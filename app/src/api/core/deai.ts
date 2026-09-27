/**
 * 反 AIGC / 去 AI 味管线 —— 镜像 `server/dobi/consistency/deai.py`。
 *
 * 闭环：定位（L1 违规） → 定点修复（模型只改违规句，不整段重写）
 * → 重跑 L1 → 归零即收敛。
 *
 * 安全阀：循环上限 **2 轮**，超限标记 `needs_human=True`，绝不死循环烧钱。
 */

import type { L1Violation, StyleProfile } from './types'
import { completeJson, type Message } from './llm'
import { checkL1, type L1Result } from './l1'
import { styleInjectionText, styleIsEmpty } from './style'

/** 属于「去 AI 味」范畴的 L1 规则名（收敛判据只看这些；伏笔/数值等与文风无关） */
export const DEAI_RULE_NAMES: ReadonlySet<string> = new Set([
  '禁用句式命中', '套话密度超阈值', '连续「了／的」字句', '词汇疲劳', '段落长度异常',
])

export const MAX_ROUNDS_DEFAULT = 2

export class DeaiResult {
  before: string
  after: string
  rounds: number
  detected: Array<Record<string, unknown>>   // [{pattern, count, samples[]}]
  patches: Array<Record<string, unknown>>    // [{para, before, after, reason}]
  l1_before: L1Result | null
  l1_after: L1Result | null
  converged: boolean       // 重跑 L1 后无命中的确定性违规
  needs_human: boolean     // 超过循环上限仍未收敛

  constructor(before: string, after: string, l1Before: L1Result | null = null) {
    this.before = before
    this.after = after
    this.rounds = 0
    this.detected = []
    this.patches = []
    this.l1_before = l1Before
    this.l1_after = l1Before
    this.converged = false
    this.needs_human = false
  }

  /** 给前端/持久化的 API 形态（camelCase，镜像 Python to_dict） */
  toDict(): Record<string, unknown> {
    return {
      before: this.before,
      after: this.after,
      rounds: this.rounds,
      detected: this.detected,
      patches: this.patches,
      l1Before: this.l1_before ? { violations: this.l1_before.violations, checked: this.l1_before.checked } : null,
      l1After: this.l1_after ? { violations: this.l1_after.violations, checked: this.l1_after.checked } : null,
      converged: this.converged,
      needsHuman: this.needs_human,
    }
  }
}

function deaiViolations(l1: L1Result): L1Violation[] {
  return l1.violations.filter((v) => DEAI_RULE_NAMES.has(v.rule))
}

/** 定位「AI 味」问题点。确定性、零模型成本——直接消费 L1 的确定性违规。 */
export function detect(
  _text: string,
  _style: StyleProfile | null,
  l1: L1Result,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const v of deaiViolations(l1)) {
    out.push({
      pattern: v.rule,
      count: v.count,
      samples: v.samples.length ? v.samples : (v.hit ? [v.hit] : []),
    })
  }
  return out
}

function buildMessages(
  chapter: number,
  text: string,
  style: StyleProfile | null,
  detected: Array<Record<string, unknown>>,
): Message[] {
  const system =
    '你是一位中文小说润色编辑，任务是**定点修复**AI 味表达。\n' +
    '硬性要求：\n' +
    '1. **只改被指出问题的句子，不整段重写**，不改变原意、人物关系与上下文衔接；\n' +
    '2. 保留原有的叙事节奏与信息量，能小改就不大改；\n' +
    '3. 输出 JSON Patch：{"patches":[{"para":段落号,"before":"原句逐字",' +
    '"after":"改写后","reason":"改动理由"}]}；\n' +
    '4. `para` 是下面列出的段落序号（1 起）；`before` 必须是与原文**逐字一致**的片段，' +
    '否则该补丁会被丢弃；\n' +
    '5. 没有可改的地方就输出 {"patches":[]}。\n' +
    '不要输出解释文字、不要 Markdown 代码块围栏。'

  const parts: string[] = [`# 待修复章节：第 ${chapter} 章`]
  parts.push('## 命中问题（需要定点修复）')
  for (const d of detected) {
    const samples = (d.samples as unknown[]).slice(0, 6).map((s) => String(s)).join('；')
    parts.push(`- ${d.pattern}（${d.count} 处）：${samples}`)
  }
  if (style && style.banned_expressions.length) {
    parts.push('## 本章需避免的禁用表达')
    parts.push(style.banned_expressions.join(' / '))
  }
  if (style && !styleIsEmpty(style)) {
    parts.push('## 文风档案')
    parts.push(styleInjectionText(style))
  }
  parts.push('## 正文（按段落编号）')
  text.split('\n\n').forEach((p, i) => {
    parts.push(`【第 ${i + 1} 段】${p}`)
  })
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
  ]
}

