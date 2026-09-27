/**
 * Archivist：定稿正文 → 摘要 / 事实抽取 / 伏笔更新 / 依赖边更新 —— 镜像 `server/dobi/agents/archivist.py`。
 *
 * 这是「长期记忆」真正沉淀的地方。抽取结果一律走 **Proposal → Validate → Commit**，
 * 冲突项降级为待人工确认 —— 模型说「某个已故角色登场了」不会被静默写进真相文件。
 *
 * 同时做两件事：
 * - 把章节标记为已定稿，章纲节点标记为 `written`
 * - 追加一条时序记忆（原版写 SQLite `timeline` 表；本地版落 localStorage），供日后检索与回溯
 */

import { Agent, Usage } from './base'
import * as prompts from './prompts'
import { fmt, fmtCharacters, fmtHooks } from './architect'
import { completeJson } from '../llm'
import { TruthWriter, proposal } from '../truthwriter'
import { graphNode } from '../memory'
import { nowIso } from '../util'
import type { ChapterSummary, CommitResult, Hook, Proposal, Subplot } from '../types'

// ---------------------------------------------------------------------------
// 解析辅助
// ---------------------------------------------------------------------------

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function asStringList(v: unknown): string[] {
  return asArray(v).map((x) => String(x).trim()).filter(Boolean)
}

/** 宽松 int 解析：镜像 Python `int(x)`（非法值返回 null，不做隐式舍入）。 */
function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isInteger(v) ? v : null
  const s = String(v).trim()
  if (!s) return null
  return /^-?\d+$/.test(s) ? parseInt(s, 10) : null
}

// ---------------------------------------------------------------------------
// 时序记忆（镜像原版 MemoryIndex.append_timeline 写入 SQLite timeline 表）
// ---------------------------------------------------------------------------

interface TimelineEntry {
  chapter: number
  kind: string
  payload: Record<string, unknown>
  createdAt: string
}

function appendTimeline(
  projectId: string,
  entry: { chapter: number; kind: string; payload: Record<string, unknown> },
): void {
  const key = `dobi.timeline.${projectId}`
  let rows: TimelineEntry[] = []
  try {
    const raw = window.localStorage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) rows = parsed as TimelineEntry[]
    }
  } catch {
    rows = []
  }
  rows.push({ ...entry, createdAt: nowIso() })
  try {
    window.localStorage.setItem(key, JSON.stringify(rows.slice(-200)))
  } catch {
    /* 存储不可用时仅内存态 */
  }
}

// ---------------------------------------------------------------------------
// 结果容器
// ---------------------------------------------------------------------------

export class ArchiveResult {
  chapter: number
  summary: ChapterSummary | null = null
  commit: CommitResult | null = null
  hooks_planted: string[] = []
  hooks_resolved: string[] = []
  state_changes: string[] = []
  usage: Usage

  constructor(chapter: number) {
    this.chapter = chapter
    this.usage = new Usage()
  }

  public(): Record<string, unknown> {
    return {
      chapter: this.chapter,
      summary: this.summary ? { ...this.summary } : null,
      hooksPlanted: this.hooks_planted,
      hooksResolved: this.hooks_resolved,
      stateChanges: this.state_changes,
      applied: this.commit ? this.commit.applied.length : 0,
      pending: this.commit ? this.commit.pending.map((p) => ({ ...p })) : [],
      issues: this.commit ? this.commit.issues.map((i) => ({ ...i })) : [],
      usage: this.usage.public(),
    }
  }
}

// ---------------------------------------------------------------------------
// Archivist
// ---------------------------------------------------------------------------

export class Archivist extends Agent {
  private commit(proposals: Proposal[], opts: { force?: boolean } = {}): CommitResult {
    return new TruthWriter(this.store).commit(proposals, opts)
  }

