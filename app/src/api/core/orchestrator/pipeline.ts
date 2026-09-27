/**
 * 单章流水线状态机（规划文档 §7.2）—— 镜像 `server/dobi/orchestrator/pipeline.py`。
 *
 * ```
 * 章纲 ─► 上下文组装 ─► 草稿 ─► 审查 ─► 可举证评审 ─► 去 AI 味 ─► 修订 ─► 定稿
 * ▲           │          │        │          │          │        │       │
 * └── 干预策略层插入「确认点」；实时干预可在任意时刻注入 ──────────────┘
 * ```
 *
 * 每环节结束写 checkpoint。干预策略决定哪些环节需人工确认（`mode.ModeController`）。
 *
 * 两种驱动方式：
 * - `runStep()` —— 前端逐个按钮触发（半自动 / 手动模式）
 * - `run()`    —— 一次跑到停（全自动模式，由 `runner.BookRunner` 调用）
 */

import { Agent, Architect, Archivist, Auditor, Reviser, Reviewer, Writer } from '../agents'
import { CheckpointManager } from '../checkpoint'
import { buildContext } from '../context'
import { checkL1 } from '../l1'
import { windowFor } from '../llm'
import { graphNode } from '../memory'
import { Meter } from '../metering'
import { ModeController } from '../mode'
import { BudgetExceededError, type ProjectStore } from '../store'
import { PIPELINE_STEPS, STEP_LABELS } from '../types'
import type { AuditReport, PipelineStep } from '../types'
import { nowIso } from '../util'
import { Planner, PlanOutcome } from './planner'

//: 属于「AI 味」范畴的规则 —— 只有这些命中才需要跑去味环节
const AI_FLAVOR_RULES: ReadonlySet<string> = new Set([
  '禁用句式命中', '套话密度超阈值', '连续「了／的」字句',
  '词汇疲劳', '段落长度异常', '描写／对话比例偏离',
])

/** 事件回调（SSE 风格）。返回 null 时 `emit` 直接忽略。 */
export type EventCallback = ((payload: Record<string, unknown>) => void) | null

export function emit(onEvent: EventCallback | undefined, payload: Record<string, unknown>): void {
  if (onEvent == null) return
  try {
    onEvent(payload)
  } catch {
    /* 事件回调异常不影响主流程 */
  }
}

export type StepStatus = 'ok' | 'skipped' | 'failed' | 'awaiting'

export interface StepOpts {
  onEvent?: EventCallback
  shouldStop?: (() => boolean) | null
  force?: boolean
}

type StepHandler = (chapter: number, opts: StepOpts) => Promise<StepOutcome>

export class StepOutcome {
  step: string
  status: StepStatus = 'ok'
  detail: Record<string, unknown> = {}
  note = ''
  elapsed_ms = 0
  cost = 0.0
  tokens = 0

  constructor(init: {
    step: string
    status?: StepStatus
    detail?: Record<string, unknown>
    note?: string
    elapsed_ms?: number
    cost?: number
    tokens?: number
  }) {
    this.step = init.step
    if (init.status !== undefined) this.status = init.status
    if (init.detail !== undefined) this.detail = init.detail
    if (init.note !== undefined) this.note = init.note
    if (init.elapsed_ms !== undefined) this.elapsed_ms = init.elapsed_ms
    if (init.cost !== undefined) this.cost = init.cost
    if (init.tokens !== undefined) this.tokens = init.tokens
  }

  get label(): string {
    return STEP_LABELS[this.step] ?? this.step
  }

  public(): Record<string, unknown> {
    return {
      step: this.step, label: this.label, status: this.status,
      note: this.note, elapsedMs: this.elapsed_ms,
      cost: Math.round(this.cost * 10000) / 10000, tokens: this.tokens,
      detail: this.detail,
    }
  }
}

export class ChapterRun {
  chapter: number
  outcomes: StepOutcome[] = []
  paused_at: string | null = null
  paused_reason = ''
  stop_condition: string | null = null
  steer_affects_committed = false

