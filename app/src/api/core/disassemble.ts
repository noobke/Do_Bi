/**
 * 拆书 —— 镜像 `server/dobi/ingest/disassemble.py`。
 *
 * 导入已有小说 → 反推结构 → 产出**提案**。六个阶段（切分章节 / 抽取角色与关系 /
 * 抽取世界观规则 / 抽取伏笔与回收 / 生成文风档案 / 生成写入提案）跑完后，得到一批
 * 提案，逐个过 `TruthWriter.validate()`，有 error 的降级为待人工确认；**这一步不 commit**，
 * 只把完整结果落盘（原版 `state/disassemble.json`，本地版存 localStorage）。
 * 前端逐条 `decide()`，`accept` 才经 `TruthWriter.commit()` 写入真相文件。
 *
 * 阶段 1「切分章节」是**确定性**的，不调模型；其余阶段各调用一次模型。
 */

import { Agent, Usage } from './agents/base'
import { fmt } from './agents/architect'
import { completeJson } from './llm'
import { analyzeStyle } from './style'
import { TruthWriter } from './truthwriter'
import type { Character, Hook, Proposal, Relation, StyleProfile, WorldRule } from './types'
import type { ProjectStore } from './store'
import { countWords, nowIso } from './util'

export const STATE_FILENAME = 'disassemble.json'

/** 六个阶段（key / 中文标题），顺序即执行顺序 */
export const STAGE_TITLES: Array<[string, string]> = [
  ['split', '切分章节'],
  ['roles', '抽取角色与关系'],
  ['world', '抽取世界观规则'],
  ['hooks', '抽取伏笔与回收'],
  ['style', '生成文风档案'],
  ['merge', '生成写入提案'],
]

/** 内部提案类型 → 给 UI 看的中文分类（与 mock.js 的 proposals[].kind 对齐） */
export const KIND_LABELS: Record<string, string> = {
  character_add: '角色',
  world_add: '世界观',
  hook_add: '伏笔',
  style_update: '文风',
}

/** 超过这个字数就抽样，避免一次把整本塞进模型 */
const SAMPLE_THRESHOLD_WORDS = 60_000

// ==========================================================================
// 阶段 1：确定性切分章节
// ==========================================================================

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 }

const RE_ZH_CHAPTER = /^第\s*([0-9]+|[〇零一二两三四五六七八九十百千万]+)\s*([章回节卷])\s*(.*)$/
const RE_EN_CHAPTER = /^chapter\s+([0-9]+)\b\s*(.*)$/i
const RE_NUM_DOT = /^([0-9]+)\s*[.、,，]\s*(.*)$/
const RE_CN_DOT = /^([〇零一二两三四五六七八九十百]+)\s*[、.．]\s*(.*)$/

/** 标题行长度上限——超过则更像正文段落，不作为标题（防误判） */
const MAX_TITLE_LEN = 40

/** 中文数字 / 阿拉伯数字 → int。识别失败返回 null。 */
function cnToInt(token: string): number | null {
  const s = (token || '').trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  let total = 0
  let section = 0
  let number = 0
  let found = false
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch]
      found = true
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch]
      found = true
      if (unit === 10000) {
        section = (section + number) * unit
        total += section
        section = 0
      } else {
        if (number === 0) number = 1
        section += number * unit
      }
      number = 0
    } else {
      return null
    }
  }
  if (!found) return null
  return total + section + number
}

/** 判断一行是否是章节标题。命中返回 [章号候选, 标题文本]，否则 null。 */
function matchHeading(line: string): [number | null, string] | null {
  const s = (line || '').trim()
  if (!s || s.length > MAX_TITLE_LEN) return null
  let m = RE_ZH_CHAPTER.exec(s)
  if (m) {
    const title = m[3].trim()
    return [cnToInt(m[1]), title || s]
  }
  m = RE_EN_CHAPTER.exec(s)
  if (m) {
    const title = m[2].trim()
    return [cnToInt(m[1]), title || s]
  }
  m = RE_NUM_DOT.exec(s)
  if (m) {
    const title = m[2].trim()
    // 纯编号（如页码「12.」）不算标题，必须带标题文字
    if (title) return [cnToInt(m[1]), title]
  }
  m = RE_CN_DOT.exec(s)
  if (m) {
    const title = m[2].trim()
    if (title) return [cnToInt(m[1]), title]
  }
  return null
}

