import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { TopBar } from '../components/Layout'
import { Loading } from '../components/Loading'
import { classNames, toast } from '../lib/ui'
import { getWorld, resolveWorldConflict, setWorldKind } from '../api/client'
import { useProject } from '../state/project'

/**
 * 世界观 —— 设定清单、冲突裁定、与引用章对齐。
 *
 * 数据源：`GET /world`（规则 + 分类 + 统计 + world.md 原文）。
 * 冲突裁定与约束强度切换都会返回**新的 world 数据**，直接就地替换（不整页重取）。
 * 类名取自 `styles/contract.css`（批次四）。
 */

type Kind = 'hard' | 'soft'
type RuleStatus = 'ok' | 'conflict' | 'unused'

interface WorldRule {
  id: string
  category: string
  kind: Kind
  rule: string
  refs: number[]
  note: string
  status: RuleStatus
}

interface WorldData {
  rules: WorldRule[]
  categories: string[]
  stats: { total: number; hard: number; soft: number; conflict: number; unused: number }
  updatedAt: string
  markdown: string
}

const KIND_LABEL: Record<Kind, string> = { hard: '硬约束', soft: '软设定' }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试')

function statusTag(w: WorldRule): ReactNode {
  if (w.status === 'conflict') return <span className="tag tag-danger">冲突待裁定</span>
  if (w.status === 'unused') return <span className="tag tag-warn">尚未使用</span>
  return <span className="tag tag-ok">生效中</span>
}

function refChips(refs: number[]): ReactNode {
  if (!refs.length) return <span className="fs-12 muted">尚未被任何章节引用</span>
  return (
    <div className="ref-chips">
      {refs.map((n) => (
        <Link key={n} className="ref-chip" to={`/chapter/${n}`}>{`第 ${n} 章`}</Link>
      ))}
    </div>
  )
}

