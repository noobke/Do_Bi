/**
 * 模型适配层 —— 镜像 `server/dobi/llm/provider.py`。
 *
 * 只依赖 OpenAI 兼容 HTTP 协议，用浏览器 fetch 实现，可在 Capacitor WebView 内直连。
 * 密钥在手机本地（localStorage），不经过任何中转服务。
 *
 * 职责：
 * - 统一调用：`complete()` 非流式 / `stream()` 流式 / `completeJson()` 带容错重试
 * - 降级链：角色指定服务商 → fallbacks → 其余可用服务商；全部失败才报错
 * - 能力探测 + 自动降级：厂商对 `max_tokens` / `response_format` / `stream_options`
 *   支持度不一，遇到 400 参数类错误自动改写参数并重试一次（会话内记忆）
 * - 稳定性：429 / 5xx / 超时 → 指数退避 + 抖动；401/403 → 不重试，直接换服务商
 * - 计量：每次调用回调 onUsage，供 metering 记账与预算熔断
 */

import { configuredProviders, getApiKey, providerByName, roleFor, type ModelSpec, type ProviderSpec, type RoleSpec } from './settings'
import { nowIso } from './util'
import { extractJson } from './jsonutil'
import { NotConfiguredError } from './store'

export type Message = { role: string; content: string }
export type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number }

const RETRY_BASE_DELAY = 1.0
const MAX_RETRIES = 2
const CONNECT_TIMEOUT_MS = 30_000
const TOTAL_TIMEOUT_MS = 180_000
const STREAM_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT = 4_096

// ==========================================================================
// 错误分类
// ==========================================================================

export class ProviderError extends Error {
  readonly code = 'provider_error'
  readonly detail?: unknown
  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'ProviderError'
    this.detail = detail
  }
}

export class ProviderAuthError extends Error {
  readonly code = 'provider_auth'
  readonly detail?: unknown
  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'ProviderAuthError'
    this.detail = detail
  }
}

export class ModelOutputError extends Error {
  readonly code = 'model_output'
  constructor(message: string) {
    super(message)
    this.name = 'ModelOutputError'
  }
}

/** 厂商因「参数不被支持」而 400。携带改写提示，改写后可重试一次。 */
class AdaptableError extends Error {
  readonly hint: string
  constructor(hint: string, message: string) {
    super(message)
    this.name = 'AdaptableError'
    this.hint = hint
  }
}

// ==========================================================================
// 结果容器
// ==========================================================================

export class ChatResult {
  text: string
  provider: string
  model: string
  usage: Usage
  latency_ms: number
  role: string
  attempts: number
  degraded_from: string | null
  cost: number
  finish_reason: string | null
  truncation: boolean
  adaptations: string[]

  constructor(
    text: string,
    provider: string,
    model: string,
    usage: Usage,
    opts: Partial<{
      latency_ms: number
      role: string
      attempts: number
      degraded_from: string | null
      cost: number
      finish_reason: string | null
      truncation: boolean
      adaptations: string[]
    }> = {},
  ) {
    this.text = text
    this.provider = provider
    this.model = model
    this.usage = usage
    this.latency_ms = opts.latency_ms ?? 0
    this.role = opts.role ?? ''
    this.attempts = opts.attempts ?? 1
    this.degraded_from = opts.degraded_from ?? null
    this.cost = opts.cost ?? 0
    this.finish_reason = opts.finish_reason ?? null
    this.truncation = opts.truncation ?? false
    this.adaptations = opts.adaptations ?? []
  }

  /** 给前端看的计量信息（作者语言：额度 / 花费） */
  public(): Record<string, unknown> {
    return {
      provider: this.provider,
      model: this.model,
      tokens: this.usage,
      cost: Math.round(this.cost * 10000) / 10000,
      latencyMs: this.latency_ms,
      degraded: this.degraded_from != null,
    }
  }
}

// ==========================================================================
// 会话内能力探测状态（镜像 providers.json 的 probed 字段）
// ==========================================================================

export interface ProviderProbe {
  ok: boolean
  latency_ms: number | null
  checked_at: string | null
  error: string | null
  max_tokens_field: 'max_tokens' | 'max_completion_tokens'
  supports_response_format: boolean
  supports_stream_options: boolean
  supports_tools: boolean
}

