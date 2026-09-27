#!/usr/bin/env python3
"""Obsidian 资料库的 MCP 接口（stdio 传输，只用标准库）——**为后续接入预留**。

用途：把你已有的 Obsidian 笔记（vault）变成一个**外部工具**，让 Do_Bi 的
「检索资料 / 查设定」能读到它。它是一个普通的 MCP 服务器，本项目不需要为它改任何代码——
在「设置 → 外部工具」里新增一条并启用即可。

它只读，绝不修改你的笔记。

指定 vault 目录（三种方式，任选其一）：
1. 环境变量 `DOBI_OBSIDIAN_VAULT`（推荐，与项目其它配置一致）
2. 环境变量 `OBSIDIAN_VAULT`
3. 启动参数：`python3 mcp/obsidian_vault.py /path/to/vault`

未指定时服务照常启动、工具也照常列出，只是调用会回一句「还没指定资料库目录」——
这样「设置 → 外部工具 → 测试」仍能连通，只是告诉你还差一步配置。

协议：JSON-RPC 2.0，**一行一条 JSON**（换行分隔），走 stdin / stdout。
日志一律写 stderr——stdout 只准出协议消息。

在 config/mcp.json 里对应这样的配置（把 command 换成你的 vault 路径）：
    {"name": "Obsidian 笔记库 obsidian-vault", "transport": "stdio",
     "command": "python3 mcp/obsidian_vault.py /path/to/your/vault",
     "tools": ["vault_status", "list_notes", "search_notes", "read_note"],
     "enabled": true}
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "dobi-obsidian-vault", "version": "0.1.0"}

#: 跳过这些目录（Obsidian 自己的配置、回收站、版本库）
_SKIP_DIRS = {".obsidian", ".trash", ".git", ".github", "node_modules"}
_MAX_NOTES = 5000          # 单次扫描的笔记上限，防止超大库把内存吃光
_MAX_NOTE_CHARS = 200_000  # 单篇笔记读取上限
_SNIPPET = 160


# ==========================================================================
# vault 定位与读取
# ==========================================================================

def _vault() -> Path | None:
    raw = (os.environ.get("DOBI_OBSIDIAN_VAULT")
           or os.environ.get("OBSIDIAN_VAULT") or "").strip()
    if not raw and len(sys.argv) > 1:
        raw = sys.argv[1].strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if path.is_dir() else None


_NOT_CONFIGURED = ("还没有指定 Obsidian 资料库目录。请把 vault 路径写进环境变量 "
                   "DOBI_OBSIDIAN_VAULT，或作为启动参数传给本服务。")


def _note_title(path: Path, text: str) -> str:
    """标题优先级：正文首个一级标题 → frontmatter 的 title → 文件名。"""
    for line in text.splitlines()[:40]:
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip() or path.stem
        if stripped.startswith("title:"):
            value = stripped.split(":", 1)[1].strip().strip('"').strip("'")
            if value:
                return value
    return path.stem


def _iter_notes(vault: Path) -> list[tuple[str, str, str]]:
    """返回 `[(相对路径, 标题, 正文)]`。只读、上限保护、跳过隐藏目录。"""
    out: list[tuple[str, str, str]] = []
    for path in sorted(vault.rglob("*.md")):
        if any(part in _SKIP_DIRS for part in path.parts):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")[:_MAX_NOTE_CHARS]
        except OSError:
            continue
        rel = str(path.relative_to(vault))
        out.append((rel, _note_title(path, text), text))
        if len(out) >= _MAX_NOTES:
            break
    return out


def _safe_note(vault: Path, rel: str) -> Path | None:
    """把相对路径限制在 vault 内，防止 `../` 越权读到别处。"""
    rel = (rel or "").strip().lstrip("/").replace("\\", "/")
    if not rel:
        return None
    if not rel.endswith(".md"):
        rel += ".md"
    target = (vault / rel).resolve()
    try:
        target.relative_to(vault.resolve())
    except ValueError:
        return None
    return target if target.is_file() else None


# ==========================================================================
# 四个工具的实现
# ==========================================================================

def _vault_status(args: dict[str, Any]) -> dict[str, Any]:
    vault = _vault()
    if vault is None:
        return {"ok": False, "configured": False, "vault": None,
                "notes": 0, "error": _NOT_CONFIGURED}
    notes = _iter_notes(vault)
    return {"ok": True, "configured": True, "vault": str(vault),
            "notes": len(notes),
            "sample": [{"path": rel, "title": title} for rel, title, _ in notes[:10]]}


def _list_notes(args: dict[str, Any]) -> dict[str, Any]:
    vault = _vault()
    if vault is None:
        return {"ok": False, "notes": [], "error": _NOT_CONFIGURED}
    folder = str(args.get("folder") or "").strip().strip("/")
    limit = int(args.get("limit") or 200)
    notes = []
    for rel, title, text in _iter_notes(vault):
        if folder and not rel.startswith(folder):
            continue
        notes.append({"path": rel, "title": title, "chars": len(text)})
    return {"ok": True, "folder": folder, "total": len(notes),
            "notes": notes[: max(1, limit)]}


def _score(query: str, rel: str, title: str, text: str) -> float:
    """朴素关键词打分：标题命中权重更高，正文按出现次数计。中文用子串匹配即可。"""
    q = query.lower()
    if not q:
        return 0.0
    score = title.lower().count(q) * 3.0 + text.lower().count(q) * 1.0
    score += rel.lower().count(q) * 1.5
    return score


def _search_notes(args: dict[str, Any]) -> dict[str, Any]:
    vault = _vault()
    if vault is None:
        return {"ok": False, "query": "", "hits": [], "error": _NOT_CONFIGURED}
    query = str(args.get("query") or "").strip()
    k = int(args.get("k") or 5)
    if not query:
        return {"ok": False, "query": "", "hits": [], "error": "请给出要检索的关键词。"}

    hits: list[tuple[float, dict[str, Any]]] = []
    for rel, title, text in _iter_notes(vault):
        score = _score(query, rel, title, text)
        if score <= 0:
            continue
        at = text.lower().find(query.lower())
        snippet = text[max(0, at - _SNIPPET // 2): at + _SNIPPET] if at >= 0 else text[:_SNIPPET]
        hits.append((score, {"path": rel, "title": title,
                             "snippet": " ".join(snippet.split())}))
    hits.sort(key=lambda x: (-x[0], x[1]["path"]))
    return {"ok": True, "query": query, "source": "obsidian-vault",
            "hits": [h for _, h in hits[: max(1, k)]]}


def _read_note(args: dict[str, Any]) -> dict[str, Any]:
    vault = _vault()
    if vault is None:
        return {"ok": False, "error": _NOT_CONFIGURED}
    rel = str(args.get("path") or "")
    target = _safe_note(vault, rel)
    if target is None:
        return {"ok": False, "path": rel, "error": f"资料库里没有这篇笔记：{rel}"}
    text = target.read_text(encoding="utf-8", errors="ignore")[:_MAX_NOTE_CHARS]
    return {"ok": True, "path": str(target.relative_to(vault)), "title": _note_title(target, text),
            "text": text}


TOOLS: list[dict[str, Any]] = [
    {
        "name": "vault_status",
        "description": "查看 Obsidian 资料库是否已配置，以及有多少篇笔记。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_notes",
        "description": "列出资料库里的笔记（可按子目录过滤）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "folder": {"type": "string", "description": "只看这个子目录，可省略"},
                "limit": {"type": "integer", "description": "返回条数，默认 200"},
            },
        },
    },
    {
        "name": "search_notes",
        "description": "在资料库里按关键词检索笔记。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "要检索的关键词"},
                "k": {"type": "integer", "description": "返回条数，默认 5"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "read_note",
        "description": "读取指定笔记的全文。",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "笔记的相对路径"}},
            "required": ["path"],
        },
    },
]

HANDLERS = {
    "vault_status": _vault_status,
    "list_notes": _list_notes,
    "search_notes": _search_notes,
    "read_note": _read_note,
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
            print("[obsidian-mcp] 收到非 JSON，已忽略", file=sys.stderr)
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