  constructor(chapter: number) {
    this.chapter = chapter
  }

  get ok(): boolean {
    return !this.paused_at && !this.outcomes.some((o) => o.status === 'failed')
  }

  get cost(): number {
    return Math.round(this.outcomes.reduce((s, o) => s + o.cost, 0) * 10000) / 10000
  }

  public(): Record<string, unknown> {
    return {
      chapter: this.chapter,
      ok: this.ok,
      outcomes: this.outcomes.map((o) => o.public()),
      pausedAt: this.paused_at,
      pausedReason: this.paused_reason,
      stopCondition: this.stop_condition,
      cost: this.cost,
    }
  }
}

export class Pipeline {
  /** 一条流水线实例代表「一次编排会话」，可连续处理多章。 */
  readonly store: ProjectStore
  readonly meter: Meter
  readonly cp: CheckpointManager
  readonly mode: ModeController
  private readonly _instances = new Map<string, unknown>()
  private readonly _handlers: Record<string, StepHandler>

  constructor(store: ProjectStore, meter?: Meter | null) {
    this.store = store
    this.meter = meter ?? new Meter(store)
    this.cp = new CheckpointManager(store)
    this.mode = new ModeController(store)
    this._handlers = {
      plan: (chapter, opts) => this._stepPlan(chapter, opts),
      context: (chapter, opts) => this._stepContext(chapter, opts),
      draft: (chapter, opts) => this._stepDraft(chapter, opts),
      audit: (chapter, opts) => this._stepAudit(chapter, opts),
      review: (chapter, opts) => this._stepReview(chapter, opts),
      deai: (chapter, opts) => this._stepDeai(chapter, opts),
      revise: (chapter, opts) => this._stepRevise(chapter, opts),
      commit: (chapter, opts) => this._stepCommit(chapter, opts),
    }
  }

  // ---------------- Agent 惰性构造（共享同一个 client，保证计量归集）----------------

  agent<T extends Agent>(cls: new (store: ProjectStore, meter?: Meter | null) => T): T {
    const key = cls.name
    let inst = this._instances.get(key) as T | undefined
    if (inst === undefined) {
      inst = new cls(this.store, this.meter)
      this._instances.set(key, inst)
    }
    return inst
  }

  // ---------------- 单步 ----------------

  async runStep(
    chapter: number,
    step: string,
    opts: { onEvent?: EventCallback; shouldStop?: (() => boolean) | null; force?: boolean } = {},
  ): Promise<StepOutcome> {
    const { onEvent = null, shouldStop = null, force = false } = opts
    if (!PIPELINE_STEPS.includes(step as PipelineStep)) {
      throw new Error(`未知环节：${step}`)
    }
    emit(onEvent, { type: 'step', step, label: STEP_LABELS[step], status: 'running' })
    const started = Date.now()
    const costBefore = this.meter.used
    const tokensBefore = this.meter.totalTokens

    const handler = this._handlers[step]
    if (handler === undefined) throw new Error(`未知环节：${step}`)
    let outcome: StepOutcome
    try {
      outcome = await handler(chapter, { onEvent, shouldStop, force })
    } catch (e) {
      if (e instanceof BudgetExceededError) throw e
      outcome = new StepOutcome({
        step,
        status: 'failed',
        note: e instanceof Error ? e.message : String(e),
      })
    }

    outcome.elapsed_ms = Date.now() - started
    outcome.cost = Math.round((this.meter.used - costBefore) * 10000) / 10000
    outcome.tokens = this.meter.totalTokens - tokensBefore

    // 保证每个走完的环节都留下 checkpoint —— 否则「计划/上下文」这类
    // 环节会因为没有快照而让进度条永远差两格，断点恢复也会算错位置。
    if ((outcome.status === 'ok' || outcome.status === 'skipped') && !this.cp.isDone(chapter, step)) {
      const cp = this.cp.begin(chapter, step)
      this.cp.finish(cp, { status: 'ok', note: outcome.note || '已完成' })
    }

    emit(onEvent, {
      type: 'step', step, label: outcome.label,
      status: outcome.status, note: outcome.note,
      elapsedMs: outcome.elapsed_ms, detail: outcome.detail,
    })
    if (outcome.status === 'failed') throw new PipelineStepFailed(outcome)
    return outcome
  }

