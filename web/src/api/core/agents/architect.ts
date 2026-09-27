/**
 * Architect：灵感 → 世界观 / 角色 / 大纲 / 依赖图 —— 镜像 `server/dobi/agents/architect.py`。
 *
 * **滚动规划**：初始只规划前 2 卷，写到该卷才展开详细章纲（`rollVolume`）。
 * 一次铺到 300 章的大纲必然空心化 —— 这是规划文档 §7.3 的核心判断。
 */

import { Agent, Usage } from './base'
import * as prompts from './prompts'
import type { ProjectStore } from '../store'
import { completeJson, maxOutputFor } from '../llm'
import { TruthWriter, proposal } from '../truthwriter'
import { graphNode, motivationsFor } from '../memory'
import type {
  Character,
  CommitResult,
  Hook,
  OutlineEdge,
  OutlineNode,
  Proposal,
  Relation,
  Volume,
  WorldRule,
} from '../types'

// ---------------------------------------------------------------------------
// 提示词格式化（镜像 Python str.format：`{{` / `}}` 转义为字面花括号）
// ---------------------------------------------------------------------------

export function fmt(tpl: string, values: Record<string, string | number>): string {
  return tpl
    .replace(/\{\{/g, '\u0000')
    .replace(/\}\}/g, '\u0001')
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, k: string) => String(values[k] ?? ''))
    .replace(/\u0000/g, '{')
    .replace(/\u0001/g, '}')
}

// ---------------------------------------------------------------------------
// 格式化辅助
// ---------------------------------------------------------------------------

export function fmtCharacters(chars: Character[]): string {
  if (!chars.length) return '（尚未建立）'
  return chars
    .map((c) => {
      const traits = c.immutable_traits.join('；') || '无'
      const state = `${c.state.location}／${c.state.status}`
      return `- ${c.name}（${c.role}）：特征 ${traits}｜状态 ${state}｜${c.personality}`
    })
    .join('\n')
}

export function fmtWorld(store: ProjectStore): string {
  const rules = store.world().rules
  if (!rules.length) return '（尚未建立）'
  return rules.map((r) => `- [${r.kind}/${r.category}] ${r.rule}`).join('\n')
}

export function fmtHooks(hooks: Hook[], opts: { onlyPending?: boolean } = {}): string {
  const { onlyPending = true } = opts
  const picked = onlyPending ? hooks.filter((h) => h.status === 'planted') : hooks
  if (!picked.length) return '（无）'
  return picked
    .map(
      (h) =>
        `- ${h.id}：${h.content}（埋于第 ${h.planted_chapter} 章，` +
        `建议第 ${h.suggested_resolve_by ?? '未定'} 章前回收）`,
    )
    .join('\n')
}

/** 从一段文本里挑出「可能出场」的角色名，用于上下文组装时优先带他们的角色卡。 */
export function presentCharacters(store: ProjectStore, text: string): string[] {
  if (!text) return []
  const names: string[] = []
  for (const c of store.characters()) {
    if (c.name && text.includes(c.name)) {
      names.push(c.name)
    } else {
      for (const alias of c.aliases) {
        if (alias && text.includes(alias)) {
          names.push(c.name)
          break
        }
      }
    }
  }
  return names
}

// ---------------------------------------------------------------------------
// 结果容器
// ---------------------------------------------------------------------------

export class ArchitectResult {
  targets: string[] = []
  proposals: Proposal[] = []
  commit: CommitResult | null = null
  usage: Usage
  notes: string[] = []

  constructor(init: {
    targets?: string[]
    proposals?: Proposal[]
    commit?: CommitResult | null
    usage?: Usage
    notes?: string[]
  } = {}) {
    this.usage = new Usage()
    if (init.targets) this.targets = init.targets
    if (init.proposals) this.proposals = init.proposals
    if (init.commit !== undefined) this.commit = init.commit
    if (init.usage) this.usage = init.usage
    if (init.notes) this.notes = init.notes
  }

