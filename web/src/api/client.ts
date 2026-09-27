/**
 * 后端 API 客户端 —— 对接 `/workspace/server` 的 FastAPI。
 *
 * 约定：
 * - 开发时由 Vite `server.proxy` 把 `/api` 转发到 `http://127.0.0.1:8000`，前端不处理 CORS；
 *   生产构建为相对路径（`base: './'`），与后端同源部署即可。
 * - 请求体统一 `JSON.stringify`，`Accept: application/json`。
 * - 非 2xx 抛 `ApiError`，错误体形如 `{ code, message, detail? }`。
 *   `message` 是后端面向作者的中文文案，**可直接展示给用户**。
 * - 流式接口（章节生成 / 整本生产）走 `streamSSE`：fetch + ReadableStream 解析
 *   `text/event-stream`，逐条回调 `{ event, data }`，返回带 `abort()` 的句柄。
 */

/** 统一的接口错误；`message` 可直接展示给作者 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly detail?: unknown

  constructor(message: string, code: string, status: number, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

const enc = encodeURIComponent

/** 解析响应体：优先 JSON，其次纯文本 */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** 从错误响应体里提取 `{ code, message, detail }` */
function toApiError(res: Response, body: unknown): ApiError {
  const fallback = `请求失败（HTTP ${res.status}）`
  if (body && typeof body === 'object') {
    const b = body as { code?: unknown; message?: unknown; detail?: unknown }
    const message = typeof b.message === 'string' && b.message ? b.message : fallback
    const code = typeof b.code === 'string' && b.code ? b.code : String(res.status)
    return new ApiError(message, code, res.status, b.detail)
  }
  const message = typeof body === 'string' && body ? body : fallback
  return new ApiError(message, String(res.status), res.status)
}

/** 统一请求入口 */
export async function request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  if (init.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const res = await fetch(path, { ...init, headers })
  const body = await readBody(res)
  if (!res.ok) throw toApiError(res, body)
  return body as T
}

/** 构造 JSON 请求的 init（无 body 时只带 method） */
function json(method: string, body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, body: JSON.stringify(body) }
}

/* ------------------------------------------------------------------ *
 * 流式（SSE）
 * ------------------------------------------------------------------ */

export interface SSEEvent {
  /** 事件名，缺省为 `message` */
  event: string
  /** `data` 字段（多行 data 以 `\n` 连接） */
  data: string
}

export interface SSEHandle {
  /** 中断流式请求 */
  abort(): void
}

/** 解析一段 SSE 报文（不含结尾空行）并回调 */
function emitEvent(raw: string, onEvent: (ev: SSEEvent) => void): void {
  let event = 'message'
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0 && event === 'message') return
  onEvent({ event, data: data.join('\n') })
}

/**
 * 流式 POST：解析 `text/event-stream`，逐条回调 `{ event, data }`。
 * 网络 / 服务端错误以 `{ event: 'error', data: message }` 形式回调，调用方统一处理即可。
 */
export function streamSSE(
  path: string,
  body: unknown,
  onEvent: (ev: SSEEvent) => void,
): SSEHandle {
  const controller = new AbortController()

  const run = async (): Promise<void> => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
    if (!res.ok) throw toApiError(res, await readBody(res))
    if (!res.body) throw new ApiError('服务端没有返回事件流', 'NO_STREAM', res.status)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let sep = buffer.indexOf('\n\n')
      while (sep !== -1) {
        emitEvent(buffer.slice(0, sep), onEvent)
        buffer = buffer.slice(sep + 2)
        sep = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) emitEvent(buffer, onEvent)
  }

  run().catch((err: unknown) => {
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message = err instanceof Error ? err.message : '流式请求失败'
    onEvent({ event: 'error', data: message })
  })

  return { abort: () => controller.abort() }
}

/* ------------------------------------------------------------------ *
 * 项目
 * ------------------------------------------------------------------ */

export const listProjects = () => request('/api/projects')
export const createProject = (body: unknown) => request('/api/projects', json('POST', body))
export const getProject = (id: string) => request(`/api/projects/${enc(id)}`)
export const deleteProject = (id: string) =>
  request(`/api/projects/${enc(id)}`, { method: 'DELETE' })
