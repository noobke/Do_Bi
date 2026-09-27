import { Fragment, type ReactNode } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { Icon, type IconName } from './Icon'
import { classNames } from '../lib/ui'
import { useProject } from '../state/project'

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

/** 10 项导航：顺序冻结，禁止增删改序 */
const NAV_ITEMS: NavItemDef[] = [
  { key: 'projects', label: '项目', icon: 'library', to: '/' },
  { key: 'workbench', label: '工作台', icon: 'pen-line', to: '/workbench' },
  { key: 'chat', label: '共创', icon: 'messages-square', to: '/chat' },
  { key: 'characters', label: '角色', icon: 'users', to: '/characters' },
  { key: 'hooks', label: '伏笔', icon: 'bookmark', to: '/hooks' },
  { key: 'outline', label: '结构', icon: 'git-branch', to: '/outline' },
  { key: 'world', label: '世界观', icon: 'globe', to: '/world' },
  { key: 'audit', label: '审计', icon: 'clipboard-check', to: '/audit' },
  { key: 'style', label: '文风', icon: 'type', to: '/style' },
  { key: 'settings', label: '设置', icon: 'settings-2', to: '/settings' },
]

/** 子页归属映射（契约 NAV_PARENT）：章节详情归「结构」，拆书归「项目」，知识库归「结构」 */
const NAV_PARENT: Record<string, string> = {
  chapter: 'outline',
  knowledge: 'outline',
  disassemble: 'projects',
}

/** 侧栏图标尺寸与原型 index.html 保持一致 */
const NAV_ICON_SIZE = 18

/** 由当前路由推导唯一的 active 键 */
function activeKeyFor(pathname: string): string {
  const first = pathname.split('/').filter(Boolean)[0] ?? 'projects'
  return NAV_PARENT[first] ?? first
}

function Sidebar() {
  const { pathname } = useLocation()
  const { projectId } = useProject()
  const activeKey = activeKeyFor(pathname)

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

      {/* 底栏：数据待接入，先用占位（避免出现写死的假值，见契约「同一指标只能有一个数据来源」） */}
      <div className="sidebar-foot">
        <div className="foot-label">当前项目</div>
        <div className="foot-title">{projectId ?? '未选择项目'}</div>
        <div className="foot-meta">
          <span>进度</span>
          <span>—</span>
        </div>
        <div className="progress" style={{ marginTop: 10 }}>
          <i style={{ width: '0%' }} />
        </div>
        <div className="foot-meta">
          <span>预算已用</span>
          <span>—</span>
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
