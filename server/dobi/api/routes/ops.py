"""生产运行、实时干预、拆书、设置（服务商 / MCP）、健康检查。"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request
from pydantic import Field

from ...config import get_settings, load_providers, load_roles, mask, save_providers
from ...core.checkpoint import CheckpointManager
from ...errors import BadRequest, NotConfigured, NotFound
from ...ingest.disassemble import Disassembler, load as load_disassemble
from ...integrations.mcp import McpRegistry, ToolGateway
from ...orchestrator import BookRunner, Steering
from ..deps import (get_store, guarded, list_stores, make_client, make_meter,
                    sse_response)
from ..serialize import ApiBody, one, to_api

router = APIRouter(tags=["ops"])


# ==========================================================================
# 整本生产
# ==========================================================================

class RunBody(ApiBody):
    max_chapters: int = Field(default=20, ge=1, le=200)
    from_chapter: int | None = None


@router.post("/projects/{project_id}/run")
async def run_book(project_id: str, body: RunBody | None = None) -> Any:
    """整本生产（SSE）。跑到完成或命中熔断条件即停。

    事件：`run_start` / `resume` / `planning` / `chapter_start` / `step` /
    `delta` / `chapter_done` / `paused` / `stopped` / `run_done` / `error`
    """
    store = get_store(project_id)
    params = body or RunBody()
    make_meter(store).check_budget()

    async def _stream():
        queue: "asyncio.Queue[dict[str, Any]]" = asyncio.Queue()

        async def _runner():
            try:
                async with make_client(store) as client:
                    runner = BookRunner(store, client, make_meter(store))
                    await runner.run(
                        max_chapters=params.max_chapters,
                        from_chapter=params.from_chapter,
                        on_event=lambda ev: queue.put_nowait(ev),
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                queue.put_nowait({"type": "error", "code": "internal", "message": str(exc)})

        task = asyncio.ensure_future(_runner())
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=0.4)
                except asyncio.TimeoutError:
                    if task.done():
                        break
                    yield {"type": "heartbeat"}
                    continue
                if event.get("type") != "heartbeat":
                    yield event
                if task.done() and queue.empty():
                    break
        finally:
            if not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

    return sse_response(_stream)


@router.get("/projects/{project_id}/run/state")
def run_state(project_id: str, chapter: int | None = None) -> dict[str, Any]:
    store = get_store(project_id)
    cp = CheckpointManager(store)
    meter = make_meter(store)
    overview = store.chapters_overview()
    return {
        "resume": cp.diagnose(target_chapter=chapter).public(),
        "progress": [cp.progress(c["n"]) for c in overview if c["status"] not in ("todo", "planned")],
        "budget": meter.budget(),
        "hooks": store.hook_stats(),
        "steering": to_api(store.steering_directives()),
        "recentCheckpoints": [to_api(c) for c in store.checkpoints()[-10:]][::-1],
    }


# ==========================================================================
# 实时干预
# ==========================================================================

class SteerBody(ApiBody):
    text: str = Field(min_length=1)
    confirm: bool = False


@router.post("/projects/{project_id}/steer")
async def steer(project_id: str, body: SteerBody) -> dict[str, Any]:
    store = get_store(project_id)

    async def _run():
        async with make_client(store) as client:
            steering = Steering(store, client, make_meter(store))
            result = await steering.apply(body.text, confirm=body.confirm)
        return one(result)

    return await guarded(project_id, _run())


class DirectiveBody(ApiBody):
    action: str = "confirm"


@router.post("/projects/{project_id}/steer/{directive_id}")
def decide_directive(project_id: str, directive_id: str, body: DirectiveBody) -> dict[str, Any]:
    store = get_store(project_id)
    steering = Steering(store, make_client(store, with_usage=False), make_meter(store))
    if body.action == "confirm":
        return one(steering.confirm_directive(directive_id))
    if body.action == "dismiss":
        return one(steering.dismiss_directive(directive_id))
    raise BadRequest("只能确认或撤销这条干预指令。")


# ==========================================================================
# 拆书
# ==========================================================================

class DisassembleBody(ApiBody):
    filename: str = Field(default="未命名.txt", max_length=200)
    text: str = Field(min_length=200)
    sample_ratio: float = 1.0


@router.get("/projects/{project_id}/disassemble")
def get_disassemble(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    saved = load_disassemble(store)
    if saved is None:
        return {"source": None, "stages": [], "stats": {}, "extracted": {},
                "proposals": [], "message": "还没有拆过书。"}
    return to_api(saved)


@router.post("/projects/{project_id}/disassemble")
async def run_disassemble(project_id: str, body: DisassembleBody) -> dict[str, Any]:
    store = get_store(project_id)

    async def _run():
        async with make_client(store) as client:
            worker = Disassembler(store, client, make_meter(store))
            result = await worker.run(filename=body.filename, text=body.text,
                                      sample_ratio=body.sample_ratio)
        return one(result)

    return await guarded(project_id, _run())


class ProposalDecisionBody(ApiBody):
    action: str | None = None


@router.post("/projects/{project_id}/disassemble/proposals/{proposal_id}/decision")
async def decide_proposal(project_id: str, proposal_id: str,
                          body: ProposalDecisionBody) -> dict[str, Any]:
    store = get_store(project_id)
    action = body.action
    if action not in ("accept", "reject", None):
        raise BadRequest("决策只能取 accept / reject / 撤回。")

    async def _run():
        async with make_client(store) as client:
            worker = Disassembler(store, client, make_meter(store))
            result = await worker.decide(proposal_id, action or "null")
        return one(result)

    return await guarded(project_id, _run())


# ==========================================================================
# 设置：服务商
# ==========================================================================

@router.get("/settings/providers")
def get_providers() -> dict[str, Any]:
    settings = get_settings()
    providers = load_providers()
    roles = load_roles()
    return to_api({
        "providers": [p.public(settings.key_mask_keep) for p in providers],
        "roles": [r.public() for r in roles.values()],
        "fallbackChain": [p.name for p in providers if p.enabled and p.configured],
        "configured": any(p.enabled and p.configured for p in providers),
        "envHint": ("至少配置一个密钥才能产出内容。"
                    "密钥请写在服务端的 .env 里，前端只用于显示「已配置 / 未配置」。"),
        "budgetSplit": [
            {"label": "系统规则", "pct": 5}, {"label": "角色/世界观", "pct": 15},
            {"label": "动态事实", "pct": 10}, {"label": "历史摘要", "pct": 20},
            {"label": "当前草稿", "pct": 30}, {"label": "输出预留", "pct": 20},
        ],
    })


class ProviderUpdateBody(ApiBody):
    enabled: bool | None = None
    priority: int | None = None


@router.put("/settings/providers/{name}")
def update_provider(name: str, body: ProviderUpdateBody) -> dict[str, Any]:
    settings = get_settings()
    providers = load_providers()
    target = next((p for p in providers if p.name == name), None)
    if target is None:
        raise NotFound(f"没有这个服务商：{name}")
    if body.enabled is not None:
        target.enabled = body.enabled
    if body.priority is not None:
        target.priority = max(1, body.priority)
    save_providers(providers)
    return {"ok": True,
            "providers": to_api([p.public(settings.key_mask_keep)
                                 for p in load_providers()])}


@router.post("/settings/providers/{name}/probe")
async def probe_provider(name: str) -> dict[str, Any]:
    provider = next((p for p in load_providers() if p.name == name), None)
    if provider is None:
        raise NotFound(f"没有这个服务商：{name}")
    if not provider.configured:
        raise NotConfigured(
            f"「{provider.name}」还没有填密钥。"
            f"请在服务端 .env 里设置 {provider.api_key_ref} 后重启服务。")
    async with make_client(get_store_any(), with_usage=False) as client:
        result = await client.probe(name)
    return to_api({"ok": bool(result.get("ok")), "probe": result,
                   "fingerprint": mask(provider.api_key)})


def get_store_any():
    """探测连通性不需要具体项目，但 LLMClient 需要 store 来记计量时才会用；
    这里借用第一个项目，没有项目时也不影响（探测不产生业务数据）。"""
    stores = list_stores()
    if stores:
        return stores[0]
    # 没有项目时用一个临时目录，仅用于探测
    from ...core.store import ProjectStore
    root = get_settings().data_dir / "_probe"
    if not (root / "meta.json").exists():
        ProjectStore.create(root.parent, "_probe", title="连通性探测")
    return ProjectStore(root)


# ==========================================================================
# 设置：MCP
# ==========================================================================

@router.get("/settings/mcp")
def get_mcp() -> dict[str, Any]:
    registry = McpRegistry()
    servers = registry.servers()
    return {
        "servers": to_api(servers),
        "enabledCount": sum(1 for s in servers if s.enabled),
        "healthyCount": sum(1 for s in servers if s.enabled and s.status == "ok"),
        "note": "外部工具不可用时，全流程会自动回落到内置检索，不会阻塞写作。",
    }


class McpToggleBody(ApiBody):
    name: str


@router.post("/settings/mcp/toggle")
def toggle_mcp(body: McpToggleBody) -> dict[str, Any]:
    registry = McpRegistry()
    server = registry.toggle(body.name)
    return {"ok": True, "server": to_api(server), "servers": to_api(registry.servers())}


@router.post("/settings/mcp/{name}/test")
async def test_mcp(name: str) -> dict[str, Any]:
    registry = McpRegistry()
    result = await registry.test(name)
    return {"ok": bool(result.get("ok")), "result": result,
            "servers": to_api(registry.servers())}


@router.get("/projects/{project_id}/tools/search")
async def tool_search(project_id: str, q: str, k: int = 5) -> dict[str, Any]:
    """检索资料。优先走外部工具，不可用时自动回落内置 BM25 检索。"""
    store = get_store(project_id)
    gateway = ToolGateway(store, McpRegistry())
    return to_api(await gateway.search_reference(query=q, k=k))


# ==========================================================================
# 健康
# ==========================================================================

@router.get("/health")
def health() -> dict[str, Any]:
    settings = get_settings()
    providers = load_providers()
    usable = [p.name for p in providers if p.enabled and p.configured]
    return {
        "ok": True,
        "version": __import__("dobi").__version__,
        "dataDir": str(settings.data_dir),
        "projects": len(list_stores()),
        "providers": {
            "usable": usable,
            "configured": bool(usable),
            "message": ("已配置：" + "、".join(usable)) if usable else
                       "尚未配置任何模型密钥，生成类接口会返回 503。请填写服务端 .env。",
        },
    }
