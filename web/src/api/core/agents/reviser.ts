/**
 * Reviser：审计结果 → JSON Patch 定点修复。
 *
 * 三条铁律：
 * 1. **定点修复**，不整段重写 —— `before` 必须在原文中逐字存在，否则**跳过该 patch**
 *   （模型偶尔会顺手改别的地方，这种补丁必须拦下）
 * 2. `blocker` / `major` → 修；`minor` → 只记录，不自动改
 * 3. 改完**必须重跑规则校验**，通过才算闭环；单章循环上限 2 轮，超限交人工
 */

import { Agent, Usage } from './base'
import * as prompts from './prompts'
import { fmt } from './architect'
import { splitParagraphs } from './writer'
import { completeJson } from '../llm'
import { checkL1, type L1Result } from '../l1'
import { stripAi as runStripAi } from '../deai'
import type { DeaiResult } from '../deai'
import type { AuditItem, AuditReport } from '../types'

/** 去掉空白与标点（用于补丁匹配的归一化） */
function norm(text: string): string {
  return (text || '').replace(/[\s，。！？、；：,.!?;:"'（）()【】\[\]—…·]+/g, '')
}

export class ReviseResult {
  chapter: number
  rounds = 0
  applied: Array<Record<string, unknown>> = []
  skipped: Array<Record<string, unknown>> = []
  diffs: Array<Record<string, unknown>> = []
  l1_before: L1Result | null = null
  l1_after: L1Result | null = null
  converged = false
  needs_human = false
  words_before = 0
  words_after = 0
  usage: Usage

  constructor(chapter: number) {
    this.chapter = chapter
    this.usage = new Usage()
  }

  public(): Record<string, unknown> {
    return {
      chapter: this.chapter,
      rounds: this.rounds,
      applied: this.applied,
      skipped: this.skipped,
      diffs: this.diffs,
      l1Before: this.l1_before ? { violations: this.l1_before.violations, checked: this.l1_before.checked } : null,
      l1After: this.l1_after ? { violations: this.l1_after.violations, checked: this.l1_after.checked } : null,
      converged: this.converged,
      needsHuman: this.needs_human,
      wordsBefore: this.words_before,
      wordsAfter: this.words_after,
      usage: this.usage.public(),
    }
  }
}

export class Reviser extends Agent {
  // ---------------- 按审查结论定点修复 ----------------

  async revise(
    chapter: number,
    opts: { severities?: string[]; maxRounds?: number } = {},
  ): Promise<ReviseResult> {
    const { severities = ['blocker', 'major'], maxRounds = 2 } = opts
    const store = this.store
    const report = store.readAudit(chapter)
    if (report === null) {
      throw new Error(`第 ${chapter} 章还没有审查报告，先跑一次审查。`)
    }
    if (!report.items.length) {
      throw new Error(`第 ${chapter} 章没有需要修订的问题。`)
    }

    const data = store.readChapter(chapter)
    const paragraphs = [...data.paragraphs]
    const outcome = new ReviseResult(chapter)
    outcome.words_before = data.words
    outcome.l1_before = this.l1(chapter, paragraphs)

    let pending = fixable(report.items, severities)
    if (!pending.length) {
      outcome.converged = !outcome.l1_before.violations.length
      outcome.skipped = report.items.map((i) => ({ dim: i.dim, reason: '未选中或标记为忽略' }))
      return outcome
    }

    for (let roundNo = 1; roundNo <= maxRounds; roundNo++) {
      outcome.rounds = roundNo
      this.scope(chapter, 'revise')
      this.budgetGate()

      const issues = pending
        .map(
          (item, i) =>
            `${i + 1}. 【${item.dim}·${sevLabel(item.severity)}】` +
            `问题：${item.suggestion || '（未给建议）'}` +
            `｜原文：${item.evidence}`,
        )
        .join('\n')
      const numbered = paragraphs.map((p, i) => `[${i + 1}]\n${p}`).join('\n\n')

      const { data: obj, result } = await completeJson('deai', [
        { role: 'user', content: fmt(prompts.REVISER, { issues, text: numbered }) },
      ])
      this.usage.add(result)

      const patches = obj && typeof obj === 'object' ? (obj as Record<string, unknown>).patches : null
      if (!Array.isArray(patches) || !patches.length) {
        outcome.needs_human = true
        outcome.skipped.push({ dim: '—', reason: '模型没有给出可用的修订' })
        break
      }

      const [applied, skipped] = applyPatches(paragraphs, patches)
      outcome.applied.push(...applied)
      outcome.skipped.push(...skipped)
      if (!applied.length) {
        outcome.needs_human = true
        break
      }

      const written = store.writeChapter(chapter, paragraphs, {
        title: data.title,
        status: 'revise',
        pov: data.pov,
      })
      outcome.words_after = written.words

      outcome.l1_after = this.l1(chapter, paragraphs)
      if (!outcome.l1_after.violations.length) {
        outcome.converged = true
        break
      }
      pending = stillBroken(pending, outcome.l1_after)
      if (!pending.length) {
        break
      }
    }

    if (!outcome.converged && outcome.rounds >= maxRounds) {
      outcome.needs_human = true
    }

    // 把 diff 与定稿决策写回审计报告
    report.diffs = outcome.diffs
    const appliedEvidence = new Set(outcome.applied.map((a) => String(a.before ?? '')))
    for (const item of report.items) {
      if (appliedEvidence.has(item.evidence) || outcome.applied.some((a) => a.dim === item.dim)) {
        item.fixed = true
      }
    }
    report.stats = restat(report)
    store.saveAudit(report)

    this.cp.finish(
      this.cp.begin(chapter, 'revise'),
      {
        output_ref: `chapters/ch_${String(chapter).padStart(4, '0')}.md`,
        cost: this.usage.cost,
        note: `${outcome.applied.length} 处修订` + (outcome.converged ? '，规则校验已通过' : '，仍需人工确认'),
      },
    )
    return outcome
  }

  // ---------------- 反 AIGC：去 AI 味 ----------------

  async stripAi(chapter: number, opts: { maxRounds?: number } = {}): Promise<DeaiResult> {
    const { maxRounds = 2 } = opts
    const store = this.store
    const data = store.readChapter(chapter)
    const text = data.paragraphs.join('\n\n')
    if (!text.trim()) {
      throw new Error(`第 ${chapter} 章还没有正文。`)
    }

    this.scope(chapter, 'deai')
    this.budgetGate()
    const result = await runStripAi(chapter, text, store.style(), maxRounds)
    this.usage.calls += 1

    if (result.patches.length) {
      const paragraphs = splitParagraphs(result.after)
      store.writeChapter(chapter, paragraphs, {
        title: data.title,
        status: 'revise',
        pov: data.pov,
      })
      const report = store.readAudit(chapter)
      if (report !== null) {
        report.diffs = (report.diffs ?? []).concat(
          result.patches.map((p) => ({
            dim: `去 AI 味 · ${String(p.reason ?? '')}`,
            before: [String(p.before ?? '')],
            after: [String(p.after ?? '')],
          })),
        )
        store.saveAudit(report)
      }
    }

    this.cp.finish(
      this.cp.begin(chapter, 'deai'),
      {
        output_ref: `chapters/ch_${String(chapter).padStart(4, '0')}.md`,
        cost: this.usage.cost,
        note:
          `${result.patches.length} 处定点改写，${result.rounds} 轮` +
          (result.converged ? '，已收敛' : '，需人工确认'),
      },
    )
    return result
  }

  // ---------------- 内部 ----------------

  private l1(chapter: number, paragraphs: string[]): L1Result {
    const store = this.store
    return checkL1({
      text: paragraphs.join('\n\n'),
      chapter,
      characters: store.characters(),
      hooks: store.hooks(),
      world_rules: store.world().rules,
      style: store.style(),
    })
  }
}

function sevLabel(severity: string): string {
  return ({ blocker: '阻塞定稿', major: '重点', minor: '建议' } as Record<string, string>)[severity] ?? severity
}

/** 谁需要修：明确接受的必修；未表态的按严重度；明确忽略的不修。 */
function fixable(items: AuditItem[], severities: string[]): AuditItem[] {
  const out: AuditItem[] = []
  for (const item of items) {
    if (item.decision === 'ignore') continue
    if (item.decision === 'accept') {
      out.push(item)
      continue
    }
    if (severities.includes(item.severity)) out.push(item)
  }
  return out
}

/** 规则违规还在的，继续修；已消失的不再重复处理。 */
function stillBroken(items: AuditItem[], l1: L1Result): AuditItem[] {
  const rules = new Set(l1.violations.map((v) => v.rule))
  if (!rules.size) return []
  return items.filter((i) => [...rules].some((r) => i.dim.includes(r)))
}

/** 应用补丁。`before` 找不到就跳过 —— 绝不盲改。 */
function applyPatches(
  paragraphs: string[],
  patches: unknown[],
): [Array<Record<string, unknown>>, Array<Record<string, unknown>>] {
  const applied: Array<Record<string, unknown>> = []
  const skipped: Array<Record<string, unknown>> = []
  for (const raw of patches) {
    if (typeof raw !== 'object' || raw === null) continue
    const rec = raw as Record<string, unknown>
    const before = String(rec.before ?? '').trim()
    const after = String(rec.after ?? '').trim()
    const reason = String(rec.reason ?? '')
    if (!before || !after) {
      skipped.push({ before, reason: '补丁缺少 before/after' })
      continue
    }
    const idx = Number(rec.para ?? 0) - 1
    let target =
      Number.isInteger(idx) && idx >= 0 && idx < paragraphs.length ? idx : null
    if (target === null || (!norm(paragraphs[target]).includes(norm(before)) && !paragraphs[target].includes(before))) {
      // 段落号不可靠时，全文搜一遍
      const found = paragraphs.findIndex((p) => p.includes(before) || norm(p).includes(norm(before)))
      target = found === -1 ? null : found
    }
    if (target === null) {
      skipped.push({ before: before.slice(0, 60), reason: '原文中找不到该句，已跳过（防止误改）' })
      continue
    }

    const original = paragraphs[target]
    let updated = original
    if (original.includes(before)) {
      updated = original.replace(before, after)
    } else {
      // 归一化后匹配：只替换整段里最接近的窗口
      updated = fuzzyReplace(original, before, after)
    }
    if (updated === original) {
      skipped.push({ before: before.slice(0, 60), reason: '替换后无变化，已跳过' })
      continue
    }

    paragraphs[target] = updated
    applied.push({ para: target + 1, dim: reason, before, after, reason })
  }
  return [applied, skipped]
}

/** 去标点后匹配到的位置，用滑窗找回原文区间再替换。 */
function fuzzyReplace(paragraph: string, before: string, after: string): string {
  const key = norm(before)
  if (!key) return paragraph
  const window = before.length
  for (let size = Math.max(4, window - 6); size < window + 8; size++) {
    for (let start = 0; start < Math.max(1, paragraph.length - size + 1); start++) {
      const chunk = paragraph.slice(start, start + size)
      if (norm(chunk) === key) {
        return paragraph.slice(0, start) + after + paragraph.slice(start + size)
      }
    }
  }
  return paragraph
}

/** 修订后的审计统计（口径与 Auditor 一致，但 fixed 由修订流程驱动） */
function restat(report: AuditReport): Record<string, number> {
  const items = report.items
  const fixed = items.filter((i) => i.fixed).length
  const total = items.length || 1
  return {
    l1: report.l1_violations.length,
    l2: items.filter((i) => !i.dim.startsWith('规则 · ')).length,
    fixed,
    open: items.filter((i) => !i.fixed).length,
    blocker: items.filter((i) => i.severity === 'blocker' && !i.fixed).length,
    major: items.filter((i) => i.severity === 'major' && !i.fixed).length,
    passRate: items.length ? Math.round((fixed / total) * 100) : 100,
  }
}
