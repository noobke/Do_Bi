import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorState } from '../components/ErrorState'
import { Icon } from '../components/Icon'
import { Loading } from '../components/Loading'
import { TopBar } from '../components/Layout'
import { classNames, fmtInt, fmtMoney, toast } from '../lib/ui'
import { useProject } from '../state/project'
import {
  getMcp,
  getProviders,
  getUsage,
  health,
  probeProvider,
  testMcp,
  toggleMcp,
  updateMcp,
  updateProvider,
  updateRole,
} from '../api/client'

/**
 * 设置 —— 模型服务 / 模型分工 / 上下文预算 / 成本 / 外部工具（MCP）。
 * 密钥只存服务端 .env，前端只显示「已配置 / 未配置」与脱敏指纹，永不接触明文。
 */

interface ModelInfo {
  name: string
  contextWindow: number
  maxOutput: number
  supportsJson: boolean
  supportsStream: boolean
  supportsTools: boolean
  priceIn: number
  priceOut: number
  note: string
}

interface Probed {
  ok: boolean
  latencyMs: number | null
  checkedAt: string | null
  error: string | null
  supportsResponseFormat?: boolean
  supportsStreamOptions?: boolean
  supportsTools?: boolean
}

interface Provider {
  name: string
  baseUrl: string
  apiKeyRef: string
  configured: boolean
  fingerprint: string | null
  models: ModelInfo[]
  priority: number
  enabled: boolean
  note: string
  probed: Probed
}

interface Role {
  step: string
  key: string
  model: string
  provider: string
  temperature: number
  format: string
}

interface ProvidersPayload {
  providers: Provider[]
  roles: Role[]
  fallbackChain: string[]
  configured: boolean
  envHint: string
  budgetSplit: { label: string; pct: number }[]
}

interface McpServer {
  name: string
  transport: string
  command: string
  url?: string
  tools: string[]
  enabled: boolean
  status: 'ok' | 'idle' | 'failed'
  latency: number | null
  calls: number
  error?: string
}

/** 外部工具编辑表单（tools 用逗号分隔的文本，提交时再切分） */
interface McpForm {
  origin: string | null
  name: string
  transport: 'stdio' | 'http'
  command: string
  url: string
  tools: string
  enabled: boolean
}

interface McpPayload {
  servers: McpServer[]
  enabledCount: number
  healthyCount: number
  note: string
}

interface UsagePayload {
  totals: { calls: number; tokens: number; cost: number; unpriced: number }
  budget: {
    used: number
    total: number
    remaining: number
    ratio: number
    unit: string
    unlimited: boolean
    level: 'ok' | 'warning' | 'exceeded'
    tokens: number
  }
  byChapter: {
    chapter: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    cost: number
    calls: number
    steps: string[]
  }[]
  byStep: { step: string; calls: number; tokens: number; cost: number }[]
}

interface ProbeResult {
  ok: boolean
  latencyMs: number | null
  error: string | null
  message?: string
}

const BUDGET_COLORS = ['#2C4A63', '#4F6B4A', '#8A5C12', '#A6392E', '#6B6455', '#1C3145']