  // ---------------- 连续运行 ----------------

  async run(
    chapter: number,
    opts: {
      steps?: string[]
      onEvent?: EventCallback
      shouldStop?: (() => boolean) | null
      respectPolicy?: boolean
      budgetExceeded?: boolean
      failStreak?: number
    } = {},
  ): Promise<ChapterRun> {
    const {
      steps = null, onEvent = null, shouldStop = null,
      respectPolicy = true, budgetExceeded = false, failStreak = 0,
    } = opts
    const run = new ChapterRun(chapter)
    const plan = steps ? [...steps] : [...PIPELINE_STEPS]

    for (const step of plan) {
      if (shouldStop !== null && shouldStop()) {
        run.paused_at = step
        run.paused_reason = '已按用户请求停止。'
        emit(onEvent, { type: 'stopped', chapter, step })
        break
      }

      // 确认点：策略要求人工点头，且调用方没给「已确认」
      if (respectPolicy && this.mode.needsConfirmation(step)) {
        run.paused_at = step
        run.paused_reason =
          `「${STEP_LABELS[step]}」需要你确认后继续（当前模式：${String(this.mode.public()['modeLabel'])}）。`
        emit(onEvent, {
          type: 'awaiting', chapter, step,
          label: STEP_LABELS[step], reason: run.paused_reason,
        })
        break
      }

      let outcome: StepOutcome
      try {
        outcome = await this.runStep(chapter, step, { onEvent, shouldStop })
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          run.paused_at = step
          run.stop_condition = 'budget.exceeded'
          run.paused_reason = e.message
          emit(onEvent, {
            type: 'paused', chapter, step,
            condition: 'budget.exceeded', reason: run.paused_reason,
          })
          break
        }
        if (e instanceof PipelineStepFailed) {
          run.outcomes.push(e.outcome)
          run.paused_at = step
          run.paused_reason = e.outcome.note || '这一步失败了。'
          break
        }
        throw e
      }

      run.outcomes.push(outcome)

      // 审查之后检查熔断条件
      if (step === 'audit') {
        const audit = this.store.readAudit(chapter)
        const hit = this.mode.checkStop({
          chapter,
          audit,
          failStreak,
          budgetExceeded,
          steerAffectsCommitted: run.steer_affects_committed,
        })
        if (hit !== null) {
          run.paused_at = step
          run.stop_condition = hit
          run.paused_reason = ModeController.stopReason(hit)
          emit(onEvent, {
            type: 'paused', chapter, step,
            condition: hit, reason: run.paused_reason,
          })
          break
        }
      }
    }