const PROBE_STATE = new Map<string, ProviderProbe>()

function probeFor(prov: ProviderSpec): ProviderProbe {
  let p = PROBE_STATE.get(prov.name)
  if (!p) {
    p = {
      ok: false, latency_ms: null, checked_at: null, error: null,
      max_tokens_field: 'max_tokens',
      supports_response_format: true,
      supports_stream_options: true,
      supports_tools: false,
    }
    PROBE_STATE.set(prov.name, p)
  }
  return p
}

// ==========================================================================
// 计量回调（Meter 在调用方注册）
// ==========================================================================

let usageCallback: ((entry: Record<string, unknown>) => void) | null = null
let scope: Record<string, unknown> = {}

export function setUsageCallback(cb: ((entry: Record<string, unknown>) => void) | null): void {
  usageCallback = cb
}

/** 调用所处的业务位置，如 `{ chapter: 17, step: 'draft' }`。调用前设置。 */
export function setScope(s: Record<string, unknown>): void {
  scope = s
}

function emit(result: ChatResult): void {
  if (!usageCallback) return
  try {
    usageCallback({
      ...result.public(),
      role: result.role,
      attempts: result.attempts,
      finishReason: result.finish_reason,
      ts: nowIso(),
      ...scope,
    })
  } catch {
    /* 计量失败绝不能影响主流程 */
  }
}

// ==========================================================================
// 工具
// ==========================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, makeErr: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(makeErr()), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ==========================================================================
// 角色与候选（降级链）
// ==========================================================================

function requireRole(key: string): RoleSpec {
  const role = roleFor(key)
  if (!role) throw new ProviderError(`模型角色未定义：${key}`)
  return role
}

function requireCredentials(): void {
  if (configuredProviders().length === 0) {
    throw new NotConfiguredError(
      '还没有配置可用的模型服务。请到「设置 · 服务商」填入至少一个 API Key 后重试。',
    )
  }
}

function defaultModel(name: string): ModelSpec {
  return {
    name,
    context_window: 128_000,
    max_output: DEFAULT_MAX_OUTPUT,
    supports_json: true,
    supports_stream: true,
    supports_tools: false,
    price_in: 0,
    price_out: 0,
    note: '',
  }
}

/** 按优先级排出候选 (服务商, 模型) 列表 = 降级链。 */
export function candidates(
  role: RoleSpec,
  needJson: boolean,
  needStream: boolean,
): Array<[ProviderSpec, ModelSpec]> {
  const usable = configuredProviders()
  const byName = new Map(usable.map((p) => [p.name, p]))
  const out: Array<[ProviderSpec, ModelSpec]> = []
  const seen = new Set<string>()

  const ok = (m: ModelSpec): boolean =>
    (!needJson || m.supports_json) && (!needStream || m.supports_stream)

  const add = (provName: string, modelName: string): void => {
    const prov = byName.get(provName)
    if (!prov) return
    let model = prov.models.find((m) => m.name === modelName) ?? null
    if (!model) {
      // 用户没在清单里声明这个模型；仍允许尝试，能力按默认值
      model = defaultModel(modelName)
    }
    if (!ok(model)) return
    const key = `${prov.name}/${model.name}`
    if (seen.has(key)) return
    seen.add(key)
    out.push([prov, model])
  }

  // 1) 角色指定的服务商 + 模型
  if (role.provider) add(role.provider, role.model)
  else {
    const owner = usable.find((p) => p.models.some((m) => m.name === role.model))
    if (owner) add(owner.name, role.model)
  }

  // 2) 显式 fallbacks
  for (const fb of role.fallbacks) {
    const [provName, modelName] = fb.split('/')
    add(provName, modelName || role.model)
  }

  // 3) 兜底：其余可用服务商各取第一个满足能力的模型
  for (const prov of usable) {
    const model = prov.models.find((m) => ok(m))
    if (model) add(prov.name, model.name)
  }

  return out
}