/** 识别不到标题时的兜底：按空行块切分，再按固定长度归并成章。 */
function fallbackChapters(text: string, target = 3000): Chapter[] {
  let blocks = (text || '')
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!blocks.length) blocks = (text || '').trim() ? [text.trim()] : []
  const units: string[] = []
  for (const b of blocks) {
    if (b.length <= target) units.push(b)
    else for (let i = 0; i < b.length; i += target) units.push(b.slice(i, i + target))
  }
  const chapters: string[][] = []
  let buf: string[] = []
  let size = 0
  for (const u of units) {
    buf.push(u)
    size += u.length
    if (size >= target) {
      chapters.push(buf)
      buf = []
      size = 0
    }
  }
  if (buf.length) chapters.push(buf)
  return chapters.map((c, i) => ({ n: i + 1, title: `第 ${i + 1} 段`, text: c.join('\n\n') }))
}

export interface Chapter {
  n: number
  title: string
  text: string
}

/**
 * **确定性**切分章节（不调模型）。返回 `[{n, title, text}]`。
 *
 * 覆盖的标题形式：`第N章/回/节/卷`、`Chapter N`、行首 `12. 标题`、行首 `十二、标题`。
 * 识别不到标题时，按空行块 + 固定长度兜底切分。
 */
export function splitChapters(text: string): Chapter[] {
  const lines = (text || '').split(/\r?\n/)
  const marks: Array<[number, number | null, string]> = []
  lines.forEach((raw, i) => {
    const hit = matchHeading(raw)
    if (hit !== null) marks.push([i, hit[0], hit[1]])
  })

  if (!marks.length) return fallbackChapters(text)

  const out: Chapter[] = []
  marks.forEach(([idx, num, title], j) => {
    const start = idx + 1
    const end = j + 1 < marks.length ? marks[j + 1][0] : lines.length
    const body = lines.slice(start, end).join('\n').trim()
    out.push({ n: num ?? 0, title, text: body })
  })

  // 章号规整：用解析到的章号；缺失或非递增时回退为「上一章 + 1」，保证连续唯一
  let prev = 0
  for (const ch of out) {
    let cand = ch.n
    if (!Number.isInteger(cand) || cand <= prev) cand = prev + 1
    ch.n = cand
    prev = cand
  }
  return out
}

// ==========================================================================
// 提示词（放在本模块，不改 agents/prompts.ts）
// ==========================================================================

const ROLES_PROMPT = `你是一位小说结构分析师。任务：从下面这部**已有小说**的样本中，反向抽取**角色与人物关系**。

【作品】{source}
【样本说明】{sample_note}

【样本正文】
{sample}

【要求】
1. 只抽取**具名**角色（有名字、或反复被指称的实体），宁精不滥。
2. \`traits\` 必须是**可判定的特征**——身体特征、惯用习惯、禁忌
   （如「左手使刀」「不饮酒」「左眉骨有旧疤」）。
   **禁止**写「性格坚毅」「为人正直」这类无法检验的评价。
3. \`relations\` 写该角色与其他角色的关系：\`target\` 填**姓名**，
   \`type\` 写关系类型，\`note\` 写一句来自样本的依据。
4. \`merges\` 用于归并**同一人的不同称呼**（简称、绰号、尊称）：
   \`canonical\` 写正式名，\`aliases\` 写其余称呼。
5. 只抽取样本中**真实出现**的信息，不要脑补。

【输出格式】只输出 JSON，不要解释、不要 Markdown 围栏：
{{"characters": [{{"name": "姓名", "role": "主角/女主/配角/反派等", "traits": ["可判定特征"],
  "relations": [{{"target": "另一角色姓名", "type": "关系类型", "note": "依据"}}]}}],
 "merges": [{{"canonical": "正式名", "aliases": ["别称1", "别称2"]}}]}}`

