/**
 * 模型输出的 JSON 容错解析 —— 镜像 `server/dobi/llm/jsonutil.py`。
 *
 * 四级降级：
 * 1. 直接 JSON.parse
 * 2. 剥离 ```json … ``` 代码块后重试
 * 3. 截取首个括号平衡的 `{…}` / `[…]` 片段，再修掉尾逗号、单引号键、中文全角引号
 * 4. 全失败 → 抛 JSONExtractError，由调用方带上错误信息重试一次
 */

export class JSONExtractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JSONExtractError'
  }
}

const FENCE_RE = /```(?:json|JSON|javascript|js)?\s*\n?(.*?)```/gs
const TRAILING_COMMA_RE = /,(\s*[}\]])/g
const SMART_QUOTES: Array<[string, string]> = [
  ['\u201c', '"'],
  ['\u201d', '"'],
  ['\u2018', "'"],
  ['\u2019', "'"],
  ['\uff02', '"'],
]
// 形如  { key: ... } / , key: ... 的裸键（模型偶尔漏引号）
const BARE_KEY_RE = /([{,]\s*)([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff-]*)(\s*:)/g
const TRAILING_TEXT_RE = /[\s。．，,.]+$/

export function looksLikeJson(text: string): boolean {
  const stripped = (text || '').trim()
  return stripped.startsWith('{') || stripped.startsWith('[')
}

/** 截取首个括号平衡片段。字符串内的括号不计入深度。 */
function balancedSlice(text: string): string | null {
  let start = -1
  let opener = ''
  let closer = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{' || ch === '[') {
      start = i
      opener = ch
      closer = ch === '{' ? '}' : ']'
      break
    }
  }
  if (start === -1) return null

  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === opener) depth += 1
    else if (ch === closer) {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  // 未闭合：模型被 max_tokens 截断。返回剩余全部，交给 _repair 修补。
  return text.slice(start)
}

function repair(fragment: string): string {
  let fixed = fragment
  for (const [bad, good] of SMART_QUOTES) fixed = fixed.split(bad).join(good)
  fixed = fixed.replace(TRAILING_COMMA_RE, '$1')
  fixed = fixed.replace(BARE_KEY_RE, '$1"$2"$3')
  // 截断补救：补齐未闭合的引号与括号
  if (fixed.split('"').length % 2 === 0) fixed += '"'
  for (const [o, c] of [['{', '}'], ['[', ']']] as Array<[string, string]>) {
    const diff = fixed.split(o).length - 1 - (fixed.split(c).length - 1)
    if (diff > 0) fixed += c.repeat(diff)
  }
  return fixed.replace(TRAILING_TEXT_RE, '')
}

/** 把模型输出解析成对象。失败抛 JSONExtractError。 */
export function extractJson(text: string): unknown {
  const raw = (text || '').trim()
  if (!raw) throw new JSONExtractError('模型返回了空内容')

  // 1) 直接解析
  try {
    return JSON.parse(raw)
  } catch {
    /* 继续降级 */
  }

  const candidates: string[] = []

  // 2) 代码块
  for (const m of raw.matchAll(FENCE_RE)) {
    candidates.push(m[1])
  }

  // 3) 平衡片段
  const sliced = balancedSlice(raw)
  if (sliced) candidates.push(sliced)

  candidates.push(raw)

  for (const cand of candidates) {
    for (const attempt of [cand, repair(cand)]) {
      try {
        return JSON.parse(attempt.trim())
      } catch {
        /* 继续 */
      }
    }
  }

  const preview = raw.slice(0, 400).replace(/\n/g, ' ')
  throw new JSONExtractError(`无法从模型输出中解析出 JSON。原文开头：${preview}`)
}
