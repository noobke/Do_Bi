import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { Crumb, TopBar } from '../components/Layout'
import { Loading } from '../components/Loading'
import { classNames, fmtInt, fmtMoney, toast } from '../lib/ui'
import { getChapterDetail, getStructure, runAudit } from '../api/client'
import { useProject } from '../state/project'

/**
 * 章节详情 —— 一章是怎么生产出来的。
 *
 * 五视图（顺序冻结）：生产流程 `pipeline`（默认）/ 场景流程 `flow` / 时间线 `timeline` /
 * 结构位置 `structure` / 问题鱼骨 `fishbone`。
 * 数据源：`GET /chapters/{n}/detail`（五张图的派生数据 + 上下文组装明细）与
 * `GET /structure`（全书章节张力，供结构位置图）。视觉照 `prototype/do-bi/chapter.html`，
 * 类名全部取自 `styles/contract.css`（批次二 / 六 / 七 / 九），动态数值用内联 style / SVG 属性。
 */

/* ------------------------------------------------------------------ *
 * 数据形状（实测 dump，camelCase）
 * ------------------------------------------------------------------ */

interface ChapterInfo {
  chapter: number
  title: string
  status: string
  words: number
  pov: string
  updated: string
  /** 本章梗概（归档派生的短文）；可能为空字符串或不存在 */
  summary?: string
  paragraphs: string[]
}

interface PipeStep {
  key: string
  label: string
  status: 'todo' | 'running' | 'ok' | 'skipped' | 'failed'
  tokens: number
  cost: number
  calls: number
  latencyMs: number
}

interface Pipeline {
  steps: PipeStep[]
  done: number
  active: number | null
  total: number
  next: number | null
  failed: string[]
  lastCheckpointAt: string | null
  cost: number
  tokens: number
}

interface ContextSection {
  key: string
  label: string
  tokens: number
  cap: number
  mandatory: boolean
  truncated: boolean
  omitted: boolean
  chars: number
}

interface RelatedChapter {
  chapter: number
  title: string
  score: number
  viaGraph: boolean
  reason: string
}

interface ContextInfo {
  chapter: number
  purpose: string
  window: number
  outputReserve: number
  usedTokens: number
  mandatoryTokens: number
  sections: ContextSection[]
  notes: string[]
  related: RelatedChapter[]
  budgetSplit: Record<string, number>
}

interface TimelineEvent {
  at: string
  label: string
  kind: string
  anchorId: string | null
  anchorAt: string | null
}

interface TimelineAnchor {
  id: string
  storyAt: string
  label: string
  kind: string
  chapters: number[]
  note: string
}

interface TimelineInfo {
  events: TimelineEvent[]
  anchors: TimelineAnchor[]
  located: number
  total: number
  kindLabels: Record<string, string>
}

interface ActInfo {
  name: string
  from: number
  to: number
  note: string
  status: string
}

interface BeatInfo {
  chapter: number
  title: string
  goal: string
  beats: string[]
  status: 'past' | 'current' | 'future'
}

interface Fishbone {
  title: string
  severity: 'blocker' | 'major' | 'minor'
  causes: Array<{ category: string; items: string[] }>
}

interface Detail {
  chapter: ChapterInfo
  node: { title?: string; beats?: string[]; intensity?: number; summary?: string } | null
  acts: ActInfo[]
  act: ActInfo | null
  beats: BeatInfo[]
  pipeline: Pipeline
  context: ContextInfo
  timeline: TimelineInfo
  fishbone: Fishbone | null
}

interface StructChapter {
  n: number
  title: string
  status: string
  words: number
  pov: string
  intensity: number
}

interface Structure {
  chapters: StructChapter[]
}

/* ------------------------------------------------------------------ *
 * 视图定义（顺序冻结）
 * ------------------------------------------------------------------ */

const VIEWS = ['pipeline', 'flow', 'timeline', 'structure', 'fishbone'] as const
type ViewKey = (typeof VIEWS)[number]

const VIEW_LABEL: Record<ViewKey, string> = {
  pipeline: '生产流程',
  flow: '场景流程',
  timeline: '时间线',
  structure: '结构位置',
  fishbone: '问题鱼骨',
}

const VIEW_HINT: Record<ViewKey, string> = {
  pipeline: '一章要过的 8 道工序；中断可从当前步续跑',
  flow: '本章场景按顺序推进；有审查结论时，转折场景标为冲突场景',
  timeline: '本章事件 × 全书时间锚点，双轨对照',
  structure: '本章在情节结构中的位置，以及本幕的节拍序列',
  fishbone: '把本章问题按维度归因，每条都对应可定位的审查证据',
}

/** 章节状态 → 标签色 + 作者可读文案。文案须与工作台 `STATUS` 逐字一致：
    同一个状态在两页各叫一名（「待审查」/「待审计」）会让作者以为是两件事；
    「审计」也是侧栏那一页的名字，统一取它。 */
const CH_STATUS: Record<string, [string, string]> = {
  todo: ['tag-quiet', '未写'],
  planned: ['tag-quiet', '待写'],
  draft: ['tag-info', '草稿'],
  audit: ['tag-warn', '待审计'],
  revise: ['tag-warn', '修订中'],
  done: ['tag-ok', '已定稿'],
}

const SEVERITY: Record<string, [string, string]> = {
  blocker: ['tag-danger', '阻塞定稿'],
  major: ['tag-warn', '重点'],
  minor: ['tag-quiet', '建议'],
}

const STEP_STATUS_TEXT: Record<string, string> = {
  ok: '已完成',
  skipped: '已完成',
  running: '进行中',
  failed: '执行失败',
  todo: '待执行',
}

/** 章节过程里 8 道工序在流程图上的节点（名称须与后端 `steps[].label` 逐字一致） */
const PF_NODES: Array<{ name: string; x: number; y: number }> = [
  { name: '章纲', x: 90, y: 76 },
  { name: '上下文组装', x: 90, y: 152 },
  { name: '草稿', x: 90, y: 228 },
  { name: '规则与模型审查', x: 90, y: 304 },
  { name: '定稿', x: 90, y: 530 },
  { name: '修订', x: 630, y: 326 },
  { name: '可举证评审', x: 630, y: 402 },
  { name: '去 AI 味', x: 630, y: 478 },
]

