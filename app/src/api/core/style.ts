/**
 * 文风仿写 —— 镜像 `server/dobi/consistency/style.py`。
 *
 * 流程：先跑 `localMetrics` 得到**确定性事实基线**（句长分布、描写/对话/动作比例、
 * 人称、段长、高频短语），再让模型在基线上补充 `preferred_patterns /
 * banned_expressions / lexicon / narrative` 判断。模型返回的数字若与本地基线偏差
 * 超过 25%，**以本地基线为准**——确定性优先。
 *
 * 另提供 9 个预设文风（逐字移植自 `prototype/do-bi/assets/mock.js` 的 stylePresets），
 * 其 `StyleProfile` 由样段跑 `localMetrics` 现算并缓存。
 */

import type { NarrativeStyle, SentenceStats, StyleProfile, StyleRatio } from './types'
import { CJK_RUN_RE, STOPWORDS_2_3, cjkLen, textRatio } from './l1'
import { completeJson, type Message } from './llm'
import { nowIso } from './util'

const SENT_RE = /[^。！？…\n]+[。！？…]?/g

// ==========================================================================
// 本地确定性指标
// ==========================================================================

function sentences(text: string): string[] {
  const out: string[] = []
  for (const m of (text || '').matchAll(SENT_RE)) {
    const s = m[0].trim()
    if (s) out.push(s)
  }
  return out
}

function percentile(values: number[], q: number): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  if (s.length === 1) return s[0]
  const k = (s.length - 1) * q
  const lo = Math.floor(k)
  const hi = Math.ceil(k)
  if (lo === hi) return s[Math.round(k)]
  return s[lo] * (hi - k) + s[hi] * (k - lo)
}

/** 高频 2–4 字短语（步长 1 的 n-gram 计数，排除停用词） */
function phrases(text: string, top = 12): Array<Record<string, unknown>> {
  const counts = new Map<string, number>()
  const raw = text || ''
  for (const n of [2, 3, 4]) {
    for (const m of raw.matchAll(CJK_RUN_RE)) {
      const run = m[0]
      for (let i = 0; i <= run.length - n; i++) {
        const g = run.slice(i, i + n)
        if (STOPWORDS_2_3.has(g)) continue
        counts.set(g, (counts.get(g) ?? 0) + 1)
      }
    }
  }
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || b[0].length - a[0].length,
  )
  return ranked.slice(0, top).map(([phrase, count]) => ({ phrase, count }))
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** 确定性文风指标：句长分布 / 比例 / 人称 / 段长 / 高频短语 */
export function localMetrics(text: string): Record<string, unknown> {
  const raw = text || ''
  const lengths = sentences(raw).map((s) => Math.max(cjkLen(s), 1))
  let sent: Record<string, number>
  if (lengths.length) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length
    sent = {
      mean: round2(mean),
      p50: round2(percentile(lengths, 0.5)),
      p90: round2(percentile(lengths, 0.9)),
      min: Math.min(...lengths),
      max: Math.max(...lengths),
    }
  } else {
    sent = { mean: 0, p50: 0, p90: 0, min: 0, max: 0 }
  }

  const counts = textRatio(raw)
  const total = Object.values(counts).reduce((s, v) => s + v, 0)
  const ratio = total
    ? Object.entries(counts).map(([label, v]) => ({ label, pct: Math.round((v / total) * 100) }))
    : []

  const first = raw.split('我').length - 1
  const third = Math.max(
    raw.split('他').length - 1 + raw.split('她').length - 1 - (raw.split('其他').length - 1),
    0,
  )
  let person = ''
  if (first > third * 1.5 && first >= 2) person = '第一人称'
  else if (third > 0) person = '第三人称限知'

  const paras = raw.split(/\n\s*\n+/).filter((p) => p.trim())
  const plens = paras.map((p) => Math.max(cjkLen(p), 1))
  let pmean = 0
  let pstd = 0
  if (plens.length) {
    pmean = plens.reduce((a, b) => a + b, 0) / plens.length
    pstd = Math.sqrt(plens.reduce((s, x) => s + (x - pmean) ** 2, 0) / plens.length)
  }

  return {
    sentence: sent,
    ratio,
    narrative: { person, tense: '', pov_switch: 'rare' },
    paragraph: { count: paras.length, mean: round2(pmean), std: round2(pstd) },
    phrases: phrases(raw),
  }
}

// ==========================================================================
// 模型分析
// ==========================================================================

