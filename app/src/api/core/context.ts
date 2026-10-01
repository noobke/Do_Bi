/**
 * 上下文组装 —— 镜像 `server/dobi/core/context.py`。
 *
 * 分层预算：系统规则 5% / 角色与世界观 15% / 动态事实 10% / 历史摘要 20% /
 * 当前草稿 30% / 输出预留 20%。**文风档案是「确定性必选」——不占配额、不参与检索竞争**。
 *
 * 三条硬约定：
 * 1. 超预算不报错，按优先级裁剪低价值内容，并在 `notes` 里如实说明省略了什么。
 * 2. 不引用后文：所有检索都带 `up_to_chapter`，避免「第 17 章引用了第 24 章才知道的事」。
 * 3. 依赖图必须被真实消费：本章的 `motivation` / `setup` 入边作为「前因约束」进入动态事实区。
 */

import type { Character, Hook, OutlineNode, StyleProfile } from './types'
import type { ProjectStore } from './store'
import { MemoryIndex, formatSearchHits, graphNode, motivationsFor } from './memory'
import { estimateTokens } from './util'

export const CONTEXT_BUDGET_SPLIT: Record<string, number> = {
  system: 5,
  cast: 15,
  facts: 10,
  summary: 20,
  draft: 30,
  output: 20,
}

const OUTPUT_RESERVE_PCT = 20

// 各区块在超预算时的牺牲顺序（越靠前越先被裁）
const SACRIFICE_ORDER: string[] = ['summary', 'facts', 'cast', 'draft']

export const BASE_SYSTEM =
  '你是一名长篇小说写作助手，服务于一位中文作者。\n' +
  '工作原则：\n' +
  '1. **只负责叙述，不负责改设定**。世界观、角色状态、伏笔归属由系统维护，你不得擅自变更。\n' +
  '2. 严格延续给定的文风档案与上文语境，不引入新的人名、地名、称谓，除非章纲明确要求。\n' +
  '3. 不写作者旁白、不写章节总结、不写「本章完」。直接给正文。\n' +
  '4. 段落自然分段；对话与叙述混排时不做额外标记。\n' +
  '5. 如果章纲里有你无法自然衔接的地方，宁可写得克制，也不要编造设定去圆场。'

export const PURPOSES: Record<string, string> = {
  writer: '撰写章节正文',
  audit: '审查章节与设定的一致性',
  review: '评审章节的写作质量',
  plan: '规划章节与依赖关系',
  revise: '按审查结论定点修订',
}

/** token 预算 → 中文字符预算（与 estimateTokens 同一换算口径） */
function charsFor(tokens: number): number {
  return Math.max(0, Math.floor(tokens * 1.6))
}

function truncate(text: string, tokenBudget: number): { text: string; truncated: boolean } {
  if (tokenBudget <= 0) return { text: '', truncated: Boolean(text.trim()) }
  if (estimateTokens(text) <= tokenBudget) return { text, truncated: false }
  const limit = charsFor(tokenBudget)
  let clipped = text.slice(0, limit)
  const cut = Math.max(clipped.lastIndexOf('\n'), clipped.lastIndexOf('。'))
  if (cut > limit * 0.5) clipped = clipped.slice(0, cut + 1)
  return {
    text: clipped.replace(/\s+$/, '') + '\n…（此处因上下文额度不足被截断）',
    truncated: true,
  }
}

export class ContextSection {
  key: string
  label: string
  text: string
  tokens: number
  cap: number
  mandatory: boolean
  truncated: boolean
  omitted: boolean

  constructor(init: {
    key: string
    label: string
    text?: string
    tokens?: number
    cap?: number
    mandatory?: boolean
    truncated?: boolean
    omitted?: boolean
  }) {
    this.key = init.key
    this.label = init.label
    this.text = init.text ?? ''
    this.tokens = init.tokens ?? 0
    this.cap = init.cap ?? 0
    this.mandatory = init.mandatory ?? false
    this.truncated = init.truncated ?? false
    this.omitted = init.omitted ?? false
  }

  public(): Record<string, unknown> {
    return {
      key: this.key, label: this.label, tokens: this.tokens,
      cap: this.cap, mandatory: this.mandatory,
      truncated: this.truncated, omitted: this.omitted,
      chars: this.text.length,
    }
  }
}

export class ContextBundle {
  chapter: number
  purpose: string
  window: number
  outputReserve: number
  sections: ContextSection[] = []
  notes: string[] = []
  related: Array<Record<string, unknown>> = []
  messages: Array<{ role: string; content: string }> = []

  constructor(chapter: number, purpose: string, window: number, outputReserve: number) {
    this.chapter = chapter
    this.purpose = purpose
    this.window = window
    this.outputReserve = outputReserve
  }

