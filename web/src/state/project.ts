import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * 当前项目的全局上下文。
 * ——————
 * 所有页面都从这里取 `projectId`，不再各自读写 localStorage。
 * 持久化键固定为 `dobi.currentProject`。
 */

/** localStorage 中保存当前项目 id 的键 */
export const CURRENT_PROJECT_KEY = 'dobi.currentProject'

export interface ProjectContextValue {
  /** 当前项目 id；未选择时为 null */
  projectId: string | null
  /** 切换当前项目（同时写入 localStorage） */
  setCurrent: (id: string | null) => void
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

function readStored(): string | null {
  try {
    return window.localStorage.getItem(CURRENT_PROJECT_KEY)
  } catch {
    // 隐私模式 / 存储被禁用时降级为纯内存态
    return null
  }
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projectId, setProjectId] = useState<string | null>(readStored)

  const setCurrent = useCallback((id: string | null) => {
    setProjectId(id)
    try {
      if (id === null) window.localStorage.removeItem(CURRENT_PROJECT_KEY)
      else window.localStorage.setItem(CURRENT_PROJECT_KEY, id)
    } catch {
      // 写入失败不影响内存态
    }
  }, [])

  const value = useMemo<ProjectContextValue>(
    () => ({ projectId, setCurrent }),
    [projectId, setCurrent],
  )

  return createElement(ProjectContext.Provider, { value }, children)
}

/** 读取当前项目上下文；必须在 <ProjectProvider> 内使用 */
export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProject() 必须在 <ProjectProvider> 内使用')
  return ctx
}