/** 该环节首选模型的上下文窗口（用于上下文组装分层预算）。取不到给保守默认 32k。 */
export function windowFor(roleKey: string): number {
  let role: RoleSpec
  try {
    role = requireRole(roleKey)
  } catch {
    return 32_000
  }
  const cands = candidates(role, role.fmt === 'json' || role.fmt === 'patch', role.fmt === 'text')
  if (!cands.length) return 32_000
  return Math.max(8_192, cands[0][1].context_window || 32_000)
}

export function maxOutputFor(roleKey: string): number {
  let role: RoleSpec
  try {
    role = requireRole(roleKey)
  } catch {
    return DEFAULT_MAX_OUTPUT
  }
  const cands = candidates(role, role.fmt === 'json' || role.fmt === 'patch', role.fmt === 'text')
  return cands.length ? cands[0][1].max_output : role.max_tokens
}

// ==========================================================================
// 报文构造与错误分类
// ==========================================================================

function buildPayload(
  prov: ProviderSpec,
  model: ModelSpec,
  messages: Message[],
  temperature: number,
  maxTokens: number,
  wantJson: boolean,
  stream: boolean,
): Record<string, unknown> {
  const probe = probeFor(prov)
  const payload: Record<string, unknown> = {
    model: model.name,
    messages,
    temperature,
  }
  payload[probe.max_tokens_field] = Math.max(1, maxTokens)
  if (wantJson && probe.supports_response_format) {
    payload.response_format = { type: 'json_object' }
  }
  if (stream) {
    payload.stream = true
    if (probe.supports_stream_options) {
      payload.stream_options = { include_usage: true }
    }
  }
  return payload
}

const UNKNOWN_MARKERS = [
  'unknown', 'unsupported', 'not supported', 'does not support',
  'unrecognized', 'unexpected', 'invalid parameter', 'extra fields',
  'not allowed', '无此参数', '不支持', '未知参数',
]

function looksLikeUnknownParam(body: string): boolean {
  const low = body.toLowerCase()
  return UNKNOWN_MARKERS.some((m) => low.includes(m))
}

function detectHint(prov: ProviderSpec, body: string): string | null {
  if (!looksLikeUnknownParam(body)) return null
  const low = body.toLowerCase()
  const probe = probeFor(prov)
  if (low.includes('stream_options') && probe.supports_stream_options) return 'stream_options'
  if (low.includes('response_format') && probe.supports_response_format) return 'response_format'
  if (low.includes('max_completion_tokens') && probe.max_tokens_field === 'max_tokens') return 'max_tokens'
  if (low.includes('max_tokens') && probe.max_tokens_field === 'max_completion_tokens') return 'max_tokens'
  return null
}

function applyAdaptation(prov: ProviderSpec, hint: string): string {
  const probe = probeFor(prov)
  if (hint === 'max_tokens') {
    probe.max_tokens_field = probe.max_tokens_field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
    return `${prov.name}：改用 ${probe.max_tokens_field}`
  }
  if (hint === 'response_format') {
    probe.supports_response_format = false
    return `${prov.name}：不支持 JSON 强制模式，改为提示词约束 + 容错解析`
  }
  if (hint === 'stream_options') {
    probe.supports_stream_options = false
    return `${prov.name}：不支持流式用量回传，改为本地估算`
  }
  return `${prov.name}：未知适配 ${hint}`
}

/** 把 HTTP 响应分类成业务异常。返回 AdaptableError 表示可改写参数重试。 */
function classify(status: number, body: string, prov: ProviderSpec): Error {
  let message = body
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    const errMsg = parsed.error?.message
    if (typeof errMsg === 'string' && errMsg) message = errMsg
  } catch {
    /* 保留原文 */
  }
  const snippet = message.slice(0, 300)
  const low = snippet.toLowerCase()

  if (status === 401 || status === 403) {
    return new ProviderAuthError(
      `${prov.name} 拒绝了密钥（${status}）。请到「设置」核对密钥。`,
      snippet,
    )
  }
  if (status === 402 || low.includes('insufficient') || low.includes('quota')) {
    return new ProviderAuthError(`${prov.name} 账户额度不足或已欠费。`, snippet)
  }
  if (status === 400 || status === 404 || status === 422) {
    const hint = detectHint(prov, body)
    if (hint) return new AdaptableError(hint, snippet)
    if (status === 404 || low.includes('model')) {
      return new ProviderError(`${prov.name} 上没有这个模型：${snippet}`, snippet)
    }
    return new ProviderError(`${prov.name} 拒绝了请求：${snippet}`, snippet)
  }
  if (status === 429) {
    return new ProviderError(`${prov.name} 限流（429），正在退避重试。`, snippet)
  }
  if (status >= 500) {
    return new ProviderError(`${prov.name} 服务异常（${status}）。`, snippet)
  }
  return new ProviderError(`${prov.name} 返回未预期状态 ${status}：${snippet}`, snippet)
}

