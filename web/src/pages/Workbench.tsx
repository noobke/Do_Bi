import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ErrorState } from '../components/ErrorState'
import { Icon, type IconName } from '../components/Icon'
import { Loading } from '../components/Loading'
import { TopBar } from '../components/Layout'
import { classNames, fmtInt, fmtMoney, toast } from '../lib/ui'
import { useProject } from '../state/project'
import {
  commitChapter,
  decideFinding,
  generateChapter,
  getChapter,
  getOverview,
  request,
  rollPlan,
  runAudit,
  runDeai,
  runReview,
  runRevise,
  setMode,
  steer,
  type SSEHandle,
} from '../api/client'

/**
 * 写作工作台（核心页）—— 左：章节目录；中：手稿；右：助手面板。
 * 数据来自 `GET /api/projects/{id}/overview`（首屏一次给全）+ 逐章的
 * 手稿接口 `.../chapters/{n}/manuscript`（带页边栏编号）与 `getChapter`（审查发现）。
 * 正文生成走 SSE（`generateChapter`），逐段 `delta` 追加并自动滚到底部。
 */

interface ProjectSummary {
  id: string
  title: string
  genre: string
  mode: string
  chaptersDone: number
  chaptersTotal: number
  words: number
}

interface Chapter {
  n: number
  title: string
  status: string
  words: number
  pov: string
  volume: string
  arc: string
  intensity: number
  updated: string
  summary: string
}

interface UsageByChapter {
  chapter: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
  calls: number
}

interface Budget {
  used: number
  total: number
  remaining: number
  ratio: number
  unit: string
  unlimited: boolean
  level: string
  tokens: number
}

interface ModeState {
  mode: string
  modeLabel: string
  modeHint: string
  modes: { value: string; label: string; hint: string }[]
}

interface Resume {
  action: string
  label: string
  chapter: number
  stepLabel: string
  reason: string
}

interface Overview {
  project: ProjectSummary
  chapters: Chapter[]
  usage?: { budget?: Budget; byChapter?: UsageByChapter[] }
  mode?: ModeState
  resume?: Resume
}

interface Para {
  gutter: string
  text: string
  mark?: string
  note?: string
}

interface Manuscript {
  n: number
  title: string
  status: string
  words: number
  pov: string
  paragraphs: Para[]
}

interface AuditItem {
  dim: string
  severity: string
  evidence: string
  suggestion: string
  ref: string
  patch?: string
  fixed: boolean
  decision: string | null
}

interface SteerIntent {
  actionLabel: string
  scope: string
  targetChapter: number
  affectedChapters: number[]
  reason: string
}

interface SteerResult {
  applied: boolean
  pendingConfirmation: boolean
  directiveId: string
  message: string
  intent: SteerIntent
}

type StepKind = 'audit' | 'review' | 'deai' | 'revise' | 'commit'

/** 章节状态 → 标签色 + 作者可读文案。
    文案须与章节页 `CH_STATUS` 逐字一致：同一个 `commit` 状态在别处叫「已定稿」，
    这里叫「已完成」会让作者以为是两件事（后端 `schema.py` 的工序名就叫「定稿」）。 */
const STATUS: Record<string, [string, string]> = {
  todo: ['tag-quiet', '未写'],
  planned: ['tag-quiet', '待写'],
  draft: ['tag-info', '草稿'],
  audit: ['tag-warn', '待审计'],
  revise: ['tag-warn', '修订中'],
  done: ['tag-ok', '已定稿'],
}

/** 审查严重度 → 标签色 + 作者可读文案（英文原词进 title） */
const SEVERITY: Record<string, [string, string]> = {
  blocker: ['tag-danger', '阻塞定稿'],
  major: ['tag-warn', '重点'],
  minor: ['tag-quiet', '建议'],
}

const STEP_BUTTONS: { key: StepKind; label: string; icon: IconName }[] = [
  { key: 'audit', label: '审查', icon: 'clipboard-check' },
  { key: 'review', label: '评审', icon: 'search' },
  { key: 'deai', label: '去 AI 味', icon: 'type' },
  { key: 'revise', label: '修订', icon: 'pen-line' },
  { key: 'commit', label: '定稿', icon: 'check' },
]