const PF_LEFT_Y = [76, 152, 228, 304]

const PALETTE = ['var(--accent)', 'var(--moss)', 'var(--amber)', 'var(--accent-ink)', 'var(--ink-3)', 'var(--ink-4)']
const SECTION_COLORS: Record<string, string> = {
  system: 'var(--accent-ink)',
  style: 'var(--ink-4)',
  cast: 'var(--accent)',
  facts: 'var(--moss)',
  summary: 'var(--amber)',
  draft: 'var(--accent-soft)',
}
const sectionColor = (key: string, i: number) => SECTION_COLORS[key] ?? PALETTE[i % PALETTE.length]

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '加载失败')

/* ------------------------------------------------------------------ *
 * 上下文组装明细（本项目「可观测」的卖点）
 * ------------------------------------------------------------------ */

const SPLIT_LABEL: Record<string, string> = {
  system: '系统规则',
  cast: '角色与世界观',
  facts: '动态事实',
  summary: '前情摘要',
  draft: '当前草稿',
  output: '输出预留',
}

function ContextCard({ ctx }: { ctx: ContextInfo }) {
  const shown = ctx.sections.filter((s) => !s.omitted)
  const total = shown.reduce((a, s) => a + s.tokens, 0) || 1
  const splitKeys = Object.keys(ctx.budgetSplit)

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <div className="card-head">
        <h2>上下文组装明细</h2>
        <span className="tag tag-info">{`${fmtInt(ctx.usedTokens)} / ${fmtInt(ctx.window)} 额度`}</span>
      </div>
      <div className="card-body stack">
        <div>
          <div className="fs-12 muted" style={{ marginBottom: 8 }}>
            {`本次用于「${ctx.purpose}」的额度分布（必选 ${fmtInt(ctx.mandatoryTokens)}）`}
          </div>
          <div className="stackbar">
            {shown.map((s, i) => (
              <i key={s.key} style={{ width: `${(s.tokens / total) * 100}%`, background: sectionColor(s.key, i) }} />
            ))}
          </div>
          <div className="stackbar-legend">
            {shown.map((s, i) => (
              <span key={s.key} className="legend-item">
                <span className="dot" style={{ background: sectionColor(s.key, i) }} />
                {`${s.label} ${fmtInt(s.tokens)}`}
              </span>
            ))}
          </div>
        </div>

        <div className="list">
          {ctx.sections.map((s) => (
            <div key={s.key} className="list-row">
              <div className="row-main">
                <div className="row-title">{s.label}</div>
                <div className="row-sub">{`${fmtInt(s.tokens)} / ${fmtInt(s.cap)} 额度 · ${fmtInt(s.chars)} 字`}</div>
              </div>
              {s.mandatory ? <span className="tag tag-info">必选</span> : null}
              {s.truncated ? <span className="tag tag-warn">已截断</span> : null}
              {s.omitted ? <span className="tag tag-danger">已省略</span> : null}
            </div>
          ))}
        </div>

        {ctx.notes.length ? (
          <div className="stack-8">
            <div className="fs-12 muted">额度说明</div>
            {ctx.notes.map((note, i) => (
              <div key={i} className="fs-12 muted">{`· ${note}`}</div>
            ))}
          </div>
        ) : null}

        {ctx.related.length ? (
          <div>
            <div className="fs-12 muted" style={{ marginBottom: 8 }}>
              关联章节（供写作参考）
            </div>
            <div className="wrap-row">
              {ctx.related.map((r) => (
                <Link key={r.chapter} className="chip" to={`/chapter/${r.chapter}`} title={r.reason}>
                  {`第 ${r.chapter} 章 · ${r.title}`}
                </Link>
              ))}
            </div>
          </div>
        ) : null}

        <div className="fs-12 muted">
          {`预算分配：${splitKeys.map((k) => `${SPLIT_LABEL[k] ?? k} ${ctx.budgetSplit[k]}%`).join(' · ')}`}
        </div>
      </div>
    </section>
  )
}

/* ================================================================== *
 * 页面主体
 * ================================================================== */