// ==========================================================================
// 非流式
// ==========================================================================

async function postJson(prov: ProviderSpec, payload: Record<string, unknown>): Promise<unknown> {
  const url = prov.base_url.replace(/\/+$/, '') + '/chat/completions'
  const key = getApiKey(prov.name)
  const headers = {
    Authorization: `Bearer ${key ?? ''}`,
    'Content-Type': 'application/json',
  }
  let delay = RETRY_BASE_DELAY
  let last: Error | null = null

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const res = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(payload) }, TOTAL_TIMEOUT_MS)
      if (res.status < 400) return await res.json()
      const bodyText = await res.text()
      const err = classify(res.status, bodyText, prov)
      if (err instanceof AdaptableError || err instanceof ProviderAuthError) throw err
      last = err
    } catch (e) {
      if (e instanceof AdaptableError || e instanceof ProviderAuthError) throw e
      if (e instanceof ProviderError) {
        last = e
      } else if (e instanceof DOMException && e.name === 'AbortError') {
        last = new ProviderError(`连接 ${prov.name} 超时。`)
      } else {
        const msg = e instanceof Error ? e.message : String(e)
        last = new ProviderError(`连接 ${prov.name} 失败（${msg}）。`)
      }
    }

    if (attempt <= MAX_RETRIES) {
      await sleep(delay + Math.random() * delay * 0.3)
      delay *= 2
    }
  }

  throw last ?? new ProviderError(`${prov.name} 调用失败。`)
}

function toResult(
  data: Record<string, unknown>,
  prov: ProviderSpec,
  model: ModelSpec,
  latencyMs: number,
  attempts: number,
  degradedFrom: string | null,
  roleKey: string,
  adaptations: string[],
  streamedText?: string,
): ChatResult {
  const choices = (data.choices as Array<Record<string, unknown>> | undefined) ?? []
  const choice = choices[0] ?? {}
  const message = (choice.message as Record<string, unknown> | undefined) ?? {}
  let text = streamedText ?? (typeof message.content === 'string' ? message.content : '')
  if (!text) {
    // deepseek-reasoner 等把推理过程放 reasoning_content；正文为空时退而取它
    text = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
  }

  const rawUsage = (data.usage as Record<string, unknown> | undefined) ?? {}
  const usage: Usage = {
    prompt_tokens: Number(rawUsage.prompt_tokens ?? 0),
    completion_tokens: Number(rawUsage.completion_tokens ?? 0),
    total_tokens: Number(rawUsage.total_tokens ?? 0),
  }
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null
  const cost =
    (usage.prompt_tokens / 1_000_000) * model.price_in +
    (usage.completion_tokens / 1_000_000) * model.price_out

  return new ChatResult(text, prov.name, model.name, usage, {
    latency_ms: latencyMs,
    role: roleKey,
    attempts,
    degraded_from: degradedFrom,
    cost,
    finish_reason: finish,
    truncation: finish === 'length',
    adaptations,
  })
}

