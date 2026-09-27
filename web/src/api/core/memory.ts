/**
 * 内存检索索引 —— 镜像 `server/dobi/core/memory.py`。
 *
 * 原版用 SQLite + rank_bm25；本地版数据全在内存（localStorage），
 * 规模小，每次检索前按真相文件重建索引即可（语义与「索引可随时重建」一致）：
 * - 中文按字符二元组（bigram）切词，无需分词器、离线可用；
 * - `up_to_chapter` 保证「不引用后文」，避免「第 17 章引用了第 24 章才知道的事」。
 */

import type { ProjectStore } from './store'
import type { OutlineEdge, OutlineGraph, OutlineNode } from './types'

export const CHUNK_KINDS: Record<string, string> = {
  summary: '章节摘要',
  chapter: '正文片段',
  world: '世界规则',
  character: '角色卡',
  hook: '伏笔',
  outline: '章纲与思维链',
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
const LATIN_WORD_RE = /[A-Za-z0-9']+/g
const PUNCT_RE = /[\s，。！？、；：,.!?;:"'（）()【】\[\]—…·]+/g
const STOP_CHARS = new Set('的了是在有和就都而及与着或一个上下来去这那为以其于')

const CHUNK_CHARS = 900
const CHUNK_OVERLAP = 180

const BM25_K1 = 1.5
const BM25_B = 0.75

/** 中文二元组 + 拉丁小写词。这是给 BM25 用的切词，不是给模型看的。 */
export function tokenize(text: string): string[] {
  if (!text) return []
  const tokens: string[] = []
  for (const w of text.match(LATIN_WORD_RE) ?? []) tokens.push(w.toLowerCase())
  for (const segment of text.split(PUNCT_RE)) {
    const cjk = segment.match(CJK_RE) ?? []
    if (!cjk.length) continue
    for (const ch of cjk) {
      if (!STOP_CHARS.has(ch)) tokens.push(ch)
    }
    for (let i = 0; i < cjk.length - 1; i++) {
      const bi = cjk[i] + cjk[i + 1]
      if (STOP_CHARS.has(bi[0]) && STOP_CHARS.has(bi[1])) continue
      tokens.push(bi)
    }
  }
  return tokens
}

export function graphNode(graph: OutlineGraph, chapter: number): OutlineNode | null {
  return graph.nodes.find((n) => n.chapter === chapter) ?? null
}

export function motivationsFor(graph: OutlineGraph, chapter: number): OutlineEdge[] {
  return graph.edges.filter(
    (e) => e.from_chapter === chapter && (e.type === 'motivation' || e.type === 'setup'),
  )
}

function splitWindows(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  text = (text || '').trim()
  if (!text) return []
  if (text.length <= size) return [text]
  const out: string[] = []
  const step = Math.max(1, size - overlap)
  for (let start = 0; start < text.length; start += step) {
    const piece = text.slice(start, start + size)
    if (piece.trim()) out.push(piece)
    if (start + size >= text.length) break
  }
  return out
}

/** Okapi BM25（k1=1.5, b=0.75），与 rank_bm25 的 BM25Okapi 同口径 */
class BM25 {
  private tfs: Map<string, number>[] = []
  private lens: number[] = []
  private avgdl = 0
  private df = new Map<string, number>()
  private n = 0

  build(corpus: string[][]): void {
    this.n = corpus.length
    this.tfs = corpus.map((doc) => {
      const tf = new Map<string, number>()
      for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1)
      return tf
    })
    this.lens = corpus.map((d) => d.length)
    this.avgdl = this.lens.reduce((a, b) => a + b, 0) / Math.max(1, this.n)
    this.df = new Map()
    for (const tf of this.tfs) {
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    }
  }

  scores(query: string[]): number[] {
    const qterms = [...new Set(query)]
    return this.tfs.map((tf, i) => {
      let score = 0
      const dl = this.lens[i]
      for (const term of qterms) {
        const f = tf.get(term)
        if (!f) continue
        const df = this.df.get(term) ?? 0
        const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5))
        score += (idf * (f * (BM25_K1 + 1))) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / Math.max(1, this.avgdl)))
      }
      return score
    })
  }
}

