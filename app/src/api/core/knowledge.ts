/**
 * 知识库 —— 镜像 `server/dobi/core/knowledge.py`。
 *
 * 纯派生、只读：把散在各真相文件里的实体与关系聚合成一张可漫游的网，
 * 不新增真相文件，也不碰 Proposal → Validate → Commit 闸门。
 */

import type { ProjectStore } from './store'
import { volumeChapters } from './story'

export const KIND_LABEL: Record<string, string> = {
  character: '角色',
  hook: '伏笔',
  rule: '设定',
  subplot: '支线',
  chapter: '章节',
}

export const LINK_LABEL: Record<string, string> = {
  relation: '人物关系',
  hook_character: '关联角色',
  chapter_character: '出场',
  chapter_hook_plant: '埋设伏笔',
  chapter_hook_resolve: '回收伏笔',
  hook_chapter: '所在章',
  rule_chapter: '引用章节',
  subplot_chapter: '活跃章节',
  character_chapter: '首次出场',
}

const SCOPE_KINDS: Record<string, Set<string>> = {
  core: new Set(['character', 'hook']),
  all: new Set(['character', 'hook', 'rule', 'subplot', 'chapter']),
}

const STATUS_LABEL: Record<string, string> = {
  skeleton: '骨架', planned: '已规划', draft: '草稿',
  written: '已成稿', audit: '已审', todo: '未开写',
}
const HOOK_STATUS_LABEL: Record<string, string> = {
  planted: '待回收', resolved: '已回收', abandoned: '已弃用',
}

interface Entity {
  kind: string
  id: string
  title: string
  subtitle: string
  chapter: number | null
  tags: string[]
  key(): string
  public(): Record<string, unknown>
}

interface Link {
  src: string
  dst: string
  type: string
  label: string
  typeLabel(): string
  public(): Record<string, unknown>
}

function clip(text: string, limit = 28): string {
  const joined = ((text || '').trim().replace(/\s+/g, ' '))
  return joined.length <= limit ? joined : joined.slice(0, limit - 1) + '…'
}

function makeEntity(
  kind: string, id: string, title: string,
  opts: { subtitle?: string; chapter?: number | null; tags?: string[] } = {},
): Entity {
  const tags = [...(opts.tags ?? [])]
  return {
    kind, id, title,
    subtitle: opts.subtitle ?? '',
    chapter: opts.chapter ?? null,
    tags,
    key(): string {
      return `${this.kind}:${this.id}`
    },
    public(): Record<string, unknown> {
      return {
        key: this.key(), kind: this.kind,
        kindLabel: KIND_LABEL[this.kind] ?? this.kind,
        id: this.id, title: this.title, subtitle: this.subtitle,
        chapter: this.chapter, tags: [...this.tags],
      }
    },
  }
}

function makeLink(src: string, dst: string, type: string, label = ''): Link {
  return {
    src, dst, type, label,
    typeLabel(): string {
      return LINK_LABEL[this.type] ?? this.type
    },
    public(): Record<string, unknown> {
      return { from: this.src, to: this.dst, type: this.type,
               typeLabel: this.typeLabel(), label: this.label }
    },
  }
}

