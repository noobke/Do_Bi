"""外部工具接入层（规划文档 §6.9）。

以 MCP 客户端身份接入外部工具服务器；**MCP 不可用时自动降级为内置检索**，不阻塞主流程。
入口：`mcp.McpRegistry`（配置与连通性测试）、`mcp.ToolGateway`（统一工具入口）。
"""

from .mcp import (
    DEGRADE_NOTE,
    McpClient,
    McpRegistry,
    McpServer,
    ToolGateway,
    builtin_fetch_history,
    builtin_lookup_setting,
    builtin_search_reference,
)

__all__ = [
    "McpServer",
    "McpRegistry",
    "McpClient",
    "ToolGateway",
    "builtin_lookup_setting",
    "builtin_search_reference",
    "builtin_fetch_history",
    "DEGRADE_NOTE",
]
