/**
 * L1 确定性规则：13 条零模型成本的检查 —— 镜像 `server/dobi/consistency/l1.py`。
 * 全部用正则与规则判定，不调用模型。`checked` 必须返回全量 13 行（含未命中）。
 */

import type { Character, Hook, L1Violation, StyleProfile, WorldRule } from './types'
import { countWords, similarity } from './util'

// ---------------------------------------------------------------------------
// 规则清单（名称与阈值不可改）
// ---------------------------------------------------------------------------

export type RuleSpec = [key: string, rule: string, threshold: number, desc: string]

export const RULES: RuleSpec[] = [
  ['name_mismatch', '称呼／姓名不一致', 1, '正文出现与已登记角色名相似度 ≥0.6 但不完全相等的人名候选（同音／形近异写）'],
  ['deceased_onstage', '角色已死亡仍出场', 1, '本章出场名单中含已标记亡故（deceased 或状态含「亡／死」）的角色'],
  ['immutable_violation', '不可变特征被违背', 1, '角色不可变特征与正文出现的显式相反词冲突（如「不饮酒」却出现「饮酒」）'],
  ['banned_expression', '禁用句式命中', 1, '命中文风档案 banned_expressions 中的禁用表达'],
  ['cliche_density', '套话密度超阈值', 3, '内置套话句式出现次数超过阈值（阈值按每千字 3 次折算）'],
  ['consecutive_particles', '连续「了／的」字句', 2, '段内「了」≥3 或「的」≥4 的段落数（阈值 2 为高发参考线）'],
  ['word_fatigue', '词汇疲劳', 3, '同一 2–3 字词（排除停用词）在章内出现次数 > 阈值'],
  ['paragraph_length', '段落长度异常', 1, '全篇段长过于均匀（标准差 < 均值×0.18），或存在单段 > 均值×4 的超长段'],
  ['pov_switch', '视角切换未标注', 1, '第一人称与第三人称人称代词占比均 ≥15%，或出现全知式旁白启发式信号'],
  ['timeline_order', '时间线倒错', 1, '「次日／第二天」出现在「当夜」之前，或「后来」出现而前文未建立时间跳跃'],
  ['hook_overdue', '伏笔超期未回收', 1, '仍处 planted 且已超过 suggested_resolve_by 的伏笔'],
  ['numeric_conflict', '数值／等级矛盾', 1, '同一量词出现两个不同数值且指向同类事物（数量／距离／年龄／银两等）'],
  ['ratio_deviation', '描写／对话比例偏离', 1, '描写／对话／动作占比与文风档案任一维度偏差 > 15 个百分点'],
]

const RULES_BY_KEY = new Map(RULES.map((r) => [r[0], r]))

const NAME_SIMILARITY = 0.6
const CLICHE_PER_1000 = 3
const WORD_FATIGUE_THRESHOLD = 3
const RATIO_TOLERANCE_PP = 15
const PARA_UNIFORM_RATIO = 0.18
const PARA_OVERLONG_RATIO = 4.0

const DEFAULT_RATIO: Array<[string, number]> = [
  ['描写', 46], ['对话', 31], ['动作', 23],
]

// ---------------------------------------------------------------------------
// 内置词表
// ---------------------------------------------------------------------------

export const CLICHE_PATTERNS: string[] = [
  '心中一凛', '心中一紧', '心下了然', '心头一震', '心中五味杂陈',
  '不由自主地', '不由自主', '下意识地', '下意识', '鬼使神差',
  '空气仿佛凝固', '空气瞬间凝固', '冷汗直流', '如坠冰窟', '毛骨悚然',
  '眼中闪过一丝', '眼中闪过一抹', '哭笑不得', '五味杂陈', '思绪万千',
  '久久不能平静', '莫名地', '不易察觉地', '几不可闻', '说不出地',
  '复杂难言', '令人窒息', '宛如游龙',
]

