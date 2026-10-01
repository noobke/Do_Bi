/**
 * 实时干预 Steer（规划文档 §7.5）。
 *
 * **不暂停生产**，作者随时注入意见。系统必须自动完成三件事：
 *
 * 1. **意图解析**：自然语言 → 结构化指令（如「节奏太慢，压缩到三段」→
 *    `{action: compress, target_chapter: 18, scope: current}`）
 * 2. **影响范围评估**：当前章 / 后续大纲 / 已定稿章 —— 依据 **依赖图**推导，不瞎猜
 * 3. **按范围执行**：
 *    - 只影响当前章 → 标记待重写，并把意见注入下一次写作上下文
 *    - 影响后续大纲 → 受影响章的章纲标记为待重排
 *    - **影响已定稿章 → 生成追溯修订提案，等人工确认，绝不静默改写历史**
 */

import * as prompts from '../agents/prompts'
import { fmt } from '../agents/architect'
import { CheckpointManager } from '../checkpoint'
import { Meter } from '../metering'
import { completeJson } from '../llm'
import type { ProjectStore } from '../store'
import type { SteeringDirective } from '../types'

const _ACTIONS = new Set([
  'compress', 'expand', 'rewrite', 'add', 'remove',
  'adjust_character', 'adjust_plot', 'adjust_style', 'unknown',
])
const _SCOPES = new Set(['current', 'outline', 'committed'])

export const ACTION_LABELS: Record<string, string> = {
  compress: '压缩节奏', expand: '展开细节', rewrite: '重写',
  add: '增加内容', remove: '删除内容', adjust_character: '调整人物',
  adjust_plot: '调整情节', adjust_style: '调整文风', unknown: '未能判定',
}

export class SteerIntent {
  intent = ''
  action = 'unknown'
  target_chapter = 1
  scope = 'current'
  affected_chapters: number[] = []
  steps: string[] = []
  requires_confirmation = false
  reason = ''

  constructor(init: Partial<SteerIntent> = {}) {
    if (init.intent !== undefined) this.intent = init.intent
    if (init.action !== undefined) this.action = init.action
    if (init.target_chapter !== undefined) this.target_chapter = init.target_chapter
    if (init.scope !== undefined) this.scope = init.scope
    if (init.affected_chapters !== undefined) this.affected_chapters = init.affected_chapters
    if (init.steps !== undefined) this.steps = init.steps
    if (init.requires_confirmation !== undefined) this.requires_confirmation = init.requires_confirmation
    if (init.reason !== undefined) this.reason = init.reason
  }

  public(): Record<string, unknown> {
    return {
      intent: this.intent,
      action: this.action,
      actionLabel: ACTION_LABELS[this.action] ?? this.action,
      targetChapter: this.target_chapter,
      scope: this.scope,
      affectedChapters: this.affected_chapters,
      steps: this.steps,
      requiresConfirmation: this.requires_confirmation,
      reason: this.reason,
    }
  }
}

export class SteerResult {
  text: string
  intent: SteerIntent
  applied = false
  pending_confirmation = false
  changed: string[] = []
  directive_id = ''
  message = ''

  constructor(init: { text: string; intent: SteerIntent }) {
    this.text = init.text
    this.intent = init.intent
  }

  public(): Record<string, unknown> {
    return {
      text: this.text,
      intent: this.intent.public(),
      applied: this.applied,
      pendingConfirmation: this.pending_confirmation,
      changed: this.changed,
      directiveId: this.directive_id,
      message: this.message,
    }
  }
}

export class Steering {
  readonly store: ProjectStore
  readonly meter: Meter
  readonly cp: CheckpointManager

  constructor(store: ProjectStore, meter?: Meter | null) {
    this.store = store
    this.meter = meter ?? new Meter(store)
    this.cp = new CheckpointManager(store)
  }

  // ---------------- 意图解析 ----------------

