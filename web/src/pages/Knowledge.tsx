import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ErrorState } from '../components/ErrorState'
import { Icon, type IconName } from '../components/Icon'
import { TopBar } from '../components/Layout'
import { Loading } from '../components/Loading'
import { classNames } from '../lib/ui'
import {
  getKnowledge,
  getKnowledgeEntity,
  getKnowledgeGraph,
  searchKnowledge,
} from '../api/client'
import { useProject } from '../state/project'

/**
 * 知识库 —— 把散在各页的设定 / 角色 / 伏笔 / 支线 / 章节连成一张可漫游的网。
 *
 * 数据全部**只读派生**自真相文件里已有的关系字段（角色关系、伏笔关联角色、章节摘要、
 * 设定引用章号、支线活跃章），所以在别处改了设定，回这里刷新即可。
 *
 * 版式为「窄栏找条目 · 宽栏看关系」的双栏工作台（`.kb-split`）：
 * 窄栏 = 全库检索 + 全部条目（按牵连多少排序）；宽栏 = 关系网 + 选中条目的双向链接。
 * 这样检索、清单、图谱、详情各占其位，不必在一个纵列里从头滚到尾。
 * 窗口不够宽（<1440）时自动并成一栏，且顺序翻转为「先图、后详情、再清单」——图谱要占满宽度。
 *
 * 图上「谁是谁」与「谁和谁有关」不靠猜：节点带类型色点，选中条目时它的邻边直接写出
 * 关系名，其余节点与连线降淡。
 *
 * 类名取自 `styles/contract.css`（`.graph-wrap` / `.gnode` / `.gedge` / `.legend` /
 * `.chart-note` / `.list-row` / `.list-scroll` 等），不新造样式。
 */

type Kind = 'character' | 'hook' | 'rule' | 'subplot' | 'chapter'

interface Entity {
  key: string
  kind: Kind
  kindLabel: string
  id: string
  title: string
  subtitle: string
  chapter: number | null
  tags: string[]
  /** 牵连的关系条数（索引接口给；清单按它排序） */
  degree?: number
}

interface LinkRow extends Entity {
  type: string
  typeLabel: string
  label: string
}

interface Stats {
  characters: number
  hooks: number
  rules: number
  subplots: number
  chapters: number
  links: number
}

interface IndexData {
  stats: Stats
  entities: Entity[]
  note: string
}

interface GraphEdge {
  from: string
  to: string
  type: string
  typeLabel: string
  label: string
}

interface GraphData {
  scope: string
  nodes: Entity[]
  edges: GraphEdge[]
  legend: Array<{ type: string; typeLabel: string }>
  omitted: number
  stats: Stats & { nodes: number; edges: number }
  note: string
}

interface DetailData {
  entity: Entity
  outbound: LinkRow[]
  inbound: LinkRow[]
  stats: { outbound: number; inbound: number }
  note: string
}

interface SearchHit {
  score: number
  chapter: number
  kind: string
  kindLabel: string
  ref: string
  title: string
  text: string
}

interface SearchData {
  query: string
  hits: SearchHit[]
  note: string
}

type Scope = 'core' | 'all'
type Filter = 'all' | Kind

const KIND_ORDER: Kind[] = ['character', 'hook', 'rule', 'subplot', 'chapter']

const KIND_ICON: Record<Kind, IconName> = {
  character: 'users',
  hook: 'bookmark',
  rule: 'globe',
  subplot: 'git-branch',
  chapter: 'library',
}

/** 每个范围画出哪些类型——点检索结果跳到范围外的条目时，用它自动把范围放宽。 */
const SCOPE_KINDS: Record<Scope, Kind[]> = {
  core: ['character', 'hook'],
  all: KIND_ORDER,
}

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'character', label: '角色' },
  { key: 'hook', label: '伏笔' },
  { key: 'rule', label: '设定' },
  { key: 'subplot', label: '支线' },
  { key: 'chapter', label: '章节' },
]

const SCOPES: Array<{ key: Scope; label: string }> = [
  { key: 'core', label: '仅角色与伏笔' },
  { key: 'all', label: '含设定、支线与章节' },
]

/* ---------- 图谱几何（固定 720 宽 viewBox，保证 1:1 不缩字） ---------- */

const VB_W = 720
const MAX_NODE_W = 142
const NODE_H = 44
const PITCH = 60
const PAD_X = 40
const PAD_Y = 24
const MIN_GAP = 20
const DOT_X = 14 // 类型色点圆心距节点左边
const TEXT_X = 26 // 文字左边距（给色点让位）
const TEXT_PAD_R = 12 // 文字右边留白