function extractPatches(obj: unknown): Array<Record<string, unknown>> {
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>
    const val = o.patches ?? o.patch ?? o.items
    if (Array.isArray(val)) {
      return val.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    }
  }
  if (Array.isArray(obj)) {
    return obj.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
  }
  return []
}

/** 按 para 序号替换段落内的 before 片段。
 *  `before` 与现段落做包含性校验——不匹配则跳过（防止模型瞎改）。
 *  返回 (新正文, 实际生效的补丁列表)。
 */
function applyPatches(text: string, patches: Array<Record<string, unknown>>): [string, Array<Record<string, unknown>>] {
  const paras = text.split('\n\n')
  const applied: Array<Record<string, unknown>> = []
  for (const p of patches) {
    const idx = Number(p.para ?? 0)
    if (!Number.isInteger(idx)) continue
    const before = String(p.before ?? '')
    const after = String(p.after ?? '')
    if (!(idx >= 1 && idx <= paras.length) || !before) continue
    const cur = paras[idx - 1]
    if (!cur.includes(before)) continue   // 逐字包含性校验，不匹配直接跳过
    paras[idx - 1] = cur.replace(before, after)
    applied.push({
      para: idx,
      before,
      after,
      reason: String(p.reason ?? '').trim(),
    })
  }
  return [paras.join('\n\n'), applied]
}

/** 去 AI 味闭环：定位 → 定点修复 → 重跑 L1，最多 `maxRounds` 轮。 */
export async function stripAi(
  chapter: number,
  text: string,
  style: StyleProfile | null = null,
  maxRounds: number = MAX_ROUNDS_DEFAULT,
): Promise<DeaiResult> {
  const before = text
  let current = text
  const l1Before = checkL1({ text: before, chapter, characters: [], hooks: [], world_rules: [], style })
  const result = new DeaiResult(before, text, l1Before)

  // 起始即无问题 → 直接收敛
  if (!deaiViolations(l1Before).length) {
    result.converged = true
    return result
  }

  let rounds = 0
  const allPatches: Array<Record<string, unknown>> = []
  let lastDetected: Array<Record<string, unknown>> = [...detect(current, style, l1Before)]

  for (let i = 0; i < Math.max(0, maxRounds); i++) {
    const l1Cur = checkL1({ text: current, chapter, characters: [], hooks: [], world_rules: [], style })
    const detected = detect(current, style, l1Cur)
    if (!detected.length) break
    lastDetected = detected
    rounds += 1
    const { data } = await completeJson('deai', buildMessages(chapter, current, style, detected))
    const [nextText, applied] = applyPatches(current, extractPatches(data))
    current = nextText
    allPatches.push(...applied)
    if (!applied.length) {
      // 模型没给出可用补丁 → 本轮无进展，不再重试
      break
    }
  }

  const l1After = checkL1({ text: current, chapter, characters: [], hooks: [], world_rules: [], style })
  const converged = deaiViolations(l1After).length === 0

  result.after = current
  result.rounds = rounds
  result.detected = lastDetected
  result.patches = allPatches
  result.l1_after = l1After
  result.converged = converged
  result.needs_human = !converged
  return result
}