export const TRAIT_CONFLICTS: Record<string, string[]> = {
  不饮酒: ['饮酒', '喝了', '酒盏', '举杯', '斟酒', '酒碗', '痛饮', '饮下'],
  惧水: ['下水', '涉水', '游泳', '渡河', '凫水', '入水', '游过去'],
  惯用左手: ['右手持', '右手握', '右手拔', '右手按', '右手使'],
  左手使刀: ['右手使刀', '右手持刀', '改用右手'],
  哑: ['开口说', '朗声', '高声说', '开口道', '出声答'],
  常年戴斗笠: ['摘下斗笠', '没戴斗笠', '不戴斗笠'],
  右手缺两指: ['右手拇指', '五指俱全', '右手完好'],
  左脸有灼伤疤: ['右脸有疤', '脸上没有疤', '左脸完好'],
}

const STOPWORDS_RAW = new Set([
  '一个', '一种', '一样', '一直', '一起', '一切', '一些', '一定',
  '没有', '什么', '这个', '那个', '这样', '那样', '这些', '那些',
  '自己', '知道', '已经', '还是', '如果', '因为', '所以', '但是',
  '可是', '然而', '于是', '然后', '起来', '出来', '过来', '下来',
  '上去', '下去', '进来', '出去', '回来', '此时', '此刻', '时候',
  '地方', '东西', '事情', '他们', '她们', '我们', '你们', '人们',
  '不可', '不是', '不能', '不会', '只是', '就是', '便是',
])

// 「仿佛」在 mock 中被判为疲劳词，从停用词中移除，让它可被检出
export const STOPWORDS_2_3 = new Set([...STOPWORDS_RAW].filter((w) => w !== '仿佛'))

const ACTION_VERBS = [
  '走', '跑', '站', '坐', '蹲', '跪', '躺', '拿', '放', '抬', '低',
  '转身', '侧身', '握', '推', '拉', '看', '望', '瞥', '盯', '听',
  '拔', '插', '按', '收', '递', '点头', '摇头', '起身', '退', '迈',
  '挥', '掷', '撞', '掀', '量', '摸', '拍', '敲', '踢', '跨', '挪',
  '靠', '俯', '撑', '抓', '拽', '扯', '挥下', '探', '缩', '折',
]

const TIME_LATE = ['次日', '第二天', '翌日', '隔日']
const TIME_NIGHT = ['当夜', '当晚', '是夜', '入夜', '此夜']
const FLASHBACK_WORDS = [
  '三日前', '三日后', '十年前', '二十年前', '十二年前',
  '年前', '此前', '当年', '幼年', '多年前', '早年',
]

const QUANTIFIERS = '个名人只匹辆尺丈里岁枚块条间座盏斤把枝卷页份道层次步'
const NUM_CLASS = '零一二三四五六七八九十百千万两0-9'
const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

export interface L1Input {
  text: string
  chapter: number
  characters: Character[]
  hooks: Hook[]
  world_rules: WorldRule[]
  style: StyleProfile | null
  characters_present?: string[]
}

export interface L1Result {
  violations: L1Violation[]
  checked: Array<Record<string, unknown>>
}

interface Outcome {
  violations: L1Violation[]
  count: number
  hitLabel: string
  samples: string[]
  hit: boolean
}

function emptyOutcome(): Outcome {
  return { violations: [], count: 0, hitLabel: '', samples: [], hit: false }
}

