/**
 * 本地核心工具函数 —— 镜像 `server/dobi/core/store.py` 与 `metering.py` 的纯函数部分。
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
const LATIN_WORD_RE = /[A-Za-z0-9']+/g
const SLUG_RE = /[^a-z0-9]+/g

/** 中文字符数 + 拉丁词数（网文平台通行口径） */
export function countWords(text: string): number {
  if (!text) return 0
  return (text.match(CJK_RE)?.length ?? 0) + (text.match(LATIN_WORD_RE)?.length ?? 0)
}

export function slugify(text: string, fallback = 'project'): string {
  const ascii = ((text || '').trim().toLowerCase()).replace(SLUG_RE, '-').replace(/^-+|-+$/g, '')
  return ascii || fallback
}

export function nowIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  const abs = Math.abs(tz)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

export function todayStr(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 生成 8 位十六进制短 id（sha1 前缀，等价于 Python 的 hexdigest()[:8]） */
export function shortId(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(16).padStart(8, '0').slice(0, 8)
}

/** 生成 16 位幂等键（等价于 sha256 前 16 位） */
export function idemKey(chapter: number, step: string, salt = ''): string {
  const raw = `${chapter}:${step}:${salt}`
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x1000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/** 本地 token 估算（镜像 estimate_tokens；只用于预算预检，不用于记账） */
const PUNCT_RE = /[\s，。！？、；：,.!?;:"'（）()【】\[\]—…·]+/g
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK_RE)?.length ?? 0
  const words = text.match(LATIN_WORD_RE) ?? []
  const latinChars = words.reduce((s, w) => s + w.length, 0)
  const latin = Math.max(words.length * 1.3, latinChars / 4)
  const punct = text.match(PUNCT_RE)?.length ?? 0
  return Math.floor(cjk / 1.6 + latin + punct * 0.5) + 1
}

/** 去掉标点与空白的归一化（用于相似度比较） */
export function normText(text: string): string {
  return (text || '').replace(/[\s，。！？、；：,.!?;:"'（）()【】\[\]]+/g, '')
}

/** 序列相似度（简化版 SequenceMatcher.ratio —— 编辑距离） */
export function similarity(a: string, b: string): number {
  if (!a && !b) return 1
  if (!a || !b) return 0
  const m = normText(a)
  const n = normText(b)
  if (!m || !n) return 0
  const dist = levenshtein(m, n)
  const maxLen = Math.max(m.length, n.length)
  return maxLen === 0 ? 1 : 1 - dist / maxLen
}

function levenshtein(a: string, b: string): number {
  const dp: number[] = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) dp[j] = j
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[b.length]
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 脱敏指纹：取前 3 后 2，中间以 * 遮蔽（镜像 config.mask） */
export function maskKey(key: string): string {
  if (!key) return ''
  const s = key.trim()
  if (s.length <= 6) return '***'
  return `${s.slice(0, 3)}***${s.slice(-2)}`
}
