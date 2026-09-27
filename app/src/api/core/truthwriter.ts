/**
 * TruthWriter —— 真相文件的唯一写入闸门。镜像 `server/dobi/core/store.py` 的 TruthWriter。
 *
 * 所有对真相数据的修改都走 Proposal → Validate → Commit：
 * - `validate()`：按顺序增量校验（同一批提案内部也互相冲突，如同批新增两个同名角色）
 * - `commit()`：error 级问题默认阻断（降级为 pending，不写入）；`force=true` 表示人工已确认
 * - `_apply()`：把通过的提案落盘到 ProjectStore
 */

import type {
  ChapterSummary,
  Character,
  CommitResult,
  Hook,
  OutlineEdge,
  OutlineGraph,
  OutlineNode,
  ProjectMeta,
  Proposal,
  Subplot,
  StyleProfile,
  ValidationIssue,
  WorldDoc,
  WorldRule,
} from './types'
import { newStyleProfile } from './types'
import type { ProjectStore } from './store'
import { normText, similarity } from './util'

const KIND_TARGET: Record<string, string> = {
  character_add: 'characters.jsonl',
  character_update: 'characters.jsonl',
  hook_add: 'pending_hooks.jsonl',
  hook_resolve: 'pending_hooks.jsonl',
  hook_abandon: 'pending_hooks.jsonl',
  world_add: 'world.md',
  world_update: 'world.md',
  outline_upsert: 'outline_graph.json',
  edge_add: 'outline_graph.json',
  subplot_upsert: 'subplot_board.md',
  summary_upsert: 'chapter_summaries.jsonl',
  style_update: 'style_profile.json',
  fact_add: 'current_state.md',
}

/** 校验上下文：同一批提案内部的增量视图 */
interface ValidateCtx {
  meta: ProjectMeta
  characters: Map<string, Character>
  byName: Map<string, Character>
  hooks: Hook[]
  graph: OutlineGraph
  world: WorldDoc
}

function issue(
  kind: string,
  message: string,
  proposalId: string,
  level: 'error' | 'warning' = 'error',
): ValidationIssue {
  return { level, kind, message, proposal_id: proposalId }
}

/** payload → Character（宽松解析，字段非法时返回 null 由调用方报错） */
function asCharacter(p: Record<string, unknown>): Character | null {
  if (typeof p !== 'object' || p === null) return null
  const name = String(p.name ?? '').trim()
  if (!name) return null
  const id = String(p.id ?? '').trim() || `char_${name}`
  return {
    id,
    name,
    role: String(p.role ?? '配角'),
    lead: Boolean(p.lead),
    immutable_traits: Array.isArray(p.immutable_traits) ? p.immutable_traits.map(String) : [],
    personality: String(p.personality ?? ''),
    speech_style: String(p.speech_style ?? ''),
    relationships: Array.isArray(p.relationships)
      ? p.relationships.map((r) => ({
          target: String((r as Record<string, unknown>).target ?? ''),
          type: String((r as Record<string, unknown>).type ?? ''),
          note: String((r as Record<string, unknown>).note ?? ''),
        }))
      : [],
    state: {
      location: String((p.state as Record<string, unknown> | undefined)?.location ?? '—'),
      status: String((p.state as Record<string, unknown> | undefined)?.status ?? '—'),
      known_secrets: Array.isArray((p.state as Record<string, unknown> | undefined)?.known_secrets)
        ? ((p.state as Record<string, unknown>).known_secrets as unknown[]).map(String)
        : [],
    },
    first_appearance: Number(p.first_appearance ?? 0),
    updated_at_chapter: Number(p.updated_at_chapter ?? 0),
    aliases: Array.isArray(p.aliases) ? p.aliases.map(String) : [],
    deceased: Boolean(p.deceased),
  }
}

function asHook(p: Record<string, unknown>): Hook | null {
  if (typeof p !== 'object' || p === null) return null
  const content = String(p.content ?? '').trim()
  if (!content) return null
  const id = String(p.id ?? '').trim() || `hook_${content.slice(0, 8)}`
  return {
    id,
    content,
    planted_chapter: Number(p.planted_chapter ?? 0),
    status: (['planted', 'resolved', 'abandoned'].includes(String(p.status)) ? p.status : 'planted') as Hook['status'],
    resolved_chapter: p.resolved_chapter == null ? null : Number(p.resolved_chapter),
    importance: p.importance === 'minor' ? 'minor' : 'major',
    linked_characters: Array.isArray(p.linked_characters) ? p.linked_characters.map(String) : [],
    suggested_resolve_by: p.suggested_resolve_by == null ? null : Number(p.suggested_resolve_by),
  }
}

