/**
 * L2 模型维度审查 —— 镜像 `server/dobi/consistency/l2.py`。
 *
 * 与 L1 的分工：L1 用规则对「可确定性判定」的问题零成本出结论；L2 交给模型，
 * 覆盖 OOC、设定冲突、因果断裂这类需要理解语义的维度。
 *
 * 两条硬约束：
 * 1. **一次调用审全部指定维度**——把维度清单作为 JSON 数组放进同一次提示词；
 * 2. **无证据的结论直接丢弃**——每条发现必须带 `evidence`（逐字原文），
 *    且该 evidence 能在正文中检索到（去标点后子串包含），否则整条丢弃。
 */

import type { AuditItem, ChapterSummary, Character, Hook, OutlineNode, Severity, StyleProfile, WorldRule } from './types'
import { completeJson, type Message } from './llm'
import { styleInjectionText, styleIsEmpty } from './style'

/** P0 首批 5 维 */
export const DIMS_P0: string[] = ['OOC', '设定冲突', '伏笔遗漏', '时间线矛盾', '文风偏移']

/** P1 增补 10 维 */
export const DIMS_P1: string[] = [
  '战力/等级漂移', '信息泄露', '节奏单调', '支线停滞', '情感弧线断裂',
  '场景重复', '对话同质化', '因果断裂', '动机不足', '爽点缺失',
]

export const ALL_DIMS: string[] = [...DIMS_P0, ...DIMS_P1]

const SEV_MAP: Record<string, Severity> = {
  blocker: 'blocker', major: 'major', minor: 'minor',
  阻塞定稿: 'blocker', 阻塞: 'blocker', 重点: 'major', 建议: 'minor',
}

export interface L2Request {
  chapter: number
  title: string
  text: string
  characters: Character[]
  hooks: Hook[]
  world_rules: WorldRule[]
  summaries: ChapterSummary[]   // 前情提要
  outline_node: OutlineNode | null
  compass_endgame: string
  style: StyleProfile | null
  dims: string[]                // 只审这些维度
}

/** 去空白与标点，用于「去标点后子串包含」的证据校验 */
function norm(text: string): string {
  return (text || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '')
}

function paragraphs(text: string): string[] {
  return (text || '').split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean)
}

/** 证据落入哪一段 → `ch_0017.md#para-5`（段落号按 \n\n 的 1-based 序号） */
function ref(chapter: number, paras: string[], evidence: string): string {
  const normEv = norm(evidence)
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]
    if (p.includes(evidence) || (normEv && norm(p).includes(normEv))) {
      return `ch_${String(chapter).padStart(4, '0')}.md#para-${i + 1}`
    }
  }
  return `ch_${String(chapter).padStart(4, '0')}.md`
}

function normalizeSeverity(value: unknown): Severity {
  const s = String(value ?? '').trim()
  return SEV_MAP[s.toLowerCase()] ?? SEV_MAP[s] ?? 'minor'
}

/** 兼容模型可能返回的几种 JSON 形状 */
function extractItems(obj: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(obj)) {
    return obj.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
  }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>
    for (const key of ['items', 'findings', 'dims', 'results', 'issues', 'audit']) {
      const val = o[key]
      if (Array.isArray(val)) {
        return val.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      }
    }
    // 单条
    if ('dim' in o || 'evidence' in o) return [o]
  }
  return []
}

function characterLines(chars: Character[]): string[] {
  const out: string[] = []
  for (const c of chars) {
    const traits = c.immutable_traits.join('、') || '—'
    const status = c.state ? c.state.status : '—'
    const dead = c.deceased ? '（已亡故）' : ''
    out.push(`- ${c.name}${dead}｜不可变特征：${traits}｜当前状态：${status}`)
  }
  return out
}

function hookLines(hooks: Hook[]): string[] {
  return hooks.map((h) => `- ${h.id}（${h.status === 'resolved' ? '已回收' : '待回收'}，埋于第 ${h.planted_chapter} 章）：${h.content}`)
}

function ruleLines(rules: WorldRule[]): string[] {
  return rules.map((r) => `- [${r.kind}] ${r.rule}`)
}