async function completeWithAdaptation(
  prov: ProviderSpec,
  model: ModelSpec,
  role: RoleSpec,
  messages: Message[],
  temperature: number,
  maxTokens: number,
  wantJson: boolean,
  degradedFrom: string | null,
): Promise<ChatResult> {
  const applied: string[] = []
  let attempts = 0
  for (;;) {
    attempts += 1
    const payload = buildPayload(prov, model, messages, temperature, maxTokens, wantJson, false)
    const started = Date.now()
    let data: Record<string, unknown>
    try {
      data = (await postJson(prov, payload)) as Record<string, unknown>
    } catch (e) {
      if (e instanceof AdaptableError) {
        const note = applyAdaptation(prov, e.hint)
        if (applied.includes(note)) {
          // 同一适配只做一次，避免来回翻转
          throw new ProviderError(`${prov.name} 拒绝了请求：${e.message}`)
        }
        applied.push(note)
        continue
      }
      throw e
    }
    const latency = Date.now() - started
    const result = toResult(data, prov, model, latency, attempts, degradedFrom, role.key, applied)
    emit(result)
    return result
  }
}

export interface CompleteOptions {
  temperature?: number
  maxTokens?: number
  fmt?: string
}

/** 非流式调用（结构化任务：大纲 / 审计 / 评审）。走完整降级链。 */
export async function complete(
  roleKey: string,
  messages: Message[],
  opts: CompleteOptions = {},
): Promise<ChatResult> {
  const role = requireRole(roleKey)
  const effFmt = opts.fmt ?? role.fmt
  const wantJson = effFmt === 'json' || effFmt === 'patch'
  const temp = opts.temperature ?? role.temperature
  const tokens = opts.maxTokens ?? role.max_tokens

  requireCredentials()
  const cands = candidates(role, wantJson, false)
  if (!cands.length) {
    throw new NotConfiguredError(
      `「${role.label}」这个环节没有可用模型：候选服务商或模型都不支持所需的输出格式。`,
    )
  }

  const firstLabel = `${cands[0][0].name}/${cands[0][1].name}`
  let last: Error | null = null
  for (let idx = 0; idx < cands.length; idx++) {
    const [prov, model] = cands[idx]
    const degraded = idx === 0 ? null : firstLabel
    try {
      return await completeWithAdaptation(prov, model, role, messages, temp, tokens, wantJson, degraded)
    } catch (e) {
      if (e instanceof ProviderAuthError || e instanceof ProviderError || e instanceof AdaptableError) {
        last = e
        continue
      }
      throw e
    }
  }
  throw last ?? new ProviderError('所有候选模型都调用失败。')
}

export interface CompleteJsonOptions {
  temperature?: number
  maxTokens?: number
  retryOnBadJson?: boolean
}

/** 要求 JSON 输出。解析失败时带上错误信息重试一次，仍失败则报错（不静默通过）。 */
export async function completeJson(
  roleKey: string,
  messages: Message[],
  opts: CompleteJsonOptions = {},
): Promise<{ data: unknown; result: ChatResult }> {
  const result = await complete(roleKey, messages, {
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    fmt: 'json',
  })
  let parseError: string | null = null
  try {
    return { data: extractJson(result.text), result }
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e)
    if (opts.retryOnBadJson === false) {
      throw new ModelOutputError(`「${requireRole(roleKey).label}」没有返回可用的结构化结果：${parseError}`)
    }
  }

  const corrective: Message[] = [
    ...messages,
    { role: 'assistant', content: result.text.slice(0, 2000) },
    {
      role: 'user',
      content:
        `上面的输出不是合法 JSON（解析错误：${parseError}）。` +
        '请只输出一个合法的 JSON 对象：不要任何解释文字、不要 Markdown 代码块围栏、' +
        '不要尾随逗号，所有键名与字符串都用英文双引号。',
    },
  ]
  const retry = await complete(roleKey, corrective, {
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    fmt: 'json',
  })
  try {
    return { data: extractJson(retry.text), result: retry }
  } catch (e2) {
    const msg = e2 instanceof Error ? e2.message : String(e2)
    throw new ModelOutputError(`「${requireRole(roleKey).label}」连续两次没有返回合法 JSON：${msg}`)
  }
}

// ==========================================================================
// 流式
// ==========================================================================

