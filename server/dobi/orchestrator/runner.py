"""整本生产流程（规划文档 §7.6）。

一个 `run` 指令从灵感跑到完成，期间无需人工。约束：

- `stop_conditions` 熔断：blocker 级未决问题 / 预算超限 / 连续 N 章审查不通过 / 干预波及已定稿章
- 支持中途切人工：随时把模式改为 `confirm`，在下个确认点停下
- 全程可断点续跑
- 结束产出：正文全稿 + 审查与评审报告 + 伏笔回收率 + 成本清单

**安全阀**：单次 run 有最大章数上限，且对「进度没有推进」的情况做检测，
避免出现「诊断→执行→还是同一步」的死循环悄悄烧钱。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ..core.checkpoint import CheckpointManager
from ..core.metering import Meter
from ..core.schema import now_iso
from ..core.store import ProjectStore
from ..errors import BudgetExceeded
from ..llm.provider import LLMClient
from .mode import ModeController
from .pipeline import Pipeline, emit
from .planning import Planner

__all__ = ["BookRunner", "RunReport"]


@dataclass
class RunReport:
    started_at: str = field(default_factory=now_iso)
    finished_at: str = ""
    chapters: list[dict[str, Any]] = field(default_factory=list)
    stop_condition: str | None = None
    stopped_reason: str = ""
    completions: int = 0
    cost: float = 0.0
    tokens: int = 0

    def public(self) -> dict[str, Any]:
        return {
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "chapters": self.chapters,
            "completedChapters": [c["chapter"] for c in self.chapters if c.get("committed")],
            "stopCondition": self.stop_condition,
            "stoppedReason": self.stopped_reason,
            "cost": round(self.cost, 4),
            "tokens": self.tokens,
        }


class BookRunner:
    def __init__(self, store: ProjectStore, client: LLMClient,
                 meter: Meter | None = None) -> None:
        self.store = store
        self.client = client
        self.meter = meter or Meter(store)
        self.cp = CheckpointManager(store)
        self.mode = ModeController(store)
        self.planner = Planner(store, client, self.meter)
        self.pipeline = Pipeline(store, client, self.meter)

    async def run(
        self,
        *,
        max_chapters: int = 20,
        from_chapter: int | None = None,
        on_event: Callable[[dict[str, Any]], Any] | None = None,
        should_stop: Callable[[], bool] | None = None,
    ) -> RunReport:
        report = RunReport()
        cost_before = self.meter.used
        tokens_before = self.meter.total_tokens
        fail_streak = 0
        stalled = 0
        last_signature: tuple[str, int] | None = None

        emit(on_event, type="run_start", chapter=from_chapter or 0, report=report.public())

        plan = self.cp.diagnose(target_chapter=from_chapter)
        emit(on_event, type="resume", chapter=plan.chapter, plan=plan.public())

        guard_iterations = 0
        while len(report.chapters) < max_chapters:
            guard_iterations += 1
            if guard_iterations > max_chapters * 4 + 12:
                report.stop_condition = "guard"
                report.stopped_reason = "进度没有继续推进，已安全停下（避免空转消耗预算）。"
                break

            if should_stop is not None and should_stop():
                report.stopped_reason = "已按请求停止。"
                emit(on_event, type="stopped", chapter=plan.chapter)
                break

            # ---- 预算闸门 ----
            try:
                self.meter.check_budget()
            except BudgetExceeded as exc:
                report.stop_condition = "budget.exceeded"
                report.stopped_reason = str(exc)
                emit(on_event, type="paused", chapter=plan.chapter,
                     condition="budget.exceeded", reason=report.stopped_reason)
                break

            # ---- 补全规划 ----
            if plan.action == "replan":
                emit(on_event, type="planning", chapter=plan.chapter, kind="bootstrap",
                     reason=plan.reason)
                try:
                    outcome = await self.planner.bootstrap()
                except BudgetExceeded as exc:
                    report.stop_condition = "budget.exceeded"
                    report.stopped_reason = str(exc)
                    break
                emit(on_event, type="planning_done", chapter=plan.chapter,
                     outcome=outcome.public())
                plan = self.cp.diagnose()
                if (plan.action, plan.chapter) == (last_signature or ("", 0)):
                    stalled += 1
                else:
                    stalled = 0
                last_signature = (plan.action, plan.chapter)
                if stalled >= 2:
                    report.stopped_reason = "设定补全后仍无法进入写作，请人工检查大纲与角色。"
                    break
                continue

            if plan.action == "expand_volume":
                emit(on_event, type="planning", chapter=plan.chapter, kind="roll",
                     reason=plan.reason)
                try:
                    outcome = await self.planner.roll_next()
                except BudgetExceeded as exc:
                    report.stop_condition = "budget.exceeded"
                    report.stopped_reason = str(exc)
                    break
                except ValueError as exc:
                    # 没有可展开的骨架卷——不当作错误，直接往下走写正文
                    emit(on_event, type="note", chapter=plan.chapter, message=str(exc))
                    plan = self.cp.diagnose(target_chapter=plan.chapter + 1)
                    last_signature = (plan.action, plan.chapter)
                    continue
                emit(on_event, type="planning_done", chapter=plan.chapter,
                     outcome=outcome.public())
                plan = self.cp.diagnose()
                last_signature = (plan.action, plan.chapter)
                continue

            # ---- 跑这一章 ----
            chapter = plan.chapter
            snapshot = self.store.read_chapter(chapter)

            try:
                guard = await self.planner.ensure_for_chapter(chapter)
            except BudgetExceeded as exc:
                report.stop_condition = "budget.exceeded"
                report.stopped_reason = str(exc)
                break
            if guard is not None:
                emit(on_event, type="planning_done", chapter=chapter, outcome=guard.public())

            emit(on_event, type="chapter_start", chapter=chapter)
            run = await self.pipeline.run(
                chapter, respect_policy=False, on_event=on_event,
                should_stop=should_stop, fail_streak=fail_streak,
            )

            audit = self.store.read_audit(chapter)
            unresolved = [i for i in (audit.items if audit else [])
                          if i.severity in ("blocker", "major") and not i.fixed
                          and i.decision != "ignore"]
            fail_streak = fail_streak + 1 if unresolved else 0
            final = self.store.read_chapter(chapter)
            committed = final["status"] == "done"

            report.chapters.append({
                "chapter": chapter,
                "title": final["title"],
                "words": final["words"],
                "committed": committed,
                "openIssues": len(unresolved),
                "cost": self.meter.used - cost_before,
                "run": run.public(),
            })
            emit(on_event, type="chapter_done", chapter=chapter,
                 committed=committed, words=final["words"],
                 openIssues=len(unresolved))

            # ---- 熔断 ----
            if run.stop_condition:
                report.stop_condition = run.stop_condition
                report.stopped_reason = run.paused_reason
                break
            if run.paused_at:
                report.stopped_reason = run.paused_reason
                break

            # ---- 是否已达成目标 ----
            meta = self.store.meta()
            if meta.chapters_total and chapter >= meta.chapters_total:
                report.stopped_reason = f"已写到本书计划的第 {meta.chapters_total} 章。"
                break

            if snapshot["status"] == final["status"] and not final["paragraphs"]:
                stalled += 1
            else:
                stalled = 0
            if stalled >= 2:
                report.stopped_reason = "连续两次没有产出，已安全停下。"
                break

            plan = self.cp.diagnose()
            if plan.action == "continue_draft" and plan.chapter == chapter and committed:
                # 该章已定稿，别再诊断回它
                plan = self.cp.diagnose(target_chapter=chapter + 1)
            last_signature = (plan.action, plan.chapter)

        report.finished_at = now_iso()
        report.completions = sum(1 for c in report.chapters if c.get("committed"))
        report.cost = round(self.meter.used - cost_before, 4)
        report.tokens = self.meter.total_tokens - tokens_before
        try:
            self.meter.reconcile()
        except Exception:
            pass

        emit(on_event, type="run_done", report=report.public(),
             hooks=self.store.hook_stats(), budget=self.meter.budget())
        return report

    # ---------------- 收尾产出 ----------------

    def summary(self) -> dict[str, Any]:
        """结束产出：正文全稿概况 + 审查与评审 + 伏笔回收率 + 成本清单。"""
        store = self.store
        overview = store.chapters_overview()
        audits = []
        for item in overview:
            report = store.read_audit(item["n"])
            review = store.read_review(item["n"])
            if report is None and review is None:
                continue
            audits.append({
                "chapter": item["n"],
                "title": item["title"],
                "open": report.stats.get("open", 0) if report else 0,
                "blocker": report.stats.get("blocker", 0) if report else 0,
                "major": report.stats.get("major", 0) if report else 0,
                "passRate": report.stats.get("passRate", 0) if report else 0,
                "l1": len(report.l1_violations) if report else 0,
                "reviewOverall": review.overall if review else None,
                "reviewDims": [d.model_dump() for d in review.dims] if review else [],
            })
        return {
            "chapters": overview,
            "words": sum(c["words"] for c in overview),
            "committed": sum(1 for c in overview if c["status"] == "done"),
            "audits": audits,
            "hooks": store.hook_stats(),
            "usage": self.meter.public(),
            "coverage": self.planner.coverage(),
        }
