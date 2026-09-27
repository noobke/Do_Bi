/**
 * 本地 API 路由 —— 把 `web/src/api/client.ts` 原本发往 FastAPI 的请求
 * **原地分发到本地核心（`web/src/api/core/*`）**。
 *
 * 目标是「契约不变、传输层换掉」：路径、方法、请求体、响应体形状与
 * `server/dobi/api/routes/*` 逐字对齐，页面代码一行不改。
 *
 * - 响应统一走 `toApi()` 转 camelCase（等价后端 `to_api`）
 * - 错误统一转成 `LocalApiError`（带 code / status），由 client 包成 `ApiError`
 * - 流式接口（章节生成 / 整本生产）用事件回调模拟 SSE
 */

import { Auditor, ChatAgent, Reviewer } from './agents'
import { CheckpointManager } from './checkpoint'
import { buildContext } from './context'
import { Disassembler, load as loadDisassemble } from './disassemble'
import { graphNode, MemoryIndex } from './memory'
import { entityDetail, graphOf, indexOf, KIND_LABEL } from './knowledge'
import { ruleCatalog } from './l1'
import { BudgetExceededError, NotConfiguredError, NotFoundError, BadRequestError, ConflictError, ProjectStore, ensureProjectInIndex, listProjectIds, newProjectId, removeProjectFromIndex } from './store'
import { Meter } from './metering'
import { ModeController } from './mode'
import { Planner } from './orchestrator/planner'
import { Pipeline, PipelineStepFailed, BookRunner } from './orchestrator/pipeline'
import { Steering } from './orchestrator/steer'
import { toApi } from './serialize'
import * as storage from './storage'
import { ProviderAuthError, ProviderError, ModelOutputError, probe, probeSnapshot, setScope, windowFor } from './llm'
import { analyzeStyle, mergeProfile, presetProfile, presets, styleIsEmpty } from './style'
import { KIND_LABELS as STORY_KIND_LABELS, bookAnchors, chapterEvents, matchAnchor } from './story'
import {
  PROVIDERS,
  ROLES,
  configuredProviders,
  fingerprint,
  getApiKey,
  providerByName,
  providerPublic,
  readMcp,
  roleFor,
  rolePublic,
  saveApiKey,
  saveProvidersStore,
  saveRolesStore,
  writeMcp,
  type McpServerState,
} from './settings'
import { TruthWriter, proposal } from './truthwriter'
import type { AuditReport, Hook, Proposal } from './types'

// ==========================================================================
// 错误
// ==========================================================================

/** 本地路由错误：携带 code / status，client 会转成 ApiError（文案可直接给作者看）。 */
export class LocalApiError extends Error {
  readonly code: string
  readonly status: number
  readonly detail?: unknown

  constructor(message: string, code: string, status: number, detail?: unknown) {
    super(message)
    this.name = 'LocalApiError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

function fail(status: number, code: string, message: string, detail?: unknown): never {
  throw new LocalApiError(message, code, status, detail)
}

/** 把核心层各种异常统一映射成 LocalApiError（状态码对齐 `server/dobi/errors.py`）。 */
function mapError(e: unknown): LocalApiError {
  if (e instanceof LocalApiError) return e
  if (e instanceof NotFoundError) return new LocalApiError(e.message, 'not_found', 404)
  if (e instanceof BadRequestError) return new LocalApiError(e.message, 'bad_request', 400)
  if (e instanceof ConflictError) return new LocalApiError(e.message, 'conflict', 409)
  if (e instanceof NotConfiguredError) return new LocalApiError(e.message, 'not_configured', 503)
  if (e instanceof BudgetExceededError) return new LocalApiError(e.message, 'budget_exceeded', 402, e.detail)
  if (e instanceof PipelineStepFailed) return new LocalApiError(e.outcome.note || '这一步失败了。', 'step_failed', 400)
  if (e instanceof ProviderAuthError) return new LocalApiError(e.message, 'provider_auth', 502, e.detail)
  if (e instanceof ModelOutputError) return new LocalApiError(e.message, 'model_output', 502)
  if (e instanceof ProviderError) return new LocalApiError(e.message, 'provider_error', 502, e.detail)
  const message = e instanceof Error ? e.message : '本地执行失败，请重试。'
  return new LocalApiError(message, 'internal', 500)
}

// ==========================================================================
// 项目与计量
// ==========================================================================

const PROJECT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function listStores(): ProjectStore[] {
  return listProjectIds()
    .map((id) => new ProjectStore(id))
    .filter((s) => s.exists)
    .sort((a, b) => (a.meta().updated_at < b.meta().updated_at ? 1 : -1))
}

function getStore(projectId: string): ProjectStore {
  if (!PROJECT_ID_RE.test(projectId || '')) fail(404, 'not_found', `没有这个作品：${projectId}`)
  const store = new ProjectStore(projectId)
  if (!store.exists) fail(404, 'not_found', `没有这个作品：${projectId}`)
  return store
}

/** 构造计量器并接到全局用量回调上（密钥与账目都只在本地）。 */
function makeMeter(store: ProjectStore): Meter {
  const meter = new Meter(store)
  meter.install()
  return meter
}

// ==========================================================================
// 请求体读取（camelCase / snake_case 双兼容）
// ==========================================================================

type Body = Record<string, unknown>

function asBody(body: unknown): Body {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Body) : {}
}

function pick<T = unknown>(body: Body, ...keys: string[]): T | undefined {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null) return body[key] as T
  }
  return undefined
}

// ==========================================================================
// 视图辅助（镜像 chapters.py 的私有函数）
// ==========================================================================