    emit(onEvent, { type: 'done', chapter, run: run.public() })
    return run
  }

  // ==================================================================
  // 各环节实现
  // ==================================================================

  async _stepPlan(chapter: number, opts: StepOpts): Promise<StepOutcome> {
    const { force = false } = opts
    const graph = this.store.outlineGraph()
    const node = graphNode(graph, chapter)
    if (node !== null && node.goal && node.beats.length > 0 && !force) {
      return new StepOutcome({
        step: 'plan', status: 'skipped',
        note: '本章章纲已存在，无需重新生成。',
        detail: { title: node.title, beats: node.beats.length },
      })
    }
    if (node === null && this.store.readChapter(chapter).paragraphs.length > 0 && !force) {
      // 已有正文却没有章纲：补一条最小章纲即可，不必花一次模型调用
      return new StepOutcome({
        step: 'plan', status: 'skipped',
        note: '本章已有正文，章纲缺失但不影响后续环节。',
      })
    }
    const architect = this.agent(Architect)
    const result = await architect.planChapter(chapter)
    const after = graphNode(this.store.outlineGraph(), chapter)
    return new StepOutcome({
      step: 'plan', status: 'ok',
      note: `章纲：${after ? after.title : '—'}`,
      detail: {
        proposals: result.proposals.length,
        applied: result.commit ? result.commit.applied.length : 0,
        pending: result.commit ? result.commit.pending.length : 0,
        title: after ? after.title : '',
        beats: after ? after.beats : [],
        rationale: after ? after.rationale : '',
      },
    })
  }

  async _stepContext(chapter: number, _opts: StepOpts): Promise<StepOutcome> {
    /** 上下文组装是**真实的一步**：它决定模型看到什么，值得让作者看见。 */
    const node = graphNode(this.store.outlineGraph(), chapter)
    const draft = this.store.chapterText(chapter)
    const bundle = buildContext(this.store, chapter, {
      purpose: 'writer',
      contextWindow: windowFor('writer'),
      node,
      draft,
    })
    return new StepOutcome({
      step: 'context', status: 'ok',
      note: `已按分层预算装好，共 ${bundle.usedTokens} 额度${bundle.notes.length ? '（有裁剪）' : ''}`,
      detail: bundle.public(),
    })
  }

  async _stepDraft(chapter: number, opts: StepOpts): Promise<StepOutcome> {
    const { onEvent = null, shouldStop = null, force = false } = opts
    const writer = this.agent(Writer)
    const result = await writer.write(chapter, {
      onDelta: (text) => emit(onEvent, { type: 'delta', step: 'draft', text }),
      shouldStop: shouldStop ?? undefined,
      continueDraft: !force,
    })
    return new StepOutcome({
      step: 'draft', status: 'ok',
      note: `${result.words} 字${result.cancelled ? '（用户中途停止，已保存半成品）' : ''}`,
      detail: {
        words: result.words,
        paragraphs: result.paragraphs.length,
        cancelled: result.cancelled,
        context: result.context ? result.context.public() : null,
        model: result.result ? `${result.result.provider}/${result.result.model}` : '',
      },
    })
  }

  async _stepAudit(chapter: number, _opts: StepOpts): Promise<StepOutcome> {
    const auditor = this.agent(Auditor)
    const report = await auditor.audit(chapter)
    return new StepOutcome({
      step: 'audit', status: 'ok',
      note: `规则命中 ${report.l1_violations.length} 条 · 共 ${report.items.length} 条待处理`,
      detail: auditDetail(report),
    })
  }

  async _stepReview(chapter: number, _opts: StepOpts): Promise<StepOutcome> {
    const report = this.store.readAudit(chapter)
    if (report === null) {
      return new StepOutcome({
        step: 'review', status: 'skipped',
        note: '还没审查过，先跑一次审查。',
      })
    }
    const reviewer = this.agent(Reviewer)
    const result = await reviewer.review(chapter)
    return new StepOutcome({
      step: 'review', status: 'ok',
      note: `${result.dims.length} 维 · 综合 ${result.overall} 分`,
      detail: {
        overall: result.overall,
        dims: result.dims.map((d) => ({ ...d })),
      },
    })
  }

  async _stepDeai(chapter: number, opts: StepOpts): Promise<StepOutcome> {
    const { force = false } = opts
    const text = this.store.chapterText(chapter)
    if (!text.trim()) {
      return new StepOutcome({ step: 'deai', status: 'skipped', note: '本章还没有正文。' })
    }
    const l1 = checkL1({
      text,
      chapter,
      characters: this.store.characters(),
      hooks: this.store.hooks(),
      world_rules: this.store.world().rules,
      style: this.store.style(),
    })
    const hits = l1.violations.filter((v) => AI_FLAVOR_RULES.has(v.rule))
    if (!hits.length && !force) {
      return new StepOutcome({
        step: 'deai', status: 'skipped',
        note: '规则校验没发现 AI 味，无需改写。',
        detail: { violations: l1.violations.length },
      })
    }

    const reviser = this.agent(Reviser)
    const result = await reviser.stripAi(chapter)
    return new StepOutcome({
      step: 'deai', status: 'ok',
      note: `${result.patches.length} 处定点改写，${result.rounds} 轮${result.converged ? '，已收敛' : '，仍需人工确认'}`,
      detail: result.toDict(),
    })
  }

  async _stepRevise(chapter: number, _opts: StepOpts): Promise<StepOutcome> {
    const report = this.store.readAudit(chapter)
    if (report === null) {
      return new StepOutcome({
        step: 'revise', status: 'skipped',
        note: '还没审查过，先跑一次审查。',
      })
    }
    const fixable = report.items.filter(
      (i) =>
        i.decision !== 'ignore' &&
        (i.decision === 'accept' || i.severity === 'blocker' || i.severity === 'major'),
    )
    if (!fixable.length) {
      return new StepOutcome({
        step: 'revise', status: 'skipped',
        note: '没有需要自动修订的问题（建议级只记录，不改动）。',
      })
    }
    const reviser = this.agent(Reviser)
    const result = await reviser.revise(chapter)
    return new StepOutcome({
      step: 'revise', status: 'ok',
      note: `${result.applied.length} 处修订${result.converged ? '，规则校验已通过' : '，需人工确认'}`,
      detail: result.public(),
    })
  }

  async _stepCommit(chapter: number, opts: StepOpts): Promise<StepOutcome> {
    const { force = false } = opts
    const data = this.store.readChapter(chapter)
    if (!data.paragraphs.length) {
      return new StepOutcome({ step: 'commit', status: 'skipped', note: '本章还没有正文。' })
    }
    const report = this.store.readAudit(chapter)
    if (report === null && !force) {
      return new StepOutcome({
        step: 'commit', status: 'skipped',
        note: '还没审查过，不允许直接定稿（这是有意为之）。',
      })
    }
    const archivist = this.agent(Archivist)
    const result = await archivist.archive(chapter)
    return new StepOutcome({
      step: 'commit', status: 'ok',
      note: `已归档：新埋 ${result.hooks_planted.length} 条伏笔 · 回收 ${result.hooks_resolved.length} 条`,
      detail: result.public(),
    })
  }
}

