/**
 * Reviewer：正文 + 章纲 + 依赖图 → 7 维可举证质量评审。
 *
 * 与 Auditor 的分工：**审查看设定与逻辑，评审看写作质量**。
 * 硬要求：每维必须引用原文，无证据的维度记 0 分并注明「未取到可举证的原文」，
 * 不进入报告结论 —— 这条约束的意义是让反馈可执行、可申诉。
 */

import { Agent } from './base'
import { reviewChapter, REVIEW_DIMS, type ReviewRequest } from '../review'
import type { ReviewReport } from '../types'
import { graphNode } from '../memory'

export class Reviewer extends Agent {
  async review(chapter: number): Promise<ReviewReport> {
    const store = this.store
    const data = store.readChapter(chapter)
    const text = data.paragraphs.join('\n\n')
    if (!text.trim()) {
      throw new Error(`第 ${chapter} 章还没有正文，先写出来再评审。`)
    }

    const graph = store.outlineGraph()
    const node = graphNode(graph, chapter)
    const summaries = store.summaries().filter((s) => s.chapter < chapter).slice(-4)
    const summaryContext = summaries
      .map((s) => `- 第 ${s.chapter} 章《${s.title}》：${s.summary}`)
      .join('\n')

    this.scope(chapter, 'review')
    this.budgetGate()
    const req: ReviewRequest = {
      chapter,
      title: data.title || (node ? node.title : ''),
      text,
      outline_node: node,
      hooks: store.hooks(),
      style: store.style(),
      summary_context: summaryContext,
    }
    const report = await reviewChapter(req)
    this.usage.calls += 1
    if (!report.dims) {
      report.dims = []
    }
    store.saveReview(report)

    // 同步进审计报告——作者只看一个地方
    const audit = store.readAudit(chapter)
    if (audit !== null) {
      audit.review = report.dims.map((d) => ({ ...d }))
      store.saveAudit(audit)
    }

    this.cp.finish(
      this.cp.begin(chapter, 'review'),
      {
        output_ref: `reviews/ch_${String(chapter).padStart(4, '0')}.json`,
        cost: this.usage.cost,
        note: `${report.dims.length}/${REVIEW_DIMS.length} 维 · 综合 ${report.overall} 分`,
      },
    )
    return report
  }
}
