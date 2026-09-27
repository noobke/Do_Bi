/**
 * 本地设置：服务商 / 模型分工 / 密钥 / MCP。
 *
 * 原 FastAPI 后端从 `server/config/providers.json` 与 `model_roles.json` 读配置、
 * 从服务端 .env 读密钥。手机端没有文件系统与 .env，这里把服务商与模型分工
 * **内联为常量**，密钥存 localStorage（`dobi.settings.keys`）——即「配置在手机本地」。
 */

import { maskKey } from './util'

export interface ModelSpec {
  name: string
  context_window: number
  max_output: number
  supports_json: boolean
  supports_stream: boolean
  supports_tools: boolean
  price_in: number
  price_out: number
  note: string
}

export interface ProviderSpec {
  name: string
  base_url: string
  api_key_ref: string
  models: ModelSpec[]
  priority: number
  enabled: boolean
  note: string
}

export interface RoleSpec {
  key: string
  label: string
  model: string
  temperature: number
  fmt: 'json' | 'text' | 'patch'
  max_tokens: number
  provider: string | null
  fallbacks: string[]
}

/** 内联服务商清单（镜像 server/config/providers.json） */
export const PROVIDERS: ProviderSpec[] = [
  {
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    api_key_ref: 'DOBI_KEY_DEEPSEEK',
    priority: 1,
    enabled: true,
    note: '主力。当前可用：deepseek-flash（非思考，便宜）/ deepseek-v4-pro（强推理）。',
    models: [
      {
        name: 'deepseek-flash',
        context_window: 1048576,
        max_output: 131072,
        supports_json: true,
        supports_stream: true,
        supports_tools: true,
        price_in: 2.0,
        price_out: 8.0,
        note: 'DeepSeek-V4.1-Flash。日常正文与抽取档位。',
      },
      {
        name: 'deepseek-v4-pro',
        context_window: 1048576,
        max_output: 393216,
        supports_json: true,
        supports_stream: true,
        supports_tools: true,
        price_in: 9.0,
        price_out: 27.0,
        note: '强推理档位。大纲、评审这类要动脑的环节用它。',
      },
    ],
  },
  {
    name: 'MiMo',
    base_url: 'https://api.xiaomimimo.com/v1',
    api_key_ref: 'DOBI_KEY_MIMO',
    priority: 2,
    enabled: true,
    note: '小米 MiMo，OpenAI 兼容。上下文 1M，便宜档用 flash。',
    models: [
      {
        name: 'mimo-v2.6-pro',
        context_window: 1048576,
        max_output: 131072,
        supports_json: true,
        supports_stream: true,
        supports_tools: true,
        price_in: 3.0,
        price_out: 6.0,
        note: '旗舰推理档。',
      },
      {
        name: 'mimo-v2.6-flash',
        context_window: 1048576,
        max_output: 131072,
        supports_json: true,
        supports_stream: true,
        supports_tools: true,
        price_in: 1.0,
        price_out: 2.0,
        note: '高性价比档，适合跑量。',
      },
    ],
  },
  {
    name: '通义千问',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api_key_ref: 'DOBI_KEY_DASHSCOPE',
    priority: 3,
    enabled: false,
    note: '填好密钥并按百炼当前文档核对模型名后再启用。',
    models: [
      {
        name: 'qwen3-max',
        context_window: 262144,
        max_output: 65536,
        supports_json: true,
        supports_stream: true,
        supports_tools: true,
        price_in: 2.5,
        price_out: 10.0,
        note: '价格按输入 ≤32k 档。',
      },
    ],
  },
  {
    name: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    api_key_ref: 'DOBI_KEY_OPENAI',
    priority: 4,
    enabled: false,
    note: 'gpt 系列模型名请按 OpenAI 当前费率表核对。',
    models: [
      {
        name: 'gpt-4.1-mini',
        context_window: 1048576,
        max_output: 32768,
        supports_json: true,
        supports_stream: true,
        supports_tools: true,
        price_in: 0.4,
        price_out: 1.6,
        note: '示例名，请核对。',
      },
    ],
  },
  {
    name: '硅基流动',
    base_url: 'https://api.siliconflow.cn/v1',
    api_key_ref: 'DOBI_KEY_SILICONFLOW',
    priority: 5,
    enabled: false,
    note: '备选。未启用时完全不参与降级链。',
    models: [
      {
        name: 'deepseek-ai/DeepSeek-V4',
        context_window: 131072,
        max_output: 32768,
        supports_json: true,
        supports_stream: true,
        supports_tools: false,
        price_in: 2.0,
        price_out: 8.0,
        note: '示例名，请核对。',
      },
    ],
  },
]

