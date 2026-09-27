/**
 * Writer：章纲 + 上下文 + 文风档案 → 章节正文（流式）。**唯一产出正文的角色。**
 *
 * 镜像 `server/dobi/agents/writer.py`。流式语义：
 * - 逐段回调 `onDelta`，前端可以边生成边显示
 * - 支持 `shouldStop()` 中途停止，**已生成的部分立即落盘为草稿**（不丢稿）
 * - 中断后重新调用会自动带上已写内容作为「续写起点」，不重复生成
 */

import { Agent, Usage } from './base'
import * as prompts from './prompts'
import { presentCharacters, fmt } from './architect'
import { stream, windowFor, type ChatResult, type Message } from '../llm'
import { buildContext, type ContextBundle } from '../context'
import { graphNode } from '../memory'
import type { OutlineNode } from '../types'

export function splitParagraphs(text: string): string[] {
  /** 按空行切段；顺带吃掉模型爱加的各种标题行与分隔线。 */
  let cleaned = (text || '').replace(/^\s*(?:#+\s*)?第\s*\d+\s*章[^\n]*\n/, '')
  cleaned = cleaned.replace(/^\s*[-—=*]{3,}\s*$/gm, '')
  const parts = cleaned.split(/\n\s*\n+/).map((p) => p.trim())
  return parts.filter((p) => p && !['（本章完）', '(本章完)', '本章完'].includes(p))
}

export class WriteResult {
  chapter: number
  title: string
  paragraphs: string[] = []
  words = 0
  cancelled = false
  usage: Usage
  context: ContextBundle | null = null
  result: ChatResult | null = null

  constructor(init: {
    chapter: number
    title?: string
    paragraphs?: string[]
    words?: number
    cancelled?: boolean
    usage?: Usage
    context?: ContextBundle | null
    result?: ChatResult | null
  }) {
    this.chapter = init.chapter
    this.title = init.title ?? ''
    if (init.paragraphs) this.paragraphs = init.paragraphs
    this.words = init.words ?? 0
    this.cancelled = init.cancelled ?? false
    this.usage = init.usage ?? new Usage()
    if (init.context !== undefined) this.context = init.context
    if (init.result !== undefined) this.result = init.result
  }

  public(): Record<string, unknown> {
    return {
      chapter: this.chapter,
      title: this.title,
      words: this.words,
      paragraphs: this.paragraphs.length,
      cancelled: this.cancelled,
      usage: this.usage.public(),
      context: this.context ? this.context.public() : null,
    }
  }
}

/** 章纲缺失时给一个最小可用节点，保证「能写」优先于「必须有序」 */
function minimalNode(chapter: number): OutlineNode {
  return {
    chapter,
    title: '',
    goal: '',
    pov: '',
    arc: '',
    volume: '',
    status: 'planned',
    beats: [],
    rationale: '',
    intensity: 3,
    story_at: '',
    timeline: [],
  }
}

export class Writer extends Agent {
  async write(
    chapter: number,
    opts: {
      onDelta?: (delta: string) => void
      shouldStop?: () => boolean
      continueDraft?: boolean
      temperature?: number | null
    } = {},
  ): Promise<WriteResult> {
    const { onDelta, shouldStop, continueDraft = true, temperature = null } = opts
    const store = this.store
    const meta = store.meta()
    const graph = store.outlineGraph()
    const node = graphNode(graph, chapter) ?? minimalNode(chapter)

    const existing = store.readChapter(chapter)
    let draftText = continueDraft ? store.chapterText(chapter) : ''
    if (store.readAudit(chapter) !== null) {
      draftText = '' // 已进入审查阶段的章节，重写时不当续写处理
    }

    const charactersPresent = presentCharacters(
      store,
      [node.goal, ...node.beats, node.pov, draftText.slice(-400)].join(' '),
    )

    const bundle = buildContext(store, chapter, {
      purpose: 'writer',
      contextWindow: windowFor('writer'),
      node,
      draft: draftText,
      charactersPresent: charactersPresent.length ? charactersPresent : null,
    })

    const beats =
      node.beats.map((b, i) => `  ${i + 1}. ${b}`).join('\n') || '  （无，按目标自由推进）'
    let previousTail = ''
    if (draftText.trim()) {
      const tail = draftText.trim().slice(-500)
      previousTail = `\n【已写部分（请从这之后无缝续写，不要重复）】\n…${tail}\n`
    }

    const messages: Message[] = [
      ...bundle.messages,
      {
        role: 'user',
        content: fmt(prompts.WRITER_TASK, {
          chapter,
          title: node.title || `第 ${chapter} 章`,
          goal: node.goal || '（未明确，按上文自然推进）',
          beats,
          rationale: node.rationale || '（未给出）',
          previous_tail: previousTail,
          target_words: Math.max(800, meta.words_per_chapter - (draftText ? existing.words : 0)),
        }),
      },
    ]

    this.scope(chapter, 'draft')
    this.budgetGate()
    const cp = this.cp.begin(chapter, 'draft', {
      note: draftText.trim() ? '续写' : '新写',
    })

    const chunks: string[] = []
    const resultHolder: { result?: ChatResult } = {}

    const capture = (res: ChatResult): void => {
      resultHolder.result = res
      this.usage.add(res)
    }

    let cancelled = false
    try {
      for await (const delta of stream('writer', messages, {
        temperature: temperature ?? undefined,
        onResult: capture,
      })) {
        chunks.push(delta)
        if (onDelta) onDelta(delta)
        if (shouldStop && shouldStop()) {
          cancelled = true
          break
        }
      }
    } catch (e) {
      // 已生成的部分必须保住 —— 这是「不丢稿」的底线。
      const partial = chunks.join('')
      if (partial.trim()) {
        const paragraphs = splitParagraphs(partial)
        store.writeChapter(chapter, paragraphs, {
          title: node.title || existing.title,
          status: 'draft',
          pov: node.pov || existing.pov,
        })
        const kept = paragraphs.reduce((s, p) => s + p.length, 0)
        this.cp.fail(cp, { note: `生成中断，已保留 ${kept} 字草稿` })
      }
      throw e
    }

    const text = chunks.join('')
    let paragraphs = splitParagraphs(text)

    if (draftText.trim() && !cancelled) {
      // 续写模式：把旧内容与新内容拼接（旧内容按段去重，避免模型把上文又写一遍）
      const old = splitParagraphs(draftText)
      const merged: string[] = [...old]
      for (const para of paragraphs) {
        if (!merged.length || para !== merged[merged.length - 1]) {
          merged.push(para)
        }
      }
      paragraphs = merged
    }

    const data = store.writeChapter(chapter, paragraphs, {
      title: node.title || existing.title,
      status: 'draft',
      pov: node.pov || existing.pov,
    })

    const final = resultHolder.result
    const tokens = final ? final.usage.total_tokens : 0
    this.cp.finish(cp, {
      status: 'ok',
      output_ref: `chapters/ch_${String(chapter).padStart(4, '0')}.md`,
      tokens,
      cost: this.usage.cost,
      note: `${data.words} 字` + (cancelled ? '（用户中途停止，已保存半成品）' : ''),
    })

    return new WriteResult({
      chapter,
      title: data.title,
      paragraphs,
      words: data.words,
      cancelled,
      usage: this.usage,
      context: bundle,
      result: final,
    })
  }
}
