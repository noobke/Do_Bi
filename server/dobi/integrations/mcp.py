"""MCP 客户端（规划文档 §6.9）。

以 **MCP 客户端**身份接入外部工具服务器（stdio / HTTP 两种传输），让「查设定」
「查资料」「查历史章节」等动作可以走外部工具而不是硬编码。

**核心约束：MCP 永远是增强而非依赖。** 连接失败 / 超时 / 协议异常一律被吞掉、
转成 `status="failed"` + `error`，由 `ToolGateway` 自动回落到内置实现，
绝不阻塞主流程。配置存 `config/mcp.json`。

对外错误文案遵守设计契约第 10 条：不出现 MCP server / JSON-RPC / subprocess / tokens
这类研发词，写成作者能懂的话（如「外部工具未响应，已改用内置检索」）。
"""

from __future__ import annotations

import asyncio
import json
import shlex
import time
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

import httpx

from .. import config as _config
from ..config import Settings, get_settings
from ..core.memory import MemoryIndex
from ..errors import NotFound

__all__ = [
    "McpServer",
    "McpRegistry",
    "McpClient",
    "ToolGateway",
    "builtin_lookup_setting",
    "builtin_search_reference",
    "builtin_fetch_history",
    "DEGRADE_NOTE",
    "MCP_CONFIG_COMMENT",
]

def _config_file() -> Path:
    """配置文件路径**延迟解析**：这样测试或部署时可以把 `config/` 指到别处，
    而不会把状态写回仓库里的真实配置。

    注意：这里**必须**走 `_config.CONFIG_DIR`（模块属性，可在测试里被替换），
    若在 import 期就 `from ..config import CONFIG_DIR` 取到值，测试隔离会失效——
    写入会落到仓库里的真实 `config/mcp.json`。
    """
    return (_config.get_settings().config_dir or _config.CONFIG_DIR) / "mcp.json"


#: 面向作者的降级提示（不含研发词）
DEGRADE_NOTE = "外部工具未响应，已改用内置检索"

MCP_CONFIG_COMMENT = (
    "MCP 服务器配置（规划文档 §6.9）。MCP 永远是增强而非依赖："
    "MCP 不可用时全流程自动降级为内置检索，不阻塞主流程。"
    "transport 取 stdio 或 http；command 供 stdio 使用（相对路径以 server/ 为基准），"
    "url 供 http 使用。设置页可以直接增删改这份清单。"
)

_TIMEOUT = 10.0          # 单次请求超时（秒）
_PROTOCOL_VERSION = "2024-11-05"


# ==========================================================================
# 数据结构
# ==========================================================================

@dataclass
class McpServer:
    name: str
    transport: str = "stdio"            # "stdio" | "http"
    command: str = ""                   # stdio 用
    url: str = ""                       # http 用
    tools: list[str] = field(default_factory=list)
    enabled: bool = False
    status: str = "idle"                # ok | idle | failed
    latency: int | None = None
    calls: int = 0
    error: str | None = None

    def public(self) -> dict[str, Any]:
        """字段名与 mock.js 的 mcpServers 一致。"""
        data: dict[str, Any] = {"name": self.name, "transport": self.transport}
        if self.transport == "http":
            data["url"] = self.url
        else:
            data["command"] = self.command
        data["tools"] = list(self.tools)
        data["enabled"] = self.enabled
        data["status"] = self.status
        data["latency"] = self.latency
        data["calls"] = self.calls
        if self.error:
            data["error"] = self.error
        return data

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "McpServer":
        allowed = {f.name for f in fields(cls)}
        data = {k: v for k, v in (raw or {}).items() if k in allowed}
        tools = data.get("tools")
        if isinstance(tools, list):
            data["tools"] = [str(t) for t in tools]
        return cls(**data)


#: 兜底配置：只在 `config/mcp.json` **缺失或损坏**时用。
#: 第 1 条是本项目自带的、真能跑通的示例（见 `server/mcp/example_server.py`）；
#: 第 2 条是 Obsidian 资料库的预留接口（见 `server/mcp/obsidian_vault.py`），
#: 默认停用——填好 `DOBI_OBSIDIAN_VAULT` 再启用即可。
DEFAULT_SERVERS: list[dict[str, Any]] = [
    {"name": "本地档案库 local-archive", "transport": "stdio",
     "command": "python3 mcp/example_server.py",
     "tools": ["lookup_setting", "search_reference", "fetch_history"],
     "enabled": True, "status": "idle", "latency": None, "calls": 0},
    {"name": "Obsidian 笔记库 obsidian-vault", "transport": "stdio",
     "command": "python3 mcp/obsidian_vault.py",
     "tools": ["vault_status", "list_notes", "search_notes", "read_note"],
     "enabled": False, "status": "idle", "latency": None, "calls": 0},
    {"name": "资料检索 reference-search", "transport": "http",
     "url": "https://mcp.local/reference/mcp",
     "tools": ["search_reference"],
     "enabled": False, "status": "idle", "latency": None, "calls": 0},
]


