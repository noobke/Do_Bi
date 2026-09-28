/**
 * 作品导出 —— 把已成稿的正文与设定整理成可存档的纯文本文件。
 *
 * 与「导出文风档案」（pages/Style.tsx）同一套做法：Blob + 隐藏 `<a>` 触发浏览器下载，
 * 不走后端接口。内容只取真实存在的数据字段，**不伪造任何字段**：
 * 没有的章节不会补空位，没有的设定不会编造。
 */

/** 触发一次下载；用完立即释放对象 URL */
export function downloadTextFile(
  filename: string,
  text: string,
  mime = 'text/plain;charset=utf-8',
): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** 作品名 → 安全文件名（替换文件系统不允许的字符），空名给一个兜底 */
export function safeFilename(name: string): string {
  const s = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  return s || '未命名作品'
}

/** 导出时刻，形如 `2026-09-28 00:14`；写进导出内容里，便于日后核对版本 */
export function nowStamp(): string {
  const d = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 「第 N 章 标题」；标题为空时不留多余空格 */
export function chapterHeading(n: number, title: string): string {
  return title ? `第 ${n} 章 ${title}` : `第 ${n} 章`
}

/**
 * 「已成稿」口径 —— 与全书统计一致：`done`（已定稿）、`revise`（修订中）都有完整正文；
 * `audit`（待审计）仍未定稿，不纳入；`draft` 草稿更不纳入。
 */
export const COMMITTED_STATUSES: string[] = ['done', 'revise']

/** 导出用的章节：只带正文与最基本信息 */
export interface ExportChapter {
  n: number
  title: string
  words: number
  text: string
}

/** 一次作品导出所需的全部输入 */
export interface BookExport {
  title: string
  genre: string
  logline: string
  exportedAt: string
  chapters: ExportChapter[]
}

/** 章节清单的元信息（导出范围统计与章节台账用） */
export interface ChapterRow {
  n: number
  title: string
  status: string
  words: number
  pov: string
}

/* ------------------------------------------------------------------ *
 * 全书 TXT / Markdown
 * ------------------------------------------------------------------ */

/** 卷首信息：两个格式共用，只写有值的行 */
function bookHeadLines(book: BookExport, bullet: string): string[] {
  const words = book.chapters.reduce((s, c) => s + c.words, 0)
  return [
    `题材：${book.genre || '待定'}`,
    book.logline ? `一句话灵感：${book.logline}` : '',
    `章节数：${book.chapters.length} 章 · 合计 ${words} 字`,
    `导出时间：${book.exportedAt}`,
  ]
    .filter(Boolean)
    .map((line) => bullet + line)
}

/** 全书 TXT：纯文本，章节间空行分隔，适合直接投稿 / 阅读 */
export function buildBookTxt(book: BookExport): string {
  const head = [`《${book.title}》`, '', ...bookHeadLines(book, '')].join('\n')
  const body = book.chapters
    .map((c) => `${chapterHeading(c.n, c.title)}\n\n${c.text.trim()}`)
    .join('\n\n\n')
  return `${head}\n\n${'-'.repeat(24)}\n\n${body}\n`
}

/** 全书 Markdown：章节用二级标题，便于二次编辑 */
export function buildBookMarkdown(book: BookExport): string {
  const head = [`# 《${book.title}》`, '', ...bookHeadLines(book, '- ')].join('\n')
  const body = book.chapters
    .map((c) => `## ${chapterHeading(c.n, c.title)}\n\n${c.text.trim()}`)
    .join('\n\n---\n\n')
  return `${head}\n\n---\n\n${body}\n`
}

/* ------------------------------------------------------------------ *
 * 真相文件（Markdown 投影）
 * ------------------------------------------------------------------ */

export interface TruthVolume {
  name: string
  fromChapter: number
  toChapter: number
  goal: string
  status: string
}

export interface TruthNode {
  chapter: number
  title: string
  volume: string
  status: string
  pov: string
  intensity: number
  goal: string
}

export interface TruthRule {
  id: string
  category: string
  kind: string
  rule: string
  status: string
  note: string
}

export interface TruthCharacter {
  name: string
  role: string
  lead: boolean
  deceased: boolean
  immutableTraits: string[]
  personality: string
  speechStyle: string
  aliases: string[]
  firstAppearance: number
  state?: { location?: string; status?: string }
}

export interface TruthHook {
  id: string
  content: string
  plantedChapter: number
  resolvedChapter: number | null
  status: string
  importance: string
  linkedCharacters: string[]
  suggestedResolveBy: number | null
  overdue?: boolean
}

export interface TruthSubplot {
  id: string
  name: string
  kind: string
  summary: string
  status: string
  active: number[]
}

export interface TruthStyle {
  source?: string
  analyzedAt?: string
  narrative?: { person?: string; tense?: string; povSwitch?: string; anchor?: string }
  sentence?: { mean?: number; p50?: number; p90?: number }
  preferredPatterns?: string[]
  bannedExpressions?: string[]
}

export interface TruthBundle {
  book: BookExport
  /** 全部章节清单（含未成稿），作为真相文件里的章节台账 */
  chapters: ChapterRow[]
  volumes: TruthVolume[]
  nodes: TruthNode[]
  rules: TruthRule[]
  characters: TruthCharacter[]
  hooks: TruthHook[]
  plotlines: TruthSubplot[]
  style: TruthStyle | null
}

/** 表格单元：换行与竖线会破坏 Markdown 表格，先归一化 */
function cell(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, ' ').trim() || '—'
}