/** 模型数字与本地基线偏差 > tol 时以本地为准 */
function pick(local: number, model: unknown, tol = 0.25): number {
  const mv = Number(model)
  if (!Number.isFinite(mv)) return local
  if (mv <= 0) return local
  if (local <= 0) return mv
  if (Math.abs(mv - local) / local > tol) return local
  return mv
}

function extractObj(obj: unknown): Record<string, unknown> {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>
    for (const key of ['profile', 'style', 'data', 'result']) {
      const val = o[key]
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        return val as Record<string, unknown>
      }
    }
    return o
  }
  return {}
}

function buildMessages(sample: string, sourceLabel: string, base: Record<string, unknown>): Message[] {
  const system =
    '你是一位文学风格分析师。下面给你一段参考样本与已算好的**确定性基线指标**，' +
    '请在基线上补充风格判断。\n' +
    '硬性要求：\n' +
    '1. sentence.mean / sentence.p90 若你给出数字，必须与基线接近（偏差不超过 25%），' +
    '不要凭空编造；\n' +
    '2. preferred_patterns 用一句话描述可复用的写法手法（不要罗列具体句子）；\n' +
    '3. banned_expressions 列出该样本回避的、AI 腔的套话表达；\n' +
    '4. lexicon 是「用词偏好」键值对；\n' +
    '5. narrative 判断人称 / 时态 / 视角切换频率 / 锚点人物。\n' +
    '只输出一个 JSON 对象：{"sentence":{"mean":数值,"p90":数值},' +
    '"narrative":{"person":"","tense":"","pov_switch":"","anchor":""},' +
    '"preferred_patterns":["..."],"banned_expressions":["..."],' +
    '"lexicon":[{"key":"","value":""}],"sample_styled":"一句仿写的样例"}。' +
    '不要输出解释文字、不要 Markdown 代码块围栏。'

  const user = [
    `# 参考样本来源：${sourceLabel}`,
    '## 确定性基线指标（以这些为准）',
    JSON.stringify(base, null, 2),
    '## 参考样本正文',
    sample,
  ]
  return [
    { role: 'system', content: system },
    { role: 'user', content: user.join('\n') },
  ]
}

/** 分析参考样本，返回 (文风档案, 消耗 token 数) */
export async function analyzeStyle(
  sample: string,
  sourceLabel: string,
): Promise<{ profile: StyleProfile; tokens: number }> {
  const base = localMetrics(sample)
  const { data, result } = await completeJson('style_analyze', buildMessages(sample, sourceLabel, base))
  const d = extractObj(data)

  const localSent = base.sentence as Record<string, number>
  const modelSent = (d.sentence ?? {}) as Record<string, unknown>
  const sentence: SentenceStats = {
    mean: pick(localSent.mean, modelSent.mean),
    p50: localSent.p50,
    p90: pick(localSent.p90, modelSent.p90),
    min: localSent.min,
    max: localSent.max,
    scale: 80,
  }

  const localNar = base.narrative as Record<string, string>
  const modelNar = (d.narrative ?? {}) as Record<string, unknown>
  const narrative: NarrativeStyle = {
    person: String(modelNar.person ?? localNar.person ?? ''),
    tense: String(modelNar.tense ?? localNar.tense ?? ''),
    pov_switch: String(modelNar.pov_switch ?? localNar.pov_switch ?? 'rare'),
    anchor: String(modelNar.anchor ?? ''),
  }

  const ratio: StyleRatio[] = (base.ratio as Array<{ label: string; pct: number }>).map((r) => ({
    label: r.label,
    pct: r.pct,
    color: '#2C4A63',
  }))

  const rawPatterns = d.preferred_patterns
  const patterns = ((Array.isArray(rawPatterns) ? rawPatterns : []) as unknown[])
    .map((x) => String(x))
    .filter((s) => s.trim())
  const rawBanned = d.banned_expressions
  const banned = ((Array.isArray(rawBanned) ? rawBanned : []) as unknown[])
    .map((x) => String(x))
    .filter((s) => s.trim())
  const rawLexicon = d.lexicon
  const lexicon = ((Array.isArray(rawLexicon) ? rawLexicon : []) as unknown[])
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x) => ({ key: String(x.key ?? ''), value: String(x.value ?? '') }))

  const profile: StyleProfile = {
    source: sourceLabel,
    analyzed_at: nowIso(),
    tokens: result.usage.total_tokens ?? 0,
    sentence,
    narrative,
    ratio,
    preferred_patterns: patterns,
    banned_expressions: banned,
    lexicon,
    sample_plain: String(d.sample_plain ?? ''),
    sample_styled: String(d.sample_styled ?? ''),
  }
  return { profile, tokens: result.usage.total_tokens ?? 0 }
}

