/**
 * 干预策略层 —— 镜像 `server/dobi/orchestrator/mode.py`。
 */

import { PIPELINE_STEPS, STEP_LABELS, STOP_CONDITION_LABELS } from './types'
import type { AuditReport, StepPolicies, StepPolicy } from './types'
import type { ProjectStore } from './store'

export const MODE_LABELS: Record<string, string> = {
  auto: '全自动',
  'semi-auto': '半自动',
  manual: '手动逐步',
}

export const MODE_HINTS: Record<string, string> = {
  auto: '全部环节自动执行，仅在阻塞时暂停',
  'semi-auto': '章纲与审查报告需人工确认',
  manual: '每个环节都停下等待确认',
}

export const MODE_PRESETS: Record<string, Record<string, StepPolicy>> = {
  auto: Object.fromEntries(PIPELINE_STEPS.map((s) => [s, 'auto'])),
  'semi-auto': {
    ...Object.fromEntries(PIPELINE_STEPS.map((s) => [s, 'auto'])),
    plan: 'confirm', audit: 'confirm', commit: 'confirm',
  },
  manual: Object.fromEntries(PIPELINE_STEPS.map((s) => [s, 'manual'])),
}

export class ModeController {
  readonly store: ProjectStore

  constructor(store: ProjectStore) {
    this.store = store
  }

  get mode(): string {
    return this.store.meta().mode
  }

  setMode(mode: string): string {
    if (!(mode in MODE_PRESETS)) throw new Error(`未知模式：${mode}`)
    const meta = this.store.meta()
    meta.mode = mode as typeof meta.mode
    meta.steps = { ...MODE_PRESETS[mode] } as unknown as StepPolicies
    this.store.saveMeta(meta)
    return mode
  }

  setStep(step: string, policy: string): string {
    if (!PIPELINE_STEPS.includes(step as (typeof PIPELINE_STEPS)[number])) {
      throw new Error(`未知环节：${step}`)
    }
    if (!['auto', 'confirm', 'manual'].includes(policy)) throw new Error(`未知策略：${policy}`)
    const meta = this.store.meta()
    meta.steps[step as keyof typeof meta.steps] = policy as StepPolicy
    const preset = MODE_PRESETS[meta.mode] ?? {}
    const drifted = PIPELINE_STEPS.some(
      (s) => preset[s] !== meta.steps[s as keyof typeof meta.steps],
    )
    if (drifted) {
      meta.mode = PIPELINE_STEPS.every((s) => meta.steps[s as keyof typeof meta.steps] === 'manual')
        ? 'manual'
        : 'semi-auto'
    }
    this.store.saveMeta(meta)
    return policy
  }

  policyFor(step: string): string {
    const steps = this.store.meta().steps
    return steps[step as keyof typeof steps] ?? 'auto'
  }

  needsConfirmation(step: string): boolean {
    const p = this.policyFor(step)
    return p === 'confirm' || p === 'manual'
  }

  setStopConditions(conditions: string[]): string[] {
    const meta = this.store.meta()
    meta.stop_conditions = conditions.filter((c) => c in STOP_CONDITION_LABELS)
    this.store.saveMeta(meta)
    return meta.stop_conditions
  }

  checkStop(opts: {
    chapter: number
    audit?: AuditReport | null
    failStreak?: number
    budgetExceeded?: boolean
    steerAffectsCommitted?: boolean
  }): string | null {
    const active = new Set(this.store.meta().stop_conditions)
    const { audit, failStreak = 0, budgetExceeded = false, steerAffectsCommitted = false } = opts

    if (active.has('budget.exceeded') && budgetExceeded) return 'budget.exceeded'
    if (active.has('audit.blocker_exists') && audit) {
      const blockers = audit.items.filter(
        (i) => i.severity === 'blocker' && !i.fixed && i.decision !== 'ignore',
      )
      if (blockers.length) return 'audit.blocker_exists'
    }
    if (active.has('audit.fail_streak') && failStreak >= 3) return 'audit.fail_streak'
    if (active.has('steer.affects_committed') && steerAffectsCommitted) return 'steer.affects_committed'
    return null
  }

  static stopReason(key: string): string {
    const base = STOP_CONDITION_LABELS[key] ?? key
    const extra: Record<string, string> = {
      'budget.exceeded': '已挂起当前进度，调高预算或换更便宜的模型后可继续。',
      'audit.blocker_exists': '请先处理阻塞定稿的问题，或把该问题标记为忽略。',
      'audit.fail_streak': '连续多章未通过审查，建议人工看一遍再继续。',
      'steer.affects_committed': '干预波及已定稿章节，需要你确认后才改动历史。',
    }
    return `${base}。${extra[key] ?? ''}`.trim()
  }

  public(): Record<string, unknown> {
    const meta = this.store.meta()
    return {
      mode: meta.mode,
      modeLabel: MODE_LABELS[meta.mode] ?? meta.mode,
      modeHint: MODE_HINTS[meta.mode] ?? '',
      modes: ['auto', 'semi-auto', 'manual'].map((k) => ({
        value: k, label: MODE_LABELS[k], hint: MODE_HINTS[k],
      })),
      steps: PIPELINE_STEPS.map((s) => ({
        key: s,
        label: STEP_LABELS[s],
        policy: this.policyFor(s),
        needsConfirmation: this.needsConfirmation(s),
      })),
      stopConditions: Object.keys(STOP_CONDITION_LABELS).map((c) => ({
        key: c,
        label: STOP_CONDITION_LABELS[c],
        active: meta.stop_conditions.includes(c),
      })),
    }
  }
}
