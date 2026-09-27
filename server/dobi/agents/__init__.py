"""Agents 层：Architect / Writer / Auditor / Reviewer / Reviser / Archivist。

角色分工（规划文档 §7.1）：

| Agent | 输入 | 输出 |
|---|---|---|
| `Architect` | 灵感 / 对话记录 | 世界观、角色、大纲、依赖图 |
| `Writer` | 章纲 + 上下文 + 文风档案 | 章节正文（流式，可中断） |
| `Auditor` | 正文 + 真相文件 | 审计报告（含原文证据） |
| `Reviewer` | 正文 + 章纲 + 依赖图 | 7 维可举证质量评审 |
| `Reviser` | 正文 + 审计报告 | 定点修复 / 去 AI 味 |
| `Archivist` | 定稿正文 | 摘要、事实抽取、伏笔与依赖边更新 |

Coordinator 由 `orchestrator.pipeline` 承担——它只做编排与仲裁，不生成内容。

每个 Agent 都继承 `Agent`，共享三件事：**计量归集**（`self.usage` / `self.meter`）、
**checkpoint 打点**（`self.cp`）、**提案提交闸门**（`self.commit()`）。
"""

from .architect import Architect, ArchitectResult, present_characters
from .archivist import ArchiveResult, Archivist
from .auditor import Auditor
from .base import ROLE_TO_STEP, Agent, Usage
from .chat import ChatAgent
from .reviewer import Reviewer
from .reviser import ReviseResult, Reviser
from .writer import WriteResult, Writer, split_paragraphs

__all__ = [
    "Agent", "Usage", "ROLE_TO_STEP",
    "Architect", "ArchitectResult", "present_characters",
    "ChatAgent",
    "Writer", "WriteResult", "split_paragraphs",
    "Auditor", "Reviewer",
    "Reviser", "ReviseResult",
    "Archivist", "ArchiveResult",
]