interface Placed {
  node: Entity
  x: number
  y: number
}

interface Layout {
  height: number
  nodeW: number
  titleLimit: number
  placed: Placed[]
  paths: Array<{ key: string; d: string; lx: number; ly: number }>
}

function layout(nodes: Entity[], edges: GraphEdge[]): Layout {
  const cols = KIND_ORDER.filter((k) => nodes.some((n) => n.kind === k))
  const byCol = cols.map((k) => nodes.filter((n) => n.kind === k))
  const maxRows = Math.max(1, ...byCol.map((c) => c.length))
  const height = PAD_Y * 2 + maxRows * PITCH - (PITCH - NODE_H)

  const n = cols.length
  // 720 宽是硬约束：`.graph-wrap > svg { min-width:720px }`，缩到 1:1 以下会让图表字号失真。
  // 所以列一多就把节点收窄，绝不把列挤出画布。
  const nodeW = n > 0
    ? Math.min(MAX_NODE_W, Math.floor((VB_W - PAD_X * 2 - (n - 1) * MIN_GAP) / n))
    : MAX_NODE_W
  const gap = n > 1 ? Math.max(MIN_GAP, Math.min(120, (VB_W - PAD_X * 2 - n * nodeW) / (n - 1))) : 0
  const totalW = n * nodeW + (n - 1) * gap
  const x0 = Math.max(PAD_X, (VB_W - totalW) / 2)

  const placed: Placed[] = []
  const at = new Map<string, Placed>()
  byCol.forEach((colNodes, ci) => {
    const colX = x0 + ci * (nodeW + gap)
    const blockH = colNodes.length * PITCH - (PITCH - NODE_H)
    const startY = PAD_Y + (maxRows * PITCH - (PITCH - NODE_H) - blockH) / 2
    colNodes.forEach((node, ri) => {
      const item: Placed = { node, x: colX, y: startY + ri * PITCH }
      placed.push(item)
      at.set(node.key, item)
    })
  })

  const paths: Array<{ key: string; d: string; lx: number; ly: number }> = []
  edges.forEach((e, i) => {
    const a = at.get(e.from)
    const b = at.get(e.to)
    if (!a || !b) return
    const y1 = a.y + NODE_H / 2
    const y2 = b.y + NODE_H / 2
    let d: string
    let lx: number
    if (a.x === b.x) {
      // 同列（如角色↔角色）：向右侧鼓一条弧，避免压住节点文字
      const x = a.x + nodeW
      const bulge = Math.min(34, VB_W - x - 6)
      d = `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`
      lx = x + bulge * 0.75 // 三次贝塞尔在 t=0.5 处的横坐标
    } else {
      const rightward = a.x < b.x
      const x1 = a.x + (rightward ? nodeW : 0)
      const x2 = b.x + (rightward ? 0 : nodeW)
      const dx = (x2 - x1) * 0.45
      d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
      lx = (x1 + 3 * (x1 + dx) + 3 * (x2 - dx) + x2) / 8
    }
    paths.push({ key: `e-${i}`, d, lx, ly: (y1 + y2) / 2 })
  })

  // 13px 中文 ≈ 每字 13px，两侧内边距 + 色点占位
  const titleLimit = Math.max(3, Math.floor((nodeW - TEXT_X - TEXT_PAD_R) / 13))
  return { height, nodeW, titleLimit, placed, paths }
}

function trunc(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** 图上的节点标签：章节只显示章号（否则收窄后会被截成「第 1 章 · …」） */
function nodeLabel(node: Entity, limit: number): string {
  if (node.kind === 'chapter' && node.chapter) return `第 ${node.chapter} 章`
  return trunc(node.title, limit)
}

/**
 * 连线上的字。`label` 通常比类型名更具体（「师徒」优于「人物关系」、「埋于」优于「所在章」），
 * 优先用它；但「第 N 章」只是把目标节点的话又写了一遍，那种就退回类型名（「引用章节」）。
 */
function edgeLabel(edge: GraphEdge): string {
  const label = (edge.label || '').trim()
  if (!label || /^第\s*\d+\s*章$/.test(label)) return edge.typeLabel
  return label
}

/** SVG `g` 承载点击时必须键盘可达（契约 §12.7） */
function press(handler: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: handler,
    onKeyDown: (e: KeyboardEvent<Element>) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault()
        handler()
      }
    },
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试')