function asWorldRule(p: Record<string, unknown>): WorldRule | null {
  if (typeof p !== 'object' || p === null) return null
  const rule = String(p.rule ?? '').trim()
  if (!rule) return null
  const id = String(p.id ?? '').trim() || `w_${rule.slice(0, 8)}`
  return {
    id,
    category: String(p.category ?? '其他'),
    kind: p.kind === 'soft' ? 'soft' : 'hard',
    rule,
    refs: Array.isArray(p.refs) ? p.refs.map(Number) : [],
    note: String(p.note ?? ''),
    status: ['ok', 'conflict', 'unused'].includes(String(p.status)) ? (p.status as WorldRule['status']) : 'ok',
  }
}

function asOutlineNode(p: Record<string, unknown>): OutlineNode | null {
  if (typeof p !== 'object' || p === null) return null
  const chapter = Number(p.chapter ?? 0)
  if (!chapter) return null
  return {
    chapter,
    title: String(p.title ?? ''),
    arc: String(p.arc ?? ''),
    volume: String(p.volume ?? ''),
    status: ['skeleton', 'planned', 'written', 'audit', 'draft'].includes(String(p.status))
      ? (p.status as OutlineNode['status'])
      : 'planned',
    goal: String(p.goal ?? ''),
    beats: Array.isArray(p.beats) ? p.beats.map(String) : [],
    rationale: String(p.rationale ?? ''),
    pov: String(p.pov ?? ''),
    intensity: Number(p.intensity ?? 3) || 3,
    story_at: String(p.story_at ?? ''),
    timeline: Array.isArray(p.timeline)
      ? p.timeline.map((t) => ({
          at: String((t as Record<string, unknown>).at ?? ''),
          label: String((t as Record<string, unknown>).label ?? ''),
          kind: String((t as Record<string, unknown>).kind ?? ''),
        }))
      : [],
  }
}

function asOutlineEdge(p: Record<string, unknown>): OutlineEdge | null {
  if (typeof p !== 'object' || p === null) return null
  const fromChapter = Number(p.from_chapter ?? 0)
  const toChapter = Number(p.to_chapter ?? 0)
  if (!fromChapter || !toChapter) return null
  return {
    from_chapter: fromChapter,
    to_chapter: toChapter,
    type: (['motivation', 'setup', 'payoff', 'causality', 'parallel'].includes(String(p.type))
      ? p.type
      : 'motivation') as OutlineEdge['type'],
    note: String(p.note ?? ''),
    confirmed: Boolean(p.confirmed),
  }
}

function asSubplot(p: Record<string, unknown>): Subplot | null {
  if (typeof p !== 'object' || p === null) return null
  const name = String(p.name ?? '').trim()
  if (!name) return null
  return {
    id: String(p.id ?? '').trim() || `subplot_${name.slice(0, 8)}`,
    name,
    kind: p.kind === 'main' ? 'main' : 'sub',
    summary: String(p.summary ?? ''),
    color: String(p.color ?? '#888'),
    active: Array.isArray(p.active) ? p.active.map(Number) : [],
    peak: Array.isArray(p.peak) ? p.peak.map(Number) : [],
    status: ['active', 'stalled', 'closed'].includes(String(p.status))
      ? (p.status as Subplot['status'])
      : 'active',
  }
}

function asChapterSummary(p: Record<string, unknown>): ChapterSummary | null {
  if (typeof p !== 'object' || p === null) return null
  const chapter = Number(p.chapter ?? 0)
  if (!chapter) return null
  return {
    chapter,
    title: String(p.title ?? ''),
    summary: String(p.summary ?? ''),
    words: Number(p.words ?? 0),
    pov: String(p.pov ?? ''),
    key_facts: Array.isArray(p.key_facts) ? p.key_facts.map(String) : [],
    characters: Array.isArray(p.characters) ? p.characters.map(String) : [],
    hooks_planted: Array.isArray(p.hooks_planted) ? p.hooks_planted.map(String) : [],
    hooks_resolved: Array.isArray(p.hooks_resolved) ? p.hooks_resolved.map(String) : [],
    updated_at: String(p.updated_at ?? ''),
  }
}

