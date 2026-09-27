/**
 * 滚动规划 —— 镜像 `server/dobi/orchestrator/planning.py`。
 *
 * 不一次性规划全部章节 —— 大纲到 300 章必然空心化。三层结构：
 *
 * - **罗盘 Compass**：终局方向 + 活跃长线 + 规模估计，每个卷边界刷新
 * - **骨架弧**：只记 `目标 + 预估章数`，写到该弧才展开详细章纲
 * - **渐进细化**：展开时参考前文摘要、角色快照、风格规则
 *
 * 初始只规划前 2 卷。
 */

import { Architect } from '../agents'
import { graphNode } from '../memory'
import { Meter } from '../metering'
import type { ProjectStore } from '../store'
import type { CommitResult } from '../types'

export class PlanOutcome {
  action = ''
  changed: string[] = []
  cost = 0.0
  notes: string[] = []
  issues: Array<Record<string, unknown>> = []
  pending: Array<Record<string, unknown>> = []

  constructor(init: { action?: string } = {}) {
    if (init.action !== undefined) this.action = init.action
  }

  public(): Record<string, unknown> {
    return {
      action: this.action,
      changed: this.changed,
      cost: Math.round(this.cost * 10000) / 10000,
      notes: this.notes,
      issues: this.issues,
      pending: this.pending,
    }
  }
}

export class Planner {
  readonly store: ProjectStore
  readonly meter: Meter
  readonly architect: Architect

  constructor(store: ProjectStore, meter?: Meter | null) {
    this.store = store
    this.meter = meter ?? new Meter(store)
    this.architect = new Architect(store, this.meter)
  }

  // ---------------- 立项：世界观 → 角色 → 大纲 ----------------

  async bootstrap(opts: { volumes?: number; targets?: string[] } = {}): Promise<PlanOutcome> {
    const { volumes = 2, targets = ['world', 'characters', 'outline'] } = opts
    const outcome = new PlanOutcome({ action: 'bootstrap' })
    const costBefore = this.meter.used

    if (targets.includes('world')) {
      const res = await this.architect.buildWorld()
      outcome.changed.push('世界观')
      outcome.notes.push(...res.notes)
      collect(outcome, res.commit)
    }
    if (targets.includes('characters')) {
      const res = await this.architect.buildCharacters()
      outcome.changed.push('角色')
      collect(outcome, res.commit)
    }
    if (targets.includes('outline')) {
      const res = await this.architect.buildOutline({ volumes })
      outcome.changed.push('大纲与依赖图')
      outcome.notes.push(...res.notes)
      collect(outcome, res.commit)
    }

    outcome.cost = Math.round((this.meter.used - costBefore) * 10000) / 10000
    const graph = this.store.outlineGraph()
    outcome.notes.push(
      `当前规划：${graph.volumes.length} 卷 · ${graph.nodes.length} 条章纲 · ` +
        `${graph.edges.length} 条依赖边`,
    )
    return outcome
  }

  // ---------------- 展开下一卷骨架 ----------------

  async rollNext(): Promise<PlanOutcome> {
    const outcome = new PlanOutcome({ action: 'roll' })
    const costBefore = this.meter.used
    const res = await this.architect.rollVolume(-1)
    outcome.changed.push(...res.targets)
    outcome.notes.push(...res.notes)
    collect(outcome, res.commit)
    outcome.cost = Math.round((this.meter.used - costBefore) * 10000) / 10000
    return outcome
  }

  // ---------------- 覆盖率视图 ----------------

  coverage(): Record<string, unknown> {
    const graph = this.store.outlineGraph()
    const nodes = new Map(graph.nodes.map((n) => [n.chapter, n]))
    const expanded = graph.volumes.filter((v) => v.status === 'expanded')
    const skeleton = graph.volumes.filter((v) => v.status === 'skeleton')
    const detailNodes = graph.nodes.filter((n) => n.goal && n.beats.length)
    return {
      compass: { ...graph.compass },
      volumes: graph.volumes.map((v) => ({
        name: v.name,
        from: v.from_chapter,
        to: v.to_chapter,
        status: v.status,
        goal: v.goal,
        chapters: v.to_chapter ? Math.max(0, v.to_chapter - v.from_chapter + 1) : v.est_chapters,
      })),
      expandedVolumes: expanded.length,
      skeletonVolumes: skeleton.length,
      nodes: graph.nodes.length,
      detailedNodes: detailNodes.length,
      edges: graph.edges.length,
      unconfirmedEdges: graph.edges.filter((e) => !e.confirmed).length,
      chapterRange: [
        nodes.size ? Math.min(...nodes.keys()) : 0,
        nodes.size ? Math.max(...nodes.keys()) : 0,
      ],
      skeletonChapters: graph.nodes
        .filter((n) => n.status === 'skeleton')
        .map((n) => n.chapter)
        .sort((a, b) => a - b),
    }
  }

  // ---------------- 写第 N 章前的规划保障 ----------------

  async ensureForChapter(chapter: number): Promise<PlanOutcome | null> {
    /** 若第 N 章落在未展开的骨架卷里，先展开；若章纲缺失，补一条。 */
    const graph = this.store.outlineGraph()
    const volume = graph.volumes.find(
      (v) =>
        v.from_chapter <= chapter &&
        chapter <= (v.to_chapter || v.from_chapter + Math.max(1, v.est_chapters) - 1),
    )
    if (volume !== undefined && volume.status === 'skeleton') {
      const index = graph.volumes.indexOf(volume)
      const outcome = new PlanOutcome({ action: 'roll' })
      const costBefore = this.meter.used
      const res = await this.architect.rollVolume(index)
      outcome.changed.push(...res.targets)
      outcome.notes.push(...res.notes)
      collect(outcome, res.commit)
      outcome.cost = Math.round((this.meter.used - costBefore) * 10000) / 10000
      return outcome
    }

    const node = graphNode(graph, chapter)
    if (node === null || node.beats.length === 0) {
      const outcome = new PlanOutcome({ action: 'plan_chapter' })
      const costBefore = this.meter.used
      const res = await this.architect.planChapter(chapter)
      outcome.changed.push(`第 ${chapter} 章章纲`)
      collect(outcome, res.commit)
      outcome.cost = Math.round((this.meter.used - costBefore) * 10000) / 10000
      return outcome
    }
    return null
  }
}

function collect(outcome: PlanOutcome, commit: CommitResult | null): void {
  if (commit === null) return
  outcome.issues.push(...commit.issues.map((i) => ({ ...i })))
  outcome.pending.push(...commit.pending.map((p) => ({ ...p })))
}
