import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { Loading } from '../components/Loading'
import { Crumb, TopBar } from '../components/Layout'
import { classNames, fmtInt, toast } from '../lib/ui'
import { useProject } from '../state/project'
import { decideProposal, request, runDisassemble } from '../api/client'

/**
 * 拆书 —— 导入已有作品，反推角色 / 世界观 / 伏笔 / 文风。
 *
 * 反推是一次完整分析（不是流式）：结果全部返回后统一展示。产出全部是「提案」，
 * 不会自动写入真相文件——只有点「接受」才会经校验写入，校验不过会原样回报原因。
 */

interface DSource {
  name: string
  chapters: number
  words: number
  format: string
  size: string
}

interface DStage {
  key: string
  title: string
  desc: string
  status: 'done' | 'active' | 'todo'
}

interface DStats {
  chapters?: number
  characters?: number
  worldRules?: number
  hooks?: number
  hooksMatched?: number
  tokens?: number
}

interface DChar {
  name: string
  role: string
  traits: string[]
  relations: number
}

interface DHook {
  content: string
  plantedChapter: number
  matched: number | null
  importance: string
}

interface DExtracted {
  characters?: DChar[]
  hooks?: DHook[]
  worldRules?: string[]
  style?: { sentence: string; pov: string; ratio: string }
}

interface DProposal {
  id: string
  kind: string
  content: string
  confidence: 'high' | 'medium' | 'low'
  decision: 'accept' | 'ignore' | null
}

interface DData {
  source: DSource | null
  stages: DStage[]
  stats: DStats
  extracted: DExtracted
  proposals: DProposal[]
  message?: string
}

/** 六个固定阶段（与后端 STAGE_TITLES 一致），用于未开跑时的占位与视觉推进 */
const STAGE_TITLES: { key: string; title: string; desc: string }[] = [
  { key: 'split', title: '切分章节', desc: '按标题与空行推断章节边界，纯本地完成' },
  { key: 'roles', title: '抽取角色与关系', desc: '识别角色、定位与相互关系' },
  { key: 'world', title: '抽取世界观规则', desc: '门派、地理、体系与硬约束' },
  { key: 'hooks', title: '抽取伏笔与回收', desc: '埋设点与回收点配对' },
  { key: 'style', title: '生成文风档案', desc: '句长、视角、描写比例与禁用表达' },
  { key: 'merge', title: '生成写入提案', desc: '产出待确认的写入提案，不直接写入' },
]

type TabKey = 'chars' | 'world' | 'hooks' | 'style'

const CONF: Record<string, { tag: string; label: string }> = {
  high: { tag: 'tag-ok', label: '高置信' },
  medium: { tag: 'tag-warn', label: '中置信' },
  low: { tag: 'tag-quiet', label: '低置信' },
}

const TEXT_EXT = ['.txt', '.md']

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试。')