function mk(key: string, hit: string, count: number, samples?: string[]): L1Violation {
  const [, name, threshold] = RULES_BY_KEY.get(key)!
  return { rule: name, hit, count, threshold, samples: samples ?? [] }
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

const PARA_RE = /\n\s*\n+/
const SENT_RE = /[^。！？…\n]+[。！？…]?/
const DIALOG_RE = /[「『“"]([^」』”"]*)[」』”"]/
export const CJK_RUN_RE = /[\u4e00-\u9fff]+/g

function paragraphs(text: string): string[] {
  return (text || '').split(PARA_RE).map((p) => p.trim()).filter(Boolean)
}

function sentences(text: string): string[] {
  const out: string[] = []
  for (const m of (text || '').matchAll(SENT_RE)) {
    const s = m[0].trim()
    if (s) out.push(s)
  }
  return out
}

export function cjkLen(text: string): number {
  return (text || '').match(CJK_RUN_RE)?.reduce((s, r) => s + r.length, 0) ?? 0
}

export function textRatio(text: string): Record<string, number> {
  const raw = text || ''
  let dialogue = 0
  for (const m of raw.matchAll(DIALOG_RE)) dialogue += m[1].length
  const rest = raw.replace(DIALOG_RE, '')
  let action = 0
  let desc = 0
  for (const sent of sentences(rest)) {
    const n = cjkLen(sent) || sent.length
    if (ACTION_VERBS.some((v) => sent.includes(v))) action += n
    else desc += n
  }
  return { 描写: desc, 对话: dialogue, 动作: action }
}

function pctOf(counts: Record<string, number>): Record<string, number> {
  const total = Object.values(counts).reduce((s, v) => s + v, 0)
  if (total <= 0) {
    return Object.fromEntries(Object.keys(counts).map((k) => [k, 0]))
  }
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, (v / total) * 100]))
}

