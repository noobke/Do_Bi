import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { Loading } from '../components/Loading'
import { TopBar } from '../components/Layout'
import { classNames, fmtInt, fmtMoney, toast } from '../lib/ui'
import { useProject } from '../state/project'
import { createProject, getOverview, getUsage, health, listProjects, request } from '../api/client'

/**
 * 我的作品（首页）—— 项目总览 / 继续创作 / 新建 / 拆书入口。
 * 数据来自 `GET /api/projects`（列表）与 `GET /api/projects/{id}/overview`（继续创作的恢复建议）。
 */

interface ProjectSummary {
  id: string
  title: string
  genre: string
  logline: string
  mode: string
  chaptersDone: number
  chaptersTotal: number
  words: number
  budgetUsed: number
  budgetTotal: number
  updatedAt: string
  hooksResolved: number
  hooksTotal: number
  auditPass: number
  isCurrent?: boolean
}

interface Resume {
  action: string
  label: string
  chapter: number
  stepLabel: string
  reason: string
}

interface HealthPayload {
  providers?: { configured?: boolean; message?: string }
}

/** 一段生成记录（后端 `usage.jsonl` 的 `UsageEntry`，经 `GET /usage` 的 recent 返回） */
interface UsageEntry {
  chapter: number
  step: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
  ts: string
}

interface UsageData {
  recent: UsageEntry[]
}

/** 生产环节取值 → 作者可读文案（与后端 STEP_LABELS 一致；英文原词只留在 title） */
const STEP_LABEL: Record<string, string> = {
  plan: '章纲',
  context: '上下文组装',
  draft: '草稿',
  audit: '规则与模型审查',
  review: '可举证评审',
  deai: '去 AI 味',
  revise: '修订',
  commit: '定稿',
  style: '文风分析',
}

/** 用量流水的时间戳（ISO）→ 「月-日 时:分」；缺失时留空占位 */
function fmtTs(ts: string): string {
  return ts ? ts.slice(5, 16).replace('T', ' ') : '—'
}

/** 干预模式取值 → 作者可读文案（与后端 modeLabel 一套） */
const MODE_LABEL: Record<string, string> = {
  auto: '全自动',
  'semi-auto': '半自动',
  manual: '手动逐步',
}

const MODE_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: '全自动' },
  { value: 'semi-auto', label: '半自动' },
  { value: 'manual', label: '手动逐步' },
]

const GENRES = ['古风悬疑', '玄幻', '武侠', '科幻', '都市', '待定']

/** 设为「当前作品」（client.ts 未导出对应方法，直接用 request 调后端） */
const openProject = (id: string) =>
  request(`/api/projects/${encodeURIComponent(id)}/open`, { method: 'POST' })

