/**
 * 本地核心内部数据模型 —— 镜像 `server/dobi/core/schema.py`（snake_case）。
 *
 * 对外 API 一律经 `toApi()` 转 camelCase（机械转换，不丢字段）。
 */

export type ChapterStatus = 'todo' | 'planned' | 'draft' | 'audit' | 'revise' | 'done'
export type Severity = 'blocker' | 'major' | 'minor'
export type HookStatus = 'planted' | 'resolved' | 'abandoned'
export type IntervMode = 'auto' | 'semi-auto' | 'manual'
export type StepPolicy = 'auto' | 'confirm' | 'manual'
export type PipelineStep = 'plan' | 'context' | 'draft' | 'audit' | 'review' | 'deai' | 'revise' | 'commit'
export type Decision = 'accept' | 'ignore' | null

export const PIPELINE_STEPS: PipelineStep[] = [
  'plan', 'context', 'draft', 'audit', 'review', 'deai', 'revise', 'commit',
]

export const STEP_LABELS: Record<string, string> = {
  plan: '章纲', context: '上下文组装', draft: '草稿', audit: '规则与模型审查',
  review: '可举证评审', deai: '去 AI 味', revise: '修订', commit: '定稿',
}

export const STOP_CONDITIONS = [
  'audit.blocker_exists', 'budget.exceeded', 'audit.fail_streak', 'steer.affects_committed',
]

export const STOP_CONDITION_LABELS: Record<string, string> = {
  'audit.blocker_exists': '出现阻塞定稿级问题',
  'budget.exceeded': '预算用尽',
  'audit.fail_streak': '连续 3 章审查不通过',
  'steer.affects_committed': '干预波及已定稿章节',
}

// ---------------------------------------------------------------------------
// meta.json
// ---------------------------------------------------------------------------

export interface StepPolicies {
  plan: StepPolicy
  context: StepPolicy
  draft: StepPolicy
  audit: StepPolicy
  review: StepPolicy
  deai: StepPolicy
  revise: StepPolicy
  commit: StepPolicy
}

export function defaultStepPolicies(): StepPolicies {
  return { plan: 'confirm', context: 'auto', draft: 'auto', audit: 'confirm', review: 'auto', deai: 'auto', revise: 'auto', commit: 'confirm' }
}

export interface ProjectMeta {
  id: string
  title: string
  genre: string
  logline: string
  premise: string
  mode: IntervMode
  steps: StepPolicies
  stop_conditions: string[]
  chapters_total: number
  words: number
  words_per_chapter: number
  budget_total: number
  budget_used: number
  cost_unit: string
  audit_dims: string[]
  audit_dims_extended: boolean
  style_locked: boolean
  created_at: string
  updated_at: string
}

export function newMeta(id: string, over: Partial<ProjectMeta> = {}): ProjectMeta {
  return {
    id,
    title: '未命名作品',
    genre: '待定',
    logline: '',
    premise: '',
    mode: 'semi-auto',
    steps: defaultStepPolicies(),
    stop_conditions: ['audit.blocker_exists', 'budget.exceeded', 'steer.affects_committed'],
    chapters_total: 0,
    words: 0,
    words_per_chapter: 3000,
    budget_total: 80.0,
    budget_used: 0.0,
    cost_unit: '¥',
    audit_dims: [],
    audit_dims_extended: false,
    style_locked: false,
    created_at: '',
    updated_at: '',
    ...over,
  }
}

// ---------------------------------------------------------------------------
// 世界观
// ---------------------------------------------------------------------------

export interface WorldRule {
  id: string
  category: string
  kind: 'hard' | 'soft'
  rule: string
  refs: number[]
  note: string
  status: 'ok' | 'conflict' | 'unused'
}

export interface WorldDoc {
  rules: WorldRule[]
  updated_at: string
}

export function newWorld(): WorldDoc {
  return { rules: [], updated_at: '' }
}

// ---------------------------------------------------------------------------
// 角色
// ---------------------------------------------------------------------------

export interface Relation {
  target: string
  type: string
  note: string
}

export interface CharacterState {
  location: string
  status: string
  known_secrets: string[]
}

