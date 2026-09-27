"""可举证质量评审（规划文档 §8.3）。

与 L2 审计的区别：L2 审「设定与逻辑」，评审审「写作质量」。7 个维度，每维给
0–100 分，且**必须引用原文举证**；无证据的维度记 0 分并注明原因——这条约束让
反馈可执行、可申诉，而不是一堆无法落地的形容词。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from ..core.schema import Hook, OutlineNode, ReviewDimension, ReviewReport, StyleProfile
from ..llm.provider import LLMClient

__all__ = ["REVIEW_DIMS", "ReviewRequest", "review_chapter"]

#: 评审维度（首批 7 项，逐字对齐规划文档 §8.3）
REVIEW_DIMS: list[str] = [
    "设定一致性", "角色行为", "节奏", "叙事连贯", "伏笔", "钩子", "审美品质",
]

_NO_EVIDENCE_NOTE = "未取到可举证的原文"


@dataclass
class ReviewRequest:
    chapter: int
    title: str
    text: str
    outline_node: OutlineNode | None = None
    hooks: list[Hook] = field(default_factory=list)
    style: StyleProfile | None = None
    summary_context: str = ""


def _norm(text: str) -> str:
    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", text or "")


def _extract_dims(obj: Any) -> list[dict[str, Any]]:
    if isinstance(obj, list):
        return [x for x in obj if isinstance(x, dict)]
    if isinstance(obj, dict):
        for key in ("dims", "items", "results", "review", "dimensions"):
            val = obj.get(key)
            if isinstance(val, list):
                return [x for x in val if isinstance(x, dict)]
        if any(k in obj for k in ("dim", "score")):
            return [obj]
    return []


def _to_score(value: Any) -> int:
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return 0
    return max(0, min(100, n))


def _build_messages(req: ReviewRequest, dims: list[str]) -> list[dict[str, str]]:
    system = (
        "你是一位资深中文小说编辑，正在做可举证的质量评审。\n"
        "硬性要求：\n"
        "1. 只评审指定的维度，每个维度给一个 0–100 的整数分（score）；\n"
        "2. 每个维度的 evidence 必须是本章正文的**逐字原文片段**（连续、原样、"
        "不得改写或概括），作为打分的依据；没有可引用的原文就不要给分，"
        "把 score 记为 0 并在 note 说明；\n"
        "3. note 用一句话说明扣分或加分的关键原因；\n"
        "4. 评分要拉开区分度，不要所有维度都给同一个分。\n"
        '只输出一个 JSON 对象，形如：{"dims":[{"dim":"节奏","score":84,'
        '"evidence":"原文逐字片段","note":"说明"}]}。'
        "不要输出解释文字、不要 Markdown 代码块围栏。"
    )

    parts: list[str] = [f"# 待评审章节：第 {req.chapter} 章《{req.title}》"]
    parts.append("## 评审维度（JSON 数组）")
    parts.append(json.dumps(dims, ensure_ascii=False))
    if req.outline_node:
        node = req.outline_node
        parts.append("## 本章章纲预期")
        parts.append(f"- 目标：{node.goal or '—'}")
        if node.beats:
            parts.append(f"- 节拍：{'；'.join(node.beats)}")
    if req.summary_context:
        parts.append(f"## 前情提要\n{req.summary_context}")
    if req.hooks:
        parts.append("## 伏笔池")
        for h in req.hooks:
            parts.append(f"- {h.id}（第 {h.planted_chapter} 章埋设，状态 {h.status}）：{h.content}")
    if req.style and not req.style.is_empty:
        parts.append("## 文风档案")
        parts.append(req.style.injection_text())
    parts.append("## 本章正文")
    parts.append(req.text)

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n".join(parts)},
    ]


async def review_chapter(client: LLMClient, req: ReviewRequest) -> ReviewReport:
    """返回 7 维评审报告；每维必须带可检索到的原文证据，否则记 0 分。"""
    dims = list(REVIEW_DIMS)
    if not (req.text or "").strip():
        return ReviewReport(
            chapter=req.chapter,
            dims=[ReviewDimension(dim=d, score=0, note=_NO_EVIDENCE_NOTE) for d in dims],
            overall=0,
        )

    obj, _result = await client.complete_json("review", _build_messages(req, dims))
    by_dim: dict[str, dict[str, Any]] = {}
    for raw in _extract_dims(obj):
        dim = str(raw.get("dim") or "").strip()
        if dim and dim not in by_dim:
            by_dim[dim] = raw

    norm_text = _norm(req.text)
    report_dims: list[ReviewDimension] = []
    for dim in dims:
        raw = by_dim.get(dim)
        if raw is None:
            report_dims.append(ReviewDimension(dim=dim, score=0, note=_NO_EVIDENCE_NOTE))
            continue
        evidence = str(raw.get("evidence") or "").strip()
        if not evidence or _norm(evidence) not in norm_text:
            report_dims.append(ReviewDimension(dim=dim, score=0, note=_NO_EVIDENCE_NOTE))
            continue
        report_dims.append(ReviewDimension(
            dim=dim,
            score=_to_score(raw.get("score")),
            evidence=evidence,
            note=str(raw.get("note") or "").strip(),
        ))

    scored = [d.score for d in report_dims]
    overall = int(round(sum(scored) / len(scored))) if scored else 0
    return ReviewReport(chapter=req.chapter, dims=report_dims, overall=overall)
