/**
 * 可举证质量评审 —— 镜像 `server/dobi/consistency/review.py`。
 *
 * 与 L2 审计的区别：L2 审「设定与逻辑」，评审审「写作质量」。7 个维度，每维给
 * 0–100 分，且**必须引用原文举证**；无证据的维度记 0 分并注明原因。
 */

import type { Hook, OutlineNode, ReviewDimension, ReviewReport, StyleProfile } from './types'
import { completeJson, type Message } from './llm'
import { nowIso } from './util'
import { styleInjectionText, styleIsEmpty } from './style'

/** 评审维度（首批 7 项） */
export const REVIEW_DIMS: string[] = [
  '设定一致性', '角色行为', '节奏', '叙事连贯', '伏笔', '钩子', '审美品质',
]

const NO_EVIDENCE_NOTE = '未取到可举证的原文'

export interface ReviewRequest {
  chapter: number
  title: string
  text: string
  outline_node: OutlineNode | null
  hooks: Hook[]
  style: StyleProfile | null
  summary_context: string
}

function norm(text: string): string {
  return (text || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '')
}

function extractDims(obj: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(obj)) {
    return obj.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
  }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>
    for (const key of ['dims', 'items', 'results', 'review', 'dimensions']) {
      const val = o[key]
      if (Array.isArray(val)) {
        return val.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      }
    }
    if ('dim' in o || 'score' in o) return [o]
  }
  return []
}

function toScore(value: unknown): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

function buildMessages(req: ReviewRequest, dims: string[]): Message[] {
  const system =
    '你是一位资深中文小说编辑，正在做可举证的质量评审。\n' +
    '硬性要求：\n' +
    '1. 只评审指定的维度，每个维度给一个 0–100 的整数分（score）；\n' +
    '2. 每个维度的 evidence 必须是本章正文的**逐字原文片段**（连续、原样、' +
    '不得改写或概括），作为打分的依据；没有可引用的原文就不要给分，' +
    '把 score 记为 0 并在 note 说明；\n' +
    '3. note 用一句话说明扣分或加分的关键原因；\n' +
    '4. 评分要拉开区分度，不要所有维度都给同一个分。\n' +
    '只输出一个 JSON 对象，形如：{"dims":[{"dim":"节奏","score":84,' +
    '"evidence":"原文逐字片段","note":"说明"}]}。' +
    '不要输出解释文字、不要 Markdown 代码块围栏。'

  const parts: string[] = [`# 待评审章节：第 ${req.chapter} 章《${req.title}》`]
  parts.push('## 评审维度（JSON 数组）')
  parts.push(JSON.stringify(dims))
  if (req.outline_node) {
    const node = req.outline_node
    parts.push('## 本章章纲预期')
    parts.push(`- 目标：${node.goal || '—'}`)
    if (node.beats.length) parts.push(`- 节拍：${node.beats.join('；')}`)
  }
  if (req.summary_context) parts.push(`## 前情提要\n${req.summary_context}`)
  if (req.hooks.length) {
    parts.push('## 伏笔池')
    for (const h of req.hooks) {
      parts.push(`- ${h.id}（第 ${h.planted_chapter} 章埋设，状态 ${h.status}）：${h.content}`)
    }
  }
  if (req.style && !styleIsEmpty(req.style)) {
    parts.push('## 文风档案')
    parts.push(styleInjectionText(req.style))
  }
  parts.push('## 本章正文')
  parts.push(req.text)

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
  ]
}

/** 返回 7 维评审报告；每维必须带可检索到的原文证据，否则记 0 分。 */
export async function reviewChapter(req: ReviewRequest): Promise<ReviewReport> {
  const dims = [...REVIEW_DIMS]
  if (!(req.text || '').trim()) {
    return {
      chapter: req.chapter,
      dims: dims.map((d) => ({ dim: d, score: 0, evidence: '', note: NO_EVIDENCE_NOTE })),
      overall: 0,
      generated_at: nowIso(),
    }
  }

  const { data } = await completeJson('review', buildMessages(req, dims))
  const byDim = new Map<string, Record<string, unknown>>()
  for (const raw of extractDims(data)) {
    const dim = String(raw.dim ?? '').trim()
    if (dim && !byDim.has(dim)) byDim.set(dim, raw)
  }

  const normText = norm(req.text)
  const reportDims: ReviewDimension[] = []
  for (const dim of dims) {
    const raw = byDim.get(dim)
    if (!raw) {
      reportDims.push({ dim, score: 0, evidence: '', note: NO_EVIDENCE_NOTE })
      continue
    }
    const evidence = String(raw.evidence ?? '').trim()
    if (!evidence || !normText.includes(norm(evidence))) {
      reportDims.push({ dim, score: 0, evidence: '', note: NO_EVIDENCE_NOTE })
      continue
    }
    reportDims.push({
      dim,
      score: toScore(raw.score),
      evidence,
      note: String(raw.note ?? '').trim(),
    })
  }

  const scored = reportDims.map((d) => d.score)
  const overall = scored.length ? Math.round(scored.reduce((s, x) => s + x, 0) / scored.length) : 0
  return { chapter: req.chapter, dims: reportDims, overall, generated_at: nowIso() }
}
