"""反 AIGC / 去 AI 味管线（规划文档 §8.4）。

分级：P0 的确定性部分已在 L1 落地（禁用句式、套话密度、连续虚词、段落均匀、词汇
疲劳）；本模块把它扩成**闭环**：

    定位（L1 违规） → 定点修复（模型只改违规句，不整段重写）
    → 重跑 L1 → 归零即收敛

安全阀：循环上限 **2 轮**，超限标记 `needs_human=True`，绝不死循环烧钱。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from ..core.schema import StyleProfile
from ..llm.provider import LLMClient
from .l1 import L1Input, L1Result, check_l1

__all__ = ["DeaiResult", "detect", "strip_ai", "DEAI_RULE_NAMES"]

#: 属于「去 AI 味」范畴的 L1 规则名（收敛判据只看这些；伏笔/数值等与文风无关）
DEAI_RULE_NAMES: frozenset[str] = frozenset({
    "禁用句式命中", "套话密度超阈值", "连续「了／的」字句", "词汇疲劳", "段落长度异常",
})

MAX_ROUNDS_DEFAULT = 2


@dataclass
class DeaiResult:
    before: str
    after: str
    rounds: int = 0
    detected: list[dict] = field(default_factory=list)   # [{pattern, count, samples[]}]
    patches: list[dict] = field(default_factory=list)    # [{para, before, after, reason}]
    l1_before: L1Result | None = None
    l1_after: L1Result | None = None
    converged: bool = False       # 重跑 L1 后无命中的确定性违规
    needs_human: bool = False     # 超过循环上限仍未收敛

    def to_dict(self) -> dict:
        return {
            "before": self.before,
            "after": self.after,
            "rounds": self.rounds,
            "detected": self.detected,
            "patches": self.patches,
            "l1Before": self.l1_before.to_dict() if self.l1_before else None,
            "l1After": self.l1_after.to_dict() if self.l1_after else None,
            "converged": self.converged,
            "needsHuman": self.needs_human,
        }


def _norm(text: str) -> str:
    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", text or "")


def _deai_violations(l1: L1Result) -> list:
    return [v for v in l1.violations if v.rule in DEAI_RULE_NAMES]


async def detect(text: str, *, style: StyleProfile | None, l1: L1Result) -> list[dict]:
    """定位「AI 味」问题点。确定性、零模型成本——直接消费 L1 的确定性违规。"""
    out: list[dict] = []
    for v in _deai_violations(l1):
        out.append({
            "pattern": v.rule,
            "count": int(v.count),
            "samples": list(v.samples) or ([v.hit] if v.hit else []),
        })
    return out


def _para_at(text: str, hit: str) -> int:
    """把违规样本定位到段落号（1-based），供定点修复参考。"""
    for i, p in enumerate(text.split("\n\n"), 1):
        if hit and (hit in p or _norm(hit) in _norm(p)):
            return i
    return 0


def _build_messages(chapter: int, text: str, style: StyleProfile | None,
                    detected: list[dict]) -> list[dict[str, str]]:
    system = (
        "你是一位中文小说润色编辑，任务是**定点修复**AI 味表达。\n"
        "硬性要求：\n"
        "1. **只改被指出问题的句子，不整段重写**，不改变原意、人物关系与上下文衔接；\n"
        "2. 保留原有的叙事节奏与信息量，能小改就不大改；\n"
        "3. 输出 JSON Patch：{\"patches\":[{\"para\":段落号,\"before\":\"原句逐字\","
        "\"after\":\"改写后\",\"reason\":\"改动理由\"}]}；\n"
        "4. `para` 是下面列出的段落序号（1 起）；`before` 必须是与原文**逐字一致**的片段，"
        "否则该补丁会被丢弃；\n"
        "5. 没有可改的地方就输出 {\"patches\":[]}。\n"
        "不要输出解释文字、不要 Markdown 代码块围栏。"
    )
    parts: list[str] = [f"# 待修复章节：第 {chapter} 章"]
    parts.append("## 命中问题（需要定点修复）")
    for d in detected:
        samples = "；".join(str(s) for s in d.get("samples", [])[:6])
        parts.append(f"- {d['pattern']}（{d['count']} 处）：{samples}")
    if style and style.banned_expressions:
        parts.append("## 本章需避免的禁用表达")
        parts.append(" / ".join(style.banned_expressions))
    if style and not style.is_empty:
        parts.append("## 文风档案")
        parts.append(style.injection_text())
    parts.append("## 正文（按段落编号）")
    for i, p in enumerate(text.split("\n\n"), 1):
        parts.append(f"【第 {i} 段】{p}")
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n".join(parts)},
    ]


def _extract_patches(obj: Any) -> list[dict[str, Any]]:
    if isinstance(obj, dict):
        val = obj.get("patches") or obj.get("patch") or obj.get("items")
        if isinstance(val, list):
            return [x for x in val if isinstance(x, dict)]
    if isinstance(obj, list):
        return [x for x in obj if isinstance(x, dict)]
    return []


def _apply_patches(text: str, patches: list[dict[str, Any]]) -> tuple[str, list[dict]]:
    """按 para 序号替换段落内的 before 片段。

    `before` 与现段落做包含性校验——不匹配则跳过（防止模型瞎改）。
    返回 (新正文, 实际生效的补丁列表)。
    """
    paras = text.split("\n\n")
    applied: list[dict] = []
    for p in patches:
        try:
            idx = int(p.get("para") or 0)
        except (TypeError, ValueError):
            continue
        before = str(p.get("before") or "")
        after = str(p.get("after") or "")
        if not (1 <= idx <= len(paras)) or not before:
            continue
        cur = paras[idx - 1]
        if before not in cur:            # 逐字包含性校验，不匹配直接跳过
            continue
        paras[idx - 1] = cur.replace(before, after, 1)
        applied.append({
            "para": idx,
            "before": before,
            "after": after,
            "reason": str(p.get("reason") or "").strip(),
        })
    return "\n\n".join(paras), applied


async def strip_ai(client: LLMClient, *, chapter: int, text: str,
                   style: StyleProfile | None, max_rounds: int = MAX_ROUNDS_DEFAULT) -> DeaiResult:
    """去 AI 味闭环：定位 → 定点修复 → 重跑 L1，最多 `max_rounds` 轮。"""
    before = text
    current = text
    l1_before = check_l1(L1Input(text=before, chapter=chapter, style=style))
    result = DeaiResult(before=before, after=text, l1_before=l1_before, l1_after=l1_before)

    # 起始即无问题 → 直接收敛
    if not _deai_violations(l1_before):
        result.converged = True
        return result

    rounds = 0
    all_patches: list[dict] = []
    last_detected: list[dict] = list(await detect(current, style=style, l1=l1_before))

    for _ in range(max(0, max_rounds)):
        l1_cur = check_l1(L1Input(text=current, chapter=chapter, style=style))
        detected = await detect(current, style=style, l1=l1_cur)
        if not detected:
            break
        last_detected = detected
        rounds += 1
        obj, _r = await client.complete_json(
            "deai", _build_messages(chapter, current, style, detected)
        )
        current, applied = _apply_patches(current, _extract_patches(obj))
        all_patches.extend(applied)
        if not applied:
            # 模型没给出可用补丁 → 本轮无进展，不再重试
            break

    l1_after = check_l1(L1Input(text=current, chapter=chapter, style=style))
    converged = not _deai_violations(l1_after)

    result.after = current
    result.rounds = rounds
    result.detected = last_detected
    result.patches = all_patches
    result.l1_after = l1_after
    result.converged = converged
    result.needs_human = not converged
    return result