  public(): Record<string, unknown> {
    return {
      targets: this.targets,
      proposalCount: this.proposals.length,
      applied: this.commit ? this.commit.applied.length : 0,
      pending: this.commit ? this.commit.pending.map((p) => ({ ...p })) : [],
      issues: this.commit ? this.commit.issues.map((i) => ({ ...i })) : [],
      usage: this.usage.public(),
      notes: this.notes,
    }
  }
}

// ---------------------------------------------------------------------------
// Architect
// ---------------------------------------------------------------------------

export class Architect extends Agent {
  private commit(proposals: Proposal[], opts: { force?: boolean } = {}): CommitResult {
    return new TruthWriter(this.store).commit(proposals, opts)
  }

  // ---------------- 世界观 ----------------

  async buildWorld(): Promise<ArchitectResult> {
    const meta = this.store.meta()
    this.scope(1, 'plan')
    this.budgetGate()
    const prompt = fmt(prompts.WORLD, {
      genre: meta.genre,
      premise: meta.premise || meta.logline || '（未填写）',
      tone: meta.logline || '克制、细节向',
      existing: fmtWorld(this.store),
    })
    const { data, result } = await completeJson('architect', [{ role: 'user', content: prompt }])
    this.usage.add(result)

    const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    const rules = rec.rules
    if (!Array.isArray(rules) || !rules.length) {
      throw new Error('设定生成结果里没有 rules，请重试或换一个更强的模型。')
    }

    const proposals: Proposal[] = []
    const existingIds = new Set(this.store.world().rules.map((r) => r.id))
    let i = 0
    for (const raw of rules) {
      i += 1
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const ruleText = String(r.rule ?? '').trim()
      if (!ruleText) continue
      let rid = String(r.id ?? `w${i}`)
      if (existingIds.has(rid)) rid = `w${i}`
      const rule: WorldRule = {
        id: rid,
        category: String(r.category ?? '其他'),
        kind: String(r.kind) === 'soft' ? 'soft' : 'hard',
        rule: ruleText,
        refs: [],
        note: String(r.note ?? ''),
        status: 'ok',
      }
      proposals.push(
        proposal('world_add', { ...rule }, {
          id: `world_${rid}`,
          reason: 'Architect 建立世界观',
          confidence: 'high',
        }),
      )
    }

    const commit = this.commit(proposals)
    return new ArchitectResult({ targets: ['world'], proposals, commit, usage: this.usage })
  }

  // ---------------- 角色 ----------------

