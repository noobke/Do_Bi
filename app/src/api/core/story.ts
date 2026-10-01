/**
 * 故事时间推导（确定性，无模型调用）—— 镜像 `server/dobi/core/story.py`。
 *
 * 剧情树与章节页双轨时间线都需要「故事时间」维度，但它是自由文本。这里做两件确定性的事：
 * 1. `storyTimeKey()` 把自由文本映射成可排序的键（回溯类事件在前，同年代按首次出现章号排）。
 * 2. `bookAnchors()` 汇总全书时间锚点，数组顺序即故事时间顺序。
 */

import type { ProjectStore } from './store'
import type { OutlineNode } from './types'

export const KIND_LABELS: Record<string, string> = {
  backstory: '前史',
  flashback: '闪回',
  now: '顺叙',
  future: '预叙',
  planned: '未写入',
}

const KINDS = new Set(Object.keys(KIND_LABELS))

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

function cnNumber(token: string): number | null {
  if (/^\d+$/.test(token)) return parseInt(token, 10)
  let total = 0
  let section = 0
  let current = 0
  for (const ch of token) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch]
    } else if (ch === '十') {
      section += (current || 1) * 10
      current = 0
    } else if (ch === '百') {
      section += (current || 1) * 100
      current = 0
    } else if (ch === '千') {
      section += (current || 1) * 1000
      current = 0
    } else {
      return null
    }
  }
  return total + section + current || null
}

const YEARS_AGO_RE = /([0-9一二三四五六七八九十百千两零〇]+)\s*年前/
const DAYS_AGO_RE = /([0-9一二三四五六七八九十百千两零〇]+)\s*(?:日|天)前/
const HOURS_RE = /(当夜|今夜|当晚|次夜|次日|第二天|翌日|黎明|清晨|上午|正午|午后|黄昏|傍晚|入夜|夜|子时|后半夜)/

/** 排序键 `[时间刻度, 首次出现章号]`。数值越小越靠前（越早）。 */
export function storyTimeKey(storyAt: string, chapter: number): [number, number] {
  const text = (storyAt || '').trim()
  if (!text) return [0, chapter]

  const ym = text.match(YEARS_AGO_RE)
  if (ym) {
    const n = cnNumber(ym[1])
    if (n != null) return [-n * 365, chapter]
  }
  const dm = text.match(DAYS_AGO_RE)
  if (dm) {
    const n = cnNumber(dm[1])
    if (n != null) return [-n, chapter]
  }
  if (text.includes('第二卷') || text.includes('第三卷')) {
    const n = cnNumber(text.replace('第', '').replace('卷', ''))
    if (n != null) return [n * 365, chapter]
  }
  // 顺叙内部：同一天内的先后关系按叙述顺序排，不做小时级语义解析
  return [0, chapter]
}

export function storyKind(storyAt: string, defaultKind = 'now'): string {
  const text = storyAt || ''
  if (/\d+\s*年前|年前|前史|战前/.test(text)) return 'backstory'
  if (storyAt && HOURS_RE.test(text) && DAYS_AGO_RE.test(text)) return 'flashback'
  if (/翌日|次日|第二天|十日后|三日后|将|预/.test(text) && !text.includes('前')) return 'future'
  return KINDS.has(defaultKind) ? defaultKind : 'now'
}

export interface ChapterEvent {
  at: string
  label: string
  kind: string
  derived?: string
}

/** 本章事件序列。优先用章纲里的 `timeline`；没有就从节拍派生，标注为派生。 */
export function chapterEvents(store: ProjectStore, chapter: number): ChapterEvent[] {
  const node = store.outlineGraph().nodes.find((n) => n.chapter === chapter) ?? null
  if (!node) return []

  const events: ChapterEvent[] = []
  for (const raw of node.timeline ?? []) {
    const label = String((raw as { label?: unknown })?.label ?? '').trim()
    if (!label) continue
    const kind = String((raw as { kind?: unknown })?.kind ?? '').trim()
    events.push({
      at: String((raw as { at?: unknown })?.at ?? node.story_at ?? '').trim(),
      label,
      kind: KINDS.has(kind) ? kind : storyKind(node.story_at),
    })
  }
  if (events.length) return events

  // 兜底：节拍当事件，整章共用一个故事时间
  const kind = storyKind(node.story_at)
  return node.beats.filter((b) => b.trim()).map((b) => ({
    at: node.story_at, label: b, kind, derived: 'true',
  }))
}

/** 全书时间锚点，数组顺序即故事时间顺序（设计契约的硬约定）。 */
export function bookAnchors(store: ProjectStore): Array<Record<string, unknown>> {
  const graph = store.outlineGraph()
  const buckets = new Map<string, Record<string, unknown>>()
  for (const node of [...graph.nodes].sort((a, b) => a.chapter - b.chapter)) {
    for (const event of chapterEvents(store, node.chapter)) {
      const key = event.at || event.label
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = {
          id: `bt_${buckets.size + 1}`,
          storyAt: event.at || '（未标注）',
          label: event.label,
          kind: event.kind,
          chapters: [],
          note: '',
        }
        buckets.set(key, bucket)
      }
      const chapters = bucket.chapters as number[]
      if (!chapters.includes(node.chapter)) chapters.push(node.chapter)
      if (!bucket.note && node.rationale) bucket.note = node.rationale.slice(0, 60)
    }
  }
  const anchors = [...buckets.values()]
  anchors.sort((a, b) => {
    const chaptersA = a.chapters as number[]
    const chaptersB = b.chapters as number[]
    const ka = storyTimeKey(String(a.storyAt), Math.min(...(chaptersA.length ? chaptersA : [0])))
    const kb = storyTimeKey(String(b.storyAt), Math.min(...(chaptersB.length ? chaptersB : [0])))
    return ka[0] - kb[0] || ka[1] - kb[1]
  })
  for (const anchor of anchors) {
    ;(anchor.chapters as number[]).sort((x, y) => x - y)
  }
  return anchors
}

/** 双向包含匹配（设计契约批次七的规定）。 */
export function matchAnchor(
  eventLabel: string,
  anchors: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  const label = (eventLabel || '').trim()
  if (!label) return null
  for (const anchor of anchors) {
    const other = String(anchor.label ?? '').trim()
    if (!other) continue
    if (label.includes(other) || other.includes(label)) return anchor
  }
  return null
}

/** 卷属性（镜像 schema.Volume.chapters） */
export function volumeChapters(v: { to_chapter: number; from_chapter: number; est_chapters: number }): number {
  if (v.to_chapter) return Math.max(0, v.to_chapter - v.from_chapter + 1)
  return v.est_chapters
}

/** 章节节点是否存在（镜像 outline_graph.node） */
export function outlineNode(graph: { nodes: OutlineNode[] }, chapter: number): OutlineNode | null {
  return graph.nodes.find((n) => n.chapter === chapter) ?? null
}
