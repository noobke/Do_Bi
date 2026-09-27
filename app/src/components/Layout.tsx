import { Fragment, type ReactNode, useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { Icon, type IconName } from './Icon'
import { classNames, fmtInt, fmtMoney } from '../lib/ui'
import { useProject } from '../state/project'
import { getOverview } from '../api/client'

/**
 * App Shell —— 全局唯一的共享布局（设计契约「App Shell + Canonical Nav」）。
 * 侧栏定位与 `.main` 左移由 contract.css 的 `.sidebar`（position:fixed + width:var(--sidebar-w)）
 * 与 `.main { margin-left: var(--sidebar-w) }` 负责，组件只负责结构与状态，不新造定位样式。
 */

interface NavItemDef {
  /** 稳定键，对应原型里的 data-nav */
  key: string
  label: string
  icon: IconName
  to: string
}

/** 11 项导航：顺序冻结，禁止增删改序 */
const NAV_ITEMS: NavItemDef[] = [
  { key: 'projects', label: '项目', icon: 'library', to: '/' },
  { key: 'workbench', label: '工作台', icon: 'pen-line', to: '/workbench' },
  { key: 'chat', label: '共创', icon: 'messages-square', to: '/chat' },
  { key: 'characters', label: '角色', icon: 'users', to: '/characters' },
  { key: 'hooks', label: '伏笔', icon: 'bookmark', to: '/hooks' },
  { key: 'outline', label: '结构', icon: 'git-branch', to: '/outline' },
  { key: 'world', label: '世界观', icon: 'globe', to: '/world' },
  { key: 'knowledge', label: '知识库', icon: 'network', to: '/knowledge' },
  { key: 'audit', label: '审计', icon: 'clipboard-check', to: '/audit' },
  { key: 'style', label: '文风', icon: 'type', to: '/style' },
  { key: 'settings', label: '设置', icon: 'settings-2', to: '/settings' },
]

/** 子页归属映射（契约 NAV_PARENT）：章节详情归「结构」，拆书归「项目」 */
const NAV_PARENT: Record<string, string> = {
  chapter: 'outline',
  disassemble: 'projects',
}

/** 侧栏图标尺寸与原型 index.html 保持一致 */
const NAV_ICON_SIZE = 18

/** 由当前路由推导唯一的 active 键 */
function activeKeyFor(pathname: string): string {
  const first = pathname.split('/').filter(Boolean)[0] ?? 'projects'
  return NAV_PARENT[first] ?? first
}

/**
 * 侧栏底栏只用到总览里的这几个字段。
 * 数据源与工作台同为 `GET /api/projects/{id}/overview` —— 满足契约「同一指标只能有一个数据来源」，
 * 不另开接口、也不写死任何数字。
 */
interface FootSummary {
  project: {
    title: string
    chaptersDone: number
    chaptersTotal: number
    words: number
  }
  usage?: {
    budget?: {
      used: number
      total: number
      unit: string
      unlimited: boolean
    }
  }
}

function Sidebar() {
  const { pathname } = useLocation()
  const { projectId } = useProject()
  const activeKey = activeKeyFor(pathname)

  const [summary, setSummary] = useState<FootSummary | null>(null)
  const [loadedId, setLoadedId] = useState<string | null>(null)

  /* 底栏数据随「当前项目」与「切页」刷新：原型里每页都会重新执行 app.js 把 foot-* 填成最新值，
     这里用 pathname 作依赖还原同一行为。切到别的作品时，旧数据因 loadedId 对不上而不显示，
     避免短暂张冠李戴；网络失败只维持占位，不阻塞任何页面的主体渲染。 */
  useEffect(() => {
    if (!projectId) {
      setSummary(null)
      setLoadedId(null)
      return
    }
    let alive = true
    getOverview(projectId)
      .then((data) => {
        if (!alive) return
        setSummary(data as FootSummary)
        setLoadedId(projectId)
      })
      .catch(() => {
        if (!alive) return
        setSummary(null)
        setLoadedId(null)
      })
    return () => {
      alive = false
    }
  }, [projectId, pathname])

  const fresh = loadedId === projectId
  const project = fresh ? summary?.project : undefined
  const budget = fresh ? (summary?.usage?.budget ?? null) : null
  const done = project?.chaptersDone ?? 0
  const total = project?.chaptersTotal ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-seal" aria-hidden="true" />
        <span className="brand-name">Do_Bi</span>
        <span className="brand-sub">小说创作台</span>
      </div>

      <nav className="nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const isActive = item.key === activeKey
          // 唯一 active 规则：由 activeKeyFor(pathname) 统一推导，
          // 因此普通页与子页（chapter / disassemble）都能拿到 .active 与 aria-current="page"。
          return (
            <Link
              key={item.key}
              to={item.to}
              className={classNames('nav-item', isActive && 'active')}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon name={item.icon} size={NAV_ICON_SIZE} />
              {item.label}
            </Link>
          )
        })}
      </nav>

      {/* 底栏结构与原型 index.html 的 .sidebar-foot 一致：当前项目 / 第 X / Y 章 · N 字 / 进度条 / 预算已用 */}
      <div className="sidebar-foot">
        <div className="foot-label">当前项目</div>
        <div className="foot-title">{project?.title || projectId || '未选择项目'}</div>
        <div className="foot-meta">
          <span>{project ? `第 ${done} / ${total} 章` : '进度'}</span>
          <span>{project ? `${fmtInt(project.words)} 字` : '—'}</span>
        </div>
        <div className="progress" style={{ marginTop: 10 }}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="foot-meta">
          <span>预算已用</span>
          <span>
            {budget
              ? `${fmtMoney(budget.used, budget.unit)} / ${
                  budget.unlimited ? '不限' : fmtMoney(budget.total, budget.unit)
                }`
              : '—'}
          </span>
        </div>
      </div>
    </aside>
  )
}

