"""L2 模型维度审查（规划文档 §8.2）。

与 L1 的分工：L1 用规则对「可确定性判定」的问题零成本出结论；L2 交给模型，
覆盖 OOC、设定冲突、因果断裂这类需要理解语义的维度。

两条硬约束（§8.3 的落地）：

1. **一次调用审全部指定维度**——每维一次调用会 15 倍烧钱，把维度清单作为 JSON
   数组放进同一次提示词；
2. **无证据的结论直接丢弃**——模型返回的每条发现必须带 `evidence`（逐字原文），
   且该 evidence 能在正文中检索到（去标点后子串包含），否则整条丢弃。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from ..core.schema import (
    AuditItem,
    ChapterSummary,
    Character,
    Hook,
    OutlineNode,
    StyleProfile,
    WorldRule,
)
from ..llm.provider import LLMClient

__all__ = ["DIMS_P0", "DIMS_P1", "ALL_DIMS", "L2Request", "audit_l2"]

#: P0 首批 5 维
DIMS_P0: list[str] = ["OOC", "设定冲突", "伏笔遗漏", "时间线矛盾", "文风偏移"]

#: P1 增补 10 维
DIMS_P1: list[str] = [
    "战力/等级漂移", "信息泄露", "节奏单调", "支线停滞", "情感弧线断裂",
    "场景重复", "对话同质化", "因果断裂", "动机不足", "爽点缺失",
]

ALL_DIMS: list[str] = DIMS_P0 + DIMS_P1

_SEV_MAP = {
    "blocker": "blocker", "major": "major", "minor": "minor",
    "阻塞定稿": "blocker", "阻塞": "blocker", "重点": "major", "建议": "minor",
}


@dataclass
class L2Request:
    chapter: int
    title: str
    text: str
    characters: list[Character] = field(default_factory=list)
    hooks: list[Hook] = field(default_factory=list)
    world_rules: list[WorldRule] = field(default_factory=list)
    summaries: list[ChapterSummary] = field(default_factory=list)   # 前情提要
    outline_node: OutlineNode | None = None
    compass_endgame: str = ""
    style: StyleProfile | None = None
    dims: list[str] = field(default_factory=list)                   # 只审这些维度


def _norm(text: str) -> str:
    """去空白与标点，用于「去标点后子串包含」的证据校验。"""
    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", text or "")


def _paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n+", text or "") if p.strip()]


def _ref(chapter: int, paras: list[str], evidence: str) -> str:
    """证据落入哪一段 → `ch_0017.md#para-5`（段落号按 \\n\\n 的 1-based 序号）。"""
    norm_ev = _norm(evidence)
    for i, p in enumerate(paras, 1):
        if evidence in p or (norm_ev and norm_ev in _norm(p)):
            return f"ch_{chapter:04d}.md#para-{i}"
    return f"ch_{chapter:04d}.md"


def _normalize_severity(value: Any) -> str:
    return _SEV_MAP.get(str(value or "").strip().lower(), _SEV_MAP.get(str(value or "").strip(), "minor"))


def _extract_items(obj: Any) -> list[dict[str, Any]]:
    """兼容模型可能返回的几种 JSON 形状。"""
    if isinstance(obj, list):
        return [x for x in obj if isinstance(x, dict)]
    if isinstance(obj, dict):
        for key in ("items", "findings", "dims", "results", "issues", "audit"):
            val = obj.get(key)
            if isinstance(val, list):
                return [x for x in val if isinstance(x, dict)]
        # 单条
        if any(k in obj for k in ("dim", "evidence")):
            return [obj]
    return []


def _character_lines(chars: list[Character]) -> list[str]:
    out: list[str] = []
    for c in chars:
        traits = "、".join(c.immutable_traits) or "—"
        status = c.state.status if c.state else "—"
        dead = "（已亡故）" if c.deceased else ""
        out.append(f"- {c.name}{dead}｜不可变特征：{traits}｜当前状态：{status}")
    return out


def _hook_lines(hooks: list[Hook]) -> list[str]:
    return [f"- {h.id}（{'已回收' if h.status == 'resolved' else '待回收'}，"
            f"埋于第 {h.planted_chapter} 章）：{h.content}" for h in hooks]


def _rule_lines(rules: list[WorldRule]) -> list[str]:
    return [f"- [{r.kind}] {r.rule}" for r in rules]


def _summary_lines(summaries: list[ChapterSummary]) -> list[str]:
    return [f"- 第 {s.chapter} 章 {s.title}：{s.summary}" for s in summaries if s.summary]


def _build_messages(req: L2Request, dims: list[str]) -> list[dict[str, str]]:
    system = (
        "你是一位严谨的中文长篇小说审校。你的任务是对给定章节做多维度一致性审查，"
        "只报告你能在原文中逐字引用证据的问题。\n"
        "硬性要求：\n"
        "1. 只针对指定的审查维度报告发现，不要新增其他维度；\n"
        "2. 每条发现的 evidence 必须是本章正文的**逐字原文片段**（连续、原样、不得改写或概括），"
        "把引文放在「」内或不加引号均可，但文字必须与原文完全一致；\n"
        "3. 每条发现给出可执行的 suggestion（修改建议）；\n"
        "4. severity 只能取 blocker / major / minor 之一："
        "blocker=阻塞定稿的硬伤，major=需要重点修订，minor=建议优化；\n"
        "5. 若某维度没有发现，就不要为它输出任何条目；宁可少报，不可编造证据。\n"
        '只输出一个 JSON 对象，形如：{"items":[{"dim":"设定冲突","severity":"major",'
        '"evidence":"原文逐字片段","suggestion":"修改建议"}]}。'
        "不要输出解释文字、不要 Markdown 代码块围栏。"
    )

    parts: list[str] = []
    parts.append(f"# 待审章节：第 {req.chapter} 章《{req.title}》")
    parts.append("## 需要审查的维度（JSON 数组）")
    parts.append(json.dumps(dims, ensure_ascii=False))
    if req.outline_node:
        node = req.outline_node
        parts.append("## 本章章纲预期")
        parts.append(f"- 目标：{node.goal or '—'}")
        if node.beats:
            parts.append(f"- 节拍：{'；'.join(node.beats)}")
        if node.pov:
            parts.append(f"- 视角：{node.pov}")
    if req.compass_endgame:
        parts.append(f"## 全书终局方向\n{req.compass_endgame}")
    if req.characters:
        parts.append("## 角色卡（不可变特征不可违背）")
        parts.extend(_character_lines(req.characters))
    if req.world_rules:
        parts.append("## 世界观规则（hard 即硬约束）")
        parts.extend(_rule_lines(req.world_rules))
    if req.hooks:
        parts.append("## 伏笔池")
        parts.extend(_hook_lines(req.hooks))
    if req.summaries:
        parts.append("## 前情提要")
        parts.extend(_summary_lines(req.summaries))
    if req.style and not req.style.is_empty:
        parts.append("## 文风档案（文风偏移维度的对照基准）")
        parts.append(req.style.injection_text())
    parts.append("## 本章正文")
    parts.append(req.text)

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n".join(parts)},
    ]


async def audit_l2(client: LLMClient, req: L2Request) -> list[AuditItem]:
    """对指定维度做一次模型审查，返回带原文证据的 AuditItem 列表。

    无证据或证据在正文中检索不到的条目会被直接丢弃。
    """
    dims = [d for d in (req.dims or ALL_DIMS) if d]
    if not dims or not (req.text or "").strip():
        return []

    obj, _result = await client.complete_json("audit_l2", _build_messages(req, dims))

    paras = _paragraphs(req.text)
    norm_text = _norm(req.text)
    out: list[AuditItem] = []
    for raw in _extract_items(obj):
        dim = str(raw.get("dim") or "").strip()
        evidence = str(raw.get("evidence") or "").strip()
        if not dim or not evidence:
            continue
        if _norm(evidence) not in norm_text:      # 硬约束：检索不到即丢弃
            continue
        out.append(AuditItem(
            dim=dim,
            severity=_normalize_severity(raw.get("severity")),  # type: ignore[arg-type]
            evidence=evidence,
            suggestion=str(raw.get("suggestion") or "").strip(),
            ref=_ref(req.chapter, paras, evidence),
        ))
    return out