  async buildCharacters(): Promise<ArchitectResult> {
    const meta = this.store.meta()
    this.scope(1, 'plan')
    this.budgetGate()
    const existing = this.store.characters()
    let prompt = fmt(prompts.CHARACTERS, {
      genre: meta.genre,
      premise: meta.premise || meta.logline || '（未填写）',
      world: fmtWorld(this.store),
    })
    if (existing.length) {
      prompt += '\n\n【已有角色（不要重复，如需增补只给新角色）】\n' + fmtCharacters(existing)
    }
    const { data, result } = await completeJson('architect', [{ role: 'user', content: prompt }])
    this.usage.add(result)

    const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    const rawChars = rec.characters
    if (!Array.isArray(rawChars) || !rawChars.length) {
      throw new Error('角色生成结果里没有 characters，请重试或换一个更强的模型。')
    }

    const usedIds = new Set(existing.map((c) => c.id))
    const usedNames = new Set(existing.map((c) => c.name))
    const proposals: Proposal[] = []
    const created: Character[] = []

    for (const raw of rawChars) {
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const name = String(r.name ?? '').trim()
      if (!name) continue
      if (usedNames.has(name)) continue
      let cid = String(r.id ?? '').trim()
      if (!cid || usedIds.has(cid)) {
        cid = this.store.nextCharacterId()
        while (usedIds.has(cid)) {
          cid = `char_${String(usedIds.size + 1).padStart(3, '0')}`
        }
      }
      usedIds.add(cid)
      usedNames.add(name)

      const rels: Relation[] = []
      for (const rel of Array.isArray(r.relationships) ? r.relationships : []) {
        if (typeof rel !== 'object' || rel === null) continue
        const relRec = rel as Record<string, unknown>
        const target = String(relRec.target ?? '').trim()
        if (!target) continue
        rels.push({
          target,
          type: String(relRec.type ?? '关联'),
          note: String(relRec.note ?? ''),
        })
      }
      const stateRaw = r.state && typeof r.state === 'object' ? (r.state as Record<string, unknown>) : {}
      const char: Character = {
        id: cid,
        name,
        role: String(r.role ?? '配角'),
        lead: Boolean(r.lead),
        immutable_traits: Array.isArray(r.immutable_traits)
          ? r.immutable_traits.map((t) => String(t).trim()).filter(Boolean)
          : [],
        personality: String(r.personality ?? ''),
        speech_style: String(r.speech_style ?? ''),
        relationships: rels,
        state: {
          location: String(stateRaw.location ?? '—'),
          status: String(stateRaw.status ?? '—'),
          known_secrets: Array.isArray(stateRaw.known_secrets)
            ? stateRaw.known_secrets.map((s) => String(s))
            : [],
        },
        first_appearance: Number(r.first_appearance || 1),
        updated_at_chapter: 0,
        aliases: [],
        deceased: Boolean(r.deceased),
      }
      created.push(char)
      proposals.push(
        proposal('character_add', { ...char }, {
          id: `char_${cid}`,
          reason: 'Architect 建立角色',
          confidence: 'high',
        }),
      )
    }

    const commit = this.commit(proposals)
    if (commit.applied.length) this.normalizeRelations()
    return new ArchitectResult({ targets: ['characters'], proposals, commit, usage: this.usage })
  }

  /** 把关系里的「角色姓名」统一成 id —— 姓名会变，id 不会。 */
  private normalizeRelations(): void {
    const chars = this.store.characters()
    const byName = new Map(chars.map((c) => [c.name, c.id]))
    let changed = false
    for (const c of chars) {
      for (const rel of c.relationships) {
        const id = byName.get(rel.target)
        if (id && id !== rel.target) {
          rel.target = id
          changed = true
        }
      }
    }
    if (changed) this.store.saveCharacters(chars)
  }

  // ---------------- 大纲 ----------------

  async buildOutline(opts: { volumes?: number } = {}): Promise<ArchitectResult> {
    const { volumes = 2 } = opts
    const meta = this.store.meta()
    const graph = this.store.outlineGraph()
    this.scope(1, 'plan')
    this.budgetGate()
    const prompt = fmt(prompts.OUTLINE, {
      genre: meta.genre,
      premise: meta.premise || meta.logline || '（未填写）',
      chapters_total: meta.chapters_total ? String(meta.chapters_total) : '自由估计',
      volumes: String(volumes),
      compass_hint: graph.compass.endgame || '（尚未确定终局方向，请你定）',
      characters: fmtCharacters(this.store.characters()),
      world: fmtWorld(this.store),
      existing: graph.nodes.length ? JSON.stringify(graph, null, 1).slice(0, 3000) : '（无）',
    })
    const { data, result } = await completeJson('architect', [{ role: 'user', content: prompt }])
    this.usage.add(result)

    const { proposals, notes } = this.outlineToProposals(data)
    const commit = this.commit(proposals)

    // 罗盘与卷是「结构」级信息，直接落盘（它们是规划产物不是事实提案，无需校验）
    const g = this.store.outlineGraph()
    const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    const compassRaw = rec.compass
    if (compassRaw && typeof compassRaw === 'object' && (compassRaw as Record<string, unknown>).endgame) {
      const cr = compassRaw as Record<string, unknown>
      g.compass = {
        endgame: String(cr.endgame ?? ''),
        active_threads: Array.isArray(cr.active_threads) ? cr.active_threads.map((t) => String(t)) : [],
        scale_estimate: String(cr.scale_estimate ?? ''),
        refresh_at: '第 1 卷末刷新',
      }
    }
    const vols = this.parseVolumes(rec.volumes)
    if (vols.length) {
      g.volumes = vols
      const total = vols.reduce((m, v) => Math.max(m, v.to_chapter || 0), 0)
      if (total) {
        const m = this.store.meta()
        m.chapters_total = Math.max(m.chapters_total, total)
        this.store.saveMeta(m)
      }
    }
    this.store.saveOutlineGraph(g)

    notes.push(g.compass.endgame ? `罗盘已设定：${g.compass.endgame.slice(0, 40)}…` : '罗盘未生成')
    return new ArchitectResult({ targets: ['outline'], proposals, commit, usage: this.usage, notes })
  }