function summaryLines(summaries: ChapterSummary[]): string[] {
  return summaries.filter((s) => s.summary).map((s) => `- 第 ${s.chapter} 章 ${s.title}：${s.summary}`)
}

function buildMessages(req: L2Request, dims: string[]): Message[] {
  const system =
    '你是一位严谨的中文长篇小说审校。你的任务是对给定章节做多维度一致性审查，' +
    '只报告你能在原文中逐字引用证据的问题。\n' +
    '硬性要求：\n' +
    '1. 只针对指定的审查维度报告发现，不要新增其他维度；\n' +
    '2. 每条发现的 evidence 必须是本章正文的**逐字原文片段**（连续、原样、不得改写或概括），' +
    '把引文放在「」内或不加引号均可，但文字必须与原文完全一致；\n' +
    '3. 每条发现给出可执行的 suggestion（修改建议）；\n' +
    '4. severity 只能取 blocker / major / minor 之一：' +
    'blocker=阻塞定稿的硬伤，major=需要重点修订，minor=建议优化；\n' +
    '5. 若某维度没有发现，就不要为它输出任何条目；宁可少报，不可编造证据。\n' +
    '只输出一个 JSON 对象，形如：{"items":[{"dim":"设定冲突","severity":"major",' +
    '"evidence":"原文逐字片段","suggestion":"修改建议"}]}。' +
    '不要输出解释文字、不要 Markdown 代码块围栏。'

  const parts: string[] = []
  parts.push(`# 待审章节：第 ${req.chapter} 章《${req.title}》`)
  parts.push('## 需要审查的维度（JSON 数组）')
  parts.push(JSON.stringify(dims))
  if (req.outline_node) {
    const node = req.outline_node
    parts.push('## 本章章纲预期')
    parts.push(`- 目标：${node.goal || '—'}`)
    if (node.beats.length) parts.push(`- 节拍：${node.beats.join('；')}`)
    if (node.pov) parts.push(`- 视角：${node.pov}`)
  }
  if (req.compass_endgame) parts.push(`## 全书终局方向\n${req.compass_endgame}`)
  if (req.characters.length) {
    parts.push('## 角色卡（不可变特征不可违背）')
    parts.push(...characterLines(req.characters))
  }
  if (req.world_rules.length) {
    parts.push('## 世界观规则（hard 即硬约束）')
    parts.push(...ruleLines(req.world_rules))
  }
  if (req.hooks.length) {
    parts.push('## 伏笔池')
    parts.push(...hookLines(req.hooks))
  }
  if (req.summaries.length) {
    parts.push('## 前情提要')
    parts.push(...summaryLines(req.summaries))
  }
  if (req.style && !styleIsEmpty(req.style)) {
    parts.push('## 文风档案（文风偏移维度的对照基准）')
    parts.push(styleInjectionText(req.style))
  }
  parts.push('## 本章正文')
  parts.push(req.text)

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
  ]
}

/** 对指定维度做一次模型审查，返回带原文证据的 AuditItem 列表。
 *  无证据或证据在正文中检索不到的条目会被直接丢弃。
 */
export async function auditL2(req: L2Request): Promise<AuditItem[]> {
  const dims = (req.dims.length ? req.dims : ALL_DIMS).filter((d) => d)
  if (!dims.length || !(req.text || '').trim()) return []

  const { data } = await completeJson('audit_l2', buildMessages(req, dims))

  const paras = paragraphs(req.text)
  const normText = norm(req.text)
  const out: AuditItem[] = []
  for (const raw of extractItems(data)) {
    const dim = String(raw.dim ?? '').trim()
    const evidence = String(raw.evidence ?? '').trim()
    if (!dim || !evidence) continue
    const normEv = norm(evidence)
    if (!normEv || !normText.includes(normEv)) continue   // 硬约束：检索不到即丢弃
    out.push({
      dim,
      severity: normalizeSeverity(raw.severity),
      evidence,
      suggestion: String(raw.suggestion ?? '').trim(),
      ref: ref(req.chapter, paras, evidence),
      fixed: false,
      decision: null,
      patch: null,
    })
  }
  return out
}
