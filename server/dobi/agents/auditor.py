"""Auditor：正文 + 真相文件 → 审计报告（含原文证据）。

两级：
- **规则校验**（`check_l1`）：13 条确定性规则，零模型成本，每次必跑
- **模型审查**（`audit_l2`）：15 维，按项目开关决定跑哪几维（关掉不关心的维度省钱）

两者的结论合并进同一份 `audits/ch_XXXX.json`，作者只需看一个地方。
"""

from __future__ import annotations

from typing import Any, Sequence

from ..consistency.l1 import L1Input, L1Result, check_l1
from ..consistency.l2 import ALL_DIMS, DIMS_P0, L2Request, audit_l2
from ..core.schema import AuditItem, AuditReport
from .base import Agent, Usage

__all__ = ["Auditor"]

#: 项目未指定维度时的默认档位
DEFAULT_DIMS_P0 = DIMS_P0


class Auditor(Agent):
    async def audit(
        self,
        chapter: int,
        *,
        dims: Sequence[str] | None = None,
        run_l2: bool = True,
    ) -> AuditReport:
        store = self.store
        data = store.read_chapter(chapter)
        text = "\n\n".join(data["paragraphs"])
        if not text.strip():
            raise ValueError(f"第 {chapter} 章还没有正文，先写出来再审查。")

        meta = store.meta()
        graph = store.outline_graph()
        node = graph.node(chapter)

        # ---------- 第一步：规则校验（零成本，必跑）----------
        l1: L1Result = check_l1(L1Input(
            text=text,
            chapter=chapter,
            characters=store.characters(),
            hooks=store.hooks(),
            world_rules=store.world().rules,
            style=store.style(),
            characters_present=_onstage_names(store, text),
        ))

        # ---------- 第二步：模型审查（按维度开关）----------
        effective_dims = list(dims) if dims else _dims_for(meta)
        items: list[AuditItem] = []
        if run_l2 and effective_dims:
            self.scope(chapter, "audit")
            self.budget_gate()
            req = L2Request(
                chapter=chapter,
                title=data["title"] or (node.title if node else ""),
                text=text,
                characters=store.characters(),
                hooks=store.hooks(),
                world_rules=store.world().rules,
                summaries=[s for s in store.summaries() if s.chapter < chapter][-6:],
                outline_node=node,
                compass_endgame=graph.compass.endgame,
                style=store.style(),
                dims=effective_dims,
            )
            items = await audit_l2(self.client, req)
            # audit_l2 内部用 complete_json，这里补记计量
            self.usage.calls += 1

        # ---------- 合并 ----------
        # 规则违规也转成"发现"，作者在同一列表里处理；但保留 l1 全量清单供表格展示
        for v in l1.violations:
            items.insert(0, AuditItem(
                dim=f"规则 · {v.rule}",
                severity=_severity_for_rule(v.rule),
                evidence=(v.samples[0] if v.samples else v.hit) or v.rule,
                suggestion=f"命中 {v.count} 次（阈值 {v.threshold}），建议定点改写。",
                ref=f"ch_{chapter:04d}.md",
                fixed=False,
            ))

        report = store.read_audit(chapter) or AuditReport(chapter=chapter)
        report.chapter = chapter
        report.title = data["title"]
        report.l1_violations = l1.violations
        report.l1_checked = l1.checked
        report.items = _merge_items(report.items, items)
        report.stats = _stats(report)
        store.save_audit(report)

        self.cp.finish(
            self.cp.begin(chapter, "audit"),
            output_ref=f"audits/ch_{chapter:04d}.json",
            cost=self.usage.cost,
            note=f"规则命中 {len(l1.violations)} 条 · 模型审查 {len(items) - len(l1.violations)} 条",
        )
        return report


def _dims_for(meta) -> list[str]:
    if meta.audit_dims:
        return [d for d in meta.audit_dims if d in ALL_DIMS]
    return list(DIMS_P0) if not meta.audit_dims_extended else list(ALL_DIMS)


def _onstage_names(store, text: str) -> list[str]:
    from .architect import present_characters
    return present_characters(store, text)


def _severity_for_rule(rule: str) -> str:
    """规则违规的严重度。设定层面的问题阻塞定稿，文风层面的只算建议。"""
    if any(k in rule for k in ("死亡", "亡故", "不可变特征", "数值", "等级", "称呼", "姓名")):
        return "major"
    if any(k in rule for k in ("伏笔", "时间线")):
        return "major"
    return "minor"


def _merge_items(old: Sequence[AuditItem], new: Sequence[AuditItem]) -> list[AuditItem]:
    """保留已有人工决策，避免重跑审查后把作者的裁定冲掉。"""
    decisions = {i.evidence: (i.decision, i.fixed) for i in old if i.decision}
    out: list[AuditItem] = []
    seen: set[str] = set()
    for item in new:
        key = item.evidence
        if key in seen:
            continue
        seen.add(key)
        if key in decisions:
            item.decision, item.fixed = decisions[key]
        out.append(item)
    # 旧报告里仍有人工决策但本轮没再检出的条目：保留，标记为已处理
    for item in old:
        if item.decision and item.evidence not in seen:
            item.fixed = item.decision == "accept"
            out.append(item)
    return out


def _stats(report: AuditReport) -> dict[str, int]:
    items = report.items
    fixed = sum(1 for i in items if i.fixed)
    open_count = sum(1 for i in items if not i.fixed)
    blockers = sum(1 for i in items if i.severity == "blocker" and not i.fixed)
    majors = sum(1 for i in items if i.severity == "major" and not i.fixed)
    total = len(items) or 1
    return {
        "l1": len(report.l1_violations),
        "l2": len([i for i in items if not i.dim.startswith("规则 · ")]),
        "fixed": fixed,
        "open": open_count,
        "blocker": blockers,
        "major": majors,
        "passRate": round(fixed / total * 100) if items else 100,
    }