# ==========================================================================
# 单个服务器的 JSON-RPC 2.0 客户端
# ==========================================================================

class _McpError(Exception):
    """内部信号：本次外部调用失败，由上层转成降级。**不抛给最终用户。**"""

    def __init__(self, message: str = DEGRADE_NOTE) -> None:
        super().__init__(message)
        self.message = message


def _parse_sse(text: str, want_id: Any) -> dict[str, Any] | None:
    """从 text/event-stream 响应里取出与 `want_id` 匹配的 JSON-RPC 消息。"""
    fallback: dict[str, Any] | None = None
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        if want_id is None or obj.get("id") == want_id:
            return obj
        fallback = fallback or obj
    return fallback


class McpClient:
    """单个服务器的 JSON-RPC 2.0 客户端。支持 stdio（子进程）与 http（POST）两种传输。"""

    def __init__(self, server: McpServer) -> None:
        self.server = server
        self._proc: asyncio.subprocess.Process | None = None
        self._http: httpx.AsyncClient | None = None
        self._id = 0
        self._lock = asyncio.Lock()

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    # ---------------- stdio ----------------

    async def _ensure_proc(self) -> asyncio.subprocess.Process:
        if self._proc is not None and self._proc.returncode is None:
            return self._proc
        argv = shlex.split(self.server.command or "")
        if not argv:
            raise _McpError()
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *argv,
                # 配置里的命令是相对路径（文档约定「以 server/ 为基准」，见
                # MCP_CONFIG_COMMENT 与 mcp/example_server.py）。不固定 cwd 的话，
                # 只有从 server/ 启动后端才找得到脚本，换目录启动必然
                # FileNotFoundError 并静默降级成内置检索。
                cwd=_config.SERVER_ROOT,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (FileNotFoundError, OSError) as exc:
            raise _McpError() from exc
        return self._proc

    async def _stdio_send(self, message: dict[str, Any]) -> None:
        proc = await self._ensure_proc()
        assert proc.stdin is not None
        line = json.dumps(message, ensure_ascii=False) + "\n"
        try:
            proc.stdin.write(line.encode("utf-8"))
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, OSError) as exc:
            raise _McpError() from exc

    async def _stdio_read(self, want_id: Any) -> dict[str, Any]:
        proc = await self._ensure_proc()
        assert proc.stdout is not None
        deadline = time.monotonic() + _TIMEOUT
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _McpError()
            try:
                raw = await asyncio.wait_for(proc.stdout.readline(), remaining)
            except asyncio.TimeoutError as exc:
                raise _McpError() from exc
            if not raw:  # 进程已退出 / 管道关闭
                raise _McpError()
            text = raw.decode("utf-8", "ignore").strip()
            if not text:
                continue
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                continue  # 忽略服务端的非 JSON 噪声行
            if not isinstance(data, dict):
                continue
            if want_id is None or data.get("id") == want_id:
                return data
            # 其他 id（服务端主动推送）忽略，继续等我们这条

    # ---------------- http ----------------

    async def _http_post(self, message: dict[str, Any]) -> dict[str, Any] | None:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True)
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if not self.server.url:
            raise _McpError()
        try:
            resp = await self._http.post(self.server.url, json=message, headers=headers)
        except httpx.HTTPError as exc:
            raise _McpError() from exc
        if resp.status_code >= 400:
            raise _McpError()
        ctype = resp.headers.get("content-type", "")
        if "text/event-stream" in ctype:
            return _parse_sse(resp.text, message.get("id"))
        try:
            return resp.json()
        except (json.JSONDecodeError, ValueError) as exc:
            raise _McpError() from exc

    # ---------------- 统一收发 ----------------

    async def _request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        async with self._lock:
            message: dict[str, Any] = {"jsonrpc": "2.0", "id": self._next_id(),
                                       "method": method}
            if params is not None:
                message["params"] = params
            if self.server.transport == "http":
                data = await self._http_post(message)
            else:
                await self._stdio_send(message)
                data = await self._stdio_read(message["id"])
            if data is None:
                raise _McpError()
            if isinstance(data, dict) and data.get("error"):
                raise _McpError()
            if isinstance(data, dict):
                return data.get("result")
            return None

    async def _notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        async with self._lock:
            message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
            if params is not None:
                message["params"] = params
            if self.server.transport == "http":
                await self._http_post(message)
            else:
                await self._stdio_send(message)

    # ---------------- 对外 API ----------------

    async def initialize(self) -> dict[str, Any]:
        result = await self._request("initialize", {
            "protocolVersion": _PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "dobi", "version": "1.0.0"},
        })
        await self._notify("notifications/initialized", {})
        return result if isinstance(result, dict) else {}

    async def list_tools(self) -> list[dict[str, Any]]:
        result = await self._request("tools/list", {})
        tools = result.get("tools") if isinstance(result, dict) else None
        return tools if isinstance(tools, list) else []

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = await self._request("tools/call", {"name": name, "arguments": arguments})
        return result if isinstance(result, dict) else {"content": result}

    async def close(self) -> None:
        if self._http is not None:
            try:
                await self._http.aclose()
            except Exception:
                pass
            self._http = None
        proc = self._proc
        self._proc = None
        if proc is not None and proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(proc.wait(), 2)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass


