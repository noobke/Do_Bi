#!/usr/bin/env python3
"""一个**可跑通的 MCP 示例服务**（stdio 传输，只用标准库）。

用途有两个：
1. 让你在「设置 → 外部工具」里点「测试」时能真的连上，看清 MCP 是怎么接的；
2. 作为模板：把下面 `_lookup_setting` / `_search_reference` / `_fetch_history`
   三个函数换成你自己的逻辑（查数据库、调内网接口、读你自己的设定库……），
   就得到一个真正的外部工具，不用改本项目的任何代码。

协议：JSON-RPC 2.0，**一行一条 JSON**（换行分隔），走 stdin / stdout。
日志一律写 stderr——stdout 只准出协议消息，否则会污染管道。

启动（在 server/ 目录下）：
    python3 mcp/example_server.py

在 config/mcp.json 里对应这样的配置：
    {"name": "本地档案库 local-archive", "transport": "stdio",
     "command": "python3 mcp/example_server.py",
     "tools": ["lookup_setting", "search_reference", "fetch_history"],
     "enabled": true}
"""

from __future__ import annotations

import json
import sys
from typing import Any

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "dobi-example-archive", "version": "0.1.0"}

#: 示例数据。换成你自己的数据源即可。
SETTINGS: dict[str, dict[str, Any]] = {
    "青铜灯": {"category": "物件", "kind": "hard",
               "text": "青铜灯灭时，亡者复归。灯不可被外力熄灭，只随持有者的死而灭。"},
    "验尸房": {"category": "地点", "kind": "soft",
               "text": "位于城南，常年点着三盏油灯，午夜后不许留人。"},
}

HISTORY: dict[int, dict[str, Any]] = {
    1: {"title": "灯灭", "summary": "验尸官在城南验一具无伤女尸，青铜灯忽然熄灭。",
        "words": 3120},
    2: {"title": "名单", "summary": "灯下浮出一份名单，末行写着验尸官自己的名字。",
        "words": 3310},
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "lookup_setting",
        "description": "按关键词查设定（世界观规则、地点、物件）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "要查的关键词"},
                "category": {"type": "string", "description": "限定分类，可省略"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "search_reference",
        "description": "检索参考资料。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "k": {"type": "integer", "description": "返回条数，默认 5"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "fetch_history",
        "description": "取指定历史章节的正文摘要。",
        "inputSchema": {
            "type": "object",
            "properties": {"chapter": {"type": "integer"}},
            "required": ["chapter"],
        },
    },
]


# ==========================================================================
# 三个工具的实现（**换成你自己的逻辑**）
# ==========================================================================

def _lookup_setting(args: dict[str, Any]) -> dict[str, Any]:
    query = str(args.get("query") or "").strip()
    category = str(args.get("category") or "").strip()
    hits = [
        {"name": name, **info}
        for name, info in SETTINGS.items()
        if (query and query in name) or (not query)
    ]
    if category:
        hits = [h for h in hits if h.get("category") == category]
    return {"ok": True, "source": "local-archive", "query": query, "items": hits}


def _search_reference(args: dict[str, Any]) -> dict[str, Any]:
    k = int(args.get("k") or 5)
    query = str(args.get("query") or "").strip()
    items = [
        {"name": name, "text": info["text"], "category": info.get("category", "")}
        for name, info in SETTINGS.items()
        if not query or query in info["text"] or query in name
    ][: max(1, k)]
    return {"ok": True, "source": "local-archive", "query": query, "items": items}


def _fetch_history(args: dict[str, Any]) -> dict[str, Any]:
    try:
        chapter = int(args.get("chapter") or 0)
    except (TypeError, ValueError):
        chapter = 0
    data = HISTORY.get(chapter)
    if data is None:
        return {"ok": False, "source": "local-archive", "chapter": chapter,
                "error": f"没有第 {chapter} 章的存档"}
    return {"ok": True, "source": "local-archive", "chapter": chapter, **data}


HANDLERS = {
    "lookup_setting": _lookup_setting,
    "search_reference": _search_reference,
    "fetch_history": _fetch_history,
}


# ==========================================================================
# 协议处理
# ==========================================================================

def _text_result(payload: dict[str, Any]) -> dict[str, Any]:
    """MCP 的工具返回值：content 是内容块数组，文本要 JSON 序列化进去。"""
    return {
        "content": [{"type": "text",
                     "text": json.dumps(payload, ensure_ascii=False)}],
        "isError": not payload.get("ok", True),
    }


def handle(message: dict[str, Any]) -> dict[str, Any] | None:
    """处理一条请求。返回 None 表示这是通知，不需要回复。"""
    method = message.get("method")
    msg_id = message.get("id")
    params = message.get("params") or {}

    if msg_id is None:            # 通知（notifications/initialized 等）
        return None

    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": msg_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": SERVER_INFO,
            },
        }

    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}

    if method == "tools/call":
        name = str(params.get("name") or "")
        arguments = params.get("arguments") or {}
        handler = HANDLERS.get(name)
        if handler is None:
            return {"jsonrpc": "2.0", "id": msg_id,
                    "error": {"code": -32601, "message": f"没有这个工具：{name}"}}
        try:
            return {"jsonrpc": "2.0", "id": msg_id,
                    "result": _text_result(handler(arguments))}
        except Exception as exc:  # noqa: BLE001 —— 工具内部出错也要按协议回，而不是崩掉进程
            return {"jsonrpc": "2.0", "id": msg_id,
                    "error": {"code": -32603, "message": f"工具执行失败：{exc}"}}

    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}

    return {"jsonrpc": "2.0", "id": msg_id,
            "error": {"code": -32601, "message": f"不支持的方法：{method}"}}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            print("[example-mcp] 收到非 JSON，已忽略", file=sys.stderr)
            continue
        if not isinstance(message, dict):
            continue
        reply = handle(message)
        if reply is None:
            continue
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
