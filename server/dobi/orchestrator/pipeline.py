"""单章流水线状态机（规划文档 §7.2）。

```
章纲 ─► 上下文组装 ─► 草稿 ─► 审查 ─► 可举证评审 ─► 去 AI 味 ─► 修订 ─► 定稿
 ▲           │          │        │          │          │        │       │
 └── 干预策略层插入「确认点」；实时干预可在任意时刻注入 ──────────────┘
```

每环节结束写 checkpoint。干预策略决定哪些环节需人工确认（`mode.ModeController`）。

两种驱动方式：
- `run_step()` —— 前端逐个按钮触发（半自动 / 手动模式）
- `run()`      —— 一次跑到停（全自动模式，由 `runner.BookRunner` 调用）
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

from ..agents import Architect, Archivist, Auditor, Reviser, Reviewer, Writer
from ..consistency.l1 import L1Input, check_l1
from ..core.checkpoint import CheckpointManager
from ..core.context import build_context
from ..core.metering import Meter
from ..core.schema import PIPELINE_STEPS, STEP_LABELS, AuditReport
from ..core.store import ProjectStore
from ..errors import BudgetExceeded, PausedByStopCondition
from ..llm.provider import LLMClient
from .mode import ModeController

__all__ = ["Pipeline", "ChapterRun", "StepOutcome"]

#: 属于「AI 味」范畴的规则 —— 只有这些命中才需要跑去味环节
_AI_FLAVOR_RULES = {
    "禁用句式命中", "套话密度超阈值", "连续「了／的」字句",
    "词汇疲劳", "段落长度异常", "描写／对话比例偏离",
}


def emit(on_event: Callable[[dict[str, Any]], Any] | None, **payload: Any) -> None:
    if on_event is None:
        return
    try:
        on_event(payload)
    except Exception:
        pass


@dataclass
class StepOutcome:
    step: str
    status: str = "ok"          # ok | skipped | failed | awaiting
    detail: dict[str, Any] = field(default_factory=dict)
    note: str = ""
    elapsed_ms: int = 0
    cost: float = 0.0
    tokens: int = 0

    @property
    def label(self) -> str:
        return STEP_LABELS.get(self.step, self.step)

    def public(self) -> dict[str, Any]:
        return {
            "step": self.step, "label": self.label, "status": self.status,
            "note": self.note, "elapsedMs": self.elapsed_ms,
            "cost": round(self.cost, 4), "tokens": self.tokens,
            "detail": self.detail,
        }


@dataclass
class ChapterRun:
    chapter: int
    outcomes: list[StepOutcome] = field(default_factory=list)
    paused_at: str | None = None
    paused_reason: str = ""
    stop_condition: str | None = None
    steer_affects_committed: bool = False

    @property
    def ok(self) -> bool:
        return not self.paused_at and all(o.status != "failed" for o in self.outcomes)

    @property
    def cost(self) -> float:
        return round(sum(o.cost for o in self.outcomes), 4)

    def public(self) -> dict[str, Any]:
        return {
            "chapter": self.chapter,
            "ok": self.ok,
            "outcomes": [o.public() for o in self.outcomes],
            "pausedAt": self.paused_at,
            "pausedReason": self.paused_reason,
            "stopCondition": self.stop_condition,
            "cost": self.cost,
        }


class Pipeline:
    """一条流水线实例代表「一次编排会话」，可连续处理多章。"""

    def __init__(self, store: ProjectStore, client: LLMClient,
                 meter: Meter | None = None) -> None:
        self.store = store
        self.client = client
        self.meter = meter or Meter(store)
        self.cp = CheckpointManager(store)
        self.mode = ModeController(store)
        self._instances: dict[str, Any] = {}

    # ---------------- Agent 惰性构造（共享同一个 client，保证计量归集）----------------

    def agent(self, cls: type) -> Any:
        key = cls.__name__
        if key not in self._instances:
            self._instances[key] = cls(self.store, self.client, self.meter)
        return self._instances[key]

    # ---------------- 单步 ----------------

    async def run_step(
        self,
        chapter: int,
        step: str,
        *,
        on_event: Callable[[dict[str, Any]], Any] | None = None,
        should_stop: Callable[[], bool] | None = None,
        force: bool = False,
    ) -> StepOutcome:
        if step not in PIPELINE_STEPS:
            raise ValueError(f"未知环节：{step}")
        emit(on_event, type="step", step=step, label=STEP_LABELS[step], status="running")
        started = time.perf_counter()
        cost_before = self.meter.used
        tokens_before = self.meter.total_tokens

        handler = getattr(self, f"_step_{step}")
        try:
            outcome: StepOutcome = await handler(
                chapter, on_event=on_event, should_stop=should_stop, force=force)
        except BudgetExceeded:
            raise
        except Exception as exc:
            outcome = StepOutcome(step=step, status="failed", note=str(exc))

        outcome.elapsed_ms = int((time.perf_counter() - started) * 1000)
        outcome.cost = round(self.meter.used - cost_before, 4)
        outcome.tokens = self.meter.total_tokens - tokens_before

        # 保证每个走完的环节都留下 checkpoint —— 否则「计划/上下文」这类
        # 环节会因为没有快照而让进度条永远差两格，断点恢复也会算错位置。
        if outcome.status in ("ok", "skipped") and not self.cp.is_done(chapter, step):
            cp = self.cp.begin(chapter, step)
            self.cp.finish(cp, status="ok", note=outcome.note or "已完成")

        emit(on_event, type="step", step=step, label=outcome.label,
             status=outcome.status, note=outcome.note,
             elapsedMs=outcome.elapsed_ms, detail=outcome.detail)
        if outcome.status == "failed":
            raise PipelineStepFailed(outcome)
        return outcome

    # ---------------- 连续运行 ----------------

    async def run(
        self,
        chapter: int,
        *,
        steps: Sequence[str] | None = None,
        on_event: Callable[[dict[str, Any]], Any] | None = None,
        should_stop: Callable[[], bool] | None = None,
        respect_policy: bool = True,
        budget_exceeded: bool = False,
        fail_streak: int = 0,
    ) -> ChapterRun:
        run = ChapterRun(chapter=chapter)
        plan = list(steps or PIPELINE_STEPS)

        for step in plan:
            if should_stop is not None and should_stop():
                run.paused_at = step
                run.paused_reason = "已按用户请求停止。"
                emit(on_event, type="stopped", chapter=chapter, step=step)
                break

            # 确认点：策略要求人工点头，且调用方没给「已确认」
            if respect_policy and self.mode.needs_confirmation(step):
                run.paused_at = step
                run.paused_reason = (f"「{STEP_LABELS[step]}」需要你确认后继续"
                                     f"（当前模式：{self.mode.public()['modeLabel']}）。")
                emit(on_event, type="awaiting", chapter=chapter, step=step,
                     label=STEP_LABELS[step], reason=run.paused_reason)
                break

            try:
                outcome = await self.run_step(chapter, step, on_event=on_event,
                                              should_stop=should_stop)
            except BudgetExceeded as exc:
                run.paused_at = step
                run.stop_condition = "budget.exceeded"
                run.paused_reason = str(exc)
                emit(on_event, type="paused", chapter=chapter, step=step,
                     condition="budget.exceeded", reason=run.paused_reason)
                break
            except PipelineStepFailed as exc:
                run.outcomes.append(exc.outcome)
                run.paused_at = step
                run.paused_reason = exc.outcome.note or "这一步失败了。"
                break

            run.outcomes.append(outcome)

            # 审查之后检查熔断条件
            if step == "audit":
                audit = self.store.read_audit(chapter)
                hit = self.mode.check_stop(chapter=chapter, audit=audit,
                                           fail_streak=fail_streak,
                                           budget_exceeded=budget_exceeded,
                                           steer_affects_committed=run.steer_affects_committed)
                if hit:
                    run.paused_at = step
                    run.stop_condition = hit
                    run.paused_reason = self.mode.stop_reason(hit)
                    emit(on_event, type="paused", chapter=chapter, step=step,
                         condition=hit, reason=run.paused_reason)
                    break

        emit(on_event, type="done", chapter=chapter, run=run.public())
        return run

    # ==================================================================
    # 各环节实现
    # ==================================================================

    async def _step_plan(self, chapter: int, *, on_event=None, should_stop=None,
                         force: bool = False) -> StepOutcome:
        graph = self.store.outline_graph()
        node = graph.node(chapter)
        if node is not None and node.goal and node.beats and not force:
            return StepOutcome(step="plan", status="skipped",
                               note="本章章纲已存在，无需重新生成。",
                               detail={"title": node.title, "beats": len(node.beats)})
        if node is None and self.store.read_chapter(chapter)["paragraphs"] and not force:
            # 已有正文却没有章纲：补一条最小章纲即可，不必花一次模型调用
            return StepOutcome(step="plan", status="skipped",
                               note="本章已有正文，章纲缺失但不影响后续环节。")
        architect = self.agent(Architect)
        result = await architect.plan_chapter(chapter)
        node = self.store.outline_graph().node(chapter)
        return StepOutcome(step="plan", status="ok",
                           note=f"章纲：{node.title if node else '—'}",
                           detail={"proposals": len(result.proposals),
                                   "applied": len(result.commit.applied) if result.commit else 0,
                                   "pending": len(result.commit.pending) if result.commit else 0,
                                   "title": node.title if node else "",
                                   "beats": node.beats if node else [],
                                   "rationale": node.rationale if node else ""})

    async def _step_context(self, chapter: int, *, on_event=None, should_stop=None,
                            force: bool = False) -> StepOutcome:
        """上下文组装是**真实的一步**：它决定模型看到什么，值得让作者看见。"""
        node = self.store.outline_graph().node(chapter)
        draft = self.store.chapter_text(chapter)
        bundle = build_context(self.store, chapter, purpose="writer",
                              context_window=self.client.window_for("writer"),
                              node=node, draft=draft)
        return StepOutcome(step="context", status="ok",
                           note=f"已按分层预算装好，共 {bundle.used_tokens} 额度"
                                + ("（有裁剪）" if bundle.notes else ""),
                           detail=bundle.public())

    async def _step_draft(self, chapter: int, *, on_event=None, should_stop=None,
                          force: bool = False) -> StepOutcome:
        writer = self.agent(Writer)
        result = await writer.write(
            chapter,
            on_delta=(lambda text: emit(on_event, type="delta", step="draft", text=text)),
            should_stop=should_stop,
            continue_draft=not force,
        )
        return StepOutcome(
            step="draft",
            status="ok",
            note=(f"{result.words} 字"
                  + ("（用户中途停止，已保存半成品）" if result.cancelled else "")),
            detail={"words": result.words, "paragraphs": len(result.paragraphs),
                    "cancelled": result.cancelled,
                    "context": result.context.public() if result.context else None,
                    "model": f"{result.result.provider}/{result.result.model}" if result.result else ""},
        )

    async def _step_audit(self, chapter: int, *, on_event=None, should_stop=None,
                          force: bool = False) -> StepOutcome:
        auditor = self.agent(Auditor)
        report = await auditor.audit(chapter)
        return StepOutcome(step="audit", status="ok",
                           note=(f"规则命中 {len(report.l1_violations)} 条 · "
                                 f"共 {len(report.items)} 条待处理"),
                           detail=_audit_detail(report))

    async def _step_review(self, chapter: int, *, on_event=None, should_stop=None,
                           force: bool = False) -> StepOutcome:
        report = self.store.read_audit(chapter)
        if report is None:
            return StepOutcome(step="review", status="skipped",
                               note="还没审查过，先跑一次审查。")
        reviewer = self.agent(Reviewer)
        result = await reviewer.review(chapter)
        return StepOutcome(step="review", status="ok",
                           note=f"{len(result.dims)} 维 · 综合 {result.overall} 分",
                           detail={"overall": result.overall,
                                   "dims": [d.model_dump() for d in result.dims]})

    async def _step_deai(self, chapter: int, *, on_event=None, should_stop=None,
                         force: bool = False) -> StepOutcome:
        text = self.store.chapter_text(chapter)
        if not text.strip():
            return StepOutcome(step="deai", status="skipped", note="本章还没有正文。")
        l1 = check_l1(L1Input(
            text=text, chapter=chapter, characters=self.store.characters(),
            hooks=self.store.hooks(), world_rules=self.store.world().rules,
            style=self.store.style(),
        ))
        hits = [v for v in l1.violations if v.rule in _AI_FLAVOR_RULES]
        if not hits and not force:
            return StepOutcome(step="deai", status="skipped",
                               note="规则校验没发现 AI 味，无需改写。",
                               detail={"violations": len(l1.violations)})

        reviser = self.agent(Reviser)
        result = await reviser.strip_ai(chapter)
        return StepOutcome(
            step="deai", status="ok",
            note=(f"{len(result.patches)} 处定点改写，{result.rounds} 轮"
                  + ("，已收敛" if result.converged else "，仍需人工确认")),
            detail=result.to_dict(),
        )

    async def _step_revise(self, chapter: int, *, on_event=None, should_stop=None,
                           force: bool = False) -> StepOutcome:
        report = self.store.read_audit(chapter)
        if report is None:
            return StepOutcome(step="revise", status="skipped",
                               note="还没审查过，先跑一次审查。")
        fixable = [i for i in report.items if i.decision != "ignore"
                   and (i.decision == "accept" or i.severity in ("blocker", "major"))]
        if not fixable:
            return StepOutcome(step="revise", status="skipped",
                               note="没有需要自动修订的问题（建议级只记录，不改动）。")
        reviser = self.agent(Reviser)
        result = await reviser.revise(chapter)
        return StepOutcome(
            step="revise", status="ok",
            note=(f"{len(result.applied)} 处修订"
                  + ("，规则校验已通过" if result.converged else "，需人工确认")),
            detail=result.public(),
        )

    async def _step_commit(self, chapter: int, *, on_event=None, should_stop=None,
                           force: bool = False) -> StepOutcome:
        data = self.store.read_chapter(chapter)
        if not data["paragraphs"]:
            return StepOutcome(step="commit", status="skipped", note="本章还没有正文。")
        report = self.store.read_audit(chapter)
        if report is None and not force:
            return StepOutcome(step="commit", status="skipped",
                               note="还没审查过，不允许直接定稿（这是有意为之）。")
        archivist = self.agent(Archivist)
        result = await archivist.archive(chapter)
        return StepOutcome(
            step="commit", status="ok",
            note=(f"已归档：新埋 {len(result.hooks_planted)} 条伏笔 · "
                  f"回收 {len(result.hooks_resolved)} 条"),
            detail=result.public(),
        )


class PipelineStepFailed(Exception):
    def __init__(self, outcome: StepOutcome) -> None:
        super().__init__(outcome.note)
        self.outcome = outcome


def _audit_detail(report: AuditReport) -> dict[str, Any]:
    return {
        "stats": report.stats,
        "l1": [{"rule": r.get("rule"), "hit": r.get("isHit"),
                "count": r.get("count"), "threshold": r.get("threshold"),
                "sample": r.get("hit")} for r in report.l1_checked],
        "l1Violations": len(report.l1_violations),
        "items": [i.model_dump() for i in report.items],
        "hasBlocker": any(i.severity == "blocker" and not i.fixed for i in report.items),
    }
