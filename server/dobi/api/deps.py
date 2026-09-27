"""API 依赖：项目解析、模型客户端、项目级锁、SSE 输出。

两件事值得说明：

1. **项目级锁**：同一本书的写操作必须串行（规划文档 §6.6「并发写同一本书」），
   不同项目之间互不影响、可并行。
2. **密钥隔离**：`LLMClient` 是唯一接触密钥的地方，且密钥只从环境变量读；
   所有 API 响应都不含密钥（`ProviderSpec.public()` 只给「已配置 + 脱敏指纹」）。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Iterable

from fastapi import Request
from fastapi.responses import StreamingResponse

from ..config import Settings, get_settings
from ..core.checkpoint import CheckpointManager
from ..core.metering import Meter
from ..core.store import ProjectStore
from ..errors import NotFound
from ..llm.provider import LLMClient

__all__ = [
    "settings", "projects_root", "list_stores", "get_store", "project_id_of",
    "current_project_id", "set_current_project", "make_meter", "make_client",
    "checkpoint_manager", "lock_for", "sse_response", "sse_event",
]

_CURRENT_FILE = "current.json"
_LOCKS: dict[str, asyncio.Lock] = {}

def settings() -> Settings:
    return get_settings()


def projects_root() -> Path:
    root = settings().projects_dir
    root.mkdir(parents=True, exist_ok=True)
    return root


def list_stores() -> list[ProjectStore]:
    root = projects_root()
    out: list[ProjectStore] = []
    for path in sorted(root.iterdir()):
        if path.is_dir() and (path / "meta.json").exists():
            out.append(ProjectStore(path))
    out.sort(key=lambda s: s.meta().updated_at, reverse=True)
    return out


def get_store(project_id: str) -> ProjectStore:
    store = ProjectStore(projects_root() / project_id)
    if not store.exists:
        raise NotFound(f"没有这个作品：{project_id}")
    return store


def project_id_of(request: Request) -> str:
    pid = request.path_params.get("project_id")
    if pid:
        return str(pid)
    current = current_project_id()
    if not current:
        raise NotFound("还没有选定作品。请先在「我的作品」里打开一本。")
    return current


# ---------------- 「当前作品」指针 ----------------

def _current_path() -> Path:
    return settings().data_dir / _CURRENT_FILE


def current_project_id() -> str | None:
    path = _current_path()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    pid = data.get("id")
    if pid and (projects_root() / pid / "meta.json").exists():
        return str(pid)
    return None


def set_current_project(project_id: str) -> None:
    path = _current_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"id": project_id}, ensure_ascii=False), encoding="utf-8")


# ---------------- 计量与客户端 ----------------

def make_meter(store: ProjectStore) -> Meter:
    return Meter(store)


def checkpoint_manager(store: ProjectStore) -> CheckpointManager:
    return CheckpointManager(store)


def make_client(store: ProjectStore, *, with_usage: bool = True) -> LLMClient:
    """构造模型客户端。`on_usage` 负责把每次调用记进本项目流水。"""
    meter = Meter(store)
    if not with_usage:
        return LLMClient()

    from ..core.schema import UsageEntry

    def on_usage(entry: dict[str, Any]) -> None:
        tokens = entry.get("tokens") or {}
        try:
            chapter = int(entry.get("chapter") or 0)
        except (TypeError, ValueError):
            chapter = 0
        meter.record(UsageEntry(
            chapter=chapter,
            step=str(entry.get("step") or ""),
            role=str(entry.get("role") or ""),
            provider=str(entry.get("provider") or ""),
            model=str(entry.get("model") or ""),
            prompt_tokens=int(tokens.get("prompt_tokens") or 0),
            completion_tokens=int(tokens.get("completion_tokens") or 0),
            total_tokens=int(tokens.get("total_tokens") or 0),
            cost=float(entry.get("cost") or 0.0),
            latency_ms=int(entry.get("latencyMs") or 0),
            attempts=int(entry.get("attempts") or 1),
            ts=str(entry.get("ts") or ""),
        ))

    return LLMClient(on_usage=on_usage)


def lock_for(project_id: str) -> asyncio.Lock:
    """项目级锁：同一本书的写操作串行，避免状态竞争。

    锁按「事件循环 + 项目」分桶 —— `asyncio.Lock` 会绑定到创建它的循环，
    测试与多 worker 场景下换循环复用会直接报错。
    """
    try:
        loop_id = id(asyncio.get_running_loop())
    except RuntimeError:
        loop_id = 0
    key = f"{loop_id}:{project_id}"
    if key not in _LOCKS:
        _LOCKS[key] = asyncio.Lock()
    return _LOCKS[key]


async def guarded(project_id: str, coro):
    """在项目锁内执行。已在锁内时直接执行（避免自锁死）。"""
    lock = lock_for(project_id)
    if lock.locked():
        return await coro
    async with lock:
        return await coro


# ---------------- SSE ----------------

def sse_event(event: str, data: Any) -> str:
    payload = data if isinstance(data, str) else json.dumps(
        data, ensure_ascii=False, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


def sse_response(source: Callable[[], AsyncIterator[dict[str, Any]]]) -> StreamingResponse:
    """把「产出 dict 的异步生成器」包装成 SSE。

    每个 dict 的 `type` 作为事件名，其余字段作为 data —— 前端 `EventSource` 或
    `fetch` 流都能直接消费。首帧送一个 `ready` 注释，避免代理缓冲。
    """

    async def _gen() -> AsyncIterator[str]:
        yield ": dobi stream open\n\n"
        try:
            async for item in source():
                event = str(item.get("type") or "message")
                yield sse_event(event, item)
        except asyncio.CancelledError:
            yield sse_event("cancelled", {"message": "已停止。"})
            raise
        except Exception as exc:  # 流内错误必须以事件形式送达，否则前端只能看到连接断开
            from ..errors import DobiError
            if isinstance(exc, DobiError):
                yield sse_event("error", {"code": exc.code, "message": exc.message})
            else:
                yield sse_event("error", {"code": "internal",
                                          "message": f"执行中断：{exc}"})

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