// ==========================================================================
// 预设（逐字移植 mock.js 的 stylePresets）
// ==========================================================================

/** 预设种子：id/name/tagline/sample/category 五要素（与 mock.js 逐字一致） */
export const PRESET_SEEDS: Array<{ id: string; name: string; tagline: string; category: string; sample: string }> = [
  { id: 'sp_lean', name: '冷峻纪实', tagline: '短句、实感，动作压过内心独白',
    category: '通用',
    sample: '雪停了。他把刀插回鞘里，手指冻得发僵。远处有火光，不大，像是有人在烧什么东西。他没有立刻过去。他先数了数地上的脚印——四双，两进两出。' },
  { id: 'sp_lyrical', name: '长句绵密', tagline: '长句层叠，感官累积，神话式语调',
    category: '通用',
    sample: '雪是后半夜落下来的，一层一层盖住关外的车辙，像是有人执意要把什么痕迹重新抹平，而风偏偏不肯，一遍遍把新雪掀开，露出底下那些不肯安分的旧印子。' },
  { id: 'sp_voice', name: '声腔叙述', tagline: '叙述者有自己的脉搏，冷幽默压着苦事',
    category: '通用',
    sample: '我在关城做了七年小吏，最大的本事是知道什么时候该看不见。这天晚上我看见了不该看的，还得假装没看见——这活儿我熟。' },
  { id: 'sp_mystery', name: '古风悬疑', tagline: '克制的冷笔，线索藏进器物细节',
    category: '悬疑',
    sample: '灯是旧的。柄上有一道缺口，缺口里积着黑垢。他盯着那道缺口，许久没有动。' },
  { id: 'sp_zhiguai', name: '志怪笔记', tagline: '笔记体，志异而不惊怪',
    category: '志怪',
    sample: '北人言铜灯者，多不实。余亲见其一，灯不燃而芯自明，持之者三日内必失一亲。不知其理，记之待考。' },
  { id: 'sp_wuxia', name: '武侠硬派', tagline: '刀法写实，招招见骨，少用虚词',
    category: '武侠',
    sample: '刀从下往上。他没有格，只侧了半步，刀锋擦着肋过去，割开了棉袄。对手收刀时手腕一沉——这是沉境的毛病，改不掉。' },
  { id: 'sp_urban', name: '都市冷感', tagline: '白描都市，情绪藏在动作里',
    category: '都市',
    sample: '地铁到站，他没下。对面的人换了三拨，他还在看那份文件。第十七页的数字他背了下来，但他还是再看了一遍，因为他不信自己。' },
  { id: 'sp_epic', name: '玄幻史诗', tagline: '宏大修辞，力量体系明确，节奏外放',
    category: '玄幻',
    sample: '那一剑落下时，整座雁回关的雪都停了半息。不是风止，是天地先听懂了这一剑的分量，才敢继续落雪。' },
  { id: 'sp_extracted', name: '寒江独钓 · 从样本提取',
    tagline: '本书当前文风（提取自参考样本前 8 章）',
    category: '我的',
    sample: '退隐的刀客在江边钓了十年鱼。第十一年，那把刀顺流而下，自己漂了回来。他看了很久，然后把它捡起来，插回腰上，没说话。' },
]

const presetProfileCache = new Map<string, StyleProfile>()

type PresetSeed = { id: string; name: string; tagline: string; category: string; sample: string }

function profileFromSample(seed: PresetSeed): StyleProfile {
  const base = localMetrics(seed.sample)
  const s = base.sentence as Record<string, number>
  const nar = base.narrative as Record<string, string>
  return {
    source: `预设 · ${seed.name}`,
    analyzed_at: nowIso(),
    tokens: 0,
    sentence: { mean: s.mean, p50: s.p50, p90: s.p90, min: s.min, max: s.max, scale: 80 },
    narrative: { person: nar.person, tense: nar.tense, pov_switch: nar.pov_switch, anchor: '' },
    ratio: (base.ratio as Array<{ label: string; pct: number }>).map((r) => ({
      label: r.label,
      pct: r.pct,
      color: '#2C4A63',
    })),
    preferred_patterns: [seed.tagline],
    banned_expressions: [],
    lexicon: [],
    sample_plain: '',
    sample_styled: '',
  }
}