# ==========================================================================
# 配置与运行状态
# ==========================================================================

class McpRegistry:
    """MCP 服务器配置与运行状态。配置存 `config/mcp.json`。"""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.path: Path = _config_file()
        self._servers: list[McpServer] | None = None

    # ---------------- 读写 ----------------

    def _load(self) -> list[McpServer]:
        raw = None
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                raw = None
        items = raw.get("servers") if isinstance(raw, dict) else raw
        # 注意：**空列表是合法状态**（作者把外部工具全删了），不能回落到默认值，
        # 否则「删除最后一个」会看起来无效。只有文件缺失/结构不对才用兜底。
        if not isinstance(items, list):
            items = DEFAULT_SERVERS
        return [McpServer.from_dict(x) for x in items if isinstance(x, dict)]

    def servers(self) -> list[McpServer]:
        if self._servers is None:
            self._servers = self._load()
        return self._servers

    def save(self, servers: list[McpServer]) -> None:
        self._servers = list(servers)
        payload = {"_comment": MCP_CONFIG_COMMENT,
                   "servers": [s.public() for s in servers]}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                             encoding="utf-8")

    def get(self, name: str) -> McpServer | None:
        key = (name or "").strip()
        return next((s for s in self.servers() if self._matches(s, key)), None)

    @staticmethod
    def _matches(server: McpServer, key: str) -> bool:
        """支持用完整名或短标识匹配，如 `百科拓展 wiki-bridge` 与 `wiki-bridge` 等价。"""
        if not key:
            return False
        return server.name == key or server.name.split(" ")[-1] == key

    def toggle(self, name: str) -> McpServer:
        server = self.get(name)
        if server is None:
            raise NotFound(f"找不到这个外部工具：{name}")
        server.enabled = not server.enabled
        self.save(self.servers())
        return server

    # ---------------- 连通性测试 ----------------

    async def test(self, name: str) -> dict[str, Any]:
        """连通性测试：initialize + tools/list。**失败一律吞掉**，只回状态。"""
        server = self.get(name)
        if server is None:
            return {"ok": False, "latency": None, "tools": [], "error": "找不到这个外部工具"}

        client = McpClient(server)
        started = time.perf_counter()
        try:
            await client.initialize()
            tools = await client.list_tools()
            latency = int((time.perf_counter() - started) * 1000)
            names = [str(t.get("name")) for t in tools
                     if isinstance(t, dict) and t.get("name")]
            server.status = "ok"
            server.latency = latency
            server.error = None
            if names:
                server.tools = names
            self.save(self.servers())
            return {"ok": True, "latency": latency, "tools": server.tools, "error": None}
        except _McpError as exc:
            server.status = "failed"
            server.latency = None
            server.error = exc.message
            self.save(self.servers())
            return {"ok": False, "latency": None, "tools": [], "error": exc.message}
        except Exception:
            # 任何意料之外的异常也不能抛给上层
            server.status = "failed"
            server.latency = None
            server.error = DEGRADE_NOTE
            self.save(self.servers())
            return {"ok": False, "latency": None, "tools": [], "error": DEGRADE_NOTE}
        finally:
            await client.close()

    # ---------------- 工具调用 ----------------

    async def call(self, tool: str, arguments: dict[str, Any],
                   *, server: str | None = None) -> dict[str, Any]:
        """调用某个外部工具。返回 `{ok, tool, server, result, error, latency}`，**不抛异常**。"""
        target = self.get(server) if server else next(
            (s for s in self.servers() if s.enabled and tool in s.tools), None)
        if target is None:
            return {"ok": False, "tool": tool, "server": None, "result": None,
                    "error": DEGRADE_NOTE, "latency": None}

        client = McpClient(target)
        started = time.perf_counter()
        try:
            await client.initialize()
            result = await client.call_tool(tool, arguments)
            latency = int((time.perf_counter() - started) * 1000)
            target.calls += 1
            target.status = "ok"
            target.latency = latency
            target.error = None
            self.save(self.servers())
            return {"ok": True, "tool": tool, "server": target.name,
                    "result": result, "error": None, "latency": latency}
        except _McpError as exc:
            target.status = "failed"
            target.error = exc.message
            self.save(self.servers())
            return {"ok": False, "tool": tool, "server": target.name,
                    "result": None, "error": exc.message, "latency": None}
        except Exception:
            target.status = "failed"
            target.error = DEGRADE_NOTE
            self.save(self.servers())
            return {"ok": False, "tool": tool, "server": target.name,
                    "result": None, "error": DEGRADE_NOTE, "latency": None}
        finally:
            await client.close()