  async interpret(text: string): Promise<SteerIntent> {
    const store = this.store
    const overview = store.chaptersOverview()
    const graph = store.outlineGraph()

    const writing = overview
      .filter((c) => c.status !== 'todo' && c.status !== 'planned')
      .map((c) => c.n as number)
    const current = writing.length ? Math.max(...writing) : 1
    const committed = overview.filter((c) => c.status === 'done').map((c) => c.n as number)
    const lastCommitted = committed.length ? Math.max(...committed) : 0
    const currentItem = overview.find((c) => c.n === current) ?? null

    const depLines =
      graph.edges
        .map((e) => `- 第 ${e.from_chapter} 章 → 依赖第 ${e.to_chapter} 章（${e.type}）：${e.note}`)
        .join('\n') || '（尚无依赖边）'

    this.meter.setChapterScope(current, 'steer')
    this.meter.checkBudget()

    const nodeChapters = graph.nodes.map((n) => n.chapter)
    const { data } = await completeJson('steer', [
      {
        role: 'user',
        content: fmt(prompts.STEER, {
          current_chapter: String(current),
          current_status: String((currentItem as Record<string, unknown> | null)?.status ?? 'todo'),
          last_committed: String(lastCommitted),
          outline_range:
            `第 ${nodeChapters.length ? Math.min(...nodeChapters) : 1}` +
            `–${nodeChapters.length ? Math.max(...nodeChapters) : 1} 章`,
          dependencies: depLines,
          text,
        }),
      },
    ])

    const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    const action = String(obj.action || 'unknown')
    const scope = String(obj.scope || 'current')

    let target = current
    const rawTarget = obj.target_chapter
    if (rawTarget !== undefined && rawTarget !== null && rawTarget !== 0 && rawTarget !== '') {
      const num = Number(rawTarget)
      if (Number.isFinite(num) && Number.isInteger(num)) target = num
    }

    const affected: number[] = []
    const rawAffected = obj.affected_chapters
    if (Array.isArray(rawAffected)) {
      for (const value of rawAffected) {
        const num = Math.trunc(Number(value))
        if (Number.isFinite(num) && num > 0 && !affected.includes(num)) affected.push(num)
      }
    }

    const rawSteps = obj.steps
    const steps = Array.isArray(rawSteps)
      ? rawSteps.map((s) => String(s).trim()).filter((s) => s.length > 0)
      : []

    const intent = new SteerIntent({
      intent: String(obj.intent || text),
      action: _ACTIONS.has(action) ? action : 'unknown',
      target_chapter: Math.max(1, target),
      scope: _SCOPES.has(scope) ? scope : 'current',
      affected_chapters: affected.sort((a, b) => a - b),
      steps,
      requires_confirmation: Boolean(obj.requires_confirmation),
      reason: String(obj.reason || ''),
    })

    // 安全兜底：**只要触及已定稿范围，一律强制人工确认**，不信任模型的自评
    if (intent.scope === 'committed' || intent.affected_chapters.some((n) => n <= lastCommitted)) {
      intent.scope = 'committed'
      intent.requires_confirmation = true
      if (!intent.reason) intent.reason = '影响范围触及已定稿章节。'
    }
    return intent
  }

  // ---------------- 执行 ----------------

  async apply(text: string, opts: { confirm?: boolean } = {}): Promise<SteerResult> {
    const { confirm = false } = opts
    const intent = await this.interpret(text)
    const result = new SteerResult({ text, intent })

    if (intent.scope === 'committed' && !confirm) {
      const directive = this.store.appendSteering({
        text,
        scope: intent.scope,
        target_chapter: intent.target_chapter,
        affected_chapters: intent.affected_chapters,
        pending_confirmation: true,
        intent: this._directiveMeta(intent),
      })
      result.directive_id = directive.id
      result.pending_confirmation = true
      result.message =
        '这条意见会改动已定稿的章节，我没有直接改。' +
        '确认后我会先给出修订提案，你逐条看过再落地。'
      return result
    }

    const directive = this.store.appendSteering({
      text,
      scope: intent.scope,
      target_chapter: intent.target_chapter,
      affected_chapters: intent.affected_chapters,
      pending_confirmation: false,
      applied: true,
      intent: this._directiveMeta(intent),
    })
    result.directive_id = directive.id
    result.applied = true

    if (intent.scope === 'outline') {
      const changed = this._resetOutline(intent)
      result.changed = changed
      result.message =
        `已记为长期指令，并把 ${changed.length} 章的章纲标记为待重排；` +
        '写这些章时会自动带上你的意见。'
    } else {
      this._resetChapter(intent.target_chapter)
      result.changed = [`第 ${intent.target_chapter} 章`]
      result.message = `已记为长期指令，第 ${intent.target_chapter} 章重写时会自动遵守。`
    }
    return result
  }

