/**
 * Chat-first 立项（规划文档 §1.3「Chat-first：从一句话灵感开始，不填表」）——
 * 镜像 `server/dobi/agents/chat.py`。
 *
 * 多轮追问沉淀设定：每一轮不仅回话，还顺手把已确定的信息写进 `meta.json` 与
 * 会话状态（原版 `state/chat.json`，本地版落 localStorage），所以「聊完就能开工」——
 * 不需要作者再去填一遍表单。
 */

import { Agent } from './base'
import * as prompts from './prompts'
import { fmt } from './architect'
import type { ProjectStore } from '../store'
import { completeJson } from '../llm'

const FIELDS = ['genre', 'premise', 'protagonist', 'conflict', 'tone']

// ---------------------------------------------------------------------------
// 会话状态持久化（镜像原版 `state/chat.json`，本地版存 localStorage）
// ---------------------------------------------------------------------------

interface ChatState {
  records: Record<string, string>
  history: Array<{ role: string; text: string }>
}

const CHAT_KEY_PREFIX = 'dobi.chat.'

function readChatState(store: ProjectStore): ChatState {
  try {
    const raw = window.localStorage.getItem(CHAT_KEY_PREFIX + store.id)
    if (!raw) return { records: {}, history: [] }
    const parsed = JSON.parse(raw) as Partial<ChatState>
    return {
      records:
        parsed.records && typeof parsed.records === 'object'
          ? (parsed.records as Record<string, string>)
          : {},
      history: Array.isArray(parsed.history) ? (parsed.history as ChatState['history']) : [],
    }
  } catch {
    return { records: {}, history: [] }
  }
}

function writeChatState(store: ProjectStore, state: ChatState): void {
  try {
    window.localStorage.setItem(CHAT_KEY_PREFIX + store.id, JSON.stringify(state))
  } catch {
    /* 存储不可用时仅内存态 */
  }
}

// ---------------------------------------------------------------------------
// ChatAgent
// ---------------------------------------------------------------------------

export class ChatAgent extends Agent {
  // ---------------- 会话状态 ----------------

  records(): Record<string, string> {
    const raw = readChatState(this.store).records
    const out: Record<string, string> = {}
    for (const key of FIELDS) {
      out[key] = String(raw[key] ?? '')
    }
    return out
  }

  history(): Array<{ role: string; text: string }> {
    return readChatState(this.store).history
  }

  private save(records: Record<string, string>, history: Array<{ role: string; text: string }>): void {
    writeChatState(this.store, { records, history: history.slice(-40) })
  }

  // ---------------- 对话 ----------------

  async reply(message: string): Promise<Record<string, unknown>> {
    const meta = this.store.meta()
    const history = this.history()
    const records = this.records()

    this.scope(0, 'plan')
    this.budgetGate()
    const transcript =
      history
        .slice(-10)
        .map((m) => `${m.role === 'me' ? '作者' : '助手'}：${m.text ?? ''}`)
        .join('\n') || '（这是第一轮）'

    const { data, result } = await completeJson('chat', [
      {
        role: 'user',
        content: fmt(prompts.CHAT, {
          genre: meta.genre || '（待定）',
          premise: meta.premise || '（未填）',
          protagonist: records.protagonist || '（未定）',
          conflict: records.conflict || '（未定）',
          tone: records.tone || '（未定）',
          history: transcript,
          message,
        }),
      },
    ])
    this.usage.add(result)

    const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    const incoming = obj.records && typeof obj.records === 'object' ? (obj.records as Record<string, unknown>) : {}
    for (const key of FIELDS) {
      const value = String(incoming[key] ?? '').trim()
      if (value) records[key] = value
    }
    if (!records.premise) {
      records.premise = meta.premise
    }

    const replyText = String(obj.reply ?? '').trim() || '（模型没有给出回话，请重试）'
    const options = (Array.isArray(obj.options) ? obj.options.map((o) => String(o).trim()) : []).filter(Boolean)
    if (!options.some((o) => o.includes('自己'))) {
      options.push('我自己说')
    }

    history.push({ role: 'me', text: message })
    history.push({ role: 'ai', text: replyText })
    this.save(records, history)
    this.persistMeta(records)

    return {
      reply: replyText,
      options: options.slice(0, 4),
      records: Object.fromEntries(FIELDS.map((k) => [k, records[k] || '（尚未确立）'])),
      ready: Boolean(obj.ready),
      usage: this.usage.public(),
    }
  }

  // ---------------- 设定沉淀 ----------------

  private persistMeta(records: Record<string, string>): void {
    /** 已确定的信息落进 meta ——「聊完就能开工」靠的就是这一步。 */
    const meta = this.store.meta()
    let changed = false
    const genre = (records.genre ?? '').trim()
    if (genre && genre !== meta.genre && genre !== '待定') {
      meta.genre = genre
      changed = true
    }
    const premise = (records.premise ?? '').trim()
    if (premise && premise !== meta.premise) {
      meta.premise = premise
      if (!meta.logline) {
        meta.logline = premise
      }
      changed = true
    }
    const parts = [records.protagonist ?? '', records.conflict ?? ''].filter((x) => x.trim())
    if (parts.length) {
      const line = parts.map((p) => p.trim()).join('；')
      if (line !== meta.logline) {
        meta.logline = line
        changed = true
      }
    }
    if (changed) {
      this.store.saveMeta(meta)
    }
  }

  seed(): Record<string, unknown> {
    /** 首屏展示的立项要点（对应原型的「项目记录」面板）。 */
    const meta = this.store.meta()
    const records = this.records()
    const ready = Boolean(meta.premise) && meta.genre !== '' && meta.genre !== '待定'
    return {
      genre: meta.genre,
      premise: meta.premise || '（尚未确立）',
      protagonist: records.protagonist || '（尚未确立）',
      coreConflict: records.conflict || '（尚未确立）',
      tone: records.tone || '（尚未确立）',
      readyForPlan: ready,
      updatedAt: meta.updated_at,
    }
  }
}