function paraIndex(ref: string): number {
  if (!ref || !ref.includes('#')) return 0
  const tail = ref.split('#')[1] ?? ''
  if (tail.startsWith('para-')) {
    const n = parseInt(tail.slice(5), 10)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

const CATEGORY_OF_DIM: Record<string, string> = {
  设定冲突: '设定', '战力/等级漂移': '设定', '数值／等级矛盾': '设定',
  OOC: '角色', 动机不足: '角色', 情感弧线断裂: '角色', 对话同质化: '角色',
  节奏单调: '节奏', 场景重复: '节奏', 爽点缺失: '节奏',
  因果断裂: '结构', 支线停滞: '结构', 时间线矛盾: '结构', 伏笔遗漏: '结构',
  信息泄露: '结构',
  文风偏移: '文风',
}

function actBeats(store: ProjectStore, act: A | null, chapter: number): Array<Record<string, unknown>> {
  if (act === null) return []
  const graph = store.outlineGraph()
  const out: Array<Record<string, unknown>> = []
  for (const node of [...graph.nodes].sort((a, b) => a.chapter - b.chapter)) {
    if (node.chapter < (act.from as number)) continue
    if (node.chapter > ((act.to as number) || (act.from as number))) continue
    out.push({
      chapter: node.chapter, title: node.title, goal: node.goal, beats: node.beats,
      status: node.chapter < chapter ? 'past' : node.chapter === chapter ? 'current' : 'future',
    })
  }
  return out
}

interface A { name: string; from: number; to: number; note: string; status: string }

function pipelineView(store: ProjectStore, chapter: number): Record<string, unknown> {
  const cp = new CheckpointManager(store)
  const progress = cp.progress(chapter)
  const meter = new Meter(store)
  const byStep: Record<string, { tokens: number; cost: number; calls: number; latencyMs: number }> = {}
  for (const entry of meter.entries().filter((e) => e.chapter === chapter)) {
    const row = (byStep[entry.step || 'draft'] ??= { tokens: 0, cost: 0, calls: 0, latencyMs: 0 })
    row.tokens += entry.total_tokens || entry.prompt_tokens + entry.completion_tokens
    row.cost = Math.round((row.cost + entry.cost) * 10000) / 10000
    row.calls += 1
    row.latencyMs += entry.latency_ms
  }
  const zero = { tokens: 0, cost: 0, calls: 0, latencyMs: 0 }
  const steps = (progress.steps as Array<Record<string, unknown>>).map((item) => ({
    ...item, ...(byStep[String(item.key)] ?? zero),
  }))
  return {
    steps,
    done: progress.done,
    active: progress.active,
    total: progress.total,
    next: progress.next,
    failed: progress.failed,
    lastCheckpointAt: progress.lastCheckpointAt,
    cost: Math.round(steps.reduce((s, x) => s + (x.cost as number), 0) * 10000) / 10000,
    tokens: steps.reduce((s, x) => s + (x.tokens as number), 0),
  }
}

function contextView(store: ProjectStore, chapter: number): Record<string, unknown> {
  const node = graphNode(store.outlineGraph(), chapter)
  const draft = store.chapterText(chapter)
  let window = 32000
  try {
    window = windowFor('writer')
  } catch {
    window = 32000
  }
  return buildContext(store, chapter, { purpose: 'writer', contextWindow: window, node, draft }).public()
}

function fishbone(store: ProjectStore, chapter: number): Record<string, unknown> | null {
  const report = store.readAudit(chapter)
  if (report === null || !report.items.length) return null
  const buckets = new Map<string, string[]>()
  for (const item of report.items) {
    let category = CATEGORY_OF_DIM[item.dim]
    if (category === undefined) category = item.dim.startsWith('规则 · ') ? '文风' : '其他'
    buckets.set(category, [...(buckets.get(category) ?? []), item.dim])
  }
  const rank: Record<string, number> = { blocker: 0, major: 1, minor: 2 }
  let worst = 'minor'
  for (const item of report.items) {
    if ((rank[item.severity] ?? 3) < (rank[worst] ?? 3)) worst = item.severity
  }
  const causes = [...buckets.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([category, items]) => ({ category, items }))
  return { title: `第 ${chapter} 章的问题归因（共 ${report.items.length} 条）`, severity: worst, causes }
}

function restat(report: AuditReport): Record<string, number> {
  const items = report.items
  const fixed = items.filter((i) => i.fixed).length
  const total = items.length || 1
  return {
    l1: report.l1_violations.length,
    l2: items.filter((i) => !i.dim.startsWith('规则 · ')).length,
    fixed,
    open: items.filter((i) => !i.fixed).length,
    blocker: items.filter((i) => i.severity === 'blocker' && !i.fixed).length,
    major: items.filter((i) => i.severity === 'major' && !i.fixed).length,
    passRate: items.length ? Math.round((fixed / total) * 100) : 100,
  }
}

function renderWorldMd(store: ProjectStore): string {
  const rules = store.world().rules
  if (!rules.length) return '（暂无内容）'
  const lines = ['# 世界观', '']
  for (const r of rules) {
    const mark = r.status === 'conflict' ? ' ⚠️待裁定冲突' : ''
    lines.push(`- [${r.kind === 'hard' ? '硬约束' : '软设定'} / ${r.category}] ${r.rule}${mark}`)
    if (r.note) lines.push(`  - 备注：${r.note}`)
  }
  return lines.join('\n')
}

function styleSources(store: ProjectStore): Array<Record<string, unknown>> {
  const overview = store.chaptersOverview()
  const committed = overview.filter((c) => c.status === 'done')
  const words = committed.reduce((s, c) => s + (c.words as number), 0)
  const profile = store.style()
  return [
    { id: 'src_upload', kind: 'file', label: '上传或粘贴参考样本',
      hint: 'txt / md，建议 ≥ 8000 字；样本越纯，提取越准', checked: true },
    { id: 'src_book', kind: 'book', label: '从本书已定稿章节提取',
      hint: committed.length ? `已定稿 ${committed.length} 章 · 约 ${words} 字` : '还没有已定稿的章节',
      checked: false, disabled: committed.length === 0 },
    { id: 'src_merge', kind: 'merge', label: '与当前档案合并（保留禁用词）',
      hint: '合并而非覆盖，适合逐步调教', checked: !styleIsEmpty(profile) },
  ]
}

// ==========================================================================
// 路由分发
// ==========================================================================

type Handler = (m: RegExpExecArray, query: URLSearchParams, body: Body) => Promise<unknown> | unknown

interface Route {
  method: string
  re: RegExp
  handler: Handler
}

const ROUTES: Route[] = []

function route(method: string, pattern: string, handler: Handler): void {
  ROUTES.push({ method, re: new RegExp(pattern), handler })
}

// ---------------- 项目 ----------------

route('GET', '^/projects$', () => {
  const current = storage.readCurrent()
  return {
    projects: listStores().map((s) => ({ ...s.projectSummary(), isCurrent: s.id === current })),
    current,
  }
})

route('POST', '^/projects$', (_m, _q, body) => {
  const title = String(pick(body, 'title') ?? '').trim()
  if (!title) fail(400, 'bad_request', '作品名不能为空。')
  const pid = newProjectId(title)
  const premise = String(pick(body, 'premise') ?? '')
  const store = ProjectStore.create(pid, {
    title,
    genre: String(pick(body, 'genre') ?? '') || '待定',
    premise,
    logline: premise,
    mode: String(pick(body, 'mode') ?? 'semi-auto'),
    budget_total: pick<number>(body, 'budgetTotal', 'budget_total') ?? null,
  })
  const chaptersTotal = Number(pick(body, 'chaptersTotal', 'chapters_total') ?? 0)
  if (chaptersTotal) store.touchMeta({ chapters_total: chaptersTotal })
  ensureProjectInIndex(pid)
  storage.writeCurrent(pid)
  return { project: { ...store.projectSummary(), isCurrent: true } }
})

route('GET', '^/projects/([^/]+)$', (m) => {
  const store = getStore(m[1])
  return {
    project: store.projectSummary(),
    meta: store.meta(),
    mode: new ModeController(store).public(),
  }
})

route('DELETE', '^/projects/([^/]+)$', (m) => {
  const store = getStore(m[1])
  store.delete()
  removeProjectFromIndex(store.id)
  if (storage.readCurrent() === store.id) {
    const remaining = listStores()
    storage.writeCurrent(remaining.length ? remaining[0].id : null)
  }
  return { ok: true, id: store.id }
})

route('POST', '^/projects/([^/]+)/open$', (m) => {
  const store = getStore(m[1])
  storage.writeCurrent(store.id)
  return { ok: true, project: { ...store.projectSummary(), isCurrent: true } }
})

route('POST', '^/projects/([^/]+)/mode$', (m, _q, body) => {
  const store = getStore(m[1])
  const controller = new ModeController(store)
  const mode = pick<string>(body, 'mode')
  const step = pick<string>(body, 'step')
  const policy = pick<string>(body, 'policy')
  if (mode) controller.setMode(mode)
  else if (step) {
    if (!policy) fail(400, 'bad_request', '改了环节策略却没给 policy。')
    controller.setStep(step, policy)
  }
  const stopConditions = pick<string[]>(body, 'stopConditions', 'stop_conditions')
  if (stopConditions !== undefined) controller.setStopConditions(stopConditions)
  return controller.public()
})

route('GET', '^/projects/([^/]+)/overview$', (m) => {
  const store = getStore(m[1])
  const meter = new Meter(store)
  const cp = new CheckpointManager(store)
  const chapters = store.chaptersOverview()
  const audits: Array<Record<string, unknown>> = []
  for (const item of chapters) {
    const report = store.readAudit(item.n as number)
    if (report !== null) audits.push({ chapter: item.n, ...report.stats })
  }
  return {
    project: store.projectSummary(),
    chapters,
    hooks: store.hookStats(),
    audits,
    usage: meter.public(8),
    mode: new ModeController(store).public(),
    resume: cp.diagnose().public(),
    checkpoints: [...store.checkpoints().slice(-8)].reverse(),
    steering: store.steeringDirectives(),
    style: store.style(),
  }
})

route('GET', '^/projects/([^/]+)/structure$', (m) => {
  const store = getStore(m[1])
  const graph = store.outlineGraph()
  return {
    chapters: store.chaptersOverview(),
    volumes: graph.volumes,
    nodes: graph.nodes,
    edges: graph.edges,
    compass: graph.compass,
    plotlines: store.subplots(),
    anchors: bookAnchors(store),
    kindLabels: STORY_KIND_LABELS,
    updatedAt: graph.updated_at,
  }
})

route('GET', '^/projects/([^/]+)/outline/graph$', (m) => {
  const graph = getStore(m[1]).outlineGraph()
  return {
    compass: graph.compass, volumes: graph.volumes,
    nodes: graph.nodes, edges: graph.edges, updatedAt: graph.updated_at,
  }
})

route('GET', '^/projects/([^/]+)/plan/coverage$', (m) => new Planner(getStore(m[1])).coverage())

route('POST', '^/projects/([^/]+)/plan$', async (m, _q, body) => {
  const store = getStore(m[1])
  const meter = makeMeter(store)
  const planner = new Planner(store, meter)
  const targets = pick<string[]>(body, 'targets') ?? ['world', 'characters', 'outline']
  const volumes = Number(pick(body, 'volumes') ?? 2)
  const outcome = await planner.bootstrap({ targets, volumes })
  return { ...outcome.public(), coverage: new Planner(store).coverage() }
})

route('POST', '^/projects/([^/]+)/plan/rolling$', async (m) => {
  const store = getStore(m[1])
  return (await new Planner(store, makeMeter(store)).rollNext()).public()
})

route('GET', '^/projects/([^/]+)/chat$', (m) => {
  const store = getStore(m[1])
  const agent = new ChatAgent(store, makeMeter(store))
  return { seed: agent.seed(), messages: agent.history() }
})

route('POST', '^/projects/([^/]+)/chat$', async (m, _q, body) => {
  const store = getStore(m[1])
  const message = String(pick(body, 'message') ?? '').trim()
  if (!message) fail(400, 'bad_request', '消息不能为空。')
  const agent = new ChatAgent(store, makeMeter(store))
  const result = await agent.reply(message)
  return { ...result, seed: agent.seed() }
})

route('GET', '^/projects/([^/]+)/stats$', (m) => {
  const store = getStore(m[1])
  const memory = new MemoryIndex(store)
  const overview = store.chaptersOverview()
  return {
    chapters: overview.length,
    words: overview.reduce((s, c) => s + (c.words as number), 0),
    hooks: store.hookStats(),
    characters: store.characters().length,
    worldRules: store.world().rules.length,
    memory: memory.stats(),
    budget: new Meter(store).budget(),
  }
})

// ---------------- 章节 ----------------

route('GET', '^/projects/([^/]+)/chapters$', (m) => ({ chapters: getStore(m[1]).chaptersOverview() }))

route('GET', '^/projects/([^/]+)/chapters/(\\d+)$', (m) => {
  const store = getStore(m[1])
  const n = Number(m[2])
  return {
    chapter: store.readChapter(n),
    node: graphNode(store.outlineGraph(), n),
    audit: store.readAudit(n),
    review: store.readReview(n),
    checkpoints: store.checkpoints(n),
  }
})

route('GET', '^/projects/([^/]+)/chapters/(\\d+)/manuscript$', (m) => {
  const store = getStore(m[1])
  const n = Number(m[2])
  const data = store.readChapter(n)
  const report = store.readAudit(n)
  const marks = new Map<number, Record<string, string>>()
  if (report !== null) {
    for (const item of report.items) {
      const idx = paraIndex(item.ref)
      if (idx) marks.set(idx, { mark: 'hl', note: `${item.dim}：${item.suggestion || item.evidence}` })
    }
  }
  return {
    n,
    title: data.title,
    status: data.status,
    words: data.words,
    pov: data.pov,
    paragraphs: data.paragraphs.map((text, i) => ({
      gutter: `${n}.${i + 1}`, text, ...(marks.get(i + 1) ?? {}),
    })),
  }
})

route('GET', '^/projects/([^/]+)/chapters/(\\d+)/detail$', (m) => {
  const store = getStore(m[1])
  const n = Number(m[2])
  const data = store.readChapter(n)
  const graph = store.outlineGraph()
  const node = graphNode(graph, n)
  if (node === null && !data.paragraphs.length) fail(404, 'not_found', `第 ${n} 章还没有章纲，先生成章纲。`)

  const acts: A[] = graph.volumes.map((v) => ({
    name: v.name, from: v.from_chapter, to: v.to_chapter, note: v.goal, status: v.status,
  }))
  const act = acts.find((a) => a.from <= n && n <= (a.to || a.from)) ?? null

  const anchors = bookAnchors(store)
  let located = 0
  const events = chapterEvents(store, n).map((event) => {
    const anchor = matchAnchor(event.label, anchors)
    if (anchor) located += 1
    return { ...event, anchorId: anchor ? anchor.id : null, anchorAt: anchor ? anchor.storyAt : null }
  })

  return {
    chapter: data,
    node,
    acts,
    act,
    beats: actBeats(store, act, n),
    pipeline: pipelineView(store, n),
    context: contextView(store, n),
    timeline: {
      events, anchors, located, total: events.length, kindLabels: STORY_KIND_LABELS,
    },
    fishbone: fishbone(store, n),
    rules: ruleCatalog(),
  }
})

route('GET', '^/projects/([^/]+)/chapters/(\\d+)/audit$', (m) => {
  const store = getStore(m[1])
  const n = Number(m[2])
  const report = store.readAudit(n)
  if (report === null) fail(404, 'not_found', `第 ${n} 章还没有审查报告，先跑一次审查。`)
  return { ...report, rules: ruleCatalog() }
})

route('GET', '^/projects/([^/]+)/chapters/(\\d+)/review$', (m) => {
  const report = getStore(m[1]).readReview(Number(m[2]))
  if (report === null) fail(404, 'not_found', `第 ${m[2]} 章还没有评审报告，先跑一次评审。`)
  return { ...report }
})

route('GET', '^/projects/([^/]+)/chapters/(\\d+)/checkpoints$', (m) => {
  const store = getStore(m[1])
  const n = Number(m[2])
  return { progress: new CheckpointManager(store).progress(n), checkpoints: store.checkpoints(n) }
})

route('GET', '^/projects/([^/]+)/chapters/(\\d+)/context$', (m) => {
  return contextView(getStore(m[1]), Number(m[2]))
})

route('POST', '^/projects/([^/]+)/chapters/(\\d+)/plan$', async (m) => {
  const store = getStore(m[1])
  return (await new Pipeline(store, makeMeter(store)).runStep(Number(m[2]), 'plan', { force: true })).public()
})

route('POST', '^/projects/([^/]+)/chapters/(\\d+)/audit$', async (m, _q, body) => {
  const store = getStore(m[1])
  const n = Number(m[2])
  const dims = pick<string[]>(body, 'dims') ?? null
  const runL2 = pick<boolean>(body, 'runL2', 'run_l2') ?? true
  const report = await new Auditor(store, makeMeter(store)).audit(n, { dims, runL2 })
  return { ...report, rules: ruleCatalog() }
})

route('POST', '^/projects/([^/]+)/chapters/(\\d+)/review$', async (m) => {
  const store = getStore(m[1])
  return { ...(await new Reviewer(store, makeMeter(store)).review(Number(m[2]))) }
})

route('POST', '^/projects/([^/]+)/chapters/(\\d+)/deai$', async (m) => {
  const store = getStore(m[1])
  return (await new Pipeline(store, makeMeter(store)).runStep(Number(m[2]), 'deai', { force: true })).public()
})

route('POST', '^/projects/([^/]+)/chapters/(\\d+)/revise$', async (m) => {
  const store = getStore(m[1])
  return (await new Pipeline(store, makeMeter(store)).runStep(Number(m[2]), 'revise')).public()
})

route('POST', '^/projects/([^/]+)/chapters/(\\d+)/commit$', async (m, q) => {
  const store = getStore(m[1])
  const force = q.get('force') === 'true'
  return (await new Pipeline(store, makeMeter(store)).runStep(Number(m[2]), 'commit', { force })).public()
})

route('POST', '^/projects/([^/]+)/chapters/(\\d+)/stop$', (m) => {
  const store = getStore(m[1])
  const n = Number(m[2])
  const data = store.readChapter(n)
  return {
    ok: true,
    chapter: n,
    saved: { words: data.words, paragraphs: data.paragraphs.length, status: data.status },
    message: data.paragraphs.length
      ? '已停止。已生成的部分已保存为草稿，下次继续写会从断点续写。'
      : '已停止。本章还没有内容。',
  }
})

route('POST', '^/projects/([^/]+)/chapters/(\\d+)/findings/([^/]+)/decision$', (m, _q, body) => {
  const store = getStore(m[1])
  const n = Number(m[2])
  const dim = decodeURIComponent(m[3])
  const report = store.readAudit(n)
  if (report === null) fail(404, 'not_found', `第 ${n} 章还没有审查报告。`)
  const action = pick<string | null>(body, 'action') ?? null
  if (![ 'accept', 'ignore', null ].includes(action)) {
    fail(400, 'bad_request', '决策只能取 accept / ignore / 撤回。')
  }
  let hit = false
  for (const item of report.items) {
    if (item.dim === dim) {
      item.decision = action as 'accept' | 'ignore' | null
      item.fixed = action === 'accept' && Boolean(item.patch)
      hit = true
    }
  }
  if (!hit) fail(404, 'not_found', `第 ${n} 章没有名为「${dim}」的发现。`)
  report.stats = restat(report)
  store.saveAudit(report)
  return { ok: true, chapter: n, dim, action, stats: report.stats }
})

route('GET', '^/projects/([^/]+)/audit$', (m, q) => {
  const store = getStore(m[1])
  const overview = store.chaptersOverview()
  const qChapter = q.get('chapter')
  let target: number | null = qChapter != null ? Number(qChapter) : null
  if (target === null) {
    const candidates = overview.filter((c) => store.readAudit(c.n as number) !== null).map((c) => c.n as number)
    target = candidates.length ? Math.max(...candidates) : null
  }
  if (target === null) {
    return {
      chapter: null, stats: {}, items: [], rules: ruleCatalog(), l1: [], review: [], diffs: [],
      chapters: overview.map((c) => c.n), message: '还没有任何审查报告。',
    }
  }
  const report = store.readAudit(target)
  if (report === null) fail(404, 'not_found', `第 ${target} 章还没有审查报告。`)
  return {
    ...report,
    rules: ruleCatalog(),
    chapters: overview.filter((c) => store.readAudit(c.n as number) !== null).map((c) => c.n),
  }
})

// ---------------- 角色 / 伏笔 / 世界观 ----------------

route('GET', '^/projects/([^/]+)/characters$', (m) => {
  const chars = getStore(m[1]).characters()
  const roles: string[] = []
  for (const c of chars) if (!roles.includes(c.role)) roles.push(c.role)
  return {
    characters: chars,
    roles: ['全部', ...roles],
    stats: {
      total: chars.length,
      lead: chars.filter((c) => c.lead).length,
      deceased: chars.filter((c) => c.deceased).length,
      traits: chars.reduce((s, c) => s + c.immutable_traits.length, 0),
    },
  }
})

route('GET', '^/projects/([^/]+)/characters/([^/]+)$', (m) => {
  const store = getStore(m[1])
  const key = decodeURIComponent(m[2])
  const char = store.character(key)
  if (char === null) fail(404, 'not_found', `没有这个角色：${key}`)
  const hooks = store.hooks().filter((h) => char.id === h.id || h.linked_characters.includes(char.id) || h.content.includes(char.name))
  return { ...char, hooks }
})

route('POST', '^/projects/([^/]+)/characters/([^/]+)/state$', (m, _q, body) => {
  const store = getStore(m[1])
  const key = decodeURIComponent(m[2])
  const char = store.character(key)
  if (char === null) fail(404, 'not_found', `没有这个角色：${key}`)
  const changes: Record<string, unknown> = {}
  const location = pick<string>(body, 'location')
  const status = pick<string>(body, 'status')
  const knownSecrets = pick<string[]>(body, 'knownSecrets', 'known_secrets')
  if (location !== undefined) changes.location = location
  if (status !== undefined) changes.status = status
  if (knownSecrets !== undefined) changes.known_secrets = knownSecrets
  if (!Object.keys(changes).length) fail(400, 'bad_request', '没有要改的内容。')
  const chapter = pick<number>(body, 'chapter')
  if (chapter) changes.updated_at_chapter = chapter

  const result = new TruthWriter(store).commit(
    [manualProposal(`manual_state_${char.id}`, 'character_update',
      { id: char.id, changes: { state: changes } }, 'characters.jsonl', '作者手工修改')],
    { force: true },
  )
  if (result.pending.length) fail(400, 'bad_request', result.issues[0]?.message ?? '这条修改没能通过校验。')
  return { ok: true, character: store.character(char.id) }
})

route('GET', '^/projects/([^/]+)/hooks$', (m) => {
  const store = getStore(m[1])
  const current = store.chaptersOverview().reduce((mx, c) => Math.max(mx, c.n as number), 0)
  const hooks = store.hooks().map((h) => ({
    ...h,
    overdue: h.status === 'planted' && h.suggested_resolve_by != null && current > h.suggested_resolve_by,
  }))
  return { hooks, stats: store.hookStats(current), currentChapter: current }
})

route('POST', '^/projects/([^/]+)/hooks$', (m, _q, body) => {
  const store = getStore(m[1])
  const content = String(pick(body, 'content') ?? '').trim()
  if (content.length < 2) fail(400, 'bad_request', '伏笔内容太短。')
  const hook: Hook = {
    id: store.nextHookId(),
    content,
    planted_chapter: Number(pick(body, 'plantedChapter', 'planted_chapter') ?? 1),
    status: 'planted',
    resolved_chapter: null,
    importance: String(pick(body, 'importance') ?? 'minor') === 'major' ? 'major' : 'minor',
    linked_characters: pick<string[]>(body, 'linkedCharacters', 'linked_characters') ?? [],
    suggested_resolve_by: pick<number | null>(body, 'suggestedResolveBy', 'suggested_resolve_by') ?? null,
  }
  const result = new TruthWriter(store).commit([
    manualProposal(`manual_${hook.id}`, 'hook_add', { ...hook }, 'pending_hooks.jsonl', '作者手工登记'),
  ])
  if (result.pending.length) fail(400, 'bad_request', result.issues[0]?.message ?? '这条伏笔没能通过校验。')
  return { ok: true, hooks: store.hooks(), stats: store.hookStats() }
})

route('POST', '^/projects/([^/]+)/hooks/([^/]+)/resolve$', (m, _q, body) => {
  const store = getStore(m[1])
  const hookId = decodeURIComponent(m[2])
  if (store.hook(hookId) === null) fail(404, 'not_found', `没有这条伏笔：${hookId}`)
  const current = store.chaptersOverview().reduce((mx, c) => Math.max(mx, c.n as number), 1)
  const chapter = pick<number>(body, 'chapter') ?? current
  const result = new TruthWriter(store).commit([
    manualProposal(`manual_resolve_${hookId}`, 'hook_resolve', { id: hookId, chapter }, 'pending_hooks.jsonl', '作者手工回收'),
  ])
  if (result.pending.length) fail(400, 'bad_request', result.issues[0]?.message ?? '没能标记回收。')
  return { ok: true, hooks: store.hooks(), stats: store.hookStats() }
})

route('POST', '^/projects/([^/]+)/hooks/([^/]+)/abandon$', (m) => {
  const store = getStore(m[1])
  const hookId = decodeURIComponent(m[2])
  if (store.hook(hookId) === null) fail(404, 'not_found', `没有这条伏笔：${hookId}`)
  new TruthWriter(store).commit([
    manualProposal(`manual_abandon_${hookId}`, 'hook_abandon', { id: hookId }, 'pending_hooks.jsonl', '作者决定弃用'),
  ])
  return { ok: true, hooks: store.hooks(), stats: store.hookStats() }
})

function worldPayload(store: ProjectStore): Record<string, unknown> {
  const doc = store.world()
  const categories: string[] = []
  for (const r of doc.rules) if (!categories.includes(r.category)) categories.push(r.category)
  return {
    rules: doc.rules,
    categories: ['全部', ...categories],
    stats: {
      total: doc.rules.length,
      hard: doc.rules.filter((r) => r.kind === 'hard').length,
      soft: doc.rules.filter((r) => r.kind === 'soft').length,
      conflict: doc.rules.filter((r) => r.status === 'conflict').length,
      unused: doc.rules.filter((r) => r.status === 'unused').length,
    },
    updatedAt: doc.updated_at,
    markdown: renderWorldMd(store),
  }
}

route('GET', '^/projects/([^/]+)/world$', (m) => worldPayload(getStore(m[1])))

route('POST', '^/projects/([^/]+)/world/([^/]+)/kind$', (m, _q, body) => {
  const store = getStore(m[1])
  const ruleId = decodeURIComponent(m[2])
  const kind = String(pick(body, 'kind') ?? '')
  if (!['hard', 'soft'].includes(kind)) fail(400, 'bad_request', '只能改为硬约束或软设定。')
  if (!store.world().rules.some((r) => r.id === ruleId)) fail(404, 'not_found', `没有这条设定：${ruleId}`)
  new TruthWriter(store).commit([
    manualProposal(`manual_kind_${ruleId}`, 'world_update', { id: ruleId, changes: { kind } }, 'world.md', '作者调整约束强度'),
  ], { force: true })
  return worldPayload(store)
})

route('POST', '^/projects/([^/]+)/world/([^/]+)/resolve$', (m, _q, body) => {
  const store = getStore(m[1])
  const ruleId = decodeURIComponent(m[2])
  const rule = store.world().rules.find((r) => r.id === ruleId)
  if (!rule) fail(404, 'not_found', `没有这条设定：${ruleId}`)
  const resolution = String(pick(body, 'resolution') ?? '')
  if (!['keep_text', 'keep_rule'].includes(resolution)) {
    fail(400, 'bad_request', '裁定只能是「保留正文改写规则」或「按规则修改正文」。')
  }
  const note = String(pick(body, 'note') ?? '')
  const changes: Record<string, unknown> = { status: 'ok' }
  if (resolution === 'keep_text') {
    changes.kind = 'soft'
    changes.note = note || '已按正文反推改为软设定'
  } else {
    changes.note = note || '已确认按规则执行，正文待修订'
  }
  new TruthWriter(store).commit([
    manualProposal(`manual_resolve_${ruleId}`, 'world_update', { id: ruleId, changes }, 'world.md', '作者裁定冲突'),
  ], { force: true })
  return { ...worldPayload(store), resolution }
})

// ---------------- 文风 ----------------

route('GET', '^/projects/([^/]+)/style$', (m) => {
  const store = getStore(m[1])
  return { profile: store.style(), presets: presets(), sources: styleSources(store) }
})

route('POST', '^/projects/([^/]+)/style/analyze$', async (m, _q, body) => {
  const store = getStore(m[1])
  const meter = makeMeter(store)
  let sample = String(pick(body, 'sample') ?? '').trim()
  const sourceIds = pick<string[]>(body, 'sourceIds', 'source_ids') ?? []
  let label = '粘贴的参考样本'

  if (!sample && sourceIds.includes('src_book')) {
    const frm = Number(pick(body, 'fromChapter', 'from_chapter') ?? 1)
    const to = Number(pick(body, 'toChapter', 'to_chapter') ?? 1_000_000)
    const chunks: string[] = []
    for (const item of store.chaptersOverview()) {
      const n = item.n as number
      if (['done', 'revise', 'audit'].includes(item.status as string) && frm <= n && n <= to) {
        chunks.push(store.chapterText(n))
      }
    }
    sample = chunks.join('\n\n')
    label = `从本书已定稿章节提取（第 ${frm}–${to < 1_000_000 ? to : '当前'} 章）`
  }
  if (!sample.trim()) fail(400, 'bad_request', '没有可用于提取的文本：请粘贴样本，或先定稿一些章节。')

  setScope({ chapter: 0, step: 'style' })
  meter.checkBudget()
  let { profile, tokens } = await analyzeStyle(sample, label)
  if (pick<boolean>(body, 'merge') || sourceIds.includes('src_merge')) {
    profile = mergeProfile(store.style(), profile)
  }
  const d = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  profile.analyzed_at = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  profile.tokens = tokens
  store.saveStyle(profile)
  return { ok: true, profile: store.style(), sources: styleSources(store), tokens }
})

route('POST', '^/projects/([^/]+)/style/apply$', (m, _q, body) => {
  const store = getStore(m[1])
  const presetId = String(pick(body, 'presetId', 'preset_id') ?? '')
  const profile = presetProfile(presetId)
  if (profile === null) fail(404, 'not_found', `没有这个文风预设：${presetId}`)
  store.saveStyle(profile)
  return { ok: true, profile: store.style(), presets: presets() }
})

route('POST', '^/projects/([^/]+)/style/banned$', (m, _q, body) => {
  const store = getStore(m[1])
  const profile = store.style()
  const expr = String(pick(body, 'expr') ?? '').trim()
  if (expr && !profile.banned_expressions.includes(expr)) {
    profile.banned_expressions.push(expr)
    store.saveStyle(profile)
  }
  return { ok: true, banned: profile.banned_expressions }
})

route('DELETE', '^/projects/([^/]+)/style/banned$', (m, q) => {
  const store = getStore(m[1])
  const profile = store.style()
  const expr = q.get('expr') ?? ''
  profile.banned_expressions = profile.banned_expressions.filter((x) => x !== expr)
  store.saveStyle(profile)
  return { ok: true, banned: profile.banned_expressions }
})

route('GET', '^/projects/([^/]+)/usage$', (m) => new Meter(getStore(m[1])).public(30))

// ---------------- 生产 / 干预 ----------------

route('GET', '^/projects/([^/]+)/run/state$', (m, q) => {
  const store = getStore(m[1])
  const cp = new CheckpointManager(store)
  const chapter = q.get('chapter') != null ? Number(q.get('chapter')) : null
  const overview = store.chaptersOverview()
  return {
    resume: cp.diagnose(chapter).public(),
    progress: overview
      .filter((c) => !['todo', 'planned'].includes(c.status as string))
      .map((c) => cp.progress(c.n as number)),
    budget: new Meter(store).budget(),
    hooks: store.hookStats(),
    steering: store.steeringDirectives(),
    recentCheckpoints: [...store.checkpoints().slice(-10)].reverse(),
  }
})

route('POST', '^/projects/([^/]+)/steer$', async (m, _q, body) => {
  const store = getStore(m[1])
  const text = String(pick(body, 'text') ?? '').trim()
  if (!text) fail(400, 'bad_request', '干预内容不能为空。')
  const confirm = Boolean(pick(body, 'confirm'))
  const result = await new Steering(store, makeMeter(store)).apply(text, { confirm })
  return result.public()
})

route('POST', '^/projects/([^/]+)/steer/([^/]+)$', (m, _q, body) => {
  const store = getStore(m[1])
  const directiveId = decodeURIComponent(m[2])
  const action = String(pick(body, 'action') ?? 'confirm')
  const steering = new Steering(store, makeMeter(store))
  if (action === 'confirm') return steering.confirmDirective(directiveId)
  if (action === 'dismiss') return steering.dismissDirective(directiveId)
  fail(400, 'bad_request', '只能确认或撤销这条干预指令。')
})

route('GET', '^/projects/([^/]+)/tools/search$', (m, q) => {
  const store = getStore(m[1])
  const query = (q.get('q') ?? '').trim()
  const k = Number(q.get('k') ?? 5)
  if (!query) return { query: '', hits: [], provider: 'builtin', note: '输入关键词后开始检索。' }
  const hits = new MemoryIndex(store).search(query, { k })
  return {
    query, hits, provider: 'builtin',
    note: `外部工具不可用时，全流程自动回落内置检索；本次在 ${hits.length} 处找到「${query}」。`,
  }
})

// ---------------- 拆书 ----------------

route('GET', '^/projects/([^/]+)/disassemble$', (m) => {
  const saved = loadDisassemble(getStore(m[1]))
  if (saved === null) {
    return { source: null, stages: [], stats: {}, extracted: {}, proposals: [], message: '还没有拆过书。' }
  }
  return saved
})

route('POST', '^/projects/([^/]+)/disassemble$', async (m, _q, body) => {
  const store = getStore(m[1])
  const filename = String(pick(body, 'filename') ?? '未命名.txt')
  const text = String(pick(body, 'text') ?? '')
  if (text.length < 200) fail(400, 'bad_request', '文本太短了，请换一个更完整的作品。')
  const sampleRatio = Number(pick(body, 'sampleRatio', 'sample_ratio') ?? 1)
  const worker = new Disassembler(store, makeMeter(store))
  return (await worker.run({ filename, text, sampleRatio })).public()
})

route('POST', '^/projects/([^/]+)/disassemble/proposals/([^/]+)/decision$', async (m, _q, body) => {
  const store = getStore(m[1])
  const pid = decodeURIComponent(m[2])
  const action = pick<string | null>(body, 'action')
  if (!['accept', 'reject', null, undefined].includes(action ?? null)) {
    fail(400, 'bad_request', '决策只能取 accept / reject / 撤回。')
  }
  const worker = new Disassembler(store, makeMeter(store))
  return worker.decide(pid, action ?? 'null')
})

// ---------------- 知识库 ----------------

route('GET', '^/projects/([^/]+)/knowledge$', (m) => indexOf(getStore(m[1])))

route('GET', '^/projects/([^/]+)/knowledge/search$', (m, q) => {
  const store = getStore(m[1])
  const query = (q.get('q') ?? '').trim()
  const k = Number(q.get('k') ?? 8)
  if (!query) return { query: '', hits: [], note: '输入关键词后，会在全库范围里找。' }
  const index = new MemoryIndex(store)
  const hits = index.search(query, { k })
  return { query, hits, note: `在 ${hits.length} 处找到「${query}」；结果按相关度排序。` }
})

route('GET', '^/projects/([^/]+)/knowledge/graph$', (m, q) => graphOf(getStore(m[1]), q.get('scope') ?? 'core'))

route('GET', '^/projects/([^/]+)/knowledge/entity/([^/]+)/([^/]+)$', (m) => {
  const kind = decodeURIComponent(m[2])
  const entityId = decodeURIComponent(m[3])
  if (!(kind in KIND_LABEL)) fail(400, 'bad_request', `不认识的类型：${kind}`)
  const detail = entityDetail(getStore(m[1]), kind, entityId)
  if (detail === null) fail(404, 'not_found', `知识库里没有这个${kind}：${entityId}`)
  return detail
})

// ---------------- 设置 ----------------

const BUDGET_SPLIT = [
  { label: '系统规则', pct: 5 }, { label: '角色/世界观', pct: 15 },
  { label: '动态事实', pct: 10 }, { label: '历史摘要', pct: 20 },
  { label: '当前草稿', pct: 30 }, { label: '输出预留', pct: 20 },
]

function providersPayload(): Record<string, unknown> {
  const usable = configuredProviders()
  return {
    providers: [...PROVIDERS]
      .sort((a, b) => a.priority - b.priority)
      .map((p) => providerPublic(p, probeSnapshot(p.name))),
    roles: ROLES.map(rolePublic),
    fallbackChain: usable.map((p) => p.name),
    configured: usable.length > 0,
    envHint:
      '密钥只保存在本机（手机本地存储），接口只回显脱敏指纹。' +
      '至少配置一个密钥才能产出内容；填好后立即生效。',
    budgetSplit: BUDGET_SPLIT,
  }
}

route('GET', '^/settings/providers$', () => providersPayload())

route('PUT', '^/settings/providers/([^/]+)$', (m, _q, body) => {
  const name = decodeURIComponent(m[1])
  const target = PROVIDERS.find((p) => p.name === name)
  if (!target) fail(404, 'not_found', `没有这个服务商：${name}`)
  const enabled = pick<boolean>(body, 'enabled')
  const priority = pick<number>(body, 'priority')
  const apiKey = pick<string>(body, 'apiKey', 'api_key')
  if (enabled !== undefined) target.enabled = Boolean(enabled)
  if (priority !== undefined) target.priority = Math.max(1, Number(priority))
  if (apiKey !== undefined) saveApiKey(name, String(apiKey).trim() || null)
  saveProvidersStore()
  return { ok: true, providers: providersPayload().providers }
})

route('POST', '^/settings/providers/([^/]+)/probe$', async (m) => {
  const name = decodeURIComponent(m[1])
  const provider = PROVIDERS.find((p) => p.name === name)
  if (!provider) fail(404, 'not_found', `没有这个服务商：${name}`)
  if (!getApiKey(name)) fail(503, 'not_configured', `「${name}」还没有填密钥。请到「设置 · 服务商」填写后重试。`)
  const result = await probe(name)
  return { ok: result.ok, probe: result, fingerprint: fingerprint(name) }
})

route('PUT', '^/settings/roles/([^/]+)$', (m, _q, body) => {
  const key = decodeURIComponent(m[1])
  const role = roleFor(key)
  if (!role) fail(404, 'not_found', `没有这个环节：${key}`)

  const providerRaw = pick<string>(body, 'provider')
  if (providerRaw !== undefined) role.provider = String(providerRaw).trim() || null
  const modelRaw = pick<string>(body, 'model')
  if (modelRaw !== undefined) {
    const modelName = String(modelRaw).trim()
    if (!modelName) fail(400, 'bad_request', '模型名不能为空。')
    role.model = modelName
  }
  const temperature = pick<number>(body, 'temperature')
  if (temperature !== undefined) role.temperature = Math.min(2, Math.max(0, Number(temperature)))

  // 能力校验：只在该模型能在目录里找到时做；找不到就放行并提醒
  const owner = role.provider
    ? providerByName(role.provider)
    : PROVIDERS.find((p) => p.models.some((mm) => mm.name === role.model)) ?? null
  let note: string | null = null
  if (owner) {
    const spec = owner.models.find((mm) => mm.name === role.model) ?? null
    if (!spec) {
      note = `「${owner.name}」的模型清单里没有 ${role.model}，将按默认能力尝试；若调用报错请核对模型名。`
    } else {
      const needs: [boolean, string] =
        role.fmt === 'text' ? [spec.supports_stream, '流式输出']
        : [spec.supports_json, '结构化输出']
      if (!needs[0]) {
        fail(400, 'bad_request', `${role.label}需要「${needs[1]}」，而 ${owner.name} / ${role.model} 不支持。换一个模型，或先调整该环节的输出格式。`)
      }
    }
  }
  saveRolesStore()
  return {
    ok: true,
    note,
    roles: ROLES.map(rolePublic),
    fallbackChain: configuredProviders().map((p) => p.name),
  }
})

route('GET', '^/settings/mcp$', () => mcpPayload())

function mcpPayload(): Record<string, unknown> {
  const servers = readMcp()
  return {
    servers,
    enabledCount: servers.filter((s) => s.enabled).length,
    healthyCount: servers.filter((s) => s.enabled && s.status === 'ok').length,
    note: '外部工具不可用时，全流程会自动回落到内置检索，不会阻塞写作。',
  }
}

route('POST', '^/settings/mcp/toggle$', (_m, _q, body) => {
  const name = String(pick(body, 'name') ?? '')
  const servers = readMcp()
  const server = servers.find((s) => s.name === name) ?? null
  if (!server) fail(404, 'not_found', `没有这个外部工具：${name}`)
  server.enabled = !server.enabled
  writeMcp(servers)
  return { ok: true, server, servers }
})

route('POST', '^/settings/mcp/([^/]+)/test$', (m) => {
  const name = decodeURIComponent(m[1])
  const servers = readMcp()
  const server = servers.find((s) => s.name === name) ?? null
  if (!server) fail(404, 'not_found', `没有这个外部工具：${name}`)
  server.status = 'failed'
  server.error = '手机端未接入外部工具运行时'
  writeMcp(servers)
  return {
    ok: false,
    result: { ok: false, message: '手机端未接入外部工具运行时，已自动回落内置检索。' },
    servers,
  }
})

route('PUT', '^/settings/mcp$', (_m, _q, body) => {
  const incoming = pick<Array<Record<string, unknown>>>(body, 'servers') ?? []
  const known = new Map(readMcp().map((s) => [s.name, s]))
  const seen = new Set<string>()
  const next: McpServerState[] = []
  for (const item of incoming) {
    const name = String(item.name ?? '').trim()
    if (!name) continue
    if (seen.has(name)) fail(400, 'bad_request', `外部工具重名了：${name}`)
    seen.add(name)
    const transport = String(item.transport ?? 'stdio').trim().toLowerCase()
    if (!['stdio', 'http'].includes(transport)) fail(400, 'bad_request', `「${name}」的连接方式只能是 stdio 或 http。`)
    const command = String(item.command ?? '').trim()
    const url = String(item.url ?? '').trim()
    if (transport === 'stdio' && !command) fail(400, 'bad_request', `「${name}」用的是 stdio，必须填启动命令。`)
    if (transport === 'http' && !url.startsWith('http')) fail(400, 'bad_request', `「${name}」用的是 http，地址要以 http:// 或 https:// 开头。`)
    const old = known.get(name)
    next.push({
      name, transport,
      command: transport === 'stdio' ? command : '',
      url: transport === 'http' ? url : '',
      tools: (Array.isArray(item.tools) ? item.tools : []).map((t) => String(t).trim()).filter(Boolean),
      enabled: Boolean(item.enabled),
      status: old?.status ?? 'idle',
      latency: old?.latency ?? null,
      calls: old?.calls ?? 0,
      error: old?.error ?? null,
    })
  }
  writeMcp(next)
  return {
    ok: true,
    servers: next,
    enabledCount: next.filter((s) => s.enabled).length,
    healthyCount: next.filter((s) => s.enabled && s.status === 'ok').length,
  }
})

// ---------------- 健康 ----------------

route('GET', '^/health$', () => {
  const usable = configuredProviders()
  const names = usable.map((p) => p.name)
  return {
    ok: true,
    version: '0.1.0-app',
    dataDir: '手机本地存储（localStorage）',
    projects: listStores().length,
    providers: {
      usable: names,
      configured: names.length > 0,
      message: names.length
        ? `已配置：${names.join('、')}`
        : '尚未配置任何模型密钥，生成类接口会返回 503。请到「设置 · 服务商」填写。',
    },
  }
})

// ==========================================================================
// 入口
// ==========================================================================

/** 手动提案（作者在界面上的显式操作，置信度固定 high，镜像 routes/truth.py 的构造）。 */
function manualProposal(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  targetFile: string,
  reason: string,
): Proposal {
  return proposal(kind, payload, { id, reason, confidence: 'high', targetFile })
}

function normalizePath(path: string): { pathname: string; query: URLSearchParams } {
  const idx = path.indexOf('/api')
  const rest = idx === 0 ? path.slice(4) : path
  const qIdx = rest.indexOf('?')
  const pathname = qIdx >= 0 ? rest.slice(0, qIdx) : rest
  const query = new URLSearchParams(qIdx >= 0 ? rest.slice(qIdx + 1) : '')
  return { pathname: pathname || '/', query }
}

function parseBody(init?: RequestInit): Body {
  const raw = init?.body
  if (raw == null) return {}
  if (typeof raw === 'string') {
    if (!raw.trim()) return {}
    try {
      return asBody(JSON.parse(raw))
    } catch {
      return {}
    }
  }
  return {}
}

/** 分发一个非流式请求。返回已转 camelCase 的响应体。 */
export async function localRequest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const { pathname, query } = normalizePath(path)
  const body = parseBody(init)
  try {
    for (const r of ROUTES) {
      if (r.method !== method) continue
      const m = r.re.exec(pathname)
      if (!m) continue
      return toApi(await r.handler(m, query, body)) as T
    }
    fail(404, 'not_found', `本地核心没有这个接口：${method} ${pathname}`)
  } catch (e) {
    throw mapError(e)
  }
}

// ==========================================================================
// 流式（章节生成 / 整本生产）
// ==========================================================================

export interface LocalStreamEvent {
  event: string
  data: string
}

export interface LocalStreamHandle {
  abort(): void
}

/** 流式接口：路径决定跑「单章生成」还是「整本生产」；事件以 JSON 字符串回传。 */
export function localStreamSSE(
  path: string,
  body: unknown,
  onEvent: (ev: LocalStreamEvent) => void,
): LocalStreamHandle {
  const { pathname } = normalizePath(path)
  const payload = asBody(body)
  const stopped = { value: false }
  const shouldStop = () => stopped.value

  const emit = (item: Record<string, unknown>): void => {
    const event = String(item.type ?? 'message')
    onEvent({ event, data: JSON.stringify(toApi(item)) })
  }

  const run = async (): Promise<void> => {
    const gen = /^\/projects\/([^/]+)\/chapters\/(\d+)\/generate$/.exec(pathname)
    const runAll = /^\/projects\/([^/]+)\/run$/.exec(pathname)
    if (gen) {
      const store = getStore(decodeURIComponent(gen[1]))
      const n = Number(gen[2])
      const meter = makeMeter(store)
      try {
        meter.checkBudget()
      } catch (e) {
        throw mapError(e)
      }
      const pipeline = new Pipeline(store, meter)
      await pipeline.run(n, {
        steps: ['plan', 'context', 'draft'],
        onEvent: emit,
        shouldStop,
        respectPolicy: false,
      })
      return
    }
    if (runAll) {
      const store = getStore(decodeURIComponent(runAll[1]))
      const meter = makeMeter(store)
      try {
        meter.checkBudget()
      } catch (e) {
        throw mapError(e)
      }
      const runner = new BookRunner(store, meter)
      await runner.run({
        maxChapters: Number(pick(payload, 'maxChapters', 'max_chapters') ?? 20),
        fromChapter: pick<number | null>(payload, 'fromChapter', 'from_chapter') ?? null,
        onEvent: emit,
        shouldStop,
      })
      return
    }
    fail(404, 'not_found', `本地核心没有这个流式接口：${pathname}`)
  }

  run().catch((e: unknown) => {
    const err = mapError(e)
    onEvent({ event: 'error', data: JSON.stringify({ code: err.code, message: err.message }) })
  })

  return { abort: () => { stopped.value = true } }
}