/** 书脊色轮换：index % 4 → 无修饰 / is-2 / is-3 / is-4 */
function spineClass(i: number): string {
  return classNames(
    'proj-spine',
    i % 4 === 1 && 'is-2',
    i % 4 === 2 && 'is-3',
    i % 4 === 3 && 'is-4',
  )
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试。')

export default function Projects() {
  const navigate = useNavigate()
  const { setCurrent: setCurrentProject } = useProject()

  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [resume, setResume] = useState<Resume | null>(null)
  const [recent, setRecent] = useState<UsageEntry[]>([])
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [error, setError] = useState('')
  const [warn, setWarn] = useState<string | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [fTitle, setFTitle] = useState('')
  const [fGenre, setFGenre] = useState(GENRES[0])
  const [fPremise, setFPremise] = useState('')
  const [fMode, setFMode] = useState('semi-auto')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const res = (await listProjects()) as { projects: ProjectSummary[]; current: string | null }
      const list = res.projects ?? []
      setProjects(list)
      const cur = res.current ?? list[0]?.id ?? null
      setCurrentId(cur)
      if (cur) setCurrentProject(cur)
      setStatus('ready')
      if (cur) {
        try {
          const ov = (await getOverview(cur)) as { resume: Resume }
          setResume(ov.resume ?? null)
        } catch {
          setResume(null)
        }
        // 最近生成记录：取当前作品用量流水里最新的几条（`GET /usage` → recent）
        try {
          const usage = (await getUsage(cur)) as UsageData
          setRecent(usage.recent ?? [])
        } catch {
          setRecent([])
        }
      } else {
        setResume(null)
        setRecent([])
      }
    } catch (e) {
      setError(errMsg(e))
      setStatus('error')
    }
  }, [setCurrentProject])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    health()
      .then((h) => {
        const info = h as HealthPayload
        if (info?.providers && info.providers.configured === false) {
          setWarn(info.providers.message || '尚未配置模型密钥，生成类功能暂不可用。')
        }
      })
      .catch(() => {
        /* 健康检查失败不阻塞首页 */
      })
  }, [])

  const open = useCallback(
    async (p: ProjectSummary, forceWorkbench = false) => {
      try {
        await openProject(p.id)
        setCurrentProject(p.id)
        setCurrentId(p.id)
      } catch (e) {
        toast(errMsg(e), 'error')
        return
      }
      const started = p.chaptersDone > 0
      navigate(forceWorkbench || started ? '/workbench' : '/chat')
    },
    [navigate, setCurrentProject],
  )

  const submitCreate = useCallback(async () => {
    const title = fTitle.trim()
    if (!title) {
      toast('先给作品起个名字', 'warn')
      return
    }
    setCreating(true)
    try {
      const res = (await createProject({
        title,
        genre: fGenre,
        premise: fPremise.trim(),
        mode: fMode,
      })) as { project?: { id?: string } }
      const id = res?.project?.id
      if (id) {
        await openProject(id)
        setCurrentProject(id)
      }
      setModalOpen(false)
      setFTitle('')
      setFPremise('')
      await load()
      toast(`已创建《${title}》`, 'ok')
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setCreating(false)
    }
  }, [fTitle, fGenre, fPremise, fMode, load, setCurrentProject])

  const totalWords = projects.reduce((s, p) => s + p.words, 0)
  const ongoing = projects.filter((p) => p.chaptersDone > 0).length
  const hooksTotal = projects.reduce((s, p) => s + p.hooksTotal, 0)
  const hooksDone = projects.reduce((s, p) => s + p.hooksResolved, 0)
  const hookRate = hooksTotal ? Math.round((hooksDone / hooksTotal) * 100) : 0
  const totalCost = projects.reduce((s, p) => s + p.budgetUsed, 0)
  const currentProject = projects.find((p) => p.id === currentId) ?? null

  const sub =
    status === 'ready' ? `${projects.length} 个作品 · 累计 ${fmtInt(totalWords)} 字` : undefined

  return (
    <>
      <TopBar
        title="我的作品"
        sub={sub}
        actions={
          <>
            <Link className="btn btn-ghost btn-sm" to="/disassemble">
              <Icon name="upload" size={16} />
              拆书
            </Link>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setModalOpen(true)}
            >
              <Icon name="plus" size={16} />
              新建作品
            </button>
          </>
        }
      />

      <div className="stack-24">
        {warn ? (
          <div className="card card-pad">
            <div className="row-between">
              <div className="row">
                <Icon name="alert-triangle" size={16} />
                <span className="fs-13">{warn}</span>
              </div>
              <Link className="btn btn-ghost btn-sm" to="/settings">
                去设置
              </Link>
            </div>
          </div>
        ) : null}

        {status === 'loading' ? (
          <Loading text="正在加载作品…" />
        ) : status === 'error' ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : (
          <>
            <div className="grid-4">
            <div className="stat">
              <div className="stat-label">作品数</div>
              <div className="stat-value fs-20">{projects.length}</div>
              <div className="fs-12 muted">{ongoing} 个进行中</div>
            </div>
            <div className="stat">
              <div className="stat-label">累计字数</div>
              <div className="stat-value fs-20">{fmtInt(totalWords)}</div>
              <div className="fs-12 muted">全部作品合计</div>
            </div>
            <div className="stat">
              <div className="stat-label">伏笔回收率</div>
              <div className="stat-value fs-20">{hookRate}%</div>
              <div className="fs-12 muted">
                已回收 {hooksDone} / {hooksTotal} 条
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">累计成本</div>
              <div className="stat-value fs-20">{fmtMoney(totalCost)}</div>
              <div className="fs-12 muted">按接口用量计</div>
            </div>
          </div>

          {currentProject && resume ? (
            <div className="proj-card is-current">
              <div className={spineClass(0)} />
              <div className="proj-body">
                <div className="proj-head">
                  <div>
                    <div className="proj-title">{currentProject.title}</div>
                    <div className="proj-sub">
                      {currentProject.genre} · {MODE_LABEL[currentProject.mode] ?? currentProject.mode}
                    </div>
                  </div>
                  <span className="tag tag-info">当前作品</span>
                </div>
                <div className="proj-logline">
                  {currentProject.logline || '还没有一句话灵感，去共创对话聊聊。'}
                </div>
                <div className="proj-stats">
                  <span>
                    第 {currentProject.chaptersDone} / {currentProject.chaptersTotal} 章
                  </span>
                  <span>{fmtInt(currentProject.words)} 字</span>
                  <span>
                    伏笔 {currentProject.hooksResolved}/{currentProject.hooksTotal}
                  </span>
                  <span>
                    {fmtMoney(currentProject.budgetUsed)} / {fmtMoney(currentProject.budgetTotal)}
                  </span>
                </div>
                <div className="fs-12 muted">
                  {resume.label}：{resume.reason}
                </div>
              </div>
              <div className="proj-foot">
                <span className="fs-12 muted">最后更新 {currentProject.updatedAt}</span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void open(currentProject, true)}
                >
                  继续
                </button>
              </div>
            </div>
          ) : projects.length === 0 ? (
            <div className="card">
              <div className="card-body">
                <div className="empty">
                  <Icon name="library" size={24} />
                  <div className="fs-16 serif">还没有作品</div>
                  <div className="fs-13">从一个名字和一句话灵感开始</div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => setModalOpen(true)}
                  >
                    新建作品
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <section className="card">
            <div className="card-head">
              <h2>全部作品</h2>
              <span className="tag tag-quiet">{projects.length} 个</span>
            </div>
            <div className="card-body">
              <div className="proj-grid">
                {projects.map((p, i) => {
                  const isCurrent = p.id === currentId
                  const started = p.chaptersDone > 0
                  return (
                    <div key={p.id} className={classNames('proj-card', isCurrent && 'is-current')}>
                      <div className={spineClass(i)} />
                      <div className="proj-body">
                        <div className="proj-head">
                          <div>
                            <div className="proj-title">{p.title}</div>
                            <div className="proj-sub">
                              {p.genre} · {MODE_LABEL[p.mode] ?? p.mode}
                            </div>
                          </div>
                          {isCurrent ? (
                            <span className="tag tag-info">当前</span>
                          ) : started ? null : (
                            <span className="tag tag-quiet">未开始</span>
                          )}
                        </div>
                        <div className="proj-logline">{p.logline || '还没有一句话灵感。'}</div>
                        <div className="proj-stats">
                          <span>
                            第 {p.chaptersDone} / {p.chaptersTotal} 章
                          </span>
                          <span>{fmtInt(p.words)} 字</span>
                          <span>
                            伏笔 {p.hooksResolved}/{p.hooksTotal}
                          </span>
                          <span>
                            {fmtMoney(p.budgetUsed)} / {fmtMoney(p.budgetTotal)}
                          </span>
                          {started ? <span>审计 {p.auditPass}%</span> : null}
                        </div>
                      </div>
                      <div className="proj-foot">
                        <span className="fs-12 muted">{p.updatedAt}</span>
                        <button
                          type="button"
                          className={classNames('btn', 'btn-sm', started ? 'btn-ghost' : 'btn-primary')}
                          onClick={() => void open(p)}
                        >
                          {started ? '打开' : '开始立项'}
                        </button>
                      </div>
                    </div>
                  )
                })}

                <button type="button" className="proj-new" onClick={() => setModalOpen(true)}>
                  <Icon name="plus" size={24} />
                  <strong>新建作品</strong>
                  <span className="fs-12">从一个名字和一句话灵感开始，不填表</span>
                </button>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>最近生成记录</h2>
              <span className="tag tag-quiet">{currentProject?.title ?? '当前作品'}</span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <div className="list">
                {recent.length ? (
                  recent.slice(0, 8).map((u, i) => (
                    <div key={`${u.ts}-${u.chapter}-${u.step}-${i}`} className="list-row">
                      <span className="mono fs-12 muted" style={{ width: 76, flex: 'none' }}>
                        {fmtTs(u.ts)}
                      </span>
                      <div className="row-main">
                        <div className="row-title">
                          {u.chapter > 0
                            ? `第 ${u.chapter} 章 · ${STEP_LABEL[u.step] ?? '生成'}`
                            : STEP_LABEL[u.step] ?? '生成'}
                        </div>
                        <div
                          className="row-sub mono"
                          title={`step: ${u.step} · 输入 ${u.promptTokens} tokens · 输出 ${u.completionTokens} tokens`}
                        >
                          {`输入 ${fmtInt(u.promptTokens)} · 输出 ${fmtInt(u.completionTokens)} 额度`}
                        </div>
                      </div>
                      <span className="mono fs-13" style={{ width: 56, textAlign: 'right' }}>
                        {fmtMoney(u.cost)}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="empty">
                    <Icon name="refresh-cw" size={24} />
                    <div className="fs-13">这部作品还没有生成记录</div>
                  </div>
                )}
              </div>
            </div>
          </section>
          </>
        )}
      </div>

      {modalOpen ? (
        <div className="modal">
          <div className="modal-veil" onClick={() => setModalOpen(false)} />
          <div className="modal-card">
            <div className="card-head">
              <h2>新建作品</h2>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setModalOpen(false)}>
                关闭
              </button>
            </div>
            <div className="card-body stack">
              <p className="fs-13 muted">
                不用先填设定表。给一个名字和一句话灵感即可，剩下的在「共创对话」里边聊边立。
              </p>
              <div className="field">
                <label className="field-label" htmlFor="np-title">
                  作品名
                </label>
                <input
                  id="np-title"
                  className="input"
                  type="text"
                  placeholder="例如：雁回关"
                  value={fTitle}
                  onChange={(e) => setFTitle(e.target.value)}
                />
              </div>
              <div className="grid-2">
                <div className="field">
                  <label className="field-label" htmlFor="np-genre">
                    题材
                  </label>
                  <select
                    id="np-genre"
                    className="select"
                    value={fGenre}
                    onChange={(e) => setFGenre(e.target.value)}
                  >
                    {GENRES.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <span className="field-label">干预模式</span>
                  <div className="seg">
                    {MODE_OPTIONS.map((m) => (
                      <button
                        key={m.value}
                        type="button"
                        className={m.value === fMode ? 'active' : undefined}
                        onClick={() => setFMode(m.value)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="np-premise">
                  一句话灵感
                </label>
                <textarea
                  id="np-premise"
                  className="textarea"
                  placeholder="例如：一个北境小吏追查失踪案，发现王朝正在被「文脉」的力量吞噬。"
                  value={fPremise}
                  onChange={(e) => setFPremise(e.target.value)}
                />
                <span className="field-hint">这句话会作为共创对话的开场，第一条追问会围绕它展开。</span>
              </div>
            </div>
            <div className="card-foot row-between">
              <span className="fs-12 muted">{creating ? '创建中…' : ''}</span>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setModalOpen(false)}
                  disabled={creating}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void submitCreate()}
                  disabled={creating}
                >
                  创建并开始立项
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