  /** 附加在指令上的结构化信息（steps/action 等；本地版 appendSteering 只保留固定字段，故放进 intent）。 */
  private _directiveMeta(intent: SteerIntent): Record<string, unknown> {
    return {
      action: intent.action,
      steps: intent.steps,
      reason: intent.reason,
      requiresConfirmation: intent.requires_confirmation,
    }
  }

  private _resetChapter(chapter: number): void {
    /** 把该章退回「待重写」：清掉 draft 之后的 checkpoint，状态回 draft。 */
    for (const step of ['draft', 'audit', 'review', 'deai', 'revise', 'commit']) {
      this._resetCheckpoints(chapter, step)
    }
    const data = this.store.readChapter(chapter)
    if (data.paragraphs.length) {
      this.store.updateChapterStatus(chapter, 'draft')
    }
  }

  private _resetOutline(intent: SteerIntent): string[] {
    const graph = this.store.outlineGraph()
    const changed: string[] = []
    const targets = new Set(
      intent.affected_chapters.length ? intent.affected_chapters : [intent.target_chapter],
    )
    for (const node of graph.nodes) {
      if (targets.has(node.chapter)) {
        node.status = 'planned'
        const note = intent.steps.join('／') || intent.intent
        const suffix = `（作者意见：${note}）`
        if (!node.rationale.includes(suffix)) {
          node.rationale = (node.rationale + suffix).trim()
        }
        changed.push(`第 ${node.chapter} 章`)
      }
    }
    this.store.saveOutlineGraph(graph)
    for (const n of [...targets].sort((a, b) => a - b)) {
      this._resetCheckpoints(n, 'plan')
    }
    return changed
  }

  /** 清掉某章（或某步）之后的 checkpoint，用于强制重跑 —— 镜像 Python checkpoint.reset_from。 */
  private _resetCheckpoints(chapter: number, step?: string): number {
    const rows = this.store.record.checkpoints
    const kept = rows.filter(
      (cp) => !(cp.chapter > chapter || (cp.chapter === chapter && step !== undefined && cp.step === step)),
    )
    this.store.record.checkpoints = kept
    this.store.flush()
    return rows.length - kept.length
  }

  // ---------------- 未消费指令 ----------------

  pendingDirectives(): SteeringDirective[] {
    return this.store.steeringDirectives({ includeResolved: false })
  }

  confirmDirective(directiveId: string): Record<string, unknown> {
    /** 人工确认后，把「待确认」的指令转为正式指令。 */
    const rows = this.store.record.steering
    const target = rows.find((r) => r.id === directiveId) ?? null
    if (target === null) {
      return { ok: false, message: '没有这条干预指令。' }
    }
    target.pending_confirmation = false
    target.applied = true
    this.store.flush()
    const chapter = Number(target.target_chapter ?? 1)
    if (target.scope === 'outline') {
      this._resetOutline(
        new SteerIntent({
          intent: target.text,
          target_chapter: chapter,
          scope: 'outline',
          affected_chapters: target.affected_chapters.map(Number),
          steps: this._stepsOf(target),
        }),
      )
    } else {
      this._resetChapter(chapter)
    }
    return { ok: true, id: directiveId, chapter }
  }

  dismissDirective(directiveId: string, opts: { applied?: boolean } = {}): Record<string, unknown> {
    const { applied = true } = opts
    const hit = this.store.resolveSteering([directiveId])
    return { ok: hit > 0, id: directiveId, applied }
  }

  private _stepsOf(directive: SteeringDirective): string[] {
    const intent = directive.intent as Record<string, unknown>
    const steps = Array.isArray(intent.steps) ? intent.steps : []
    return steps.map((s) => String(s).trim()).filter((s) => s.length > 0)
  }
}

export { Steering as Steer, Steering as SteerController }