function asStyleProfile(p: Record<string, unknown>): StyleProfile | null {
  if (typeof p !== 'object' || p === null) return null
  if (!String(p.source ?? '').trim() && !Array.isArray(p.preferred_patterns)) return null
  const base = newStyleProfile()
  return {
    ...base,
    ...(p as Partial<StyleProfile>),
    sentence: { ...base.sentence, ...((p.sentence as Partial<StyleProfile['sentence']>) ?? {}) },
    narrative: { ...base.narrative, ...((p.narrative as Partial<StyleProfile['narrative']>) ?? {}) },
  }
}

/** 把 payload 的 changes 应用到现有记录（state 为深合并，其余直接覆盖） */
function applyChanges<T extends Record<string, unknown>>(base: T, changes: Record<string, unknown>): T {
  const out = { ...base }
  for (const [k, v] of Object.entries(changes ?? {})) {
    if (k === 'state' && typeof v === 'object' && v !== null) {
      out[k as keyof T] = { ...((base as Record<string, unknown>)[k] as Record<string, unknown>), ...v } as T[keyof T]
    } else {
      ;(out as Record<string, unknown>)[k] = v
    }
  }
  return out
}

// ==========================================================================
// TruthWriter
// ==========================================================================

export class TruthWriter {
  readonly store: ProjectStore

  constructor(store: ProjectStore) {
    this.store = store
  }

  // ---------------- 校验 ----------------