export class PipelineStepFailed extends Error {
  readonly outcome: StepOutcome

  constructor(outcome: StepOutcome) {
    super(outcome.note)
    this.name = 'PipelineStepFailed'
    this.outcome = outcome
  }
}

function auditDetail(report: AuditReport): Record<string, unknown> {
  return {
    stats: report.stats,
    l1: report.l1_checked.map((r) => ({
      rule: r.rule,
      hit: r.isHit,
      count: r.count,
      threshold: r.threshold,
      sample: r.hit,
    })),
    l1Violations: report.l1_violations.length,
    items: report.items.map((i) => ({ ...i })),
    hasBlocker: report.items.some((i) => i.severity === 'blocker' && !i.fixed),
  }
}

// ==========================================================================
// 整本生产流程（规划文档 §7.6）—— 镜像 `server/dobi/orchestrator/runner.py`
// ==========================================================================

export class RunReport {
  started_at: string
  finished_at = ''
  chapters: Array<Record<string, unknown>> = []
  stop_condition: string | null = null
  stopped_reason = ''
  completions = 0
  cost = 0.0
  tokens = 0

  constructor() {
    this.started_at = nowIso()
  }

  public(): Record<string, unknown> {
    return {
      startedAt: this.started_at,
      finishedAt: this.finished_at,
      chapters: this.chapters,
      completedChapters: this.chapters.filter((c) => Boolean(c.committed)).map((c) => Number(c.chapter)),
      stopCondition: this.stop_condition,
      stoppedReason: this.stopped_reason,
      cost: Math.round(this.cost * 10000) / 10000,
      tokens: this.tokens,
    }
  }
}

export class BookRunner {
  readonly store: ProjectStore
  readonly meter: Meter
  readonly cp: CheckpointManager
  readonly mode: ModeController
  readonly planner: Planner
  readonly pipeline: Pipeline

  constructor(store: ProjectStore, meter?: Meter | null) {
    this.store = store
    this.meter = meter ?? new Meter(store)
    this.cp = new CheckpointManager(store)
    this.mode = new ModeController(store)
    this.planner = new Planner(store, this.meter)
    this.pipeline = new Pipeline(store, this.meter)
  }

