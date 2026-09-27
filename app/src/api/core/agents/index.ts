/**
 * Agents 层统一出口 —— 镜像 `server/dobi/agents/__init__.py`。
 *
 * 角色分工（规划文档 §7.1）：
 * - Architect：灵感 / 对话记录 → 世界观、角色、大纲、依赖图
 * - Writer：章纲 + 上下文 + 文风档案 → 章节正文（流式，可中断）
 * - Auditor：正文 + 真相文件 → 审计报告（含原文证据）
 * - Reviewer：正文 + 章纲 + 依赖图 → 7 维可举证质量评审
 * - Reviser：正文 + 审计报告 → 定点修复 / 去 AI 味
 * - Archivist：定稿正文 → 摘要、事实抽取、伏笔与依赖边更新
 * - ChatAgent：一句话灵感 → 多轮追问沉淀可开工的设定
 *
 * Coordinator 由 orchestrator.pipeline 承担——它只做编排与仲裁，不生成内容。
 */

export { Agent, Usage, ROLE_TO_STEP } from './base'
export { Architect, ArchitectResult, presentCharacters } from './architect'
export { ChatAgent } from './chat'
export { Writer, WriteResult, splitParagraphs } from './writer'
export { Auditor } from './auditor'
export { Reviewer } from './reviewer'
export { Reviser, ReviseResult } from './reviser'
export { Archivist, ArchiveResult } from './archivist'