const SCOPE_LABEL: Record<string, string> = {
  current: '当前章',
  outline: '后续大纲',
  committed: '已定稿章节',
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试。')

/** 默认打开的章：最近一章有正文的；否则第一章 */
function pickDefault(chapters: Chapter[]): number | null {
  if (!chapters.length) return null
  const written = chapters.filter((c) => c.words > 0)
  return (written.length ? written[written.length - 1] : chapters[0]).n
}

export default function Workbench() {
  const { projectId } = useProject()
  const navigate = useNavigate()

  const [ov, setOv] = useState<Overview | null>(null)
  const [ovStatus, setOvStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [ovErr, setOvErr] = useState('')

  const [current, setCurrent] = useState<number | null>(null)
  const [manuscript, setManuscript] = useState<Manuscript | null>(null)
  const [msStatus, setMsStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [msErr, setMsErr] = useState('')
  const [audit, setAudit] = useState<AuditItem[]>([])

  const [generating, setGenerating] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [stepLabel, setStepLabel] = useState('')
  const [busy, setBusy] = useState<StepKind | null>(null)

  /** 正在处理哪条审查发现（`dim`），避免并发决策 */
  const [auditing, setAuditing] = useState<string | null>(null)

  /** 定稿确认弹窗（null=关）。写毕可能把部分提案降级为待人工确认，用 `commitPend` 透出 */
  const [commitOpen, setCommitOpen] = useState<number | null>(null)
  const [commitPend, setCommitPend] = useState<{ id: string; kind: string }[] | null>(null)

  const [steerText, setSteerText] = useState('')
  const [steerModal, setSteerModal] = useState<{ id: string; message: string; intent: SteerIntent } | null>(
    null,
  )

  const sseRef = useRef<SSEHandle | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  /** 序号防乱序：连点章节时旧响应可能后到，过期响应直接丢弃（否则正文与左栏选中的章对不上） */
  const seqRef = useRef(0)

  const scrollBottom = () => bottomRef.current?.scrollIntoView({ block: 'end' })

  const loadOverview = useCallback(async () => {
    if (!projectId) return
    setOvStatus('loading')
    try {
      const data = (await getOverview(projectId)) as Overview
      setOv(data)
      setOvStatus('ready')
      setCurrent((prev) =>
        prev != null && data.chapters.some((c) => c.n === prev) ? prev : pickDefault(data.chapters),
      )
    } catch (e) {
      setOvErr(errMsg(e))
      setOvStatus('error')
    }
  }, [projectId])

  const loadChapter = useCallback(
    async (n: number) => {
      if (!projectId) return
      const token = ++seqRef.current
      setMsStatus('loading')
      const [msRes, chRes] = await Promise.allSettled([
        request(`/api/projects/${encodeURIComponent(projectId)}/chapters/${n}/manuscript`),
        getChapter(projectId, n),
      ])
      if (token !== seqRef.current) return

      if (msRes.status === 'fulfilled') {
        setManuscript(msRes.value as Manuscript)
        setMsStatus('ready')
      } else if (chRes.status === 'fulfilled') {
        /* 手稿接口不可用时的兜底：用 getChapter 的纯文本段落补页边栏编号 */
        const ch = (
          chRes.value as {
            chapter?: { paragraphs?: string[]; title?: string; status?: string; words?: number; pov?: string }
          }
        ).chapter
        const paragraphs = (ch?.paragraphs ?? []).map((text, i) => ({
          gutter: `${n}.${i + 1}`,
          text,
        }))
        setManuscript({
          n,
          title: ch?.title ?? '',
          status: ch?.status ?? 'todo',
          words: ch?.words ?? 0,
          pov: ch?.pov ?? '',
          paragraphs,
        })
        setMsStatus('ready')
      } else {
        setMsErr(errMsg(msRes.reason))
        setMsStatus('error')
      }

      if (chRes.status === 'fulfilled') {
        const a = (chRes.value as { audit?: { items?: AuditItem[] } | null }).audit
        setAudit(a?.items ?? [])
      } else {
        setAudit([])
      }
    },
    [projectId],
  )

  useEffect(() => {
    if (!projectId) {
      setOv(null)
      setOvStatus('ready')
      setCurrent(null)
      return
    }
    setCurrent(null)
    setManuscript(null)
    setAudit([])
    void loadOverview()
  }, [projectId, loadOverview])

  useEffect(() => {
    if (projectId && current != null) void loadChapter(current)
  }, [projectId, current, loadChapter])

  /* 离开页面（或切换作品）时中止仍在跑的生成流：否则后台继续烧额度，
     回到页面还会看到正文与左栏选中的章错位。 */
  useEffect(
    () => () => {
      sseRef.current?.abort()
      sseRef.current = null
    },
    [projectId],
  )

  /* 生成结束后刷新章节与统计 */
  const finishGenerate = useCallback(
    async (n: number) => {
      sseRef.current = null
      setGenerating(false)
      setStreamText('')
      await loadOverview()
      await loadChapter(n)
      toast(`第 ${n} 章已生成`, 'ok')
    },
    [loadOverview, loadChapter],
  )

  const startGenerate = useCallback(
    (n: number) => {
      if (!projectId) return
      setGenerating(true)
      setStreamText('')
      setStepLabel('准备中…')
      sseRef.current = generateChapter(projectId, n, (ev) => {
        let data: { type?: string; text?: string; label?: string; message?: string } = {}
        try {
          data = JSON.parse(ev.data) as typeof data
        } catch {
          /* 网络 / 服务端错误以纯文本回传（如未配置密钥的 503），直接提示 */
          if (ev.event === 'error') {
            setGenerating(false)
            toast(ev.data || '生成失败', 'error')
          }
          return
        }
        const type = data.type ?? ev.event
        if (type === 'step') {
          setStepLabel(data.label ?? '')
        } else if (type === 'delta') {
          setStreamText((t) => t + (data.text ?? ''))
          scrollBottom()
        } else if (type === 'done') {
          void finishGenerate(n)
        } else if (type === 'error') {
          setGenerating(false)
          toast(data.message ?? '生成失败', 'error')
        }
      })
    },
    [projectId, finishGenerate],
  )

  const stopGenerate = useCallback(async () => {
    if (!projectId || current == null) return
    sseRef.current?.abort()
    sseRef.current = null
    setGenerating(false)
    /* 断开 SSE 后服务端才把半成品落盘为草稿，等一小会儿再收尾，避免读到旧字数 */
    await new Promise((r) => window.setTimeout(r, 400))
    try {
      const res = (await request(
        `/api/projects/${encodeURIComponent(projectId)}/chapters/${current}/stop`,
        { method: 'POST' },
      )) as { saved?: { words?: number } }
      toast(`已保存 ${res.saved?.words ?? 0} 字草稿`, 'ok')
    } catch (e) {
      toast(errMsg(e), 'error')
    }
    await loadOverview()
    await loadChapter(current)
  }, [projectId, current, loadOverview, loadChapter])

  const runAction = useCallback(
    async (n: number, kind: StepKind) => {
      if (!projectId) return
      setBusy(kind)
      try {
        const fn =
          kind === 'audit'
            ? runAudit
            : kind === 'review'
              ? runReview
              : kind === 'deai'
                ? runDeai
                : kind === 'revise'
                  ? runRevise
                  : commitChapter
        const res = (await fn(projectId, n)) as {
          note?: string
          status?: string
          message?: string
          detail?: { pending?: unknown[] }
        }
        const label = STEP_BUTTONS.find((s) => s.key === kind)?.label ?? ''
        toast(res?.note || res?.status || `${label}完成`, 'ok')
        await loadOverview()
        await loadChapter(n)
        return res
      } catch (e) {
        toast(errMsg(e), 'error')
        return undefined
      } finally {
        setBusy(null)
      }
    },
    [projectId, loadOverview, loadChapter],
  )

  /** 定稿确认：弹出「确认写入并标记已定稿」，写毕把降级为待人工确认的提案透出 */
  const confirmCommit = useCallback(async () => {
    if (commitOpen == null) return
    const n = commitOpen
    setCommitOpen(null)
    const res = await runAction(n, 'commit')
    const pend = res?.detail?.pending
    if (Array.isArray(pend) && pend.length) {
      setCommitPend(pend as { id: string; kind: string }[])
    }
  }, [commitOpen, runAction])

  /** 处置一条审查发现：接受修订 / 忽略 / 撤回（语义与审计页一致，复用 `decideFinding`） */
  const decideAudit = useCallback(
    async (dim: string, action: 'accept' | 'ignore' | null, n: number) => {
      if (!projectId) return
      setAuditing(dim)
      try {
        const res = (await decideFinding(projectId, n, dim, action)) as {
          status?: string
          message?: string
        }
        setAudit((prev) =>
          prev.map((it) =>
            it.dim === dim
              ? { ...it, decision: action, fixed: action === 'accept' && !!it.patch }
              : it,
          ),
        )
        const msg =
          res?.message ?? (action === 'accept' ? '已接受修订' : action === 'ignore' ? '已忽略' : '已撤回决策')
        toast(res?.status === 'ok' ? msg : `已记录：${dim}`, 'ok')
      } catch (e) {
        toast(errMsg(e), 'error')
      } finally {
        setAuditing(null)
      }
    },
    [projectId],
  )

  const changeMode = useCallback(
    async (value: string) => {
      if (!projectId) return
      try {
        const m = (await setMode(projectId, value)) as ModeState
        setOv((prev) => (prev ? { ...prev, mode: m } : prev))
        toast(`已切换为${m.modeLabel}`, 'ok')
      } catch (e) {
        toast(errMsg(e), 'error')
      }
    },
    [projectId],
  )

  const submitSteer = useCallback(async () => {
    if (!projectId) return
    const text = steerText.trim()
    if (!text) {
      toast('先写下你的意见', 'warn')
      return
    }
    try {
      const res = (await steer(projectId, text)) as SteerResult
      if (res.pendingConfirmation) {
        setSteerModal({ id: res.directiveId, message: res.message, intent: res.intent })
      } else {
        toast(res.message || '已记录你的意见', 'ok')
        setSteerText('')
      }
      await loadOverview()
    } catch (e) {
      toast(errMsg(e), 'error')
    }
  }, [projectId, steerText, loadOverview])

  const confirmSteer = useCallback(async () => {
    if (!projectId || !steerModal) return
    try {
      await request(
        `/api/projects/${encodeURIComponent(projectId)}/steer/${encodeURIComponent(steerModal.id)}`,
        { method: 'POST', body: JSON.stringify({ action: 'confirm' }) },
      )
      toast('已确认执行', 'ok')
      setSteerModal(null)
      setSteerText('')
      await loadOverview()
      if (current != null) await loadChapter(current)
    } catch (e) {
      toast(errMsg(e), 'error')
    }
  }, [projectId, steerModal, current, loadOverview, loadChapter])

  const goResume = useCallback(async () => {
    const r = ov?.resume
    if (!r || !projectId) return
    switch (r.action) {
      case 'write_next':
      case 'continue_draft':
        setCurrent(r.chapter)
        startGenerate(r.chapter)
        break
      case 're_audit':
        setCurrent(r.chapter)
        await runAction(r.chapter, 'audit')
        break
      case 'continue_revise':
        setCurrent(r.chapter)
        await runAction(r.chapter, 'revise')
        break
      case 'expand_volume':
        try {
          await rollPlan(projectId)
          toast('已展开下一卷骨架', 'ok')
          await loadOverview()
        } catch (e) {
          toast(errMsg(e), 'error')
        }
        break
      case 'replan':
        navigate('/outline')
        break
      default:
        toast(r.label, 'warn')
    }
  }, [ov, projectId, startGenerate, runAction, loadOverview, navigate])

  const chapters = ov?.chapters ?? []
  const nums = chapters.map((c) => c.n)
  const chapterCountLabel = chapters.length
    ? `共 ${chapters.length} 章 · 显示 ${Math.min(...nums)}–${Math.max(...nums)}`
    : '暂无章节'
  const chapterMeta = chapters.find((c) => c.n === current) ?? null

  const statusKey = generating ? 'draft' : manuscript?.status ?? chapterMeta?.status ?? 'todo'
  const st = STATUS[statusKey] ?? STATUS.todo
  const words = manuscript?.words ?? chapterMeta?.words ?? 0

  const paras: Para[] =
    generating && streamText
      ? streamText
          .split(/\n\s*\n+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((text, i) => ({ gutter: `${current}.${i + 1}`, text }))
      : generating
        ? []
        : manuscript?.paragraphs ?? []

  const spend = ov?.usage?.byChapter?.find((x) => x.chapter === current) ?? null
  const budget = ov?.usage?.budget ?? null
  const budgetPct = budget ? Math.min(100, Math.round((budget.ratio || 0) * 100)) : 0
  const budgetColor =
    budget?.level === 'exceeded'
      ? 'var(--error)'
      : budget?.level === 'warning'
        ? 'var(--amber)'
        : undefined

  return (
    <>
      <TopBar
        title="写作工作台"
        sub={
          ov
            ? `《${ov.project.title}》· ${ov.project.genre} · 第 ${ov.project.chaptersDone} / ${ov.project.chaptersTotal} 章`
            : undefined
        }
        actions={
          ov?.mode ? (
            <>
              <span className="fs-12 muted">{ov.mode.modeLabel}</span>
              <div className="seg">
                {ov.mode.modes.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    className={m.value === ov.mode?.mode ? 'active' : undefined}
                    title={m.hint}
                    onClick={() => void changeMode(m.value)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </>
          ) : null
        }
      />

      {!projectId ? (
        <div className="empty">
          <Icon name="pen-line" size={24} />
          <div className="fs-16 serif">还没有选择作品</div>
          <div className="fs-13">先到「我的作品」打开一部作品，再回来写作</div>
          <Link className="btn btn-ghost btn-sm" to="/">
            去我的作品
          </Link>
        </div>
      ) : ovStatus === 'loading' ? (
        <Loading text="正在打开工作台…" />
      ) : ovStatus === 'error' ? (
        <ErrorState message={ovErr} onRetry={() => void loadOverview()} />
      ) : (
        <div className="stack-24">
          {budget ? (
            <section className="card card-pad stack-8">
              <div className="row-between fs-12 muted">
                <span>预算已用{budget.unlimited ? '（不限）' : ''}</span>
                <span className="mono">
                  {fmtMoney(budget.used, budget.unit)} /{' '}
                  {budget.unlimited ? '不限' : fmtMoney(budget.total, budget.unit)}
                </span>
              </div>
              <div className="progress">
                <i style={{ width: `${budgetPct}%`, background: budgetColor }} />
              </div>
            </section>
          ) : null}

          <div className="workbench">
            {/* 左栏 · 章节目录 */}
            <section className="card col-left">
              <div className="card-head">
                <h2>章节目录</h2>
                <span className="tag tag-quiet">{chapterCountLabel}</span>
              </div>
              {chapters.length ? (
                <div className="list">
                  {chapters.map((c) => {
                    const t = STATUS[c.status] ?? STATUS.todo
                    return (
                      <div
                        key={c.n}
                        className={classNames('list-row', c.n === current && 'is-active')}
                        role="button"
                        tabIndex={0}
                        onClick={() => c.n !== current && setCurrent(c.n)}
                        onKeyDown={(e) => {
                          if ((e.key === 'Enter' || e.key === ' ') && c.n !== current) {
                            e.preventDefault()
                            setCurrent(c.n)
                          }
                        }}
                      >
                        <span className="mono fs-12 muted">{c.n}</span>
                        <div className="row-main">
                          <div className="row-title">{c.title || '（未命名）'}</div>
                          <div className="row-sub">
                            {c.words ? `${fmtInt(c.words)} 字 · ${c.updated}` : '未开始'}
                          </div>
                        </div>
                        <span className={classNames('tag', t[0])}>{t[1]}</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="empty">
                  <Icon name="git-branch" size={24} />
                  <span className="fs-13">还没有章节</span>
                  <span className="fs-12 muted">先到「结构」页生成大纲与章纲</span>
                </div>
              )}
            </section>

            {/* 中栏 · 手稿 */}
            <section className="manuscript">
              <div className="ms-head">
                <div>
                  <div className="ms-title">
                    第 {current ?? '—'} 章 ·{' '}
                    {manuscript?.title || chapterMeta?.title || '（未命名）'}
                  </div>
                  <div className="ms-meta">
                    {generating
                      ? `生成中 · ${stepLabel || '准备中…'}`
                      : words
                        ? `${fmtInt(words)} 字 · ${st[1]}`
                        : `尚未生成正文 · ${st[1]}`}
                  </div>
                </div>
                <div className="stack-8">
                  <div className="row">
                    {generating ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void stopGenerate()}
                      >
                        <Icon name="square" size={16} />
                        停止
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={current == null}
                        onClick={() => current != null && startGenerate(current)}
                      >
                        <Icon name="play" size={16} />
                        {words ? '重新生成本章' : '生成本章'}
                      </button>
                    )}
                  </div>
                  <div className="wrap-row">
                    {STEP_BUTTONS.map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={generating || busy !== null || !words || current == null}
                        onClick={() =>
                          s.key === 'commit'
                            ? current != null && setCommitOpen(current)
                            : current != null && void runAction(current, s.key)
                        }
                      >
                        <Icon name={s.icon} size={16} />
                        {busy === s.key ? `${s.label}中…` : s.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="ms-body">
                {msStatus === 'loading' && !generating ? (
                  <Loading text="正在载入手稿…" />
                ) : msStatus === 'error' ? (
                  <ErrorState
                    message={msErr}
                    onRetry={() => current != null && void loadChapter(current)}
                  />
                ) : paras.length === 0 ? (
                  <div className="empty">
                    <Icon name="pen-line" size={24} />
                    <span className="fs-13">第 {current ?? '—'} 章还没有正文</span>
                    <span className="fs-12 muted">
                      点上方「生成本章」开始；章纲未定时，先到「结构」页确认本章节拍
                    </span>
                  </div>
                ) : (
                  paras.map((p, i) => (
                    <Fragment key={`${p.gutter}-${i}`}>
                      <div className="ms-line">
                        <div className="ms-gutter">{p.gutter}</div>
                        <div className="ms-text">
                          {p.mark === 'hl' ? <span className="hl">{p.text}</span> : p.text}
                        </div>
                      </div>
                      {p.note ? <div className="ms-note">{p.note}</div> : null}
                    </Fragment>
                  ))
                )}
                <div ref={bottomRef} />
              </div>
            </section>

            {/* 右栏 · 助手面板 */}
            <aside className="col-right stack-24">
              <div className="card">
                <div className="card-head">
                  <h2>本章状态</h2>
                  <span className={classNames('tag', st[0])}>{st[1]}</span>
                </div>
                <div className="card-body grid-2">
                  <div className="stat">
                    <div className="stat-label">字数</div>
                    <div className="stat-value fs-20">{words ? fmtInt(words) : '—'}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">本章花费</div>
                    <div className="stat-value fs-20">
                      {spend ? fmtMoney(spend.cost) : '—'}
                      {spend ? <small>{fmtInt(spend.totalTokens)} 额度</small> : null}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">状态</div>
                    <div className="stat-value fs-16">{st[1]}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">视角</div>
                    <div className="stat-value fs-16">
                      {manuscript?.pov || chapterMeta?.pov || '—'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h2>审查发现</h2>
                  <Link className="btn btn-quiet btn-sm" to="/audit">
                    看全部
                  </Link>
                </div>
                <div className="card-body stack-8">
                  {audit.length ? (
                    audit.map((it) => {
                      const t = SEVERITY[it.severity] ?? SEVERITY.minor
                      const decided = it.decision === 'accept' || it.decision === 'ignore'
                      const working = auditing === it.dim
                      return (
                        <div key={it.dim} className={classNames('audit-item', `sev-${it.severity}`)}>
                          <div className="row-between">
                            <span className="fs-13">{it.dim}</span>
                            <span className={classNames('tag', t[0])} title={it.severity}>
                              {t[1]}
                            </span>
                          </div>
                          {it.evidence ? (
                            <div className="audit-evidence" title="原文证据（可举证）">
                              {it.evidence}
                            </div>
                          ) : null}
                          <div className="row-between" style={{ marginTop: 8 }}>
                            <span className="row">
                              {decided ? (
                                <span className="tag tag-quiet">
                                  {it.decision === 'accept' ? '已接受修订' : '已忽略'}
                                </span>
                              ) : (
                                <span className="fs-12 muted">待处置</span>
                              )}
                            </span>
                            <div className="row">
                              {decided ? (
                                <button
                                  type="button"
                                  className="btn btn-quiet btn-sm"
                                  disabled={working || current == null}
                                  onClick={() => void decideAudit(it.dim, null, current as number)}
                                >
                                  撤回
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn-primary btn-sm"
                                    disabled={working || current == null}
                                    onClick={() => void decideAudit(it.dim, 'accept', current as number)}
                                  >
                                    {working ? '处理中…' : '接受'}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    disabled={working || current == null}
                                    onClick={() => void decideAudit(it.dim, 'ignore', current as number)}
                                  >
                                    忽略
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })
                  ) : (
                    <div className="empty">
                      <span className="fs-12">本章还没有审查发现</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h2>实时干预</h2>
                  <span className="tag tag-quiet">随时可用</span>
                </div>
                <div className="card-body stack-8">
                  <p className="fs-12 muted">
                    写下你的意见，助手会先判断影响范围；触及已定稿章节时会先请你确认。
                  </p>
                  <textarea
                    className="textarea"
                    placeholder="例如：这一章节奏太慢，把追查部分压缩到三段以内"
                    value={steerText}
                    onChange={(e) => setSteerText(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm btn-block"
                    onClick={() => void submitSteer()}
                  >
                    注入意见
                  </button>
                </div>
              </div>

              {ov?.resume ? (
                <div className="card">
                  <div className="card-head">
                    <h2>接着做什么</h2>
                    <span className="tag tag-info">{ov.resume.stepLabel}</span>
                  </div>
                  <div className="card-body stack-8">
                    <div className="fs-14">{ov.resume.label}</div>
                    <div className="fs-12 muted">{ov.resume.reason}</div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-block"
                      onClick={() => void goResume()}
                    >
                      按建议继续
                    </button>
                  </div>
                </div>
              ) : null}
            </aside>
          </div>
        </div>
      )}

      {steerModal ? (
        <div className="modal">
          <div className="modal-veil" onClick={() => setSteerModal(null)} />
          <div className="modal-card">
            <div className="card-head">
              <h2>这条意见会改动已定稿的章节</h2>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setSteerModal(null)}>
                关闭
              </button>
            </div>
            <div className="card-body stack-8">
              <p className="fs-13">{steerModal.message}</p>
              <div className="fs-12 muted">
                影响范围：{SCOPE_LABEL[steerModal.intent.scope] ?? steerModal.intent.scope} · 涉及章节：
                {steerModal.intent.affectedChapters.length
                  ? steerModal.intent.affectedChapters.join('、')
                  : `第 ${steerModal.intent.targetChapter} 章`}
              </div>
            </div>
            <div className="card-foot row-between">
              <span className="fs-12 muted">确认后先生成修订提案，不会静默改写历史</span>
              <div className="row">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSteerModal(null)}>
                  再想想
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void confirmSteer()}>
                  确认执行
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {commitOpen != null ? (
        <div className="modal">
          <div className="modal-veil" onClick={() => setCommitOpen(null)} />
          <div className="modal-card">
            <div className="card-head">
              <h2>定稿第 {commitOpen} 章</h2>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setCommitOpen(null)}>
                关闭
              </button>
            </div>
            <div className="card-body stack-8">
              <p className="fs-13">
                定稿会把本章的摘要、事实、伏笔与依赖关系写入真相文件；冲突项会被校验器拦下、降级为待人工确认，不会自动入正史。
              </p>
              <div className="fs-12 muted">尚未通过「审查」的章节不能直接定稿（这是有意为之）。</div>
            </div>
            <div className="card-foot row-between">
              <span className="fs-12 muted">确认后不可撤销地标记为已定稿</span>
              <div className="row">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCommitOpen(null)}>
                  再想想
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void confirmCommit()}>
                  确认写入并标记已定稿
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {commitPend ? (
        <div className="modal">
          <div className="modal-veil" onClick={() => setCommitPend(null)} />
          <div className="modal-card">
            <div className="card-head">
              <h2>有 {commitPend.length} 项需人工确认</h2>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setCommitPend(null)}>
                关闭
              </button>
            </div>
            <div className="card-body stack-8">
              <p className="fs-13">这次定稿中有几项提案触到了冲突，未自动写入，留给你逐条裁定：</p>
              <div className="list">
                {commitPend.map((p) => (
                  <div key={p.id} className="list-row">
                    <div className="row-main">
                      <div className="row-title">{p.id}</div>
                      <div className="row-sub">{p.kind}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="card-foot row-between">
              <span className="fs-12 muted">其余内容已正常归档，不因这几项而回滚</span>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setCommitPend(null)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