export interface Character {
  id: string
  name: string
  role: string
  lead: boolean
  immutable_traits: string[]
  personality: string
  speech_style: string
  relationships: Relation[]
  state: CharacterState
  first_appearance: number
  updated_at_chapter: number
  aliases: string[]
  deceased: boolean
}

export function newCharacterState(): CharacterState {
  return { location: '—', status: '—', known_secrets: [] }
}

// ---------------------------------------------------------------------------
// 当前状态
// ---------------------------------------------------------------------------

export interface CurrentState {
  chapter: number
  location_focus: string
  situation: string
  open_questions: string[]
  updated_at: string
}

export function newCurrentState(): CurrentState {
  return { chapter: 0, location_focus: '', situation: '', open_questions: [], updated_at: '' }
}

// ---------------------------------------------------------------------------
// 伏笔
// ---------------------------------------------------------------------------

export interface Hook {
  id: string
  content: string
  planted_chapter: number
  status: HookStatus
  resolved_chapter: number | null
  importance: 'major' | 'minor'
  linked_characters: string[]
  suggested_resolve_by: number | null
}

// ---------------------------------------------------------------------------
// 章节摘要
// ---------------------------------------------------------------------------

export interface ChapterSummary {
  chapter: number
  title: string
  summary: string
  words: number
  pov: string
  key_facts: string[]
  characters: string[]
  hooks_planted: string[]
  hooks_resolved: string[]
  updated_at: string
}

// ---------------------------------------------------------------------------
// 支线
// ---------------------------------------------------------------------------

export interface Subplot {
  id: string
  name: string
  kind: 'main' | 'sub'
  summary: string
  color: string
  active: number[]
  peak: number[]
  status: 'active' | 'stalled' | 'closed'
}

// ---------------------------------------------------------------------------
// 大纲
// ---------------------------------------------------------------------------

export interface Compass {
  endgame: string
  active_threads: string[]
  scale_estimate: string
  refresh_at: string
}

export function newCompass(): Compass {
  return { endgame: '', active_threads: [], scale_estimate: '', refresh_at: '尚未刷新' }
}

export interface Volume {
  name: string
  from_chapter: number
  to_chapter: number
  goal: string
  est_chapters: number
  status: 'skeleton' | 'expanded'
  arc: string
}

export interface OutlineNode {
  chapter: number
  title: string
  arc: string
  volume: string
  status: 'skeleton' | 'planned' | 'written' | 'audit' | 'draft'
  goal: string
  beats: string[]
  rationale: string
  pov: string
  intensity: number
  story_at: string
  timeline: Array<{ at: string; label: string; kind: string }>
}

export interface OutlineEdge {
  from_chapter: number
  to_chapter: number
  type: 'motivation' | 'setup' | 'payoff' | 'causality' | 'parallel'
  note: string
  confirmed: boolean
}

export interface OutlineGraph {
  compass: Compass
  volumes: Volume[]
  nodes: OutlineNode[]
  edges: OutlineEdge[]
  updated_at: string
}

export function newOutlineGraph(): OutlineGraph {
  return { compass: newCompass(), volumes: [], nodes: [], edges: [], updated_at: '' }
}

// ---------------------------------------------------------------------------
// 文风
// ---------------------------------------------------------------------------

export interface SentenceStats {
  mean: number
  p50: number
  p90: number
  min: number
  max: number
  scale: number
}

export interface NarrativeStyle {
  person: string
  tense: string
  pov_switch: string
  anchor: string
}

export interface StyleRatio {
  label: string
  pct: number
  color: string
}

export interface StyleProfile {
  source: string
  analyzed_at: string
  tokens: number
  sentence: SentenceStats
  narrative: NarrativeStyle
  ratio: StyleRatio[]
  preferred_patterns: string[]
  banned_expressions: string[]
  lexicon: Array<{ key: string; value: string }>
  sample_plain: string
  sample_styled: string
}

export function newStyleProfile(): StyleProfile {
  return {
    source: '', analyzed_at: '', tokens: 0,
    sentence: { mean: 0, p50: 0, p90: 0, min: 0, max: 0, scale: 80 },
    narrative: { person: '', tense: '', pov_switch: 'rare', anchor: '' },
    ratio: [], preferred_patterns: [], banned_expressions: [], lexicon: [],
    sample_plain: '', sample_styled: '',
  }
}