  async archive(chapter: number): Promise<ArchiveResult> {
    const store = this.store
    const data = store.readChapter(chapter)
    const text = data.paragraphs.join('\n\n')
    if (!text.trim()) {
      throw new Error(`第 ${chapter} 章还没有正文，无法归档。`)
    }

    this.scope(chapter, 'commit')
    this.budgetGate()
    const { data: obj, result } = await completeJson('archivist', [
      {
        role: 'user',
        content: fmt(prompts.ARCHIVIST, {
          chapter,
          title: data.title,
          text,
          hooks: fmtHooks(store.hooks(), { onlyPending: false }),
          characters: fmtCharacters(store.characters()),
        }),
      },
    ])
    this.usage.add(result)
    if (typeof obj !== 'object' || obj === null) {
      throw new Error('归档结果不是 JSON 对象，请重试。')
    }
    const rec = obj as Record<string, unknown>

    const proposals: Proposal[] = []
    const outcome = new ArchiveResult(chapter)

    // ---------- 摘要 ----------
    const present = asStringList(rec.characters_present)
    const summary: ChapterSummary = {
      chapter,
      title: data.title,
      summary: String(rec.summary ?? '').trim(),
      words: data.words,
      pov: data.pov,
      key_facts: asStringList(rec.key_facts),
      characters: present,
      hooks_planted: outcome.hooks_planted,
      hooks_resolved: outcome.hooks_resolved,
      updated_at: nowIso(),
    }
    outcome.summary = summary

    // ---------- 新伏笔 ----------
    for (const raw of asArray(rec.hooks_planted)) {
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const content = String(r.content ?? '').trim()
      if (!content) continue
      let hid = store.nextHookId()
      while (outcome.hooks_planted.includes(hid)) {
        hid = `hook_${String(Number(hid.split('_')[1]) + 1).padStart(3, '0')}`
      }
      const hook: Hook = {
        id: hid,
        content,
        planted_chapter: chapter,
        status: 'planted',
        resolved_chapter: null,
        importance: String(r.importance) === 'major' ? 'major' : 'minor',
        linked_characters: [],
        suggested_resolve_by: intOrNull(r.suggested_resolve_by),
      }
      outcome.hooks_planted.push(hid)
      proposals.push(
        proposal('hook_add', { ...hook }, {
          id: `hook_${hid}`,
          targetFile: 'pending_hooks.jsonl',
          reason: `第 ${chapter} 章埋设`,
          confidence: 'medium',
        }),
      )
    }

    // ---------- 回收伏笔 ----------
    const known = new Set(store.hooks().map((h) => h.id))
    for (const raw of asArray(rec.hooks_resolved)) {
      const hid = String(raw).trim()
      if (hid && known.has(hid)) {
        outcome.hooks_resolved.push(hid)
        proposals.push(
          proposal('hook_resolve', { id: hid, chapter }, {
            id: `resolve_${hid}`,
            targetFile: 'pending_hooks.jsonl',
            reason: `第 ${chapter} 章回收`,
            confidence: 'high',
          }),
        )
      }
    }
    summary.hooks_resolved = outcome.hooks_resolved

    // ---------- 世界状态 / 事实 ----------
    const stateRaw = rec.state && typeof rec.state === 'object' ? (rec.state as Record<string, unknown>) : {}
    const situation = String(stateRaw.situation ?? '').trim()
    const location = String(stateRaw.location_focus ?? '').trim()
    const questions = asStringList(stateRaw.open_questions)
    proposals.push(
      proposal(
        'fact_add',
        { text: questions[0] ?? '', chapter, situation, location },
        {
          id: `fact_ch${chapter}`,
          targetFile: 'current_state.md',
          reason: `第 ${chapter} 章后的世界状态`,
          confidence: 'medium',
        },
      ),
    )

    // ---------- 情节线推进 ----------
    const existingSubs = new Map(store.subplots().map((s) => [s.name, s]))
    for (const raw of asArray(rec.subplot_updates)) {
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const name = String(r.name ?? '').trim()
      if (!name) continue
      const base = existingSubs.get(name)
      const chapters = [...new Set([...(base ? base.active : []), chapter])].sort((a, b) => a - b)
      const sub: Subplot = {
        id: base ? base.id : `pl_${existingSubs.size + 1}`,
        name,
        kind: base ? base.kind : 'sub',
        summary: String(r.summary ?? (base ? base.summary : '')),
        color: base ? base.color : '#4F6B4A',
        active: chapters,
        peak: base && base.peak.length
          ? [...new Set([...base.peak, chapter])].sort((a, b) => a - b)
          : [chapter],
        status: 'active',
      }
      proposals.push(
        proposal('subplot_upsert', { ...sub }, {
          id: `subplot_${sub.id}`,
          targetFile: 'subplot_board.md',
          reason: `第 ${chapter} 章推进`,
          confidence: 'medium',
        }),
      )
    }

    // ---------- 角色状态变更 ----------
    const byName = new Map(store.characters().map((c) => [c.name, c]))
    const allowedKeys = new Set(['location', 'status', 'known_secrets'])
    for (const raw of asArray(rec.character_state_changes)) {
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const name = String(r.name ?? '').trim()
      const changesRaw = r.changes
      const char = byName.get(name)
      if (!char || typeof changesRaw !== 'object' || changesRaw === null) continue
      const changes: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(changesRaw as Record<string, unknown>)) {
        if (allowedKeys.has(k) && v) changes[k] = v
      }
      if (!Object.keys(changes).length) continue
      changes.updated_at_chapter = chapter
      const desc = Object.entries(changes)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.map(String).join('、') : String(v)}`)
        .join('/')
      outcome.state_changes.push(`${name}: ${desc}`)
      proposals.push(
        proposal('character_update', { id: char.id, changes }, {
          id: `state_${char.id}`,
          targetFile: 'characters.jsonl',
          reason: `第 ${chapter} 章状态变更`,
          confidence: 'medium',
        }),
      )
    }

    // ---------- 摘要提案 ----------
    proposals.push(
      proposal('summary_upsert', { ...summary }, {
        id: `summary_ch${chapter}`,
        targetFile: 'chapter_summaries.jsonl',
        reason: `第 ${chapter} 章摘要`,
        confidence: 'high',
      }),
    )

    outcome.commit = this.commit(proposals)

    // ---------- 章节与章纲状态 ----------
    store.updateChapterStatus(chapter, 'done', { title: data.title, pov: data.pov })
    const graph = store.outlineGraph()
    const node = graphNode(graph, chapter)
    if (node !== null) {
      node.status = 'written'
      if (!node.title && data.title) {
        node.title = data.title
      }
      store.saveOutlineGraph(graph)
    }

    // ---------- 时序记忆 ----------
    try {
      appendTimeline(this.store.id, {
        chapter,
        kind: 'commit',
        payload: {
          title: data.title,
          summary: summary.summary,
          hooksPlanted: outcome.hooks_planted,
          hooksResolved: outcome.hooks_resolved,
          words: data.words,
        },
      })
    } catch {
      /* 记忆写入失败不影响定稿 */
    }

    // ---------- 计量对账（原版 reconcile 把 budget_used 缓存与流水对齐；
    // ---------- 本地版在 store.appendUsage 里已同步 meta 缓存，无需再对账） ----------

    this.cp.finish(
      this.cp.begin(chapter, 'commit'),
      {
        output_ref: `chapter_summaries.jsonl#${chapter}`,
        cost: this.usage.cost,
        note:
          `摘要 ${summary.summary.length} 字 · 新埋 ${outcome.hooks_planted.length} 条伏笔 · ` +
          `回收 ${outcome.hooks_resolved.length} 条`,
      },
    )
    return outcome
  }
}
