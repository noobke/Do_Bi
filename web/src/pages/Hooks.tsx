import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { TopBar } from '../components/Layout'
import { Loading } from '../components/Loading'
import { classNames, toast } from '../lib/ui'
import { listHooks, request } from '../api/client'
import { useProject } from '../state/project'

/**
 * 伏笔看板 —— 追踪伏笔与回收率。
 *
 * 数据源：`GET /hooks`（伏笔 + 统计 + 当前章）。写操作（新增 / 回收 / 弃用）成功后
 * 用返回的 `hooks` / `stats` **就地更新**，不整页重取。
 * 注意：写接口返回的 `hooks` 不带 `overdue`（只有 GET 会补），这里按后端同一规则
 * （仍待回收且已超过建议回收章）在前端重算，保证告警不丢。
 * 类名取自 `styles/contract.css`（批次一 / 二 / 九），动态位置用内联 style。
 */

type HookStatus = 'planted' | 'resolved' | 'abandoned'
type Importance = 'major' | 'minor'

interface Hook {
  id: string
  content: string
  plantedChapter: number
  status: HookStatus
  resolvedChapter: number | null
  importance: Importance
  linkedCharacters: string[]
  suggestedResolveBy: number | null
  overdue: boolean
}

interface HookStats {
  total: number
  planted: number
  resolved: number
  abandoned: number
  overdue: number
  rate: number
}

interface HooksData {
  hooks: Hook[]
  stats: HookStats
  currentChapter: number
}

interface WriteResult {
  ok: boolean
  hooks: Hook[]
  stats: HookStats
}

type Filter = 'all' | 'major' | 'overdue'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'major', label: '仅主线' },
  { key: 'overdue', label: '仅超期' },
]

const STATUS_TAG: Record<HookStatus, [string, string]> = {
  planted: ['tag-seal', '待回收'],
  resolved: ['tag-ok', '已回收'],
  abandoned: ['tag-quiet', '已弃用'],
}

