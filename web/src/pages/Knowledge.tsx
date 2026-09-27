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
 * 三块内容：全库检索 / 关系网（点节点即漫游）/ 条目清单。
 *
 * 类名取自 `styles/contract.css`（`.graph-wrap` / `.gnode` / `.gedge` / `.legend` /
 * `.chart-note` / `.list-row` 等），不新造样式。
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

const KIND_ICON: Record<Kind, IconName> = {
  character: 'users',
  hook: 'bookmark',
  rule: 'globe',
  subplot: 'git-branch',
  chapter: 'library',
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
  paths: Array<{ key: string; d: string }>
}

function layout(nodes: Entity[], edges: GraphEdge[]): Layout {
  const order: Kind[] = ['character', 'hook', 'rule', 'subplot', 'chapter']
  const cols = order.filter((k) => nodes.some((n) => n.kind === k))
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

  const paths: Array<{ key: string; d: string }> = []
  edges.forEach((e, i) => {
    const a = at.get(e.from)
    const b = at.get(e.to)
    if (!a || !b) return
    const y1 = a.y + NODE_H / 2
    const y2 = b.y + NODE_H / 2
    let d: string
    if (a.x === b.x) {
      // 同列（如角色↔角色）：向右侧鼓一条弧，避免压住节点文字
      const x = a.x + nodeW
      const bulge = Math.min(34, VB_W - x - 6)
      d = `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`
    } else {
      const rightward = a.x < b.x
      const x1 = a.x + (rightward ? nodeW : 0)
      const x2 = b.x + (rightward ? 0 : nodeW)
      const dx = (x2 - x1) * 0.45
      d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
    }
    paths.push({ key: `e-${i}`, d })
  })

  // 13px 中文 ≈ 每字 13px，两侧各留 12px 内边距
  const titleLimit = Math.max(4, Math.floor((nodeW - 24) / 13))
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

export default function Knowledge() {
  const { projectId } = useProject()

  const [index, setIndex] = useState<IndexData | null>(null)
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [scope, setScope] = useState<Scope>('core')
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [err, setErr] = useState('')

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailData | null>(null)

  const [q, setQ] = useState('')
  const [search, setSearch] = useState<SearchData | null>(null)
  const [searching, setSearching] = useState(false)

  const [filter, setFilter] = useState<Filter>('all')

  const load = useCallback(async () => {
    if (!projectId) return
    setStatus('loading')
    try {
      const [idx, g] = (await Promise.all([
        getKnowledge(projectId),
        getKnowledgeGraph(projectId, scope),
      ])) as [IndexData, GraphData]
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
      setErr(errMsg(e))
      setStatus('error')
    }
  }, [projectId, scope])

  useEffect(() => {
    setIndex(null)
    setGraph(null)
    setDetail(null)
    setSelectedKey(null)
    setSearch(null)
    setQ('')
    if (!projectId) {
      setStatus('ready')
      return
    }
    void load()
  }, [projectId, load])

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

  const entities = index?.entities ?? []
  const visible = useMemo(
    () => (filter === 'all' ? entities : entities.filter((e) => e.kind === filter)),
    [entities, filter],
  )

  const drawn = useMemo(() => (graph ? layout(graph.nodes, graph.edges) : null), [graph])

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
              <Icon name="git-branch" size={24} />
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

  if (status === 'loading') {
    return (
      <>
        <TopBar title="知识库" sub="把角色、伏笔、设定、支线与章节连成一张网" />
        <Loading text="正在梳理全书关系…" />
      </>
    )
  }

  if (status === 'error') {
    return (
      <>
        <TopBar title="知识库" sub="把角色、伏笔、设定、支线与章节连成一张网" />
        <ErrorState message={err} onRetry={() => void load()} />
      </>
    )
  }

  const stats = index?.stats
  const total = entities.length

  function linkRow(row: LinkRow, arrow: string): ReactNode {
    return (
      <div
        key={`${row.type}-${row.key}`}
        className={classNames('list-row', row.key === selectedKey && 'is-active')}
        {...press(() => setSelectedKey(row.key))}
      >
        <span className="mono fs-12 muted" style={{ minWidth: 26 }}>{arrow}</span>
        <div className="row-main">
          <div className="row-title">{row.title}</div>
          <div className="row-sub wrap-row">
            <span className="tag tag-quiet">{row.kindLabel}</span>
            <span className="tag tag-info">{row.typeLabel}</span>
            {row.label ? <span className="fs-12 muted">{row.label}</span> : null}
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
            ? `共 ${stats.characters} 位角色 · ${stats.hooks} 条伏笔 · ${stats.rules} 条设定 · ${stats.subplots} 条支线 · ${stats.chapters} 章`
            : '把角色、伏笔、设定、支线与章节连成一张网'
        }
        actions={
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            <Icon name="refresh-cw" size={16} />
            重新梳理
          </button>
        }
      />

      <div className="stack-24">
        <section className="card">
          <div className="card-head">
            <h2>全库检索</h2>
            <span className="tag tag-quiet">摘要 · 正文 · 设定 · 角色 · 伏笔 · 章纲</span>
          </div>
          <div className="card-body stack">
            <div className="row">
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="输入人物名、器物、地名或一句话，一次找遍全库"
                value={q}
                aria-label="全库检索关键词"
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch()
                }}
              />
              <button type="button" className="btn btn-primary btn-sm" disabled={searching} onClick={() => void runSearch()}>
                <Icon name="search" size={16} />
                {searching ? '检索中…' : '检索'}
              </button>
            </div>

            {search ? (
              search.hits.length ? (
                <div className="list">
                  {search.hits.map((hit) => (
                    <div key={`${hit.kind}-${hit.ref}-${hit.score}`} className="list-row" title={hit.ref}>
                      <span className="mono fs-12 muted">{hit.score}</span>
                      <div className="row-main">
                        <div className="row-title">{hit.title}</div>
                        <div className="row-sub">{hit.text}</div>
                      </div>
                      <span className="tag tag-quiet">
                        {hit.chapter > 0 ? `${hit.kindLabel} · 第 ${hit.chapter} 章` : hit.kindLabel}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <Icon name="search" size={20} />
                  <span className="fs-12">{search.note || '没有找到相关内容'}</span>
                </div>
              )
            ) : (
              <div className="fs-12 muted">检索走的是项目自己的全文索引，离线可用，不消耗模型额度。</div>
            )}
          </div>
        </section>

        <div className="grid-3">
          <div className="stat">
            <div className="stat-label">角色</div>
            <div className="stat-value">{stats?.characters ?? 0}</div>
          </div>
          <div className="stat">
            <div className="stat-label">伏笔</div>
            <div className="stat-value">{stats?.hooks ?? 0}</div>
          </div>
          <div className="stat">
            <div className="stat-label">设定</div>
            <div className="stat-value">{stats?.rules ?? 0}</div>
          </div>
        </div>

        <div className="grid-3">
          <div className="stat">
            <div className="stat-label">支线</div>
            <div className="stat-value">{stats?.subplots ?? 0}</div>
          </div>
          <div className="stat">
            <div className="stat-label">章节</div>
            <div className="stat-value">{stats?.chapters ?? 0}</div>
          </div>
          <div className="stat">
            <div className="stat-label">关系</div>
            <div className="stat-value">
              {stats?.links ?? 0}
              <small>条连线</small>
            </div>
          </div>
        </div>

        <div className="split">
          <section className="card">
            <div className="card-head">
              <h2>关系网</h2>
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
                          className={classNames('gedge', active && 'is-active')}
                          fill="none"
                          d={path.d}
                          markerEnd={active ? 'url(#kbar-on)' : 'url(#kbar)'}
                        />
                      )
                    })}
                    {drawn.placed.map(({ node, x, y }) => (
                      <g
                        key={node.key}
                        className={classNames('gnode', node.key === selectedKey && 'is-selected')}
                        {...press(() => setSelectedKey(node.key))}
                      >
                        <rect x={x} y={y} width={drawn.nodeW} height={NODE_H} rx={8} />
                        <text className="gt" x={x + 12} y={y + 19}>{nodeLabel(node, drawn.titleLimit)}</text>
                        <text className="gs" x={x + 12} y={y + 35}>{node.kindLabel}</text>
                      </g>
                    ))}
                  </svg>
                </div>
              ) : (
                <div className="card-body">
                  <div className="empty">
                    <Icon name="git-branch" size={24} />
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
                <div className="legend-item">
                  <span className="legend-swatch is-node" />
                  <span>条目（点它可漫游）</span>
                </div>
                <div className="legend-item">
                  <span className="legend-swatch is-active" />
                  <span>与当前条目相关</span>
                </div>
                {graph.legend.map((item) => (
                  <div key={item.type} className="legend-item">
                    <span className="legend-swatch" />
                    <span>{item.typeLabel}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {conclusion && graph && conclusion.edges > 0 ? (
              <div className="card-body">
                <div className="chart-note">
                  <strong>{`${conclusion.nodes} 个条目之间有 ${conclusion.edges} 条关系`}</strong>
                  {`，其中「${conclusion.topLabel}」最多（${conclusion.topCount} 条）· 点任意条目即可沿关系漫游，右栏会同步列出它的来龙去脉`}
                  {graph.omitted > 0 ? `；另有 ${graph.omitted} 个条目暂无连线，未画进图，可在下方清单里找到` : ''}
                </div>
              </div>
            ) : null}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>条目详情</h2>
              {detail ? <span className="tag tag-quiet">{detail.entity.kindLabel}</span> : null}
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {detail ? (
                <>
                  <div className="card-body">
                    <div className="row-title">{detail.entity.title}</div>
                    <div className="row-sub wrap-row" style={{ marginTop: 8 }}>
                      {detail.entity.subtitle ? <span className="fs-12 muted">{detail.entity.subtitle}</span> : null}
                      {detail.entity.chapter ? <span className="tag tag-quiet">{`第 ${detail.entity.chapter} 章`}</span> : null}
                      {detail.entity.tags.map((t) => (
                        <span key={t} className="chip">{t}</span>
                      ))}
                    </div>
                  </div>
                  <div className="list">
                    <div className="row-sub" style={{ padding: '12px 16px 4px' }}>
                      {`它指向（${detail.stats.outbound}）`}
                    </div>
                    {detail.outbound.length ? (
                      detail.outbound.map((row) => linkRow(row, '→'))
                    ) : (
                      <div className="empty"><span className="fs-12">还没有从它连出去的关系</span></div>
                    )}
                    <div className="row-sub" style={{ padding: '12px 16px 4px' }}>
                      {`指向它（${detail.stats.inbound}）`}
                    </div>
                    {detail.inbound.length ? (
                      detail.inbound.map((row) => linkRow(row, '←'))
                    ) : (
                      <div className="empty"><span className="fs-12">还没有别的条目连到它</span></div>
                    )}
                  </div>
                </>
              ) : (
                <div className="card-body">
                  <div className="empty">
                    <Icon name="info" size={20} />
                    <span className="fs-12">点关系网里的条目，或下方清单里的任意一行</span>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        <section className="card">
          <div className="card-head">
            <h2>全部条目</h2>
            <div className="seg" role="group" aria-label="条目筛选">
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
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {visible.length ? (
              <div className="list">
                {visible.map((entity) => (
                  <div
                    key={entity.key}
                    className={classNames('list-row', entity.key === selectedKey && 'is-active')}
                    {...press(() => setSelectedKey(entity.key))}
                  >
                    <Icon name={KIND_ICON[entity.kind]} size={16} />
                    <div className="row-main">
                      <div className="row-title">{entity.title}</div>
                      <div className="row-sub wrap-row">
                        <span className="tag tag-quiet">{entity.kindLabel}</span>
                        {entity.subtitle ? <span className="fs-12 muted">{entity.subtitle}</span> : null}
                      </div>
                    </div>
                    {entity.chapter ? <span className="mono fs-12 muted">{`第 ${entity.chapter} 章`}</span> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">
                <Icon name="info" size={20} />
                <span className="fs-12">{total ? '当前筛选下没有条目' : '这部作品还没有可沉淀的设定'}</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  )
}
