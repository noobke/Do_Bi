import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { Loading } from '../components/Loading'
import { TopBar } from '../components/Layout'
import { classNames, toast } from '../lib/ui'
import { useProject } from '../state/project'
import { decideFinding, getAuditReport, runAudit } from '../api/client'

/**
 * 审计报告 —— 对接 `GET /api/projects/{id}/audit`。
 *
 * 一页回答三个问题：这一章有没有问题（规则校验 + 模型审查）、每条问题凭什么
 * （原文证据）、改了什么（改动预览）。所有数字都来自接口，不写死。
 */

type Severity = 'blocker' | 'major' | 'minor'
type Decision = 'accept' | 'ignore' | null

interface L1Row {
  rule: string
  hit: string
  count: number
  threshold: number
  isHit: boolean
}

interface L1Violation {
  rule: string
  hit: string
  count: number
  threshold: number
  samples: string[]
}

interface Finding {
  dim: string
  severity: Severity
  evidence: string
  suggestion: string
  ref: string
  fixed: boolean
  decision: Decision
  patch?: unknown
}

interface ReviewRow {
  dim: string
  score: number
  evidence: string
  note: string
}

interface DiffBlock {
  dim: string
  before: string[]
  after: string[]
}

interface AuditStats {
  l1?: number
  l2?: number
  fixed?: number
  open?: number
  blocker?: number
  major?: number
  passRate?: number
}

interface Report {
  chapter: number | null
  title?: string
  l1Checked?: L1Row[]
  l1Violations?: L1Violation[]
  items?: Finding[]
  review?: ReviewRow[]
  diffs?: DiffBlock[]
  stats?: AuditStats
  generatedAt?: string
  chapters?: number[]
  message?: string
}

/** 严重度 → 作者可读文案；原术语收进 title（不在正文里挡路） */
const SEV: Record<Severity, { tag: string; label: string; raw: string }> = {
  blocker: { tag: 'tag-danger', label: '阻塞定稿', raw: 'blocker' },
  major: { tag: 'tag-warn', label: '重点', raw: 'major' },
  minor: { tag: 'tag-quiet', label: '建议', raw: 'minor' },
}

type Filter = 'all' | 'major' | 'minor'
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'major', label: '仅重点' },
  { value: 'minor', label: '仅建议' },
]

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试。')

/** 改动预览：删除行 / 新增行 */
function DiffView({ block }: { block: DiffBlock }) {
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="mono fs-12">{block.dim}</span>
        <span className="tag tag-quiet" title="JSON Patch">
          改动预览
        </span>
      </div>
      {(block.before ?? []).map((line, i) => (
        <div className="diff-line is-del" key={`b${i}`}>
          <span className="diff-gutter">-</span>
          <span className="diff-text diff-del">{line}</span>
        </div>
      ))}
      {(block.after ?? []).map((line, i) => (
        <div className="diff-line is-add" key={`a${i}`}>
          <span className="diff-gutter">+</span>
          <span className="diff-text diff-add">{line}</span>
        </div>
      ))}
    </div>
  )
}

function Stat({
  label,
  title,
  value,
  sub,
}: {
  label: string
  title?: string
  value: string
  sub: string
}) {
  return (
    <div className="stat">
      <div className="stat-label" title={title}>
        {label}
      </div>
      <div className="stat-value fs-20">{value}</div>
      <div className="fs-12 muted">{sub}</div>
    </div>
  )
}

