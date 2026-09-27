/**
 * API 序列化：内部 snake_case ⇄ 前端 camelCase（镜像 `server/dobi/api/serialize.py`）。
 *
 * 转换是机械的：只改键名大小写，不改结构、不丢字段。递归进列表与嵌套结构。
 */

/** 已经是前端约定的键，不参与转换 */
const KEEP = new Set(['from', 'to', 'id', 'n', 'ref', 'url', 'command'])

function toCamel(name: string): string {
  if (KEEP.has(name) || !name) return name
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

function toSnake(name: string): string {
  if (KEEP.has(name) || !name) return name
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

type PlainRecord = Record<string, unknown>

function isRecord(v: unknown): v is PlainRecord {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 内部 snake_case → 前端 camelCase（递归） */
export function toApi(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => toApi(v))
  if (isRecord(value)) {
    const out: PlainRecord = {}
    for (const [k, v] of Object.entries(value)) {
      out[toCamel(k)] = toApi(v)
    }
    return out
  }
  return value
}

/** 前端 camelCase → 内部 snake_case（递归，供请求体读取） */
export function fromApi(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => fromApi(v))
  if (isRecord(value)) {
    const out: PlainRecord = {}
    for (const [k, v] of Object.entries(value)) {
      out[toSnake(k)] = fromApi(v)
    }
    return out
  }
  return value
}
