import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { ErrorState } from '../components/ErrorState'
import { Loading } from '../components/Loading'
import { TopBar } from '../components/Layout'
import { classNames, fmtInt, toast } from '../lib/ui'
import { getProject, getStructure, request, rollPlan, runPlan } from '../api/client'
import { useProject } from '../state/project'

/**
 * 结构与大纲（九视图）。
 *
 * 数据全部来自真实接口：`GET /structure`（章节 / 卷 / 章纲 / 依赖边 / 罗盘 / 情节线 / 故事锚点）
 * 与 `GET /plan/coverage`（覆盖率）。视图分组见设计契约批次八：
 *   走向 [tree, beats, curve] · 时间 [timeline, plotlines] · 生产 [pipeline] · 明细 [overview, board, graph]
 * 视觉、坐标、交互照 `/prototype/do-bi/outline.html`；图类名全部取自 `styles/contract.css`，
 * 动态数值（SVG 坐标 / 宽度 / 颜色）用内联属性或 style，这是契约允许且必要的。
 */

/* ------------------------------------------------------------------ *
 * 数据形状（实测 dump，camelCase）
 * ------------------------------------------------------------------ */

type RawStatus = 'todo' | 'planned' | 'draft' | 'audit' | 'revise' | 'done'
/** 页面统一的四态：未写 / 草稿 / 审查中 / 已定稿 */
type Canon = 'todo' | 'draft' | 'review' | 'done'

interface Chapter {
  n: number
  title: string
  status: RawStatus
  words: number
  pov: string
  volume: string
  arc: string
  intensity: number
  updated: string
  summary: string
}

interface Volume {
  name: string
  fromChapter: number
  toChapter: number
  goal: string
  estChapters: number
  status: 'skeleton' | 'expanded'
  arc: string
}

interface OutlineNode {
  chapter: number
  title: string
  arc: string
  volume: string
  status: 'skeleton' | 'planned' | 'written' | 'audit' | 'draft'
  goal: string
  beats: string[]
  rationale: string
  pov: string
  intensity: number
  storyAt: string
  timeline: Array<{ at: string; label: string; kind: string }>
}

interface OutlineEdge {
  fromChapter: number
  toChapter: number
  type: 'motivation' | 'setup' | 'payoff' | 'causality' | 'parallel'
  note: string
  confirmed: boolean
}

interface Compass {
  endgame: string
  activeThreads: string[]
  scaleEstimate: string
  refreshAt: string
}

interface Plotline {
  id: string
  name: string
  kind: 'main' | 'sub'
  summary: string
  color: string
  active: number[]
  peak: number[]
  status: string
}

interface Anchor {
  id: string
  storyAt: string
  label: string
  kind: 'backstory' | 'flashback' | 'now' | 'future' | 'planned'
  chapters: number[]
  note: string
}

interface Structure {
  chapters: Chapter[]
  volumes: Volume[]
  nodes: OutlineNode[]
  edges: OutlineEdge[]
  compass: Compass
  plotlines: Plotline[]
  anchors: Anchor[]
  kindLabels: Record<string, string>
  updatedAt: string
}

interface Coverage {
  compass: Compass
  volumes: Array<{ name: string; from: number; to: number; status: string; goal: string; chapters: number }>
  expandedVolumes: number
  skeletonVolumes: number
  nodes: number
  detailedNodes: number
  edges: number
  unconfirmedEdges: number
  chapterRange: [number, number]
  skeletonChapters: number[]
}

interface PlanResult {
  action?: string
  changed?: string[]
  cost?: number
  notes?: string[]
  issues?: unknown[]
}

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

function countBy<T>(list: T[], key: (x: T) => string): Record<string, number> {
  const m: Record<string, number> = {}
  for (const x of list) {
    const k = key(x)
    m[k] = (m[k] ?? 0) + 1
  }
  return m
}

function uniq(list: string[]): string[] {
  const out: string[] = []
  for (const x of list) if (x && out.indexOf(x) < 0) out.push(x)
  return out
}

function trunc(s: string, n: number): string {
  const v = s ?? ''
  return v.length > n ? v.slice(0, n) + '…' : v
}

/** 原始状态 → 页面四态 */
function canon(status: string): Canon {
  if (status === 'done') return 'done'
  if (status === 'draft') return 'draft'
  if (status === 'audit' || status === 'revise') return 'review'
  return 'todo'
}

/** 骨架卷尚未定死结束章时，用 estChapters 推算 */
function effTo(v: Volume): number {
  return v.toChapter > 0 ? v.toChapter : v.fromChapter + Math.max(1, v.estChapters) - 1
}

/** 非原生控件（SVG `<g>` / `<div>`）的键盘可达包装：补 role + tabindex + Enter/Space */
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

const PALETTE = ['var(--accent)', 'var(--moss)', 'var(--amber)', 'var(--crimson)', 'var(--ink-3)']

/** 情节线为空时按「卷 / 弧」派生（数据零新增，全部派生） */
function derivePlotlines(s: Structure): Plotline[] {
  const nodes = s.nodes
  const chapters = s.chapters
  const volNames = new Set(s.volumes.map((v) => v.name))
  const out: Plotline[] = []

  if (s.volumes.length) {
    s.volumes.forEach((v, i) => {
      let active = chapters.filter((c) => c.volume === v.name).map((c) => c.n)
      if (!active.length) active = nodes.filter((n) => n.volume === v.name).map((n) => n.chapter)
      out.push({
        id: `vol-${i}`,
        name: v.name,
        kind: 'main',
        summary: v.goal,
        color: PALETTE[i % PALETTE.length],
        active,
        peak: [],
        status: 'active',
      })
    })
    const extra = uniq(nodes.map((n) => n.arc).filter((a) => a && !volNames.has(a)))
    extra.forEach((arc, i) => {
      out.push({
        id: `arc-${i}`,
        name: arc,
        kind: 'sub',
        summary: '由章纲派生',
        color: PALETTE[(s.volumes.length + i) % PALETTE.length],
        active: nodes.filter((n) => n.arc === arc).map((n) => n.chapter),
        peak: [],
        status: 'active',
      })
    })
  } else {
    const arcs = uniq(nodes.map((n) => n.arc || '未命名弧'))
    arcs.forEach((arc, i) => {
      out.push({
        id: `arc-${i}`,
        name: arc,
        kind: 'main',
        summary: '由章纲派生',
        color: PALETTE[i % PALETTE.length],
        active: nodes.filter((n) => (n.arc || '未命名弧') === arc).map((n) => n.chapter),
        peak: [],
        status: 'active',
      })
    })
  }

  // 派生线的「高潮」＝该线活跃章里张力 ≥4 的章（真实情节线的 peak 用后端数据）
  return out.map((pl) => {
    if (pl.peak.length) return pl
    const byN = new Map(chapters.map((c) => [c.n, c]))
    return { ...pl, peak: pl.active.filter((n) => (byN.get(n)?.intensity ?? 0) >= 4) }
  })
}

/** 章节状态计数三连（计数为 0 的标签不渲染，避免「0 未写」噪声） */
function StatusTags({ chapters }: { chapters: Chapter[] }) {
  const c = countBy(chapters, (x) => canon(x.status))
  return (
    <>
      {(c.done ?? 0) > 0 ? <span className="tag tag-ok">{c.done} 已定稿</span> : null}
      {(c.review ?? 0) > 0 ? <span className="tag tag-warn">{c.review} 审查中</span> : null}
      {(c.draft ?? 0) > 0 ? <span className="tag tag-info">{c.draft} 草稿</span> : null}
      {(c.todo ?? 0) > 0 ? <span className="tag tag-quiet">{c.todo} 未写</span> : null}
    </>
  )
}

/* ================================================================== *
 * 视图 1 · 故事树（章节结构视角：主干 1→N + 卷分带 + 支线分岔合流）
 * ================================================================== */

const TX0 = 60
const TSTEP = 45
const Y_TRUNK = 150
const TREE_TIERS = [Y_TRUNK - 26, Y_TRUNK - 44, Y_TRUNK - 62]

function tx(ch: number): number {
  return TX0 + (ch - 1) * TSTEP
}

function treeNodeClass(status: string): string {
  const c = canon(status)
  if (c === 'review') return 'is-audit'
  if (c === 'draft') return 'is-draft'
  if (c === 'todo') return 'is-todo'
  return ''
}

