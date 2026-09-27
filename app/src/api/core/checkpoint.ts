/**
 * step 级 checkpoint 与断点恢复 —— 镜像 `server/dobi/core/checkpoint.py`。
 */

import type { Checkpoint } from './types'
import { PIPELINE_STEPS, STEP_LABELS } from './types'
import { idemKey, nowIso } from './util'
import type { ProjectStore } from './store'

export type ResumeAction =
  | 'none'
  | 'replan'
  | 'expand_volume'
  | 'write_next'
  | 'continue_draft'
  | 're_audit'
  | 'continue_revise'

export const ACTION_LABELS: Record<string, string> = {
  none: '无需恢复',
  replan: '补全缺失的设定与大纲',
  expand_volume: '展开下一卷骨架',
  write_next: '续写下一章',
  continue_draft: '从已有草稿继续写',
  re_audit: '重新审查本章',
  continue_revise: '继续处理待修订项',
}

export interface ResumePlan {
  action: ResumeAction
  chapter: number
  step: string
  reason: string
  detail: Record<string, unknown>
  public(): Record<string, unknown>
}

export class CheckpointManager {
  readonly store: ProjectStore

  constructor(store: ProjectStore) {
    this.store = store
  }

  key(chapter: number, step: string, salt = ''): string {
    return idemKey(chapter, step, salt)
  }

  appliedKeys(chapter?: number): Set<string> {
    const keys = new Set<string>()
    for (const cp of this.store.checkpoints(chapter)) {
      if ((cp.status === 'ok' || cp.status === 'skipped') && cp.idempotency_key) {
        keys.add(cp.idempotency_key)
      }
    }
    return keys
  }

  alreadyApplied(key: string): boolean {
    return this.appliedKeys().has(key)
  }

  begin(chapter: number, step: string, opts: { note?: string; salt?: string } = {}): Checkpoint {
    const cp: Checkpoint = {
      chapter,
      step,
      status: 'running',
      attempt: this.nextAttempt(chapter, step),
      idempotency_key: this.key(chapter, step, opts.salt ?? ''),
      output_ref: '',
      tokens: 0,
      cost: 0,
      note: opts.note ?? '',
      timestamp: '',
    }
    this.store.saveCheckpoint(cp)
    return cp
  }

  finish(
    cp: Checkpoint,
    opts: { status?: string; output_ref?: string; tokens?: number; cost?: number; note?: string } = {},
  ): Checkpoint {
    cp.status = (opts.status ?? 'ok') as Checkpoint['status']
    cp.output_ref = opts.output_ref ?? cp.output_ref
    cp.tokens = opts.tokens ?? cp.tokens
    cp.cost = Math.round((opts.cost ?? cp.cost) * 10000) / 10000
    if (opts.note) cp.note = opts.note
    cp.timestamp = nowIso()
    this.store.saveCheckpoint(cp)
    return cp
  }

  fail(cp: Checkpoint, opts: { note?: string; tokens?: number; cost?: number } = {}): Checkpoint {
    return this.finish(cp, { status: 'failed', tokens: opts.tokens, cost: opts.cost, note: opts.note })
  }

  skip(chapter: number, step: string, note = '已完成，跳过'): Checkpoint {
    const cp: Checkpoint = {
      chapter, step, status: 'skipped', attempt: 1,
      idempotency_key: this.key(chapter, step), output_ref: '',
      tokens: 0, cost: 0, note, timestamp: nowIso(),
    }
    this.store.saveCheckpoint(cp)
    return cp
  }

