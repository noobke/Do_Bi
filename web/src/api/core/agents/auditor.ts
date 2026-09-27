/**
 * Auditor：正文 + 真相文件 → 审计报告（含原文证据）—— 镜像 `server/dobi/agents/auditor.py`。
 *
 * 两级：
 * - **规则校验**（`checkL1`）：13 条确定性规则，零模型成本，每次必跑
 * - **模型审查**（`auditL2`）：15 维，按项目开关决定跑哪几维（关掉不关心的维度省钱）
 *
 * 两者的结论合并进同一份审计报告，作者只需看一个地方。
 */

import { Agent } from './base'
import { checkL1, type L1Result } from '../l1'
import { ALL_DIMS, DIMS_P0, auditL2, type L2Request } from '../l2'
import type { AuditItem, AuditReport, Decision, ProjectMeta, Severity } from '../types'
import { graphNode } from '../memory'
import { presentCharacters } from './architect'
import { nowIso } from '../util'

/** 项目未指定维度时的默认档位（P0 首批 5 维） */
export const DEFAULT_DIMS_P0 = DIMS_P0

export class Auditor extends Agent {
  async audit(
    chapter: number,
    opts: { dims?: string[] | null; runL2?: boolean } = {},
  ): Promise<AuditReport> {
    const { dims = null, runL2 = true } = opts
    const store = this.store
    const data = store.readChapter(chapter)
    const text = data.paragraphs.join('\n\n')
    if (!text.trim()) {
      throw new Error(`第 ${chapter} 章还没有正文，先写出来再审查。`)
    }

    const meta = store.meta()
    const graph = store.outlineGraph()
    const node = graphNode(graph, chapter)

    // ---------- 第一步：规则校验（零成本，必跑）----------
    const l1: L1Result = checkL1({
      text,
      chapter,
      characters: store.characters(),
      hooks: store.hooks(),
      world_rules: store.world().rules,
      style: store.style(),
      characters_present: presentCharacters(store, text),
    })

    // ---------- 第二步：模型审查（按维度开关）----------
    const effectiveDims = dims ? [...dims] : dimsFor(meta)
    let items: AuditItem[] = []
    if (runL2 && effectiveDims.length) {
      this.scope(chapter, 'audit')
      this.budgetGate()
      const req: L2Request = {
        chapter,
        title: data.title || (node ? node.title : ''),
        text,
        characters: store.characters(),
        hooks: store.hooks(),
        world_rules: store.world().rules,
        summaries: store.summaries().filter((s) => s.chapter < chapter).slice(-6),
        outline_node: node,
        compass_endgame: graph.compass.endgame,
        style: store.style(),
        dims: effectiveDims,
      }
      items = await auditL2(req)
      // auditL2 内部用 completeJson，这里补记计量
      this.usage.calls += 1
    }

    // ---------- 合并 ----------
    // 规则违规也转成「发现」，作者在同一列表里处理；但保留 l1 全量清单供表格展示
    for (const v of l1.violations) {
      items.unshift({
        dim: `规则 · ${v.rule}`,
        severity: severityForRule(v.rule),
        evidence: (v.samples[0] ?? v.hit) || v.rule,
        suggestion: `命中 ${v.count} 次（阈值 ${v.threshold}），建议定点改写。`,
        ref: `ch_${String(chapter).padStart(4, '0')}.md`,
        fixed: false,
        decision: null,
        patch: null,
      })
    }

    const report: AuditReport = store.readAudit(chapter) ?? newAuditReport(chapter)
    report.chapter = chapter
    report.title = data.title
    report.l1_violations = l1.violations
    report.l1_checked = l1.checked
    report.items = mergeItems(report.items, items)
    report.stats = stats(report)
    store.saveAudit(report)

    this.cp.finish(
      this.cp.begin(chapter, 'audit'),
      {
        output_ref: `audits/ch_${String(chapter).padStart(4, '0')}.json`,
        cost: this.usage.cost,
        note: `规则命中 ${l1.violations.length} 条 · 模型审查 ${items.length - l1.violations.length} 条`,
      },
    )
    return report
  }
}

/** 空审计报告（镜像 Python `AuditReport(chapter=chapter)` 的默认字段） */
function newAuditReport(chapter: number): AuditReport {
  return {
    chapter,
    title: '',
    l1_violations: [],
    l1_checked: [],
    items: [],
    review: [],
    diffs: [],
    stats: {},
    generated_at: nowIso(),
  }
}

/** 项目未指定维度时的默认档位 */
function dimsFor(meta: ProjectMeta): string[] {
  if (meta.audit_dims.length) {
    return meta.audit_dims.filter((d) => ALL_DIMS.includes(d))
  }
  return meta.audit_dims_extended ? [...ALL_DIMS] : [...DIMS_P0]
}

/** 规则违规的严重度。设定层面的问题阻塞定稿，文风层面的只算建议。 */
function severityForRule(rule: string): Severity {
  if (['死亡', '亡故', '不可变特征', '数值', '等级', '称呼', '姓名'].some((k) => rule.includes(k))) {
    return 'major'
  }
  if (['伏笔', '时间线'].some((k) => rule.includes(k))) {
    return 'major'
  }
  return 'minor'
}

/** 保留已有人工决策，避免重跑审查后把作者的裁定冲掉。 */
function mergeItems(old: AuditItem[], next: AuditItem[]): AuditItem[] {
  const decisions = new Map<string, { decision: Decision; fixed: boolean }>()
  for (const item of old) {
    if (item.decision) decisions.set(item.evidence, { decision: item.decision, fixed: item.fixed })
  }
  const out: AuditItem[] = []
  const seen = new Set<string>()
  for (const item of next) {
    const key = item.evidence
    if (seen.has(key)) continue
    seen.add(key)
    const kept = decisions.get(key)
    if (kept) {
      item.decision = kept.decision
      item.fixed = kept.fixed
    }
    out.push(item)
  }
  // 旧报告里仍有人工决策但本轮没再检出的条目：保留，标记为已处理
  for (const item of old) {
    if (item.decision && !seen.has(item.evidence)) {
      item.fixed = item.decision === 'accept'
      out.push(item)
    }
  }
  return out
}

function stats(report: AuditReport): Record<string, number> {
  const items = report.items
  const fixed = items.filter((i) => i.fixed).length
  const openCount = items.filter((i) => !i.fixed).length
  const blockers = items.filter((i) => i.severity === 'blocker' && !i.fixed).length
  const majors = items.filter((i) => i.severity === 'major' && !i.fixed).length
  const total = items.length || 1
  return {
    l1: report.l1_violations.length,
    l2: items.filter((i) => !i.dim.startsWith('规则 · ')).length,
    fixed,
    open: openCount,
    blocker: blockers,
    major: majors,
    passRate: items.length ? Math.round((fixed / total) * 100) : 100,
  }
}