export default function World() {
  const { projectId } = useProject()

  const [world, setWorld] = useState<WorldData | null>(null)
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [err, setErr] = useState('')
  const [category, setCategory] = useState('全部')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    if (!projectId) return
    setStatus('loading')
    try {
      setWorld((await getWorld(projectId)) as WorldData)
      setStatus('ready')
    } catch (e) {
      setErr(errMsg(e))
      setStatus('error')
    }
  }, [projectId])

  useEffect(() => {
    setWorld(null)
    setCategory('全部')
    if (!projectId) {
      setStatus('ready')
      return
    }
    void load()
  }, [projectId, load])

  const toggleKind = useCallback(
    async (rule: WorldRule) => {
      if (!projectId || busy) return
      const next: Kind = rule.kind === 'hard' ? 'soft' : 'hard'
      setBusy(rule.id)
      try {
        setWorld((await setWorldKind(projectId, rule.id, next)) as WorldData)
        toast(`已改为${KIND_LABEL[next]}`, 'ok')
      } catch (e) {
        toast(errMsg(e), 'error')
      } finally {
        setBusy('')
      }
    },
    [projectId, busy],
  )

  const resolve = useCallback(
    async (ruleId: string, resolution: 'keep_text' | 'keep_rule') => {
      if (!projectId || busy) return
      setBusy(ruleId)
      try {
        setWorld((await resolveWorldConflict(projectId, ruleId, resolution)) as WorldData)
        toast('已记录裁定；正文的实际修改仍需走修订流程', 'ok')
      } catch (e) {
        toast(errMsg(e), 'error')
      } finally {
        setBusy('')
      }
    },
    [projectId, busy],
  )

  const conflicts = useMemo(() => (world?.rules ?? []).filter((r) => r.status === 'conflict'), [world])
  const visibleRules = useMemo(() => {
    const rules = world?.rules ?? []
    return category === '全部' ? rules : rules.filter((r) => r.category === category)
  }, [world, category])
  const grouped = useMemo(() => {
    const cats: string[] = []
    for (const r of visibleRules) if (!cats.includes(r.category)) cats.push(r.category)
    return cats.map((cat) => ({ cat, rules: visibleRules.filter((r) => r.category === cat) }))
  }, [visibleRules])

  /* ---------- 三态 ---------- */

  if (!projectId) {
    return (
      <>
        <TopBar title="世界观" sub="设定清单与冲突裁定" />
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="library" size={24} />
              <div className="fs-16 serif">还没有选择作品</div>
              <div className="fs-13 muted">先到「项目」里选择或新建一部作品，再回来看世界观。</div>
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
        <TopBar title="世界观" sub="设定清单与冲突裁定" />
        <Loading text="正在载入世界观…" />
      </>
    )
  }

  if (status === 'error' || !world) {
    return (
      <>
        <TopBar title="世界观" sub="设定清单与冲突裁定" />
        <ErrorState message={err} onRetry={() => void load()} />
      </>
    )
  }

  const stats = world.stats

  if (world.rules.length === 0) {
    return (
      <>
        <TopBar title="世界观" sub="设定清单与冲突裁定" />
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="globe" size={24} />
              <div className="fs-16 serif">还没有世界观设定</div>
              <div className="fs-13 muted">去「共创」聊几句，或到「结构」点「生成世界观与大纲」。</div>
              <div className="row">
                <Link className="btn btn-ghost btn-sm" to="/chat">去共创</Link>
                <Link className="btn btn-primary btn-sm" to="/outline">去结构</Link>
              </div>
            </div>
          </div>
        </section>
      </>
    )
  }

  return (
    <>
      <TopBar
        title="世界观"
        sub={`${stats.total} 条设定 · ${stats.hard} 条硬约束 · ${stats.conflict} 处冲突待裁定`}
        actions={
          <div className="seg" role="group" aria-label="按分类筛选">
            {world.categories.map((c) => (
              <button
                key={c}
                type="button"
                className={c === category ? 'active' : undefined}
                aria-pressed={c === category}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
        }
      />

      <div className="stack-24">
        <div className="grid-4">
          <div className="stat">
            <div className="stat-label">硬约束</div>
            <div className="stat-value">{stats.hard}</div>
            <div className="fs-12 muted" style={{ marginTop: 4 }}>违反会阻塞定稿</div>
          </div>
          <div className="stat">
            <div className="stat-label">软设定</div>
            <div className="stat-value">{stats.soft}</div>
            <div className="fs-12 muted" style={{ marginTop: 4 }}>倾向性约定，冲突只提示</div>
          </div>
          <div className="stat">
            <div className="stat-label">冲突</div>
            <div className="stat-value">{stats.conflict}</div>
            <div className="fs-12 muted" style={{ marginTop: 4 }}>与正文相抵，待裁定</div>
          </div>
          <div className="stat">
            <div className="stat-label">未引用</div>
            <div className="stat-value">{stats.unused}</div>
            <div className="fs-12 muted" style={{ marginTop: 4 }}>已写入，尚未出现在正文</div>
          </div>
        </div>

        {conflicts.length ? (
          <section className="card">
            <div className="card-head">
              <h2>冲突待裁定</h2>
              <span className="tag tag-danger">{`${conflicts.length} 处`}</span>
            </div>
            <div className="card-body">
              <div className="stack">
                {conflicts.map((w) => (
                  <div key={w.id} className="rule-card is-conflict">
                    <div className="rule-text">{w.rule}</div>
                    <div className="rule-meta">
                      <span className="row">
                        <span className="chip">{KIND_LABEL[w.kind]}</span>
                        <span className="chip">{w.category}</span>
                      </span>
                      <span className="tag tag-danger">冲突</span>
                    </div>
                    {refChips(w.refs)}
                    {w.note ? <div className="fs-12 muted" style={{ marginTop: 8 }}>{w.note}</div> : null}
                    <div className="row" style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy !== ''}
                        onClick={() => void resolve(w.id, 'keep_text')}
                      >
                        {busy === w.id ? '裁定中…' : '保留正文，改写规则'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy !== ''}
                        onClick={() => void resolve(w.id, 'keep_rule')}
                      >
                        按规则修改正文
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        disabled={busy !== ''}
                        onClick={() => void toggleKind(w)}
                      >
                        改为软设定
                      </button>
                    </div>
                  </div>
                ))}
                <div className="chart-note is-danger">
                  <strong>{`${conflicts.length} 处设定与正文相抵`}</strong>
                  {` · 两种裁定只记录结论：选「保留正文」会把规则降级为软设定，选「按规则修改正文」只登记待修订；正文的实际修改仍需走修订流程`}
                </div>
              </div>
            </div>
          </section>
        ) : null}

        <section className="card">
          <div className="card-head">
            <h2>设定清单</h2>
            <span className="tag tag-quiet">{`${visibleRules.length} 条`}</span>
          </div>
          <div className="card-body">
            {visibleRules.length ? (
              grouped.map((g) => (
                <div key={g.cat}>
                  <div className="cat-bar">
                    <span className="cat-name">{g.cat}</span>
                    <span className="mono fs-12">{`${g.rules.length} 条`}</span>
                  </div>
                  <div className="stack-8" style={{ marginTop: 12, marginBottom: 20 }}>
                    {g.rules.map((w) => (
                      <div
                        key={w.id}
                        className={classNames(
                          'rule-card',
                          w.status === 'conflict' && 'is-conflict',
                          w.kind === 'soft' && 'is-soft',
                          w.status === 'unused' && 'is-unused',
                        )}
                      >
                        {w.status === 'conflict' ? (
                          <>
                            <div className="rule-text">{w.rule}</div>
                            <div className="fs-12 muted" style={{ marginTop: 8 }}>见上方「冲突待裁定」</div>
                          </>
                        ) : (
                          <>
                            <div className="rule-text">{w.rule}</div>
                            <div className="rule-meta">
                              <span className="row">
                                <span className="chip">{KIND_LABEL[w.kind]}</span>
                                <span className="chip">{w.category}</span>
                              </span>
                              {statusTag(w)}
                            </div>
                            {refChips(w.refs)}
                            {w.note ? <div className="fs-12 muted" style={{ marginTop: 8 }}>{w.note}</div> : null}
                            <div className="row" style={{ marginTop: 10 }}>
                              <button
                                type="button"
                                className="btn btn-quiet btn-sm"
                                disabled={busy !== ''}
                                onClick={() => void toggleKind(w)}
                              >
                                {w.kind === 'hard' ? '改为软设定' : '改为硬约束'}
                              </button>
                              {w.kind === 'hard' ? (
                                <span className="fs-12 muted">硬约束：违反会阻塞定稿</span>
                              ) : (
                                <span className="fs-12 muted">软设定：只在审查时提示，不阻塞</span>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="empty">
                <Icon name="globe" size={24} />
                <span className="fs-12">该分类下暂无设定</span>
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>world.md 片段</h2>
            <span className="tag tag-quiet mono">{`更新于 ${world.updatedAt || '—'}`}</span>
          </div>
          <div className="card-body">
            <pre className="mono-block">{world.markdown || '（暂无内容）'}</pre>
            <div className="fs-12 muted" style={{ marginTop: 12 }}>
              这是机器数据的可读投影，改动请走界面，直接改文件会被覆盖。
            </div>
          </div>
        </section>
      </div>
    </>
  )
}