function build(store: ProjectStore): { entities: Entity[]; links: Link[] } {
  const entities: Entity[] = []
  const links: Link[] = []

  const characters = store.characters()
  const hooks = store.hooks()
  const world = store.world()
  const subplots = store.subplots()
  const summaries = new Map(store.summaries().map((s) => [s.chapter, s]))
  const outlines = new Map(store.outlineGraph().nodes.map((n) => [n.chapter, n]))

  for (const c of characters) {
    const tags: string[] = []
    for (const tag of [c.role, c.lead ? '主角' : '', c.deceased ? '已故' : '']) {
      if (tag && !tags.includes(tag)) tags.push(tag)
    }
    const status = (c.state.status ?? '').trim()
    const subtitle = status === '' || status === '—' ? c.role : `${c.role} · ${status}`
    entities.push(makeEntity('character', c.id, c.name, {
      subtitle, chapter: c.first_appearance || null, tags,
    }))
  }

  for (const h of hooks) {
    const tags = [h.importance === 'major' ? '主线' : '支线']
    entities.push(makeEntity('hook', h.id, clip(h.content), {
      subtitle: HOOK_STATUS_LABEL[h.status] ?? h.status,
      chapter: h.planted_chapter || null, tags,
    }))
  }

  for (const r of world.rules) {
    entities.push(makeEntity('rule', r.id, clip(r.rule), {
      subtitle: `${r.category} · ${r.kind === 'hard' ? '硬约束' : '软约束'}`,
      tags: [r.category],
    }))
  }

  for (const s of subplots) {
    entities.push(makeEntity('subplot', s.id, s.name, {
      subtitle: s.kind === 'main' ? '主线' : '支线',
    }))
  }

  const chapterNos = [...new Set([...store.chapterNumbers(), ...summaries.keys(), ...outlines.keys()])].sort((a, b) => a - b)
  for (const n of chapterNos) {
    const node = outlines.get(n)
    const summary = summaries.get(n)
    const title = node?.title || summary?.title || ''
    const status = node ? STATUS_LABEL[node.status] ?? '' : ''
    entities.push(makeEntity('chapter', String(n), `第 ${n} 章` + (title ? ` · ${title}` : ''), {
      subtitle: status || (summary ? '已沉淀摘要' : '未开写'),
      chapter: n,
    }))
  }

  // 名字 / 别名 → 角色 key（关系里的 target 是人名，需要归一到 id）
  const charKey = new Map<string, string>()
  for (const c of characters) {
    const key = `character:${c.id}`
    for (const alias of [c.id, c.name, ...c.aliases]) {
      if (alias && !charKey.has(alias)) charKey.set(alias, key)
    }
  }

  const resolveChar = (ref: string): string | null => {
    ref = (ref || '').trim()
    if (!ref) return null
    if (charKey.has(ref)) return charKey.get(ref) ?? null
    for (const [alias, key] of charKey) {
      if (alias.length >= 2 && (ref.startsWith(alias) || alias.includes(ref))) return key
    }
    return null
  }

  const hookKeyById = new Map(hooks.map((h) => [h.id, `hook:${h.id}`]))
  const chapterKey = new Map(chapterNos.map((n) => [n, `chapter:${n}`]))

  const link = (src: string | null, dst: string | null, type: string, label = ''): void => {
    if (src && dst && src !== dst) links.push(makeLink(src, dst, type, label))
  }

  for (const c of characters) {
    const src = `character:${c.id}`
    for (const rel of c.relationships) {
      link(src, resolveChar(rel.target), 'relation', rel.type || '关联')
    }
  }

  for (const h of hooks) {
    const src = hookKeyById.get(h.id)
    if (!src) continue
    for (const ref of h.linked_characters) {
      link(src, resolveChar(ref), 'hook_character')
    }
    link(chapterKey.get(h.planted_chapter) ?? null, src, 'hook_chapter', '埋于')
    if (h.resolved_chapter) {
      link(chapterKey.get(h.resolved_chapter) ?? null, src, 'hook_chapter', '回收于')
    }
  }

  for (const c of characters) {
    link(`character:${c.id}`, chapterKey.get(c.first_appearance) ?? null, 'character_chapter', '首次出场')
  }

  for (const [n, s] of summaries) {
    const ch = chapterKey.get(n)
    if (!ch) continue
    for (const ref of s.characters) link(ch, resolveChar(ref), 'chapter_character')
    for (const hid of s.hooks_planted) link(ch, hookKeyById.get(hid) ?? null, 'chapter_hook_plant', '埋设')
    for (const hid of s.hooks_resolved) link(ch, hookKeyById.get(hid) ?? null, 'chapter_hook_resolve', '回收')
  }

  for (const r of world.rules) {
    for (const n of r.refs) {
      link(`rule:${r.id}`, chapterKey.get(n) ?? null, 'rule_chapter', `第 ${n} 章`)
    }
  }

  for (const s of subplots) {
    for (const n of s.active) link(`subplot:${s.id}`, chapterKey.get(n) ?? null, 'subplot_chapter', '活跃')
    for (const n of s.peak) link(`subplot:${s.id}`, chapterKey.get(n) ?? null, 'subplot_chapter', '高潮')
  }

  // 去重
  const seen = new Set<string>()
  const unique: Link[] = []
  for (const l of links) {
    const sig = `${l.src}|${l.dst}|${l.type}|${l.label}`
    if (seen.has(sig)) continue
    seen.add(sig)
    unique.push(l)
  }
  return { entities, links: unique }
}

