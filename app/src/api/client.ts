/**
 * 本地核心 API 客户端。
 *
 * 原版对接 `/workspace/server` 的 FastAPI；现在整套后端逻辑已用 TypeScript 重写，
 * 直接跑在手机里（`web/src/api/core/*`）。这里只做**传输层替换**：
 * 路径、方法、请求体、响应体形状完全不变，页面代码一行不改。
 *
 * 约定：
 * - 密钥与数据都只在本机（localStorage），不经过任何中转服务与云服务器。
 * - 请求体统一 `JSON.stringify`；响应体已是前端 camelCase。
 * - 出错抛 `ApiError`，`message` 是面向作者的中文文案，**可直接展示给用户**。
 * - 流式接口（章节生成 / 整本生产）由本地核心逐条回调 `{ event, data }`，
 *   返回带 `abort()` 的句柄。
 */

import { LocalApiError, localRequest, localStreamSSE } from './core/api'

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

/** 统一请求入口：走本地核心，错误包成 `ApiError`。 */
export async function request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await localRequest<T>(path, init)
  } catch (e) {
    if (e instanceof LocalApiError) throw new ApiError(e.message, e.code, e.status, e.detail)
    const message = e instanceof Error ? e.message : '本地执行失败，请重试。'
    throw new ApiError(message, 'internal', 500)
  }
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

/**
 * 流式接口：把 `path` + `body` 交给本地核心执行，逐条回调 `{ event, data }`。
 *
 * 事件语义与原来的 SSE 完全一致：`delta`（逐段文本）/ `step` / `done` /
 * `paused` / `error` 等；`data` 是 JSON 字符串（已转 camelCase）。
 * `abort()` 会让写作流程在安全点停下，并把已生成的部分落盘为草稿。
 */
export function streamSSE(
  path: string,
  body: unknown,
  onEvent: (ev: SSEEvent) => void,
): SSEHandle {
  return localStreamSSE(path, body, onEvent)
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
/** 给某个环节换模型 / 换服务商 / 调温度（key 见 model_roles.json 的 key 字段） */
export const updateRole = (key: string, body: unknown) =>
  request(`/api/settings/roles/${enc(key)}`, json('PUT', body))
export const getMcp = () => request('/api/settings/mcp')
export const toggleMcp = (name: string) =>
  request('/api/settings/mcp/toggle', json('POST', { name }))
export const updateMcp = (servers: unknown) => request('/api/settings/mcp', json('PUT', servers))
export const testMcp = (name: string) =>
  request(`/api/settings/mcp/${enc(name)}/test`, json('POST'))

/* ------------------------------------------------------------------ *
 * 知识库
 * ------------------------------------------------------------------ */

/**
 * 知识库是**只读派生层**：数据来自真相文件里已有的关系字段，不新增真相文件。
 * 因此在别处改了设定，回这里刷新即可看到最新关系。
 */
export const getKnowledge = (id: string) => request(`/api/projects/${enc(id)}/knowledge`)
/** 跨类检索：一次在 摘要 / 正文 / 设定 / 角色 / 伏笔 / 章纲 里找 */
export const searchKnowledge = (id: string, q: string, k = 8) =>
  request(`/api/projects/${enc(id)}/knowledge/search?q=${enc(q)}&k=${k}`)
/** 关系图谱。scope=core 只含角色与伏笔（易读）；scope=all 再加设定与支线 */
export const getKnowledgeGraph = (id: string, scope: 'core' | 'all' = 'core') =>
  request(`/api/projects/${enc(id)}/knowledge/graph?scope=${scope}`)
/** 单个实体的双向链接：它指向谁、谁指向它 */
export const getKnowledgeEntity = (id: string, kind: string, entityId: string) =>
  request(`/api/projects/${enc(id)}/knowledge/entity/${enc(kind)}/${enc(entityId)}`)

/* ------------------------------------------------------------------ *
 * 健康
 * ------------------------------------------------------------------ */

export const health = () => request('/api/health')