interface Doc {
  id: number
  chapter: number
  kind: string
  ref: string
  title: string
  text: string
}

export interface MemoryHit {
  score: number
  chapter: number
  kind: string
  kindLabel: string
  ref: string
  title: string
  text: string
}

/** 检索命中 → 文本片段（镜像 context._format_search_hits） */
export function formatSearchHits(hits: MemoryHit[]): string {
  const lines: string[] = []
  for (const h of hits) {
    const where = h.chapter ? `第 ${h.chapter} 章` : '设定库'
    lines.push(`- [${h.kindLabel}] ${where}《${h.title}》：${h.text.slice(0, 220)}`)
  }
  return lines.join('\n')
}

export class MemoryIndex {
  readonly store: ProjectStore
  private docs: Doc[] = []
  private bm25: BM25 | null = null

  constructor(store: ProjectStore) {
    this.store = store
  }

  /** 从真相文件重建全部片段。返回写入的片段数。 */
  reindex(): number {
    const store = this.store
    const rows: Doc[] = []

    for (const s of store.summaries()) {
      const text = [s.title, s.summary, s.key_facts.join('；')].filter(Boolean).join(' ')
      rows.push({
        id: rows.length + 1, chapter: s.chapter, kind: 'summary',
        ref: `chapter_summaries.jsonl#${s.chapter}`,
        title: s.title || `第 ${s.chapter} 章`, text,
      })
    }

    for (const n of store.chapterNumbers()) {
      const data = store.readChapter(n)
      const body = data.paragraphs.join('\n\n')
      splitWindows(body).forEach((piece, i) => {
        rows.push({
          id: rows.length + 1, chapter: n, kind: 'chapter',
          ref: `ch_${String(n).padStart(4, '0')}.md#win-${i + 1}`,
          title: data.title || `第 ${n} 章`, text: piece,
        })
      })
    }

    for (const r of store.world().rules) {
      rows.push({
        id: rows.length + 1, chapter: 0, kind: 'world',
        ref: `world.md#${r.id}`, title: r.category,
        text: r.rule + (r.note ? ' ' + r.note : ''),
      })
    }

    for (const c of store.characters()) {
      const text = [
        c.name, c.role, c.personality, c.speech_style,
        c.immutable_traits.join('；'),
        `状态：${c.state.location} ${c.state.status}`,
        c.relationships.map((rel) => `${rel.target}(${rel.type})${rel.note}`).join('；'),
      ].filter(Boolean).join(' ')
      rows.push({
        id: rows.length + 1, chapter: c.first_appearance, kind: 'character',
        ref: `characters.jsonl#${c.id}`, title: c.name, text,
      })
    }

    for (const h of store.hooks()) {
      const resolved = h.resolved_chapter ? `，已于第 ${h.resolved_chapter} 章回收` : '，尚未回收'
      rows.push({
        id: rows.length + 1, chapter: h.planted_chapter, kind: 'hook',
        ref: `pending_hooks.jsonl#${h.id}`, title: h.content.slice(0, 24),
        text: `${h.content}（埋于第 ${h.planted_chapter} 章${resolved}）`,
      })
    }

    for (const node of store.outlineGraph().nodes) {
      const text = [node.title, node.goal, node.beats.join('；'), node.rationale].filter(Boolean).join(' ')
      rows.push({
        id: rows.length + 1, chapter: node.chapter, kind: 'outline',
        ref: `outline_graph.json#ch${node.chapter}`,
        title: node.title || `第 ${node.chapter} 章`, text,
      })
    }

    this.docs = rows
    const corpus = rows.map((d) => {
      const t = tokenize(d.text)
      return t.length ? t : ['∅']
    })
    this.bm25 = new BM25()
    this.bm25.build(corpus)
    return rows.length
  }

  /** 数据全在内存，每次检索前重建即得最新真相（等价原版「索引可随时丢弃重建」）。 */
  private ensureIndex(): void {
    this.reindex()
  }