function statsOf(entities: Entity[], links: Link[]): Record<string, number> {
  const counts: Record<string, number> = { character: 0, hook: 0, rule: 0, subplot: 0, chapter: 0 }
  for (const e of entities) counts[e.kind] = (counts[e.kind] ?? 0) + 1
  return {
    characters: counts.character,
    hooks: counts.hook,
    rules: counts.rule,
    subplots: counts.subplot,
    chapters: counts.chapter,
    links: links.length,
  }
}

function degreeOf(links: Link[]): Map<string, number> {
  const degree = new Map<string, number>()
  for (const l of links) {
    degree.set(l.src, (degree.get(l.src) ?? 0) + 1)
    degree.set(l.dst, (degree.get(l.dst) ?? 0) + 1)
  }
  return degree
}

/** 全库实体索引：给「知识库」页的清单用。 */
export function indexOf(store: ProjectStore): Record<string, unknown> {
  const { entities, links } = build(store)
  const degree = degreeOf(links)
  const rows = entities.map((e) => ({ ...e.public(), degree: degree.get(e.key()) ?? 0 }))
  return {
    stats: statsOf(entities, links),
    entities: rows,
    note: '知识库由真相文件实时派生，只读；在别的页面改了设定后，这里同步更新。',
  }
}

/** 图谱：节点 + 带类型的关系。scope=core 只含角色与伏笔，最易读。 */
export function graphOf(store: ProjectStore, scope = 'core'): Record<string, unknown> {
  const kinds = SCOPE_KINDS[scope] ?? SCOPE_KINDS.core
  const { entities, links } = build(store)
  const inScope = entities.filter((e) => kinds.has(e.kind))
  const keys = new Set(inScope.map((e) => e.key()))
  const edges = links.filter((l) => keys.has(l.src) && keys.has(l.dst))

  const degree = new Map(inScope.map((e) => [e.key(), 0]))
  for (const l of edges) {
    degree.set(l.src, (degree.get(l.src) ?? 0) + 1)
    degree.set(l.dst, (degree.get(l.dst) ?? 0) + 1)
  }

  // 不画孤点
  const kept = inScope.filter((e) => (degree.get(e.key()) ?? 0) > 0)
  const omitted = inScope.length - kept.length

  const nodes = kept.map((e) => ({ ...e.public(), degree: degree.get(e.key()) ?? 0 }))
  const usedTypes = [...new Set(edges.map((l) => l.type))].sort()

  return {
    scope: scope in SCOPE_KINDS ? scope : 'core',
    nodes,
    edges: edges.map((l) => l.public()),
    legend: usedTypes.map((t) => ({ type: t, typeLabel: LINK_LABEL[t] ?? t })),
    omitted,
    stats: { ...statsOf(entities, links), nodes: nodes.length, edges: edges.length },
    note: '只画真相文件里已有的关系；没有连线的条目不会出现在图里，可在下方「全部条目」里找到。',
  }
}

/** 单个实体 + 双向链接（谁指向它、它指向谁）——「反查」的底座。 */
export function entityDetail(store: ProjectStore, kind: string, id: string): Record<string, unknown> | null {
  const { entities, links } = build(store)
  const target = entities.find((e) => e.kind === kind && e.id === id) ?? null
  if (!target) return null
  const byKey = new Map(entities.map((e) => [e.key(), e]))

  const rows = (direction: 'out' | 'in'): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = []
    for (const l of links) {
      const src = direction === 'out' ? l.src : l.dst
      const dst = direction === 'out' ? l.dst : l.src
      if (src !== target.key()) continue
      const other = byKey.get(dst)
      if (!other) continue
      const row = other.public()
      row.type = l.type
      row.typeLabel = l.typeLabel()
      row.label = l.label
      out.push(row)
    }
    return out
  }

  const outbound = rows('out')
  const inbound = rows('in')
  return {
    entity: target.public(),
    outbound,
    inbound,
    stats: { outbound: outbound.length, inbound: inbound.length },
    note: '反向链接来自真相文件里已有的关系字段，只读。',
  }
}

export { volumeChapters }