const WORLD_PROMPT = `你是一位小说设定师。任务：从下面这部**已有小说**的样本中，反向抽取**世界观规则**。

【作品】{source}
【样本说明】{sample_note}

【样本正文】
{sample}

【要求】
1. 只抽取样本中**能被检验**的规则（违反了能在后文被发现），不要写抽象氛围。
2. \`kind\` 只能取 \`hard\`（不可违反的硬约束）或 \`soft\`（可被正文反推改写的软设定）。
3. \`category\` 建议取值：器物 / 体系 / 地理 / 组织 / 历史 / 风俗。
4. 每条给一句 \`note\` 注明依据（来自样本的哪处）。

【输出格式】只输出 JSON，不要解释、不要围栏：
{{"rules": [{{"category": "", "kind": "hard", "rule": "规则正文", "note": "依据"}}]}}`

const HOOKS_PROMPT = `你是一位小说结构分析师。任务：从下面这部**已有小说**的样本中，反向抽取**伏笔（埋设）与回收点**。

【作品】{source}
【章号对照】样本涉及的真实章号：{chapter_index}
【样本说明】{sample_note}

【样本正文】
{sample}

【要求】
1. \`content\` 写伏笔内容——刻意的、有回收价值的线索。
2. \`planted_chapter\` / \`resolved_chapter\` 必须填**真实章号**（对照上面的章号）。
   后续找不到回收点的，\`resolved_chapter\` 填 \`null\`。
3. \`importance\` 取 \`major\` / \`minor\`。
4. \`evidence\` 引一句样本中的**原文**作为依据。

【输出格式】只输出 JSON，不要解释、不要围栏：
{{"hooks": [{{"content": "", "planted_chapter": 1, "resolved_chapter": null,
  "importance": "major", "evidence": "原文引用"}}]}}`

// ==========================================================================
// 数据容器
// ==========================================================================

export interface DisassembleSource {
  name: string
  chapters: number
  words: number
  format: string
  size: string
}

export class DisassembleResult {
  source: DisassembleSource
  stages: Array<Record<string, unknown>>
  stats: Record<string, unknown>
  extracted: Record<string, unknown>
  proposals: Array<Record<string, unknown>>
  usage: Usage
  style_profile: StyleProfile | null

  constructor(init: {
    source: DisassembleSource
    stages: Array<Record<string, unknown>>
    stats: Record<string, unknown>
    extracted: Record<string, unknown>
    proposals: Array<Record<string, unknown>>
    usage: Usage
    style_profile?: StyleProfile | null
  }) {
    this.source = init.source
    this.stages = init.stages
    this.stats = init.stats
    this.extracted = init.extracted
    this.proposals = init.proposals
    this.usage = init.usage
    this.style_profile = init.style_profile ?? null
  }

  public(): Record<string, unknown> {
    return {
      source: { ...this.source },
      stages: this.stages,
      stats: this.stats,
      extracted: this.extracted,
      proposals: this.proposals,
      usage: this.usage.public(),
    }
  }
}

// ==========================================================================
// 工具
// ==========================================================================

function humanSize(nbytes: number): string {
  if (nbytes < 1024) return `${nbytes} B`
  if (nbytes < 1024 * 1024) return `${(nbytes / 1024).toFixed(0)} KB`
  return `${(nbytes / (1024 * 1024)).toFixed(1)} MB`
}

function stateKey(store: ProjectStore): string {
  return `dobi.disassemble.${store.id}`
}

