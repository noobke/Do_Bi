"""Writer：章纲 + 上下文 + 文风档案 → 章节正文（流式）。**唯一产出正文的角色。**

流式语义：
- 逐段回调 `on_delta`，前端可以边生成边显示
- 支持 `should_stop()` 中途停止，**已生成的部分立即落盘为草稿**（不丢稿）
- 中断后重新调用会自动带上已写内容作为「续写起点」，不重复生成
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from ..core.context import ContextBundle, build_context
from ..core.schema import OutlineNode
from ..llm.provider import ChatResult
from . import prompts
from .architect import present_characters
from .base import Agent, Usage

__all__ = ["Writer", "WriteResult"]


@dataclass
class WriteResult:
    chapter: int
    title: str
    paragraphs: list[str] = field(default_factory=list)
    words: int = 0
    cancelled: bool = False
    usage: Usage = field(default_factory=Usage)
    context: ContextBundle | None = None
    result: ChatResult | None = None

    def public(self) -> dict[str, Any]:
        return {
            "chapter": self.chapter,
            "title": self.title,
            "words": self.words,
            "paragraphs": len(self.paragraphs),
            "cancelled": self.cancelled,
            "usage": self.usage.public(),
            "context": self.context.public() if self.context else None,
        }


def split_paragraphs(text: str) -> list[str]:
    """按空行切段；顺带吃掉模型爱加的各种标题行与分隔线。"""
    cleaned = re.sub(r"^\s*(?:#+\s*)?第\s*\d+\s*章[^\n]*\n", "", text or "", count=1)
    cleaned = re.sub(r"^\s*[-—=*]{3,}\s*$", "", cleaned, flags=re.MULTILINE)
    parts = [p.strip() for p in re.split(r"\n\s*\n+", cleaned)]
    return [p for p in parts if p and p not in ("（本章完）", "(本章完)", "本章完")]


class Writer(Agent):
    async def write(
        self,
        chapter: int,
        *,
        on_delta: Callable[[str], Any] | None = None,
        should_stop: Callable[[], bool] | None = None,
        continue_draft: bool = True,
        temperature: float | None = None,
    ) -> WriteResult:
        store = self.store
        meta = store.meta()
        graph = store.outline_graph()
        node = graph.node(chapter)
        if node is None:
            # 章纲缺失时给一个最小可用节点，保证「能写」优先于「必须有序」
            node = OutlineNode(chapter=chapter, title="", goal="", pov="")

        existing = store.read_chapter(chapter)
        draft_text = store.chapter_text(chapter) if continue_draft else ""
        if store.read_audit(chapter) is not None:
            draft_text = ""      # 已进入审查阶段的章节，重写时不当续写处理

        characters_present = present_characters(
            store, " ".join([node.goal, *node.beats, node.pov, draft_text[-400:]]))

        bundle = build_context(
            store, chapter, purpose="writer",
            context_window=self.client.window_for("writer"),
            node=node, draft=draft_text,
            characters_present=characters_present or None,
        )

        beats = "\n".join(f"  {i}. {b}" for i, b in enumerate(node.beats, start=1)) or "  （无，按目标自由推进）"
        previous_tail = ""
        if draft_text.strip():
            tail = draft_text.strip()[-500:]
            previous_tail = f"\n【已写部分（请从这之后无缝续写，不要重复）】\n…{tail}\n"

        messages = list(bundle.messages) + [{
            "role": "user",
            "content": prompts.WRITER_TASK.format(
                chapter=chapter, title=node.title or f"第 {chapter} 章",
                goal=node.goal or "（未明确，按上文自然推进）",
                beats=beats,
                rationale=node.rationale or "（未给出）",
                previous_tail=previous_tail,
                target_words=max(800, meta.words_per_chapter - (existing["words"] if draft_text else 0)),
            ),
        }]

        self.scope(chapter, "draft")
        self.budget_gate()
        cp = self.cp.begin(chapter, "draft",
                           note="续写" if draft_text.strip() else "新写")

        chunks: list[str] = []
        result_holder: dict[str, ChatResult] = {}

        def _capture(res: ChatResult) -> None:
            result_holder["result"] = res
            self.usage.add(res)

        cancelled = False
        try:
            async for delta in self.client.stream(
                "writer", messages, temperature=temperature, on_result=_capture,
            ):
                chunks.append(delta)
                if on_delta is not None:
                    on_delta(delta)
                if should_stop is not None and should_stop():
                    cancelled = True
                    break
        except (Exception, asyncio.CancelledError) as exc:
            # 已生成的部分必须保住 —— 这是「不丢稿」的底线。
            # CancelledError 也要接：前端点「停止」会直接断开 SSE 连接。
            partial = "".join(chunks)
            if partial.strip():
                paragraphs = split_paragraphs(partial)
                store.write_chapter(chapter, paragraphs,
                                    title=node.title or existing["title"],
                                    status="draft", pov=node.pov or existing["pov"])
                self.cp.fail(cp, note=f"生成中断，已保留 {sum(len(p) for p in paragraphs)} 字草稿")
            raise

        text = "".join(chunks)
        paragraphs = split_paragraphs(text)

        if draft_text.strip() and not cancelled:
            # 续写模式：把旧内容与新内容拼接（旧内容按段去重，避免模型把上文又写一遍）
            old = split_paragraphs(draft_text)
            merged: list[str] = list(old)
            for para in paragraphs:
                if not merged or para != merged[-1]:
                    merged.append(para)
            paragraphs = merged

        data = store.write_chapter(chapter, paragraphs,
                                   title=node.title or existing["title"],
                                   status="draft", pov=node.pov or existing["pov"])

        final = result_holder.get("result")
        tokens = final.usage.total_tokens if final else 0
        self.cp.finish(cp, status="ok",
                       output_ref=f"chapters/ch_{chapter:04d}.md",
                       tokens=tokens, cost=self.usage.cost,
                       note=f"{data['words']} 字" + ("（用户中途停止，已保存半成品）" if cancelled else ""))

        return WriteResult(chapter=chapter, title=data["title"], paragraphs=paragraphs,
                           words=data["words"], cancelled=cancelled,
                           usage=self.usage, context=bundle, result=final)