  /** 片段与记忆规模（镜像 Python `MemoryIndex.stats`）。 */
  stats(): Record<string, unknown> {
    this.reindex()
    const byKind: Record<string, number> = {}
    for (const doc of this.docs) byKind[doc.kind] = (byKind[doc.kind] ?? 0) + 1
    let timelineEvents = 0
    try {
      const raw = window.localStorage.getItem(`dobi.timeline.${this.store.id}`)
      const parsed = raw ? (JSON.parse(raw) as unknown) : []
      if (Array.isArray(parsed)) timelineEvents = parsed.length
    } catch {
      /* 存储不可用时按 0 计 */
    }
    return {
      chunks: this.docs.length,
      byKind,
      timelineEvents,
      engine: 'rank_bm25 + 中文 bigram',
    }
  }

  search(
    query: string,
    opts: { k?: number; kinds?: string[] | null; excludeChapters?: number[]; upToChapter?: number | null } = {},
  ): MemoryHit[] {
    const { k = 8, kinds = null, excludeChapters = [], upToChapter = null } = opts
    this.ensureIndex()
    if (!this.bm25 || !this.docs.length) return []
    const tokens = tokenize(query)
    if (!tokens.length) return []
    const scores = this.bm25.scores(tokens)
    const exclude = new Set(excludeChapters)
    const ranked: Array<[number, Doc]> = []
    this.docs.forEach((doc, i) => {
      const score = scores[i]
      if (score <= 0) return
      if (kinds && !kinds.includes(doc.kind)) return
      if (doc.chapter && exclude.has(doc.chapter)) return
      if (upToChapter != null && doc.chapter && doc.chapter > upToChapter) return
      ranked.push([score, doc])
    })
    ranked.sort((a, b) => b[0] - a[0])
    return ranked.slice(0, k).map(([score, doc]) => ({
      score: Math.round(score * 10000) / 10000,
      chapter: doc.chapter,
      kind: doc.kind,
      kindLabel: CHUNK_KINDS[doc.kind] ?? doc.kind,
      ref: doc.ref,
      title: doc.title,
      text: doc.text,
    }))
  }

  /** 关联章节推荐：BM25 相关度 + 依赖图邻接 + 时间近邻，三者加权。 */
  relatedChapters(
    chapter: number,
    query: string,
    opts: { k?: number } = {},
  ): Array<Record<string, unknown>> {
    const { k = 5 } = opts
    const store = this.store
    const graph = store.outlineGraph()
    const neighbours: Record<number, number> = {}
    for (const edge of graph.edges) {
      if (edge.from_chapter === chapter && edge.to_chapter > 0 && edge.to_chapter < chapter) {
        neighbours[edge.to_chapter] = Math.max(neighbours[edge.to_chapter] ?? 0, 1.0)
      }
    }

    const scores: Record<number, number> = {}
    for (const hit of this.search(query, { k: k * 4, upToChapter: chapter })) {
      const n = hit.chapter
      if (!n || n === chapter) continue
      const weight = hit.kind !== 'outline' ? 1.0 : 0.8
      scores[n] = (scores[n] ?? 0) + hit.score * weight
    }
    for (const [key, boost] of Object.entries(neighbours)) {
      const n = Number(key)
      scores[n] = (scores[n] ?? 0) + boost * 1.5
    }
    for (let n = Math.max(1, chapter - 3); n < chapter; n++) {
      if (n in scores) scores[n] += 0.6
    }

    const ranked = Object.entries(scores)
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)

    return ranked.map(([key, score]) => {
      const n = Number(key)
      const node = graphNode(graph, n)
      const summary = store.summary(n)
      const viaGraph = n in neighbours
      return {
        chapter: n,
        title: node?.title || summary?.title || '',
        score: Math.round(score * 1000) / 1000,
        viaGraph,
        reason: viaGraph ? '依赖图直连' : chapter - 3 <= n && n < chapter ? '前情近邻' : '内容相关',
      }
    })
  }
}
