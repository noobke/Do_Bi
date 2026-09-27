/**
 * 通用行为层 —— 由原型 `prototype/do-bi/assets/app.js` 移植而来。
 *
 * 只保留与 React 场景仍相关、且会被多个页面复用的工具；
 * 原型里的 `App.fail` / `App.loading` 在 React 侧改为组件：
 * `components/ErrorState.tsx` 与 `components/Loading.tsx`。
 */

/** querySelector 包装 */
export const $ = <T extends Element = Element>(sel: string, root?: ParentNode): T | null =>
  (root ?? document).querySelector<T>(sel)

/** querySelectorAll 包装，返回真数组（可直接 map / forEach） */
export const $$ = <T extends Element = Element>(sel: string, root?: ParentNode): T[] =>
  Array.from((root ?? document).querySelectorAll<T>(sel))

/** 千分位整数格式化 */
export function fmtInt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 金额格式化：默认人民币符号 + 两位小数 */
export function fmtMoney(n: number, unit = '¥'): string {
  return unit + Number(n).toFixed(2)
}

/** 拼接类名，过滤掉 false / null / undefined */
export function classNames(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(' ')
}

export type ToastType = 'ok' | 'warn' | 'error'

/**
 * 轻提示：固定底部居中，1800ms 后自动移除。
 * 容器类名 `.card.card-pad.fs-13` + 语义分型 `.toast-ok / .toast-warn / .toast-error`（见 contract.css）。
 * `role="status"`；错误用 `aria-live="assertive"`，其余 `polite`（设计契约 · 批次十二）。
 */
export function toast(msg: string, type?: ToastType): void {
  const el = document.createElement('div')
  el.className = classNames('card', 'card-pad', 'fs-13', type ? `toast-${type}` : null)
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite')
  el.textContent = msg
  el.style.position = 'fixed'
  el.style.left = '50%'
  el.style.bottom = '36px'
  el.style.transform = 'translateX(-50%)'
  el.style.zIndex = '90'
  el.style.boxShadow = 'var(--sh-lg)'
  el.style.background = 'var(--paper)'
  document.body.appendChild(el)
  window.setTimeout(() => el.remove(), 1800)
}

/**
 * 把 `div` / `span` / SVG `<g>` 等非原生控件变成键盘可达的交互元素：
 * 补 `role`（默认 `button`）+ `tabindex="0"` + Enter/Space 触发。
 * `role` 传 `false` 表示只补键盘能力、不覆盖元素原生语义（例如 `<tr>`）；
 * 焦点环由 contract.css 的全局 `:focus-visible` 提供，组件不得自行移除。
 */
export function clickable<E extends Element>(
  el: E | null | undefined,
  handler: (event: Event) => void,
  role?: string | false,
): E | null | undefined {
  if (!el) return el
  if (role !== false) el.setAttribute('role', role ?? 'button')
  el.setAttribute('tabindex', '0')
  el.addEventListener('click', handler)
  el.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      e.preventDefault()
      handler(e)
    }
  })
  return el
}