/** 渲染 Markdown 表格；`rows` 为空时返回一句空态 */
function mdTable(headers: string[], rows: unknown[][], emptyHint: string): string {
  if (!rows.length) return `_${emptyHint}_\n`
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n')
  return `${head}\n${sep}\n${body}\n`
}

const HOOK_STATUS_LABEL: Record<string, string> = {
  planted: '待回收',
  resolved: '已回收',
  abandoned: '已弃用',
}

/** 真相文件导出：世界观 / 角色 / 伏笔 / 章纲 / 支线 / 文风，一份人可读可改的 Markdown */
export function buildTruthMarkdown(bundle: TruthBundle): string {
  const { book } = bundle
  const parts: string[] = []

  parts.push(`# 《${book.title}》· 真相文件`)
  parts.push(
    [
      `- 题材：${book.genre || '待定'}`,
      book.logline ? `- 一句话灵感：${book.logline}` : '',
      `- 导出时间：${book.exportedAt}`,
    ]
      .filter(Boolean)
      .join('\n'),
  )

  const committed = bundle.chapters.filter((c) => COMMITTED_STATUSES.includes(c.status)).length
  parts.push('## 作品信息')
  parts.push(`- 章节总数：${bundle.chapters.length} 章（已成稿 ${committed} 章）`)
  parts.push(`- 正文字数：${book.chapters.reduce((s, c) => s + c.words, 0)} 字（仅计本次已导出的正文章节）`)

  parts.push('## 章节台账')
  parts.push(
    mdTable(
      ['章', '标题', '状态', '字数', '视角'],
      bundle.chapters.map((c) => [c.n, c.title, c.status, c.words, c.pov]),
      '还没有章节',
    ),
  )

  parts.push('## 卷与章纲')
  parts.push(
    mdTable(
      ['卷名', '章节范围', '状态', '目标'],
      bundle.volumes.map((v) => [v.name, `${v.fromChapter}–${v.toChapter}`, v.status, v.goal]),
      '还没有规划卷',
    ),
  )
  parts.push(
    mdTable(
      ['章', '标题', '卷', '状态', '视角', '张力', '目标'],
      bundle.nodes.map((n) => [n.chapter, n.title, n.volume, n.status, n.pov, n.intensity, n.goal]),
      '还没有章纲',
    ),
  )

  parts.push('## 世界观规则')
  parts.push(
    mdTable(
      ['编号', '类别', '强度', '规则', '状态', '备注'],
      bundle.rules.map((r) => [
        r.id,
        r.category,
        r.kind === 'hard' ? '硬约束' : '软设定',
        r.rule,
        r.status,
        r.note,
      ]),
      '还没有世界观规则',
    ),
  )

  parts.push('## 角色档案')
  parts.push(
    mdTable(
      ['姓名', '定位', '主角', '已故', '不可变特征', '说话风格', '当前处境'],
      bundle.characters.map((c) => [
        c.name,
        c.role,
        c.lead ? '是' : '否',
        c.deceased ? '是' : '否',
        c.immutableTraits.join('；'),
        c.speechStyle,
        c.state?.location ?? '',
      ]),
      '还没有角色档案',
    ),
  )

  parts.push('## 伏笔台账')
  parts.push(
    mdTable(
      ['编号', '内容', '埋设章', '状态', '建议回收', '实际回收', '重要度', '超期'],
      bundle.hooks.map((h) => [
        h.id,
        h.content,
        h.plantedChapter,
        HOOK_STATUS_LABEL[h.status] ?? h.status,
        h.suggestedResolveBy ?? '—',
        h.resolvedChapter ?? '—',
        h.importance === 'major' ? '主线级' : '支线级',
        h.overdue ? '是' : '否',
      ]),
      '还没有登记伏笔',
    ),
  )

  parts.push('## 支线进度')
  parts.push(
    mdTable(
      ['名称', '类型', '状态', '活跃章节', '梗概'],
      bundle.plotlines.map((p) => [
        p.name,
        p.kind === 'main' ? '主线' : '支线',
        p.status,
        p.active.join('、'),
        p.summary,
      ]),
      '还没有支线',
    ),
  )

  parts.push('## 文风档案')
  const st = bundle.style
  if (st && st.source) {
    const nar = st.narrative ?? {}
    parts.push(`- 分析来源：${st.source}`)
    if (st.analyzedAt) parts.push(`- 分析时间：${st.analyzedAt}`)
    if (st.sentence) {
      parts.push(`- 句长：均值 ${st.sentence.mean ?? '—'} · P50 ${st.sentence.p50 ?? '—'} · P90 ${st.sentence.p90 ?? '—'}`)
    }
    parts.push(`- 视角：${nar.person || '—'} · ${nar.tense || '—'} · 视角切换 ${nar.povSwitch || '—'}`)
    parts.push(`- 偏好手法：${(st.preferredPatterns ?? []).join('；') || '—'}`)
    parts.push(`- 禁用表达：${(st.bannedExpressions ?? []).join('；') || '—'}`)
  } else {
    parts.push('_还没有文风档案_')
  }

  return parts.join('\n\n') + '\n'
}
