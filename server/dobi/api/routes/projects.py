"""项目、结构、大纲、共创对话。"""

from __future__ import annotations

import hashlib
from typing import Any

from fastapi import APIRouter, Request
from pydantic import Field

from ...agents import ChatAgent
from ...core.checkpoint import CheckpointManager
from ...core.memory import MemoryIndex
from ...core.schema import OutlineGraph
from ...core.story import KIND_LABELS, book_anchors
from ...core.store import ProjectStore, slugify
from ...errors import BadRequest, Conflict, NotFound
from ...orchestrator import ModeController, Planner
from ..deps import (current_project_id, get_store, guarded, list_stores,
                    make_client, make_meter, project_id_of, projects_root,
                    set_current_project)
from ..serialize import ApiBody, one, table, to_api

router = APIRouter(tags=["projects"])


# ==========================================================================
# 请求体
# ==========================================================================

class CreateProjectBody(ApiBody):
    title: str = Field(min_length=1, max_length=80)
    genre: str = ""
    premise: str = ""
    mode: str = "semi-auto"
    budget_total: float | None = None
    chapters_total: int = 0


class ModeBody(ApiBody):
    mode: str | None = None
    step: str | None = None
    policy: str | None = None
    stop_conditions: list[str] | None = None


class PlanBody(ApiBody):
    targets: list[str] = Field(default_factory=lambda: ["world", "characters", "outline"])
    volumes: int = 2
    force: bool = False


class ChatBody(ApiBody):
    message: str = Field(min_length=1)


# ==========================================================================
# 项目
# ==========================================================================

def _new_project_id(title: str) -> str:
    base = slugify(title, fallback="")
    if not base:
        digest = hashlib.sha1(title.encode("utf-8")).hexdigest()[:8]
        base = f"novel-{digest}"
    root = projects_root()
    pid, i = base, 2
    while (root / pid / "meta.json").exists():
        pid = f"{base}-{i}"
        i += 1
    return pid


@router.get("/projects")
def list_projects() -> dict[str, Any]:
    stores = list_stores()
    current = current_project_id()
    items = []
    for store in stores:
        summary = store.project_summary()
        summary["isCurrent"] = store.id == current
        items.append(summary)
    return {"projects": items, "current": current}


@router.post("/projects", status_code=201)
def create_project(body: CreateProjectBody) -> dict[str, Any]:
    pid = _new_project_id(body.title)
    store = ProjectStore.create(
        projects_root(), pid,
        title=body.title, genre=body.genre or "待定",
        premise=body.premise, logline=body.premise,
        mode=body.mode, budget_total=body.budget_total,
    )
    meta = store.meta()
    if body.chapters_total:
        meta.chapters_total = body.chapters_total
        store.save_meta(meta)
    MemoryIndex(store).reindex()
    set_current_project(pid)
    return {"project": one(store.project_summary(), **{"isCurrent": True})}