/** 解析一行 SSE `data:` JSON，返回增量文本与用量/结束标记。 */
function parseSseData(line: string): { text: string; usage: Usage | null; finish: string | null } {
  const trimmed = (line || '').trim()
  if (!trimmed || trimmed.startsWith(':')) return { text: '', usage: null, finish: null }
  let dataLine = trimmed
  if (dataLine.startsWith('data:')) dataLine = dataLine.slice(5).trim()
  if (!dataLine || dataLine === '[DONE]') return { text: '', usage: null, finish: null }

  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(dataLine) as Record<string, unknown>
  } catch {
    return { text: '', usage: null, finish: null }
  }

  let usage: Usage | null = null
  const rawUsage = obj.usage as Record<string, unknown> | undefined
  if (rawUsage) {
    usage = {
      prompt_tokens: Number(rawUsage.prompt_tokens ?? 0),
      completion_tokens: Number(rawUsage.completion_tokens ?? 0),
      total_tokens: Number(rawUsage.total_tokens ?? 0),
    }
  }

  const choices = (obj.choices as Array<Record<string, unknown>> | undefined) ?? []
  if (!choices.length) return { text: '', usage, finish: null }
  const choice = choices[0] ?? {}
  const delta = (choice.delta as Record<string, unknown> | undefined) ?? {}
  const text =
    (typeof delta.content === 'string' ? delta.content : '') ||
    (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '')
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null
  return { text, usage, finish }
}

interface StreamOneState {
  usage: Usage
  finish: string | null
}

async function* streamOne(
  prov: ProviderSpec,
  model: ModelSpec,
  role: RoleSpec,
  messages: Message[],
  temperature: number,
  maxTokens: number,
  degradedFrom: string | null,
  applied: string[],
  holder: { result?: ChatResult },
): AsyncGenerator<string> {
  const payload = buildPayload(prov, model, messages, temperature, maxTokens, false, true)
  const url = prov.base_url.replace(/\/+$/, '') + '/chat/completions'
  const key = getApiKey(prov.name)
  const headers = {
    Authorization: `Bearer ${key ?? ''}`,
    'Content-Type': 'application/json',
  }

  let delay = RETRY_BASE_DELAY
  let attempt = 0
  const parts: string[] = []
  const state: StreamOneState = { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, finish: null }
  const started = Date.now()
  let emitted = false

  for (;;) {
    attempt += 1
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      if (res.status >= 400) {
        const bodyText = await res.text()
        const err = classify(res.status, bodyText, prov)
        if (err instanceof AdaptableError || err instanceof ProviderAuthError) throw err
        if (attempt <= MAX_RETRIES) {
          await sleep(delay + Math.random() * delay * 0.3)
          delay *= 2
          continue
        }
        throw err
      }
      if (!res.body) throw new ProviderError(`连接 ${prov.name} 失败：没有响应流。`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const readPromise = reader.read()
        const { value, done } = await withTimeout(
          readPromise,
          STREAM_IDLE_TIMEOUT_MS,
          () => new ProviderError(`与 ${prov.name} 的连接长时间无数据，已中断。`),
        )
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
        let sep = buffer.indexOf('\n\n')
        while (sep !== -1) {
          const raw = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const delta = parseSseData(raw)
          if (delta.usage) state.usage = delta.usage
          if (delta.finish) state.finish = delta.finish
          if (delta.text) {
            emitted = true
            parts.push(delta.text)
            yield delta.text
          }
          sep = buffer.indexOf('\n\n')
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) {
        const delta = parseSseData(buffer)
        if (delta.usage) state.usage = delta.usage
        if (delta.finish) state.finish = delta.finish
        if (delta.text) {
          emitted = true
          parts.push(delta.text)
          yield delta.text
        }
      }
      break
    } catch (e) {
      if (e instanceof AdaptableError || e instanceof ProviderAuthError) throw e
      if (e instanceof ProviderError) {
        if (emitted || attempt > MAX_RETRIES) {
          throw new ProviderError(
            `生成过程中与 ${prov.name} 的连接中断。已生成的部分已保留，可从断点继续。`,
          )
        }
      } else if (e instanceof DOMException && e.name === 'AbortError') {
        if (emitted || attempt > MAX_RETRIES) {
          throw new ProviderError(`连接 ${prov.name} 超时。已生成的部分已保留，可从断点继续。`)
        }
      }
      await sleep(delay + Math.random() * delay * 0.3)
      delay *= 2
    }
  }

  const latency = Date.now() - started
  if (state.usage.total_tokens === 0 && parts.length) {
    // 厂商不支持流式用量回传 → 本地粗估（中文 ≈ 1.6 字/token），并标注为估算
    const approxOut = Math.max(1, Math.floor(''.concat(...parts).length / 1.6))
    state.usage.completion_tokens = approxOut
    state.usage.total_tokens = approxOut
    applied.push(`${prov.name}：用量为本地估算`)
  }

  const result = toResult(
    { choices: [{ finish_reason: state.finish }], usage: state.usage },
    prov,
    model,
    latency,
    attempt,
    degradedFrom,
    role.key,
    applied,
    parts.join(''),
  )
  holder.result = result
  emit(result)
}