function StoryTree({ s, lines, onOpen }: { s: Structure; lines: Plotline[]; onOpen: (n: number) => void }) {
  const chapters = useMemo(() => [...s.chapters].sort((a, b) => a.n - b.n), [s.chapters])
  const vols = s.volumes
  const W = 980
  const H = 470
  const nMax = chapters.length ? chapters[chapters.length - 1].n : 1
  const xMax = tx(nMax)

  // 卷分带（只填奇数索引卷）/ 卷名 / 分卷虚线
  const bands: ReactNode[] = []
  const volLabels: ReactNode[] = []
  const splits: ReactNode[] = []
  vols.forEach((v, i) => {
    const from = v.fromChapter || 1
    const to = effTo(v)
    const xa = Math.max(tx(from), tx(1) - 22)
    const xb = Math.min(tx(to), xMax + 22)
    if (i % 2 === 1 && xb - xa + 44 > 0) {
      bands.push(<rect key={`band-${i}`} className="tree-vol-band" x={xa - 22} y={30} width={xb - xa + 44} height={400} />)
    }
    volLabels.push(
      <text key={`vol-${i}`} className="tree-vol-label" x={xa - 14} y={26} textAnchor="start">
        {v.name}
      </text>,
    )
    if (i > 0) splits.push(<path key={`split-${i}`} className="tree-vol-split" d={`M ${xa - 28},30 V 430`} />)
  })

  // 关键章：张力 ≥4、未定稿，或落在任一支线的分岔 / 收束章（固定派生规则）
  const subEnds: Record<number, boolean> = {}
  lines
    .filter((l) => l.kind === 'sub')
    .forEach((l) => {
      if (!l.active.length) return
      subEnds[Math.min(...l.active)] = true
      subEnds[Math.max(...l.active)] = true
    })
  const isKey: Record<number, boolean> = {}
  chapters.forEach((c) => {
    if (c.intensity >= 4 || c.status !== 'done' || subEnds[c.n]) isKey[c.n] = true
  })
  const lastUsed = [-99, -99, -99]
  const keyY: Record<number, number> = {}
  chapters.forEach((c) => {
    if (!isKey[c.n]) return
    let pick = TREE_TIERS.length - 1
    for (let k = 0; k < TREE_TIERS.length; k++) {
      if (c.n - lastUsed[k] >= 3) {
        pick = k
        break
      }
    }
    lastUsed[pick] = c.n
    keyY[c.n] = TREE_TIERS[pick]
  })

  const trunk = <path className="tree-trunk" d={`M ${tx(1)},${Y_TRUNK} L ${xMax},${Y_TRUNK}`} />

  // 支线：下落 → 沿轨道 → 回收
  const branchEls: ReactNode[] = []
  lines
    .filter((l) => l.kind === 'sub')
    .forEach((pl, i) => {
      if (!pl.active.length) return
      const branch = Math.min(...pl.active)
      const merge = Math.max(...pl.active)
      const yB = Y_TRUNK + 76 + i * 56
      const mid = (Y_TRUNK + 15 + yB) / 2
      const x1 = tx(branch)
      const x2 = tx(merge)
      branchEls.push(
        <path
          key={`br-${i}`}
          className="tree-branch"
          style={{ stroke: pl.color }}
          d={
            `M ${x1},${Y_TRUNK + 15} C ${x1},${mid} ${x1 + 18},${mid} ${x1 + 18},${yB}` +
            ` L ${x2 - 18},${yB} C ${x2 - 18},${mid} ${x2},${mid} ${x2},${Y_TRUNK + 15}`
          }
        />,
      )
      pl.active.forEach((ch, k) => {
        branchEls.push(<circle key={`bd-${i}-${k}`} className="tree-branch-dot" cx={tx(ch)} cy={yB} r={4} style={{ fill: pl.color }} />)
      })
      const cx = (x1 + x2) / 2
      branchEls.push(
        <text key={`bl-${i}`} className="tree-branch-label" textAnchor="middle" x={cx} y={yB - 9} style={{ fill: pl.color }}>
          {pl.name}
        </text>,
      )
      branchEls.push(
        <text key={`bc-${i}`} className="tree-branch-caption" textAnchor="middle" x={cx} y={yB + 8}>
          {branch === merge ? `第 ${branch} 章` : `第 ${branch} 章分岔 → 第 ${merge} 章收束`}
        </text>,
      )
    })

  // 章节轴
  const ticks = [1, 5, 10, 15, 20].filter((n) => n <= nMax)
  if (ticks.length === 0 || ticks[ticks.length - 1] !== nMax) ticks.push(nMax)
  const axisEls: ReactNode[] = [<path key="axis" className="tree-axis-line" d="M 40,430 H 940" />]
  ticks.forEach((n) => {
    axisEls.push(
      <text key={`ax-${n}`} className="tree-axis" textAnchor="middle" x={tx(n)} y={446}>
        {n}
      </text>,
    )
  })

  // 章节节点 + 关键章两行标签
  const nodeEls = chapters.map((c) => {
    const cls = classNames('tree-node', treeNodeClass(c.status), c.intensity >= 5 && 'is-peak')
    const cx = tx(c.n)
    const ky = keyY[c.n]
    return (
      <g key={c.n} className={cls} {...press(() => onOpen(c.n))}>
        <title>{`第${c.n}章 · ${c.title} · 强度${c.intensity}`}</title>
        <rect x={cx - 15} y={Y_TRUNK - 15} width={30} height={30} rx={6} />
        <text className="tn-n" textAnchor="middle" x={cx} y={Y_TRUNK + 4}>
          {c.n}
        </text>
        {ky == null ? null : (
          <>
            <text className="tn-t" textAnchor="middle" x={cx} y={ky}>
              {c.title}
            </text>
            <text className="tn-s" textAnchor="middle" x={cx} y={ky + 13}>
              {`第${c.n}章 · 强度${c.intensity}`}
            </text>
          </>
        )}
      </g>
    )
  })

  const c = countBy(chapters, (x) => canon(x.status))
  const subCount = lines.filter((l) => l.kind === 'sub').length

  return (
    <section className="card">
      <div className="card-head">
        <h2>故事树</h2>
        <div className="row">
          <StatusTags chapters={chapters} />
        </div>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <div className="tree-wrap">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="故事树">
            {bands}
            {volLabels}
            {splits}
            {trunk}
            {branchEls}
            {axisEls}
            {nodeEls}
          </svg>
        </div>
        <div className="legend">
          <div className="legend-item">
            <span className="legend-swatch" />
            <span>主干</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch is-node" style={{ background: 'var(--paper-2)', borderColor: 'var(--line-strong)' }} />
            <span>已定稿</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch is-node" style={{ background: 'var(--amber-soft)', borderColor: 'var(--amber)' }} />
            <span>审查中</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch is-node" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)' }} />
            <span>草稿</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch is-node" style={{ background: 'var(--paper-3)', borderColor: 'var(--line-strong)', borderStyle: 'dashed' }} />
            <span>未写</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch is-node" style={{ borderWidth: 2 }} />
            <span>高潮（张力 5）</span>
          </div>
          {lines
            .filter((l) => l.kind === 'sub')
            .slice(0, 6)
            .map((l) => (
              <div key={l.id} className="legend-item">
                <span className="legend-swatch" style={{ borderTopColor: l.color }} />
                <span>{l.name}</span>
              </div>
            ))}
        </div>
        <div style={{ padding: '14px 16px 16px' }}>
          <div className="chart-note">
            <strong>
              {`主干 ${chapters.length} 章：${c.done ?? 0} 已定稿 · ${c.review ?? 0} 审查中 · ${c.draft ?? 0} 草稿 · ${c.todo ?? 0} 未写`}
            </strong>
            {` · ${subCount} 条支线自分岔章长出、在收束章合流；点击章节可进入章节详情`}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== *
 * 视图 2 · 节拍骨架（卷 → 章 → 节拍块）
 * ================================================================== */

interface Beat {
  n: number
  name: string
  core: string
  st: Canon
}

function beatClass(st: Canon): string {
  if (st === 'done') return 'is-done'
  if (st === 'review' || st === 'draft') return 'is-active'
  return 'is-todo'
}

function BeatSheet({ s, current }: { s: Structure; current: number | null }) {
  const nodes = s.nodes
  const byN = new Map(s.chapters.map((c) => [c.n, c]))
  const bx = (ch: number) => 60 + (ch - 1) * 42

  const acts = useMemo(() => {
    const toBeat = (n: OutlineNode): Beat => {
      const ch = byN.get(n.chapter)
      return { n: n.chapter, name: n.title || `第 ${n.chapter} 章`, core: n.goal, st: canon(ch ? ch.status : n.status) }
    }
    if (s.volumes.length) {
      return s.volumes.map((v) => ({
        act: v.name,
        from: v.fromChapter || 1,
        to: effTo(v),
        beats: nodes
          .filter((n) => n.volume === v.name)
          .sort((a, b) => a.chapter - b.chapter)
          .map(toBeat),
      }))
    }
    return uniq(nodes.map((n) => n.arc || '未命名弧')).map((arc) => {
      const ns = nodes.filter((n) => (n.arc || '未命名弧') === arc).sort((a, b) => a.chapter - b.chapter)
      return { act: arc, from: ns[0]?.chapter ?? 1, to: ns[ns.length - 1]?.chapter ?? 1, beats: ns.map(toBeat) }
    })
  }, [s.volumes, nodes, byN])

  const allBeats = acts.flatMap((a) => a.beats)
  const bc = countBy(allBeats, (b) => b.st)
  const maxN = allBeats.length ? Math.max(...allBeats.map((b) => b.n)) : 1

  const actEls: ReactNode[] = []
  const linkEls: ReactNode[] = []
  const beatEls: ReactNode[] = []
  acts.forEach((a, ai) => {
    const xa = bx(a.from)
    const xb = bx(a.to)
    const ax = bx((a.from + a.to) / 2)
    actEls.push(<rect key={`act-${ai}`} className="beat-act" x={xa - 16} y={30} width={xb - xa + 32} height={42} rx={6} />)
    actEls.push(
      <text key={`act-t-${ai}`} className="beat-act-name" textAnchor="middle" x={ax} y={56}>
        {a.act}
      </text>,
    )
    a.beats.forEach((b, bi) => {
      const bmid = bx(b.n)
      linkEls.push(<path key={`link-${ai}-${bi}`} className="beat-link" d={`M ${ax},72 V 88 H ${bmid} V 104`} />)
      beatEls.push(
        <g key={`beat-${ai}-${bi}`}>
          <rect className={`beat-block ${beatClass(b.st)}`} x={bmid - 18} y={104} width={36} height={40} rx={6}>
            <title>{`${b.name} · 第 ${b.n} 章 · ${b.core}`}</title>
          </rect>
          <text className="beat-name" textAnchor="middle" x={bmid} y={128}>
            {trunc(b.name, 4)}
          </text>
        </g>,
      )
    })
  })

  const ticks = [1, 5, 10, 15, 20].filter((n) => n <= maxN)
  if (ticks.length === 0 || ticks[ticks.length - 1] !== maxN) ticks.push(maxN)
  const axisEls: ReactNode[] = [<path key="axis" className="beat-axis-line" d="M 40,180 H 880" />]
  ticks.forEach((n) => {
    axisEls.push(
      <text key={`ax-${n}`} className="beat-axis" textAnchor="middle" x={bx(n)} y={196}>
        {n}
      </text>,
    )
  })

  const marker =
    current == null ? null : (
      <>
        <path className="beat-marker" d={`M ${bx(current)},16 V 186`} />
        <circle className="beat-marker-dot" cx={bx(current)} cy={180} r={5} />
        <text className="beat-marker-label" textAnchor="middle" x={bx(current)} y={12}>
          {`当前 · 第 ${current} 章`}
        </text>
      </>
    )

  const curBeat = current == null ? null : allBeats.find((b) => b.n === current) ?? null
  const curAct = current == null ? null : acts.find((a) => a.beats.some((b) => b.n === current)) ?? null

  return (
    <section className="card">
      <div className="card-head">
        <h2>节拍骨架</h2>
        <div className="row">
          {(bc.done ?? 0) > 0 ? <span className="tag tag-ok">{bc.done} 已定稿</span> : null}
          {(bc.review ?? 0) > 0 ? <span className="tag tag-warn">{bc.review} 审查中</span> : null}
          {(bc.draft ?? 0) > 0 ? <span className="tag tag-info">{bc.draft} 草稿</span> : null}
          {(bc.todo ?? 0) > 0 ? <span className="tag tag-quiet">{bc.todo} 未写</span> : null}
        </div>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <div className="beat-wrap">
          <svg viewBox="0 0 900 230" role="img" aria-label="节拍骨架">
            {actEls}
            {linkEls}
            {beatEls}
            {axisEls}
            {marker}
          </svg>
        </div>
        <div style={{ padding: '14px 16px 16px' }}>
          <div className="chart-note">
            <strong>
              {`${acts.length} 幕 ${allBeats.length} 节拍：${bc.done ?? 0} 已定稿 · ${bc.review ?? 0} 审查中 · ${bc.draft ?? 0} 草稿 · ${bc.todo ?? 0} 未写`}
            </strong>
            {` · 由章纲派生（卷＝幕、每章一块，块内为该章目标）；`}
            {curBeat
              ? `当前写作位置在第 ${curBeat.n} 章「${curBeat.name}」，属于「${curAct?.act ?? '—'}」`
              : '当前没有待写章节'}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== *
 * 视图 3 · 节奏曲线（按章张力 1–5，含自动诊断）
 * ================================================================== */

function RhythmCurve({ s }: { s: Structure }) {
  const chapters = useMemo(() => [...s.chapters].sort((a, b) => a.n - b.n), [s.chapters])
  const vols = s.volumes
  const W = 980
  const H = 320
  const nMax = chapters.length ? chapters[chapters.length - 1].n : 1
  const xMax = tx(nMax)
  const yInt = (v: number) => 250 - ((v - 1) / 4) * 180

  const bands: ReactNode[] = []
  const volLabels: ReactNode[] = []
  vols.forEach((v, i) => {
    const xa = Math.max(tx(v.fromChapter || 1), tx(1) - 22)
    const xb = Math.min(tx(effTo(v)), xMax + 22)
    if (i % 2 === 1 && xb - xa + 44 > 0) {
      bands.push(<rect key={`band-${i}`} className="curve-band" x={xa - 22} y={40} width={xb - xa + 44} height={225} />)
    }
    volLabels.push(
      <text key={`vol-${i}`} className="curve-label" x={xa - 14} y={30}>
        {v.name}
      </text>,
    )
  })

  const grid: ReactNode[] = []
  const scale: ReactNode[] = []
  for (let v = 1; v <= 5; v++) {
    grid.push(<path key={`g-${v}`} className={v === 3 ? 'curve-grid-strong' : 'curve-grid'} d={`M 40,${yInt(v)} H 940`} />)
    scale.push(
      <text key={`s-${v}`} className="curve-axis" textAnchor="end" x={34} y={yInt(v) + 3}>
        {v}
      </text>,
    )
  }

  const areaD = `M ${tx(1)},250 ${chapters.map((c) => `L ${tx(c.n)},${yInt(c.intensity)}`).join(' ')} L ${xMax},250 Z`
  const lineD = chapters.map((c, i) => `${i ? 'L' : 'M'} ${tx(c.n)},${yInt(c.intensity)}`).join(' ')

  const dots = chapters.map((c) => (
    <circle
      key={`d-${c.n}`}
      className={classNames('curve-dot', c.intensity >= 4 && 'is-peak', c.intensity <= 2 && 'is-low')}
      cx={tx(c.n)}
      cy={yInt(c.intensity)}
      r={c.intensity >= 4 ? 5 : 4}
    />
  ))

  // 高潮标签：仅 5 级；相邻（章号差 <3）只留靠后者
  const keep: Chapter[] = []
  chapters
    .filter((c) => c.intensity === 5)
    .forEach((c) => {
      const prev = keep[keep.length - 1]
      if (prev && c.n - prev.n < 3) {
        if (c.intensity >= prev.intensity) keep[keep.length - 1] = c
      } else keep.push(c)
    })
  const peaks = keep.map((c) => (
    <text key={`p-${c.n}`} className="curve-peak-label" textAnchor="middle" x={tx(c.n)} y={yInt(c.intensity) - 12}>
      {c.title}
    </text>
  ))

  const ticks = [1, 5, 10, 15, 20].filter((n) => n <= nMax)
  if (ticks.length === 0 || ticks[ticks.length - 1] !== nMax) ticks.push(nMax)
  const axisEls: ReactNode[] = [<path key="axis" className="tree-axis-line" d="M 40,290 H 940" />]
  ticks.forEach((n) => {
    axisEls.push(
      <text key={`ax-${n}`} className="curve-axis" textAnchor="middle" x={tx(n)} y={306}>
        {n}
      </text>,
    )
  })

  // ---------- 自动诊断（纯前端计算） ----------
  const risks: Array<[Chapter, Chapter, number]> = []
  let run: Chapter[] = []
  chapters.forEach((c) => {
    if (c.intensity <= 2) {
      run.push(c)
      return
    }
    if (run.length >= 3) risks.push([run[0], run[run.length - 1], run.length])
    run = []
  })
  if (run.length >= 3) risks.push([run[0], run[run.length - 1], run.length])

  const low = chapters.reduce((m, c) => (c.intensity < m.intensity ? c : m), chapters[0])
  const highs = chapters.filter((c) => c.intensity === 5)

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>节奏曲线</h2>
          <span className="tag tag-info">按章张力 1–5</span>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="curve-wrap">
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="节奏曲线">
              {bands}
              {volLabels}
              {grid}
              {scale}
              <path className="curve-area" d={areaD} />
              <path className="curve-line" d={lineD} />
              {dots}
              {peaks}
              {axisEls}
            </svg>
          </div>
          <div style={{ padding: '14px 16px 16px' }}>
            {risks.length ? (
              <div className="chart-note is-warn">
                <strong>{`${risks.length} 处节奏风险`}</strong>
                {` · ${risks.map((r) => `第 ${r[0].n}–${r[1].n} 章张力连续 ≤2（共 ${r[2]} 章）`).join('；')}，建议插入推进事件或压缩合并`}
              </div>
            ) : (
              <div className="chart-note is-ok">
                <strong>无节奏风险</strong>
                {` · 全书张力分布均匀，没有连续 3 章以上的低强度段（共 ${chapters.length} 章）`}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 24 }}>
        <div className="card-head">
          <h2>节奏诊断</h2>
          <span className={classNames('tag', risks.length ? 'tag-warn' : 'tag-ok')}>
            {risks.length ? `${risks.length} 处风险` : '无风险'}
          </span>
        </div>
        <div className="card-body">
          <div className="stack-8">
            {risks.length ? (
              risks.map((r) => (
                <div key={`${r[0].n}-${r[1].n}`} className="audit-item sev-major">
                  <div className="row-between">
                    <span className="fs-13" style={{ fontWeight: 500 }}>
                      节奏风险
                    </span>
                    <span className="tag tag-warn">{`连续 ${r[2]} 章`}</span>
                  </div>
                  <div className="audit-fix">{`第 ${r[0].n}–${r[1].n} 章张力连续 ≤2，共 ${r[2]} 章；建议插入一个推进事件，或把其中若干章压缩合并`}</div>
                </div>
              ))
            ) : (
              <div className="fs-13 muted">张力分布均匀，无明显拖沓段</div>
            )}
            <div className="audit-item sev-minor">
              <div className="row-between">
                <span className="fs-13" style={{ fontWeight: 500 }}>
                  最低点
                </span>
                <span className="tag tag-quiet">{`张力 ${low.intensity}`}</span>
              </div>
              <div className="audit-fix">{`第 ${low.n} 章 · ${low.title} 为全书最低点，确认此处是否为有意留白`}</div>
            </div>
            <div className="fs-13 muted">
              {`全书 5 级高潮 ${highs.length} 处：${highs.length ? highs.map((c) => c.n).join('、') + ' 章' : '暂无'}`}
            </div>
          </div>
        </div>
      </section>
    </>
  )
}

/* ================================================================== *
 * 视图 4 · 剧情树（故事时间 → 章节落点，固定坐标）
 * ================================================================== */

const VTR = {
  W: 760,
  PAD: 26,
  ROOT_GAP: 40,
  BAND: 34,
  ROW: 84,
  TRUNK: 300,
  TEXT_R: 286,
  SPLIT: 356,
  LEAF0: 390,
  LEAF_W: 160,
  LEAF_H: 24,
  LEAF_GAP: 26,
}

const VTR_STAGES: Array<{ key: string; name: string }> = [
  { key: 'backstory', name: '背景设定' },
  { key: 'flashback', name: '闪回' },
  { key: 'now', name: '现在' },
  { key: 'future', name: '预叙 / 未写' },
]

function vtrStage(kind: string): string {
  return kind === 'planned' ? 'future' : kind
}

function vtrStageName(key: string): string {
  return VTR_STAGES.find((s) => s.key === key)?.name ?? key
}

function PlotTree({ s, current, onOpen }: { s: Structure; current: number | null; onOpen: (n: number) => void }) {
  const anchors = s.anchors
  const byN = new Map(s.chapters.map((c) => [c.n, c]))
  const titleOf = (n: number) => byN.get(n)?.title ?? ''
  const statusOf = (n: number) => byN.get(n)?.status ?? ''
  const { W, PAD, TRUNK, TEXT_R, SPLIT, LEAF0 } = VTR
  const ROOT_Y = PAD + 14

  // 按阶段分段：每个阶段一条分段带 + 若干锚点行
  const groups: Array<{ key: string; bandY: number; rows: Array<{ a: Anchor; y: number }> }> = []
  let y = PAD + VTR.ROOT_GAP
  anchors.forEach((a) => {
    const st = vtrStage(a.kind)
    if (!groups.length || groups[groups.length - 1].key !== st) {
      groups.push({ key: st, bandY: y, rows: [] })
      y += VTR.BAND
    }
    groups[groups.length - 1].rows.push({ a, y })
    y += VTR.ROW
  })
  const H = y + PAD + 12

  const bandEls: ReactNode[] = []
  const trunkEls: ReactNode[] = []
  groups.forEach((g, gi) => {
    bandEls.push(<rect key={`band-${gi}`} className={`vtr-band is-${g.key}`} x={PAD - 12} y={g.bandY} width={W - (PAD - 12) * 2} height={VTR.BAND - 8} rx={6} />)
    bandEls.push(<rect key={`dot-${gi}`} className={`vtr-band-dot vtr-f-${g.key}`} x={PAD - 2} y={g.bandY + 8} width={9} height={9} rx={2} />)
    bandEls.push(
      <text key={`bt-${gi}`} className="vtr-band-t" x={PAD + 14} y={g.bandY + 17}>
        {vtrStageName(g.key)}
      </text>,
    )
    const last = g.rows[g.rows.length - 1]
    const top = gi === 0 ? ROOT_Y : g.bandY
    trunkEls.push(<path key={`tr-${gi}`} className={`vtr-trunk vtr-s-${g.key}`} d={`M ${TRUNK},${top} V ${last.y + VTR.ROW}`} />)
  })

  const headEls: ReactNode[] = [
    <circle key="root" className="vtr-root" cx={TRUNK} cy={ROOT_Y} r={6} />,
    <text key="h1" className="vtr-head" textAnchor="end" x={TEXT_R} y={ROOT_Y + 4}>
      全书剧情走向
    </text>,
    <text key="h2" className="vtr-head" x={LEAF0} y={ROOT_Y + 4}>
      故事时间 → 章节落点
    </text>,
    <path key="arrow" className="vtr-arrow" d={`M ${TRUNK - 6},${H - PAD - 8} L ${TRUNK},${H - PAD + 4} L ${TRUNK + 6},${H - PAD - 8} Z`} />,
  ]

  const rowEls: ReactNode[] = []
  groups.forEach((g) => {
    g.rows.forEach(({ a, y: ry }, ri) => {
      const cy = ry + VTR.ROW / 2
      const chs = a.chapters ?? []
      const tip = `${a.storyAt} · ${a.label}${a.note ? ' · ' + a.note : ''}${chs.length ? ' · 第 ' + chs.join('、') + ' 章' : ''}`
      rowEls.push(
        <text key={`at-${g.key}-${ri}`} className="vtr-at" textAnchor="end" x={TEXT_R} y={cy - 14}>
          {a.storyAt}
        </text>,
      )
      rowEls.push(
        <text key={`lb-${g.key}-${ri}`} className="vtr-label" textAnchor="end" x={TEXT_R} y={cy + 6}>
          {trunc(a.label, 14)}
        </text>,
      )
      if (a.note) {
        rowEls.push(
          <text key={`nt-${g.key}-${ri}`} className="vtr-note" textAnchor="end" x={TEXT_R} y={cy + 24}>
            {trunc(a.note, 18)}
          </text>,
        )
      }
      rowEls.push(
        <circle key={`dotm-${g.key}-${ri}`} className={classNames('vtr-dot', a.kind === 'planned' ? 'is-planned' : `is-${vtrStage(a.kind)}`)} cx={TRUNK} cy={cy} r={7}>
          <title>{tip}</title>
        </circle>,
      )
      const n = chs.length
      if (n) {
        rowEls.push(<path key={`br-${g.key}-${ri}`} className={`vtr-branch vtr-s-${g.key}`} d={`M ${TRUNK + 7},${cy} H ${SPLIT}`} />)
        chs.forEach((ch, i) => {
          const ly = cy + (i - (n - 1) / 2) * VTR.LEAF_GAP
          const st = statusOf(ch)
          const leafCls = classNames('vtr-leaf', st === 'todo' && 'is-todo', ch === current && 'is-now')
          const textCls = classNames('vtr-leaf-t', st === 'todo' && 'is-todo', ch === current && 'is-now')
          const sub = titleOf(ch) ? ` · ${trunc(titleOf(ch), 6)}` : ''
          rowEls.push(<path key={`tw-${g.key}-${ri}-${i}`} className={`vtr-twig vtr-s-${g.key}`} d={`M ${SPLIT},${cy} L ${LEAF0 - 6},${ly}`} />)
          rowEls.push(
            <g key={`lf-${g.key}-${ri}-${i}`} className="vtr-leaf-g" {...press(() => onOpen(ch))}>
              <title>{`第 ${ch} 章${titleOf(ch) ? ' · ' + titleOf(ch) : ''}`}</title>
              <rect className={leafCls} x={LEAF0} y={ly - VTR.LEAF_H / 2} width={VTR.LEAF_W} height={VTR.LEAF_H} rx={5} />
              <text className={textCls} x={LEAF0 + 12} y={ly + 4}>
                {`第 ${ch} 章${sub}`}
              </text>
            </g>,
          )
        })
      }
      if (a.kind === 'now' && current != null && chs.indexOf(current) >= 0) {
        const RIGHT = W - PAD + 8
        rowEls.push(<path key={`now-${g.key}-${ri}`} className="vtr-now" d={`M ${PAD - 12},${cy + 38} H ${RIGHT}`} />)
        rowEls.push(
          <text key={`nowt-${g.key}-${ri}`} className="vtr-now-t" textAnchor="end" x={RIGHT} y={cy + 33}>
            {`写作进度 · 第 ${current} 章停在此处`}
          </text>,
        )
      }
    })
  })

  const backstory = anchors.filter((a) => a.kind === 'backstory').length
  const flash = anchors.filter((a) => a.kind === 'flashback').length
  const ahead = anchors.filter((a) => a.kind === 'future').length
  const landed = new Set<number>()
  let branchN = 0
  anchors.forEach((a) => {
    if ((a.chapters ?? []).length > 1) branchN++
    ;(a.chapters ?? []).forEach((n) => landed.add(n))
  })

  return (
    <section className="card">
      <div className="card-head">
        <h2>剧情走向树（故事时间 → 章节落点）</h2>
        <span className="tag tag-info">{`${anchors.length} 个锚点 · ${groups.length} 个阶段`}</span>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <div className="vtr-wrap">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="全书剧情走向树状图">
            {bandEls}
            {trunkEls}
            {headEls}
            {rowEls}
          </svg>
        </div>
        <div style={{ padding: '14px 16px 16px' }}>
          <div className="chart-note">
            <strong>
              {`${anchors.length} 个时间锚点（${backstory} 背景设定 · ${flash} 闪回 · ${ahead} 预叙）分岔落到 ${landed.size} 章，其中 ${branchN} 个锚点跨多章`}
            </strong>
            {` · 主干自上而下即故事时间推进；每个锚点向右分出枝与叶——一条枝挂多片叶＝同一事件被分散在多章叙述；叶子标出章号与章名，点击进入章节详情`}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== *
 * 视图 5 · 情节线（地铁图 + 章节 × 情节线矩阵）
 * ================================================================== */

function plSegments(arr: number[]): Array<[number, number]> {
  const a = [...arr].sort((x, y) => x - y)
  const segs: Array<[number, number]> = []
  let start: number | null = null
  let prev: number | null = null
  a.forEach((v) => {
    if (start === null || prev === null) {
      start = v
      prev = v
      return
    }
    if (v === prev + 1) {
      prev = v
      return
    }
    segs.push([start, prev])
    start = v
    prev = v
  })
  if (start !== null && prev !== null) segs.push([start, prev])
  return segs
}

function tickList(maxN: number): number[] {
  if (maxN <= 5) return Array.from({ length: maxN }, (_, i) => i + 1)
  const out = [1]
  const step = Math.ceil((maxN - 1) / 4)
  for (let n = 1 + step; n < maxN; n += step) out.push(n)
  out.push(maxN)
  return out
}

function PlotlinesView({ s, lines, derived }: { s: Structure; lines: Plotline[]; derived: boolean }) {
  const chapters = s.chapters
  const maxChapter = Math.max(1, ...chapters.map((c) => c.n))
  const den = Math.max(1, maxChapter - 1)
  const pct = (ch: number) => ((ch - 1) / den) * 100

  const rows = lines.map((pl) => {
    const active = [...pl.active].sort((a, b) => a - b)
    const segs = plSegments(active)
    const segEls = segs.map((sg, i) => (
      <i
        key={`seg-${i}`}
        className="pl-seg"
        style={{ left: `${pct(sg[0])}%`, width: sg[1] > sg[0] ? `${((sg[1] - sg[0]) / den) * 100}%` : '1.2%', background: pl.color }}
      />
    ))
    const nodeEls = active.map((ch) => {
      const peak = pl.peak.indexOf(ch) >= 0
      return (
        <i
          key={`nd-${ch}`}
          className="pl-node"
          style={{
            left: `${pct(ch)}%`,
            transform: 'translateX(-50%)',
            background: pl.color,
            ...(peak ? { width: 16, height: 16, top: 7 } : {}),
          }}
        />
      )
    })
    const crossEls = active.map((ch) => <i key={`cx-${ch}`} className="pl-cross" style={{ left: `${pct(ch)}%`, height: 30 }} />)
    return (
      <div key={pl.id}>
        <div className="pl-row">
          <div className="pl-name">
            <span className="dot" style={{ background: pl.color }} />
            <span>{pl.name}</span>
            <span className="pl-kind">{pl.kind === 'main' ? '主线' : '支线'}</span>
          </div>
          <div className="pl-track">
            {segEls}
            {nodeEls}
            {crossEls}
          </div>
        </div>
        <div className="pl-axis">
          <span />
          <span className="fs-12 muted">{pl.summary}</span>
        </div>
      </div>
    )
  })

  const ticks = tickList(maxChapter)
  const mainLines = lines.filter((l) => l.kind === 'main').length
  const subLines = lines.filter((l) => l.kind === 'sub').length
  const crosses = lines.reduce((acc, l) => acc + l.active.length, 0)

  // 章节 × 情节线矩阵
  const cols = Array.from({ length: maxChapter }, (_, i) => i + 1)
  let filled = 0
  const matrixRows = lines.map((pl) => {
    const cells = cols.map((n) => {
      const level = pl.peak.indexOf(n) >= 0 ? 2 : pl.active.indexOf(n) >= 0 ? 1 : 0
      if (level > 0) filled++
      return (
        <td key={n} className={classNames('cell', level === 2 && 'is-peak', level === 1 && 'is-on')}>
          <span>{level === 0 ? '' : level === 2 ? '◆' : '·'}</span>
        </td>
      )
    })
    return (
      <tr key={pl.id}>
        <th className="rowhead">
          <span className="dot" style={{ background: pl.color, width: 10, height: 10, borderRadius: 3, display: 'inline-block' }} /> {pl.name}{' '}
          <span className="pl-kind">{pl.kind === 'main' ? '主线' : '支线'}</span>
        </th>
        {cells}
      </tr>
    )
  })

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>情节线地铁图</h2>
          <span className="tag tag-info">{`${mainLines} 主线 · ${subLines} 支线`}</span>
        </div>
        <div className="card-body">
          <div className="plotline">{rows}</div>
          <div className="pl-axis" style={{ marginTop: 8 }}>
            <span />
            <div className="pl-ticks">
              {ticks.map((t) => (
                <span key={t} className="pl-tick" style={{ left: `${pct(t)}%` }}>
                  {t}
                </span>
              ))}
            </div>
          </div>
          <div className="chart-note" style={{ marginTop: 12 }}>
            {derived ? <strong>情节线尚未登记，当前按卷 / 弧派生</strong> : null}
            <strong>{`${derived ? '· ' : ''}${lines.length} 条情节线：${mainLines} 主线 + ${subLines} 支线，共覆盖 ${crosses} 个「章 × 线」交点`}</strong>
            {` · 方块为活跃章、放大方块为高潮`}
          </div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 24 }}>
        <div className="card-head">
          <h2>章节 × 情节线矩阵</h2>
          <span className="tag tag-quiet">{`${maxChapter} 章 · ${lines.length} 条线`}</span>
        </div>
        <div className="card-body">
          <div className="matrix">
            <table>
              <thead>
                <tr>
                  <th className="rowhead">情节线</th>
                  {cols.map((n) => (
                    <th key={n}>{n}</th>
                  ))}
                </tr>
              </thead>
              <tbody>{matrixRows}</tbody>
            </table>
          </div>
          <div className="chart-note" style={{ marginTop: 12 }}>
            <strong>{`${maxChapter} 章 × ${lines.length} 条线 = ${maxChapter * lines.length} 格，已填充 ${filled} 格`}</strong>
            {` · 深色为该线在本章达到高潮、浅色为本章推进该线、空格为本章未涉及；此矩阵仅作展示`}
          </div>
        </div>
      </section>
    </>
  )
}

/* ================================================================== *
 * 视图 6 · 生产流程（判定 + 2 处回环）
 * ================================================================== */

type FlowStatus = 'done' | 'active' | 'todo'

function PipelineView({ s }: { s: Structure }) {
  const chapters = s.chapters
  const total = chapters.length
  const doneN = chapters.filter((c) => c.status === 'done').length
  const startedN = chapters.filter((c) => c.status !== 'todo' && c.status !== 'planned').length
  const allDone = total > 0 && doneN === total
  const hasPlan = s.nodes.length > 0

  const left: Array<{ name: string; meta: string; status: FlowStatus }> = [
    { name: '章纲规划', meta: '每章目标与节拍', status: hasPlan ? 'done' : 'todo' },
    { name: '上下文组装', meta: '前情 · 角色 · 伏笔', status: startedN > 0 ? 'done' : hasPlan ? 'active' : 'todo' },
    { name: '初稿写作', meta: '按章生成正文', status: allDone ? 'done' : startedN > 0 ? 'active' : 'todo' },
    { name: '规则校验', meta: '硬约束与一致性', status: allDone ? 'done' : doneN > 0 ? 'active' : 'todo' },
    { name: '模型审查', meta: '可举证评审', status: allDone ? 'done' : doneN > 0 ? 'active' : 'todo' },
    { name: '修订润色', meta: '定点改写', status: allDone ? 'done' : doneN > 0 ? 'active' : 'todo' },
  ]
  const right: Array<{ name: string; meta: string; status: FlowStatus }> = [
    { name: '全书组装', meta: '按卷拼装成书', status: allDone ? 'done' : 'todo' },
    { name: '完结校验', meta: '通读与收尾核对', status: allDone ? 'done' : 'todo' },
  ]
  const stages = [...left, ...right]

  const LEFT_Y = [76, 152, 228, 304, 380, 456]

  const flowCls = (st: FlowStatus) => (st === 'done' ? 'is-done' : st === 'active' ? 'is-active' : 'is-todo')
  const node = (key: string, x: number, y: number, st: { name: string; meta: string; status: FlowStatus }) => (
    <g key={key} className={classNames('pflow-node', flowCls(st.status))}>
      <rect x={x} y={y} width={240} height={46} rx={8} />
      <text className="pflow-name" x={x + 16} y={y + 20}>
        {st.name}
      </text>
      <text className="pflow-meta" x={x + 16} y={y + 36}>
        {st.meta}
      </text>
    </g>
  )

  // 边先于节点绘制（契约批次七约定），节点压线避免连线穿过文字
  const edgeEls: ReactNode[] = [
    <path key="e-start" className="pflow-edge" d="M 210,50 V 76" />,
  ]
  for (let i = 0; i < LEFT_Y.length - 1; i++) {
    edgeEls.push(<path key={`e-${i}`} className="pflow-edge" d={`M 210,${LEFT_Y[i] + 46} V ${LEFT_Y[i + 1]}`} />)
  }
  edgeEls.push(<path key="e-dec" className="pflow-edge" d="M 210,502 V 486 H 380" />)
  edgeEls.push(<path key="e-a" className="pflow-edge" d="M 580,486 H 605 V 453 H 630" />)
  edgeEls.push(<path key="e-b" className="pflow-edge" d="M 750,476 V 506" />)
  edgeEls.push(<path key="e-c" className="pflow-edge" d="M 750,552 V 578" />)
  // 回环 1：判定「否」→ 回到「章纲规划」续写下一章
  edgeEls.push(<path key="loop-1" className="pflow-edge is-loop" d="M 480,446 V 56 H 330 V 99" />)
  edgeEls.push(
    <text key="loop-1-t" className="pflow-edge-label" textAnchor="middle" x={405} y={50}>
      否 · 续写下一章
    </text>,
  )
  // 回环 2：全书组装 → 重跑逐章流水线
  edgeEls.push(<path key="loop-2" className="pflow-edge is-loop" d="M 870,453 H 890 V 479 H 330" />)
  edgeEls.push(
    <text key="loop-2-t" className="pflow-edge-label" textAnchor="end" x={880} y={446}>
      有新定稿章 · 重跑
    </text>,
  )
  edgeEls.push(
    <text key="yes" className="pflow-edge-label" x={596} y={478}>
      是
    </text>,
  )

  const pc = countBy(stages, (st) => st.status)

  return (
    <section className="card">
      <div className="card-head">
        <h2>全书内容生产流程</h2>
        <div className="row">
          {(pc.done ?? 0) > 0 ? <span className="tag tag-ok">{pc.done} 已完成</span> : null}
          {(pc.active ?? 0) > 0 ? <span className="tag tag-warn">{pc.active} 进行中</span> : null}
          {(pc.todo ?? 0) > 0 ? <span className="tag tag-quiet">{pc.todo} 待开始</span> : null}
        </div>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <div className="pflow-wrap">
          <svg viewBox="0 0 900 640" role="img" aria-label="全书生产流程">
            {edgeEls}
            <rect className="pflow-pill" x={90} y={22} width={120} height={28} rx={14} />
            <text className="pflow-pill-text" textAnchor="middle" x={150} y={41}>
              开始
            </text>
            {LEFT_Y.map((y, k) => (stages[k] ? node(`n-${k}`, 90, y, stages[k]) : null))}
            <polygon className="pflow-decision" points="380,486 480,446 580,486 480,526" />
            <text className="pflow-decision-text" textAnchor="middle" x={480} y={490}>
              全书定稿？
            </text>
            <text className="pflow-meta" textAnchor="middle" x={480} y={504}>
              {`（共 ${total} 章）`}
            </text>
            {node('n-6', 630, 430, stages[6])}
            {node('n-7', 630, 506, stages[7])}
            <rect className="pflow-pill" x={690} y={578} width={120} height={28} rx={14} />
            <text className="pflow-pill-text" textAnchor="middle" x={750} y={597}>
              完结
            </text>
          </svg>
        </div>
        <div style={{ padding: '14px 16px 16px' }}>
          <div className="chart-note">
            <strong>
              {`${stages.length} 个阶段：${pc.done ?? 0} 已完成 · ${pc.active ?? 0} 进行中 · ${pc.todo ?? 0} 待开始`}
            </strong>
            {` · 实线为主流程，琥珀虚线为回环（判定「否」→ 续写下一章；有新定稿章 → 重跑逐章流水线）；从「开始」到「完结」是一条不间断的闭环，任一节点中断后可从该节点续跑`}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ================================================================== *
 * 视图 7 · 总纲（罗盘 + 覆盖率 + 操作）
 * ================================================================== */

function OverviewView({
  s,
  coverage,
  coverageError,
  coverageLoading,
  onRetryCoverage,
  onRefreshCompass,
  onRoll,
  busy,
}: {
  s: Structure
  coverage: Coverage | null
  coverageError: string | null
  coverageLoading: boolean
  onRetryCoverage: () => void
  onRefreshCompass: () => void
  onRoll: () => void
  busy: string
}) {
  const c = s.compass
  const vols = coverage?.volumes ?? s.volumes.map((v) => ({
    name: v.name,
    from: v.fromChapter,
    to: effTo(v),
    status: v.status,
    goal: v.goal,
    chapters: effTo(v) - (v.fromChapter || 1) + 1,
  }))
  const rollDisabled = busy !== '' || (coverage ? coverage.skeletonVolumes === 0 : false)

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>罗盘 · 全书方向</h2>
          <div className="row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRefreshCompass} disabled={busy !== ''}>
              {busy === 'plan' ? '刷新中…' : '刷新罗盘'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRoll} disabled={rollDisabled}>
              {busy === 'roll' ? '展开中…' : '展开下一卷'}
            </button>
          </div>
        </div>
        <div className="card-body">
          <div className="stack">
            <div className="audit-evidence">{c.endgame || '（尚未设定终局方向）'}</div>
            <div className="grid-3">
              <div className="stat">
                <div className="stat-label">活跃长线</div>
                <div className="stat-value">{c.activeThreads.length}</div>
              </div>
              <div className="stat">
                <div className="stat-label">规模估计</div>
                <div className="stat-value fs-16">{c.scaleEstimate || '—'}</div>
              </div>
              <div className="stat">
                <div className="stat-label">下次刷新</div>
                <div className="stat-value fs-16">{c.refreshAt || '尚未刷新'}</div>
              </div>
            </div>
            <div>
              <div className="fs-12 muted" style={{ marginBottom: 8 }}>
                活跃长线
              </div>
              <div className="wrap-row">
                {c.activeThreads.length ? c.activeThreads.map((t) => <span key={t} className="chip">{t}</span>) : <span className="fs-13 muted">暂无</span>}
              </div>
            </div>
            <div className="divider" />
            <div className="stack-8">
              {vols.length ? (
                vols.map((v) => {
                  const expanded = v.status === 'expanded'
                  return (
                    <div key={v.name} className="arc-card">
                      <div className="arc-head">
                        <span className="fs-13">{v.name}</span>
                        {expanded ? <span className="tag tag-ok">已展开</span> : <span className="tag tag-quiet">骨架卷</span>}
                      </div>
                      <div style={{ padding: 12 }}>
                        <div className="row-between fs-12 muted">
                          <span>{`第 ${v.from}–${v.to} 章`}</span>
                          <span>{`共 ${v.chapters} 章`}</span>
                        </div>
                        <div className="arc-meta" style={{ marginTop: 6 }}>
                          {v.goal || '（暂无卷目标）'}
                        </div>
                        <div className="progress" style={{ marginTop: 8 }}>
                          <i style={{ width: '100%' }} />
                        </div>
                      </div>
                    </div>
                  )
                })
              ) : (
                <div className="fs-13 muted">还没有划分卷。</div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 24 }}>
        <div className="card-head">
          <h2>覆盖率</h2>
          <span className="tag tag-quiet">滚动规划进度</span>
        </div>
        <div className="card-body">
          {coverageLoading ? (
            <Loading text="正在统计覆盖率…" />
          ) : coverageError ? (
            <ErrorState message={coverageError} onRetry={onRetryCoverage} />
          ) : coverage ? (
            <>
              <div className="grid-4">
                <div className="stat">
                  <div className="stat-label">已展开卷</div>
                  <div className="stat-value">{coverage.expandedVolumes}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">骨架卷</div>
                  <div className="stat-value">{coverage.skeletonVolumes}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">章纲数</div>
                  <div className="stat-value">
                    {coverage.nodes}
                    <small>{`详细 ${coverage.detailedNodes}`}</small>
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-label">依赖边</div>
                  <div className="stat-value">
                    {coverage.edges}
                    <small>{`未确认 ${coverage.unconfirmedEdges}`}</small>
                  </div>
                </div>
              </div>
              <div className="chart-note" style={{ marginTop: 16 }}>
                <strong>
                  {`覆盖第 ${coverage.chapterRange[0]}–${coverage.chapterRange[1]} 章：${coverage.expandedVolumes} 卷已展开 / ${coverage.skeletonVolumes} 卷为骨架，章纲 ${coverage.nodes} 条（其中详细 ${coverage.detailedNodes} 条），依赖边 ${coverage.edges} 条（未确认 ${coverage.unconfirmedEdges} 条）`}
                </strong>
                {` · 骨架卷尚未展开章纲；点「展开下一卷」按顺序推进，点「刷新罗盘」重算终局方向与活跃长线`}
              </div>
            </>
          ) : (
            <div className="empty">
              <span className="fs-13">暂无覆盖率数据</span>
            </div>
          )}
        </div>
      </section>
    </>
  )
}

/* ================================================================== *
 * 视图 8 · 章节板（按状态分 4 列）
 * ================================================================== */

const BOARD_COLS: Array<{ key: Canon; label: string; tag: string; card: string }> = [
  { key: 'todo', label: '未写', tag: 'tag-quiet', card: 'is-todo' },
  { key: 'draft', label: '草稿', tag: 'tag-info', card: 'is-draft' },
  { key: 'review', label: '审查中', tag: 'tag-warn', card: 'is-audit' },
  { key: 'done', label: '已定稿', tag: 'tag-ok', card: 'is-done' },
]

function BoardView({ s, onOpen }: { s: Structure; onOpen: (n: number) => void }) {
  const chapters = s.chapters
  const bc = countBy(chapters, (c) => canon(c.status))

  return (
    <section className="card">
      <div className="card-head">
        <h2>章节板</h2>
        <div className="row">
          <StatusTags chapters={chapters} />
        </div>
      </div>
      <div className="card-body">
        <div className="board" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          {BOARD_COLS.map((col) => {
            const items = chapters.filter((c) => canon(c.status) === col.key)
            return (
              <div key={col.key} className="board-col">
                <div className="board-col-head">
                  <span className="board-col-title">{col.label}</span>
                  <span className="mono fs-12">{`${items.length} 章`}</span>
                </div>
                <div className="board-body">
                  {items.length ? (
                    items.map((c) => (
                      <div key={c.n} className={`chap-card ${col.card}`} {...press(() => onOpen(c.n))}>
                        <div className="chap-top">
                          <span className="chap-no">{`第 ${c.n} 章`}</span>
                          <span className={`tag ${col.tag}`}>{col.label}</span>
                        </div>
                        <div className="chap-name">{c.title}</div>
                        <div className="chap-meta">
                          <span className="row">
                            <span className="mono">{`${fmtInt(c.words)} 字`}</span>
                            {c.pov ? <span className="chip">{c.pov}</span> : null}
                          </span>
                          <span className="intensity">
                            {[0, 1, 2, 3, 4].map((i) => (
                              <i key={i} className={i < c.intensity ? 'on' : undefined} />
                            ))}
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="empty">
                      <span className="fs-12">此列暂无章节</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="chart-note" style={{ marginTop: 16 }}>
          <strong>
            {`共 ${chapters.length} 章：${bc.done ?? 0} 已定稿 · ${bc.review ?? 0} 审查中 · ${bc.draft ?? 0} 草稿 · ${bc.todo ?? 0} 未写`}
          </strong>
          {` · 左侧色条为状态，点击章节卡进入章节详情`}
        </div>
      </div>
    </section>
  )
}

/* ================================================================== *
 * 视图 9 · 依赖图（章节间因果依赖 + 节点详情 + 边清单）
 * ================================================================== */

const GNODE_W = 148
const GNODE_H = 58

const NODE_STATUS_TAG: Record<string, [string, string]> = {
  written: ['tag-ok', '已写'],
  draft: ['tag-info', '草稿'],
  audit: ['tag-warn', '待审计'],
  planned: ['tag-info', '已规划'],
  skeleton: ['tag-quiet', '骨架'],
}

interface GPos {
  x: number
  y: number
  row: number
  idx: number
  count: number
}

function graphLayout(nodes: OutlineNode[]): { pos: Record<number, GPos>; rowY: number[] } {
  const arcs: string[] = []
  nodes.forEach((n) => {
    if (arcs.indexOf(n.arc) < 0) arcs.push(n.arc)
  })
  const rowY = arcs.map((_, r) => 62 + r * 120)
  const pos: Record<number, GPos> = {}
  arcs.forEach((arc, r) => {
    const row = nodes.filter((n) => n.arc === arc).sort((a, b) => a.chapter - b.chapter)
    const count = row.length
    const y = rowY[r]
    row.forEach((nodeItem, k) => {
      const x = count === 1 ? (720 - GNODE_W) / 2 : 34 + k * ((720 - 68 - GNODE_W) / (count - 1))
      pos[nodeItem.chapter] = { x, y, row: r, idx: k, count }
    })
  })
  return { pos, rowY }
}

function graphEdgePath(a: GPos, b: GPos): string {
  if (a.row === b.row) {
    const y2 = a.y + GNODE_H / 2
    const sx2 = a.x + GNODE_W
    const tx2 = b.x
    const gap = Math.abs(b.idx - a.idx)
    if (gap === 1) return `M ${sx2} ${y2} L ${tx2} ${y2}`
    const crossed = gap - 1
    const cy = a.y + GNODE_H + (crossed === 1 ? 28 : 54)
    return `M ${sx2} ${y2} C ${sx2 + 30} ${cy} ${tx2 - 30} ${cy} ${tx2} ${y2}`
  }
  const downward = b.y > a.y
  const xs = a.x + GNODE_W / 2
  const xe = b.x + GNODE_W / 2
  const sy2 = downward ? a.y + GNODE_H : a.y
  const ty = downward ? b.y : b.y + GNODE_H
  const c1 = sy2 + (downward ? 40 : -40)
  const c2 = ty + (downward ? -40 : 40)
  return `M ${xs} ${sy2} C ${xs} ${c1} ${xe} ${c2} ${xe} ${ty}`
}

function GraphView({ s, onOpen }: { s: Structure; onOpen: (n: number) => void }) {
  const nodes = s.nodes
  const edges = s.edges
  const [selected, setSelected] = useState<number | null>(null)
  const [hover, setHover] = useState<{ from: number; to: number } | null>(null)

  const { pos, rowY } = useMemo(() => graphLayout(nodes), [nodes])
  const H = (rowY.length ? rowY[rowY.length - 1] : 62) + GNODE_H + 20

  const isActive = (from: number, to: number) => selected === from || selected === to || (hover?.from === from && hover?.to === to)

  const pathEls: ReactNode[] = []
  const edgeEls: ReactNode[] = []
  edges.forEach((e, i) => {
    const a = pos[e.fromChapter]
    const b = pos[e.toChapter]
    if (!a || !b) return
    const d = graphEdgePath(a, b)
    const active = isActive(e.fromChapter, e.toChapter)
    if (active) pathEls.push(<path key={`halo-${i}`} className="gedge-halo" fill="none" d={d} />)
    edgeEls.push(
      <path
        key={`edge-${i}`}
        className={classNames('gedge', !e.confirmed && 'is-skeleton', active && 'is-active')}
        fill="none"
        d={d}
        markerEnd={active ? 'url(#ar-on)' : 'url(#ar)'}
      />,
    )
  })

  const nodeEls = nodes.map((n) => {
    const p = pos[n.chapter]
    if (!p) return null
    const cls = classNames('gnode', n.status === 'skeleton' && 'is-skeleton', n.chapter === selected && 'is-selected')
    return (
      <g key={n.chapter} className={cls} data-ch={n.chapter} {...press(() => setSelected(n.chapter))}>
        <rect x={p.x} y={p.y} width={GNODE_W} height={GNODE_H} rx={8} />
        <text className="gt" x={p.x + 14} y={p.y + 24}>
          {`第 ${n.chapter} 章 · ${n.title}`}
        </text>
        <text className="gs" x={p.x + 14} y={p.y + 43}>
          {trunc(n.goal, 14)}
        </text>
      </g>
    )
  })

  const pending = edges.filter((e) => !e.confirmed).length
  const detail = selected == null ? null : nodes.find((n) => n.chapter === selected) ?? null
  const inEdges = detail ? edges.filter((e) => e.toChapter === detail.chapter) : []
  const outEdges = detail ? edges.filter((e) => e.fromChapter === detail.chapter) : []

  return (
    <div className="split">
      <section className="card">
        <div className="card-head">
          <h2>依赖图</h2>
          <span className="tag tag-quiet">{`${edges.length} 条边`}</span>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="graph-wrap">
            <svg viewBox={`0 0 720 ${H}`} role="img" aria-label="章纲依赖图">
              <defs>
                <marker id="ar" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={8} markerHeight={8} markerUnits="userSpaceOnUse" orient="auto">
                  <path d="M1 1 L7 4 L1 7 Z" style={{ fill: 'var(--ink-4)' }} />
                </marker>
                <marker id="ar-on" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={8} markerHeight={8} markerUnits="userSpaceOnUse" orient="auto">
                  <path d="M1 1 L7 4 L1 7 Z" style={{ fill: 'var(--accent)' }} />
                </marker>
              </defs>
              {pathEls}
              {edgeEls}
              {nodeEls}
            </svg>
          </div>
          <div className="legend">
            <div className="legend-item">
              <span className="legend-swatch" />
              <span>已确立依赖</span>
            </div>
            <div className="legend-item">
              <span className="legend-swatch is-dashed" />
              <span>待确认</span>
            </div>
            <div className="legend-item">
              <span className="legend-swatch is-active" />
              <span>当前选中</span>
            </div>
            <div className="legend-item">
              <span className="legend-swatch is-node-skeleton" />
              <span>骨架章纲</span>
            </div>
          </div>
          <div style={{ padding: '14px 16px 0' }}>
            <div className="chart-note">
              <strong>{`${nodes.length} 个节点 · ${edges.length} 条依赖边，其中 ${pending} 条待确认`}</strong>
              {` · 点击节点高亮其边并联动右侧详情；箭头由后章指向前章，表示「本章依赖谁」`}
            </div>
          </div>
          <div className="card-foot" style={{ padding: 0 }}>
            <div className="rule-row">
              <span className="rule-name fs-13">依赖清单</span>
              <span className="rule-count">{`${edges.length} 条`}</span>
            </div>
            {edges.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>后章</th>
                    <th>依赖前章</th>
                    <th>类型</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {edges.map((e, i) => (
                    <tr
                      key={`${e.fromChapter}-${e.toChapter}-${i}`}
                      {...press(() => setSelected(e.toChapter), null)}
                      onMouseEnter={() => setHover({ from: e.fromChapter, to: e.toChapter })}
                      onMouseLeave={() => setHover(null)}
                      style={{ background: isActive(e.fromChapter, e.toChapter) ? 'var(--paper-3)' : undefined }}
                    >
                      <td className="mono">{`第 ${e.fromChapter} 章`}</td>
                      <td className="mono">{`第 ${e.toChapter} 章`}</td>
                      <td>
                        <span className="chip mono">{e.type}</span>
                      </td>
                      <td className="muted">{e.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty">
                <span className="fs-12">暂无依赖边</span>
              </div>
            )}
          </div>
        </div>
      </section>

      <aside className="stack-24">
        <div className="card">
          <div className="card-head">
            <h2>节点详情</h2>
            {detail ? <span className="tag tag-quiet mono">{`第 ${detail.chapter} 章`}</span> : null}
          </div>
          <div className="card-body">
            {!detail ? (
              <div className="empty">
                <span className="fs-12">未选择节点，点击左侧任一章节节点查看</span>
              </div>
            ) : (
              <div className="stack">
                <div>
                  <div className="ms-title">{detail.title}</div>
                  <div className="wrap-row" style={{ marginTop: 8 }}>
                    <span className={`tag ${NODE_STATUS_TAG[detail.status]?.[0] ?? 'tag-quiet'}`}>{NODE_STATUS_TAG[detail.status]?.[1] ?? detail.status}</span>
                    {detail.pov ? <span className="chip">{detail.pov}</span> : null}
                    <span className="chip">{`张力 ${detail.intensity}`}</span>
                  </div>
                </div>
                <div className="divider" />
                <div>
                  <div className="fs-12 muted">本章目标</div>
                  <div className="fs-14">{detail.goal || '—'}</div>
                </div>
                <div>
                  <div className="fs-12 muted" style={{ marginBottom: 8 }}>
                    剧情节拍
                  </div>
                  {detail.beats?.length ? (
                    <div className="trait-list">
                      {detail.beats.map((b, i) => (
                        <div key={i} className="trait">
                          <i />
                          <span>{b}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="fs-12 muted">骨架节点暂无节拍</div>
                  )}
                </div>
                <div>
                  <div className="fs-12 muted" style={{ marginBottom: 8 }}>
                    安排思路
                  </div>
                  <div className="audit-evidence">{detail.rationale || '—'}</div>
                </div>
                <div className="divider" />
                <div>
                  <div className="fs-12 muted" style={{ marginBottom: 8 }}>
                    上游依赖
                  </div>
                  {outEdges.length ? (
                    <div className="list">
                      {outEdges.map((e, i) => (
                        <div key={i} className="list-row">
                          <div className="row-main">
                            <div className="row-title">{`本章 → 第 ${e.toChapter} 章`}</div>
                            <div className="row-sub">{`${e.type} · ${e.note}`}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="fs-12 muted">无上游依赖</div>
                  )}
                </div>
                <div>
                  <div className="fs-12 muted" style={{ marginBottom: 8 }}>
                    下游影响
                  </div>
                  {inEdges.length ? (
                    <div className="list">
                      {inEdges.map((e, i) => (
                        <div key={i} className="list-row">
                          <div className="row-main">
                            <div className="row-title">{`第 ${e.fromChapter} 章 → 本章`}</div>
                            <div className="row-sub">{`${e.type} · ${e.note}`}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="fs-12 muted">无下游影响</div>
                  )}
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpen(detail.chapter)}>
                  {`打开第 ${detail.chapter} 章详情 →`}
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}

/* ================================================================== *
 * 视图分组（契约批次八，顺序冻结）
 * ================================================================== */

type ViewKey = 'tree' | 'beats' | 'curve' | 'timeline' | 'plotlines' | 'pipeline' | 'overview' | 'board' | 'graph'

const VIEW_GROUPS: Array<{ key: string; label: string; views: ViewKey[] }> = [
  { key: 'arc', label: '走向', views: ['tree', 'beats', 'curve'] },
  { key: 'time', label: '时间', views: ['timeline', 'plotlines'] },
  { key: 'build', label: '生产', views: ['pipeline'] },
  { key: 'detail', label: '明细', views: ['overview', 'board', 'graph'] },
]

const VIEW_LABEL: Record<ViewKey, string> = {
  tree: '故事树',
  beats: '节拍骨架',
  curve: '节奏曲线',
  timeline: '剧情树',
  plotlines: '情节线',
  pipeline: '生产流程',
  overview: '总纲',
  board: '章节板',
  graph: '依赖图',
}

const VIEW_HINT: Record<ViewKey, string> = {
  tree: '主干向右推进即剧情走向；支线自分岔章长出、在收束章合流 · 点击章节可进入章节详情',
  beats: '卷 → 章 → 节拍块 三层骨架；朱砂虚线标出当前写作位置',
  curve: '按章张力起伏；连续低强度段会被标记为节奏风险',
  timeline: '主干自上而下即故事时间推进；每个锚点向右分岔出章节叶 · 点击叶子进入章节详情',
  plotlines: '每行一条线，方块为该线活跃章节，深色为高潮',
  pipeline: '全书内容生产流程；琥珀虚线为回环，判定不通过走修订',
  overview: '罗盘 + 覆盖率',
  board: '按状态分列，左侧色条为状态 · 点击章节卡进入章节详情',
  graph: '章节间因果依赖，可点击节点看本章目标与思路',
}

function groupOfView(v: ViewKey): string {
  return VIEW_GROUPS.find((g) => g.views.indexOf(v) >= 0)?.key ?? 'arc'
}

/* ================================================================== *
 * 页面主体
 * ================================================================== */

export default function Outline() {
  const { projectId } = useProject()
  const navigate = useNavigate()

  const [structure, setStructure] = useState<Structure | null>(null)
  const [structureLoading, setStructureLoading] = useState(false)
  const [structureError, setStructureError] = useState<string | null>(null)

  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [coverageLoading, setCoverageLoading] = useState(false)
  const [coverageError, setCoverageError] = useState<string | null>(null)

  const [projectTitle, setProjectTitle] = useState<string | null>(null)
  const [busy, setBusy] = useState('')

  const [activeGroup, setActiveGroup] = useState('arc')
  const [activeView, setActiveView] = useState<ViewKey>('tree')
  const [groupMemory, setGroupMemory] = useState<Record<string, ViewKey>>({})

  const loadStructure = useCallback(async () => {
    if (!projectId) return
    setStructureLoading(true)
    setStructureError(null)
    try {
      setStructure((await getStructure(projectId)) as Structure)
    } catch (e) {
      setStructureError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setStructureLoading(false)
    }
  }, [projectId])

  const loadCoverage = useCallback(async () => {
    if (!projectId) return
    setCoverageLoading(true)
    setCoverageError(null)
    try {
      setCoverage((await request(`/api/projects/${encodeURIComponent(projectId)}/plan/coverage`)) as Coverage)
    } catch (e) {
      setCoverageError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setCoverageLoading(false)
    }
  }, [projectId])

  const loadTitle = useCallback(async () => {
    if (!projectId) return
    try {
      const r = (await getProject(projectId)) as { project?: { title?: string } }
      setProjectTitle(r.project?.title ?? null)
    } catch {
      // 书名非关键信息，取不到就省略
      setProjectTitle(null)
    }
  }, [projectId])

  useEffect(() => {
    void loadStructure()
    void loadCoverage()
    void loadTitle()
  }, [loadStructure, loadCoverage, loadTitle])

  const setView = useCallback((name: ViewKey) => {
    const gk = groupOfView(name)
    setActiveView(name)
    setActiveGroup(gk)
    setGroupMemory((m) => ({ ...m, [gk]: name }))
  }, [])

  const onGroupClick = (key: string, views: ViewKey[]) => {
    if (key === activeGroup) return
    const mem = groupMemory[key]
    setView(mem && views.indexOf(mem) >= 0 ? mem : views[0])
  }

  const openChapter = useCallback((n: number) => navigate(`/chapter/${n}`), [navigate])

  const runAction = useCallback(
    async (kind: 'plan' | 'roll') => {
      if (!projectId || busy) return
      setBusy(kind)
      try {
        const res = (kind === 'plan' ? await runPlan(projectId, ['outline']) : await rollPlan(projectId)) as PlanResult
        const changed = res.changed ?? []
        toast(kind === 'plan' ? `大纲已刷新${changed.length ? '：' + changed.join('、') : ''}` : `已展开下一卷${changed.length ? '：' + changed.join('、') : ''}`, 'ok')
        await Promise.all([loadStructure(), loadCoverage()])
      } catch (e) {
        toast(e instanceof Error ? e.message : '操作失败', 'error')
      } finally {
        setBusy('')
      }
    },
    [projectId, busy, loadStructure, loadCoverage],
  )

  const derivedLines = useMemo(() => (structure ? (structure.plotlines.length ? structure.plotlines : derivePlotlines(structure)) : []), [structure])
  const plotlinesDerived = !!structure && structure.plotlines.length === 0

  const currentChapter = useMemo(() => {
    if (!structure) return null
    const chs = [...structure.chapters].sort((a, b) => a.n - b.n)
    const front = chs.find((c) => c.status !== 'done')
    return front ? front.n : null
  }, [structure])

  /* ---------- 三态 ---------- */

  if (!projectId) {
    return (
      <>
        <TopBar title="结构与大纲" sub="故事树 · 节拍 · 章节板 · 依赖图" />
        <section className="card">
          <div className="card-body">
            <div className="empty">
              <Icon name="library" size={24} />
              <div className="fs-16 serif">还没有选择作品</div>
              <div className="fs-13 muted">先到「项目」里选择或新建一部作品，再回来查看结构与大纲。</div>
              <Link className="btn btn-ghost btn-sm" to="/">
                前往项目列表
              </Link>
            </div>
          </div>
        </section>
      </>
    )
  }

  if (structureLoading && !structure) {
    return (
      <>
        <TopBar title="结构与大纲" sub="故事树 · 节拍 · 章节板 · 依赖图" />
        <Loading text="正在载入结构与大纲…" />
      </>
    )
  }

  if (structureError && !structure) {
    return (
      <>
        <TopBar title="结构与大纲" sub="故事树 · 节拍 · 章节板 · 依赖图" />
        <ErrorState message={structureError} onRetry={loadStructure} />
      </>
    )
  }

  if (!structure) return null

  const sub = `${projectTitle ? projectTitle + ' · ' : ''}${structure.volumes.length} 卷 · ${structure.nodes.length} 章纲 · ${structure.edges.length} 条依赖边`

  if (structure.nodes.length === 0) {
    return (
      <>
        <TopBar
          title="结构与大纲"
          sub={sub}
          actions={
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => runAction('plan')} disabled={busy !== ''}>
              {busy === 'plan' ? '生成中…' : '刷新大纲'}
            </button>
          }
        />
        <section className="card">
          <div className="card-head">
            <h2>还没有大纲</h2>
          </div>
          <div className="card-body">
            <div className="empty">
              <Icon name="git-branch" size={24} />
              <div className="fs-16 serif">这本书还没有生成世界观与大纲</div>
              <div className="fs-13 muted">先让创作台把世界观、角色与章纲搭起来，本页的故事树、节拍骨架、依赖图才有内容可画。</div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => runAction('plan')} disabled={busy !== ''}>
                {busy === 'plan' ? '生成中…' : '生成世界观与大纲'}
              </button>
            </div>
          </div>
        </section>
      </>
    )
  }

  const group = VIEW_GROUPS.find((g) => g.key === activeGroup) ?? VIEW_GROUPS[0]

  let view: ReactNode = null
  switch (activeView) {
    case 'tree':
      view = <StoryTree s={structure} lines={derivedLines} onOpen={openChapter} />
      break
    case 'beats':
      view = <BeatSheet s={structure} current={currentChapter} />
      break
    case 'curve':
      view = <RhythmCurve s={structure} />
      break
    case 'timeline':
      view = <PlotTree s={structure} current={currentChapter} onOpen={openChapter} />
      break
    case 'plotlines':
      view = <PlotlinesView s={structure} lines={derivedLines} derived={plotlinesDerived} />
      break
    case 'pipeline':
      view = <PipelineView s={structure} />
      break
    case 'overview':
      view = (
        <OverviewView
          s={structure}
          coverage={coverage}
          coverageError={coverageError}
          coverageLoading={coverageLoading}
          onRetryCoverage={loadCoverage}
          onRefreshCompass={() => runAction('plan')}
          onRoll={() => runAction('roll')}
          busy={busy}
        />
      )
      break
    case 'board':
      view = <BoardView s={structure} onOpen={openChapter} />
      break
    case 'graph':
      view = <GraphView s={structure} onOpen={openChapter} />
      break
  }

  return (
    <>
      <TopBar
        title="结构与大纲"
        sub={sub}
        actions={
          <>
            <Link className="btn btn-ghost btn-sm" to="/knowledge" title="把角色、伏笔、设定、支线与章节连成一张网">
              <Icon name="git-branch" size={16} />
              知识库
            </Link>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => runAction('plan')} disabled={busy !== ''}>
              <Icon name="refresh-cw" size={16} />
              {busy === 'plan' ? '刷新中…' : '刷新大纲'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => runAction('roll')}
              disabled={busy !== '' || (coverage ? coverage.skeletonVolumes === 0 : false)}
            >
              <Icon name="chevron-right" size={16} />
              {busy === 'roll' ? '展开中…' : '展开下一卷'}
            </button>
          </>
        }
      />

      <div className="viewbar is-grouped">
        <div className="viewbar-groups" aria-label="视图分组">
          {VIEW_GROUPS.map((g) => (
            <button
              key={g.key}
              type="button"
              className={classNames('vgroup', g.key === activeGroup && 'active')}
              aria-pressed={g.key === activeGroup}
              onClick={() => onGroupClick(g.key, g.views)}
            >
              {g.label}
              <span className="vgroup-count">{g.views.length}</span>
            </button>
          ))}
        </div>
        <span className="fs-12 muted">{VIEW_HINT[activeView]}</span>
      </div>
      <div className="viewbar-sub">
        <div className="viewbar-tabs" aria-label="视图">
          {group.views.map((v) => (
            <button
              key={v}
              type="button"
              className={classNames('vtab', v === activeView && 'active')}
              aria-pressed={v === activeView}
              onClick={() => setView(v)}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
      </div>

      {view}
    </>
  )
}