const IMPORTANCE_TAG: Record<Importance, [string, string]> = {
  major: ['tag-warn', '主线'],
  minor: ['tag-quiet', '支线'],
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试')

const enc = encodeURIComponent

/** 与后端 `Hook.overdue()` 同一规则：仍待回收且已超过建议回收章 */
function withOverdue(hooks: Hook[], current: number): Hook[] {
  return hooks.map((h) => ({
    ...h,
    overdue: h.status === 'planted' && h.suggestedResolveBy != null && current > h.suggestedResolveBy,
  }))
}

export default function Hooks() {
  const { projectId } = useProject()

  const [hooks, setHooks] = useState<Hook[]>([])
  const [stats, setStats] = useState<HookStats | null>(null)
  const [currentChapter, setCurrentChapter] = useState(0)
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [err, setErr] = useState('')

  const [filter, setFilter] = useState<Filter>('all')
  const [showAbandoned, setShowAbandoned] = useState(false)
  const [busy, setBusy] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ content: '', planted: '1', importance: 'minor' as Importance, suggested: '' })

  const [resolveTarget, setResolveTarget] = useState<Hook | null>(null)
  const [resolveChapter, setResolveChapter] = useState('')

  const load = useCallback(async () => {
    if (!projectId) return
    setStatus('loading')
    try {
      const data = (await listHooks(projectId)) as HooksData
      setHooks(withOverdue(data.hooks ?? [], data.currentChapter ?? 0))
      setStats(data.stats ?? null)
      setCurrentChapter(data.currentChapter ?? 0)
      setStatus('ready')
    } catch (e) {
      setErr(errMsg(e))
      setStatus('error')
    }
  }, [projectId])

  useEffect(() => {
    setHooks([])
    setStats(null)
    if (!projectId) {
      setStatus('ready')
      return
    }
    void load()
  }, [projectId, load])

  /** 写操作成功后就地套用返回的 hooks / stats */
  const applyWrite = useCallback(
    (res: WriteResult, message: string) => {
      setHooks(withOverdue(res.hooks ?? [], currentChapter))
      setStats(res.stats ?? null)
      toast(message, 'ok')
    },
    [currentChapter],
  )

  const submitCreate = useCallback(async () => {
    if (!projectId) return
    const content = form.content.trim()
    if (content.length < 2) {
      toast('先把伏笔内容写清楚（至少两个字）', 'warn')
      return
    }
    setBusy(true)
    try {
      const res = (await request(`/api/projects/${enc(projectId)}/hooks`, {
        method: 'POST',
        body: JSON.stringify({
          content,
          plantedChapter: Number(form.planted) || 1,
          importance: form.importance,
          suggestedResolveBy: form.suggested.trim() ? Number(form.suggested) : undefined,
        }),
      })) as WriteResult
      applyWrite(res, '已登记一条伏笔')
      setCreateOpen(false)
      setForm({ content: '', planted: '1', importance: 'minor', suggested: '' })
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(false)
    }
  }, [projectId, form, applyWrite])

  const confirmResolve = useCallback(async () => {
    if (!projectId || !resolveTarget) return
    const chapter = Number(resolveChapter) || currentChapter || 1
    setBusy(true)
    try {
      const res = (await request(`/api/projects/${enc(projectId)}/hooks/${enc(resolveTarget.id)}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ chapter }),
      })) as WriteResult
      applyWrite(res, `已标记回收（第 ${chapter} 章）`)
      setResolveTarget(null)
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(false)
    }
  }, [projectId, resolveTarget, resolveChapter, currentChapter, applyWrite])

  const abandon = useCallback(
    async (hook: Hook) => {
      if (!projectId) return
      setBusy(true)
      try {
        const res = (await request(`/api/projects/${enc(projectId)}/hooks/${enc(hook.id)}/abandon`, {
          method: 'POST',
        })) as WriteResult
        applyWrite(res, `已弃用 ${hook.id}`)
      } catch (e) {
        toast(errMsg(e), 'error')
      } finally {
        setBusy(false)
      }
    },
    [projectId, applyWrite],
  )

  const visible = useMemo(() => {
    if (filter === 'major') return hooks.filter((h) => h.importance === 'major')
    if (filter === 'overdue') return hooks.filter((h) => h.overdue)
    return hooks
  }, [hooks, filter])

  const byStatus = useCallback(
    (s: HookStatus) => visible.filter((h) => h.status === s),
    [visible],
  )

  /* ---------- 时间线：章节跨度 ---------- */
  const span = useMemo(() => {
    const nums = [
      currentChapter,
      ...hooks.map((h) => h.plantedChapter),
      ...hooks.map((h) => h.resolvedChapter ?? 0),
      ...hooks.map((h) => h.suggestedResolveBy ?? 0),
    ]
    return Math.max(1, ...nums)
  }, [hooks, currentChapter])

  const pct = useCallback((ch: number) => (span > 1 ? ((ch - 1) / (span - 1)) * 100 : 0), [span])

  /* ---------- 三态 ---------- */

  if (!projectId) {
    return (
      <>
        <TopBar title="伏笔看板" sub="追踪伏笔与回收率" />
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="library" size={24} />
              <div className="fs-16 serif">还没有选择作品</div>
              <div className="fs-13 muted">先到「项目」里选择或新建一部作品，再回来追踪伏笔。</div>
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
        <TopBar title="伏笔看板" sub="追踪伏笔与回收率" />
        <Loading text="正在载入伏笔…" />
      </>
    )
  }

  if (status === 'error') {
    return (
      <>
        <TopBar title="伏笔看板" sub="追踪伏笔与回收率" />
        <ErrorState message={err} onRetry={() => void load()} />
      </>
    )
  }

  const s = stats

  function hookCard(h: Hook): ReactNode {
    const st = STATUS_TAG[h.status]
    const tag = h.overdue ? ['tag-danger', '超期'] : st
    return (
      <div
        key={h.id}
        className={classNames('hook-card', h.status === 'resolved' && 'is-resolved', h.overdue && 'is-overdue')}
        style={h.overdue ? { borderTopColor: 'var(--error)', background: 'var(--error-soft)' } : undefined}
      >
        {h.importance === 'major' ? (
          <div style={{ marginBottom: 8 }}>
            <span className="chip">主线</span>
          </div>
        ) : null}
        <div className="hook-text">{h.content}</div>
        <div className="hook-meta">
          <span className="mono">{`${h.id} · 埋于第 ${h.plantedChapter} 章`}</span>
          <span className={classNames('tag', tag[0])} title={h.overdue ? 'overdue' : h.status}>{tag[1]}</span>
        </div>
      </div>
    )
  }

  function lane(statusKey: HookStatus, label: string, emptyText: string): ReactNode {
    const list = byStatus(statusKey)
    return (
      <div className="lane">
        <div className="lane-head">
          <span>{label}</span>
          <span className="mono">{list.length}</span>
        </div>
        <div className="lane-body">
          {list.length ? (
            list.map(hookCard)
          ) : (
            <div className="empty">
              <Icon name="bookmark" size={20} />
              <span className="fs-12">{emptyText}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <TopBar
        title="伏笔看板"
        sub={
          s
            ? `共 ${s.total} 条 · 待回收 ${s.planted} 条 · 已回收 ${s.resolved} 条 · 超期 ${s.overdue} 条`
            : '追踪伏笔与回收率'
        }
        actions={
          <>
            <div className="seg" role="group" aria-label="伏笔筛选">
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
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
              <Icon name="plus" size={16} />
              新增伏笔
            </button>
          </>
        }
      />

      {hooks.length === 0 ? (
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="bookmark" size={24} />
              <div className="fs-16 serif">还没有伏笔</div>
              <div className="fs-13 muted">写完第一章并定稿后，系统会自动沉淀伏笔；也可以手工登记。</div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                新增伏笔
              </button>
            </div>
          </div>
        </section>
      ) : (
        <div className="stack-24">
          <div className="grid-3">
            <div className="stat">
              <div className="stat-label">总伏笔</div>
              <div className="stat-value">{s?.total ?? 0}</div>
            </div>
            <div className="stat">
              <div className="stat-label">待回收</div>
              <div className="stat-value">{s?.planted ?? 0}</div>
            </div>
            <div className="stat">
              <div className="stat-label">已回收</div>
              <div className="stat-value">{s?.resolved ?? 0}</div>
            </div>
          </div>

          <div className="grid-3">
            <div className="stat">
              <div className="stat-label">已弃用</div>
              <div className="stat-value">{s?.abandoned ?? 0}</div>
            </div>
            <div className="stat">
              <div className="stat-label">超期</div>
              <div className="stat-value">
                <span className="dot" style={{ background: 'var(--error)', verticalAlign: 'middle', marginRight: 6 }} />
                {s?.overdue ?? 0}
              </div>
              <div className="fs-12 muted" style={{ marginTop: 6 }}>建议回收章已逾期</div>
            </div>
            <div className="stat">
              <div className="stat-label">回收率</div>
              <div className="stat-value">{`${s?.rate ?? 0}%`}<small>核心质量指标</small></div>
              <div className="progress" style={{ marginTop: 8 }}>
                <i style={{ width: `${s?.rate ?? 0}%` }} />
              </div>
            </div>
          </div>

          <section className="card">
            <div className="card-head">
              <h2>状态泳道</h2>
              <div className="row">
                <span className="tag tag-quiet">{`当前筛选 ${visible.length} 条`}</span>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  aria-pressed={showAbandoned}
                  onClick={() => setShowAbandoned((v) => !v)}
                >
                  {showAbandoned ? '收起已弃用' : `展开已弃用（${byStatus('abandoned').length}）`}
                </button>
              </div>
            </div>
            <div className="card-body">
              <div className={showAbandoned ? 'grid-3' : 'grid-2'}>
                {lane('planted', '待回收', filter === 'overdue' ? '「仅超期」下无超期待回收伏笔' : '无待回收伏笔')}
                {lane('resolved', '已回收', '无已回收伏笔')}
                {showAbandoned ? lane('abandoned', '已弃用', '无已弃用伏笔') : null}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>伏笔时间线</h2>
              <span className="tag tag-quiet">{`第 1 – ${span} 章`}</span>
            </div>
            <div className="card-body">
              <div className="timeline">
                {hooks.map((h) => {
                  const start = Math.min(h.plantedChapter, h.resolvedChapter ?? h.plantedChapter)
                  const rawEnd = h.resolvedChapter ?? currentChapter
                  const end = Math.max(start, rawEnd)
                  const left = pct(start)
                  const width = Math.max(1.2, pct(end) - left)
                  return (
                    <div key={h.id} className="tl-row">
                      <span className="tl-ch">{h.id}</span>
                      <div>
                        <div className="rangebar">
                          <i
                            style={{
                              left: `${left}%`,
                              width: `${width}%`,
                              ...(h.overdue
                                ? { background: 'var(--error-soft)', borderLeftColor: 'var(--error)', borderRightColor: 'var(--error)' }
                                : null),
                            }}
                          />
                          <b style={{ left: `${pct(h.plantedChapter)}%` }} />
                        </div>
                        <div className="fs-12 muted" style={{ marginTop: 4 }}>
                          <span className="mono">{`第 ${h.plantedChapter} 章 → `}</span>
                          <span className="mono">
                            {h.resolvedChapter != null
                              ? `第 ${h.resolvedChapter} 章`
                              : h.overdue
                                ? `计划第 ${h.suggestedResolveBy} 章（已逾期）`
                                : `第 ${end} 章（当前）`}
                          </span>
                          {h.overdue ? <span className="tag tag-danger" style={{ marginLeft: 8 }}>超期</span> : null}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="chart-note" style={{ marginTop: 16 }}>
                <strong>
                  {`${hooks.length} 条伏笔横跨第 1–${span} 章，其中 ${hooks.filter((h) => h.overdue).length} 条已超期`}
                </strong>
                {` · 浅色区间为「埋设 → 回收」的跨度，竖线标出埋设章；超期条目用错误色标出，需尽快给出呼应`}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>伏笔清单</h2>
              <span className="tag tag-quiet">{`${visible.length} 条`}</span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <div className="list">
                {visible.length ? (
                  visible.map((h) => {
                    const imp = IMPORTANCE_TAG[h.importance]
                    const st = h.overdue ? (['tag-danger', '超期'] as [string, string]) : STATUS_TAG[h.status]
                    return (
                      <div key={h.id} className="list-row">
                        <span className="mono fs-12 muted">{h.id}</span>
                        <div className="row-main">
                          <div className="row-title">{h.content}</div>
                          <div className="row-sub wrap-row">
                            <span className={classNames('tag', imp[0])}>{imp[1]}</span>
                            <span className={classNames('tag', st[0])}>{st[1]}</span>
                            <span className="fs-12 muted">
                              {`建议回收：${h.suggestedResolveBy != null ? `第 ${h.suggestedResolveBy} 章` : '未指定'}`}
                            </span>
                            <span className="fs-12 muted">
                              {`关联角色：${h.linkedCharacters.length ? h.linkedCharacters.join('、') : '—'}`}
                            </span>
                          </div>
                        </div>
                        {h.status === 'planted' ? (
                          <div className="row">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={busy}
                              onClick={() => {
                                setResolveTarget(h)
                                setResolveChapter(String(currentChapter || h.plantedChapter))
                              }}
                            >
                              标记已回收
                            </button>
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm"
                              disabled={busy}
                              onClick={() => void abandon(h)}
                            >
                              弃用
                            </button>
                          </div>
                        ) : null}
                      </div>
                    )
                  })
                ) : (
                  <div className="empty">
                    <span className="fs-12">当前筛选下没有伏笔</span>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      {createOpen ? (
        <div className="modal">
          <div className="modal-veil" onClick={() => setCreateOpen(false)} />
          <div className="modal-card">
            <div className="card-head">
              <h2>新增伏笔</h2>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setCreateOpen(false)}>
                关闭
              </button>
            </div>
            <div className="card-body stack">
              <div className="field">
                <label className="field-label" htmlFor="hook-content">伏笔内容</label>
                <textarea
                  id="hook-content"
                  className="textarea"
                  placeholder="一句话写清这条伏笔埋了什么、将来要回收什么"
                  value={form.content}
                  onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                />
              </div>
              <div className="grid-2">
                <div className="field">
                  <label className="field-label" htmlFor="hook-planted">埋设章</label>
                  <input
                    id="hook-planted"
                    className="input"
                    type="number"
                    min={1}
                    value={form.planted}
                    onChange={(e) => setForm((f) => ({ ...f, planted: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="hook-importance">重要性</label>
                  <select
                    id="hook-importance"
                    className="select"
                    value={form.importance}
                    onChange={(e) => setForm((f) => ({ ...f, importance: e.target.value as Importance }))}
                  >
                    <option value="minor">支线</option>
                    <option value="major">主线</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="hook-suggested">建议回收章</label>
                <input
                  id="hook-suggested"
                  className="input"
                  type="number"
                  min={1}
                  placeholder="留空表示不设期限"
                  value={form.suggested}
                  onChange={(e) => setForm((f) => ({ ...f, suggested: e.target.value }))}
                />
                <div className="field-hint">设定了建议回收章后，超过该章仍未回收会进入「超期」告警。</div>
              </div>
            </div>
            <div className="card-foot row-between">
              <span className="fs-12 muted">手工登记的伏笔会写入真相文件，可随时回收或弃用</span>
              <div className="row">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreateOpen(false)}>
                  取消
                </button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submitCreate()}>
                  {busy ? '登记中…' : '登记伏笔'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {resolveTarget ? (
        <div className="modal">
          <div className="modal-veil" onClick={() => setResolveTarget(null)} />
          <div className="modal-card">
            <div className="card-head">
              <h2>标记已回收</h2>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setResolveTarget(null)}>
                关闭
              </button>
            </div>
            <div className="card-body stack">
              <div className="audit-evidence">{resolveTarget.content}</div>
              <div className="field">
                <label className="field-label" htmlFor="hook-resolve-ch">回收章</label>
                <input
                  id="hook-resolve-ch"
                  className="input"
                  type="number"
                  min={1}
                  value={resolveChapter}
                  onChange={(e) => setResolveChapter(e.target.value)}
                />
                <div className="field-hint">默认填当前章；这一条会在该章标记为已回收。</div>
              </div>
            </div>
            <div className="card-foot row-between">
              <span className="fs-12 muted">回收只记录结论，不会改动正文</span>
              <div className="row">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setResolveTarget(null)}>
                  取消
                </button>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void confirmResolve()}>
                  {busy ? '处理中…' : '确认回收'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