  validate(proposals: Proposal[]): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    const ctx = this._ctx()
    for (const p of proposals) {
      if (!KIND_TARGET[p.kind]) {
        issues.push(issue('未知提案类型', `不认识的提案类型：${p.kind}`, p.id))
        continue
      }
      const handler = this._handler(p.kind)
      if (handler) issues.push(...handler(p, ctx))
      this._register(p, ctx)
    }
    return issues
  }

  private _ctx(): ValidateCtx {
    const chars = this.store.characters()
    return {
      meta: this.store.meta(),
      characters: new Map(chars.map((c) => [c.id, c])),
      byName: new Map(chars.map((c) => [c.name, c])),
      hooks: this.store.hooks(),
      graph: this.store.outlineGraph(),
      world: this.store.world(),
    }
  }

  private _handler(kind: string): ((p: Proposal, ctx: ValidateCtx) => ValidationIssue[]) | null {
    switch (kind) {
      case 'character_add': return this._validateCharacterAdd
      case 'character_update': return this._validateCharacterUpdate
      case 'hook_add': return this._validateHookAdd
      case 'hook_resolve': return this._validateHookResolve
      case 'hook_abandon': return this._validateHookAbandon
      case 'world_add': return this._validateWorldAdd
      case 'outline_upsert': return this._validateOutlineUpsert
      case 'edge_add': return this._validateEdgeAdd
      case 'subplot_upsert': return this._validateSubplotUpsert
      case 'summary_upsert': return this._validateSummaryUpsert
      case 'style_update': return this._validateStyleUpdate
      case 'fact_add': return this._validateFactAdd
      default: return null
    }
  }

  /** 把提案登记进校验上下文，让后续提案能看见它 */
  private _register(p: Proposal, ctx: ValidateCtx): void {
    try {
      if (p.kind === 'character_add') {
        const char = asCharacter(p.payload)
        if (char) {
          ctx.characters.set(char.id, char)
          if (!ctx.byName.has(char.name)) ctx.byName.set(char.name, char)
        }
      } else if (p.kind === 'character_update') {
        const key = String(p.payload.id ?? p.payload.name ?? '')
        const target = ctx.characters.get(key) ?? ctx.byName.get(key)
        if (target) {
          const updated = asCharacter(applyChanges(target as unknown as Record<string, unknown>, (p.payload.changes as Record<string, unknown>) ?? {}))
          if (updated) {
            ctx.characters.set(updated.id, updated)
            ctx.byName.set(updated.name, updated)
          }
        }
      } else if (p.kind === 'hook_add') {
        const hook = asHook(p.payload)
        if (hook) ctx.hooks.push(hook)
      } else if (p.kind === 'hook_resolve') {
        const hookId = String(p.payload.id ?? p.payload.hook_id ?? '')
        for (const h of ctx.hooks) {
          if (h.id === hookId) {
            h.status = 'resolved'
            h.resolved_chapter = Number(p.payload.chapter ?? 0) || h.resolved_chapter
          }
        }
      } else if (p.kind === 'hook_abandon') {
        const hookId = String(p.payload.id ?? p.payload.hook_id ?? '')
        for (const h of ctx.hooks) {
          if (h.id === hookId) h.status = 'abandoned'
        }
      } else if (p.kind === 'world_add') {
        const rule = asWorldRule(p.payload)
        if (rule) {
          ctx.world.rules = [...ctx.world.rules.filter((r) => r.id !== rule.id), rule]
        }
      } else if (p.kind === 'outline_upsert') {
        const node = asOutlineNode(p.payload)
        if (node) {
          ctx.graph.nodes = [...ctx.graph.nodes.filter((n) => n.chapter !== node.chapter), node]
          ctx.graph.nodes.sort((a, b) => a.chapter - b.chapter)
        }
      } else if (p.kind === 'edge_add') {
        const edge = asOutlineEdge(p.payload)
        if (edge) ctx.graph.edges.push(edge)
      }
    } catch {
      /* 登记失败不影响校验流程 */
    }
  }

  // -- 各类型的校验规则 --

  private _validateCharacterAdd = (p: Proposal, ctx: ValidateCtx): ValidationIssue[] => {
    const out: ValidationIssue[] = []
    const char = asCharacter(p.payload)
    if (!char) return [issue('字段非法', '角色字段不合法', p.id)]

    if (ctx.characters.has(char.id)) {
      out.push(issue('重复角色', `角色 id 已存在：${char.id}`, p.id))
    }
    const sameName = ctx.byName.get(char.name)
    if (sameName && sameName.id !== char.id) {
      out.push(issue('重复角色', `角色姓名已存在：${char.name}`, p.id))
    }
    if (!char.immutable_traits.length) {
      out.push(issue('缺少不可变特征', `「${char.name}」没有不可变特征，防崩能力会打折`, p.id, 'warning'))
    }
    if (
      char.deceased &&
      char.state.status &&
      !char.state.status.includes('亡') &&
      !char.state.status.includes('死')
    ) {
      out.push(issue('状态矛盾', `「${char.name}」标记为已故，但状态写的是「${char.state.status}」`, p.id))
    }
    return out
  }

  private _validateCharacterUpdate = (p: Proposal, ctx: ValidateCtx): ValidationIssue[] => {
    const out: ValidationIssue[] = []
    const key = String(p.payload.id ?? p.payload.name ?? '')
    const target = ctx.characters.get(key) ?? ctx.byName.get(key)
    if (!target) return [issue('角色不存在', `要更新的角色不存在：${key}`, p.id)]
    const changes = (p.payload.changes as Record<string, unknown>) ?? {}

    // 硬规则：不可变特征只能增补，不能改写或删除
    if ('immutable_traits' in changes) {
      const newTraits = (Array.isArray(changes.immutable_traits) ? changes.immutable_traits : []).map(String)
      const removed = target.immutable_traits.filter((t) => !newTraits.includes(t))
      if (removed.length) {
        out.push(
          issue(
            '违背不可变特征',
            `不得删除「${target.name}」的不可变特征：${removed.join('、')}` +
              '（如需变更，必须人工在设置里显式解除锁定）',
            p.id,
          ),
        )
      }
    }
    if (changes.deceased === false && target.deceased) {
      out.push(
        issue(
          '角色复活',
          `「${target.name}」已标记亡故，不得直接复活；如需复活请在提案里说明依据并人工确认`,
          p.id,
        ),
      )
    }
    if ('state' in changes && (typeof changes.state !== 'object' || changes.state === null)) {
      out.push(issue('字段非法', '角色状态的格式不正确', p.id))
    }
    return out
  }

  private _validateHookAdd = (p: Proposal, ctx: ValidateCtx): ValidationIssue[] => {
    const out: ValidationIssue[] = []
    const hook = asHook(p.payload)
    if (!hook) return [issue('字段非法', '伏笔字段不合法', p.id)]

    const norm = normText(hook.content)
    for (const existing of ctx.hooks) {
      if (existing.id === hook.id) {
        out.push(issue('重复伏笔', `伏笔 id 已存在：${hook.id}`, p.id))
        continue
      }
      if (similarity(norm, normText(existing.content)) >= 0.82) {
        out.push(
          issue('重复伏笔', `与已有伏笔「${existing.content}」高度相似，疑似重复埋设`, p.id),
        )
      }
    }
    if (hook.suggested_resolve_by != null && hook.suggested_resolve_by <= hook.planted_chapter) {
      out.push(issue('字段非法', '建议回收章必须晚于埋设章', p.id))
    }
    return out
  }

  private _validateHookResolve = (p: Proposal, ctx: ValidateCtx): ValidationIssue[] => {
    const hookId = String(p.payload.id ?? p.payload.hook_id ?? '')
    const chapter = Number(p.payload.chapter ?? 0)
    const hooks = new Map(ctx.hooks.map((h) => [h.id, h]))
    const hook = hooks.get(hookId)
    if (!hook) return [issue('伏笔不存在', `要回收的伏笔不存在：${hookId}`, p.id)]
    if (hook.status === 'resolved') {
      return [
        issue(
          '重复回收',
          `伏笔「${hook.content}」已在第 ${hook.resolved_chapter ?? '?'} 章回收`,
          p.id,
          'warning',
        ),
      ]
    }
    if (chapter && chapter < hook.planted_chapter) {
      return [issue('时序矛盾', '回收章早于埋设章', p.id)]
    }
    return []
  }

  private _validateHookAbandon = (p: Proposal, ctx: ValidateCtx): ValidationIssue[] => {
    const hookId = String(p.payload.id ?? p.payload.hook_id ?? '')
    if (!ctx.hooks.some((h) => h.id === hookId)) {
      return [issue('伏笔不存在', `要放弃的伏笔不存在：${hookId}`, p.id)]
    }
    return [issue('伏笔弃用', '伏笔被标记为弃用，会拉低回收率，请确认这是有意为之', p.id, 'warning')]
  }

  private _validateWorldAdd = (p: Proposal, ctx: ValidateCtx): ValidationIssue[] => {
    const out: ValidationIssue[] = []
    const rule = asWorldRule(p.payload)
    if (!rule) return [issue('字段非法', '世界观字段不合法', p.id)]

    const norm = normText(rule.rule)
    for (const existing of ctx.world.rules) {
      if (existing.id === rule.id) {
        out.push(issue('重复设定', `设定 id 已存在：${rule.id}`, p.id))
      } else if (similarity(norm, normText(existing.rule)) >= 0.85) {
        out.push(issue('重复设定', `与已有设定高度相似：「${existing.rule}」`, p.id))
      }
    }
    if (rule.kind === 'hard' && !rule.rule.trim()) {
      out.push(issue('字段非法', '硬约束不能为空', p.id))
    }
    return out
  }

  private _validateOutlineUpsert = (p: Proposal, ctx: ValidateCtx): ValidationIssue[] => {
    const node = asOutlineNode(p.payload)
    if (!node) return [issue('字段非法', '章纲字段不合法', p.id)]
    const existing = ctx.graph.nodes.find((n) => n.chapter === node.chapter)
    if (existing && existing.status === 'written' && normText(existing.goal) !== normText(node.goal)) {
      return [
        issue(
          '改动已成稿章纲',
          `第 ${node.chapter} 章已有正文，改动章纲会影响已定稿内容，需人工确认`,
          p.id,
          'warning',
        ),
      ]
    }
    return []
  }

  private _validateEdgeAdd = (p: Proposal, _ctx: ValidateCtx): ValidationIssue[] => {
    const edge = asOutlineEdge(p.payload)
    if (!edge) return [issue('字段非法', '依赖边字段不合法', p.id)]
    if (edge.from_chapter === edge.to_chapter) {
      return [issue('字段非法', '依赖边的起点与终点不能是同一章', p.id)]
    }
    if (edge.from_chapter < edge.to_chapter) {
      return [
        issue(
          '依赖边方向可疑',
          `依赖边的方向看起来反了：约定是「后章 → 它依赖的前章」，但这里是第 ${edge.from_chapter} 章 → 第 ${edge.to_chapter} 章。`,
          p.id,
          'warning',
        ),
      ]
    }
    return []
  }

  private _validateSubplotUpsert = (p: Proposal, _ctx: ValidateCtx): ValidationIssue[] => {
    if (!asSubplot(p.payload)) return [issue('字段非法', '情节线字段不合法', p.id)]
    return []
  }

  private _validateSummaryUpsert = (p: Proposal, _ctx: ValidateCtx): ValidationIssue[] => {
    if (!asChapterSummary(p.payload)) return [issue('字段非法', '章节摘要字段不合法', p.id)]
    return []
  }

  private _validateStyleUpdate = (p: Proposal, _ctx: ValidateCtx): ValidationIssue[] => {
    if (!asStyleProfile(p.payload)) return [issue('字段非法', '文风档案字段不合法', p.id)]
    return []
  }

  private _validateFactAdd = (p: Proposal, _ctx: ValidateCtx): ValidationIssue[] => {
    if (!String(p.payload.text ?? '').trim()) return [issue('字段非法', '事实内容为空', p.id)]
    return []
  }

  // ---------------- 提交 ----------------

  commit(proposals: Proposal[], opts: { force?: boolean } = {}): CommitResult {
    const { force = false } = opts
    const result: CommitResult = {
      applied: [],
      pending: [],
      issues: [],
      changed_files: [],
      blocked: false,
      public() {
        return {
          applied: this.applied,
          pending: this.pending,
          issues: this.issues,
          changedFiles: this.changed_files,
        }
      },
    }
    const issues = this.validate(proposals)
    result.issues = issues
    const errorsByProposal = new Map<string, ValidationIssue[]>()
    for (const i of issues) {
      if (i.level === 'error') {
        errorsByProposal.set(i.proposal_id, [...(errorsByProposal.get(i.proposal_id) ?? []), i])
      }
    }

    const changed = new Set<string>()
    for (const p of proposals) {
      if (errorsByProposal.has(p.id) && !force) {
        result.pending.push(p) // 降级为待人工确认，不写入
        continue
      }
      let rel = ''
      try {
        rel = this._apply(p)
      } catch {
        result.issues.push(issue('应用失败', `提案 ${p.id} 写入失败`, p.id))
        result.pending.push(p)
        continue
      }
      p.decision = p.decision ?? 'accept'
      result.applied.push(p)
      if (rel) changed.add(rel)
    }

    result.changed_files = [...changed].sort()
    result.blocked = result.pending.length > 0
    return result
  }

  private _apply(p: Proposal): string {
    const store = this.store
    switch (p.kind) {
      case 'character_add': {
        const char = asCharacter(p.payload)
        if (!char) throw new Error('角色字段不合法')
        const items = store.characters().filter((c) => c.id !== char.id)
        items.push(char)
        store.saveCharacters(items)
        return 'characters.jsonl'
      }
      case 'character_update': {
        const key = String(p.payload.id ?? p.payload.name ?? '')
        const items = store.characters()
        const target = items.find((c) => c.id === key || c.name === key)
        if (!target) throw new Error(`角色不存在：${key}`)
        const updated = asCharacter(
          applyChanges(target as unknown as Record<string, unknown>, (p.payload.changes as Record<string, unknown>) ?? {}),
        )
        if (!updated) throw new Error('角色字段不合法')
        store.saveCharacters(items.map((c) => (c.id === target.id ? updated : c)))
        return 'characters.jsonl'
      }
      case 'hook_add': {
        const hook = asHook(p.payload)
        if (!hook) throw new Error('伏笔字段不合法')
        const items = store.hooks().filter((h) => h.id !== hook.id)
        items.push(hook)
        items.sort((a, b) => a.planted_chapter - b.planted_chapter || (a.id < b.id ? -1 : 1))
        store.saveHooks(items)
        return 'pending_hooks.jsonl'
      }
      case 'hook_resolve': {
        const hookId = String(p.payload.id ?? p.payload.hook_id ?? '')
        const chapter = Number(p.payload.chapter ?? 0)
        const items = store.hooks()
        let hit = false
        for (const h of items) {
          if (h.id === hookId) {
            h.status = 'resolved'
            h.resolved_chapter = chapter || h.resolved_chapter
            hit = true
          }
        }
        if (!hit) throw new Error(`伏笔不存在：${hookId}`)
        store.saveHooks(items)
        return 'pending_hooks.jsonl'
      }
      case 'hook_abandon': {
        const hookId = String(p.payload.id ?? p.payload.hook_id ?? '')
        const items = store.hooks()
        let hit = false
        for (const h of items) {
          if (h.id === hookId) {
            h.status = 'abandoned'
            hit = true
          }
        }
        if (!hit) throw new Error(`伏笔不存在：${hookId}`)
        store.saveHooks(items)
        return 'pending_hooks.jsonl'
      }
      case 'world_add': {
        const rule = asWorldRule(p.payload)
        if (!rule) throw new Error('世界观字段不合法')
        const doc = store.world()
        doc.rules = [...doc.rules.filter((r) => r.id !== rule.id), rule]
        store.saveWorld(doc)
        return 'world.md'
      }
      case 'world_update': {
        const ruleKey = String(p.payload.id ?? '')
        const changes = (p.payload.changes as Record<string, unknown>) ?? {}
        const doc = store.world()
        const hit = doc.rules.some((r) => {
          if (r.id === ruleKey) {
            Object.assign(r, changes)
            return true
          }
          return false
        })
        if (!hit) throw new Error(`设定不存在：${ruleKey}`)
        store.saveWorld(doc)
        return 'world.md'
      }
      case 'outline_upsert': {
        const node = asOutlineNode(p.payload)
        if (!node) throw new Error('章纲字段不合法')
        const graph = store.outlineGraph()
        graph.nodes = [...graph.nodes.filter((n) => n.chapter !== node.chapter), node]
        graph.nodes.sort((a, b) => a.chapter - b.chapter)
        store.saveOutlineGraph(graph)
        return 'outline_graph.json'
      }
      case 'edge_add': {
        const edge = asOutlineEdge(p.payload)
        if (!edge) throw new Error('依赖边字段不合法')
        const graph = store.outlineGraph()
        const key = (e: OutlineEdge) => `${e.from_chapter}|${e.to_chapter}|${e.type}`
        graph.edges = [...graph.edges.filter((e) => key(e) !== key(edge)), edge]
        store.saveOutlineGraph(graph)
        return 'outline_graph.json'
      }
      case 'subplot_upsert': {
        const sub = asSubplot(p.payload)
        if (!sub) throw new Error('情节线字段不合法')
        store.saveSubplots([...store.subplots().filter((s) => s.id !== sub.id), sub])
        return 'subplot_board.md'
      }
      case 'summary_upsert': {
        const summary = asChapterSummary(p.payload)
        if (!summary) throw new Error('章节摘要字段不合法')
        store.upsertSummary(summary)
        return 'chapter_summaries.jsonl'
      }
      case 'style_update': {
        const profile = asStyleProfile(p.payload)
        if (!profile) throw new Error('文风档案字段不合法')
        store.saveStyle(profile)
        return 'style_profile.json'
      }
      case 'fact_add': {
        const state = store.state()
        const text = String(p.payload.text ?? '').trim()
        const chapter = Number(p.payload.chapter ?? state.chapter ?? 0)
        state.chapter = Math.max(state.chapter, chapter)
        if (p.payload.situation) state.situation = String(p.payload.situation)
        if (p.payload.location) state.location_focus = String(p.payload.location)
        if (text && !state.open_questions.includes(text)) state.open_questions.push(text)
        store.saveState(state)
        return 'current_state.md'
      }
      default:
        throw new Error(`未知提案类型：${p.kind}`)
    }
  }
}

/** 便捷工厂：构造一条 Proposal（供各 Agent 使用） */
export function proposal(
  kind: string,
  payload: Record<string, unknown>,
  opts: { id?: string; reason?: string; confidence?: Proposal['confidence']; targetFile?: string } = {},
): Proposal {
  return {
    id: opts.id ?? `${kind}_${Date.now().toString(36)}`,
    kind,
    payload,
    reason: opts.reason ?? '',
    confidence: opts.confidence ?? 'medium',
    decision: null,
    target_file: opts.targetFile ?? KIND_TARGET[kind] ?? '',
  }
}