/** 读取上次的拆书结果（含 source/stages/stats/extracted/proposals/decisions）。 */
export function load(store: ProjectStore): Record<string, unknown> | null {
  try {
    const raw = window.localStorage.getItem(stateKey(store))
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function saveState(store: ProjectStore, state: Record<string, unknown>): void {
  try {
    window.localStorage.setItem(stateKey(store), JSON.stringify(state))
  } catch {
    /* 存储不可用时仅内存态 */
  }
}

/** 按字数决定是否抽样。返回 [样本正文, 是否抽样, 被抽中的章节]。 */
function sampleText(chapters: Chapter[], ratio: number): [string, boolean, Chapter[]] {
  const fullWords = countWords(chapters.map((ch) => ch.text).join('\n'))
  const render = (list: Chapter[]): string =>
    list.map((ch) => `第${ch.n}章 ${ch.title}\n${ch.text}`).join('\n\n')
  if (fullWords <= SAMPLE_THRESHOLD_WORDS) return [render(chapters), false, chapters]

  const k = Math.max(1, Math.round(2 * Math.max(0.1, ratio)))
  const n = chapters.length
  let picked: Chapter[]
  if (n <= k * 3) {
    picked = [...chapters]
  } else {
    const head = chapters.slice(0, k)
    const midStart = Math.max(0, Math.floor(n / 2) - Math.floor(k / 2))
    const mid = chapters.slice(midStart, midStart + k)
    const tail = chapters.slice(-k)
    const seen = new Set<number>()
    picked = []
    for (const ch of [...head, ...mid, ...tail]) {
      if (!seen.has(ch.n)) {
        seen.add(ch.n)
        picked.push(ch)
      }
    }
  }
  return [render(picked), true, picked]
}

function sampleNote(sampled: boolean, picked: Chapter[]): string {
  if (!sampled) return '全书正文（未抽样）。'
  return (
    `正文超过 6 万字，此处按「前 2 章 + 中间 2 章 + 最后 2 章」抽样，` +
    `共 ${picked.length} 章作为样本。据此推断时请注意覆盖面有限。`
  )
}

interface MergedChar {
  name: string
  role: string
  traits: string[]
  relations: Array<{ target: string; type: string; note: string }>
  aliases: string[]
}

/** 归并同人异名，得到内部角色列表。 */
function mergeCharacters(rawChars: unknown, merges: unknown): MergedChar[] {
  const aliasMap = new Map<string, string>()
  for (const m of Array.isArray(merges) ? merges : []) {
    if (typeof m !== 'object' || m === null) continue
    const rec = m as Record<string, unknown>
    const canonical = String(rec.canonical ?? '').trim()
    if (!canonical) continue
    for (const a of Array.isArray(rec.aliases) ? rec.aliases : []) {
      const alias = String(a).trim()
      if (alias && alias !== canonical) aliasMap.set(alias, canonical)
    }
  }

  const byName = new Map<string, MergedChar>()
  const order: string[] = []
  for (const raw of Array.isArray(rawChars) ? rawChars : []) {
    if (typeof raw !== 'object' || raw === null) continue
    const rec = raw as Record<string, unknown>
    const name = String(rec.name ?? '').trim()
    if (!name) continue
    const canonical = aliasMap.get(name) ?? name
    const rels: Array<{ target: string; type: string; note: string }> = []
    for (const rel of Array.isArray(rec.relations) ? rec.relations : []) {
      if (typeof rel !== 'object' || rel === null) continue
      const r = rel as Record<string, unknown>
      const target = String(r.target ?? '').trim()
      if (!target) continue
      rels.push({
        target: aliasMap.get(target) ?? target,
        type: String(r.type ?? '关联'),
        note: String(r.note ?? ''),
      })
    }
    const traits = (Array.isArray(rec.traits) ? rec.traits : [])
      .map((t) => String(t).trim())
      .filter(Boolean)
    const aliases = [...new Set([name, ...[...aliasMap.entries()].filter(([, c]) => c === canonical).map(([a]) => a)])].sort()
    const existing = byName.get(canonical)
    if (!existing) {
      byName.set(canonical, {
        name: canonical,
        role: String(rec.role ?? '配角'),
        traits,
        relations: rels,
        aliases: aliases.filter((a) => a !== canonical),
      })
      order.push(canonical)
    } else {
      for (const t of traits) if (!existing.traits.includes(t)) existing.traits.push(t)
      existing.relations.push(...rels)
      if (existing.role === '' || existing.role === '配角') {
        existing.role = String(rec.role ?? existing.role)
      }
    }
  }
  return order.map((n) => byName.get(n)!)
}

// ==========================================================================
// Disassembler
// ==========================================================================

export class Disassembler extends Agent {
  /** 一次 `run()` 跑完六个阶段并落盘提案，`decide()` 逐条确认写入。 */
  async run(opts: { filename: string; text: string; sampleRatio?: number }): Promise<DisassembleResult> {
    const { filename, text, sampleRatio = 1.0 } = opts
    const sourceName = filename.split(/[\\/]/).pop() || '未命名样本'
    const dot = sourceName.lastIndexOf('.')
    const fmtExt = dot >= 0 ? sourceName.slice(dot + 1).toLowerCase() : 'txt'
    const rawBytes = new TextEncoder().encode(text || '').length
    this.scope(0, 'disassemble')

    const stages: Array<Record<string, unknown>> = STAGE_TITLES.map(([key, title]) => ({
      key, title, desc: '', status: 'todo',
    }))

    // ---- 1. split（确定性）----
    stages[0].status = 'active'
    const chapters = splitChapters(text || '')
    const hasHeadings = (text || '').split(/\r?\n/).some((line) => matchHeading(line) !== null)
    stages[0].desc = hasHeadings
      ? `按标题与空行推断章节边界，识别 ${chapters.length} 章`
      : `未识别到章节标题，按空行与长度兜底切分为 ${chapters.length} 段`
    stages[0].status = 'done'

    const fullText = chapters.map((ch) => ch.text).join('\n')
    const words = countWords(fullText)
    const [sample, sampled, picked] = sampleText(chapters, sampleRatio)
    const note = sampleNote(sampled, picked)

    // ---- 2. roles ----
    stages[1].status = 'active'
    this.budgetGate()
    const rolesOut = await completeJson('disassemble', [
      { role: 'user', content: fmt(ROLES_PROMPT, { source: sourceName, sample_note: note, sample }) },
    ])
    this.usage.add(rolesOut.result)
    const rolesData = isRecord(rolesOut.data) ? rolesOut.data : {}
    const merges = rolesData.merges
    const characters = mergeCharacters(rolesData.characters, merges)
    stages[1].desc = `识别 ${characters.length} 个具名实体，归并同人异名 ${Array.isArray(merges) ? merges.length : 0} 组`
    stages[1].status = 'done'

    // ---- 3. world ----
    stages[2].status = 'active'
    this.budgetGate()
    const worldOut = await completeJson('disassemble', [
      { role: 'user', content: fmt(WORLD_PROMPT, { source: sourceName, sample_note: note, sample }) },
    ])
    this.usage.add(worldOut.result)
    const worldData = isRecord(worldOut.data) ? worldOut.data : {}
    const rules: Array<{ category: string; kind: 'hard' | 'soft'; rule: string; note: string }> = []
    for (const raw of Array.isArray(worldData.rules) ? worldData.rules : []) {
      if (typeof raw !== 'object' || raw === null) continue
      const rec = raw as Record<string, unknown>
      const ruleText = String(rec.rule ?? '').trim()
      if (!ruleText) continue
      rules.push({
        category: String(rec.category ?? '其他'),
        kind: String(rec.kind) === 'soft' ? 'soft' : 'hard',
        rule: ruleText,
        note: String(rec.note ?? ''),
      })
    }
    stages[2].desc = `提取门派、地理、体系与硬约束 ${rules.length} 条`
    stages[2].status = 'done'

    // ---- 4. hooks ----
    stages[3].status = 'active'
    this.budgetGate()
    const chapterIndex = picked.slice(0, 12).map((p) => `第${p.n}章《${p.title}》`).join('、')
    const hooksOut = await completeJson('disassemble', [
      {
        role: 'user',
        content: fmt(HOOKS_PROMPT, {
          source: sourceName, sample_note: note,
          chapter_index: chapterIndex || '（无）', sample,
        }),
      },
    ])
    this.usage.add(hooksOut.result)
    const hooksData = isRecord(hooksOut.data) ? hooksOut.data : {}
    const totalChapters = chapters.length
    const hooks: Array<Record<string, unknown>> = []
    for (const raw of Array.isArray(hooksData.hooks) ? hooksData.hooks : []) {
      if (typeof raw !== 'object' || raw === null) continue
      const rec = raw as Record<string, unknown>
      const content = String(rec.content ?? '').trim()
      if (!content) continue
      const planted = clampChapter(rec.planted_chapter, totalChapters) ?? 1
      let resolved = clampChapter(rec.resolved_chapter, totalChapters)
      if (resolved !== null && resolved <= planted) resolved = null
      hooks.push({
        content,
        planted_chapter: planted,
        resolved_chapter: resolved,
        importance: String(rec.importance) === 'major' ? 'major' : 'minor',
        evidence: String(rec.evidence ?? ''),
      })
    }
    const matched = hooks.filter((h) => h.resolved_chapter).length
    stages[3].desc = `识别 ${hooks.length} 处埋设点，匹配到 ${matched} 处回收点`
    stages[3].status = 'done'

    // ---- 5. style ----
    stages[4].status = 'active'
    this.budgetGate()
    const { profile, tokens: styleTokens } = await analyzeStyle(sample, `拆书 · ${sourceName}`)
    stages[4].desc = '句长、视角、描写比例与禁用表达'
    stages[4].status = 'done'

    const extractedStyle = readableStyle(profile)

    // ---- 6. merge（生成提案 + 校验，不 commit）----
    stages[5].status = 'active'
    const { summaries, detailed } = this.buildProposals(characters, rules, hooks, profile)
    stages[5].desc = `生成 ${summaries.length} 条写入提案，待你确认后才写入真相文件`
    stages[5].status = 'done'

    const extracted: Record<string, unknown> = {
      characters: characters.map((c) => ({
        name: c.name, role: c.role, traits: c.traits, relations: c.relations.length,
      })),
      hooks: hooks.map((h) => ({
        content: h.content, plantedChapter: h.planted_chapter,
        matched: h.resolved_chapter, importance: h.importance,
      })),
      worldRules: rules.map((r) => r.rule),
      style: extractedStyle,
    }

    const stats: Record<string, unknown> = {
      chapters: chapters.length,
      characters: characters.length,
      worldRules: rules.length,
      hooks: hooks.length,
      hooksMatched: matched,
      // 文风分析只回传 token 数（不是 ChatResult），单独并入总用量
      tokens: this.usage.total_tokens + Math.trunc(styleTokens || 0),
    }

    const source: DisassembleSource = {
      name: sourceName, chapters: chapters.length, words,
      format: fmtExt, size: humanSize(rawBytes),
    }
    const result = new DisassembleResult({
      source, stages, stats, extracted, proposals: summaries,
      usage: this.usage, style_profile: profile,
    })

    const state: Record<string, unknown> = {
      source: { ...source },
      stages,
      stats,
      extracted,
      proposals: detailed,
      decisions: Object.fromEntries(detailed.map((item) => [String(item.id), null])),
      usage: this.usage.public(),
      generatedAt: nowIso(),
    }
    saveState(this.store, state)
    return result
  }

  /** 对单条提案做出决策。`action` ∈ accept / reject / null。 */
  async decide(proposalId: string, action: string): Promise<Record<string, unknown>> {
    const state = load(this.store)
    if (!state) return { ok: false, message: '还没有可确认的拆书结果，请先执行拆书。' }
    const items = (state.proposals as Array<Record<string, unknown>>) ?? []
    const item = items.find((p) => p.id === proposalId)
    if (!item) return { ok: false, message: '找不到这条提案。' }

    if (['null', 'withdraw', '', 'none'].includes(action)) {
      item.decision = null
      this.persist(item, state)
      return { ok: true, id: proposalId, decision: null }
    }
    if (action === 'reject') {
      item.decision = 'ignore'
      this.persist(item, state)
      return { ok: true, id: proposalId, decision: 'ignore' }
    }
    if (action !== 'accept') {
      return { ok: false, message: '不认识的操作，只支持 accept / reject / null。' }
    }

    const proposal: Proposal = {
      id: String(item.id),
      kind: String(item.proposal_kind ?? ''),
      payload: (item.payload as Record<string, unknown>) ?? {},
      reason: String(item.reason ?? ''),
      confidence: (String(item.confidence ?? 'medium') as Proposal['confidence']),
      decision: null,
      target_file: String(item.target_file ?? ''),
    }
    const result = new TruthWriter(this.store).commit([proposal], { force: false })
    const errors = result.issues
      .filter((i) => i.level === 'error' && i.proposal_id === proposal.id)
      .map((i) => i.message)
    if (result.pending.length || errors.length) {
      // 保持 decision=null，等作者处理完冲突再来确认
      item.decision = null
      item.issues = errors
      this.persist(item, state)
      const reason = errors.join('；') || '这条提案还有未解决的冲突。'
      return { ok: false, message: `这条提案未写入：${reason}` }
    }

    item.decision = 'accept'
    item.issues = []
    this.persist(item, state)
    return { ok: true, id: proposalId, decision: 'accept', changedFiles: result.changed_files }
  }

  /** 待确认的提案摘要（decision 仍为 null）。 */
  pending(): Array<Record<string, unknown>> {
    const state = load(this.store) ?? {}
    const items = (state.proposals as Array<Record<string, unknown>>) ?? []
    return items.filter((item) => item.decision == null).map((item) => summaryOf(item))
  }

  // ---------------- 内部 ----------------

  private persist(item: Record<string, unknown>, state: Record<string, unknown>): void {
    const decisions =
      state.decisions && typeof state.decisions === 'object'
        ? (state.decisions as Record<string, unknown>)
        : {}
    decisions[String(item.id)] = item.decision ?? null
    state.decisions = decisions
    saveState(this.store, state)
  }

  private buildProposals(
    characters: MergedChar[],
    rules: Array<{ category: string; kind: 'hard' | 'soft'; rule: string; note: string }>,
    hooks: Array<Record<string, unknown>>,
    profile: StyleProfile,
  ): { summaries: Array<Record<string, unknown>>; detailed: Array<Record<string, unknown>> } {
    const writer = new TruthWriter(this.store)

    const usedCharIds = new Set(this.store.characters().map((c) => c.id))
    const usedNames = new Set(this.store.characters().map((c) => c.name))
    const usedRuleIds = new Set(this.store.world().rules.map((r) => r.id))
    const usedHookIds = new Set(this.store.hooks().map((h) => h.id))

    const allocCharId = (): string => {
      let i = 1
      while (usedCharIds.has(`char_${String(i).padStart(3, '0')}`)) i += 1
      const cid = `char_${String(i).padStart(3, '0')}`
      usedCharIds.add(cid)
      return cid
    }
    const allocRuleId = (): string => {
      let i = 1
      while (usedRuleIds.has(`w${i}`)) i += 1
      const rid = `w${i}`
      usedRuleIds.add(rid)
      return rid
    }
    const allocHookId = (): string => {
      let i = 1
      while (usedHookIds.has(`hook_${String(i).padStart(3, '0')}`)) i += 1
      const hid = `hook_${String(i).padStart(3, '0')}`
      usedHookIds.add(hid)
      return hid
    }

    const proposals: Proposal[] = []
    const contents: Record<string, string> = {}

    // 角色
    for (const c of characters) {
      const name = c.name
      if (usedNames.has(name)) continue
      usedNames.add(name)
      const cid = allocCharId()
      const isLead = ['主角', '男主', '女主'].includes(c.role)
      const relationships: Relation[] = c.relations.map((r) => ({
        target: r.target, type: r.type, note: r.note,
      }))
      const char: Character = {
        id: cid, name, role: c.role, lead: isLead,
        immutable_traits: [...c.traits],
        personality: '',
        speech_style: '',
        relationships,
        state: { location: '—', status: '—', known_secrets: [] },
        first_appearance: 1,
        updated_at_chapter: 0,
        aliases: [...(c.aliases ?? [])],
        deceased: false,
      }
      const p = makeProposal(`dis_char_${cid}`, 'character_add', { ...char }, 'characters.jsonl',
        '拆书反推角色', isLead ? 'high' : 'medium')
      proposals.push(p)
      contents[p.id] = `新增角色「${name}」，含 ${c.traits.length} 条不可变特征与 ${c.relations.length} 条关系`
    }

    // 世界观
    for (const r of rules) {
      const rid = allocRuleId()
      const rule: WorldRule = {
        id: rid, category: r.category, kind: r.kind,
        rule: r.rule, refs: [], note: r.note, status: 'ok',
      }
      const p = makeProposal(`dis_world_${rid}`, 'world_add', { ...rule }, 'world.md',
        '拆书反推世界观', r.kind === 'hard' ? 'high' : 'medium')
      proposals.push(p)
      contents[p.id] = `写入设定：[${r.kind === 'hard' ? '硬约束' : '软设定'}] ${r.rule}`
    }

    // 伏笔
    for (const h of hooks) {
      const hid = allocHookId()
      const resolved = (h.resolved_chapter as number | null) ?? null
      const hook: Hook = {
        id: hid,
        content: String(h.content),
        planted_chapter: Number(h.planted_chapter),
        status: resolved ? 'resolved' : 'planted',
        resolved_chapter: resolved,
        importance: (String(h.importance) === 'major' ? 'major' : 'minor'),
        linked_characters: [],
        suggested_resolve_by: null,
      }
      const p = makeProposal(`dis_hook_${hid}`, 'hook_add', { ...hook }, 'pending_hooks.jsonl',
        '拆书反推伏笔', resolved ? 'high' : 'low')
      proposals.push(p)
      const matchedText = resolved ? `，第 ${resolved} 章回收` : '，未匹配到回收点'
      contents[p.id] = `写入伏笔：${hook.content}（第 ${hook.planted_chapter} 章埋设${matchedText}）`
    }

    // 文风
    const styleP = makeProposal('dis_style', 'style_update', { ...profile }, 'style_profile.json',
      '拆书生成文风档案', 'high')
    proposals.push(styleP)
    contents[styleP.id] = '生成 style_profile.json 并设为必选上下文'

    // 逐个校验，收集 error
    const issues = writer.validate(proposals)
    const errorsById = new Map<string, string[]>()
    for (const issue of issues) {
      if (issue.level === 'error') {
        errorsById.set(issue.proposal_id, [...(errorsById.get(issue.proposal_id) ?? []), issue.message])
      }
    }

    const summaries: Array<Record<string, unknown>> = []
    const detailed: Array<Record<string, unknown>> = []
    for (const p of proposals) {
      const errs = errorsById.get(p.id) ?? []
      if (errs.length) p.confidence = 'low' // 有 error → 降级为待确认
      const summary: Record<string, unknown> = {
        id: p.id,
        kind: KIND_LABELS[p.kind] ?? p.kind,
        content: contents[p.id] ?? p.kind,
        confidence: p.confidence,
        decision: p.decision,
      }
      summaries.push(summary)
      detailed.push({
        ...summary,
        proposal_kind: p.kind,
        payload: p.payload,
        reason: p.reason,
        target_file: p.target_file,
        issues: errs,
      })
    }
    return { summaries, detailed }
  }
}

// ==========================================================================
// 纯函数辅助
// ==========================================================================

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function clampChapter(value: unknown, total: number): number | null {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  if (n <= 0) return null
  if (total && n > total) return total
  return n
}

/** 可读的文风摘要（`extracted["style"]`）。 */
function readableStyle(profile: StyleProfile): Record<string, string> {
  const mean = profile.sentence.mean || 0
  const sentence =
    mean <= 0
      ? '样本过短，未判定'
      : `${mean < 22 ? '偏短' : mean < 35 ? '中等' : '偏长'}，均值 ${Math.round(mean * 100) / 100} 字`
  const ratio = profile.ratio.map((r) => `${r.label} ${r.pct}%`).join(' · ') || '未判定'
  return {
    sentence,
    pov: profile.narrative.person || '未判定',
    ratio,
  }
}

function makeProposal(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  targetFile: string,
  reason: string,
  confidence: Proposal['confidence'],
): Proposal {
  return { id, kind, payload, reason, confidence, decision: null, target_file: targetFile }
}

function summaryOf(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: item.id,
    kind: item.kind,
    content: item.content,
    confidence: item.confidence,
    decision: item.decision ?? null,
  }
}