export interface TopBarProps {
  title: string
  sub?: string
  /** 子页面包屑（渲染在 h1 之上，与 chapter.html 结构一致） */
  crumb?: ReactNode
  /** 顶栏右侧操作区 */
  actions?: ReactNode
}

/** 每页内容的第一块：`.topbar > .topbar-title + .topbar-actions` */
export function TopBar({ title, sub, crumb, actions }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        {crumb}
        <h1>{title}</h1>
        {sub ? <div className="topbar-sub">{sub}</div> : null}
      </div>
      <div className="topbar-actions">{actions}</div>
    </header>
  )
}

export interface CrumbItem {
  label: string
  /** 省略即为当前页（不可点） */
  to?: string
}

/** 子页面包屑：`.crumb`（契约要求每个子页都有） */
export function Crumb({ items }: { items: CrumbItem[] }) {
  return (
    <nav className="crumb" aria-label="面包屑">
      {items.map((item, i) => (
        <Fragment key={`${item.label}-${i}`}>
          {i > 0 ? <span aria-hidden="true">›</span> : null}
          {item.to ? <Link to={item.to}>{item.label}</Link> : <span>{item.label}</span>}
        </Fragment>
      ))}
    </nav>
  )
}

export function Layout() {
  const { pathname } = useLocation()

  /* 入场动效（对应原型 assets/app.js 的 `[data-reveal]` 错落浮现）：
     每次切页，给主内容区的顶层块依次加 `.reveal` + 递增延迟，页面像原型一样逐卡浮现。
     逻辑只是加类，不碰元素几何；`prefers-reduced-motion` 由 contract.css §24 负责回落。 */
  useEffect(() => {
    const main = document.getElementById('main')?.querySelector('.wrap')
    if (!main) return
    // 只取当前页的顶层内容块（页面根的直接子级），避免重复/嵌套动画
    const nodes = Array.from(main.querySelectorAll(':scope > *'))
    nodes.forEach((n, i) => {
      n.classList.remove('reveal-1', 'reveal-2', 'reveal-3', 'reveal-4', 'reveal-5', 'reveal-6')
      n.classList.add('reveal', `reveal-${(i % 6) + 1}`)
    })
  }, [pathname])

  return (
    <>
      <Sidebar />
      <main className="main" id="main">
        <div className="wrap">
          <Outlet />
        </div>
      </main>
    </>
  )
}