/** 内联模型分工（镜像 server/config/model_roles.json） */
export const ROLES: RoleSpec[] = [
  { key: 'architect', label: '世界观 / 大纲', model: 'deepseek-flash', temperature: 0.75, fmt: 'json', max_tokens: 8192, provider: 'DeepSeek', fallbacks: ['MiMo/mimo-v2.6-pro'] },
  { key: 'chapter_plan', label: '章纲 + 依赖图与思维链', model: 'deepseek-flash', temperature: 0.6, fmt: 'json', max_tokens: 6144, provider: 'DeepSeek', fallbacks: ['MiMo/mimo-v2.6-pro'] },
  { key: 'writer', label: '正文生成', model: 'deepseek-flash', temperature: 0.92, fmt: 'text', max_tokens: 8192, provider: 'DeepSeek', fallbacks: ['MiMo/mimo-v2.6-flash', 'MiMo/mimo-v2.6-pro'] },
  { key: 'audit_l2', label: '模型审查（多维度）', model: 'mimo-v2.6-pro', temperature: 0.15, fmt: 'json', max_tokens: 6144, provider: 'MiMo', fallbacks: ['MiMo/mimo-v2.6-flash'] },
  { key: 'review', label: '可举证质量评审', model: 'deepseek-flash', temperature: 0.3, fmt: 'json', max_tokens: 6144, provider: 'DeepSeek', fallbacks: ['MiMo/mimo-v2.6-pro'] },
  { key: 'deai', label: '去 AI 味改写', model: 'mimo-v2.6-pro', temperature: 0.4, fmt: 'patch', max_tokens: 6144, provider: 'MiMo', fallbacks: ['MiMo/mimo-v2.6-flash'] },
  { key: 'style_analyze', label: '文风仿写分析', model: 'deepseek-flash', temperature: 0.2, fmt: 'json', max_tokens: 6144, provider: 'DeepSeek', fallbacks: ['MiMo/mimo-v2.6-pro'] },
  { key: 'disassemble', label: '拆书（导入反推）', model: 'deepseek-flash', temperature: 0.3, fmt: 'json', max_tokens: 8192, provider: 'DeepSeek', fallbacks: ['MiMo/mimo-v2.6-pro'] },
  { key: 'archivist', label: '摘要 / 事实抽取', model: 'deepseek-flash', temperature: 0.1, fmt: 'json', max_tokens: 4096, provider: 'DeepSeek', fallbacks: ['MiMo/mimo-v2.6-flash'] },
  { key: 'chat', label: '对话式共创', model: 'deepseek-flash', temperature: 0.7, fmt: 'json', max_tokens: 4096, provider: 'DeepSeek', fallbacks: ['MiMo/mimo-v2.6-flash'] },
  { key: 'steer', label: '实时干预意图解析', model: 'mimo-v2.6-pro', temperature: 0.2, fmt: 'json', max_tokens: 2048, provider: 'MiMo', fallbacks: ['MiMo/mimo-v2.6-flash'] },
]

// ---------------------------------------------------------------------------
// 用户改动持久化（enabled / priority / 模型分工 / 温度）
//
// 原版把改动写回 `config/providers.json` 与 `config/model_roles.json`；手机端
// 没有配置文件，改动存 localStorage，模块加载时覆盖回内联常量（保持数组引用不变）。
// ---------------------------------------------------------------------------

const KEYS_KEY = 'dobi.settings.keys'
const MCP_KEY = 'dobi.settings.mcp'
const ROLES_KEY = 'dobi.settings.roles'
const PROVIDERS_KEY = 'dobi.settings.providers'

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 存储不可用时仅内存态 */
  }
}

function applyOverrides(): void {
  const roles = readJson<RoleSpec[]>(ROLES_KEY)
  if (Array.isArray(roles) && roles.length) {
    const byKey = new Map(roles.map((r) => [r.key, r]))
    for (const role of ROLES) {
      const saved = byKey.get(role.key)
      if (saved) Object.assign(role, saved)
    }
  }
  const providers = readJson<ProviderSpec[]>(PROVIDERS_KEY)
  if (Array.isArray(providers) && providers.length) {
    const byName = new Map(providers.map((p) => [p.name, p]))
    for (const prov of PROVIDERS) {
      const saved = byName.get(prov.name)
      if (saved) {
        prov.enabled = saved.enabled
        prov.priority = saved.priority
        if (Array.isArray(saved.models) && saved.models.length) prov.models = saved.models
      }
    }
  }
}