export default function Chapter() {
  const { projectId } = useProject()
  const navigate = useNavigate()
  const { n } = useParams<{ n: string }>()

  const rawN = Number(n)
  const chapterNo = Number.isFinite(rawN) && rawN >= 1 ? Math.floor(rawN) : 1

  const [detail, setDetail] = useState<Detail | null>(null)
  const [structure, setStructure] = useState<Structure | null>(null)
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [err, setErr] = useState('')
  const [view, setView] = useState<ViewKey>('pipeline')
  const [busy, setBusy] = useState(false)

  /** 序号防乱序：切章时旧响应可能后到，过期响应直接丢弃 */
  const seqRef = useRef(0)

  const load = useCallback(
    async (no: number) => {
      if (!projectId) return
      const token = ++seqRef.current
      setStatus('loading')
      try {
        const [d, s] = await Promise.all([getChapterDetail(projectId, no), getStructure(projectId)])
        if (token !== seqRef.current) return
        setDetail(d as Detail)
        setStructure(s as Structure)
        setStatus('ready')
      } catch (e) {
        if (token !== seqRef.current) return
        setErr(errMsg(e))
        setStatus('error')
      }
    },
    [projectId],
  )

  useEffect(() => {
    if (!projectId) return
    setDetail(null)
    setStructure(null)
    void load(chapterNo)
  }, [projectId, chapterNo, load])

  const nums = useMemo(
    () => (structure ? [...structure.chapters].map((c) => c.n).sort((a, b) => a - b) : []),
    [structure],
  )
  const prevN = useMemo(() => {
    const smaller = nums.filter((x) => x < chapterNo)
    return smaller.length ? smaller[smaller.length - 1] : null
  }, [nums, chapterNo])
  const nextN = useMemo(() => nums.find((x) => x > chapterNo) ?? null, [nums, chapterNo])

  const go = useCallback((no: number | null) => {
    if (no == null) return
    navigate(`/chapter/${no}`)
  }, [navigate])

  const runAuditNow = useCallback(async () => {
    if (!projectId || busy) return
    setBusy(true)
    try {
      await runAudit(projectId, chapterNo)
      toast('审查完成，已刷新本章结论', 'ok')
      await load(chapterNo)
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(false)
    }
  }, [projectId, busy, chapterNo, load])

  /* ---------- 三态 ---------- */

  if (!projectId) {
    return (
      <>
        <TopBar title="章节详情" sub="一章是怎么生产出来的" />
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="library" size={24} />
              <div className="fs-16 serif">还没有选择作品</div>
              <div className="fs-13 muted">先到「项目」里选择或新建一部作品，再回来看章节。</div>
              <Link className="btn btn-ghost btn-sm" to="/">
                前往项目列表
              </Link>
            </div>
          </div>
        </section>
      </>
    )
  }

  if (status === 'loading' && !detail) {
    return (
      <>
        <TopBar title={`第 ${chapterNo} 章`} sub="一章是怎么生产出来的" />
        <Loading text="正在载入本章…" />
      </>
    )
  }

  if (status === 'error' && !detail) {
    return (
      <>
        <TopBar
          title={`第 ${chapterNo} 章`}
          sub="一章是怎么生产出来的"
          crumb={
            <Crumb items={[{ label: '结构', to: '/outline' }, { label: `第 ${chapterNo} 章` }]} />
          }
        />
        <ErrorState message={err} onRetry={() => void load(chapterNo)} />
      </>
    )
  }

  if (!detail || !structure) return null

  // 绑定为非空常量：下面的渲染函数是闭包，TS 不会把外层的空值收窄带进闭包体内
  const d = detail
  const s = structure

  const ch = detail.chapter
  const pipe = detail.pipeline
  const steps = pipe.steps
  const st = CH_STATUS[ch.status] ?? CH_STATUS.todo
  const running = pipe.active != null ? 1 : 0
  const todoCount = Math.max(0, pipe.total - pipe.done - running)
  const activeStepName = pipe.active != null ? steps[pipe.active - 1]?.label ?? '' : ''

  /** 本章梗概：优先取章节对象，缺省回落章纲节点；两者都没有或为空就视为无梗概（走空态） */
  const chapterSummary =
    (ch.summary || '').trim() || (detail.node?.summary || '').trim() || ''

  const stepByName = (name: string) => steps.find((s) => s.label === name) ?? null
  const isStepDone = (name: string) => {
    const s = stepByName(name)
    return s?.status === 'ok' || s?.status === 'skipped'
  }
  const nodeCls = (name: string) => {
    const s = stepByName(name)
    if (!s) return 'is-todo'
    if (s.status === 'ok' || s.status === 'skipped') return 'is-done'
    if (s.status === 'running') return 'is-active'
    return 'is-todo'
  }
  const nodeMeta = (name: string) => {
    const s = stepByName(name)
    if (!s) return '尚未执行'
    if (!s.calls && !s.tokens) return '无模型调用'
    const secs = s.latencyMs ? `${(s.latencyMs / 1000).toFixed(1)} s · ` : ''
    return `${secs}${fmtInt(s.tokens)} 额度 · ${s.calls} 次`
  }

  /* ---------- 视图 1 · 生产流程 ---------- */

  function renderPipeline(): ReactNode {
    const edgeEls: ReactNode[] = [<path key="e-start" className="pflow-edge" d="M 210,50 V 76" />]
    for (let i = 0; i < PF_LEFT_Y.length - 1; i++) {
      edgeEls.push(<path key={`e-${i}`} className="pflow-edge" d={`M 210,${PF_LEFT_Y[i] + 46} V ${PF_LEFT_Y[i + 1]}`} />)
    }
    edgeEls.push(<path key="e-dec" className="pflow-edge" d="M 330,327 H 355 V 350 H 380" />)
    edgeEls.push(<path key="e-no" className="pflow-edge" d="M 580,350 H 630" />)
    edgeEls.push(<text key="e-no-t" className="pflow-edge-label" x={592} y={342}>不通过</text>)
    edgeEls.push(<path key="loop" className="pflow-edge is-loop" d="M 750,326 V 286 H 210 V 304" />)
    edgeEls.push(
      <text key="loop-t" className="pflow-edge-label" textAnchor="middle" x={480} y={280}>
        修订后重审
      </text>,
    )
    edgeEls.push(<path key="e-yes" className="pflow-edge" d="M 480,390 V 425 H 630" />)
    edgeEls.push(<text key="e-yes-t" className="pflow-edge-label" x={492} y={412}>通过</text>)
    edgeEls.push(<path key="e-r1" className="pflow-edge" d="M 750,448 V 478" />)
    edgeEls.push(<path key="e-r2" className="pflow-edge" d="M 750,524 V 553 H 330" />)
    edgeEls.push(
      <text key="e-r2-t" className="pflow-edge-label" textAnchor="middle" x={540} y={547}>
        全流程通过
      </text>,
    )

    return (
      <div className="stack-24">
        <section className="card">
          <div className="card-head">
            <h2>执行流程图</h2>
            <div className="row">
              <span className="tag tag-info">含判定与回环</span>
              <span className="tag tag-ok">{`${pipe.done} 已完成`}</span>
              <span className="tag tag-warn">{`${running} 进行中`}</span>
              <span className="tag tag-quiet">{`${todoCount} 待执行`}</span>
            </div>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="pflow-wrap">
              <svg viewBox="0 0 900 640" role="img" aria-label="章节执行流程">
                {edgeEls}
                <rect className="pflow-pill" x={90} y={22} width={120} height={28} rx={14} />
                <text className="pflow-pill-text" textAnchor="middle" x={150} y={41}>开始</text>
                {PF_NODES.map((nd) => (
                  <g
                    key={nd.name}
                    className={classNames('pflow-node', nodeCls(nd.name), nd.name === '修订' && !isStepDone('修订') && 'is-revise')}
                  >
                    <title>{nodeMeta(nd.name)}</title>
                    <rect x={nd.x} y={nd.y} width={240} height={46} rx={8} />
                    <text className="pflow-name" x={nd.x + 16} y={nd.y + 20}>{nd.name}</text>
                    <text className="pflow-meta" x={nd.x + 16} y={nd.y + 36}>{nodeMeta(nd.name)}</text>
                  </g>
                ))}
                <polygon className="pflow-decision" points="380,350 480,310 580,350 480,390" />
                <text className="pflow-decision-text" textAnchor="middle" x={480} y={354}>审查通过？</text>
                <rect className="pflow-pill" x={690} y={578} width={120} height={28} rx={14} />
                <text className="pflow-pill-text" textAnchor="middle" x={750} y={597}>结束</text>
              </svg>
            </div>
          </div>
          <div className="card-body">
            <div className="chart-note">
              <strong>{`${PF_NODES.length} 个节点 · 1 处判定 · 1 处回环`}</strong>
              {` · 实线为顺序流程，琥珀虚线为回环：审查不通过走「修订」，再回到「规则与模型审查」重审；通过后经可举证评审、去 AI 味到定稿`}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>工序步骤条</h2>
            <span className={classNames('tag', pipe.done === pipe.total ? 'tag-ok' : 'tag-info')}>
              {`第 ${Math.min(pipe.done + 1, pipe.total)} / ${pipe.total} 步`}
            </span>
          </div>
          <div className="card-body">
            <div className="steps">
              {steps.map((s, i) => {
                const cls = s.status === 'ok' || s.status === 'skipped' ? 'is-done' : s.status === 'running' ? 'is-active' : ''
                return (
                  <div key={s.key} className="step-item">
                    <div className="step-rail">
                      <span className={classNames('step-dot', cls)}>{i + 1}</span>
                      {i < steps.length - 1 ? <span className="step-line" /> : null}
                    </div>
                    <div className="step-body">
                      <div className="step-title">{s.label}</div>
                      <div className="step-desc">
                        {`${STEP_STATUS_TEXT[s.status] ?? s.status} · ${fmtInt(s.tokens)} 额度 · ${s.calls} 次调用${
                          s.latencyMs ? ` · ${(s.latencyMs / 1000).toFixed(1)} s` : ''
                        }`}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="chart-note" style={{ marginTop: 16 }}>
              <strong>{`${pipe.total} 道工序：${pipe.done} 已完成 · ${running} 进行中 · ${todoCount} 待执行`}</strong>
              {pipe.active != null
                ? ` · 本章推进到第 ${pipe.active} 步「${activeStepName}」；定稿前不写入真相文件，中断可从该步续跑`
                : ' · 全部工序已完成，状态已写入真相文件，可从任一历史版本回溯'}
            </div>
          </div>
        </section>
      </div>
    )
  }

  /* ---------- 视图 2 · 场景流程 ---------- */

  function renderFlow(): ReactNode {
    const scenes = d.node?.beats ?? []
    const total = scenes.length
    const fb = d.fishbone

    if (!total) {
      return (
        <section className="card">
          <div className="card-head">
            <h2>场景流程</h2>
            <span className="tag tag-quiet">0 个场景</span>
          </div>
          <div className="card-body">
            <div className="empty">
              <Icon name="git-branch" size={24} />
              <span className="fs-13">本章还没有场景节拍</span>
              <span className="fs-12 muted">场景流程在章纲生成后自动填充</span>
            </div>
            <div className="chart-note is-ok" style={{ marginTop: 12 }}>
              <strong>本章无场景节拍</strong>
              {` · 先到「结构」页生成本章章纲，场景流程才有内容可画`}
            </div>
          </div>
        </section>
      )
    }

    const TOP = 50
    const NH = 46
    const GAP = 26
    const y = (i: number) => TOP + i * (NH + GAP)
    const y0 = y(0)
    const lastY = y(total - 1)
    const endY = lastY + NH + GAP
    const H = endY + 34

    let build = 0
    let turn = 0
    let resolve = 0
    const nodeEls: ReactNode[] = []
    const edgeEls: ReactNode[] = [
      <path key="flow-start" className="flow-edge" d={`M 84,${y0 + NH / 2} H 140`} />,
    ]
    scenes.forEach((label, i) => {
      const yi = y(i)
      let cls = ''
      if (total === 1) {
        cls = ' is-resolve'
        resolve++
      } else if (i === 0) {
        build++
      } else if (i === total - 1) {
        cls = ' is-resolve'
        resolve++
      } else if (fb) {
        cls = ' is-conflict'
        turn++
      } else {
        cls = ' is-turn'
        turn++
      }
      nodeEls.push(
        <g key={`fn-${i}`} className={classNames('flow-node', cls)}>
          <rect x={140} y={yi} width={340} height={NH} rx={8} />
          <text className="fn-t" x={158} y={yi + 20}>{label}</text>
          <text className="fn-s" x={158} y={yi + 36}>{`场景 ${i + 1} / ${total}`}</text>
        </g>,
      )
      if (i < total - 1) {
        edgeEls.push(<path key={`fe-${i}`} className="flow-edge" d={`M 310,${yi + NH} V ${y(i + 1)}`} />)
      }
    })
    edgeEls.push(<path key="flow-end" className="flow-edge" d={`M 310,${lastY + NH} V ${endY - 13}`} />)

    return (
      <section className="card">
        <div className="card-head">
          <h2>场景流程</h2>
          <span className="tag tag-quiet">{`${total} 个场景`}</span>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="flow-wrap">
            <svg viewBox={`0 0 900 ${H}`} role="img" aria-label="场景流程">
              {edgeEls}
              <rect className="flow-pill" x={20} y={y0 + NH / 2 - 13} width={64} height={26} rx={13} />
              <text className="flow-pill-text" textAnchor="middle" x={52} y={y0 + NH / 2 + 4}>起</text>
              {nodeEls}
              <rect className="flow-pill" x={278} y={endY - 13} width={64} height={26} rx={13} />
              <text className="flow-pill-text" textAnchor="middle" x={310} y={endY + 4}>止</text>
            </svg>
          </div>
        </div>
        <div className="card-body">
          <div className="chart-note">
            <strong>{`本章 ${total} 个场景：${build} 建置 · ${turn} 转折 · ${resolve} 收束`}</strong>
            {fb
              ? ` · 本章有审查结论（${fb.causes.length} 类成因），${turn} 个转折场景已标为冲突场景；灰为建置、琥珀为冲突、苔绿为收束`
              : ' · 灰色为建置、靛蓝为转折、苔绿为收束；线性推进，无分叉'}
          </div>
        </div>
      </section>
    )
  }

  /* ---------- 视图 3 · 时间线（单轨故事时间线 + 双轨锚点对照） ---------- */

  function renderTimeline(): ReactNode {
    const { events, anchors, located, total, kindLabels } = d.timeline
    const ne = events.length
    const na = anchors.length

    const dotCls = (kind: string) => {
      if (kind === 'backstory' || kind === 'flashback') return ' is-backstory'
      if (kind === 'future') return ' is-future'
      if (kind === 'planned') return ' is-planned'
      return ''
    }
    const kindOf = (kind: string) => kindLabels[kind] ?? kind

    /* ---------- 单轨 · 故事内时间线 ---------- */
    // 事件尽量对齐到全书锚点：有锚点的事件按锚点在全书时间轴上的先后排布，
    // 没有锚点的事件往后排；横轴用「故事内先后」而非叙述顺序。
    const anchorIndexById = new Map(anchors.map((a, j) => [a.id, j]))
    const unlocatedEvs = events.filter((e) => !e.anchorAt)
    const locatedEvs = events
      .filter((e) => e.anchorAt)
      .sort((a, b) => (anchorIndexById.get(a.anchorId!) ?? Infinity) - (anchorIndexById.get(b.anchorId!) ?? Infinity))

    // 单轨上事件均匀铺开；对齐锚点的在前，未对齐的补在后面
    const singleOrder = [...locatedEvs, ...unlocatedEvs]
    const singleX = (i: number) => 60 + (i + 0.5) * (780 / Math.max(1, singleOrder.length))
    const singleEls: ReactNode[] = [<path key="st-line" className="tl-line" d="M 60,36 H 840" />]
    singleOrder.forEach((ev, i) => {
      const x = singleX(i)
      const amber = ev.kind === 'flashback' || ev.kind === 'backstory'
      singleEls.push(<path key={`st-tick-${i}`} className="tl-tick" d={`M ${x},28 V 44`} />)
      singleEls.push(
        <circle
          key={`st-dot-${i}`}
          className={classNames('tl-dot', amber && 'is-backstory', ev.kind === 'future' && 'is-future')}
          cx={x}
          cy={36}
          r={6}
        >
          <title>{`${ev.at} · ${ev.label} · ${kindOf(ev.kind)}${ev.anchorAt ? ` · 对应锚点 ${ev.anchorAt}` : ''}`}</title>
        </circle>,
      )
      // 事件较多时标签上下交错，避免文字拥挤
      const ly = singleOrder.length >= 4 && i % 2 === 1 ? 22 : 20
      singleEls.push(
        <text key={`st-lb-${i}`} className="tl-label" textAnchor="middle" x={x} y={ly}>
          {ev.label}
        </text>,
      )
      singleEls.push(
        <text key={`st-at-${i}`} className="tl-at" textAnchor="middle" x={x} y={54}>
          {ev.at}
        </text>,
      )
      singleEls.push(
        <text key={`st-ty-${i}`} className="tl-label-sub" textAnchor="middle" x={x} y={68}>
          {kindOf(ev.kind)}
        </text>,
      )
    })
    const flashCount = events.filter((e) => e.kind === 'flashback').length
    const singleNote =
      ne === 1
        ? `本章 1 个事件：${events[0].at}「${events[0].label}」`
        : `本章 ${ne} 个事件横跨「${events[0].at} → ${events[ne - 1].at}」`

    const singleCard: ReactNode = (
      <section className="card">
        <div className="card-head">
          <h2>故事内时间线</h2>
          <span className="tag tag-quiet">{`${ne} 个事件`}</span>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="tl-wrap">
            <svg viewBox="0 0 900 90" role="img" aria-label="故事内时间线">
              {singleEls}
            </svg>
          </div>
          <div className="legend" style={{ borderTop: 'none' }}>
            <div className="legend-item">
              <span className="legend-swatch is-node" style={{ background: 'var(--accent)', borderColor: 'var(--accent)' }} />
              <span>顺叙</span>
            </div>
            <div className="legend-item">
              <span className="legend-swatch is-node" style={{ background: 'var(--amber)', borderColor: 'var(--amber)' }} />
              <span>闪回</span>
            </div>
            <div className="legend-item">
              <span className="legend-swatch is-node" style={{ background: 'var(--ink-4)', borderColor: 'var(--ink-4)' }} />
              <span>预叙</span>
            </div>
          </div>
        </div>
        <div className="card-body">
          <div className="chart-note">
            <strong>{singleNote}</strong>
            {` · 单轨按故事内先后排布，尽量对齐到全书锚点的时序${
              locatedEvs.length
                ? `：${locatedEvs.length} 个事件已对齐到锚点、${unlocatedEvs.length} 个暂未对齐`
                : ''
            }；琥珀为闪回、深灰为预叙`}
          </div>
        </div>
      </section>
    )

    if (!ne) {
      return (
        <div className="stack-24">
          {singleCard}
          <section className="card">
            <div className="card-head">
              <h2>本章事件 ↔ 全书时间锚点</h2>
              <span className="tag tag-quiet">0 个事件</span>
            </div>
            <div className="card-body">
              <div className="empty">
                <Icon name="refresh-cw" size={24} />
                <span className="fs-13">本章还没有故事内时间事件</span>
                <span className="fs-12 muted">时间线在章纲或正文生成后自动提取</span>
              </div>
              <div className="chart-note is-ok" style={{ marginTop: 12 }}>
                <strong>本章无时间事件</strong>
                {` · 全书现有 ${na} 个时间锚点，本章暂无可对照的事件`}
              </div>
            </div>
          </section>
        </div>
      )
    }

    /* ---------- 双轨 · 本章事件 ↔ 全书时间锚点 ---------- */
    const upperX = (i: number) => (ne <= 1 ? 500 : 140 + i * (680 / Math.max(1, ne - 1)))
    const lowerX = (j: number) => 130 + j * (720 / Math.max(1, na - 1))

    const linkEls: ReactNode[] = []
    const upperEls: ReactNode[] = []
    const lowerEls: ReactNode[] = []

    events.forEach((ev, i) => {
      const xi = upperX(i)
      if (ev.anchorId) {
        const j = anchors.findIndex((a) => a.id === ev.anchorId)
        if (j >= 0) {
          const ax = lowerX(j)
          const amber = anchors[j].kind === 'backstory' || anchors[j].kind === 'flashback'
          linkEls.push(
            <path
              key={`lk-${i}`}
              className={classNames('tl2-link', amber && 'is-backstory')}
              d={`M ${xi},86 C ${xi},150 ${ax},150 ${ax},214`}
            />,
          )
        }
      }
      upperEls.push(
        <circle key={`ud-${i}`} className={classNames('tl2-dot', dotCls(ev.kind))} cx={xi} cy={80} r={6}>
          <title>{`${ev.at} · ${ev.label} · ${kindOf(ev.kind)}${
            ev.anchorAt ? ` · 对应锚点 ${ev.anchorAt}` : ''
          }`}</title>
        </circle>,
      )
      upperEls.push(
        <text key={`ul-${i}`} className="tl2-label" textAnchor="middle" x={xi} y={58}>{ev.label}</text>,
      )
      upperEls.push(
        <text key={`ua-${i}`} className="tl2-at" textAnchor="middle" x={xi} y={102}>{ev.at}</text>,
      )
    })

    anchors.forEach((a, j) => {
      const xj = lowerX(j)
      lowerEls.push(
        <circle key={`ad-${j}`} className={classNames('tl2-dot', dotCls(a.kind))} cx={xj} cy={220} r={5}>
          <title>{`${a.storyAt} · ${a.label} · ${kindOf(a.kind)}${
            a.chapters.length ? ` · 第 ${a.chapters.join('、')} 章` : ''
          }`}</title>
        </circle>,
      )
      lowerEls.push(
        <text key={`aa-${j}`} className="tl2-at" textAnchor="middle" x={xj} y={198}>{a.storyAt}</text>,
      )
      lowerEls.push(
        <text key={`al-${j}`} className="tl2-label" textAnchor="middle" x={xj} y={242}>{a.label}</text>,
      )
    })

    const nowIdx = anchors.findIndex((a) => a.chapters.includes(ch.chapter))
    const nowEls: ReactNode[] =
      nowIdx >= 0
        ? [
            <path key="now" className="tl2-now" d={`M ${lowerX(nowIdx)},58 V 252`} />,
            <text key="now-t" className="tl2-now-label" textAnchor="middle" x={lowerX(nowIdx)} y={266}>本章</text>,
          ]
        : []

    const back = anchors.filter((a) => a.kind === 'backstory' || a.kind === 'flashback').length
    const ahead = anchors.filter((a) => a.kind === 'future').length
    const planned = anchors.filter((a) => a.kind === 'planned').length

    return (
      <div className="stack-24">
        {singleCard}
        <section className="card">
          <div className="card-head">
            <h2>本章事件 ↔ 全书时间锚点</h2>
            <span className="tag tag-quiet">{`${located} / ${total} 个事件已定位`}</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="tl2-wrap">
              <svg viewBox="0 0 900 300" role="img" aria-label="本章事件与全书时间锚点对照">
                <path className="tl2-rail" d="M 120,80 H 860" />
                <path className="tl2-rail" d="M 120,220 H 860" />
                <text className="tl2-rail-label" textAnchor="end" x={108} y={84}>本章事件</text>
                <text className="tl2-rail-label" textAnchor="end" x={108} y={224}>全书时间锚点</text>
                {linkEls}
                {upperEls}
                {lowerEls}
                {nowEls}
              </svg>
            </div>
            <div className="legend" style={{ borderTop: 'none' }}>
              <div className="legend-item">
                <span className="legend-swatch is-node" style={{ background: 'var(--accent)', borderColor: 'var(--accent)' }} />
                <span>顺叙</span>
              </div>
              <div className="legend-item">
                <span className="legend-swatch is-node" style={{ background: 'var(--amber)', borderColor: 'var(--amber)' }} />
                <span>前史 / 闪回</span>
              </div>
              <div className="legend-item">
                <span className="legend-swatch is-node" style={{ background: 'var(--ink-4)', borderColor: 'var(--ink-4)' }} />
                <span>预叙</span>
              </div>
              <div className="legend-item">
                <span className="legend-swatch is-node" style={{ background: 'var(--paper-3)', borderColor: 'var(--line-strong)', borderStyle: 'dashed' }} />
                <span>尚未写入</span>
              </div>
            </div>
          </div>
          <div className="card-body">
            <div className="chart-note">
              <strong>{`本章 ${total} 个事件中 ${located} 个可对应到全书时间锚点（全书共 ${na} 个锚点）`}</strong>
              {` · 虚线把本章事件连到它在全书时间轴上的位置：其中 ${flashCount} 个为闪回、${back} 个锚点为背景 / 闪回、${ahead} 个预叙、${planned} 个尚未写入`}
            </div>
          </div>
        </section>
      </div>
    )
  }

  /* ---------- 视图 4 · 结构位置 ---------- */

  function renderStructure(): ReactNode {
    const chs = [...s.chapters].sort((a, b) => a.n - b.n)
    const W = 900
    const maxC = chs.length ? chs[chs.length - 1].n : 1
    const x = (c: number) => (maxC > 1 ? 70 + (c - 1) * ((W - 140) / (maxC - 1)) : W / 2)
    const yInt = (v: number) => 200 - ((Math.min(5, Math.max(1, v)) - 1) / 4) * 130

    const acts = d.acts
    const actEls: ReactNode[] = []
    acts.forEach((a, i) => {
      // 骨架卷可能没有结束章（to = 0），按后端口径回落到起始章
      const toN = a.to && a.to > 0 ? a.to : a.from
      const xa = Math.max(12, x(a.from) - 22)
      const xb = Math.min(W - 12, x(toN) + 22)
      actEls.push(
        <rect key={`act-${i}`} className="struct-act" x={xa} y={40} width={Math.max(20, xb - xa)} height={180} />,
      )
      actEls.push(
        <text key={`act-t-${i}`} className="struct-act-name" textAnchor="middle" x={(xa + xb) / 2} y={32}>
          {a.name}
        </text>,
      )
      if (i > 0) actEls.push(<path key={`act-l-${i}`} className="struct-act-line" d={`M ${xa},40 V 220`} />)
    })

    const firstN = chs.length ? chs[0].n : 1
    const areaD = chs.length
      ? `M ${x(firstN)},200 ${chs.map((c) => `L ${x(c.n)},${yInt(c.intensity)}`).join(' ')} L ${x(maxC)},200 Z`
      : ''
    const lineD = chs.map((c, i) => `${i ? 'L' : 'M'} ${x(c.n)},${yInt(c.intensity)}`).join(' ')

    const cur = chs.find((c) => c.n === ch.chapter)
    const curIntensity = cur?.intensity ?? d.node?.intensity ?? 3
    const beatText = d.node?.title || ch.title
    const peak = chs.length ? Math.max(...chs.map((c) => c.intensity)) : curIntensity

    const beats = d.beats
    const past = beats.filter((b) => b.status === 'past').length
    const current = beats.filter((b) => b.status === 'current').length
    const future = beats.length - past - current
    const curBeat = beats.find((b) => b.status === 'current') ?? null

    return (
      <div className="stack-24">
        <section className="card">
          <div className="card-head">
            <h2>情节结构位置</h2>
            <span className="tag tag-info">{d.act?.name ?? '—'}</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="struct-wrap">
              <svg viewBox={`0 0 ${W} 280`} role="img" aria-label="情节结构位置">
                {actEls}
                {areaD ? <path className="struct-area" d={areaD} /> : null}
                {lineD ? <path className="struct-curve" d={lineD} /> : null}
                <path className="struct-marker-line" d={`M ${x(ch.chapter)},30 V 230`} />
                <circle className="struct-marker" cx={x(ch.chapter)} cy={yInt(curIntensity)} r={6} />
                <text className="struct-label" textAnchor="middle" x={x(ch.chapter)} y={24}>本章</text>
                <text className="struct-beat" textAnchor="middle" x={x(ch.chapter)} y={248}>{beatText}</text>
              </svg>
            </div>
          </div>
          <div className="card-body">
            <div className="chart-note">
              <strong>
                {d.act
                  ? `本章处于「${d.act.name}」（第 ${d.act.from}–${d.act.to || d.act.from} 章）`
                  : `本章节拍「${beatText}」`}
              </strong>
              {` · 张力 ${curIntensity}/5${
                curIntensity >= peak ? '，处于全书峰值区' : ''
              }；曲线为全书各章张力，朱砂虚线标记本章位置`}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>本幕节拍序列</h2>
            <span className="tag tag-info">{d.act?.name ?? '—'}</span>
          </div>
          <div className="card-body">
            {beats.length ? (
              <div className="actline">
                {beats.map((b, i) => (
                  <span key={b.chapter} style={{ display: 'contents' }}>
                    <div
                      className={classNames(
                        'actline-beat',
                        b.status === 'past' && 'is-past',
                        b.status === 'current' && 'is-current',
                      )}
                      title={b.goal}
                    >
                      <div className="actline-name">{b.title || `第 ${b.chapter} 章`}</div>
                      <div className="actline-meta">{`第 ${b.chapter} 章`}</div>
                    </div>
                    {i < beats.length - 1 ? (
                      <span className="actline-arrow">
                        <Icon name="chevron-right" size={16} />
                      </span>
                    ) : null}
                  </span>
                ))}
              </div>
            ) : (
              <div className="empty">
                <span className="fs-12">本幕暂无节拍数据</span>
              </div>
            )}
            <div className="chart-note" style={{ marginTop: 16 }}>
              <strong>{`本幕 ${beats.length} 个节拍：${past} 已过 · ${current} 进行中${future > 0 ? ` · ${future} 未到` : ''}`}</strong>
              {curBeat
                ? ` · 当前第 ${ch.chapter} 章正处于「${curBeat.title || `第 ${curBeat.chapter} 章`}」（第 ${curBeat.chapter} 章）`
                : ' · 当前章不在本幕节拍序列中'}
            </div>
          </div>
        </section>
      </div>
    )
  }

  /* ---------- 视图 5 · 问题鱼骨 ---------- */

  function renderFishbone(): ReactNode {
    const fb = d.fishbone

    if (!fb) {
      return (
        <section className="card">
          <div className="card-head">
            <h2>问题归因（鱼骨）</h2>
            <span className="tag tag-quiet">0 类成因</span>
          </div>
          <div className="card-body">
            <div className="empty">
              <Icon name="alert-triangle" size={24} />
              <span className="fs-13">本章暂无审查结论</span>
              <span className="fs-12 muted">先跑一次审查，才能把问题按维度归因</span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => void runAuditNow()}
              >
                {busy ? '审查中…' : '去跑审查'}
              </button>
            </div>
            <div className="chart-note is-ok" style={{ marginTop: 12 }}>
              <strong>本章未发现需要归因的问题</strong>
              {` · 鱼骨图会在审查发现不少于 1 项时自动生成`}
            </div>
          </div>
        </section>
      )
    }

    const causes = fb.causes
    const sev = SEVERITY[fb.severity] ?? SEVERITY.minor
    const shown = causes.slice(0, 4)
    const parts: ReactNode[] = []
    shown.forEach((c, i) => {
      const dir = i % 2 === 0 ? -1 : 1
      const bx = 120 + i * 152
      const tipy = 170 + dir * 90
      parts.push(<path key={`rib-${i}`} className="fish-rib" d={`M ${bx},170 L ${bx - 60},${tipy}`} />)
      parts.push(
        <text key={`cat-${i}`} className="fish-cat" textAnchor="end" x={bx - 64} y={tipy + dir * 14}>
          {c.category}
        </text>,
      )
      const items = c.items
      const m = items.length
      items.forEach((it, j) => {
        const t = (j + 1) / (m + 1)
        const px = bx - 60 * t
        const py = 170 + dir * 90 * t
        const short = it.length > 16 ? `${it.slice(0, 16)}…` : it
        parts.push(<circle key={`dot-${i}-${j}`} className="fish-cause-dot" cx={px} cy={py} r={2.5} />)
        parts.push(
          <text key={`it-${i}-${j}`} className="fish-cause" textAnchor="end" x={px - 8} y={py + 4}>
            {short}
            <title>{it}</title>
          </text>,
        )
      })
    })

    const itemCount = causes.reduce((a, c) => a + c.items.length, 0)
    const extra = causes.length > 4 ? `另有 ${causes.length - 4} 类未显示。` : ''

    return (
      <section className="card">
        <div className="card-head">
          <h2>问题归因（鱼骨）</h2>
          <span className={classNames('tag', sev[0])} title={fb.severity}>{sev[1]}</span>
        </div>
        <div className="card-body">
          <div className="fs-13" style={{ marginBottom: 12 }}>
            <span className="tag tag-danger">问题</span> {fb.title}
          </div>
          <div className="fish-wrap">
            <svg viewBox="0 0 900 340" role="img" aria-label="问题归因鱼骨图">
              <path className="fish-spine" d="M 40,170 H 750" />
              <rect className="fish-head" x={750} y={144} width={130} height={52} rx={10} />
              <text className="fish-head-text" textAnchor="middle" x={815} y={166}>问题</text>
              <text className="fish-head-text" textAnchor="middle" x={815} y={184}>待归因</text>
              {parts}
            </svg>
          </div>
          <div className={classNames('chart-note', fb.severity === 'blocker' ? 'is-danger' : 'is-warn')} style={{ marginTop: 12 }}>
            <strong>{`1 个问题 · ${causes.length} 类成因 · ${itemCount} 条具体原因`}</strong>
            {` · 鱼骨用于归因：每根刺上的条目都对应一条可定位的审查证据${extra}`}
          </div>
        </div>
      </section>
    )
  }

  const views: Record<ViewKey, () => ReactNode> = {
    pipeline: renderPipeline,
    flow: renderFlow,
    timeline: renderTimeline,
    structure: renderStructure,
    fishbone: renderFishbone,
  }

  const chapterOptions = structure.chapters

  return (
    <>
      <TopBar
        title={`第 ${ch.chapter} 章 · ${ch.title || '（未命名）'}`}
        sub={`${fmtInt(ch.words)} 字 · 张力 ${detail.node?.intensity ?? curSafeIntensity(structure, chapterNo)}/5 · ${ch.pov || '—'} 视角`}
        crumb={
          <Crumb items={[{ label: '结构', to: '/outline' }, { label: `第 ${chapterNo} 章` }]} />
        }
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={prevN == null}
              onClick={() => go(prevN)}
            >
              <Icon name="chevron-left" size={16} />
              上一章
            </button>
            <select
              className="select"
              style={{ height: 30, width: 200 }}
              value={String(ch.chapter)}
              aria-label="跳转到指定章节"
              onChange={(e) => go(Number(e.target.value))}
            >
              {chapterOptions.length ? (
                chapterOptions.map((c) => (
                  <option key={c.n} value={c.n}>
                    {`第 ${c.n} 章 · ${c.title || '（未命名）'}`}
                  </option>
                ))
              ) : (
                <option value={ch.chapter}>{`第 ${ch.chapter} 章`}</option>
              )}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={nextN == null}
              onClick={() => go(nextN)}
            >
              下一章
              <Icon name="chevron-right" size={16} />
            </button>
          </>
        }
      />

      <div className="grid-4" style={{ marginBottom: 24 }}>
        <div className="stat">
          <div className="stat-label">字数</div>
          <div className="stat-value">{fmtInt(ch.words)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">状态</div>
          <div className="stat-value fs-16">{st[1]}</div>
        </div>
        <div className="stat">
          <div className="stat-label">视角</div>
          <div className="stat-value fs-16">{ch.pov || '—'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">本章花费</div>
          <div className="stat-value">
            {fmtMoney(pipe.cost)}
            <small>{`${fmtInt(pipe.tokens)} 额度`}</small>
          </div>
        </div>
      </div>

      {/*—— 本章梗概：把归档生成的本章短文亮出来；没有时给出友好空态，不伪造内容 ——*/}
      <section className="card" style={{ marginBottom: 24 }}>
        <div className="card-head">
          <h2>本章梗概</h2>
          <span className="tag tag-quiet">{chapterSummary ? '已归档' : '暂无'}</span>
        </div>
        <div className="card-body">
          {chapterSummary ? (
            <div className="fs-14" style={{ lineHeight: 1.8, maxWidth: 820 }}>
              {chapterSummary}
            </div>
          ) : (
            <div className="empty">
              <Icon name="library" size={24} />
              <span className="fs-13">还没有梗概，先规划或生成本章</span>
              <span className="fs-12 muted">本章梗概在归档环节自动沉淀，可作为前情回顾复用</span>
            </div>
          )}
        </div>
      </section>

      <div className="viewbar">
        <div className="viewbar-tabs" role="tablist" aria-label="章节视图">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={v === view}
              className={classNames('vtab', v === view && 'active')}
              onClick={() => setView(v)}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        <span className="fs-12 muted">{VIEW_HINT[view]}</span>
      </div>

      {views[view]()}

      <ContextCard ctx={detail.context} />
    </>
  )
}

/** 章纲缺失时，回落到结构里的本章张力，再不然给 3 */
function curSafeIntensity(structure: Structure, n: number): number {
  return structure.chapters.find((c) => c.n === n)?.intensity ?? 3
}