  get usedTokens(): number {
    return this.sections.filter((s) => !s.omitted).reduce((sum, s) => sum + s.tokens, 0)
  }

  get mandatoryTokens(): number {
    return this.sections.filter((s) => s.mandatory && !s.omitted).reduce((sum, s) => sum + s.tokens, 0)
  }

  section(key: string): ContextSection | undefined {
    return this.sections.find((s) => s.key === key)
  }

  public(): Record<string, unknown> {
    return {
      chapter: this.chapter,
      purpose: this.purpose,
      window: this.window,
      outputReserve: this.outputReserve,
      usedTokens: this.usedTokens,
      mandatoryTokens: this.mandatoryTokens,
      sections: this.sections.map((s) => s.public()),
      notes: this.notes,
      related: this.related,
      budgetSplit: CONTEXT_BUDGET_SPLIT,
    }
  }
}

// ==========================================================================
// 各区块内容
// ==========================================================================

function renderCharacters(chars: Character[], present: string[] | null): string {
  let picked: Character[] = []
  let rest: Character[] = [...chars]
  if (present && present.length) {
    const names = new Set(present)
    picked = chars.filter((c) => names.has(c.name) || names.has(c.id))
    rest = chars.filter((c) => !picked.includes(c))
  }

  const lines: string[] = []
  const ordered = [...picked, ...rest.slice(0, 4)] // 未指明出场时，只带最近更新的 4 个，其余靠检索
  for (const c of ordered) {
    lines.push(`### ${c.name}（${c.role}${c.lead ? '·主角' : ''}）`)
    if (c.immutable_traits.length) {
      lines.push(`- 不可变特征：${c.immutable_traits.join('；')}（**不得违背**）`)
    }
    if (c.personality) lines.push(`- 性格：${c.personality}`)
    if (c.speech_style) lines.push(`- 说话方式：${c.speech_style}`)
    lines.push(`- 当前状态：${c.state.location}／${c.state.status}`)
    if (c.deceased) {
      lines.push('- ⚠️ 已亡故：**不得作为在场人物出现**，只能出现在回忆或他人转述中')
    }
    if (c.relationships.length) {
      const rel = c.relationships
        .slice(0, 4)
        .map((r) => `${r.target}(${r.type})${r.note ? '：' + r.note : ''}`)
        .join('；')
      lines.push(`- 关系：${rel}`)
    }
    lines.push('')
  }
  if (rest.length > 4) lines.push(`_（另有 ${rest.length - 4} 个未出场角色，需要时再检索）_`)
  return lines.join('\n').trim()
}

function renderWorld(store: ProjectStore): string {
  const hard = store.world().rules.filter((r) => r.kind === 'hard')
  if (!hard.length) return ''
  const lines = ['### 硬约束（违反即阻塞定稿）', '']
  for (const r of hard) {
    const mark = r.status === 'conflict' ? ' ⚠️待裁定冲突' : ''
    lines.push(`- [${r.category}] ${r.rule}${mark}`)
  }
  return lines.join('\n')
}