/**
 * 检索命中 → 它对应的条目。
 * 命中片段的 `ref` 形如 `characters.jsonl#c001`、`world.md#r2`；正文/摘要/章纲则落在章上。
 * 对不上条目的（例如正文窗口）返回 null，那一行就只是读读，不可跳。
 */
function hitKey(hit: SearchHit): string | null {
  const hash = (hit.ref || '').indexOf('#')
  const id = hash >= 0 ? hit.ref.slice(hash + 1) : ''
  if (hit.kind === 'character' && id) return `character:${id}`
  if (hit.kind === 'hook' && id) return `hook:${id}`
  if (hit.kind === 'world' && id) return `rule:${id}`
  if ((hit.kind === 'summary' || hit.kind === 'outline' || hit.kind === 'chapter') && hit.chapter > 0) {
    return `chapter:${hit.chapter}`
  }
  return null
}

export default function Knowledge() {
  const { projectId } = useProject()

  const [index, setIndex] = useState<IndexData | null>(null)
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [scope, setScope] = useState<Scope>('core')
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [err, setErr] = useState('')
  const [tick, setTick] = useState(0)

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailData | null>(null)

  const [q, setQ] = useState('')
  const [search, setSearch] = useState<SearchData | null>(null)
  const [searching, setSearching] = useState(false)

  const [filter, setFilter] = useState<Filter>('all')

  const reload = useCallback(() => setTick((t) => t + 1), [])

  /**
   * 选中一个条目。若它不在当前范围里（例如在「仅角色与伏笔」时点了条设定），
   * 顺手把范围放宽到全量——否则图上找不到它，点了跟没点一样。
   */
  const selectEntity = useCallback((key: string) => {
    setSelectedKey(key)
    const kind = key.slice(0, key.indexOf(':')) as Kind
    setScope((cur) => (SCOPE_KINDS[cur].includes(kind) ? cur : 'all'))
  }, [])

  // 换作品：整页归零
  useEffect(() => {
    setIndex(null)
    setGraph(null)
    setDetail(null)
    setSelectedKey(null)
    setSearch(null)
    setQ('')
    setFilter('all')
    setScope('core')
  }, [projectId])

  // 取数据。范围切换只重排图谱，不清空页面——否则点一下范围就闪一次整页 loading。
  useEffect(() => {
    if (!projectId) {
      setStatus('ready')
      return
    }
    let alive = true
    setStatus('loading')
    void (async () => {
      try {
        const [idx, g] = (await Promise.all([
          getKnowledge(projectId),
          getKnowledgeGraph(projectId, scope),
        ])) as [IndexData, GraphData]
        if (!alive) return
        setIndex(idx)
        setGraph(g)
        setStatus('ready')
        setSelectedKey((current) => {
          if (current && idx.entities.some((e) => e.key === current)) return current
          // 默认停在牵连最多的条目上——那是一张网的「结」
          const busiest = [...g.nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))[0]
          return busiest?.key ?? idx.entities[0]?.key ?? null
        })
      } catch (e) {
        if (!alive) return
        setErr(errMsg(e))
        setStatus('error')
      }
    })()
    return () => {
      alive = false
    }
  }, [projectId, scope, tick])

  // 选中条目 → 取它的双向链接
  useEffect(() => {
    if (!projectId || !selectedKey) {
      setDetail(null)
      return
    }
    const sep = selectedKey.indexOf(':')
    const kind = selectedKey.slice(0, sep)
    const id = selectedKey.slice(sep + 1)
    let alive = true
    void (async () => {
      try {
        const data = (await getKnowledgeEntity(projectId, kind, id)) as DetailData
        if (alive) setDetail(data)
      } catch {
        if (alive) setDetail(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [projectId, selectedKey])

  const runSearch = useCallback(async () => {
    if (!projectId) return
    const query = q.trim()
    if (!query) {
      setSearch(null)
      return
    }
    setSearching(true)
    try {
      setSearch((await searchKnowledge(projectId, query, 8)) as SearchData)
    } catch (e) {
      setSearch({ query, hits: [], note: errMsg(e) })
    } finally {
      setSearching(false)
    }
  }, [projectId, q])

  const entities = useMemo(() => index?.entities ?? [], [index])

  // 牵连多的排前面：先看到「结」，再看到边角
  const visible = useMemo(() => {
    const list = filter === 'all' ? entities : entities.filter((e) => e.kind === filter)
    return [...list].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0))
  }, [entities, filter])

  const drawn = useMemo(() => (graph ? layout(graph.nodes, graph.edges) : null), [graph])

  // 焦点态：选中条目的邻域。之外的节点与连线降淡，关系才看得出来。
  const neighbors = useMemo(() => {
    if (!graph || !selectedKey) return null
    const set = new Set<string>([selectedKey])
    for (const e of graph.edges) {
      if (e.from === selectedKey) set.add(e.to)
      if (e.to === selectedKey) set.add(e.from)
    }
    return set
  }, [graph, selectedKey])

  const kindsInGraph = useMemo(() => {
    if (!graph) return [] as Kind[]
    return KIND_ORDER.filter((k) => graph.nodes.some((n) => n.kind === k))
  }, [graph])

  const conclusion = useMemo(() => {
    if (!graph) return null
    const tally = new Map<string, number>()
    for (const e of graph.edges) tally.set(e.typeLabel, (tally.get(e.typeLabel) ?? 0) + 1)
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
    return {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      topLabel: top?.[0] ?? '—',
      topCount: top?.[1] ?? 0,
    }
  }, [graph])

  /* ---------- 三态 ---------- */

  if (!projectId) {
    return (
      <>
        <TopBar title="知识库" sub="把角色、伏笔、设定、支线与章节连成一张网" />
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="network" size={24} />
              <div className="fs-16 serif">还没有选择作品</div>
              <div className="fs-13 muted">先到「项目」里选择或新建一部作品，再回来漫游它的设定网。</div>
              <Link className="btn btn-ghost btn-sm" to="/">
                前往项目列表
              </Link>
            </div>
          </div>
        </section>
      </>
    )
  }

  // 只有「第一次还没有数据」才整页载入；切范围时就地重排，不闪屏
  if (status === 'loading' && !index) {
    return (
      <>
        <TopBar title="知识库" sub="把角色、伏笔、设定与章节连成一张网" />
        <Loading text="正在梳理全书关系…" />
      </>
    )
  }

  if (status === 'error') {
    return (
      <>
        <TopBar title="知识库" sub="把角色、伏笔、设定与章节连成一张网" />
        <ErrorState message={err} onRetry={reload} />
      </>
    )
  }

  const stats = index?.stats
  const busy = status === 'loading'

  function linkRow(row: LinkRow): ReactNode {
    return (
      <div
        key={`${row.type}-${row.key}`}
        className={classNames('list-row', row.key === selectedKey && 'is-active')}
        {...press(() => selectEntity(row.key))}
      >
        <Icon name={KIND_ICON[row.kind]} size={16} />
        <div className="row-main">
          <div className="row-title">{row.title}</div>
          <div className="row-sub wrap-row">
            <span className="tag tag-info">{row.typeLabel}</span>
            {/* 有些关系的 label 与类型同名（如「首次出场」），重复一遍是噪音 */}
            {row.label && row.label !== row.typeLabel ? (
              <span className="fs-12 muted">{row.label}</span>
            ) : null}
            <span className="fs-12 muted">{row.kindLabel}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <TopBar
        title="知识库"
        sub={
          stats
            ? `共 ${stats.characters} 位角色 · ${stats.hooks} 条伏笔 · ${stats.rules} 条设定 · ${stats.subplots} 条支线 · ${stats.chapters} 章 · ${stats.links} 条关系`
            : '把角色、伏笔、设定与章节连成一张网'
        }
        actions={
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={reload}>
            <Icon name="refresh-cw" size={16} />
            {busy ? '梳理中…' : '重新梳理'}
          </button>
        }
      />

      <div className="kb-split">
        {/* 窄栏 · 找条目 */}
        <div className="stack-24 kb-nav">
          <section className="card">
            <div className="card-head">
              <h2>全库检索</h2>
              <span className="tag tag-quiet">离线 · 不耗额度</span>
            </div>
            <div className="card-body stack-8">
              <div className="row">
                <input
                  className="input"
                  style={{ flex: 1 }}
                  placeholder="人物名、器物、地名或一句话"
                  value={q}
                  aria-label="全库检索关键词"
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void runSearch()
                  }}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={searching}
                  onClick={() => void runSearch()}
                >
                  <Icon name="search" size={16} />
                  {searching ? '检索中…' : '检索'}
                </button>
              </div>

              {search ? (
                search.hits.length ? (
                  <>
                    <div className="fs-12 muted">{search.note}</div>
                    <div className="list list-scroll">
                      {search.hits.map((hit) => {
                        const key = hitKey(hit)
                        return (
                          <div
                            key={`${hit.kind}-${hit.ref}`}
                            className={classNames('list-row', key && key === selectedKey && 'is-active')}
                            title={hit.ref}
                            {...(key ? press(() => selectEntity(key)) : {})}
                          >
                            <div className="row-main">
                              <div className="row-title">{hit.title}</div>
                              <div className="row-sub">{hit.text}</div>
                            </div>
                            <span className="tag tag-quiet">
                              {key ? '查看' : hit.chapter > 0 ? `第 ${hit.chapter} 章` : hit.kindLabel}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </>
                ) : (
                  <div className="empty">
                    <Icon name="search" size={20} />
                    <span className="fs-12">{search.note || '没有找到相关内容'}</span>
                  </div>
                )
              ) : (
                <div className="fs-12 muted">
                  一次找遍摘要、正文、设定、角色、伏笔与章纲；标「查看」的结果点一下即可跳到对应条目。
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>全部条目</h2>
              <span className="tag tag-quiet">{`${visible.length} / ${entities.length}`}</span>
            </div>
            <div className="card-body" style={{ padding: '12px 0 0' }}>
              <div
                className="seg"
                role="group"
                aria-label="条目筛选"
                style={{ margin: '0 16px 8px', flexWrap: 'wrap' }}
              >
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    className={f.key === filter ? 'active' : undefined}
                    aria-pressed={f.key === filter}
                    onClick={() => setFilter(f.key)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="list list-scroll">
                {visible.length ? (
                  visible.map((entity) => (
                    <div
                      key={entity.key}
                      className={classNames('list-row', entity.key === selectedKey && 'is-active')}
                      {...press(() => selectEntity(entity.key))}
                    >
                      <Icon name={KIND_ICON[entity.kind]} size={16} />
                      <div className="row-main">
                        <div className="row-title">{entity.title}</div>
                        <div className="row-sub wrap-row">
                          <span className="tag tag-quiet">{entity.kindLabel}</span>
                          {entity.subtitle ? <span className="fs-12 muted">{entity.subtitle}</span> : null}
                        </div>
                      </div>
                      {entity.degree ? (
                        <span className="fs-12 muted">{`${entity.degree} 条`}</span>
                      ) : (
                        <span className="fs-12 muted">—</span>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="empty">
                    <Icon name="info" size={20} />
                    <span className="fs-12">{entities.length ? '当前筛选下没有条目' : '这部作品还没有可沉淀的设定'}</span>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>

        {/* 宽栏 · 看关系 */}
        <div className="stack-24 kb-main">
          <section className="card">
            <div className="card-head">
              <h2>关系网</h2>
              <div className="row">
                {busy ? <span className="fs-12 muted">重排中…</span> : null}
                <div className="seg" role="group" aria-label="图谱范围">
                  {SCOPES.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      className={s.key === scope ? 'active' : undefined}
                      aria-pressed={s.key === scope}
                      onClick={() => setScope(s.key)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="card-body" style={{ padding: 0 }}>
              {graph && drawn && drawn.placed.length ? (
                <div className="graph-wrap">
                  <svg viewBox={`0 0 ${VB_W} ${drawn.height}`} role="img" aria-label="全书关系网">
                    <defs>
                      <marker id="kbar" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={8} markerHeight={8} markerUnits="userSpaceOnUse" orient="auto">
                        <path d="M1 1 L7 4 L1 7 Z" style={{ fill: 'var(--ink-4)' }} />
                      </marker>
                      <marker id="kbar-on" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={8} markerHeight={8} markerUnits="userSpaceOnUse" orient="auto">
                        <path d="M1 1 L7 4 L1 7 Z" style={{ fill: 'var(--accent)' }} />
                      </marker>
                    </defs>

                    {graph.edges.map((e, i) => {
                      const path = drawn.paths.find((p) => p.key === `e-${i}`)
                      if (!path) return null
                      const active = e.from === selectedKey || e.to === selectedKey
                      return (
                        <path
                          key={`edge-${i}`}
                          className={classNames('gedge', active && 'is-active', neighbors && !active && 'is-dim')}
                          fill="none"
                          d={path.d}
                          markerEnd={active ? 'url(#kbar-on)' : 'url(#kbar)'}
                        />
                      )
                    })}

                    {/* 邻边上的关系名：只在被选中的那个条目的边上写，避免整张图糊成一片 */}
                    {graph.edges.map((e, i) => {
                      if (e.from !== selectedKey && e.to !== selectedKey) return null
                      const path = drawn.paths.find((p) => p.key === `e-${i}`)
                      if (!path) return null
                      return (
                        <text key={`elabel-${i}`} className="gedge-label" x={path.lx} y={path.ly}>
                          {edgeLabel(e)}
                        </text>
                      )
                    })}

                    {drawn.placed.map(({ node, x, y }) => (
                      <g
                        key={node.key}
                        className={classNames(
                          'gnode',
                          node.key === selectedKey && 'is-selected',
                          neighbors && !neighbors.has(node.key) && 'is-dim',
                        )}
                        data-kind={node.kind}
                        {...press(() => selectEntity(node.key))}
                      >
                        <rect x={x} y={y} width={drawn.nodeW} height={NODE_H} rx={8} />
                        <circle className="gkind" cx={x + DOT_X} cy={y + NODE_H / 2} r={4.5} />
                        <text className="gt" x={x + TEXT_X} y={y + 19}>{nodeLabel(node, drawn.titleLimit)}</text>
                        <text className="gs" x={x + TEXT_X} y={y + 35}>{node.kindLabel}</text>
                      </g>
                    ))}
                  </svg>
                </div>
              ) : (
                <div className="card-body">
                  <div className="empty">
                    <Icon name="network" size={24} />
                    <div className="fs-16 serif">还没有可连的关系</div>
                    <div className="fs-13 muted">
                      角色之间写了关系、伏笔关联了角色之后，这里就会长出一张网。
                    </div>
                  </div>
                </div>
              )}
            </div>

            {graph && drawn && drawn.placed.length ? (
              <div className="legend">
                {kindsInGraph.map((k) => (
                  <div key={k} className="legend-item">
                    <span className={classNames('legend-swatch', 'is-kind', `is-${k}`)} />
                    <span>{graph.nodes.find((n) => n.kind === k)?.kindLabel}</span>
                  </div>
                ))}
                <div className="legend-item">
                  <span className="legend-swatch is-active" />
                  <span>与当前条目相关</span>
                </div>
                <div className="legend-item">
                  <span className="legend-swatch" />
                  <span>其余关系</span>
                </div>
              </div>
            ) : null}

            {conclusion && graph && conclusion.edges > 0 ? (
              <div className="card-body">
                <div className="chart-note">
                  <strong>{`${conclusion.nodes} 个条目之间有 ${conclusion.edges} 条关系`}</strong>
                  {`，其中「${conclusion.topLabel}」最多（${conclusion.topCount} 条）· 点任意条目即可沿关系漫游，连线上的字就是这两者的关系`}
                  {graph.omitted > 0 ? `；另有 ${graph.omitted} 个条目暂无连线，未画进图，可在左栏清单里找到` : ''}
                </div>
              </div>
            ) : null}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>条目详情</h2>
              {detail ? (
                <span className="tag tag-quiet">{`${detail.entity.kindLabel} · ${detail.stats.outbound + detail.stats.inbound} 条关系`}</span>
              ) : null}
            </div>

            {detail ? (
              <>
                <div className="card-body" style={{ paddingBottom: 12 }}>
                  <div className="row-title fs-16">{detail.entity.title}</div>
                  <div className="row-sub wrap-row" style={{ marginTop: 8 }}>
                    {detail.entity.subtitle ? <span className="fs-12 muted">{detail.entity.subtitle}</span> : null}
                    {detail.entity.chapter ? <span className="tag tag-quiet">{`第 ${detail.entity.chapter} 章`}</span> : null}
                    {detail.entity.tags.map((t) => (
                      <span key={t} className="chip">{t}</span>
                    ))}
                  </div>
                </div>

                <div className="grid-2" style={{ padding: '0 16px 16px', gap: '0 16px' }}>
                  <div>
                    <div className="row-sub" style={{ paddingBottom: 4 }}>
                      {`它指向（${detail.stats.outbound}）`}
                    </div>
                    <div className="list">
                      {detail.outbound.length ? (
                        detail.outbound.map((row) => linkRow(row))
                      ) : (
                        <div className="empty"><span className="fs-12">还没有从它连出去的关系</span></div>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="row-sub" style={{ paddingBottom: 4 }}>
                      {`指向它（${detail.stats.inbound}）`}
                    </div>
                    <div className="list">
                      {detail.inbound.length ? (
                        detail.inbound.map((row) => linkRow(row))
                      ) : (
                        <div className="empty"><span className="fs-12">还没有别的条目连到它</span></div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="card-body">
                <div className="empty">
                  <Icon name="info" size={20} />
                  <span className="fs-12">点关系网里的条目，或左栏清单里的任意一行</span>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  )
}