# ==========================================================================
# 内置降级实现（签名与 MCP 工具一致）
# ==========================================================================

async def builtin_lookup_setting(store, *, query: str,
                                 category: str | None = None) -> dict[str, Any]:
    """内置「查设定」：在世界观规则里按关键字 / 分类检索。"""
    query = (query or "").strip()
    items: list[dict[str, Any]] = []
    for rule in store.world().rules:
        if category and rule.category != category:
            continue
        if query and not (query in rule.rule or query in rule.note or query in rule.category):
            continue
        items.append({"id": rule.id, "category": rule.category, "kind": rule.kind,
                      "rule": rule.rule, "note": rule.note})
    return {"ok": True, "source": "builtin", "query": query,
            "category": category, "items": items}


async def builtin_search_reference(store, *, query: str, k: int = 5) -> dict[str, Any]:
    """内置「查资料」：用 `core.memory` 的 BM25 检索真相文件。"""
    try:
        hits = MemoryIndex(store).search(query, k=max(1, int(k)))
    except Exception:
        hits = []
    return {"ok": True, "source": "builtin", "query": query, "items": hits}


async def builtin_fetch_history(store, *, chapter: int) -> dict[str, Any]:
    """内置「查历史章节」：读取指定章正文与摘要。"""
    try:
        data = store.read_chapter(int(chapter))
    except Exception:
        data = {"chapter": int(chapter), "title": "", "words": 0, "pov": "",
                "paragraphs": []}
    summary = store.summary(int(chapter))
    return {"ok": True, "source": "builtin", "chapter": int(chapter),
            "title": data.get("title", ""), "words": data.get("words", 0),
            "pov": data.get("pov", ""),
            "summary": summary.summary if summary else "",
            "paragraphs": data.get("paragraphs", [])}


# ==========================================================================
# 统一工具入口
# ==========================================================================

class ToolGateway:
    """统一工具入口。`use_mcp=True` 时优先走 MCP，失败自动回落内置实现。"""

    def __init__(self, store, registry: McpRegistry | None = None) -> None:
        self.store = store
        self.registry = registry or McpRegistry()

    async def lookup_setting(self, *, query: str, category: str | None = None,
                             use_mcp: bool = True) -> dict[str, Any]:
        return await self._dispatch(
            "lookup_setting",
            {"query": query, **({"category": category} if category else {})},
            lambda: builtin_lookup_setting(self.store, query=query, category=category),
            use_mcp=use_mcp,
        )

    async def search_reference(self, *, query: str, k: int = 5,
                               use_mcp: bool = True) -> dict[str, Any]:
        return await self._dispatch(
            "search_reference", {"query": query, "k": k},
            lambda: builtin_search_reference(self.store, query=query, k=k),
            use_mcp=use_mcp,
        )

    async def fetch_history(self, *, chapter: int,
                            use_mcp: bool = True) -> dict[str, Any]:
        return await self._dispatch(
            "fetch_history", {"chapter": chapter},
            lambda: builtin_fetch_history(self.store, chapter=chapter),
            use_mcp=use_mcp,
        )

    async def _dispatch(self, tool: str, arguments: dict[str, Any],
                        builtin, *, use_mcp: bool) -> dict[str, Any]:
        note: str | None = None
        if use_mcp:
            try:
                outcome = await self.registry.call(tool, arguments)
            except Exception:  # Registry.call 理论上不抛，这里再兜一层
                outcome = {"ok": False, "error": DEGRADE_NOTE}
            if outcome.get("ok"):
                return {"ok": True, "tool": tool, "via": "mcp",
                        "server": outcome.get("server"), "latency": outcome.get("latency"),
                        "note": None, "data": outcome.get("result")}
            note = outcome.get("error") or DEGRADE_NOTE
        else:
            note = "已停用外部工具，改用内置检索"

        try:
            data = await builtin()
        except Exception:
            data = {"ok": False, "source": "builtin",
                    "error": "内置检索也未能完成，请稍后重试。"}
        return {"ok": True, "tool": tool, "via": "builtin", "server": None,
                "latency": None, "note": note, "data": data}