  done(chapter: number, step: string): Checkpoint | null {
    const rows = this.store.checkpoints(chapter).filter((c) => c.step === step)
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].status === 'ok' || rows[i].status === 'skipped') return rows[i]
    }
    return null
  }

  isDone(chapter: number, step: string): boolean {
    return this.done(chapter, step) !== null
  }

  nextAttempt(chapter: number, step: string): number {
    return this.store.checkpoints(chapter).filter((c) => c.step === step).length + 1
  }

  progress(chapter: number): Record<string, unknown> {
    const rows = this.store.checkpoints(chapter)
    const byStep: Record<string, string> = {}
    for (const cp of rows) byStep[cp.step] = cp.status
    const done = PIPELINE_STEPS.filter((s) => byStep[s] === 'ok' || byStep[s] === 'skipped')
    const running = PIPELINE_STEPS.find((s) => byStep[s] === 'running') ?? null
    const failed = PIPELINE_STEPS.filter((s) => byStep[s] === 'failed')
    const next = PIPELINE_STEPS.find((s) => !done.includes(s)) ?? null
    return {
      chapter,
      steps: PIPELINE_STEPS.map((s) => ({
        key: s, label: STEP_LABELS[s], status: byStep[s] ?? 'todo',
      })),
      done: done.length,
      total: PIPELINE_STEPS.length,
      active: running,
      next,
      failed,
      lastCheckpointAt: rows.length ? rows[rows.length - 1].timestamp : null,
    }
  }

  diagnose(targetChapter?: number | null): ResumePlan {
    const store = this.store
    const overview = store.chaptersOverview()
    const meta = store.meta()

    const missing: string[] = []
    if (!store.world().rules.length) missing.push('world')
    if (!store.characters().length) missing.push('characters')
    const graph = store.outlineGraph()
    if (!graph.nodes.length) missing.push('outline')
    if (missing.length) {
      return this._plan('replan', targetChapter ?? 1, 'plan',
        '世界观 / 角色 / 大纲尚未建立完整，需要先补全设定。', { missing })
    }

    const written = overview.filter((c) => ['draft', 'audit', 'revise', 'done'].includes(c.status as string))
    const committed = overview.filter((c) => c.status === 'done')
    const lastChapter = overview.reduce((m, c) => Math.max(m, c.n as number), 0)

    const current = targetChapter ?? (written.reduce((m, c) => Math.max(m, c.n as number), 0) || lastChapter)
    const skeleton = graph.nodes.filter((n) => n.status === 'skeleton' && n.chapter <= current + 1)
    if (!skeleton.length) {
      const nextVol = graph.volumes.find(
        (v) => v.status === 'skeleton' && v.from_chapter <= lastChapter + 1,
      )
      if (nextVol === undefined && graph.volumes.length) {
        const expandedMax = graph.volumes
          .filter((v) => v.status === 'expanded')
          .reduce((m, v) => Math.max(m, v.to_chapter), 0)
        if (lastChapter >= expandedMax) {
          return this._plan('expand_volume', lastChapter + 1, 'plan',
            '当前卷已写完，下一卷仍是骨架弧，需要展开为详细章纲。',
            { volumes: graph.volumes })
        }
      }
    }

    let pending = overview.filter((c) => !['todo', 'planned'].includes(c.status as string))
    if (targetChapter != null) {
      pending = overview.filter((c) => c.n === targetChapter).length
        ? overview.filter((c) => c.n === targetChapter)
        : pending
    }

    for (const item of [...pending].sort((a, b) => (b.n as number) - (a.n as number))) {
      const n = item.n as number
      const status = item.status as string
      const audit = store.readAudit(n)

      if (audit !== null) {
        const openMajor = audit.items.filter(
          (i) => i.decision === null && (i.severity === 'blocker' || i.severity === 'major'),
        )
        if ((status === 'audit' || status === 'revise') && openMajor.length) {
          return this._plan('continue_revise', n, 'revise',
            `第 ${n} 章还有 ${openMajor.length} 条重点问题未处理。`,
            { open: openMajor.map((i) => i.dim) })
        }
      }

      if ((status === 'draft' || status === 'audit') && audit === null) {
        return this._plan('re_audit', n, 'audit',
          `第 ${n} 章已有正文但尚未审查。`, { words: item.words })
      }

      if (status === 'draft' || status === 'audit' || status === 'revise') {
        const data = store.readChapter(n)
        if (data.paragraphs.length) {
          return this._plan('continue_draft', n, 'draft',
            `第 ${n} 章有未定稿的草稿（${data.words} 字），可继续写。`, { words: data.words })
        }
      }
    }

    let firstEmpty: number | null = null
    for (const item of [...overview].sort((a, b) => (a.n as number) - (b.n as number))) {
      if (!store.readChapter(item.n as number).paragraphs.length) {
        firstEmpty = item.n as number
        break
      }
    }
    const nxt = targetChapter ?? firstEmpty ?? (lastChapter ? lastChapter + 1 : 1)
    return this._plan('write_next', nxt, 'plan',
      `前面的章节都已处理完，可以继续第 ${nxt} 章。` +
      `（本书目标 ${meta.chapters_total || '未定'} 章，已定稿 ${committed.length} 章）`,
      { committed: committed.length })
  }

  private _plan(
    action: ResumeAction,
    chapter: number,
    step: string,
    reason: string,
    detail: Record<string, unknown>,
  ): ResumePlan {
    const plan: ResumePlan = {
      action,
      chapter,
      step,
      reason,
      detail,
      public() {
        return {
          action: plan.action,
          label: ACTION_LABELS[plan.action] ?? plan.action,
          chapter: plan.chapter,
          step: plan.step,
          stepLabel: STEP_LABELS[plan.step] ?? plan.step,
          reason: plan.reason,
          detail: plan.detail,
        }
      },
    }
    return plan
  }

  publicState(targetChapter?: number | null): Record<string, unknown> {
    const plan = this.diagnose(targetChapter)
    return {
      resume: plan.public(),
      recent: this.store.checkpoints().slice(-12).reverse(),
    }
  }
}
