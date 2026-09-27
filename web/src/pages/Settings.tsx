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
  updateProvider,
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

  return (
    <>
      <TopBar title="设置" sub="模型接入 · 全部通过接口调用 · 不含本地模型" />

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
                <span className="fs-12 muted">密钥写在服务端 .env 里，前端只用于显示状态</span>
              </div>
            </section>
          ) : null}

          {/* 1. 服务商 */}
          <section className="card">
            <div className="card-head">
              <h2>模型服务</h2>
              <span className="tag tag-quiet">OpenAI 兼容协议</span>
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
                            <span className="mono fs-12 muted" title="密钥所在环境变量名">
                              {p.apiKeyRef}
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
              <span className="fs-12 muted">
                密钥只存在服务端 .env，前端永不接触；这里只显示「已配置 / 未配置」与脱敏指纹。
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
              <span className="tag tag-quiet">按环节分配</span>
            </div>
            <div className="card-body">
              <table className="table">
                <thead>
                  <tr>
                    <th>环节</th>
                    <th>模型</th>
                    <th>服务商</th>
                    <th>温度</th>
                    <th>输出格式</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => (
                    <tr key={r.key || r.step}>
                      <td>{r.step}</td>
                      <td className="mono">{r.model}</td>
                      <td>{r.provider || '—'}</td>
                      <td className="mono">{r.temperature}</td>
                      <td title={r.format}>{formatLabel(r.format)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="fs-12 muted" style={{ marginTop: 12 }}>
                每个环节绑定一个模型：不同的活儿用不同的模型，既省钱也稳。
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
                          : '按接口用量计'}
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
              <span className="tag tag-info">
                已启用 {mcp?.enabledCount ?? 0} · 正常 {mcp?.healthyCount ?? 0}
              </span>
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
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            <div className="card-foot">
              <span className="fs-12 muted">
                {mcp?.note || '外部工具不可用时，全流程会自动回落到内置检索，不会阻塞写作。'}
              </span>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
