"""Do_Bi 小说创作台 · 后端。

分层（对应规划文档 §4 系统架构）：
    ② 干预策略层  orchestrator.mode
    ③ 编排层      orchestrator.pipeline / planning / steer
    ④ 上下文组装  core.context
    ⑤ 一致性引擎  consistency.*
    ⑥ 项目状态层  core.store / core.memory / core.checkpoint
    ⑦ 模型适配层  llm.provider
    ⑧ MCP 客户端  integrations.mcp
"""

__version__ = "1.0.0"
