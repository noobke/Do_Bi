import { Icon } from './Icon'

/**
 * 加载态占位 —— 居中静默图标 + 文案（`.empty` 结构，禁止 emoji）。
 * 供各页面在数据未到达时使用；读屏用 `role="status"` 播报。
 */
export interface LoadingProps {
  /** 文案，默认「载入中…」 */
  text?: string
}

export function Loading({ text = '载入中…' }: LoadingProps) {
  return (
    <div className="empty" role="status" aria-live="polite">
      <Icon name="loader" size={24} />
      <span className="fs-13">{text}</span>
    </div>
  )
}