/** 输出格式 → 作者可读；原词收进 title */
function formatLabel(format: string): string {
  if (!format) return '—'
  if (/patch/i.test(format)) return '定点改写指令'
  if (/json/i.test(format)) return '结构化数据'
  return format
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试。')

export default function Settings() {
  const { projectId } = useProject()

  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [error, setError] = useState('')
  const [providers, setProviders] = useState<Provider[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [fallbackChain, setFallbackChain] = useState<string[]>([])
  const [budgetSplit, setBudgetSplit] = useState<{ label: string; pct: number }[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({})
  const [busy, setBusy] = useState<string | null>(null)
  //: 正在填密钥的服务商名 + 输入框内容（密钥只在内存里过一手，不回显）
  const [keyFor, setKeyFor] = useState<string | null>(null)
  const [keyValue, setKeyValue] = useState('')
  //: 模型分工：正在保存的环节 / 自定义模型名的环节 / 温度草稿
  const [roleBusy, setRoleBusy] = useState<string | null>(null)
  const [customFor, setCustomFor] = useState<string | null>(null)
  const [customValue, setCustomValue] = useState('')
  const [tempDraft, setTempDraft] = useState<Record<string, string>>({})
  //: 外部工具：正在编辑的表单（null = 没有在编辑）
  const [mcpForm, setMcpForm] = useState<McpForm | null>(null)
  //: 「添加服务商」模态：后端暂不支持在线新增，这里只用于对照检查并产出「本地配置片段」
  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addUrl, setAddUrl] = useState('')
  const [addModel, setAddModel] = useState('')
  //: 总预算的本地预览草稿（后端没有「改总预算」的写接口，此值只在本页生效）
  const [budgetDraft, setBudgetDraft] = useState('')

  const [mcp, setMcp] = useState<McpPayload | null>(null)
  const [mcpBusy, setMcpBusy] = useState<string | null>(null)
  const [mcpTest, setMcpTest] = useState<Record<string, { ok: boolean; text: string }>>({})

  const [usage, setUsage] = useState<UsagePayload | null>(null)
  const [warn, setWarn] = useState<string | null>(null)

  const loadProviders = useCallback(async () => {
    setStatus('loading')
    try {
      const res = (await getProviders()) as ProvidersPayload
      setProviders(res.providers ?? [])
      setRoles(res.roles ?? [])
      setFallbackChain(res.fallbackChain ?? [])
      setBudgetSplit(res.budgetSplit ?? [])
      setStatus('ready')
    } catch (e) {
      setError(errMsg(e))
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  useEffect(() => {
    health()
      .then((h) => {
        const info = h as { providers?: { configured?: boolean; message?: string } }
        if (info?.providers && info.providers.configured === false) {
          setWarn(info.providers.message || '尚未配置模型密钥，生成类功能暂不可用。')
        }
      })
      .catch(() => {
        /* 健康检查失败不阻塞设置页 */
      })
  }, [])

  useEffect(() => {
    let alive = true
    getMcp()
      .then((res) => {
        if (alive) setMcp(res as McpPayload)
      })
      .catch(() => {
        if (alive) setMcp({ servers: [], enabledCount: 0, healthyCount: 0, note: '' })
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!projectId) {
      setUsage(null)
      return
    }
    let alive = true
    getUsage(projectId)
      .then((res) => {
        if (alive) setUsage(res as UsagePayload)
      })
      .catch(() => {
        if (alive) setUsage(null)
      })
    return () => {
      alive = false
    }
  }, [projectId])

  const toggleEnabled = useCallback(async (p: Provider) => {
    setBusy(`toggle:${p.name}`)
    try {
      const res = (await updateProvider(p.name, { enabled: !p.enabled })) as { providers: Provider[] }
      if (res.providers) setProviders(res.providers)
      toast(`${p.enabled ? '已停用' : '已启用'}：${p.name}`, 'ok')
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(null)
    }
  }, [])

  const probe = useCallback(
    async (p: Provider) => {
      setBusy(`probe:${p.name}`)
      try {
        const res = (await probeProvider(p.name)) as { probe: Probed; fingerprint?: string }
        setProbes((prev) => ({
          ...prev,
          [p.name]: {
            ok: !!res.probe?.ok,
            latencyMs: res.probe?.latencyMs ?? null,
            error: res.probe?.error ?? null,
          },
        }))
        setProviders((prev) =>
          prev.map((x) =>
            x.name === p.name
              ? { ...x, probed: res.probe ?? x.probed, fingerprint: res.fingerprint ?? x.fingerprint }
              : x,
          ),
        )
        toast(res.probe?.ok ? `连接正常：${p.name}` : `连接异常：${p.name}`, res.probe?.ok ? 'ok' : 'warn')
      } catch (e) {
        setProbes((prev) => ({
          ...prev,
          [p.name]: { ok: false, latencyMs: null, error: null, message: errMsg(e) },
        }))
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  /** 保存密钥：写进服务端 .env 并立即生效，随后顺手测一次连通性。 */
  const saveKey = useCallback(
    async (p: Provider, value: string) => {
      const key = value.trim()
      if (!key) {
        toast('请先粘贴密钥', 'warn')
        return
      }
      setBusy(`key:${p.name}`)
      try {
        const res = (await updateProvider(p.name, { apiKey: key })) as { providers: Provider[] }
        if (res.providers) setProviders(res.providers)
        setKeyFor(null)
        setKeyValue('')
        toast(`已保存 ${p.name} 的密钥，正在测试连通性…`, 'ok')
        void probe({ ...p, configured: true })
      } catch (e) {
        toast(errMsg(e), 'error')
      } finally {
        setBusy(null)
      }
    },
    [probe],
  )

  /** 清除密钥（传空串）。 */
  const clearKey = useCallback(async (p: Provider) => {
    setBusy(`key:${p.name}`)
    try {
      const res = (await updateProvider(p.name, { apiKey: '' })) as { providers: Provider[] }
      if (res.providers) setProviders(res.providers)
      setKeyFor(null)
      setKeyValue('')
      toast(`已清除 ${p.name} 的密钥`, 'ok')
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setBusy(null)
    }
  }, [])

  /** 改某个环节的模型分工。失败时重新拉一次，避免界面停在未保存的状态。 */
  const saveRole = useCallback(
    async (r: Role, patch: { provider?: string; model?: string; temperature?: number }) => {
      setRoleBusy(r.key)
      try {
        const res = (await updateRole(r.key, patch)) as { roles: Role[]; note?: string | null }
        if (res.roles) setRoles(res.roles)
        if (res.note) toast(res.note, 'warn')
        else toast(`已更新「${r.step}」`, 'ok')
      } catch (e) {
        toast(errMsg(e), 'error')
        void loadProviders()
      } finally {
        setRoleBusy(null)
      }
    },
    [loadProviders],
  )

  /** 整体保存外部工具清单（新增 / 编辑 / 删除共用）。 */
  const saveMcpServers = useCallback(async (next: McpServer[]) => {
    setMcpBusy('save')
    try {
      const res = (await updateMcp(next)) as {
        servers: McpServer[]
        enabledCount: number
        healthyCount: number
      }
      setMcp((prev) =>
        prev
          ? {
              ...prev,
              servers: res.servers ?? prev.servers,
              enabledCount: res.enabledCount ?? prev.enabledCount,
              healthyCount: res.healthyCount ?? prev.healthyCount,
            }
          : prev,
      )
      setMcpForm(null)
      toast('外部工具配置已保存', 'ok')
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setMcpBusy(null)
    }
  }, [])

  const submitMcpForm = useCallback(() => {
    if (!mcpForm) return
    const name = mcpForm.name.trim()
    if (!name) {
      toast('请填名称', 'warn')
      return
    }
    if (mcpForm.transport === 'stdio' && !mcpForm.command.trim()) {
      toast('选择「本机命令」时要填启动命令', 'warn')
      return
    }
    if (mcpForm.transport === 'http' && !/^https?:\/\//.test(mcpForm.url.trim())) {
      toast('远程地址要以 http:// 或 https:// 开头', 'warn')
      return
    }
    const existing = mcp?.servers ?? []
    const kept = existing.filter((s) => s.name !== mcpForm.origin && s.name !== name)
    const previous = existing.find((s) => s.name === mcpForm.origin)
    const next: McpServer[] = [
      ...kept,
      {
        name,
        transport: mcpForm.transport,
        command: mcpForm.transport === 'stdio' ? mcpForm.command.trim() : '',
        url: mcpForm.transport === 'http' ? mcpForm.url.trim() : '',
        tools: mcpForm.tools
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean),
        enabled: mcpForm.enabled,
        status: previous?.status ?? 'idle',
        latency: previous?.latency ?? null,
        calls: previous?.calls ?? 0,
      },
    ]
    void saveMcpServers(next)
  }, [mcpForm, mcp, saveMcpServers])

  const removeMcp = useCallback(
    (s: McpServer) => {
      const next = (mcp?.servers ?? []).filter((x) => x.name !== s.name)
      void saveMcpServers(next)
    },
    [mcp, saveMcpServers],
  )

  const doToggleMcp = useCallback(async (s: McpServer) => {
    setMcpBusy(`toggle:${s.name}`)
    try {
      const res = (await toggleMcp(s.name)) as { servers: McpServer[] }
      setMcp((prev) => (prev ? { ...prev, servers: res.servers ?? prev.servers } : prev))
      toast(`${s.enabled ? '已停用' : '已启用'}：${s.name}`, 'ok')
    } catch (e) {
      toast(errMsg(e), 'error')
    } finally {
      setMcpBusy(null)
    }
  }, [])

  const doTestMcp = useCallback(async (s: McpServer) => {
    setMcpBusy(`test:${s.name}`)
    try {
      const res = (await testMcp(s.name)) as {
        ok: boolean
        result?: { ok: boolean; latency: number | null; tools: string[]; error: string | null }
        servers: McpServer[]
      }
      setMcp((prev) => (prev ? { ...prev, servers: res.servers ?? prev.servers } : prev))
      const r = res.result
      if (res.ok && r?.ok) {
        setMcpTest((prev) => ({
          ...prev,
          [s.name]: { ok: true, text: `连接正常 · ${r.latency ?? 0}ms` },
        }))
      } else {
        setMcpTest((prev) => ({
          ...prev,
          [s.name]: { ok: false, text: r?.error || '连接失败，已回落内置检索' },
        }))
      }
    } catch (e) {
      setMcpTest((prev) => ({ ...prev, [s.name]: { ok: false, text: errMsg(e) } }))
    } finally {
      setMcpBusy(null)
    }
  }, [])

  const budgetPct = useMemo(() => {
    if (!usage) return 0
    const b = usage.budget
    if (b.unlimited) return 0
    return Math.max(0, Math.min(100, Math.round((b.ratio ?? 0) * 100)))
  }, [usage])

  //: 首次拿到账本时，用账本里的总预算作为「本地预览」的初值，仅作对照
  useEffect(() => {
    if (usage && budgetDraft === '') {
      setBudgetDraft(usage.budget.unlimited ? '' : String(usage.budget.total || ''))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usage])

  //: 本地预览：只根据页码里键入的总预算重新算一遍余量/比例，不写服务器
  const budgetLocal = useMemo(() => {
    if (!usage) return null
    const used = usage.budget.used
    const unit = usage.budget.unit
    const raw = Number(budgetDraft)
    const total = Number.isFinite(raw) && raw > 0 ? raw : 0
    const unlimited = total <= 0
    const remaining = unlimited ? 0 : Math.max(0, total - used)
    const ratio = unlimited ? 0 : used / total
    const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)))
    const level = unlimited ? 'ok' : used >= total ? 'exceeded' : ratio >= 0.8 ? 'warning' : 'ok'
    return { used, unit, total, unlimited, remaining, pct, level }
  }, [usage, budgetDraft])

  //: 「本地配置片段」：按填写的名称/地址/默认模型拼一段可直接贴进配置文件的片段
  const providerSnippet = useMemo(() => {
    const name = addName.trim().replace(/\s+/g, '')
    const slug = name ? name.replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '') : ''
    const envName = slug ? `DOBI_KEY_${slug.toUpperCase()}` : 'DOBI_KEY_新服务商'
    const entry: Record<string, unknown> = {
      name: name || '新服务商',
      base_url: addUrl.trim() || 'https://api.example.com/v1',
      api_key_ref: envName,
      priority: providers.length + 1,
      enabled: true,
      note: '按实际情况修改后再粘贴。',
    }
    if (addModel.trim()) {
      entry.models = [
        {
          name: addModel.trim(),
          context_window: 131072,
          max_output: 32768,
          supports_json: true,
          supports_stream: true,
          supports_tools: false,
          price_in: 0,
          price_out: 0,
          note: '示例名，请按厂商当前可用清单核对。',
        },
      ]
    }
    return JSON.stringify({ providers: [entry] }, null, 2)
  }, [addName, addUrl, addModel, providers.length])

  //: 复制上面生成的配置片段（只复制文本，不触发任何新增）
  const copySnippet = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(providerSnippet)
      toast('配置片段已复制，请贴进本地配置文件', 'ok')
    } catch {
      toast('复制失败，请手动选中上面的片段复制', 'warn')
    }
  }, [providerSnippet])

  return (
    <>
      <TopBar title="设置" sub="模型接入 · 全部在线调用 · 不含本地模型" />

      {status === 'loading' ? (
        <Loading text="正在加载设置…" />
      ) : status === 'error' ? (
        <ErrorState message={error} onRetry={() => void loadProviders()} />
      ) : (
        <div className="stack-24">
          {warn ? (
            <section className="card card-pad">
              <div className="row-between">
                <div className="row">
                  <Icon name="alert-triangle" size={16} />
                  <span className="fs-13">{warn}</span>
                </div>
                <span className="fs-12 muted" title="密钥保存在服务端 .env">密钥保存在服务端，可在此直接填写；只回显脱敏指纹</span>
              </div>
            </section>
          ) : null}

          {/* 1. 服务商 */}
          <section className="card">
            <div className="card-head">
              <h2>模型服务</h2>
              <div className="row" style={{ gap: 8 }}>
                <span className="tag tag-quiet">兼容 OpenAI</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setAddOpen(true)}
                >
                  添加服务商
                </button>
              </div>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {providers.length === 0 ? (
                <div className="empty">
                  <Icon name="settings-2" size={24} />
                  <div className="fs-13">还没有可用的服务商</div>
                </div>
              ) : (
                providers.map((p) => {
                  const result = probes[p.name]
                  const isOpen = !!expanded[p.name]
                  return (
                    <div className="provider-card" key={p.name}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="provider-name">{p.name}</div>
                        <div className="provider-url">{p.baseUrl}</div>
                        <div className="row" style={{ marginTop: 8 }}>
                          <span className="fs-12 muted">优先级 {p.priority}</span>
                          {p.configured ? (
                            <span className="tag tag-ok" title="密钥状态">
                              已配置{p.fingerprint ? ` · ${p.fingerprint}` : ''}
                            </span>
                          ) : (
                            <span className="tag tag-quiet" title="密钥状态">
                              未配置
                            </span>
                          )}
                          {!p.configured ? (
                            <span className="mono fs-12 muted" title={`环境变量：${p.apiKeyRef}`}>
                              密钥只保存在服务端
                            </span>
                          ) : null}
                        </div>
                        {result ? (
                          <div className="fs-12" style={{ marginTop: 6 }}>
                            {result.message ? (
                              <span style={{ color: 'var(--error)' }}>{result.message}</span>
                            ) : result.ok ? (
                              <span className="muted">
                                连通正常 · {result.latencyMs ?? 0}ms
                              </span>
                            ) : (
                              <span style={{ color: 'var(--error)' }}>
                                {result.error || '连接失败'}
                              </span>
                            )}
                          </div>
                        ) : null}
                        {keyFor === p.name ? (
                          <div style={{ marginTop: 12 }}>
                            <div className="row" style={{ gap: 8 }}>
                              <input
                                className="input mono"
                                type="password"
                                autoComplete="off"
                                spellCheck={false}
                                title={`环境变量：${p.apiKeyRef}`}
                                placeholder={p.configured ? '粘贴新密钥以替换' : '粘贴密钥，将保存到服务端'}
                                value={keyValue}
                                onChange={(e) => setKeyValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void saveKey(p, keyValue)
                                  if (e.key === 'Escape') {
                                    setKeyFor(null)
                                    setKeyValue('')
                                  }
                                }}
                              />
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={busy !== null}
                                onClick={() => void saveKey(p, keyValue)}
                              >
                                {busy === `key:${p.name}` ? '保存中…' : '保存并测试'}
                              </button>
                              {p.configured ? (
                                <button
                                  type="button"
                                  className="btn btn-quiet btn-sm"
                                  disabled={busy !== null}
                                  onClick={() => void clearKey(p)}
                                >
                                  清除
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="btn btn-quiet btn-sm"
                                onClick={() => {
                                  setKeyFor(null)
                                  setKeyValue('')
                                }}
                              >
                                取消
                              </button>
                            </div>
                            <div
                              className="fs-12 muted"
                              style={{ marginTop: 6 }}
                              title={`环境变量：${p.apiKeyRef}（保存到服务端 .env）`}
                            >
                              密钥只写入服务端，保存后立即生效、无需重启；只回显脱敏指纹。
                            </div>
                          </div>
                        ) : null}
                        {isOpen ? (
                          p.models.length > 0 ? (
                            <table className="table" style={{ marginTop: 12 }}>
                              <thead>
                                <tr>
                                  <th>模型</th>
                                  <th>上下文</th>
                                  <th>最大输出</th>
                                  <th>结构化输出</th>
                                  <th>流式</th>
                                  <th>单价（入 / 出）</th>
                                </tr>
                              </thead>
                              <tbody>
                                {p.models.map((m) => (
                                  <tr key={m.name}>
                                    <td className="mono">{m.name}</td>
                                    <td className="mono">{fmtInt(m.contextWindow)}</td>
                                    <td className="mono">{fmtInt(m.maxOutput)}</td>
                                    <td>{m.supportsJson ? '支持' : '不支持'}</td>
                                    <td>{m.supportsStream ? '支持' : '不支持'}</td>
                                    <td className="mono">
                                      {m.priceIn} / {m.priceOut}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <div className="fs-12 muted" style={{ marginTop: 10 }}>
                              这个服务商没有登记可用模型
                            </div>
                          )
                        ) : null}
                      </div>
                      <div className="row">
                        <button
                          type="button"
                          className={classNames('switch', p.enabled && 'is-on')}
                          aria-label={p.enabled ? '停用' : '启用'}
                          aria-pressed={p.enabled}
                          disabled={busy !== null}
                          onClick={() => void toggleEnabled(p)}
                        />
                        <button
                          type="button"
                          className={classNames('btn', p.configured ? 'btn-quiet' : 'btn-primary', 'btn-sm')}
                          disabled={busy !== null}
                          onClick={() => {
                            const next = keyFor === p.name ? null : p.name
                            setKeyFor(next)
                            setKeyValue('')
                          }}
                        >
                          {p.configured ? '更换密钥' : '填写密钥'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-quiet btn-sm"
                          onClick={() => void probe(p)}
                          disabled={busy !== null}
                        >
                          {busy === `probe:${p.name}` ? '测试中…' : '测试连通性'}
                        </button>
                        {p.models.length > 0 ? (
                          <button
                            type="button"
                            className="btn btn-quiet btn-sm"
                            onClick={() =>
                              setExpanded((prev) => ({ ...prev, [p.name]: !prev[p.name] }))
                            }
                          >
                            {isOpen ? '收起模型' : '查看模型'}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            <div className="card-foot">
              <span className="fs-12 muted" title="密钥只存在服务端 .env">
                密钥只存在服务端，前端永不接触；这里只显示「已配置 / 未配置」与脱敏指纹。
              </span>
            </div>
          </section>

          {/* 2. 降级链 */}
          <section className="card">
            <div className="card-head">
              <h2>模型降级链</h2>
              <span className="tag tag-quiet">{fallbackChain.length} 个可用</span>
            </div>
            <div className="card-body stack-8">
              <div className="wrap-row">
                {fallbackChain.length > 0 ? (
                  fallbackChain.map((name, i) => (
                    <span className="row" key={name}>
                      {i > 0 ? <span className="muted">{'→'}</span> : null}
                      <span className="chip">
                        {i === 0 ? '主力 · ' : i === 1 ? '备用 · ' : ''}
                        {name}
                      </span>
                    </span>
                  ))
                ) : (
                  <span className="fs-13 muted">还没有可用的服务商，先配置至少一个密钥</span>
                )}
              </div>
              <div className="fs-12 muted">
                主力失败会自动降级到下一个；全部失败才挂起并提示，不会静默继续。
              </div>
            </div>
          </section>

          {/* 3. 模型分工表 */}
          <section className="card">
            <div className="card-head">
              <h2>模型分工</h2>
              <span className="tag tag-quiet">按环节分配 · 可直接改</span>
            </div>
            <div className="card-body">
              <table className="table">
                <thead>
                  <tr>
                    <th>环节</th>
                    <th style={{ minWidth: 190 }}>服务商</th>
                    <th style={{ minWidth: 210 }}>模型</th>
                    <th style={{ width: 96 }}>温度</th>
                    <th>输出格式</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => {
                    const owner = providers.find((p) => p.name === r.provider)
                    // 下拉里出现的模型：该服务商登记的 + 当前这个（可能来自其他服务商或已是自定义名）
                    const options = [
                      ...(owner?.models ?? []).map((m) => m.name),
                      ...(r.model && !(owner?.models ?? []).some((m) => m.name === r.model)
                        ? [r.model]
                        : []),
                    ]
                    const busyRow = roleBusy === r.key
                    return (
                      <tr key={r.key || r.step}>
                        <td>{r.step}</td>
                        <td>
                          <select
                            className="input"
                            value={r.provider ?? ''}
                            disabled={busyRow}
                            onChange={(e) => {
                              const name = e.target.value
                              const next = providers.find((p) => p.name === name)
                              const firstModel = next?.models[0]?.name
                              void saveRole(r, {
                                provider: name,
                                ...(firstModel ? { model: firstModel } : {}),
                              })
                            }}
                          >
                            <option value="">自动（按优先级）</option>
                            {providers.map((p) => (
                              <option key={p.name} value={p.name}>
                                {p.name}
                                {p.configured ? '' : '（未配密钥）'}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            className="input mono"
                            value={r.model}
                            disabled={busyRow}
                            onChange={(e) => {
                              const value = e.target.value
                              if (value === '__custom__') {
                                setCustomFor(r.key)
                                setCustomValue(r.model)
                                return
                              }
                              void saveRole(r, { model: value })
                            }}
                          >
                            {options.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                            <option value="__custom__">自定义模型名…</option>
                          </select>
                          {customFor === r.key ? (
                            <div className="row" style={{ marginTop: 6, gap: 6 }}>
                              <input
                                className="input mono"
                                autoFocus
                                placeholder="厂商当前可用的模型名"
                                value={customValue}
                                onChange={(e) => setCustomValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    void saveRole(r, { model: customValue })
                                    setCustomFor(null)
                                  }
                                  if (e.key === 'Escape') setCustomFor(null)
                                }}
                              />
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={busyRow}
                                onClick={() => {
                                  void saveRole(r, { model: customValue })
                                  setCustomFor(null)
                                }}
                              >
                                用这个
                              </button>
                              <button
                                type="button"
                                className="btn btn-quiet btn-sm"
                                onClick={() => setCustomFor(null)}
                              >
                                取消
                              </button>
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <input
                            className="input mono"
                            type="number"
                            min={0}
                            max={2}
                            step={0.05}
                            disabled={busyRow}
                            value={tempDraft[r.key] ?? String(r.temperature)}
                            onChange={(e) =>
                              setTempDraft((prev) => ({ ...prev, [r.key]: e.target.value }))
                            }
                            onBlur={(e) => {
                              const raw = e.target.value
                              const value = Number(raw)
                              if (raw === '' || Number.isNaN(value)) {
                                setTempDraft((prev) => {
                                  const next = { ...prev }
                                  delete next[r.key]
                                  return next
                                })
                                return
                              }
                              if (value === Number(r.temperature)) return
                              void saveRole(r, { temperature: value })
                            }}
                          />
                        </td>
                        <td title={r.format}>{formatLabel(r.format)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="fs-12 muted" style={{ marginTop: 12 }}>
                每个环节绑定一个模型：不同的活儿用不同的模型，既省钱也稳。
                <br />
                选「自定义模型名…」可以直接填厂商新上的模型，不必改配置文件；换服务商后模型会跟着切到该服务商的第一个。
              </div>
            </div>
          </section>

          {/* 4. 上下文预算分配 */}
          <section className="card">
            <div className="card-head">
              <h2>上下文预算分配</h2>
              <span className="tag tag-quiet">{budgetSplit.length} 档</span>
            </div>
            <div className="card-body stack-8">
              {budgetSplit.length > 0 ? (
                <>
                  <div className="stackbar">
                    {budgetSplit.map((b, i) => (
                      <i
                        key={b.label}
                        style={{ width: `${b.pct}%`, background: BUDGET_COLORS[i % BUDGET_COLORS.length] }}
                      />
                    ))}
                  </div>
                  <div className="stackbar-legend">
                    {budgetSplit.map((b, i) => (
                      <span className="legend-item" key={b.label}>
                        <span
                          className="legend-swatch is-node"
                          style={{
                            background: BUDGET_COLORS[i % BUDGET_COLORS.length],
                            border: 'none',
                          }}
                        />
                        <span>
                          {b.label} {b.pct}%
                        </span>
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <div className="fs-13 muted">还没有预算分配</div>
              )}
              <div className="fs-12 muted">
                文风档案不占配额（体量小且必须每章一致）；预算不足时优先裁剪历史摘要，而不是报错。
              </div>
            </div>
          </section>

          {/* 5. 成本 */}
          <section className="card">
            <div className="card-head">
              <h2>成本</h2>
              <span className="tag tag-quiet">按章结算</span>
            </div>
            <div className="card-body stack">
              {!projectId ? (
                <div className="fs-13 muted">
                  还没有选择作品，暂时看不到成本明细。<Link to="/">去选一个作品</Link>
                </div>
              ) : !usage ? (
                <div className="fs-13 muted">暂时拿不到成本明细</div>
              ) : (
                <>
                  <div className="stack-8">
                    <div className="row-between fs-13">
                      <span>项目预算</span>
                      <span className="mono">
                        {usage.budget.unlimited
                          ? '未设置上限'
                          : `${fmtMoney(usage.budget.used, usage.budget.unit)} / ${fmtMoney(
                              usage.budget.total,
                              usage.budget.unit,
                            )}`}
                      </span>
                    </div>
                    {!usage.budget.unlimited ? (
                      <div className="progress">
                        <i
                          style={{
                            width: `${budgetPct}%`,
                            background:
                              usage.budget.level === 'exceeded'
                                ? 'var(--error)'
                                : usage.budget.level === 'warning'
                                  ? 'var(--amber)'
                                  : undefined,
                          }}
                        />
                      </div>
                    ) : null}
                    <div className="fs-12 muted">
                      {usage.budget.level === 'exceeded'
                        ? '预算已超出：超出后会挂起，不会静默继续花钱。'
                        : usage.budget.unlimited
                          ? '未设置预算上限，不会触发熔断。'
                          : `剩余 ${fmtMoney(usage.budget.remaining, usage.budget.unit)}；接近上限时会提示。`}
                    </div>
                  </div>

                  {/* 本地预览的可编辑总预算：后端没有「改总预算」的写接口，此值只在本页生效 */}
                  <div className="field" style={{ maxWidth: 340 }}>
                    <div className="row-between">
                      <label className="field-label" htmlFor="budget-total-edit">
                        总预算（本地预览）
                      </label>
                      {budgetLocal ? (
                        budgetLocal.unlimited ? (
                          <span className="tag tag-quiet">不限上限</span>
                        ) : budgetLocal.level === 'exceeded' ? (
                          <span className="tag tag-danger">已超出</span>
                        ) : budgetLocal.level === 'warning' ? (
                          <span className="tag tag-warn">接近上限</span>
                        ) : (
                          <span className="tag tag-ok">正常</span>
                        )
                      ) : null}
                    </div>
                    <input
                      id="budget-total-edit"
                      className="input mono"
                      type="number"
                      step={10}
                      min={0}
                      value={budgetDraft}
                      onChange={(e) => setBudgetDraft(e.target.value)}
                    />
                    {budgetLocal && !budgetLocal.unlimited ? (
                      <span className="field-hint">
                        本地预览：已用 {fmtMoney(budgetLocal.used, budgetLocal.unit)} ／{' '}
                        {fmtMoney(budgetLocal.total, budgetLocal.unit)}，余量{' '}
                        {fmtMoney(budgetLocal.remaining, budgetLocal.unit)}
                      </span>
                    ) : (
                      <span className="field-hint">填 0 或留空表示不限上限</span>
                    )}
                    <span
                      className="field-hint"
                      title="后端没有提供修改总预算的写接口；填写的数值只影响本页预览，不会被同步到服务器账本"
                    >
                      此改动只在本页生效，实际以本地账本为准；刷新后仍以账本数值为准。
                    </span>
                  </div>

                  <div className="grid-3">
                    <div className="stat">
                      <div className="stat-label">调用次数</div>
                      <div className="stat-value fs-20">{fmtInt(usage.totals.calls)}</div>
                      <div className="fs-12 muted">全部环节合计</div>
                    </div>
                    <div className="stat">
                      <div className="stat-label" title="tokens">
                        消耗额度
                      </div>
                      <div className="stat-value fs-20">{fmtInt(usage.totals.tokens)}</div>
                      <div className="fs-12 muted">输入 + 输出合计</div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">累计成本</div>
                      <div className="stat-value fs-20">
                        {fmtMoney(usage.totals.cost, usage.budget.unit)}
                      </div>
                      <div className="fs-12 muted">
                        {usage.totals.unpriced > 0
                          ? `${usage.totals.unpriced} 次调用未定价`
                          : '按实际用量计'}
                      </div>
                    </div>
                  </div>

                  <div className="divider" />

                  <div className="fs-13">按章</div>
                  {usage.byChapter.length > 0 ? (
                    <table className="table">
                      <thead>
                        <tr>
                          <th>章节</th>
                          <th>额度</th>
                          <th>成本</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usage.byChapter.map((u) => (
                          <tr key={u.chapter}>
                            <td>{u.chapter === 0 ? '文风分析' : `第 ${u.chapter} 章`}</td>
                            <td className="mono">{fmtInt(u.totalTokens)}</td>
                            <td className="mono">{fmtMoney(u.cost, usage.budget.unit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="fs-12 muted">还没有产生费用</div>
                  )}

                  <div className="fs-13">按环节</div>
                  {usage.byStep.length > 0 ? (
                    <div className="kv">
                      {usage.byStep.map((row) => (
                        <div className="kv-row" key={row.step}>
                          <span className="kv-key">{row.step}</span>
                          <span className="kv-val">
                            {row.calls} 次 · {fmtInt(row.tokens)} 额度 ·{' '}
                            {fmtMoney(row.cost, usage.budget.unit)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="fs-12 muted">还没有产生费用</div>
                  )}
                </>
              )}
            </div>
          </section>

          {/* 6. 外部工具（MCP） */}
          <section className="card">
            <div className="card-head">
              <h2>外部工具</h2>
              <div className="row" style={{ gap: 8 }}>
                <span className="tag tag-info">
                  已启用 {mcp?.enabledCount ?? 0} · 正常 {mcp?.healthyCount ?? 0}
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={mcpBusy !== null}
                  onClick={() =>
                    setMcpForm({
                      origin: null,
                      name: '',
                      transport: 'stdio',
                      command: '',
                      url: '',
                      tools: '',
                      enabled: true,
                    })
                  }
                >
                  新增工具
                </button>
              </div>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {!mcp || mcp.servers.length === 0 ? (
                <div className="empty">
                  <Icon name="settings-2" size={24} />
                  <div className="fs-13">还没有配置外部工具</div>
                </div>
              ) : (
                mcp.servers.map((s) => {
                  const test = mcpTest[s.name]
                  return (
                    <div className="provider-card" key={s.name}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="provider-name">{s.name}</div>
                        <div className="provider-url">
                          {s.transport === 'stdio' ? s.command : s.url}
                        </div>
                        {s.tools.length > 0 ? (
                          <div className="wrap-row" style={{ marginTop: 8 }}>
                            {s.tools.map((t) => (
                              <span className="chip" key={t}>
                                {t}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {s.error ? (
                          <div className="fs-12" style={{ marginTop: 6, color: 'var(--error)' }}>
                            {s.error}
                          </div>
                        ) : null}
                        {test ? (
                          <div
                            className="fs-12"
                            style={{ marginTop: 6, color: test.ok ? undefined : 'var(--error)' }}
                          >
                            <span className={test.ok ? 'muted' : undefined}>{test.text}</span>
                          </div>
                        ) : null}
                      </div>
                      <div className="row">
                        <button
                          type="button"
                          className={classNames('switch', s.enabled && 'is-on')}
                          aria-label={s.enabled ? '停用' : '启用'}
                          aria-pressed={s.enabled}
                          disabled={mcpBusy !== null}
                          onClick={() => void doToggleMcp(s)}
                        />
                        {s.status === 'ok' ? (
                          <span className="tag tag-ok">已连接{s.latency != null ? ` · ${s.latency}ms` : ''}</span>
                        ) : s.status === 'failed' ? (
                          <span className="tag tag-danger">连接失败</span>
                        ) : (
                          <span className="tag tag-quiet">已停用</span>
                        )}
                        <button
                          type="button"
                          className="btn btn-quiet btn-sm"
                          onClick={() => void doTestMcp(s)}
                          disabled={mcpBusy !== null}
                        >
                          {mcpBusy === `test:${s.name}` ? '测试中…' : '测试'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-quiet btn-sm"
                          disabled={mcpBusy !== null}
                          onClick={() =>
                            setMcpForm({
                              origin: s.name,
                              name: s.name,
                              transport: s.transport === 'http' ? 'http' : 'stdio',
                              command: s.command ?? '',
                              url: s.url ?? '',
                              tools: s.tools.join(', '),
                              enabled: s.enabled,
                            })
                          }
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn btn-quiet btn-sm"
                          disabled={mcpBusy !== null}
                          onClick={() => removeMcp(s)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  )
                })
              )}
              {mcpForm ? (
                <div className="provider-card" style={{ background: 'var(--paper-2)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="provider-name">
                      {mcpForm.origin ? `编辑：${mcpForm.origin}` : '新增外部工具'}
                    </div>
                    <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      <label className="field-label" htmlFor="mcp-name">
                        名称
                      </label>
                      <input
                        id="mcp-name"
                        className="input"
                        placeholder="例如：本地设定库"
                        value={mcpForm.name}
                        onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })}
                      />
                      <label className="field-label" htmlFor="mcp-transport">
                        连接方式
                      </label>
                      <select
                        id="mcp-transport"
                        className="input"
                        value={mcpForm.transport}
                        onChange={(e) =>
                          setMcpForm({ ...mcpForm, transport: e.target.value as 'stdio' | 'http' })
                        }
                      >
                        <option value="stdio">本机命令</option>
                        <option value="http">远程地址</option>
                      </select>
                    </div>
                    <div className="row" style={{ gap: 8, marginTop: 8 }}>
                      {mcpForm.transport === 'stdio' ? (
                        <>
                          <label className="field-label" htmlFor="mcp-command">
                            启动命令
                          </label>
                          <input
                            id="mcp-command"
                            className="input mono"
                            placeholder="python3 mcp/example_server.py"
                            value={mcpForm.command}
                            onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })}
                          />
                        </>
                      ) : (
                        <>
                          <label className="field-label" htmlFor="mcp-url">
                            服务地址
                          </label>
                          <input
                            id="mcp-url"
                            className="input mono"
                            placeholder="https://your-host/mcp"
                            value={mcpForm.url}
                            onChange={(e) => setMcpForm({ ...mcpForm, url: e.target.value })}
                          />
                        </>
                      )}
                    </div>
                    <div className="row" style={{ gap: 8, marginTop: 8 }}>
                      <label className="field-label" htmlFor="mcp-tools">
                        工具名
                      </label>
                      <input
                        id="mcp-tools"
                        className="input mono"
                        placeholder="lookup_setting, search_reference"
                        value={mcpForm.tools}
                        onChange={(e) => setMcpForm({ ...mcpForm, tools: e.target.value })}
                      />
                    </div>
                    <div className="row" style={{ gap: 10, marginTop: 10 }}>
                      <button
                        type="button"
                        className={classNames('switch', mcpForm.enabled && 'is-on')}
                        aria-label={mcpForm.enabled ? '停用' : '启用'}
                        aria-pressed={mcpForm.enabled}
                        onClick={() => setMcpForm({ ...mcpForm, enabled: !mcpForm.enabled })}
                      />
                      <span className="fs-12 muted">
                        {mcpForm.enabled ? '保存后即参与检索' : '保存但先不启用'}
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={mcpBusy !== null}
                        onClick={submitMcpForm}
                      >
                        {mcpBusy === 'save' ? '保存中…' : '保存'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        onClick={() => setMcpForm(null)}
                      >
                        取消
                      </button>
                    </div>
                    <div
                      className="fs-12 muted"
                      style={{ marginTop: 8 }}
                      title="命令以服务端 server/ 为基准；示例命令：python3 mcp/example_server.py；工具名示例：lookup_setting, search_reference, fetch_history"
                    >
                      选择「本机命令」时，命令以服务端目录为基准；工具名用逗号分隔，留空表示全部开放。
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="card-foot">
              <span className="fs-12 muted">
                {mcp?.note || '外部工具不可用时，全流程会自动回落到内置检索，不会阻塞写作。'}
              </span>
            </div>
          </section>
        </div>
      )}

      {/* 「添加服务商」：后端暂不支持在线新增，此模态用于对照检查并产出「本地配置片段」 */}
      {addOpen ? (
        <div className="modal">
          <div className="modal-veil" onClick={() => setAddOpen(false)} />
          <div className="modal-card">
            <div className="card-head">
              <h2>添加服务商</h2>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAddOpen(false)}>
                关闭
              </button>
            </div>
            <div className="card-body stack">
              <div className="honest-note">
                目前暂不支持在页面上直接新增服务商——新增服务商需要先在本地配置文件里声明
                （名称、服务地址、默认模型等），再回到本页列表点「填写密钥」保存，密钥写入服务端后即可启用。
                下面表单用于把要新增的内容拼成一段可直接贴进配置文件的片段。
              </div>
              <div className="field">
                <label className="field-label" htmlFor="pv-name">
                  名称
                </label>
                <input
                  id="pv-name"
                  className="input"
                  type="text"
                  placeholder="例如 DeepSeek"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="pv-url">
                  服务地址
                </label>
                <input
                  id="pv-url"
                  className="input mono"
                  type="text"
                  placeholder="https://api.deepseek.com/v1"
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="pv-model">
                  默认模型
                </label>
                <input
                  id="pv-model"
                  className="input mono"
                  type="text"
                  placeholder="deepseek-chat"
                  value={addModel}
                  onChange={(e) => setAddModel(e.target.value)}
                />
              </div>
              <div className="field">
                <span className="field-label">配置片段（随上面内容实时更新，可贴进本地配置文件）</span>
                <pre
                  className="mono-block"
                  title="本地配置文件：server/config/providers.json；密钥值只填在服务端的密钥文件里，不写进此片段"
                >
                  {providerSnippet}
                </pre>
              </div>
              <div className="fs-12 muted">
                密钥值得在本地配置文件声明好之后，回到本页列表点「填写密钥」保存到服务端；
                本页只显示「已配置 / 未配置」与脱敏指纹，永不接触明文。
              </div>
            </div>
            <div className="card-foot row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setAddOpen(false)}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void copySnippet()}>
                复制配置片段
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
