/**
 * 项目存储 —— 镜像 `server/dobi/core/store.py` 的 ProjectStore。
 *
 * 每个项目一条 `ProjectRecord`，内存里保持单一引用，写操作后同步落盘（flush）。
 * 对外返回结构与原后端逐字一致。
 */

import * as storage from './storage'
import type {
  AuditReport,
  ChapterFile,
  ChapterStatus,
  ChapterSummary,
  Character,
  Checkpoint,
  CurrentState,
  Hook,
  OutlineGraph,
  ProjectMeta,
  ProjectRecord,
  ReviewReport,
  SteeringDirective,
  StyleProfile,
  Subplot,
  UsageEntry,
  WorldDoc,
  WorldRule,
} from './types'
import { newProjectRecord, newWorld, newCurrentState, newOutlineGraph, newStyleProfile } from './types'
import { countWords, nowIso, slugify, shortId } from './util'

export class NotFoundError extends Error {
  readonly code = 'not_found'
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends Error {
  readonly code = 'conflict'
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

export class BadRequestError extends Error {
  readonly code = 'bad_request'
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

export class NotConfiguredError extends Error {
  readonly code = 'not_configured'
  constructor(message: string) {
    super(message)
    this.name = 'NotConfiguredError'
  }
}

export class BudgetExceededError extends Error {
  readonly code = 'budget_exceeded'
  readonly detail: unknown
  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = 'BudgetExceededError'
    this.detail = detail
  }
}

export class ProjectStore {
  readonly id: string
  record: ProjectRecord

  constructor(id: string) {
    this.id = id
    this.record = storage.readProject(id) ?? newProjectRecord(id)
  }

  /** 内存态 + 落盘一次（新建项目时用） */
  static create(
    id: string,
    over: {
      title: string
      genre?: string
      premise?: string
      logline?: string
      mode?: string
      budget_total?: number | null
      chapters_total?: number
    } = { title: '' },
  ): ProjectStore {
    const ts = nowIso()
    const store = new ProjectStore(id)
    store.record = newProjectRecord(id, {
      id,
      title: over.title || '未命名作品',
      genre: over.genre || '待定',
      premise: over.premise ?? '',
      logline: over.logline ?? (over.premise ?? ''),
      mode: (over.mode as 'auto' | 'semi-auto' | 'manual') ?? 'semi-auto',
      budget_total: over.budget_total ?? 80.0,
      chapters_total: over.chapters_total ?? 0,
      created_at: ts,
      updated_at: ts,
    })
    store.flush()
    return store
  }

  flush(): void {
    storage.writeProject(this.record)
  }

  delete(): void {
    storage.deleteProject(this.id)
  }

  get exists(): boolean {
    return storage.readProject(this.id) !== null
  }

  // ---------------- meta ----------------

  meta(): ProjectMeta {
    return this.record.meta
  }

  saveMeta(meta: ProjectMeta): void {
    meta.updated_at = nowIso()
    this.record.meta = meta
    this.flush()
  }

  touchMeta(changes: Partial<ProjectMeta>): ProjectMeta {
    this.record.meta = { ...this.record.meta, ...changes, updated_at: nowIso() }
    this.flush()
    return this.record.meta
  }

  // ---------------- characters ----------------

  characters(): Character[] {
    return this.record.characters
  }

  saveCharacters(items: Character[]): void {
    this.record.characters = items
    this.flush()
  }

  character(key: string): Character | null {
    return (
      this.record.characters.find((c) => c.id === key || c.name === key || c.aliases.includes(key)) ?? null
    )
  }

  nextCharacterId(): string {
    const used = new Set(
      this.record.characters
        .map((c) => /^char_(\d+)$/.exec(c.id)?.[1])
        .filter(Boolean)
        .map(Number),
    )
    const next = used.size ? Math.max(...used) + 1 : 1
    return `char_${String(next).padStart(3, '0')}`
  }

  // ---------------- hooks ----------------

  hooks(): Hook[] {
    return this.record.hooks
  }

  saveHooks(items: Hook[]): void {
    this.record.hooks = items
    this.flush()
  }

  hook(hookId: string): Hook | null {
    return this.record.hooks.find((h) => h.id === hookId) ?? null
  }

  nextHookId(): string {
    const used = new Set(
      this.record.hooks
        .map((h) => /^hook_(\d+)$/.exec(h.id)?.[1])
        .filter(Boolean)
        .map(Number),
    )
    const next = used.size ? Math.max(...used) + 1 : 1
    return `hook_${String(next).padStart(3, '0')}`
  }

  hookStats(currentChapter?: number | null): Record<string, number> {
    const hooks = this.record.hooks
    const cur =
      currentChapter ?? hooks.reduce((m, h) => Math.max(m, h.planted_chapter), 0)
    const total = hooks.length
    const planted = hooks.filter((h) => h.status === 'planted').length
    const resolved = hooks.filter((h) => h.status === 'resolved').length
    const abandoned = hooks.filter((h) => h.status === 'abandoned').length
    const overdue = hooks.filter(
      (h) => h.status === 'planted' && h.suggested_resolve_by != null && cur > (h.suggested_resolve_by ?? 0),
    ).length
    return {
      total, planted, resolved, abandoned, overdue,
      rate: total ? Math.round((resolved / total) * 100) : 0,
    }
  }

  // ---------------- 世界观 ----------------

  world(): WorldDoc {
    return this.record.world
  }

  saveWorld(doc: WorldDoc): void {
    doc.updated_at = nowIso()
    this.record.world = doc
    this.flush()
  }

  hardRules(): WorldRule[] {
    return this.record.world.rules.filter((r) => r.kind === 'hard')
  }

  // ---------------- 当前状态 ----------------

  state(): CurrentState {
    return this.record.state
  }

  saveState(state: CurrentState): void {
    state.updated_at = nowIso()
    this.record.state = state
    this.flush()
  }

  // ---------------- 支线 ----------------

  subplots(): Subplot[] {
    return this.record.subplots
  }

  saveSubplots(items: Subplot[]): void {
    this.record.subplots = items
    this.flush()
  }

  // ---------------- 大纲 ----------------

  outlineGraph(): OutlineGraph {
    return this.record.outline_graph
  }

  saveOutlineGraph(graph: OutlineGraph): void {
    graph.updated_at = nowIso()
    this.record.outline_graph = graph
    this.flush()
  }

  // ---------------- 章节摘要 ----------------

  summaries(): ChapterSummary[] {
    return this.record.summaries
  }

  summary(chapter: number): ChapterSummary | null {
    return this.record.summaries.find((s) => s.chapter === chapter) ?? null
  }

  upsertSummary(summary: ChapterSummary): void {
    const items = this.record.summaries.filter((s) => s.chapter !== summary.chapter)
    items.push(summary)
    items.sort((a, b) => a.chapter - b.chapter)
    this.record.summaries = items
    this.flush()
  }

  // ---------------- 正文 ----------------

  readChapter(n: number): ChapterFile {
    const key = String(n)
    const found = this.record.chapters[key]
    if (found) return found
    return { chapter: n, title: '', status: 'todo', words: 0, pov: '', updated: '', paragraphs: [] }
  }

  chapterText(n: number): string {
    return this.readChapter(n).paragraphs.join('\n\n')
  }

  writeChapter(
    n: number,
    paragraphs: string[],
    opts: { title?: string; status?: ChapterStatus; pov?: string } = {},
  ): ChapterFile {
    const body = paragraphs.map((p) => p.trim()).filter(Boolean).join('\n\n')
    const words = countWords(body)
    const data: ChapterFile = {
      chapter: n,
      title: opts.title ?? '',
      status: opts.status ?? 'draft',
      words,
      pov: opts.pov ?? '',
      updated: nowIso(),
      paragraphs,
    }
    this.record.chapters[String(n)] = data
    this.flush()
    return data
  }

  updateChapterStatus(n: number, status: ChapterStatus, extra: Partial<ChapterFile> = {}): ChapterFile {
    const data = this.readChapter(n)
    return this.writeChapter(n, data.paragraphs, {
      title: extra.title ?? data.title,
      status,
      pov: extra.pov ?? data.pov,
    })
  }

  chapterNumbers(): number[] {
    return Object.keys(this.record.chapters)
      .map(Number)
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b)
  }

  // ---------------- 审计 / 评审 ----------------

  readAudit(n: number): AuditReport | null {
    return this.record.audits[String(n)] ?? null
  }

  saveAudit(report: AuditReport): void {
    report.generated_at = nowIso()
    this.record.audits[String(report.chapter)] = report
    this.flush()
  }

  readReview(n: number): ReviewReport | null {
    return this.record.reviews[String(n)] ?? null
  }

  saveReview(report: ReviewReport): void {
    report.generated_at = nowIso()
    this.record.reviews[String(report.chapter)] = report
    this.flush()
  }

  // ---------------- 文风 ----------------

  style(): StyleProfile {
    return this.record.style
  }

  saveStyle(profile: StyleProfile): void {
    this.record.style = profile
    this.flush()
  }

  // ---------------- checkpoint ----------------

  checkpoints(chapter?: number): Checkpoint[] {
    const rows = this.record.checkpoints.filter((c) => chapter == null || c.chapter === chapter)
    rows.sort((a, b) => (a.chapter - b.chapter) || (a.timestamp < b.timestamp ? -1 : 1))
    return rows
  }

  saveCheckpoint(cp: Checkpoint): void {
    const rows = this.record.checkpoints.filter(
      (c) => !(c.chapter === cp.chapter && c.step === cp.step && c.attempt === cp.attempt),
    )
    rows.push(cp)
    this.record.checkpoints = rows
    this.flush()
  }

  latestCheckpoint(chapter?: number): Checkpoint | null {
    const rows = this.checkpoints(chapter)
    return rows.length ? rows[rows.length - 1] : null
  }

  // ---------------- 实时干预 ----------------

  steeringDirectives(opts: { chapter?: number | null; includeResolved?: boolean } = {}): SteeringDirective[] {
    const { chapter, includeResolved = false } = opts
    return this.record.steering.filter((d) => {
      if (!includeResolved && d.resolved) return false
      if (chapter != null && d.target_chapter != null && d.target_chapter > chapter) return false
      return true
    })
  }

  appendSteering(directive: Partial<SteeringDirective>): SteeringDirective {
    const rows = this.record.steering
    const item: SteeringDirective = {
      id: directive.id ?? `steer_${String(rows.length + 1).padStart(3, '0')}`,
      text: directive.text ?? '',
      intent: directive.intent ?? {},
      scope: directive.scope ?? 'current',
      target_chapter: directive.target_chapter ?? null,
      affected_chapters: directive.affected_chapters ?? [],
      applied: directive.applied ?? false,
      pending_confirmation: directive.pending_confirmation ?? false,
      resolved: directive.resolved ?? false,
      created_at: directive.created_at ?? nowIso(),
      resolved_at: directive.resolved_at ?? null,
    }
    rows.push(item)
    this.record.steering = rows
    this.flush()
    return item
  }

  resolveSteering(ids: string[]): number {
    const wanted = new Set(ids)
    let hit = 0
    this.record.steering = this.record.steering.map((d) => {
      if (wanted.has(d.id)) {
        hit += 1
        return { ...d, resolved: true, resolved_at: nowIso() }
      }
      return d
    })
    if (hit) this.flush()
    return hit
  }

  // ---------------- 派生概览 ----------------

  chaptersOverview(): Array<Record<string, unknown>> {
    const graph = this.outlineGraph()
    const nodes = new Map(graph.nodes.map((n) => [n.chapter, n]))
    const numbers = new Set<number>([
      ...nodes.keys(),
      ...this.chapterNumbers(),
      ...this.summaries().map((s) => s.chapter),
    ])
    const out: Array<Record<string, unknown>> = []
    for (const n of [...numbers].sort((a, b) => a - b)) {
      const node = nodes.get(n)
      const data = this.readChapter(n)
      const summary = this.summary(n)
      let status = data.status
      if (status === 'todo' && node && (node.status === 'planned' || node.status === 'skeleton')) {
        status = 'planned'
      }
      out.push({
        n,
        title: data.title || node?.title || summary?.title || '',
        status,
        words: data.words,
        pov: data.pov || node?.pov || '',
        volume: node?.volume || '',
        arc: node?.arc || '',
        intensity: node?.intensity ?? 3,
        updated: data.updated ? data.updated.slice(0, 10) : '—',
        summary: summary?.summary || node?.goal || '',
      })
    }
    return out
  }

  projectSummary(budgetUsed?: number | null): Record<string, unknown> {
    const meta = this.meta()
    const overview = this.chaptersOverview()
    const words = overview.reduce((s, c) => s + (c.words as number), 0)
    const done = overview.filter((c) => c.status === 'done').length
    const stats = this.hookStats()
    const audits = overview
      .filter((c) => ['audit', 'revise', 'done'].includes(c.status as string))
      .map((c) => this.readAudit(c.n as number))
      .filter(Boolean) as AuditReport[]
    let passRate = 0
    if (audits.length) {
      const clean = audits.filter(
        (a) => !a.items.some((i) => i.severity === 'blocker' || i.severity === 'major'),
      ).length
      passRate = Math.round((clean / audits.length) * 100)
    }
    const total = Math.max(meta.chapters_total, overview.length)
    return {
      id: this.id,
      title: meta.title,
      genre: meta.genre,
      logline: meta.logline || meta.premise,
      mode: meta.mode,
      chaptersDone: done,
      chaptersTotal: total,
      words: words || meta.words,
      budgetUsed: Math.round((budgetUsed ?? meta.budget_used) * 100) / 100,
      budgetTotal: Math.round(meta.budget_total * 100) / 100,
      updatedAt: meta.updated_at.replace('T', ' ').slice(0, 16),
      hooksResolved: stats.resolved,
      hooksTotal: stats.total,
      auditPass: passRate,
    }
  }

  usageEntries(): UsageEntry[] {
    return this.record.usage
  }

  appendUsage(entry: UsageEntry): void {
    this.record.usage.push(entry)
    // 同步 meta 缓存（口径：usage 流水为准）
    const used = this.record.usage.reduce((s, e) => s + e.cost, 0)
    const words = this.chaptersOverview().reduce((s, c) => s + (c.words as number), 0)
    this.record.meta = {
      ...this.record.meta,
      budget_used: Math.round(used * 10000) / 10000,
      words,
      updated_at: nowIso(),
    }
    this.flush()
  }
}

// ==========================================================================
// 项目索引（list_projects / create / delete）
// ==========================================================================

export function listProjectIds(): string[] {
  return storage.readProjectIndex()
}

export function ensureProjectInIndex(id: string): void {
  const ids = listProjectIds()
  if (!ids.includes(id)) {
    ids.push(id)
    storage.writeProjectIndex(ids)
  }
}

export function removeProjectFromIndex(id: string): void {
  storage.writeProjectIndex(listProjectIds().filter((x) => x !== id))
}

export function newProjectId(title: string): string {
  const base = slugify(title, '') || `novel-${shortId(title)}`
  const ids = new Set(listProjectIds())
  let pid = base
  let i = 2
  while (ids.has(pid)) {
    pid = `${base}-${i}`
    i += 1
  }
  return pid
}

// ==========================================================================
// 新建项目时的默认真相（空文档）
// ==========================================================================

export { newWorld, newCurrentState, newOutlineGraph, newStyleProfile }