  // ---------------- 滚动规划：展开骨架卷 ----------------

  async rollVolume(index = -1): Promise<ArchitectResult> {
    const graph = this.store.outlineGraph()
    if (!graph.volumes.length) {
      throw new Error('还没有卷纲，先执行一次大纲生成。')
    }
    let volume: Volume
    if (index < 0) {
      const skeleton = graph.volumes.filter((v) => v.status === 'skeleton')
      if (!skeleton.length) {
        throw new Error('没有待展开的骨架卷——所有卷都已经是详细章纲了。')
      }
      volume = skeleton[0]
    } else {
      if (index >= graph.volumes.length) {
        throw new Error(`卷序号超出范围（共 ${graph.volumes.length} 卷）。`)
      }
      volume = graph.volumes[index]
      if (volume.status === 'expanded') {
        throw new Error(`「${volume.name}」已经是详细章纲，无需重复展开。`)
      }
    }

    const frm = volume.from_chapter
    const to = volume.to_chapter || (frm + Math.max(1, volume.est_chapters) - 1)
    const prevs = this.store.summaries()
    const previous =
      prevs
        .slice(-12)
        .map((s) => `- 第 ${s.chapter} 章《${s.title}》：${s.summary}`)
        .join('\n') || '（这是第一卷，无前情）'

    this.scope(frm, 'plan')
    this.budgetGate()
    const prompt = fmt(prompts.ROLL_VOLUME, {
      genre: this.store.meta().genre,
      endgame: graph.compass.endgame || '（未定）',
      volume_name: volume.name,
      from_chapter: String(frm),
      to_chapter: String(to),
      goal: volume.goal || '（未定）',
      previous,
      threads: graph.compass.active_threads.join('、') || '（无）',
      characters: fmtCharacters(this.store.characters()),
      hooks: fmtHooks(this.store.hooks()),
    })
    const { data, result } = await completeJson('architect', [{ role: 'user', content: prompt }], {
      maxTokens: maxOutputFor('architect'),
    })
    this.usage.add(result)

    const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    const nodesRaw = rec.nodes
    if (!Array.isArray(nodesRaw) || !nodesRaw.length) {
      throw new Error('展开结果里没有 nodes，请重试。')
    }
    const proposals = this.nodesToProposals(nodesRaw, { volume, defaultPov: '' })
    proposals.push(...this.edgesToProposals(rec.edges))
    const commit = this.commit(proposals)

    const g = this.store.outlineGraph()
    for (const v of g.volumes) {
      if (v.name === volume.name) {
        v.status = 'expanded'
        v.to_chapter = to
      }
    }
    const compassRaw = rec.compass
    if (compassRaw && typeof compassRaw === 'object') {
      const cr = compassRaw as Record<string, unknown>
      if (cr.refresh_at) g.compass.refresh_at = String(cr.refresh_at)
      const threads = cr.active_threads
      if (Array.isArray(threads) && threads.length) {
        g.compass.active_threads = threads.map((t) => String(t))
      }
    }
    this.store.saveOutlineGraph(g)

    return new ArchitectResult({
      targets: [`volume:${volume.name}`],
      proposals,
      commit,
      usage: this.usage,
      notes: [`已展开 ${volume.name}（第 ${frm}–${to} 章）`],
    })
  }

  // ---------------- 单章章纲 ----------------