  async run(
    opts: {
      maxChapters?: number
      fromChapter?: number | null
      onEvent?: EventCallback
      shouldStop?: (() => boolean) | null
    } = {},
  ): Promise<RunReport> {
    const { maxChapters = 20, fromChapter = null, onEvent = null, shouldStop = null } = opts
    const report = new RunReport()
    const costBefore = this.meter.used
    const tokensBefore = this.meter.totalTokens
    let failStreak = 0
    let stalled = 0
    let lastSignature: [string, number] | null = null

    emit(onEvent, { type: 'run_start', chapter: fromChapter ?? 0, report: report.public() })

    let plan = this.cp.diagnose(fromChapter ?? undefined)
    emit(onEvent, { type: 'resume', chapter: plan.chapter, plan: plan.public() })

    let guardIterations = 0
    while (report.chapters.length < maxChapters) {
      guardIterations += 1
      if (guardIterations > maxChapters * 4 + 12) {
        report.stop_condition = 'guard'
        report.stopped_reason = '进度没有继续推进，已安全停下（避免空转消耗预算）。'
        break
      }

      if (shouldStop !== null && shouldStop()) {
        report.stopped_reason = '已按请求停止。'
        emit(onEvent, { type: 'stopped', chapter: plan.chapter })
        break
      }

      // ---- 预算闸门 ----
      try {
        this.meter.checkBudget()
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          report.stop_condition = 'budget.exceeded'
          report.stopped_reason = e.message
          emit(onEvent, {
            type: 'paused', chapter: plan.chapter,
            condition: 'budget.exceeded', reason: report.stopped_reason,
          })
          break
        }
        throw e
      }

      // ---- 补全规划 ----
      if (plan.action === 'replan') {
        emit(onEvent, {
          type: 'planning', chapter: plan.chapter, kind: 'bootstrap', reason: plan.reason,
        })
        let outcome: PlanOutcome
        try {
          outcome = await this.planner.bootstrap()
        } catch (e) {
          if (e instanceof BudgetExceededError) {
            report.stop_condition = 'budget.exceeded'
            report.stopped_reason = e.message
            break
          }
          throw e
        }
        emit(onEvent, { type: 'planning_done', chapter: plan.chapter, outcome: outcome.public() })
        plan = this.cp.diagnose()
        if (lastSignature !== null && plan.action === lastSignature[0] && plan.chapter === lastSignature[1]) {
          stalled += 1
        } else {
          stalled = 0
        }
        lastSignature = [plan.action, plan.chapter]
        if (stalled >= 2) {
          report.stopped_reason = '设定补全后仍无法进入写作，请人工检查大纲与角色。'
          break
        }
        continue
      }

      if (plan.action === 'expand_volume') {
        emit(onEvent, {
          type: 'planning', chapter: plan.chapter, kind: 'roll', reason: plan.reason,
        })
        let outcome: PlanOutcome
        try {
          outcome = await this.planner.rollNext()
        } catch (e) {
          if (e instanceof BudgetExceededError) {
            report.stop_condition = 'budget.exceeded'
            report.stopped_reason = e.message
            break
          }
          // 没有可展开的骨架卷——不当作错误，直接往下走写正文
          emit(onEvent, {
            type: 'note', chapter: plan.chapter,
            message: e instanceof Error ? e.message : String(e),
          })
          plan = this.cp.diagnose(plan.chapter + 1)
          lastSignature = [plan.action, plan.chapter]
          continue
        }
        emit(onEvent, { type: 'planning_done', chapter: plan.chapter, outcome: outcome.public() })
        plan = this.cp.diagnose()
        lastSignature = [plan.action, plan.chapter]
        continue
      }

      // ---- 跑这一章 ----
      const chapter = plan.chapter
      const snapshot = this.store.readChapter(chapter)

      let guard: PlanOutcome | null = null
      try {
        guard = await this.planner.ensureForChapter(chapter)
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          report.stop_condition = 'budget.exceeded'
          report.stopped_reason = e.message
          break
        }
        throw e
      }
      if (guard !== null) {
        emit(onEvent, { type: 'planning_done', chapter, outcome: guard.public() })
      }

