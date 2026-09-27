"""Reviser：审计结果 → JSON Patch 定点修复（规划文档 §8.6）。

三条铁律：
1. **定点修复**，不整段重写 —— `before` 必须在原文中逐字存在，否则**跳过该 patch**
   （模型偶尔会顺手改别的地方，这种补丁必须拦下）
2. `blocker` / `major` → 修；`minor` → 只记录，不自动改
3. 改完**必须重跑规则校验**，通过才算闭环；单章循环上限 2 轮，超限交人工
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from ..consistency.deai import DeaiResult, strip_ai
from ..consistency.l1 import L1Input, L1Result, check_l1
from ..core.schema import AuditItem, Proposal
from ..llm.provider import ChatResult
from . import prompts
from .base import Agent, Usage
from .writer import split_paragraphs

__all__ = ["Reviser", "ReviseResult"]

_NORM_RE = None


def _norm(text: str) -> str:
    import re
    return re.sub(r"[\s，。！？、；：,.!?;:\"'（）()【】\[\]—…·]+", "", text or "")


@dataclass
class ReviseResult:
    chapter: int
    rounds: int = 0
    applied: list[dict[str, Any]] = field(default_factory=list)
    skipped: list[dict[str, Any]] = field(default_factory=list)
    diffs: list[dict[str, Any]] = field(default_factory=list)
    l1_before: L1Result | None = None
    l1_after: L1Result | None = None
    converged: bool = False
    needs_human: bool = False
    words_before: int = 0
    words_after: int = 0
    usage: Usage = field(default_factory=Usage)

    def public(self) -> dict[str, Any]:
        return {
            "chapter": self.chapter,
            "rounds": self.rounds,
            "applied": self.applied,
            "skipped": self.skipped,
            "diffs": self.diffs,
            "l1Before": self.l1_before.to_dict() if self.l1_before else None,
            "l1After": self.l1_after.to_dict() if self.l1_after else None,
            "converged": self.converged,
            "needsHuman": self.needs_human,
            "wordsBefore": self.words_before,
            "wordsAfter": self.words_after,
            "usage": self.usage.public(),
        }


class Reviser(Agent):
    # ---------------- 按审查结论定点修复 ----------------

    async def revise(
        self,
        chapter: int,
        *,
        severities: Sequence[str] = ("blocker", "major"),
        max_rounds: int = 2,
    ) -> ReviseResult:
        store = self.store
        report = store.read_audit(chapter)
        if report is None:
            raise ValueError(f"第 {chapter} 章还没有审查报告，先跑一次审查。")
        if not report.items:
            raise ValueError(f"第 {chapter} 章没有需要修订的问题。")

        data = store.read_chapter(chapter)
        paragraphs = list(data["paragraphs"])
        outcome = ReviseResult(chapter=chapter, words_before=data["words"])
        outcome.l1_before = self._l1(chapter, paragraphs)

        pending = _fixable(report.items, severities)
        if not pending:
            outcome.converged = not outcome.l1_before.violations
            outcome.skipped = [{"dim": i.dim, "reason": "未选中或标记为忽略"} for i in report.items]
            return outcome

        for round_no in range(1, max_rounds + 1):
            outcome.rounds = round_no
            self.scope(chapter, "revise")
            self.budget_gate()

            issues = "\n".join(
                f"{i + 1}. 【{item.dim}·{_sev_label(item.severity)}】"
                f"问题：{item.suggestion or '（未给建议）'}"
                f"｜原文：{item.evidence}"
                for i, item in enumerate(pending)
            )
            numbered = "\n\n".join(f"[{i}]\n{p}" for i, p in enumerate(paragraphs, start=1))

            obj, result = await self.client.complete_json("deai", [{
                "role": "user",
                "content": prompts.REVISER.format(issues=issues, text=numbered),
            }])
            self.usage.add(result)

            patches = obj.get("patches") if isinstance(obj, dict) else None
            if not isinstance(patches, list) or not patches:
                outcome.needs_human = True
                outcome.skipped.append({"dim": "—", "reason": "模型没有给出可用的修订"})
                break

            applied, skipped = _apply(paragraphs, patches)
            outcome.applied.extend(applied)
            outcome.skipped.extend(skipped)
            if not applied:
                outcome.needs_human = True
                break

            written = store.write_chapter(
                chapter, paragraphs, title=data["title"], status="revise", pov=data["pov"])
            outcome.words_after = written["words"]

            outcome.l1_after = self._l1(chapter, paragraphs)
            if not outcome.l1_after.violations:
                outcome.converged = True
                break
            pending = _still_broken(pending, outcome.l1_after)
            if not pending:
                break

        if not outcome.converged and outcome.rounds >= max_rounds:
            outcome.needs_human = True

        # 把 diff 与定稿决策写回审计报告
        report.diffs = outcome.diffs
        applied_evidence = {a["before"] for a in outcome.applied}
        for item in report.items:
            if item.evidence in applied_evidence or any(
                    a.get("dim") == item.dim for a in outcome.applied):
                item.fixed = True
        report.stats = _restat(report)
        store.save_audit(report)

        self.cp.finish(
            self.cp.begin(chapter, "revise"),
            output_ref=f"chapters/ch_{chapter:04d}.md",
            cost=self.usage.cost,
            note=(f"{len(outcome.applied)} 处修订"
                  + ("，规则校验已通过" if outcome.converged else "，仍需人工确认")),
        )
        return outcome

    # ---------------- 反 AIGC：去 AI 味 ----------------

    async def strip_ai(self, chapter: int, *, max_rounds: int = 2) -> DeaiResult:
        store = self.store
        data = store.read_chapter(chapter)
        text = "\n\n".join(data["paragraphs"])
        if not text.strip():
            raise ValueError(f"第 {chapter} 章还没有正文。")

        self.scope(chapter, "deai")
        self.budget_gate()
        result = await strip_ai(self.client, chapter=chapter, text=text,
                                style=store.style(), max_rounds=max_rounds)
        self.usage.calls += 1

        if result.patches:
            paragraphs = split_paragraphs(result.after)
            store.write_chapter(chapter, paragraphs, title=data["title"],
                                status="revise", pov=data["pov"])
            report = store.read_audit(chapter)
            if report is not None:
                report.diffs = (report.diffs or []) + [
                    {"dim": f"去 AI 味 · {p.get('reason', '')}",
                     "before": [p.get("before", "")], "after": [p.get("after", "")]}
                    for p in result.patches
                ]
                store.save_audit(report)

        self.cp.finish(
            self.cp.begin(chapter, "deai"),
            output_ref=f"chapters/ch_{chapter:04d}.md",
            cost=self.usage.cost,
            note=(f"{len(result.patches)} 处定点改写，{result.rounds} 轮"
                  + ("，已收敛" if result.converged else "，需人工确认")),
        )
        return result

    # ---------------- 内部 ----------------

    def _l1(self, chapter: int, paragraphs: Sequence[str]) -> L1Result:
        store = self.store
        return check_l1(L1Input(
            text="\n\n".join(paragraphs),
            chapter=chapter,
            characters=store.characters(),
            hooks=store.hooks(),
            world_rules=store.world().rules,
            style=store.style(),
        ))


def _sev_label(severity: str) -> str:
    return {"blocker": "阻塞定稿", "major": "重点", "minor": "建议"}.get(severity, severity)


def _fixable(items: Sequence[AuditItem], severities: Sequence[str]) -> list[AuditItem]:
    """谁需要修：明确接受的必修；未表态的按严重度；明确忽略的不修。"""
    out: list[AuditItem] = []
    for item in items:
        if item.decision == "ignore":
            continue
        if item.decision == "accept":
            out.append(item)
            continue
        if item.severity in severities:
            out.append(item)
    return out


def _still_broken(items: Sequence[AuditItem], l1: L1Result) -> list[AuditItem]:
    """规则违规还在的，继续修；已消失的不再重复处理。"""
    rules = {v.rule for v in l1.violations}
    if not rules:
        return []
    return [i for i in items if any(r in i.dim for r in rules)]


def _apply(paragraphs: list[str], patches: Sequence[Any]) -> tuple[list[dict], list[dict]]:
    """应用补丁。`before` 找不到就跳过 —— 绝不盲改。"""
    applied: list[dict] = []
    skipped: list[dict] = []
    for raw in patches:
        if not isinstance(raw, dict):
            continue
        before = str(raw.get("before") or "").strip()
        after = str(raw.get("after") or "").strip()
        reason = str(raw.get("reason") or "")
        if not before or not after:
            skipped.append({"before": before, "reason": "补丁缺少 before/after"})
            continue
        try:
            idx = int(raw.get("para")) - 1
        except (TypeError, ValueError):
            idx = -1

        target = idx if 0 <= idx < len(paragraphs) else None
        if target is None or (_norm(before) not in _norm(paragraphs[target])
                              and before not in paragraphs[target]):
            # 段落号不可靠时，全文搜一遍
            target = next((i for i, p in enumerate(paragraphs)
                           if before in p or _norm(before) in _norm(p)), None)
        if target is None:
            skipped.append({"before": before[:60], "reason": "原文中找不到该句，已跳过（防止误改）"})
            continue

        original = paragraphs[target]
        if before in original:
            updated = original.replace(before, after, 1)
        else:  # 归一化后匹配：只替换整段里最接近的窗口
            updated = _fuzzy_replace(original, before, after)
        if updated == original:
            skipped.append({"before": before[:60], "reason": "替换后无变化，已跳过"})
            continue

        paragraphs[target] = updated
        applied.append({"para": target + 1, "dim": reason, "before": before,
                        "after": after, "reason": reason})
    return applied, skipped


def _fuzzy_replace(paragraph: str, before: str, after: str) -> str:
    """去标点后匹配到的位置，用滑窗找回原文区间再替换。"""
    key = _norm(before)
    if not key:
        return paragraph
    window = len(before)
    for size in range(max(4, window - 6), window + 8):
        for start in range(0, max(1, len(paragraph) - size + 1)):
            chunk = paragraph[start:start + size]
            if _norm(chunk) == key:
                return paragraph[:start] + after + paragraph[start + size:]
    return paragraph


def _restat(report) -> dict[str, int]:
    items = report.items
    fixed = sum(1 for i in items if i.fixed)
    total = len(items) or 1
    return {
        "l1": len(report.l1_violations),
        "l2": len([i for i in items if not i.dim.startswith("规则 · ")]),
        "fixed": fixed,
        "open": sum(1 for i in items if not i.fixed),
        "blocker": sum(1 for i in items if i.severity == "blocker" and not i.fixed),
        "major": sum(1 for i in items if i.severity == "major" and not i.fixed),
        "passRate": round(fixed / total * 100) if items else 100,
    }