export const setMode = (id: string, mode: string) =>
  request(`/api/projects/${enc(id)}/mode`, json('POST', { mode }))
export const getOverview = (id: string) => request(`/api/projects/${enc(id)}/overview`)
export const openProject = (id: string) =>
  request(`/api/projects/${enc(id)}/open`, json('POST'))
export const getProjectStats = (id: string) => request(`/api/projects/${enc(id)}/stats`)

/* ------------------------------------------------------------------ *
 * 共创
 * ------------------------------------------------------------------ */

export const getChat = (id: string) => request(`/api/projects/${enc(id)}/chat`)
export const sendChat = (id: string, message: string) =>
  request(`/api/projects/${enc(id)}/chat`, json('POST', { message }))

/* ------------------------------------------------------------------ *
 * 规划
 * ------------------------------------------------------------------ */

export const runPlan = (id: string, targets?: string[]) =>
  request(`/api/projects/${enc(id)}/plan`, json('POST', targets ? { targets } : {}))
export const rollPlan = (id: string) => request(`/api/projects/${enc(id)}/plan/rolling`, json('POST'))
export const getPlanCoverage = (id: string) =>
  request(`/api/projects/${enc(id)}/plan/coverage`)

/* ------------------------------------------------------------------ *
 * 结构与章节
 * ------------------------------------------------------------------ */

export const getStructure = (id: string) => request(`/api/projects/${enc(id)}/structure`)
export const getOutlineGraph = (id: string) => request(`/api/projects/${enc(id)}/outline/graph`)
export const listChapters = (id: string) => request(`/api/projects/${enc(id)}/chapters`)
export const getChapter = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}`)
export const getChapterDetail = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/detail`)
export const planChapter = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/plan`, json('POST'))

/** 手稿区数据：带页边栏编号（`gutter`）与审计标注（`mark`/`note`）的段落 */
export const getManuscript = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/manuscript`)
/** 停止生成：SSE 断开已中止，这里用于拿回「已保存多少字」 */
export const stopChapter = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/stop`, json('POST'))
export const getChapterCheckpoints = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/checkpoints`)
/** 上下文组装结果（Token 分层预算、裁剪说明、关联章节） */
export const getChapterContext = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/context`)

/** 流式生成章节正文（SSE） */
export const generateChapter = (id: string, n: number, onEvent: (ev: SSEEvent) => void) =>
  streamSSE(`/api/projects/${enc(id)}/chapters/${n}/generate`, {}, onEvent)

export const getAudit = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/audit`)
export const runAudit = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/audit`, json('POST'))
export const getReview = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/review`)
export const runReview = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/review`, json('POST'))
export const runDeai = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/deai`, json('POST'))
export const runRevise = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/revise`, json('POST'))
export const commitChapter = (id: string, n: number) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/commit`, json('POST'))
export const decideFinding = (id: string, n: number, dim: string, action: string | null) =>
  request(`/api/projects/${enc(id)}/chapters/${n}/findings/${enc(dim)}/decision`, json('POST', { action }))

/* ------------------------------------------------------------------ *
 * 角色 / 伏笔 / 世界观
 * ------------------------------------------------------------------ */

export const listCharacters = (id: string) => request(`/api/projects/${enc(id)}/characters`)
export const getCharacter = (id: string, key: string) =>
  request(`/api/projects/${enc(id)}/characters/${enc(key)}`)
export const setCharacterState = (id: string, key: string, body: unknown) =>
  request(`/api/projects/${enc(id)}/characters/${enc(key)}/state`, json('POST', body))
export const listHooks = (id: string) => request(`/api/projects/${enc(id)}/hooks`)
export const createHook = (id: string, body: unknown) =>
  request(`/api/projects/${enc(id)}/hooks`, json('POST', body))
export const resolveHook = (id: string, hookId: string, chapter?: number) =>
  request(`/api/projects/${enc(id)}/hooks/${enc(hookId)}/resolve`,
    json('POST', chapter == null ? {} : { chapter }))
export const abandonHook = (id: string, hookId: string) =>
  request(`/api/projects/${enc(id)}/hooks/${enc(hookId)}/abandon`, json('POST'))