/** 9 个预设文风（id/name/tagline/sample/category + 完整 StyleProfile） */
export function presets(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const seed of PRESET_SEEDS) {
    const pid = seed.id
    let profile = presetProfileCache.get(pid)
    if (!profile) {
      profile = profileFromSample(seed)
      presetProfileCache.set(pid, profile)
    }
    out.push({
      id: pid,
      name: seed.name,
      tagline: seed.tagline,
      sample: seed.sample,
      category: seed.category,
      profile,
    })
  }
  return out
}

export function presetProfile(presetId: string): StyleProfile | null {
  for (const seed of PRESET_SEEDS) {
    if (seed.id === presetId) {
      let profile = presetProfileCache.get(presetId)
      if (!profile) {
        profile = profileFromSample(seed)
        presetProfileCache.set(presetId, profile)
      }
      return profile
    }
  }
  return null
}

// ==========================================================================
// 合并
// ==========================================================================

const BASE_WEIGHT = 0.6

/** 数值加权平均：base 权重 0.6。任一侧为 0 时直接取另一侧 */
function blend(base: number, inc: number, w = BASE_WEIGHT): number {
  if (!inc) return base
  if (!base) return inc
  return Math.round((base * w + inc * (1 - w)) * 10000) / 10000
}

function dedup(seq: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of seq) {
    if (x && !seen.has(x)) {
      seen.add(x)
      out.push(x)
    }
  }
  return out
}

/** 与当前档案合并：禁用词取并集，数值取加权平均（base 权重 0.6） */
export function mergeProfile(base: StyleProfile, incoming: StyleProfile): StyleProfile {
  const bs = base.sentence
  const iss = incoming.sentence
  const minPos = [bs.min, iss.min].filter((x) => x > 0)
  const sentence: SentenceStats = {
    mean: blend(bs.mean, iss.mean),
    p50: blend(bs.p50, iss.p50),
    p90: blend(bs.p90, iss.p90),
    // min/max 是极值，取更极的一端比加权平均更符合语义
    min: minPos.length ? Math.min(...minPos) : 0,
    max: Math.max(bs.max, iss.max),
    scale: bs.scale || iss.scale || 80,
  }

  const ratioMap = new Map<string, StyleRatio>(base.ratio.map((r) => [r.label, r]))
  for (const r of incoming.ratio) {
    const old = ratioMap.get(r.label)
    if (old) {
      ratioMap.set(r.label, {
        label: r.label,
        pct: Math.round(blend(old.pct, r.pct)),
        color: old.color || r.color,
      })
    } else {
      ratioMap.set(r.label, r)
    }
  }
  const ratio = [...ratioMap.values()]

  const narrative: NarrativeStyle = {
    person: base.narrative.person || incoming.narrative.person,
    tense: base.narrative.tense || incoming.narrative.tense,
    pov_switch: base.narrative.pov_switch || incoming.narrative.pov_switch,
    anchor: base.narrative.anchor || incoming.narrative.anchor,
  }

  const lexicon: Array<{ key: string; value: string }> = [...base.lexicon]
  const have = new Set(lexicon.map((x) => x.key))
  for (const x of incoming.lexicon) {
    if (!have.has(x.key)) {
      lexicon.push(x)
      have.add(x.key)
    }
  }

  const sources = [base.source, incoming.source].filter(Boolean)
  return {
    source: [...new Set(sources)].join(' + '),
    analyzed_at: nowIso(),
    tokens: (base.tokens || 0) + (incoming.tokens || 0),
    sentence,
    narrative,
    ratio,
    preferred_patterns: dedup([...base.preferred_patterns, ...incoming.preferred_patterns]),
    banned_expressions: dedup([...base.banned_expressions, ...incoming.banned_expressions]),
    lexicon,
    sample_plain: base.sample_plain || incoming.sample_plain,
    sample_styled: base.sample_styled || incoming.sample_styled,
  }
}

// ==========================================================================
// 文风档案工具（镜像 schema.py StyleProfile 的方法）
// ==========================================================================

/** 文风档案是否为空（镜像 schema.py StyleProfile.is_empty） */
export function styleIsEmpty(style: StyleProfile): boolean {
  return !style.source && style.preferred_patterns.length === 0
}

/** 文风档案的确定性必选注入文本（镜像 schema.py StyleProfile.injection_text） */
export function styleInjectionText(style: StyleProfile): string {
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
