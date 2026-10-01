/**
 * 加载失败态 —— 与原型 `App.fail()` 渲染的结构一致：
 * `.empty.state-error` + `.fs-13` 主文案 + `.fs-12.muted` 说明 + `.btn.btn-ghost.btn-sm` 重试。
 * 容器选择器由调用方决定，目标是该请求真正写入的主内容容器。
 */
export interface ErrorStateProps {
  /** 错误信息；建议直接传后端返回的 message（后端文案已面向作者） */
  message?: string
  /** 重试回调；省略则不渲染重试按钮 */
  onRetry?: () => void
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="empty state-error">
      <svg
        width={24}
        height={24}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
      <span className="fs-13">加载失败{message ? `：${message}` : ''}</span>
      <span className="fs-12 muted">这一块没能拿到数据，可重试；其余内容不受影响</span>
      {onRetry ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  )
}