export const getWorld = (id: string) => request(`/api/projects/${enc(id)}/world`)
export const setWorldKind = (id: string, ruleId: string, kind: string) =>
  request(`/api/projects/${enc(id)}/world/${enc(ruleId)}/kind`, json('POST', { kind }))
export const resolveWorldConflict = (id: string, ruleId: string, resolution: string) =>
  request(`/api/projects/${enc(id)}/world/${enc(ruleId)}/resolve`, json('POST', { resolution }))

/* ------------------------------------------------------------------ *
 * 审计（项目级）
 * ------------------------------------------------------------------ */

export const getAuditReport = (id: string, chapter?: number) =>
  request(`/api/projects/${enc(id)}/audit${chapter != null ? `?chapter=${chapter}` : ''}`)

/* ------------------------------------------------------------------ *
 * 文风
 * ------------------------------------------------------------------ */

export const getStyle = (id: string) => request(`/api/projects/${enc(id)}/style`)
export const analyzeStyle = (id: string, body: unknown) =>
  request(`/api/projects/${enc(id)}/style/analyze`, json('POST', body))
export const applyStyle = (id: string, presetId: string) =>
  request(`/api/projects/${enc(id)}/style/apply`, json('POST', { presetId }))
export const addBanned = (id: string, expr: string) =>
  request(`/api/projects/${enc(id)}/style/banned`, json('POST', { expr }))
export const removeBanned = (id: string, expr: string) =>
  request(`/api/projects/${enc(id)}/style/banned?expr=${enc(expr)}`, { method: 'DELETE' })

/* ------------------------------------------------------------------ *
 * 成本
 * ------------------------------------------------------------------ */

export const getUsage = (id: string) => request(`/api/projects/${enc(id)}/usage`)

/* ------------------------------------------------------------------ *
 * 生产 / 干预
 * ------------------------------------------------------------------ */

/** 流式整本生产（SSE） */
export const runBook = (id: string, body: unknown, onEvent: (ev: SSEEvent) => void) =>
  streamSSE(`/api/projects/${enc(id)}/run`, body, onEvent)
export const steer = (id: string, text: string) =>
  request(`/api/projects/${enc(id)}/steer`, json('POST', { text }))
/** 确认 / 撤销一条待人工确认的干预指令（action: 'confirm' | 'dismiss'） */
export const decideSteer = (id: string, directiveId: string, action: string) =>
  request(`/api/projects/${enc(id)}/steer/${enc(directiveId)}`, json('POST', { action }))
export const getRunState = (id: string) => request(`/api/projects/${enc(id)}/run/state`)
/** 检索资料：优先走外部工具，不可用时后端自动回落内置检索 */
export const toolSearch = (id: string, q: string, k = 5) =>
  request(`/api/projects/${enc(id)}/tools/search?q=${enc(q)}&k=${k}`)

/* ------------------------------------------------------------------ *
 * 拆书
 * ------------------------------------------------------------------ */

export const runDisassemble = (id: string, body: unknown) =>
  request(`/api/projects/${enc(id)}/disassemble`, json('POST', body))
/** 上次拆书结果（source 为 null 表示还没拆过） */
export const getDisassemble = (id: string) => request(`/api/projects/${enc(id)}/disassemble`)
export const decideProposal = (id: string, pid: string, action: string | null) =>
  request(
    `/api/projects/${enc(id)}/disassemble/proposals/${enc(pid)}/decision`,
    json('POST', { action }),
  )

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

export const getProviders = () => request('/api/settings/providers')
export const probeProvider = (name: string) =>
  request(`/api/settings/providers/${enc(name)}/probe`, json('POST'))
export const updateProvider = (name: string, body: unknown) =>
  request(`/api/settings/providers/${enc(name)}`, json('PUT', body))
export const getMcp = () => request('/api/settings/mcp')
export const toggleMcp = (name: string) =>
  request('/api/settings/mcp/toggle', json('POST', { name }))
export const updateMcp = (servers: unknown) => request('/api/settings/mcp', json('PUT', servers))
export const testMcp = (name: string) =>
  request(`/api/settings/mcp/${enc(name)}/test`, json('POST'))

/* ------------------------------------------------------------------ *
 * 健康
 * ------------------------------------------------------------------ */

export const health = () => request('/api/health')