/** 去掉空白后的字数（中文按字、英文按词都近似计入） */
function countWords(text: string): number {
  return text.replace(/\s+/g, '').length
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

/** 非原生控件（`div` 等）承载点击时必须键盘可达（契约 §12.7），写法照抄 Outline/Knowledge 的 `press` */
function press(handler: () => void, role: string | null = 'button') {
  return {
    ...(role ? { role } : {}),
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

export default function Disassemble() {
  const { projectId } = useProject()
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [error, setError] = useState('')
  const [data, setData] = useState<DData | null>(null)

  const [file, setFile] = useState<{ name: string; size: number; ext: string; words: number; text: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [running, setRunning] = useState(false)
  const [runStage, setRunStage] = useState(0)
  const [tab, setTab] = useState<TabKey>('chars')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const load = useCallback(async () => {
    if (!projectId) return
    setStatus('loading')
    try {
      const res = (await request(`/api/projects/${encodeURIComponent(projectId)}/disassemble`)) as DData
      setData(res)
      setStatus('ready')
    } catch (e) {
      setError(errMsg(e))
      setStatus('error')
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId) {
      setStatus('ready')
      setData(null)
      return
    }
    void load()
  }, [projectId, load])

  useEffect(() => {
    if (!running) return
    setRunStage(0)
    const timer = window.setInterval(() => {
      setRunStage((s) => Math.min(s + 1, STAGE_TITLES.length - 1))
    }, 1400)
    return () => window.clearInterval(timer)
  }, [running])

  const acceptFile = useCallback((f: File) => {
    const ext = extOf(f.name)
    if (!TEXT_EXT.includes(ext)) {
      toast('只支持 txt / md 纯文本文件', 'warn')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      if (text.replace(/\s+/g, '').length < 200) {
        toast('文本太短了，请换一个更完整的作品', 'warn')
        return
      }
      setFile({ name: f.name, size: f.size, ext, words: countWords(text), text })
      toast(`已载入：${f.name}`, 'ok')
    }
    reader.onerror = () => toast('文件读取失败，请重试', 'error')
    reader.readAsText(f, 'utf-8')
  }, [])

  const startRun = useCallback(async () => {
    const id = projectId
    if (!id || !file) {
      toast('先导入一个 txt / md 文件', 'warn')
      return
    }
    setRunning(true)
    try {
      const res = (await runDisassemble(id, {
        filename: file.name,
        text: file.text,
        sampleRatio: 1,
      })) as DData
      setData(res)
      toast('反推完成，结果已生成', 'ok')
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setRunning(false)
    }
  }, [projectId, file])

  const decide = useCallback(
    async (pid: string, action: 'accept' | 'reject' | null) => {
      const id = projectId
      if (!id) return
      setBusy(pid)
      try {
        const res = (await decideProposal(id, pid, action as unknown as string)) as {
          ok: boolean
          decision?: 'accept' | 'ignore' | null
          message?: string
        }
        if (!res.ok) {
          toast(res.message || '这条提案没有写入', 'error')
          return
        }
        setData((prev) =>
          prev
            ? {
                ...prev,
                proposals: prev.proposals.map((p) =>
                  p.id === pid ? { ...p, decision: res.decision ?? null } : p,
                ),
              }
            : prev,
        )
        toast(
          action === 'accept' ? '已接受该提案' : action === 'reject' ? '已拒绝该提案' : '已撤回决策',
          'ok',
        )
      } catch (e) {
        toast(errMsg(e), 'error')
      } finally {
        setBusy(null)
      }
    },
    [projectId],
  )

  const acceptAll = useCallback(async () => {
    const id = projectId
    if (!id || !data) return
    setBusy('all')
    const updated = [...data.proposals]
    const failed: string[] = []
    for (const p of data.proposals) {
      if (p.decision === 'accept') continue
      try {
        const res = (await decideProposal(id, p.id, 'accept')) as {
          ok: boolean
          decision?: 'accept' | 'ignore' | null
          message?: string
        }
        if (res.ok) {
          const idx = updated.findIndex((x) => x.id === p.id)
          if (idx >= 0) updated[idx] = { ...updated[idx], decision: res.decision ?? 'accept' }
        } else {
          failed.push(`${p.kind}：${res.message || '未写入'}`)
        }
      } catch (e) {
        failed.push(`${p.kind}：${errMsg(e)}`)
      }
    }
    setData((prev) => (prev ? { ...prev, proposals: updated } : prev))
    setBusy(null)
    setConfirmOpen(false)
    if (failed.length > 0) {
      toast(`${failed.length} 条未写入：${failed[0]}`, 'warn')
    } else {
      toast('已接受全部提案', 'ok')
    }
  }, [projectId, data])

  const steps: DStage[] = running
    ? STAGE_TITLES.map((s, i) => ({
        ...s,
        status: i < runStage ? 'done' : i === runStage ? 'active' : 'todo',
      }))
    : data && data.stages && data.stages.length > 0
      ? data.stages
      : STAGE_TITLES.map((s) => ({ ...s, status: 'todo' as const }))

  const stats = data?.stats ?? {}
  const ex = data?.extracted ?? {}
  const proposals = data?.proposals ?? []
  const pending = proposals.filter((p) => p.decision === null).length
  const hasStats = typeof stats.chapters === 'number'
  const hasExtracted = Array.isArray(ex.characters) && ex.characters.length >= 0 && !!data?.source

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'chars', label: '角色' },
    { key: 'world', label: '世界观' },
    { key: 'hooks', label: '伏笔' },
    { key: 'style', label: '文风' },
  ]

  return (
    <>
      <TopBar
        title="拆书"
        sub="把已有作品反推成结构化设定——角色、世界观、伏笔、文风"
        crumb={
          <Crumb
            items={[{ label: '我的作品', to: '/' }, { label: '拆书' }]}
          />
        }
        actions={
          <Link className="btn btn-ghost btn-sm" to="/">
            <Icon name="arrow-left" size={16} />
            返回全部作品
          </Link>
        }
      />

      {!projectId ? (
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="upload" size={24} />
              <div className="fs-16 serif">还没有选择作品</div>
              <div className="fs-13">拆书结果会归到某个作品下，先选一个作品</div>
              <Link className="btn btn-primary btn-sm" to="/">
                去我的作品
              </Link>
            </div>
          </div>
        </section>
      ) : status === 'loading' ? (
        <Loading text="正在加载拆书结果…" />
      ) : status === 'error' ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <div className="stack-24">
          {/* 导入 */}
          <section className="card">
            <div className="card-head">
              <h2>导入作品</h2>
              <span className="tag tag-quiet">txt / md 纯文本</span>
            </div>
            <div className="card-body stack">
              <div
                className={classNames('dropzone', dragging && 'is-over')}
                aria-label="选择要拆解的文件"
                {...press(() => inputRef.current?.click())}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragging(false)
                  const f = e.dataTransfer.files?.[0]
                  if (f) acceptFile(f)
                }}
              >
                <Icon name="upload" size={24} />
                <div className="fs-14">拖入 .txt / .md 文件，或点击选择</div>
                <div className="fs-12">支持 txt / md 纯文本；解析在服务端进行，不调用模型</div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    inputRef.current?.click()
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  选择文件
                </button>
              </div>
              {!file ? (
                <div className="fs-13 muted">
                  {data?.source
                    ? '想换一本，就再导入一个文件'
                    : '导入已有作品，反推结构，用于旧作续写 / 同题材仿写 / 竞品结构分析'}
                </div>
              ) : (
                <div className="list-row">
                  <div className="row-main">
                    <div className="row-title">{file.name}</div>
                    <div className="row-sub">
                      {file.ext.toUpperCase()} · {(file.size / 1024).toFixed(0)} KB ·{' '}
                      {fmtInt(file.words)} 字
                    </div>
                  </div>
                  <span className="tag tag-ok">已载入</span>
                </div>
              )}
              <input
                ref={inputRef}
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) acceptFile(f)
                  e.target.value = ''
                }}
              />
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void startRun()}
                  disabled={running || !file}
                >
                  {running ? '正在反推…' : data?.source ? '重新反推' : '开始反推'}
                </button>
                {running ? <span className="fs-12 muted">反推可能耗时较久，请稍候</span> : null}
              </div>
            </div>
          </section>

          {/* 统计条 */}
          {hasStats ? (
            <div className="grid-4">
              <div className="stat">
                <div className="stat-label">章节</div>
                <div className="stat-value fs-20">{fmtInt(stats.chapters ?? 0)}</div>
                <div className="fs-12 muted">按标题与空行推断边界</div>
              </div>
              <div className="stat">
                <div className="stat-label">角色</div>
                <div className="stat-value fs-20">{fmtInt(stats.characters ?? 0)}</div>
                <div className="fs-12 muted">含同人异名归并</div>
              </div>
              <div className="stat">
                <div className="stat-label">世界观规则</div>
                <div className="stat-value fs-20">{fmtInt(stats.worldRules ?? 0)}</div>
                <div className="fs-12 muted">门派、地理与武力体系</div>
              </div>
              <div className="stat">
                <div className="stat-label">伏笔</div>
                <div className="stat-value fs-20">{fmtInt(stats.hooks ?? 0)}</div>
                <div className="fs-12 muted">已匹配回收 {fmtInt(stats.hooksMatched ?? 0)} 条</div>
              </div>
              <div className="stat">
                <div className="stat-label" title="tokens">
                  消耗额度
                </div>
                <div className="stat-value fs-20">{fmtInt(stats.tokens ?? 0)}</div>
                <div className="fs-12 muted">本次反推合计</div>
              </div>
            </div>
          ) : null}

          <div className="split">
            {/* 反推流水线 */}
            <section className="card">
              <div className="card-head">
                <h2>反推流水线</h2>
                <span className="tag tag-info">6 阶段</span>
              </div>
              <div className="card-body">
                {running ? (
                  <div className="fs-12 muted" style={{ marginBottom: 12 }}>
                    反推为一次完整分析，结果返回后统一展示
                  </div>
                ) : null}
                <div className="steps">
                  {steps.map((st, i) => (
                    <div className="step-item" key={st.key}>
                      <div className="step-rail">
                        <div
                          className={classNames(
                            'step-dot',
                            st.status === 'done' && 'is-done',
                            st.status === 'active' && 'is-active',
                          )}
                        >
                          {st.status === 'done' ? <Icon name="check" size={16} /> : i + 1}
                        </div>
                        {i < steps.length - 1 ? <div className="step-line" /> : null}
                      </div>
                      <div className="step-body">
                        <div className="step-title">{st.title}</div>
                        <div className="step-desc">{st.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* 抽取结果 */}
            <section className="card">
              <div className="card-head">
                <h2>抽取结果</h2>
                <span className="tag tag-quiet">4 类</span>
              </div>
              <div className="card-body">
                {!hasExtracted ? (
                  <div className="empty">
                    <Icon name="search" size={24} />
                    <div className="fs-13">反推完成后，这里会列出抽到的内容</div>
                  </div>
                ) : (
                  <>
                    <div className="tabs">
                      {TABS.map((t) => (
                        <button
                          key={t.key}
                          type="button"
                          className={classNames('tab', tab === t.key && 'active')}
                          onClick={() => setTab(t.key)}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                    <div className="tabpanel active" style={{ marginTop: 16 }}>
                      {tab === 'chars' ? (
                        (ex.characters ?? []).length > 0 ? (
                          <div className="list">
                            {(ex.characters ?? []).map((c) => (
                              <div className="list-row" key={c.name}>
                                <div className="char-item" style={{ flex: 1, minWidth: 0 }}>
                                  <div
                                    className={classNames(
                                      'char-avatar',
                                      c.role === '主角' && 'is-lead',
                                    )}
                                  >
                                    {c.name.charAt(0)}
                                  </div>
                                  <div className="row-main">
                                    <div className="row-title">
                                      {c.name} <span className="chip">{c.role}</span>
                                    </div>
                                    <div className="row-sub">
                                      {(c.traits ?? []).join(' · ') || '未提取到特征'}
                                    </div>
                                  </div>
                                </div>
                                <span className="fs-12 muted">关系 {c.relations}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="fs-13 muted">没有抽到角色</div>
                        )
                      ) : null}

                      {tab === 'world' ? (
                        (ex.worldRules ?? []).length > 0 ? (
                          <div className="trait-list">
                            {(ex.worldRules ?? []).map((r, i) => (
                              <div className="trait" key={`${r}-${i}`}>
                                <i />
                                <span>{r}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="fs-13 muted">没有抽到世界观规则</div>
                        )
                      ) : null}

                      {tab === 'hooks' ? (
                        (ex.hooks ?? []).length > 0 ? (
                          <div className="stack-8">
                            {(ex.hooks ?? []).map((h, i) => (
                              <div className="audit-item" key={`${h.content}-${i}`}>
                                <div className="row-between">
                                  <span className="fs-13">{h.content}</span>
                                  <span
                                    className={classNames(
                                      'tag',
                                      h.importance === 'major' ? 'tag-seal' : 'tag-quiet',
                                    )}
                                  >
                                    {h.importance === 'major' ? '主线' : '支线'}
                                  </span>
                                </div>
                                <div className="audit-fix">
                                  埋于第 {h.plantedChapter} 章 ·{' '}
                                  {h.matched != null
                                    ? `回收于第 ${h.matched} 章`
                                    : '未匹配到回收点'}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="fs-13 muted">没有抽到伏笔</div>
                        )
                      ) : null}

                      {tab === 'style' && ex.style ? (
                        <div className="kv">
                          <div className="kv-row">
                            <span className="kv-key">句式</span>
                            <span className="kv-val">{ex.style.sentence || '—'}</span>
                          </div>
                          <div className="kv-row">
                            <span className="kv-key">视角</span>
                            <span className="kv-val">{ex.style.pov || '—'}</span>
                          </div>
                          <div className="kv-row">
                            <span className="kv-key">比例</span>
                            <span className="kv-val">{ex.style.ratio || '—'}</span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            </section>
          </div>

          {/* 写入提案 */}
          <section className="card">
            <div className="card-head">
              <h2>写入提案</h2>
              <div className="row">
                <span className="tag tag-warn">待确认 {pending} 项</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setConfirmOpen(true)}
                  disabled={busy !== null || proposals.length === 0}
                >
                  全部接受
                </button>
              </div>
            </div>
            <div className="card-body stack">
              <div className="chart-note is-warn">
                <strong>拆书结果不会自动写入。</strong> 只有点「接受」才会经校验写入真相文件；
                校验不过会原样回报原因，不会把失败显示成成功。
              </div>
              {proposals.length === 0 ? (
                <div className="empty">
                  <Icon name="bookmark" size={24} />
                  <div className="fs-13">反推完成后，这里会列出待确认的写入提案</div>
                </div>
              ) : (
                <div className="stack-8">
                  {proposals.map((p) => {
                    const conf = CONF[p.confidence] ?? CONF.medium
                    const working = busy === p.id
                    return (
                      <div className="audit-item" key={p.id}>
                        <div className="row-between">
                          <span className="fs-13">{p.content}</span>
                          {p.decision === 'accept' ? (
                            <span className="tag tag-ok">已接受</span>
                          ) : p.decision === 'ignore' ? (
                            <span className="tag tag-quiet">已拒绝</span>
                          ) : (
                            <span className={classNames('tag', conf.tag)} title={p.confidence}>
                              {conf.label}
                            </span>
                          )}
                        </div>
                        <div className="row-between" style={{ marginTop: 10 }}>
                          <span className="chip">{p.kind}</span>
                          <div className="row">
                            {p.decision === 'accept' || p.decision === 'ignore' ? (
                              <button
                                type="button"
                                className="btn btn-quiet btn-sm"
                                onClick={() => void decide(p.id, null)}
                                disabled={busy !== null}
                              >
                                撤回
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  onClick={() => void decide(p.id, 'accept')}
                                  disabled={busy !== null}
                                >
                                  {working ? '写入中…' : '接受'}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => void decide(p.id, 'reject')}
                                  disabled={busy !== null}
                                >
                                  拒绝
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {/* 全部接受二次确认 */}
      {confirmOpen ? (
        <div className="modal">
          <div className="modal-veil" onClick={() => (busy ? undefined : setConfirmOpen(false))} />
          <div className="modal-card">
            <div className="card-head">
              <h2>全部接受提案</h2>
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                onClick={() => setConfirmOpen(false)}
                disabled={busy !== null}
              >
                关闭
              </button>
            </div>
            <div className="card-body stack">
              <p className="fs-13 muted">
                将接受全部 {proposals.length} 条提案，写入角色 / 世界观 / 伏笔 / 文风，可能影响已有设定。
              </p>
              <p className="fs-12 muted">
                写入会逐条经校验；校验不过的条目会原样回报原因，不会静默覆盖。
              </p>
            </div>
            <div className="card-foot row" style={{ justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmOpen(false)}
                disabled={busy !== null}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void acceptAll()}
                disabled={busy !== null}
              >
                {busy === 'all' ? '写入中…' : '确认全部接受'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