@router.get("/projects/{project_id}")
def get_project(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    meta = store.meta()
    mode = ModeController(store).public()
    return {
        "project": one(store.project_summary()),
        "meta": to_api(meta),
        "mode": mode,
    }


@router.delete("/projects/{project_id}")
def delete_project(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    store.delete()
    if current_project_id() == project_id:
        remaining = list_stores()
        set_current_project(remaining[0].id) if remaining else None
    return {"ok": True, "id": project_id}


@router.post("/projects/{project_id}/open")
def open_project(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    set_current_project(project_id)
    return {"ok": True, "project": one(store.project_summary(), **{"isCurrent": True})}


@router.post("/projects/{project_id}/mode")
def set_mode(project_id: str, body: ModeBody) -> dict[str, Any]:
    store = get_store(project_id)
    controller = ModeController(store)
    if body.mode:
        controller.set_mode(body.mode)
    elif body.step:
        if not body.policy:
            raise BadRequest("改了环节策略却没给 policy。")
        controller.set_step(body.step, body.policy)
    if body.stop_conditions is not None:
        controller.set_stop_conditions(body.stop_conditions)
    return controller.public()


# ==========================================================================
# 总览 / 结构 / 大纲
# ==========================================================================

@router.get("/projects/{project_id}/overview")
def overview(project_id: str) -> dict[str, Any]:
    """工作台首屏：一次给全，避免前端拼五个请求。"""
    store = get_store(project_id)
    meter = make_meter(store)
    cp = CheckpointManager(store)
    chapters = store.chapters_overview()
    audits = []
    for item in chapters:
        report = store.read_audit(item["n"])
        if report is not None:
            audits.append({"chapter": item["n"], **report.stats})
    return {
        "project": one(store.project_summary()),
        "chapters": to_api(chapters),
        "hooks": store.hook_stats(),
        "audits": audits,
        "usage": to_api(meter.public(recent=8)),
        "mode": ModeController(store).public(),
        "resume": cp.diagnose().public(),
        "checkpoints": [to_api(c) for c in store.checkpoints()[-8:]][::-1],
        "steering": to_api(store.steering_directives()),
        "style": to_api(store.style()),
    }


@router.get("/projects/{project_id}/structure")
def structure(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    graph: OutlineGraph = store.outline_graph()
    return {
        "chapters": to_api(store.chapters_overview()),
        "volumes": to_api(graph.volumes),
        "nodes": to_api(graph.nodes),
        "edges": to_api(graph.edges),
        "compass": to_api(graph.compass),
        "plotlines": to_api(store.subplots()),
        # 全书故事时间锚点：数组顺序即故事时间顺序（剧情树与双轨时间线共用）
        "anchors": to_api(book_anchors(store)),
        "kindLabels": KIND_LABELS,
        "updatedAt": graph.updated_at,
    }


@router.get("/projects/{project_id}/outline/graph")
def outline_graph(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    graph = store.outline_graph()
    return {
        "compass": to_api(graph.compass),
        "volumes": to_api(graph.volumes),
        "nodes": to_api(graph.nodes),
        "edges": to_api(graph.edges),
        "updatedAt": graph.updated_at,
    }


@router.get("/projects/{project_id}/plan/coverage")
def coverage(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    planner = Planner(store, make_client(store, with_usage=False), make_meter(store))
    return to_api(planner.coverage())


# ==========================================================================
# 规划（世界观 / 角色 / 大纲 / 滚卷）
# ==========================================================================

@router.post("/projects/{project_id}/plan")
async def run_plan(project_id: str, body: PlanBody) -> dict[str, Any]:
    store = get_store(project_id)

    async def _run():
        meter = make_meter(store)
        async with make_client(store) as client:
            planner = Planner(store, client, meter)
            outcome = await planner.bootstrap(targets=body.targets, volumes=body.volumes)
        return outcome.public()

    result = await guarded(project_id, _run())
    return one(result, coverage=Planner(
        store, make_client(store, with_usage=False), make_meter(store)).coverage())


@router.post("/projects/{project_id}/plan/rolling")
async def roll_plan(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)

    async def _run():
        async with make_client(store) as client:
            planner = Planner(store, client, make_meter(store))
            outcome = await planner.roll_next()
        return outcome.public()

    return one(await guarded(project_id, _run()))


# ==========================================================================
# 共创对话
# ==========================================================================

def _chat_agent(store: ProjectStore):
    return ChatAgent(store, make_client(store), make_meter(store))


@router.get("/projects/{project_id}/chat")
def get_chat(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    agent = _chat_agent(store)
    return {"seed": to_api(agent.seed()), "messages": to_api(agent.history())}


@router.post("/projects/{project_id}/chat")
async def send_chat(project_id: str, body: ChatBody) -> dict[str, Any]:
    store = get_store(project_id)

    async def _run():
        async with make_client(store) as client:
            agent = ChatAgent(store, client, make_meter(store))
            result = await agent.reply(body.message)
            result["seed"] = agent.seed()
        return result

    return one(await guarded(project_id, _run()))


# ==========================================================================
# 项目级统计
# ==========================================================================

@router.get("/projects/{project_id}/stats")
def project_stats(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    memory = MemoryIndex(store)
    return {
        "chapters": len(store.chapters_overview()),
        "words": sum(c["words"] for c in store.chapters_overview()),
        "hooks": store.hook_stats(),
        "characters": len(store.characters()),
        "worldRules": len(store.world().rules),
        "memory": memory.stats(),
        "budget": make_meter(store).budget(),
    }
