"""实时干预 Steer（规划文档 §7.5）。

**不暂停生产**，作者随时注入意见。系统必须自动完成三件事：

1. **意图解析**：自然语言 → 结构化指令（如「节奏太慢，压缩到三段」→
   `{action: compress, target_chapter: 18, scope: current}`）
2. **影响范围评估**：当前章 / 后续大纲 / 已定稿章 —— 依据 **依赖图**推导，不瞎猜
3. **按范围执行**：
   - 只影响当前章 → 标记待重写，并把意见注入下一次写作上下文
   - 影响后续大纲 → 受影响章的章纲标记为待重排
   - **影响已定稿章 → 生成追溯修订提案，等人工确认，绝不静默改写历史**
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..agents import prompts
from ..core.checkpoint import CheckpointManager
from ..core.metering import Meter
from ..core.store import ProjectStore
from ..llm.provider import LLMClient

__all__ = ["Steering", "SteerIntent", "SteerResult"]

_ACTIONS = {
    "compress", "expand", "rewrite", "add", "remove",
    "adjust_character", "adjust_plot", "adjust_style", "unknown",
}
_SCOPES = {"current", "outline", "committed"}

ACTION_LABELS: dict[str, str] = {
    "compress": "压缩节奏", "expand": "展开细节", "rewrite": "重写",
    "add": "增加内容", "remove": "删除内容", "adjust_character": "调整人物",
    "adjust_plot": "调整情节", "adjust_style": "调整文风", "unknown": "未能判定",
}


@dataclass
class SteerIntent:
    intent: str = ""
    action: str = "unknown"
    target_chapter: int = 1
    scope: str = "current"
    affected_chapters: list[int] = field(default_factory=list)
    steps: list[str] = field(default_factory=list)
    requires_confirmation: bool = False
    reason: str = ""

    def public(self) -> dict[str, Any]:
        return {
            "intent": self.intent,
            "action": self.action,
            "actionLabel": ACTION_LABELS.get(self.action, self.action),
            "targetChapter": self.target_chapter,
            "scope": self.scope,
            "affectedChapters": self.affected_chapters,
            "steps": self.steps,
            "requiresConfirmation": self.requires_confirmation,
            "reason": self.reason,
        }


@dataclass
class SteerResult:
    text: str
    intent: SteerIntent
    applied: bool = False
    pending_confirmation: bool = False
    changed: list[str] = field(default_factory=list)
    directive_id: str = ""
    message: str = ""

    def public(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "intent": self.intent.public(),
            "applied": self.applied,
            "pendingConfirmation": self.pending_confirmation,
            "changed": self.changed,
            "directiveId": self.directive_id,
            "message": self.message,
        }


class Steering:
    def __init__(self, store: ProjectStore, client: LLMClient,
                 meter: Meter | None = None) -> None:
        self.store = store
        self.client = client
        self.meter = meter or Meter(store)
        self.cp = CheckpointManager(store)

    # ---------------- 意图解析 ----------------

    async def interpret(self, text: str) -> SteerIntent:
        store = self.store
        overview = store.chapters_overview()
        graph = store.outline_graph()
        current = max((c["n"] for c in overview if c["status"] not in ("todo", "planned")),
                      default=1)
        committed = [c["n"] for c in overview if c["status"] == "done"]
        last_committed = max(committed, default=0)
        current_item = next((c for c in overview if c["n"] == current), None)

        deps = graph.edges
        dep_lines = "\n".join(
            f"- 第 {e.from_chapter} 章 → 依赖第 {e.to_chapter} 章（{e.type}）：{e.note}"
            for e in deps) or "（尚无依赖边）"

        self.client.scope = {"chapter": current, "step": "steer"}
        self.meter.check_budget()
        obj, result = await self.client.complete_json("steer", [{
            "role": "user",
            "content": prompts.STEER.format(
                current_chapter=current,
                current_status=(current_item or {}).get("status", "todo"),
                last_committed=last_committed,
                outline_range=(f"第 {min((n.chapter for n in graph.nodes), default=1)}"
                               f"–{max((n.chapter for n in graph.nodes), default=1)} 章"),
                dependencies=dep_lines,
                text=text,
            ),
        }])
        self.meter.make_callback(chapter=current, step="steer")(result.public())

        data = obj if isinstance(obj, dict) else {}
        action = str(data.get("action") or "unknown")
        scope = str(data.get("scope") or "current")
        try:
            target = int(data.get("target_chapter") or current)
        except (TypeError, ValueError):
            target = current
        affected = []
        for value in (data.get("affected_chapters") or []):
            try:
                n = int(value)
            except (TypeError, ValueError):
                continue
            if n > 0 and n not in affected:
                affected.append(n)

        intent = SteerIntent(
            intent=str(data.get("intent") or text),
            action=action if action in _ACTIONS else "unknown",
            target_chapter=max(1, target),
            scope=scope if scope in _SCOPES else "current",
            affected_chapters=sorted(affected),
            steps=[str(s).strip() for s in (data.get("steps") or []) if str(s).strip()],
            requires_confirmation=bool(data.get("requires_confirmation")),
            reason=str(data.get("reason") or ""),
        )

        # 安全兜底：**只要触及已定稿范围，一律强制人工确认**，不信任模型的自评
        if intent.scope == "committed" or any(n <= last_committed for n in intent.affected_chapters):
            intent.scope = "committed"
            intent.requires_confirmation = True
            if not intent.reason:
                intent.reason = "影响范围触及已定稿章节。"
        return intent

    # ---------------- 执行 ----------------

    async def apply(self, text: str, *, confirm: bool = False) -> SteerResult:
        intent = await self.interpret(text)
        result = SteerResult(text=text, intent=intent)

        if intent.scope == "committed" and not confirm:
            directive = self.store.append_steering({
                "text": text,
                "steps": intent.steps,
                "action": intent.action,
                "scope": intent.scope,
                "target_chapter": intent.target_chapter,
                "affected_chapters": intent.affected_chapters,
                "requires_confirmation": True,
            })
            result.directive_id = directive["id"]
            result.pending_confirmation = True
            result.message = ("这条意见会改动已定稿的章节，我没有直接改。"
                              "确认后我会先给出修订提案，你逐条看过再落地。")
            return result

        directive = self.store.append_steering({
            "text": text,
            "steps": intent.steps,
            "action": intent.action,
            "scope": intent.scope,
            "target_chapter": intent.target_chapter,
            "affected_chapters": intent.affected_chapters,
            "requires_confirmation": False,
            "confirmed": confirm,
        })
        result.directive_id = directive["id"]
        result.applied = True

        if intent.scope == "outline":
            changed = self._reset_outline(intent)
            result.changed = changed
            result.message = (f"已记为长期指令，并把 {len(changed)} 章的章纲标记为待重排；"
                              "写这些章时会自动带上你的意见。")
        else:
            self._reset_chapter(intent.target_chapter)
            result.changed = [f"第 {intent.target_chapter} 章"]
            result.message = (f"已记为长期指令，第 {intent.target_chapter} 章重写时会自动遵守。")
        return result

    def _reset_chapter(self, chapter: int) -> None:
        """把该章退回「待重写」：清掉 draft 之后的 checkpoint，状态回 draft。"""
        self.cp.reset_from(chapter, step="draft")
        for step in ("audit", "review", "deai", "revise", "commit"):
            self.cp.reset_from(chapter, step=step)
        data = self.store.read_chapter(chapter)
        if data["paragraphs"]:
            self.store.update_chapter_status(chapter, "draft")

    def _reset_outline(self, intent: SteerIntent) -> list[str]:
        graph = self.store.outline_graph()
        changed: list[str] = []
        targets = set(intent.affected_chapters) or {intent.target_chapter}
        for node in graph.nodes:
            if node.chapter in targets:
                node.status = "planned"
                note = "／".join(intent.steps) or intent.intent
                suffix = f"（作者意见：{note}）"
                if suffix not in node.rationale:
                    node.rationale = (node.rationale + suffix).strip()
                changed.append(f"第 {node.chapter} 章")
        self.store.save_outline_graph(graph)
        for n in sorted(targets):
            self.cp.reset_from(n, step="plan")
        return changed

    # ---------------- 未消费指令 ----------------

    def pending_directives(self) -> list[dict[str, Any]]:
        return self.store.steering_directives(include_resolved=False)

    def confirm_directive(self, directive_id: str) -> dict[str, Any]:
        """人工确认后，把「待确认」的指令转为正式指令。"""
        rows = self.store.read_jsonl(self.store.steering_path)
        target = next((r for r in rows if r.get("id") == directive_id), None)
        if target is None:
            return {"ok": False, "message": "没有这条干预指令。"}
        target["requires_confirmation"] = False
        target["confirmed"] = True
        self.store.write_jsonl(self.store.steering_path, rows)
        chapter = int(target.get("target_chapter") or 1)
        if target.get("scope") == "outline":
            self._reset_outline(SteerIntent(
                intent=target.get("text", ""), target_chapter=chapter, scope="outline",
                affected_chapters=[int(x) for x in (target.get("affected_chapters") or [])],
                steps=[str(s) for s in (target.get("steps") or [])],
            ))
        else:
            self._reset_chapter(chapter)
        return {"ok": True, "id": directive_id, "chapter": chapter}

    def dismiss_directive(self, directive_id: str, *, applied: bool = True) -> dict[str, Any]:
        hit = self.store.resolve_steering([directive_id])
        return {"ok": bool(hit), "id": directive_id, "applied": applied}