// ---------------------------------------------------------------------------
// 审计 / 评审
// ---------------------------------------------------------------------------

export interface L1Violation {
  rule: string
  hit: string
  count: number
  threshold: number
  samples: string[]
}

export interface AuditItem {
  dim: string
  severity: Severity
  evidence: string
  suggestion: string
  ref: string
  fixed: boolean
  decision: Decision
  patch: Record<string, unknown> | null
}

export interface AuditReport {
  chapter: number
  title: string
  l1_violations: L1Violation[]
  l1_checked: Array<Record<string, unknown>>
  items: AuditItem[]
  review: Array<Record<string, unknown>>
  diffs: Array<Record<string, unknown>>
  stats: Record<string, number>
  generated_at: string
}

export interface ReviewDimension {
  dim: string
  score: number
  evidence: string
  note: string
}

export interface ReviewReport {
  chapter: number
  dims: ReviewDimension[]
  overall: number
  generated_at: string
}

// ---------------------------------------------------------------------------
// 提案 / 检查点 / 用量
// ---------------------------------------------------------------------------

export interface Proposal {
  id: string
  kind: string
  payload: Record<string, unknown>
  reason: string
  confidence: 'high' | 'medium' | 'low'
  decision: Decision
  target_file: string
}

export interface ValidationIssue {
  level: 'error' | 'warning'
  kind: string
  message: string
  proposal_id: string
}

export interface CommitResult {
  applied: Proposal[]
  pending: Proposal[]
  issues: ValidationIssue[]
  changed_files: string[]
  blocked: boolean
  public(): Record<string, unknown>
}

export interface Checkpoint {
  chapter: number
  step: string
  status: 'running' | 'ok' | 'failed' | 'skipped'
  attempt: number
  idempotency_key: string
  output_ref: string
  tokens: number
  cost: number
  note: string
  timestamp: string
}

export interface UsageEntry {
  chapter: number
  step: string
  role: string
  provider: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost: number
  latency_ms: number
  attempts: number
  ts: string
}

// ---------------------------------------------------------------------------
// 章节正文（chapters/ch_XXXX.md 的内存形态）
// ---------------------------------------------------------------------------

export interface ChapterFile {
  chapter: number
  title: string
  status: ChapterStatus
  words: number
  pov: string
  updated: string
  paragraphs: string[]
}

// ---------------------------------------------------------------------------
// 实时干预指令
// ---------------------------------------------------------------------------

export interface SteeringDirective {
  id: string
  text: string
  intent: Record<string, unknown>
  scope: string
  target_chapter: number | null
  affected_chapters: number[]
  applied: boolean
  pending_confirmation: boolean
  resolved: boolean
  created_at: string
  resolved_at: string | null
}

// ---------------------------------------------------------------------------
// 项目记录（一条 = 一个项目的全部真相数据）
// ---------------------------------------------------------------------------

export interface ProjectRecord {
  meta: ProjectMeta
  world: WorldDoc
  characters: Character[]
  hooks: Hook[]
  summaries: ChapterSummary[]
  subplots: Subplot[]
  outline_graph: OutlineGraph
  style: StyleProfile
  state: CurrentState
  chapters: Record<string, ChapterFile>
  audits: Record<string, AuditReport>
  reviews: Record<string, ReviewReport>
  checkpoints: Checkpoint[]
  usage: UsageEntry[]
  steering: SteeringDirective[]
  created_at: string
  updated_at: string
}

export function newProjectRecord(id: string, over: Partial<ProjectMeta> = {}): ProjectRecord {
  const meta = newMeta(id, over)
  return {
    meta,
    world: newWorld(),
    characters: [],
    hooks: [],
    summaries: [],
    subplots: [],
    outline_graph: newOutlineGraph(),
    style: newStyleProfile(),
    state: newCurrentState(),
    chapters: {},
    audits: {},
    reviews: {},
    checkpoints: [],
    usage: [],
    steering: [],
    created_at: meta.created_at,
    updated_at: meta.updated_at,
  }
}