// ---- 1. 称呼／姓名不一致 -------------------------------------------------
const QUOTE_CAND_RE = /[「『"]([\u4e00-\u9fff]{2,4})/g
const SUFFIX_CAND_RE = /([\u4e00-\u9fff]{2,4})(?=[说道问答喊叫冷笑怒喝应声])/g

function nameCandidates(text: string): string[] {
  const found: string[] = []
  for (const m of (text || '').matchAll(QUOTE_CAND_RE)) {
    if (m[1].length >= 2 && m[1].length <= 4) found.push(m[1])
  }
  for (const m of (text || '').matchAll(SUFFIX_CAND_RE)) {
    if (m[1].length >= 2 && m[1].length <= 4) found.push(m[1])
  }
  return found
}

function rNameMismatch(d: L1Input): Outcome {
  const names = new Set<string>()
  for (const c of d.characters) {
    for (const n of [c.name, ...c.aliases]) if (n) names.add(n)
  }
  if (!names.size) return emptyOutcome()
  const seen = new Set<string>()
  const hits: Array<[string, string, number]> = []
  for (const cand of nameCandidates(d.text)) {
    if (seen.has(cand) || names.has(cand)) continue
    seen.add(cand)
    if ([...names].some((reg) => cand.includes(reg))) continue
    for (const reg of names) {
      if (Math.abs(cand.length - reg.length) > 1) continue
      const r = similarity(cand, reg)
      if (r >= NAME_SIMILARITY) {
        hits.push([cand, reg, r])
        break
      }
    }
  }
  if (!hits.length) return emptyOutcome()
  const vs = hits.map(([cand, reg, r]) =>
    mk('name_mismatch', `${cand}（疑为「${reg}」）`, 1, [`${cand}≈${reg}(${r.toFixed(2)})`]))
  return {
    violations: vs, count: hits.length, hitLabel: vs[0].hit,
    samples: hits.map(([c, g]) => `${c}≈${g}`), hit: true,
  }
}

// ---- 2. 角色已死亡仍出场 -------------------------------------------------
function resolveChar(d: L1Input, key: string): Character | null {
  return (
    d.characters.find((c) => c.id === key || c.name === key || c.aliases.includes(key)) ?? null
  )
}

function rDeceasedOnstage(d: L1Input): Outcome {
  const vs: L1Violation[] = []
  const samples: string[] = []
  for (const name of d.characters_present ?? []) {
    const c = resolveChar(d, name)
    if (!c) continue
    const status = c.state.status
    const dead = c.deceased || status.includes('亡') || status.includes('死') || status.includes('殁')
    if (dead) {
      const reason = c.deceased ? '已标记亡故' : `状态为「${status}」`
      vs.push(mk('deceased_onstage', c.name, 1, [`${c.name}：${reason}`]))
      samples.push(`${c.name}（${reason}）`)
    }
  }
  return {
    violations: vs, count: vs.length,
    hitLabel: vs.length ? vs[0].hit : '', samples, hit: vs.length > 0,
  }
}

// ---- 3. 不可变特征被违背 -------------------------------------------------
function rImmutableViolation(d: L1Input): Outcome {
  const vs: L1Violation[] = []
  const samples: string[] = []
  const text = d.text || ''
  for (const c of d.characters) {
    for (const trait of c.immutable_traits) {
      const key = Object.keys(TRAIT_CONFLICTS).find(
        (k) => trait.includes(k) || k.includes(trait),
      )
      if (!key) continue
      if (key === '已故') {
        if (text.includes(c.name)) {
          const hit = `${trait} ←→ ${c.name}仍出场`
          vs.push(mk('immutable_violation', hit, 1, [trait]))
          samples.push(hit)
        }
        continue
      }
      for (const word of TRAIT_CONFLICTS[key]) {
        if (text.includes(word)) {
          const hit = `${trait} ←→ ${word}`
          vs.push(mk('immutable_violation', hit, 1, [trait, word]))
          samples.push(hit)
          break
        }
      }
    }
  }
  return {
    violations: vs, count: vs.length,
    hitLabel: vs.length ? vs[0].hit : '', samples, hit: vs.length > 0,
  }
}

// ---- 4. 禁用句式命中 -----------------------------------------------------
function rBannedExpression(d: L1Input): Outcome {
  const banned = d.style?.banned_expressions ?? []
  const text = d.text || ''
  let total = 0
  const found: string[] = []
  for (const b of banned) {
    if (!b) continue
    const cnt = text.split(b).length - 1
    if (cnt > 0) {
      total += cnt
      found.push(`${b}×${cnt}`)
    }
  }
  if (!found.length) return emptyOutcome()
  const hit = found[0].split('×')[0]
  return {
    violations: [mk('banned_expression', hit, total, found)],
    count: total, hitLabel: hit, samples: found, hit: true,
  }
}

// ---- 5. 套话密度超阈值 ---------------------------------------------------
function rClicheDensity(d: L1Input): Outcome {
  const text = d.text || ''
  const words = Math.max(countWords(text), 1)
  const found: string[] = []
  let occ = 0
  for (const p of CLICHE_PATTERNS) {
    const cnt = text.split(p).length - 1
    if (cnt) {
      occ += cnt
      found.push(`${p}×${cnt}`)
    }
  }
  if (occ === 0) return { ...emptyOutcome(), count: 0 }
  const eff = Math.max(CLICHE_PER_1000, Math.round((CLICHE_PER_1000 * words) / 1000))
  if (occ < eff) return { ...emptyOutcome(), count: occ }
  const hit = found[0].split('×')[0]
  return {
    violations: [mk('cliche_density', hit, occ, found)],
    count: occ, hitLabel: hit, samples: found, hit: true,
  }
}

// ---- 6. 连续「了／的」字句 -----------------------------------------------
function rConsecutiveParticles(d: L1Input): Outcome {
  const paras = paragraphs(d.text)
  const heavy: string[] = []
  paras.forEach((p, i) => {
    const nLe = p.split('了').length - 1
    const nDe = p.split('的').length - 1
    if (nLe >= 3 || nDe >= 4) heavy.push(`第 ${i + 1} 段（了×${nLe}／的×${nDe}）`)
  })
  if (!heavy.length) return { ...emptyOutcome(), count: 0 }
  const hit = heavy[0]
  return {
    violations: [mk('consecutive_particles', hit, heavy.length, heavy)],
    count: heavy.length, hitLabel: hit, samples: heavy, hit: true,
  }
}

// ---- 7. 词汇疲劳 ---------------------------------------------------------
function cnNgrams(text: string, n: number): string[] {
  const out: string[] = []
  for (const m of (text || '').matchAll(CJK_RUN_RE)) {
    const run = m[0]
    for (let i = 0; i <= run.length - n; i++) {
      const g = run.slice(i, i + n)
      if (STOPWORDS_2_3.has(g)) continue
      out.push(g)
    }
  }
  return out
}

function rWordFatigue(d: L1Input): Outcome {
  const counts = new Map<string, number>()
  for (const n of [2, 3]) {
    for (const g of cnNgrams(d.text, n)) counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  const names = new Set<string>()
  for (const c of d.characters) {
    for (const n of [c.name, ...c.aliases]) if (n) names.add(n)
  }
  const filtered = new Map<string, number>()
  for (const [g, c] of counts) {
    if (names.has(g)) continue
    if ([...names].some((name) => name.includes(g))) continue
    filtered.set(g, c)
  }
  const candidates = [...filtered.entries()].filter(([, c]) => c > WORD_FATIGUE_THRESHOLD)
  if (!candidates.length) {
    const top = filtered.size ? Math.max(...filtered.values()) : 0
    return { ...emptyOutcome(), count: top }
  }
  candidates.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
  const picked: Array<[string, number]> = []
  for (const [g, c] of candidates) {
    if (g.length === 2 && candidates.some(([h, hc]) => h.length === 3 && g.length === 2 && h.includes(g) && hc >= c)) {
      continue
    }
    picked.push([g, c])
  }
  picked.length = Math.min(picked.length, 5)
  const samples = picked.map(([g, c]) => `${g}×${c}`)
  const [topWord, topCnt] = picked[0]
  return {
    violations: [mk('word_fatigue', topWord, topCnt, samples)],
    count: topCnt, hitLabel: topWord, samples, hit: true,
  }
}

// ---- 8. 段落长度异常 -----------------------------------------------------
function rParagraphLength(d: L1Input): Outcome {
  const paras = paragraphs(d.text)
  if (paras.length < 3) return { ...emptyOutcome(), count: 0 }
  const lens = paras.map((p) => Math.max(countWords(p), 1))
  const mean = lens.reduce((s, x) => s + x, 0) / lens.length
  const std = Math.sqrt(lens.reduce((s, x) => s + (x - mean) ** 2, 0) / lens.length)
  const signals: string[] = []
  if (mean > 0 && std < mean * PARA_UNIFORM_RATIO) {
    signals.push(`全篇段长过于均匀（标准差 ${std.toFixed(1)} < 均值 ${mean.toFixed(1)}×0.18）`)
  }
  const overlon = lens.map((L, i) => (L > mean * PARA_OVERLONG_RATIO ? i + 1 : 0)).filter(Boolean)
  if (overlon.length) {
    signals.push('超长段落：' + overlon.map((i) => `第 ${i} 段`).join('、'))
  }
  if (!signals.length) return { ...emptyOutcome(), count: 0 }
  const hit = signals[0]
  return {
    violations: [mk('paragraph_length', hit, signals.length, signals)],
    count: signals.length, hitLabel: hit, samples: signals, hit: true,
  }
}

// ---- 9. 视角切换未标注 ---------------------------------------------------
function rPovSwitch(d: L1Input): Outcome {
  const text = d.text || ''
  const first = text.split('我').length - 1
  const third = Math.max(text.split('他').length - 1 + text.split('她').length - 1 - (text.split('其他').length - 1), 0)
  const total = first + third
  const signals: string[] = []
  if (total >= 5) {
    const rf = first / total
    const rt = third / total
    if (rf >= 0.15 && rt >= 0.15) {
      signals.push(`第一人称 ${Math.round(rf * 100)}% 与第三人称 ${Math.round(rt * 100)}% 并存，视角未注明切换`)
    }
  }
  if ((text.includes('他知道') || text.includes('她知道')) && (text.includes('其实') || text.includes('原来'))) {
    signals.push('出现「他知道…其实…」式的全知旁白，与限知视角冲突')
  }
  if (!signals.length) return { ...emptyOutcome(), count: 0 }
  const hit = signals[0]
  return {
    violations: [mk('pov_switch', hit, signals.length, signals)],
    count: signals.length, hitLabel: hit, samples: signals, hit: true,
  }
}

// ---- 10. 时间线倒错 ------------------------------------------------------
function firstIndex(text: string, words: string[]): [number, string] {
  let best = -1
  let bestW = ''
  for (const w of words) {
    const i = text.indexOf(w)
    if (i !== -1 && (best === -1 || i < best)) {
      best = i
      bestW = w
    }
  }
  return [best, bestW]
}

function rTimelineOrder(d: L1Input): Outcome {
  const text = d.text || ''
  const signals: string[] = []
  const [lateI, lateW] = firstIndex(text, TIME_LATE)
  const [nightI, nightW] = firstIndex(text, TIME_NIGHT)
  if (lateI !== -1 && nightI !== -1 && lateI < nightI) {
    signals.push(`「${lateW}」出现在「${nightW}」之前，时间线倒错`)
  }
  for (const p of paragraphs(text)) {
    if (p.startsWith('后来')) {
      const idx = text.indexOf(p)
      const prefix = idx !== -1 ? text.slice(0, idx) : ''
      if (!FLASHBACK_WORDS.some((f) => prefix.includes(f))) {
        signals.push('「后来」出现在段首，但前文未见时间跳跃的锚点')
        break
      }
    }
  }
  if (!signals.length) return { ...emptyOutcome(), count: 0 }
  const hit = signals[0]
  return {
    violations: [mk('timeline_order', hit, signals.length, signals)],
    count: signals.length, hitLabel: hit, samples: signals, hit: true,
  }
}

// ---- 11. 伏笔超期未回收 --------------------------------------------------
function rHookOverdue(d: L1Input): Outcome {
  const vs: L1Violation[] = []
  const samples: string[] = []
  for (const h of d.hooks) {
    const overdue =
      h.status === 'planted' && h.suggested_resolve_by != null && d.chapter > h.suggested_resolve_by
    if (overdue) {
      const summary = (h.content || '').slice(0, 18)
      const hit = `${h.id}：${summary}`
      vs.push(mk('hook_overdue', hit, 1, [
        `${h.id} 建议第 ${h.suggested_resolve_by} 章前回收，当前第 ${d.chapter} 章仍悬置`,
      ]))
      samples.push(hit)
    }
  }
  return {
    violations: vs, count: vs.length,
    hitLabel: vs.length ? vs[0].hit : '', samples, hit: vs.length > 0,
  }
}

// ---- 12. 数值／等级矛盾 --------------------------------------------------
const NUM_Q_RE = new RegExp(`([${NUM_CLASS}]{1,6})([${QUANTIFIERS}])`, 'g')
const TAEL_RE = new RegExp(`([${NUM_CLASS.replace('两', '')}]{1,6})两`, 'g')

function cnToInt(token: string): number | null {
  if (!token) return null
  if (/^\d+$/.test(token)) return parseInt(token, 10)
  let total = 0
  let number = 0
  for (const ch of token) {
    if (ch in CN_DIGITS) number = CN_DIGITS[ch]
    else if (ch in CN_UNITS) {
      total += (number || 1) * CN_UNITS[ch]
      number = 0
    } else return null
  }
  return total + number
}

function rNumericConflict(d: L1Input): Outcome {
  const text = d.text || ''
  const groups = new Map<string, Set<number>>()
  const raw = new Map<string, Set<string>>()
  for (const m of text.matchAll(NUM_Q_RE)) {
    const v = cnToInt(m[1])
    if (v === null || v === 0) continue
    if (!groups.has(m[2])) groups.set(m[2], new Set())
    groups.get(m[2])!.add(v)
    if (!raw.has(m[2])) raw.set(m[2], new Set())
    raw.get(m[2])!.add(m[1])
  }
  for (const m of text.matchAll(TAEL_RE)) {
    const v = cnToInt(m[1])
    if (v === null || v === 0) continue
    if (!groups.has('两')) groups.set('两', new Set())
    groups.get('两')!.add(v)
    if (!raw.has('两')) raw.set('两', new Set())
    raw.get('两')!.add(m[1])
  }
  const conflicts = [...groups.entries()].filter(([, vs]) => vs.size > 1)
  if (!conflicts.length) return { ...emptyOutcome(), count: 0 }
  const samples = conflicts.map(([q, vs]) => `${q}：${[...vs].sort((a, b) => a - b).join('、')}`)
  const hit = samples[0]
  return {
    violations: [mk('numeric_conflict', hit, conflicts.length, samples)],
    count: conflicts.length, hitLabel: hit, samples, hit: true,
  }
}

// ---- 13. 描写／对话比例偏离 ----------------------------------------------
function rRatioDeviation(d: L1Input): Outcome {
  const counts = textRatio(d.text)
  if (Object.values(counts).reduce((s, v) => s + v, 0) < 30) return { ...emptyOutcome(), count: 0 }
  const actual = pctOf(counts)
  let expected = new Map<string, number>()
  if (d.style?.ratio?.length) {
    expected = new Map(d.style.ratio.map((r) => [r.label, r.pct]))
  } else {
    expected = new Map(DEFAULT_RATIO)
  }
  const devs: string[] = []
  for (const [label, exp] of expected) {
    const act = actual[label]
    if (act === undefined) continue
    const diff = Math.abs(act - exp)
    if (diff > RATIO_TOLERANCE_PP) {
      devs.push(`${label}：实际 ${Math.round(act)}% vs 档案 ${exp}%（偏差 ${Math.round(diff)} 个百分点）`)
    }
  }
  if (!devs.length) return { ...emptyOutcome(), count: 0 }
  const hit = devs[0]
  return {
    violations: [mk('ratio_deviation', hit, devs.length, devs)],
    count: devs.length, hitLabel: hit, samples: devs, hit: true,
  }
}

const IMPL: Record<string, (d: L1Input) => Outcome> = {
  name_mismatch: rNameMismatch,
  deceased_onstage: rDeceasedOnstage,
  immutable_violation: rImmutableViolation,
  banned_expression: rBannedExpression,
  cliche_density: rClicheDensity,
  consecutive_particles: rConsecutiveParticles,
  word_fatigue: rWordFatigue,
  paragraph_length: rParagraphLength,
  pov_switch: rPovSwitch,
  timeline_order: rTimelineOrder,
  hook_overdue: rHookOverdue,
  numeric_conflict: rNumericConflict,
  ratio_deviation: rRatioDeviation,
}

export function checkL1(data: L1Input): L1Result {
  const violations: L1Violation[] = []
  const checked: Array<Record<string, unknown>> = []
  for (const [key, name, threshold] of RULES) {
    let outcome: Outcome
    try {
      outcome = IMPL[key](data)
    } catch {
      outcome = emptyOutcome()
    }
    violations.push(...outcome.violations)
    checked.push({
      rule: name,
      hit: outcome.hit ? outcome.hitLabel : '',
      count: outcome.count,
      threshold,
      isHit: outcome.hit,
    })
  }
  return { violations, checked }
}

export function ruleCatalog(): Array<Record<string, unknown>> {
  return RULES.map(([key, rule, threshold, describe]) => ({
    key, rule, threshold, describe,
  }))
}