      emit(onEvent, { type: 'chapter_start', chapter })
      const run = await this.pipeline.run(chapter, {
        respectPolicy: false,
        onEvent,
        shouldStop,
        failStreak,
      })

      const audit = this.store.readAudit(chapter)
      const unresolved = (audit ? audit.items : []).filter(
        (i) => (i.severity === 'blocker' || i.severity === 'major') && !i.fixed && i.decision !== 'ignore',
      )
      failStreak = unresolved.length ? failStreak + 1 : 0
      const final = this.store.readChapter(chapter)
      const committed = final.status === 'done'

      report.chapters.push({
        chapter,
        title: final.title,
        words: final.words,
        committed,
        openIssues: unresolved.length,
        cost: Math.round((this.meter.used - costBefore) * 10000) / 10000,
        run: run.public(),
      })
      emit(onEvent, {
        type: 'chapter_done', chapter,
        committed, words: final.words, openIssues: unresolved.length,
      })

      // ---- 熔断 ----
      if (run.stop_condition) {
        report.stop_condition = run.stop_condition
        report.stopped_reason = run.paused_reason
        break
      }
      if (run.paused_at) {
        report.stopped_reason = run.paused_reason
        break
      }

      // ---- 是否已达成目标 ----
      const meta = this.store.meta()
      if (meta.chapters_total && chapter >= meta.chapters_total) {
        report.stopped_reason = `已写到本书计划的第 ${meta.chapters_total} 章。`
        break
      }

      if (snapshot.status === final.status && final.paragraphs.length === 0) {
        stalled += 1
      } else {
        stalled = 0
      }
      if (stalled >= 2) {
        report.stopped_reason = '连续两次没有产出，已安全停下。'
        break
      }

      plan = this.cp.diagnose()
      if (plan.action === 'continue_draft' && plan.chapter === chapter && committed) {
        // 该章已定稿，别再诊断回它
        plan = this.cp.diagnose(chapter + 1)
      }
      lastSignature = [plan.action, plan.chapter]
    }

    report.finished_at = nowIso()
    report.completions = report.chapters.filter((c) => Boolean(c.committed)).length
    report.cost = Math.round((this.meter.used - costBefore) * 10000) / 10000
    report.tokens = this.meter.totalTokens - tokensBefore

    emit(onEvent, {
      type: 'run_done',
      report: report.public(),
      hooks: this.store.hookStats(),
      budget: this.meter.budget(),
    })
    return report
  }

  // ---------------- 收尾产出 ----------------

  summary(): Record<string, unknown> {
    /** 结束产出：正文全稿概况 + 审查与评审 + 伏笔回收率 + 成本清单。 */
    const store = this.store
    const overview = store.chaptersOverview()
    const audits: Array<Record<string, unknown>> = []
    for (const item of overview) {
      const n = item.n as number
      const report = store.readAudit(n)
      const review = store.readReview(n)
      if (report === null && review === null) continue
      audits.push({
        chapter: n,
        title: item.title,
        open: report ? (report.stats.open ?? 0) : 0,
        blocker: report ? (report.stats.blocker ?? 0) : 0,
        major: report ? (report.stats.major ?? 0) : 0,
        passRate: report ? (report.stats.passRate ?? 0) : 0,
        l1: report ? report.l1_violations.length : 0,
        reviewOverall: review ? review.overall : null,
        reviewDims: review ? review.dims.map((d) => ({ ...d })) : [],
      })
    }
    return {
      chapters: overview,
      words: overview.reduce((s, c) => s + (c.words as number), 0),
      committed: overview.filter((c) => c.status === 'done').length,
      audits,
      hooks: store.hookStats(),
      usage: this.meter.public(),
      coverage: this.planner.coverage(),
    }
  }
}