function renderFacts(store: ProjectStore, chapter: number, node: OutlineNode | null, hooks: Hook[]): string {
  const lines: string[] = []

  // 作者的实时干预意见 —— 最高优先级，写在最前面
  const directives = store.steeringDirectives({ chapter })
  if (directives.length) {
    lines.push('### 作者干预意见（**必须遵守，优先级最高**）')
    for (const d of directives) {
      const raw = d as unknown as Record<string, unknown>
      const steps = (Array.isArray(raw.steps) ? raw.steps : (d.intent?.steps as unknown)) ?? []
      lines.push(`- ${d.text}` + (Array.isArray(steps) && steps.length ? `（要求：${steps.join('；')}）` : ''))
    }
    lines.push('')
  }

  const state = store.state()
  if (state.situation) lines.push(`### 当前局势\n${state.situation}\n`)

  // 依赖图反查：本章依赖的前因（motivation / setup 入边）
  if (node) {
    const graph = store.outlineGraph()
    const paths = motivationsFor(graph, chapter)
    if (paths.length) {
      lines.push('### 本章依赖的前因（来自依赖图，**必须衔接上**）')
      for (const e of paths) {
        const src = graphNode(graph, e.to_chapter)
        lines.push(`- 依赖第 ${e.to_chapter} 章《${src?.title ?? ''}》：${e.note}（类型：${e.type}）`)
      }
      lines.push('')
    }
  }

  const overdue = hooks.filter(
    (h) => h.status === 'planted' && h.suggested_resolve_by != null && chapter > (h.suggested_resolve_by ?? 0),
  )
  if (overdue.length) {
    lines.push('### 已超期的伏笔（建议本章或近期给出呼应）')
    for (const h of overdue) {
      lines.push(`- ${h.id}：${h.content}（埋于第 ${h.planted_chapter} 章，原计划第 ${h.suggested_resolve_by} 章前回收）`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}

// ==========================================================================
// 组装
// ==========================================================================

export interface BuildContextOptions {
  purpose?: string
  contextWindow?: number
  node?: OutlineNode | null
  draft?: string
  query?: string
  systemText?: string
  charactersPresent?: string[] | null
  targetText?: string
  outputReservePct?: number | null
}

export function buildContext(
  store: ProjectStore,
  chapter: number,
  opts: BuildContextOptions = {},
): ContextBundle {
  const {
    purpose = 'writer',
    contextWindow = 32000,
    node = null,
    draft = '',
    query = '',
    systemText = '',
    charactersPresent = null,
    targetText = '',
    outputReservePct = null,
  } = opts

  const meta = store.meta()
  const style = store.style()
  const reservePct = outputReservePct ?? OUTPUT_RESERVE_PCT

  const window = Math.max(1024, Math.floor(contextWindow || 32000))
  const outputReserve = Math.floor((window * reservePct) / 100)
  const avail = window - outputReserve

  // 审查 / 评审时被审正文才是主角，需要更大额度；其余区块相应压缩。
  // 权重之和恒等于 (100 - output_reserve_pct)，即「可用额度」那一档。
  const split = { ...CONTEXT_BUDGET_SPLIT }
  if (purpose === 'audit' || purpose === 'review') {
    split.cast = 12
    split.facts = 8
    split.summary = 15
    split.draft = 45
  }

  const capFor = (key: string): number => Math.floor((avail * (split[key] ?? 0)) / (100 - reservePct))

  const bundle = new ContextBundle(chapter, purpose, window, outputReserve)

  // ---- 必选：系统规则 + 文风档案（不占配额）----
  const sysParts: string[] = [systemText || BASE_SYSTEM]
  if (purpose) sysParts.push(`本次任务：${PURPOSES[purpose] ?? purpose}。`)
  bundle.sections.push(
    new ContextSection({
      key: 'system', label: '系统规则',
      text: sysParts.join('\n\n'),
      tokens: estimateTokens(sysParts.join('\n\n')),
      mandatory: true,
    }),
  )
  if (!styleIsEmpty(style)) {
    const injection = styleInjectionText(style)
    bundle.sections.push(
      new ContextSection({
        key: 'style', label: '文风档案（必选）',
        text: injection,
        tokens: estimateTokens(injection),
        mandatory: true,
      }),
    )
  }

  // ---- 历史摘要（BM25 + 关联章节推荐）----
  const lookups =
    (query || '').trim() ||
    [node?.goal ?? '', node?.beats.join(' ') ?? '', node?.rationale ?? ''].filter(Boolean).join(' ')
  const memory = new MemoryIndex(store)
  const related = lookups ? memory.relatedChapters(chapter, lookups || '章节', { k: 5 }) : []
  bundle.related = related

  const summaryParts: string[] = []
  const recent = store
    .summaries()
    .filter((s) => s.chapter < chapter)
    .sort((a, b) => b.chapter - a.chapter)
  for (const s of recent.slice(0, 3)) summaryParts.push(`- 第 ${s.chapter} 章《${s.title}》：${s.summary}`)
  if (recent.length > 3) {
    summaryParts.push('')
    summaryParts.push('更早（按相关度）：')
    for (const s of recent.slice(3, 8)) summaryParts.push(`- 第 ${s.chapter} 章《${s.title}》：${s.summary.slice(0, 120)}`)
  }
  const hits = lookups ? memory.search(lookups || '章节', { k: 6, upToChapter: chapter }) : []
  const hitsFiltered = hits.filter((h) => h.chapter !== chapter)
  if (hitsFiltered.length) {
    summaryParts.push('')
    summaryParts.push('相关片段（检索所得）：')
    summaryParts.push(formatSearchHits(hitsFiltered))
  }

  // ---- 草稿区（写作时是已写内容，审查时是被审正文）----
  const draftText = purpose === 'audit' || purpose === 'review' ? targetText : draft

  const rawSections: Array<[string, string, string, boolean]> = [
    ['cast', '角色与世界观', [renderCharacters(store.characters(), charactersPresent), renderWorld(store)].filter((x) => x.trim()).join('\n\n'), false],
    ['facts', '动态事实', renderFacts(store, chapter, node, store.hooks()), false],
    ['summary', '前情摘要', summaryParts.join('\n').trim(), false],
    ['draft', purpose === 'writer' ? '当前草稿' : '待审正文', draftText, purpose === 'audit' || purpose === 'review'],
  ]

  for (const [key, label, text, mandatory] of rawSections) {
    const cap = capFor(key)
    if (purpose === 'writer' && key === 'draft' && !text) {
      bundle.sections.push(new ContextSection({ key, label, cap, mandatory, omitted: true }))
      continue
    }
    const { text: clipped, truncated } = truncate(text, cap)
    const section = new ContextSection({
      key, label, text: clipped,
      tokens: estimateTokens(clipped), cap,
      mandatory, truncated,
      omitted: !clipped.trim(),
    })
    if (truncated) {
      bundle.notes.push(`「${label}」超出本档额度（${section.tokens} / ${cap}），已截断到最新内容。`)
    }
    bundle.sections.push(section)
  }

  // ---- 超预算：按牺牲顺序继续裁剪（不报错）----
  for (const key of SACRIFICE_ORDER) {
    if (bundle.usedTokens <= avail) break
    const section = bundle.section(key)
    if (!section || section.mandatory || section.omitted) continue
    const over = bundle.usedTokens - avail
    const keep = Math.max(0, section.tokens - over)
    const { text: clipped } = truncate(section.text, keep)
    const newTokens = estimateTokens(clipped)
    if (newTokens <= 0) {
      const lost = section.tokens
      section.text = ''
      section.tokens = 0
      section.omitted = true
      bundle.notes.push(`额度不足，已整块省略「${section.label}」（省下约 ${lost} 额度）`)
    } else {
      const lost = section.tokens - newTokens
      section.text = clipped
      section.tokens = newTokens
      section.truncated = true
      bundle.notes.push(`额度不足，已压缩「${section.label}」约 ${lost} 额度`)
    }
  }

  if (bundle.usedTokens > avail) {
    bundle.notes.push(
      `上下文仍超出额度 ${bundle.usedTokens - avail}（必选区块不可裁），已交由模型侧自行取舍。`,
    )
  }

  if (meta.budget_used && meta.budget_total && meta.budget_used / meta.budget_total >= 0.8) {
    bundle.notes.push(
      `本书预算已用 ${meta.cost_unit}${meta.budget_used.toFixed(2)} / ${meta.cost_unit}${meta.budget_total.toFixed(2)}。`,
    )
  }

  bundle.messages = composeMessages(bundle)
  return bundle
}

function composeMessages(bundle: ContextBundle): Array<{ role: string; content: string }> {
  const systemParts = bundle.sections
    .filter((s) => (s.key === 'system' || s.key === 'style') && !s.omitted)
    .map((s) => s.text)
  const userParts: string[] = []
  for (const s of bundle.sections) {
    if (s.key === 'system' || s.key === 'style' || s.omitted || !s.text.trim()) continue
    userParts.push(`## ${s.label}\n${s.text}`)
  }
  if (bundle.related.length) {
    const lines = ['## 关联章节（供参考，不必全部提及）']
    for (const r of bundle.related) {
      lines.push(`- 第 ${r.chapter} 章《${r.title}》（${r.reason}）`)
    }
    userParts.push(lines.join('\n'))
  }
  return [
    { role: 'system', content: systemParts.join('\n\n') },
    { role: 'user', content: userParts.join('\n\n') },
  ]
}

// ==========================================================================
// 文风档案（确定性必选）
// ==========================================================================

function styleIsEmpty(style: StyleProfile): boolean {
  return !style.source && style.preferred_patterns.length === 0
}

function styleInjectionText(style: StyleProfile): string {
  const lines = ['# 文风档案（确定性必选，优先级高于一般上下文）']
  if (style.source) lines.push(`来源：${style.source}`)
  if (style.sentence.mean) {
    lines.push(
      `句长：均值 ${fmt(style.sentence.mean)} 字 · p50 ${fmt(style.sentence.p50)} · p90 ${fmt(style.sentence.p90)}`,
    )
  }
  if (style.narrative.person) {
    lines.push(
      `叙述：${style.narrative.person} / ${style.narrative.tense} / 视角切换${style.narrative.pov_switch}` +
        (style.narrative.anchor ? `；${style.narrative.anchor}` : ''),
    )
  }
  if (style.ratio.length) {
    lines.push('描写/对话/动作比例：' + style.ratio.map((r) => `${r.label} ${r.pct}%`).join(' · '))
  }
  if (style.preferred_patterns.length) lines.push('偏好手法：' + style.preferred_patterns.join('；'))
  if (style.banned_expressions.length) lines.push('禁用表达：' + style.banned_expressions.join(' / '))
  for (const item of style.lexicon) lines.push(`${item.key}：${item.value}`)
  return lines.join('\n')
}

/** 数字格式化（等价 Python `:g`：去掉多余小数位） */
function fmt(v: number): string {
  return String(Math.round(v * 100) / 100)
}
