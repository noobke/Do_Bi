/**
 * 本地持久化：每个项目一条 JSON 记录，存 localStorage。
 *
 * 等价于原后端的「9 个真相文件 + chapters/audits/reviews/checkpoints/usage」，
 * 但合并在一条记录里，写入即原子（JSON.stringify 整体落盘）。
 *
 * - `dobi.projects`          项目 id 有序索引
 * - `dobi.projects.<id>`     单个项目全部真相数据
 * - `dobi.currentProject`    当前项目（web/src/state/project.ts 已占用）
 */

import type { ProjectRecord } from './types'
import { nowIso } from './util'

const INDEX_KEY = 'dobi.projects'
const RECORD_PREFIX = 'dobi.projects.'

export function readProjectIndex(): string[] {
  try {
    const raw = window.localStorage.getItem(INDEX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function writeProjectIndex(ids: string[]): void {
  try {
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(ids))
  } catch {
    /* 存储不可用时仅内存态 */
  }
}

export function readProject(id: string): ProjectRecord | null {
  try {
    const raw = window.localStorage.getItem(RECORD_PREFIX + id)
    if (!raw) return null
    return JSON.parse(raw) as ProjectRecord
  } catch {
    return null
  }
}

export function writeProject(record: ProjectRecord): void {
  record.updated_at = nowIso()
  try {
    window.localStorage.setItem(RECORD_PREFIX + record.meta.id, JSON.stringify(record))
  } catch {
    /* 存储不可用时仅内存态 */
  }
}

export function deleteProject(id: string): void {
  try {
    window.localStorage.removeItem(RECORD_PREFIX + id)
  } catch {
    /* ignore */
  }
}

export function readCurrent(): string | null {
  try {
    return window.localStorage.getItem('dobi.currentProject')
  } catch {
    return null
  }
}

export function writeCurrent(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem('dobi.currentProject')
    else window.localStorage.setItem('dobi.currentProject', id)
  } catch {
    /* ignore */
  }
}
