/**
 * Agent 公共基类 —— 镜像 `server/dobi/agents/base.py`。
 *
 * 三件事：**计量归集**、**checkpoint 打点**、**提案提交**。子类只管业务逻辑。
 */

import type { ProjectStore } from '../store'
import type { ChatResult } from '../llm'
import { Meter } from '../metering'
import { CheckpointManager } from '../checkpoint'
import { setScope } from '../llm'

export const ROLE_TO_STEP: Record<string, string> = {
  architect: 'plan',
  chapter_plan: 'plan',
  chat: 'plan',
  writer: 'draft',
  audit_l2: 'audit',
  review: 'review',
  deai: 'deai',
  steer: 'steer',
  archivist: 'commit',
  style_analyze: 'style',
  disassemble: 'disassemble',
}

export class Usage {
  calls = 0
  prompt_tokens = 0
  completion_tokens = 0
  cost = 0
  latency_ms = 0
  models: string[] = []
  adapted: string[] = []

  add(result: ChatResult | null): void {
    if (!result) return
    this.calls += 1
    this.prompt_tokens += result.usage.prompt_tokens
    this.completion_tokens += result.usage.completion_tokens
    this.cost += result.cost
    this.latency_ms += result.latency_ms
    const label = `${result.provider}/${result.model}`
    if (!this.models.includes(label)) this.models.push(label)
    for (const note of result.adaptations) {
      if (!this.adapted.includes(note)) this.adapted.push(note)
    }
  }

  get total_tokens(): number {
    return this.prompt_tokens + this.completion_tokens
  }

  public(): Record<string, unknown> {
    return {
      calls: this.calls,
      tokens: {
        prompt_tokens: this.prompt_tokens,
        completion_tokens: this.completion_tokens,
        total_tokens: this.total_tokens,
      },
      cost: Math.round(this.cost * 10000) / 10000,
      latencyMs: this.latency_ms,
      models: this.models,
      adaptations: this.adapted,
    }
  }
}

export abstract class Agent {
  readonly store: ProjectStore
  readonly meter: Meter
  readonly cp: CheckpointManager
  readonly usage: Usage

  constructor(store: ProjectStore, meter?: Meter | null) {
    this.store = store
    this.meter = meter ?? new Meter(store)
    this.cp = new CheckpointManager(store)
    this.usage = new Usage()
  }

  /** 告诉计量层「现在在哪个环节」，账目才能归对位置。 */
  scope(chapter: number, step: string): void {
    setScope({ chapter, step })
  }

  /** 模型调用前的预算预检。超额抛错，由上层挂起。 */
  budgetGate(estimated = 0): void {
    this.meter.checkBudget(estimated)
  }
}