export default function Audit() {
  const { projectId } = useProject()

  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [error, setError] = useState('')
  const [report, setReport] = useState<Report | null>(null)
  const [chapter, setChapter] = useState<number | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [openDiffs, setOpenDiffs] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(
    async (ch: number | null) => {
      if (!projectId) return
      setStatus('loading')
      try {
        const res = (await getAuditReport(projectId, ch ?? undefined)) as Report
        setReport(res)
        setStatus('ready')
      } catch (e) {
        setError(errMsg(e))
        setStatus('error')
      }
    },
    [projectId],
  )

  useEffect(() => {
    if (!projectId) {
      setStatus('ready')
      setReport(null)
      return
    }
    void load(chapter)
  }, [projectId, chapter, load])

  const chapterNow = chapter ?? report?.chapter ?? null
  const stats = report?.stats ?? {}
  const l1Rows = report?.l1Checked ?? []
  const findings = report?.items ?? []
  const diffs = report?.diffs ?? []
  const review = report?.review ?? []

  const sampleMap = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const v of report?.l1Violations ?? []) m.set(v.rule, v.samples ?? [])
    return m
  }, [report])

  const hitCount = l1Rows.filter((r) => r.isHit).length
  const shownFindings = findings.filter((f) => filter === 'all' || f.severity === filter)

  const reaudit = useCallback(async () => {
    const id = projectId
    const n = chapter ?? report?.chapter ?? null
    if (!id || n == null) return
    setBusy('audit')
    try {
      await runAudit(id, n)
      await load(n)
      toast('审查已完成，报告已更新', 'ok')
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(null)
    }
  }, [projectId, chapter, report, load])

  const decide = useCallback(
    async (dim: string, action: Decision) => {
      const id = projectId
      const n = chapter ?? report?.chapter ?? null
      if (!id || n == null) return
      setBusy(`${dim}:${action ?? 'undo'}`)
      try {
        const res = (await decideFinding(id, n, dim, action as unknown as string)) as {
          stats?: AuditStats
        }
        setReport((prev) =>
          prev
            ? {
                ...prev,
                stats: res?.stats ?? prev.stats,
                items: (prev.items ?? []).map((it) =>
                  it.dim === dim
                    ? { ...it, decision: action, fixed: action === 'accept' && !!it.patch }
                    : it,
                ),
              }
            : prev,
        )
        const msg =
          action === 'accept'
            ? `已接受修订：${dim}`
            : action === 'ignore'
              ? `已忽略：${dim}`
              : `已撤回决策：${dim}`
        toast(msg, 'ok')
      } catch (e) {
        toast(errMsg(e), 'error')
      } finally {
        setBusy(null)
      }
    },
    [projectId, chapter, report],
  )

  const sub =
    report && report.chapter != null
      ? `第 ${report.chapter} 章${report.title ? ` · ${report.title}` : ''}` +
        `${report.generatedAt ? ` · ${report.generatedAt} 生成` : ''}`
      : undefined

  const topActions = (
    <>
      {report && (report.chapters?.length ?? 0) > 0 ? (
        <select
          className="select"
          style={{ width: 118, height: 28 }}
          aria-label="选择要查看的章节"
          value={chapterNow ?? ''}
          onChange={(e) => setChapter(Number(e.target.value))}
          disabled={busy !== null}
        >
          {(report.chapters ?? []).map((n) => (
            <option key={n} value={n}>
              第 {n} 章
            </option>
          ))}
        </select>
      ) : null}
      {chapterNow != null ? (
        <Link className="btn btn-ghost btn-sm" to={`/chapter/${chapterNow}`}>
          本章详情
        </Link>
      ) : null}
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => void reaudit()}
        disabled={busy !== null || chapterNow == null}
      >
        <Icon name="refresh-cw" size={16} />
        {busy === 'audit' ? '审查中…' : '重新审查'}
      </button>
    </>
  )

  return (
    <>
      <TopBar title="审计报告" sub={sub} actions={topActions} />

      {!projectId ? (
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="clipboard-check" size={24} />
              <div className="fs-16 serif">还没有选择作品</div>
              <div className="fs-13">先选一个作品，再回来看它的审查报告</div>
              <Link className="btn btn-primary btn-sm" to="/">
                去我的作品
              </Link>
            </div>
          </div>
        </section>
      ) : status === 'loading' ? (
        <Loading text="正在加载审查报告…" />
      ) : status === 'error' ? (
        <ErrorState message={error} onRetry={() => void load(chapter)} />
      ) : report && report.chapter == null ? (
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="clipboard-check" size={24} />
              <div className="fs-16 serif">还没有审查报告</div>
              <div className="fs-13">{report.message || '这一章还没有跑过审查。'}</div>
              <div className="fs-12 muted">先去工作台写一章，写完再跑一次审查，报告会出现在这里</div>
              <Link className="btn btn-primary btn-sm" to="/workbench">
                去工作台
              </Link>
            </div>
          </div>
        </section>
      ) : (
        <div className="stack-24">
          {/* 统计条：全部运行时计算，不写死 */}
          <div className="grid-3">
            <Stat
              label="规则命中"
              title="L1 确定性规则"
              value={String(stats.l1 ?? 0)}
              sub={`${l1Rows.length} 条规则中命中 ${hitCount} 条`}
            />
            <Stat
              label="模型审查条数"
              title="L2 模型审查"
              value={String(stats.l2 ?? 0)}
              sub="按维度给出的发现"
            />
            <Stat label="已处理" value={String(stats.fixed ?? 0)} sub="已接受修订" />
            <Stat label="待处理" value={String(stats.open ?? 0)} sub="尚未裁定" />
            <Stat
              label="阻塞定稿"
              title="blocker"
              value={String(stats.blocker ?? 0)}
              sub="未解决前不建议定稿"
            />
            <Stat label="通过率" value={`${stats.passRate ?? 0}%`} sub="目标 ≥ 90%" />
          </div>

          <div className="split">
            <div className="stack-24">
              {/* 规则校验 */}
              <section className="card">
                <div className="card-head">
                  <h2 title="L1 确定性规则">规则校验 · {l1Rows.length} 条</h2>
                  <span className="tag tag-warn">命中 {hitCount} 条</span>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  {l1Rows.map((row) => {
                    const samples = sampleMap.get(row.rule) ?? []
                    const countText = row.isHit
                      ? `${row.hit ? `${row.hit} · ` : ''}${row.count}/${row.threshold}`
                      : `${row.count}`
                    return (
                      <div
                        className={classNames('rule-row', row.isHit && 'is-hit')}
                        key={row.rule}
                      >
                        <span className="rule-name">{row.rule}</span>
                        <span className="wrap-row" style={{ justifyContent: 'flex-end' }}>
                          {row.isHit
                            ? samples.map((s, i) => (
                                <span className="chip" key={`${row.rule}-${i}`}>
                                  {s}
                                </span>
                              ))
                            : null}
                          <span className="rule-count">{countText}</span>
                        </span>
                      </div>
                    )
                  })}
                </div>
                <div className="card-foot">
                  <div className="fs-12 muted" title="L1 确定性规则 · spot-fix 定点改写">
                    规则校验为零成本确定性规则，命中后只定点改写违规句，不整段重写
                  </div>
                </div>
              </section>

              {/* 模型审查 */}
              <section className="card">
                <div className="card-head">
                  <h2 title="L2 模型审查">模型审查发现</h2>
                  <div className="row">
                    <span className="tag tag-quiet">{shownFindings.length} 条</span>
                    <div className="seg">
                      {FILTERS.map((f) => (
                        <button
                          key={f.value}
                          type="button"
                          className={filter === f.value ? 'active' : undefined}
                          onClick={() => setFilter(f.value)}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="card-body">
                  {shownFindings.length === 0 ? (
                    <div className="empty">
                      <Icon name="check" size={24} />
                      <div className="fs-13">当前筛选下没有发现</div>
                    </div>
                  ) : (
                    <div className="stack-8">
                      {shownFindings.map((f) => {
                        const sev = SEV[f.severity] ?? SEV.minor
                        const matched = diffs.find((d) => d.dim === f.dim)
                        const expanded = !!openDiffs[f.dim]
                        const working = busy?.startsWith(`${f.dim}:`) ?? false
                        return (
                          <div
                            className={classNames('audit-item', `sev-${f.severity}`)}
                            key={f.dim}
                          >
                            <div className="row-between">
                              <span className="fs-13" style={{ fontWeight: 500 }}>
                                {f.dim}
                              </span>
                              {f.decision === 'accept' ? (
                                <span className="tag tag-ok">已接受</span>
                              ) : f.decision === 'ignore' ? (
                                <span className="tag tag-quiet">已忽略</span>
                              ) : (
                                <span className={classNames('tag', sev.tag)} title={sev.raw}>
                                  {sev.label}
                                </span>
                              )}
                            </div>
                            <div className="audit-evidence" title="原文证据（可举证）">
                              {f.evidence}
                            </div>
                            {f.suggestion ? <div className="audit-fix">{f.suggestion}</div> : null}
                            <div className="row-between" style={{ marginTop: 10 }}>
                              <span className="row">
                                <span className="fs-12 muted">证据位置：</span>
                                <span className="mono fs-12">{f.ref}</span>
                              </span>
                              <div className="row">
                                {f.decision === 'accept' || f.decision === 'ignore' ? (
                                  <button
                                    type="button"
                                    className="btn btn-quiet btn-sm"
                                    onClick={() => void decide(f.dim, null)}
                                    disabled={busy !== null}
                                  >
                                    撤回
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      className="btn btn-primary btn-sm"
                                      onClick={() => void decide(f.dim, 'accept')}
                                      disabled={busy !== null}
                                    >
                                      {working ? '处理中…' : '接受修订'}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-sm"
                                      onClick={() => void decide(f.dim, 'ignore')}
                                      disabled={busy !== null}
                                    >
                                      忽略
                                    </button>
                                    {f.patch ? (
                                      <button
                                        type="button"
                                        className="btn btn-quiet btn-sm"
                                        onClick={() =>
                                          setOpenDiffs((prev) => ({
                                            ...prev,
                                            [f.dim]: !prev[f.dim],
                                          }))
                                        }
                                      >
                                        {expanded ? '收起改动' : '查看改动'}
                                      </button>
                                    ) : null}
                                  </>
                                )}
                              </div>
                            </div>
                            {expanded ? (
                              <div style={{ marginTop: 10 }}>
                                {matched ? (
                                  <DiffView block={matched} />
                                ) : (
                                  <div className="fs-12 muted">本条暂无改动预览</div>
                                )}
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <div className="fs-12 muted" style={{ marginTop: 12 }}>
                    接受＝按建议改；忽略＝保留原文并记账；撤回＝取消这次决策
                  </div>
                </div>
              </section>
            </div>

            <div className="stack-24">
              {/* 可举证评审 */}
              <section className="card">
                <div className="card-head">
                  <h2>可举证评审</h2>
                  <span className="tag tag-info">{review.length} 维 · 均引原文</span>
                </div>
                <div className="card-body">
                  {review.length === 0 ? (
                    <div className="empty">
                      <Icon name="info" size={24} />
                      <div className="fs-13">这一章还没有评审</div>
                    </div>
                  ) : (
                    <div className="stack">
                      {review.map((it, i) => (
                        <div className="stack-8" key={it.dim}>
                          {i > 0 ? <div className="divider" style={{ margin: 0 }} /> : null}
                          <div className="score-row">
                            <span className="score-name">{it.dim}</span>
                            <span className="score-bar">
                              <i style={{ width: `${Math.max(0, Math.min(100, it.score))}%` }} />
                            </span>
                            <span className="score-val">{it.score}</span>
                          </div>
                          <div className="audit-evidence">{it.evidence}</div>
                          {it.note ? <div className="fs-12 muted">{it.note}</div> : null}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="divider" />
                  <div className="fs-12 muted">没有原文证据的结论会被直接丢弃，不进入报告</div>
                </div>
              </section>

              {/* 改动预览：只有真的有改动才给这一区 */}
              {diffs.length > 0 ? (
                <section className="card">
                  <div className="card-head">
                    <h2>改动预览</h2>
                    <span className="tag tag-quiet">{diffs.length} 处</span>
                  </div>
                  <div className="card-body">
                    <div className="stack">
                      {diffs.map((d, i) => (
                        <DiffView block={d} key={`${d.dim}-${i}`} />
                      ))}
                    </div>
                  </div>
                </section>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
