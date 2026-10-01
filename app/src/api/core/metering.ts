/**
 * 调用计量与成本统计 —— 镜像 `server/dobi/core/metering.py`。
 *
 * 单一数据来源：`ProjectRecord.usage` 是权威流水，`meta.budget_used` 只是缓存。
 *
 * 预算熔断：
 * - 用度 ≥ 80% → warning
 * - 用度 ≥ 100% → 抛 BudgetExceededError，挂起 checkpoint 而不是静默继续烧钱
 * - budget_total = 0 视为不限制
 */

import { ProjectStore, BudgetExceededError } from './store'
import { setScope, setUsageCallback } from './llm'
import { nowIso } from './util'
import type { UsageEntry } from './types'

const WARN_RATIO = 0.8

export class Meter {
  readonly store: ProjectStore

  constructor(store: ProjectStore) {
    this.store = store
  }

  /** 绑定到 LLMClient 的 onUsage 回调；scope（chapter/step）由调用方在调用前设置。 */
  install(): void {
    setUsageCallback((entry) => {
      this.store.appendUsage({
        chapter: Number(entry.chapter ?? 0),
        step: String(entry.step ?? ''),
        role: String(entry.role ?? ''),
        provider: String(entry.provider ?? ''),
        model: String(entry.model ?? ''),
        prompt_tokens: Number((entry.tokens as Record<string, unknown> | undefined)?.prompt_tokens ?? 0),
        completion_tokens: Number((entry.tokens as Record<string, unknown> | undefined)?.completion_tokens ?? 0),
        total_tokens: Number((entry.tokens as Record<string, unknown> | undefined)?.total_tokens ?? 0),
        cost: Number(entry.cost ?? 0),
        latency_ms: Number(entry.latencyMs ?? 0),
        attempts: Number(entry.attempts ?? 1),
        ts: String(entry.ts ?? nowIso()),
      })
    })
  }

  setChapterScope(chapter: number, step: string): void {
    setScope({ chapter, step })
  }

  uninstall(): void {
    setUsageCallback(null)
    setScope({})
  }

  // ---------------- 读取 ----------------

  entries(): UsageEntry[] {
    return this.store.usageEntries()
  }

  get used(): number {
    return Math.round(this.entries().reduce((s, e) => s + e.cost, 0) * 10000) / 10000
  }

  get totalTokens(): number {
    return this.entries().reduce(
      (s, e) => s + (e.total_tokens || e.prompt_tokens + e.completion_tokens),
      0,
    )
  }

  byChapter(): Array<Record<string, unknown>> {
    const agg = new Map<number, Record<string, unknown>>()
    for (const e of this.entries()) {
      const row = agg.get(e.chapter) ?? {
        chapter: e.chapter, promptTokens: 0, completionTokens: 0,
        totalTokens: 0, cost: 0.0, calls: 0, steps: [] as string[],
      }
      row.promptTokens = (row.promptTokens as number) + e.prompt_tokens
      row.completionTokens = (row.completionTokens as number) + e.completion_tokens
      row.totalTokens = (row.totalTokens as number) + (e.total_tokens || e.prompt_tokens + e.completion_tokens)
      row.cost = Math.round((row.cost as number + e.cost) * 10000) / 10000
      row.calls = (row.calls as number) + 1
      if (e.step && !(row.steps as string[]).includes(e.step)) {
        ;(row.steps as string[]).push(e.step)
      }
      agg.set(e.chapter, row)
    }
    return [...agg.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r)
  }

  byStep(): Array<Record<string, unknown>> {
    const agg = new Map<string, Record<string, unknown>>()
    for (const e of this.entries()) {
      const key = e.step || '未标注'
      const row = agg.get(key) ?? { step: key, calls: 0, tokens: 0, cost: 0.0 }
      row.calls = (row.calls as number) + 1
      row.tokens = (row.tokens as number) + (e.total_tokens || e.prompt_tokens + e.completion_tokens)
      row.cost = Math.round((row.cost as number + e.cost) * 10000) / 10000
      agg.set(key, row)
    }
    return [...agg.values()].sort((a, b) => (b.cost as number) - (a.cost as number))
  }

  byDay(): Array<Record<string, unknown>> {
    const agg = new Map<string, Record<string, unknown>>()
    for (const e of this.entries()) {
      const day = (e.ts || '').slice(0, 10) || nowIso().slice(0, 10)
      const row = agg.get(day) ?? { day, calls: 0, tokens: 0, cost: 0.0 }
      row.calls = (row.calls as number) + 1
      row.tokens = (row.tokens as number) + (e.total_tokens || e.prompt_tokens + e.completion_tokens)
      row.cost = Math.round((row.cost as number + e.cost) * 10000) / 10000
      agg.set(day, row)
    }
    return [...agg.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, r]) => r)
  }

  totals(): Record<string, unknown> {
    const entries = this.entries()
    return {
      calls: entries.length,
      tokens: this.totalTokens,
      cost: this.used,
      unpriced: entries.filter((e) => e.cost === 0 && (e.total_tokens || 0) > 0).length,
    }
  }

  budget(): Record<string, unknown> {
    const meta = this.store.meta()
    const used = this.used
    const total = meta.budget_total
    const ratio = total > 0 ? used / total : 0
    return {
      used,
      total: Math.round(total * 100) / 100,
      remaining: Math.round(Math.max(0, total - used) * 100) / 100,
      ratio: Math.round(ratio * 10000) / 10000,
      unit: meta.cost_unit,
      unlimited: total <= 0,
      level:
        total > 0 && used >= total ? 'exceeded'
        : total > 0 && ratio >= WARN_RATIO ? 'warning'
        : 'ok',
      tokens: this.totalTokens,
    }
  }

  // ---------------- 闸门 4：预算熔断 ----------------

  /** 调用模型**之前**预检。超额直接抛错，由上层挂起 checkpoint。 */
  checkBudget(estimatedNext = 0): void {
    const meta = this.store.meta()
    if (meta.budget_total <= 0) return
    const used = this.used
    if (used + Math.max(0, estimatedNext) >= meta.budget_total) {
      throw new BudgetExceededError(
        `本书预算已用尽（${meta.cost_unit}${used.toFixed(2)} / ` +
          `${meta.cost_unit}${meta.budget_total.toFixed(2)}）。` +
          '已挂起当前进度，调高预算或切换更便宜的模型后可继续。',
        { used, total: meta.budget_total },
      )
    }
  }

  warning(): string | null {
    const b = this.budget()
    if (b.level === 'warning' || b.level === 'exceeded') {
      if (!b.unlimited) {
        return `本书预算已用 ${b.unit}${(b.used as number).toFixed(2)} / ` +
          `${b.unit}${(b.total as number).toFixed(2)}，接近上限。`
      }
    }
    return null
  }

  public(recent = 20): Record<string, unknown> {
    const entries = this.entries()
    return {
      totals: this.totals(),
      budget: this.budget(),
      byChapter: this.byChapter(),
      byStep: this.byStep(),
      byDay: this.byDay(),
      recent: entries.slice(-recent).reverse(),
    }
  }
}