export interface StreamOptions {
  temperature?: number
  maxTokens?: number
  onResult?: (result: ChatResult) => void
}

/**
 * 流式调用（正文生成）。逐段 yield 文本。
 *
 * 降级语义：**只有在还没吐出任何内容时**才允许换服务商；
 * 一旦开始出字，中途断流就如实报错（已生成部分由调用方保留），绝不静默重来。
 */
export async function* stream(
  roleKey: string,
  messages: Message[],
  opts: StreamOptions = {},
): AsyncGenerator<string> {
  const role = requireRole(roleKey)
  const temp = opts.temperature ?? role.temperature
  const tokens = opts.maxTokens ?? role.max_tokens

  requireCredentials()
  const cands = candidates(role, false, true)
  if (!cands.length) {
    throw new NotConfiguredError(`「${role.label}」这个环节没有支持流式输出的可用模型。`)
  }

  const firstLabel = `${cands[0][0].name}/${cands[0][1].name}`
  let last: Error | null = null

  for (let idx = 0; idx < cands.length; idx++) {
    const [prov, model] = cands[idx]
    const degraded = idx === 0 ? null : firstLabel
    const applied: string[] = []
    for (;;) {
      let emitted = false
      const holder: { result?: ChatResult } = {}
      try {
        const it = streamOne(prov, model, role, messages, temp, tokens, degraded, applied, holder)
        for await (const delta of it) {
          emitted = true
          yield delta
        }
        if (holder.result && opts.onResult) opts.onResult(holder.result)
        return
      } catch (e) {
        if (e instanceof AdaptableError) {
          const note = applyAdaptation(prov, e.hint)
          if (applied.includes(note)) {
            last = new ProviderError(`${prov.name} 拒绝了请求：${e.message}`)
            break
          }
          applied.push(note)
          continue // 同服务商改写参数重试
        }
        if (e instanceof ProviderAuthError) {
          last = e
          break // 换下一个服务商
        }
        if (e instanceof ProviderError) {
          last = e
          if (emitted) throw e // 已出字，不允许换服务商重来
          break
        }
        throw e
      }
    }
  }

  throw last ?? new ProviderError('所有候选模型都调用失败。')
}

// ==========================================================================
// 连通性探测（设置页「测试」按钮）
// ==========================================================================

export async function probe(providerName: string, modelName?: string): Promise<ProviderProbe> {
  const prov = providerByName(providerName)
  if (!prov) throw new ProviderError(`没有这个服务商：${providerName}`)
  if (!getApiKey(providerName)) {
    throw new NotConfiguredError(`「${prov.name}」还没有填密钥。`)
  }

  const model =
    (modelName ? prov.models.find((m) => m.name === modelName) : undefined) ??
    (prov.models[0] ?? null)
  if (!model) throw new ProviderError(`「${prov.name}」没有配置任何模型。`)

  const started = Date.now()
  let ok = false
  let error: string | null = null
  try {
    await complete('chat', [{ role: 'user', content: '用两个字回答：收到' }], {
      temperature: 0,
      maxTokens: 8,
      fmt: 'text',
    })
    ok = true
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const latency = Date.now() - started

  const probe = probeFor(prov)
  probe.ok = ok
  probe.latency_ms = latency
  probe.checked_at = nowIso()
  probe.error = error
  return { ...probe }
}