  async planChapter(chapter: number): Promise<ArchitectResult> {
    const graph = this.store.outlineGraph()
    const node = graphNode(graph, chapter)
    const neighbours = graph.nodes.filter((n) => Math.abs(n.chapter - chapter) === 1)
    const incoming = motivationsFor(graph, chapter)
    this.scope(chapter, 'plan')
    this.budgetGate()
    const volumeGoal = node ? (graph.volumes.find((v) => v.name === node.volume)?.goal ?? '') : ''
    const prompt = fmt(prompts.CHAPTER_PLAN, {
      chapter: String(chapter),
      genre: this.store.meta().genre,
      endgame: graph.compass.endgame || '（未定）',
      volume: node ? node.volume : '',
      volume_goal: volumeGoal,
      neighbours:
        neighbours.map((n) => `第 ${n.chapter} 章《${n.title}》${n.goal}`).join('；') || '（无）',
      previous:
        this.store.summaries().slice(-5).map((s) => `- 第 ${s.chapter} 章：${s.summary}`).join('\n') ||
        '（无）',
      characters: fmtCharacters(this.store.characters()),
      hooks: fmtHooks(this.store.hooks()),
      incoming: incoming.map((e) => `- 依赖第 ${e.to_chapter} 章：${e.note}`).join('\n') || '（无）',
    })
    const { data, result } = await completeJson('chapter_plan', [{ role: 'user', content: prompt }])
    this.usage.add(result)

    const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    const raw = rec.node
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('章纲生成结果里没有 node，请重试。')
    }
    const volume = node ? node.volume : ''
    const proposals = this.nodesToProposals([raw], { volume: null, defaultPov: '', volumeName: volume })
    proposals.push(...this.edgesToProposals(rec.new_edges))
    const commit = this.commit(proposals)
    return new ArchitectResult({ targets: [`chapter:${chapter}`], proposals, commit, usage: this.usage })
  }

  // ---------------- 解析辅助 ----------------

  private outlineToProposals(data: unknown): { proposals: Proposal[]; notes: string[] } {
    const notes: string[] = []
    if (typeof data !== 'object' || data === null) {
      throw new Error('大纲生成结果不是 JSON 对象，请重试。')
    }
    const rec = data as Record<string, unknown>
    const nodes = this.parseNodes(rec.nodes)
    if (!nodes.length) {
      throw new Error('大纲生成结果里没有有效的 nodes，请重试。')
    }
    const volumeOf: Record<number, string> = {}
    for (const v of this.parseVolumes(rec.volumes)) {
      for (let n = v.from_chapter; n <= (v.to_chapter || v.from_chapter); n++) {
        volumeOf[n] = v.name
      }
    }
    const proposals: Proposal[] = []
    for (const node of nodes) {
      if (!node.volume && node.chapter in volumeOf) {
        node.volume = volumeOf[node.chapter]
      }
      proposals.push(this.nodeProposal(node))
    }
    proposals.push(...this.edgesToProposals(rec.edges))
    notes.push(`已生成 ${nodes.length} 条章纲`)
    return { proposals, notes }
  }

  private nodesToProposals(
    rawNodes: unknown,
    opts: { volume: Volume | null; defaultPov: string; volumeName?: string },
  ): Proposal[] {
    const { volume, defaultPov, volumeName = '' } = opts
    const nodes = this.parseNodes(rawNodes, { volume, defaultPov, volumeName })
    return nodes.map((n) => this.nodeProposal(n))
  }

  private nodeProposal(node: OutlineNode): Proposal {
    return proposal('outline_upsert', { ...node }, {
      id: `outline_ch${node.chapter}`,
      reason: `第 ${node.chapter} 章章纲`,
      confidence: 'high',
    })
  }

  private parseNodes(
    rawNodes: unknown,
    opts: { volume?: Volume | null; defaultPov?: string; volumeName?: string } = {},
  ): OutlineNode[] {
    const { volume = null, defaultPov = '', volumeName = '' } = opts
    const out: OutlineNode[] = []
    if (!Array.isArray(rawNodes)) return out
    for (const raw of rawNodes) {
      if (typeof raw !== 'object' || raw === null) continue
      const rec = raw as Record<string, unknown>
      const chapter = Number(rec.chapter)
      if (!Number.isInteger(chapter)) continue
      if (chapter <= 0) continue
      const beats = Array.isArray(rec.beats)
        ? rec.beats.map((b) => String(b).trim()).filter(Boolean)
        : []
      const timeline: Array<{ at: string; label: string; kind: string }> = []
      for (const ev of Array.isArray(rec.timeline) ? rec.timeline : []) {
        if (typeof ev !== 'object' || ev === null) continue
        const evRec = ev as Record<string, unknown>
        const label = String(evRec.label ?? '').trim()
        if (!label) continue
        const kind = String(evRec.kind ?? '').trim()
        timeline.push({
          at: String(evRec.at ?? '').trim(),
          label,
          kind: ['backstory', 'flashback', 'now', 'future'].includes(kind) ? kind : 'now',
        })
      }
      const intensity = Number(rec.intensity || 3)
      out.push({
        chapter,
        title: String(rec.title ?? '').trim(),
        arc: String(rec.arc ?? '').trim() || (volume ? volume.name.split('·').slice(-1)[0].trim() : ''),
        volume: String(rec.volume || volumeName || (volume ? volume.name : '')),
        status: 'planned',
        goal: String(rec.goal ?? '').trim(),
        beats,
        rationale: String(rec.rationale ?? '').trim(),
        pov: String(rec.pov || defaultPov),
        intensity: Number.isFinite(intensity) ? Math.max(1, Math.min(5, intensity)) : 3,
        story_at: String(rec.story_at ?? '').trim(),
        timeline: timeline.slice(0, 6),
      })
    }
    out.sort((a, b) => a.chapter - b.chapter)
    return out
  }

  private parseVolumes(rawVols: unknown): Volume[] {
    const out: Volume[] = []
    if (!Array.isArray(rawVols)) return out
    for (const raw of rawVols) {
      if (typeof raw !== 'object' || raw === null) continue
      const rec = raw as Record<string, unknown>
      const name = String(rec.name ?? '').trim()
      if (!name) continue
      const frm = Number(rec.from_chapter || 1)
      const to = Number(rec.to_chapter || 0)
      const status = String(rec.status) === 'expanded' ? 'expanded' : 'skeleton'
      const est = Number(rec.est_chapters || (to ? to - frm + 1 : 0))
      out.push({
        name,
        from_chapter: Number.isFinite(frm) ? frm : 1,
        to_chapter: Number.isFinite(to) ? to : 0,
        goal: String(rec.goal ?? ''),
        est_chapters: Number.isFinite(est) ? est : 0,
        status,
        arc: String(rec.arc ?? '').trim() || name.split('·').slice(-1)[0].trim(),
      })
    }
    return out
  }

  private edgesToProposals(rawEdges: unknown): Proposal[] {
    const out: Proposal[] = []
    if (!Array.isArray(rawEdges)) return out
    const allowed = new Set(['motivation', 'setup', 'payoff', 'causality', 'parallel'])
    let i = 0
    for (const raw of rawEdges) {
      i += 1
      if (typeof raw !== 'object' || raw === null) continue
      const rec = raw as Record<string, unknown>
      const frm = Number(rec.from ?? rec.from_chapter)
      const to = Number(rec.to ?? rec.to_chapter)
      if (!Number.isInteger(frm) || !Number.isInteger(to)) continue
      if (frm === to) continue
      let etype = String(rec.type ?? 'causality')
      if (!allowed.has(etype)) etype = 'causality'
      const edge: OutlineEdge = {
        from_chapter: frm,
        to_chapter: to,
        type: etype as OutlineEdge['type'],
        note: String(rec.note ?? ''),
        confirmed: false,
      }
      out.push(
        proposal('edge_add', { ...edge }, {
          id: `edge_${frm}_${to}_${etype}_${i}`,
          reason: '依赖边',
          confidence: 'medium',
        }),
      )
    }
    return out
  }
}