applyOverrides()

/** 保存模型分工改动（设置页改模型 / 服务商 / 温度后调用） */
export function saveRolesStore(): void {
  writeJson(ROLES_KEY, ROLES.map((r) => ({ ...r })))
}

/** 保存服务商改动（启用状态 / 优先级 / 模型清单） */
export function saveProvidersStore(): void {
  writeJson(PROVIDERS_KEY, PROVIDERS.map((p) => ({ ...p })))
}

/** 服务商对外视图（不含密钥本体，只给脱敏指纹） */
export function providerPublic(spec: ProviderSpec, probe?: Record<string, unknown> | null): Record<string, unknown> {
  const key = getApiKey(spec.name)
  return {
    name: spec.name,
    base_url: spec.base_url,
    api_key_ref: spec.api_key_ref,
    configured: key !== null,
    fingerprint: key ? maskKey(key) : null,
    models: spec.models.map((m) => ({ ...m })),
    priority: spec.priority,
    enabled: spec.enabled,
    note: spec.note,
    probed: probe ?? {
      ok: false, latencyMs: null, checkedAt: null, error: null,
      maxTokensField: 'max_tokens', supportsResponseFormat: true,
      supportsStreamOptions: true, supportsTools: false,
    },
  }
}

/** 模型分工对外视图（镜像 Python ModelRoleSpec.public） */
export function rolePublic(role: RoleSpec): Record<string, unknown> {
  const fmtLabel = { json: 'JSON', text: '流式文本', patch: 'JSON Patch' }[role.fmt] ?? role.fmt
  return {
    step: role.label,
    key: role.key,
    model: role.model,
    provider: role.provider,
    temperature: role.temperature.toFixed(2),
    format: fmtLabel,
  }
}

function readKeys(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(KEYS_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function writeKeys(keys: Record<string, string>): void {
  try {
    window.localStorage.setItem(KEYS_KEY, JSON.stringify(keys))
  } catch {
    /* 存储不可用时仅内存态 */
  }
}

/** 取某个服务商的密钥（按 api_key_ref 存） */
export function getApiKey(name: string): string | null {
  const spec = PROVIDERS.find((p) => p.name === name)
  if (!spec) return null
  const key = readKeys()[spec.api_key_ref] ?? ''
  return key.trim() || null
}

export function saveApiKey(name: string, key: string | null): void {
  const spec = PROVIDERS.find((p) => p.name === name)
  if (!spec) return
  const keys = readKeys()
  const v = (key ?? '').trim()
  if (v) keys[spec.api_key_ref] = v
  else delete keys[spec.api_key_ref]
  writeKeys(keys)
}

export function providerConfigured(name: string): boolean {
  return getApiKey(name) !== null
}

export function fingerprint(name: string): string | null {
  const key = getApiKey(name)
  return key ? maskKey(key) : null
}

export function configuredProviders(): ProviderSpec[] {
  return PROVIDERS.filter((p) => p.enabled && providerConfigured(p.name)).sort(
    (a, b) => a.priority - b.priority,
  )
}

export function fallbackChain(): string[] {
  return configuredProviders().map((p) => p.name)
}

/** 按角色 key 找模型分工 */
export function roleFor(key: string): RoleSpec | null {
  return ROLES.find((r) => r.key === key) ?? null
}

/** 按服务商名取 ProviderSpec（不存在则视为未配置） */
export function providerByName(name: string | null | undefined): ProviderSpec | null {
  if (!name) return null
  return PROVIDERS.find((p) => p.name === name) ?? null
}

export interface McpServerState {
  name: string
  transport: string
  command: string
  url: string
  tools: string[]
  enabled: boolean
  status: 'ok' | 'idle' | 'failed'
  latency: number | null
  calls: number
  error: string | null
}

export function readMcp(): McpServerState[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(MCP_KEY) ?? '[]') as McpServerState[]
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

export function writeMcp(servers: McpServerState[]): void {
  try {
    window.localStorage.setItem(MCP_KEY, JSON.stringify(servers))
  } catch {
    /* 存储不可用时仅内存态 */
  }
}
