"""章节：正文、生产流水线、审查、评审、修订、定稿、故事时间。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from ...agents import Auditor, Reviser, Reviewer
from ...consistency.l1 import rule_catalog
from ...core.checkpoint import CheckpointManager
from ...core.context import build_context
from ...core.metering import Meter
from ...core.schema import PIPELINE_STEPS, STEP_LABELS
from ...core.story import KIND_LABELS, book_anchors, chapter_events, match_anchor
from ...errors import BadRequest, NotFound
from ...orchestrator import ModeController, Pipeline
from ..deps import (get_store, guarded, make_client, make_meter, sse_response)
from ..serialize import ApiBody, one, table, to_api

router = APIRouter(tags=["chapters"])


# ==========================================================================
# 请求体
# ==========================================================================

class AuditBody(ApiBody):
    dims: list[str] | None = None
    run_l2: bool = True


class DecisionBody(ApiBody):
    action: str | None = None   # accept | ignore | null


class GenerateBody(ApiBody):
    force: bool = False
    temperature: float | None = None


class ReviseBody(ApiBody):
    severities: list[str] = Field(default_factory=lambda: ["blocker", "major"])


# ==========================================================================
# 读取
# ==========================================================================

@router.get("/projects/{project_id}/chapters")
def list_chapters(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    return {"chapters": to_api(store.chapters_overview())}


@router.get("/projects/{project_id}/chapters/{n}")
def get_chapter(project_id: str, n: int) -> dict[str, Any]:
    store = get_store(project_id)
    data = store.read_chapter(n)
    node = store.outline_graph().node(n)
    return {
        "chapter": to_api(data),
        "node": to_api(node),
        "audit": to_api(store.read_audit(n)),
        "review": to_api(store.read_review(n)),
        "checkpoints": [to_api(c) for c in store.checkpoints(n)],
    }


@router.get("/projects/{project_id}/chapters/{n}/manuscript")
def get_manuscript(project_id: str, n: int) -> dict[str, Any]:
    """手稿编辑区数据：带页边栏编号的段落。"""
    store = get_store(project_id)
    data = store.read_chapter(n)
    report = store.read_audit(n)
    marks: dict[int, dict[str, str]] = {}
    if report is not None:
        for item in report.items:
            idx = _para_index(item.ref)
            if idx:
                marks[idx] = {"mark": "hl", "note": f"{item.dim}：{item.suggestion or item.evidence}"}
    paragraphs = [
        {"gutter": f"{n}.{i}", "text": text, **marks.get(i, {})}
        for i, text in enumerate(data["paragraphs"], start=1)
    ]
    return {
        "n": n, "title": data["title"], "status": data["status"],
        "words": data["words"], "pov": data["pov"], "paragraphs": paragraphs,
    }


@router.get("/projects/{project_id}/chapters/{n}/detail")
def get_chapter_detail(project_id: str, n: int) -> dict[str, Any]:
    """章节详情页所需的全部派生数据（五张图的数据源）。"""
    store = get_store(project_id)
    data = store.read_chapter(n)
    graph = store.outline_graph()
    node = graph.node(n)
    if node is None and not data["paragraphs"]:
        raise NotFound(f"第 {n} 章还没有章纲，先生成章纲。")

    acts = [{"name": v.name, "from": v.from_chapter, "to": v.to_chapter,
             "note": v.goal, "status": v.status} for v in graph.volumes]
    act = next((a for a in acts
                if a["from"] <= n <= (a["to"] or a["from"])), None)

    events = chapter_events(store, n)
    anchors = book_anchors(store)
    located = 0
    for event in events:
        anchor = match_anchor(event["label"], anchors)
        event["anchorId"] = anchor["id"] if anchor else None
        event["anchorAt"] = anchor["storyAt"] if anchor else None
        if anchor:
            located += 1

    return {
        "chapter": to_api(data),
        "node": to_api(node),
        "acts": acts,
        "act": act,
        "beats": _act_beats(store, act, n),
        "pipeline": _pipeline_view(store, n),
        "context": _context_view(store, n),
        "timeline": {
            "events": events,
            "anchors": anchors,
            "located": located,
            "total": len(events),
            "kindLabels": KIND_LABELS,
        },
        "fishbone": _fishbone(store, n),
        "rules": rule_catalog(),
    }


@router.get("/projects/{project_id}/chapters/{n}/audit")
def get_audit(project_id: str, n: int) -> dict[str, Any]:
    store = get_store(project_id)
    report = store.read_audit(n)
    if report is None:
        raise NotFound(f"第 {n} 章还没有审查报告，先跑一次审查。")
    return one(report, rules=rule_catalog())


@router.get("/projects/{project_id}/chapters/{n}/review")
def get_review(project_id: str, n: int) -> dict[str, Any]:
    store = get_store(project_id)
    report = store.read_review(n)
    if report is None:
        raise NotFound(f"第 {n} 章还没有评审报告，先跑一次评审。")
    return one(report)


@router.get("/projects/{project_id}/chapters/{n}/checkpoints")
def get_checkpoints(project_id: str, n: int) -> dict[str, Any]:
    store = get_store(project_id)
    cp = CheckpointManager(store)
    return {
        "progress": cp.progress(n),
        "checkpoints": [to_api(c) for c in store.checkpoints(n)],
    }


@router.get("/projects/{project_id}/chapters/{n}/context")
def get_context(project_id: str, n: int) -> dict[str, Any]:
    store = get_store(project_id)
    return _context_view(store, n)


# ==========================================================================
# 生成（SSE）
# ==========================================================================

@router.post("/projects/{project_id}/chapters/{n}/plan")
async def plan_chapter(project_id: str, n: int) -> dict[str, Any]:
    store = get_store(project_id)

    async def _run():
        async with make_client(store) as client:
            pipeline = Pipeline(store, client, make_meter(store))
            outcome = await pipeline.run_step(n, "plan", force=True)
        return outcome.public()

    return one(await guarded(project_id, _run()))


@router.post("/projects/{project_id}/chapters/{n}/generate")
async def generate_chapter(project_id: str, n: int, body: GenerateBody | None = None) -> Any:
    """流式生成正文。事件：`delta`（逐段文本）/ `step` / `done` / `error`。

    前端断开连接（停止按钮）会取消服务端任务；`Writer` 会在取消路径上
    **把已生成的部分落盘为草稿**，所以停止不会丢稿。
    """
    store = get_store(project_id)
    make_meter(store).check_budget()

    async def _stream():
        import asyncio

        queue: "asyncio.Queue[dict[str, Any]]" = asyncio.Queue()

        async def _runner():
            try:
                async with make_client(store) as client:
                    pipeline = Pipeline(store, client, make_meter(store))
                    await pipeline.run(
                        n, steps=["plan", "context", "draft"],
                        on_event=lambda ev: queue.put_nowait(ev),
                        respect_policy=False,
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                queue.put_nowait({"type": "error", "code": "internal", "message": str(exc)})

        task = asyncio.ensure_future(_runner())
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=0.3)
                except asyncio.TimeoutError:
                    if task.done():
                        break
                    continue
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


@router.post("/projects/{project_id}/chapters/{n}/stop")
def stop_chapter(project_id: str, n: int) -> dict[str, Any]:
    """停止说明：SSE 连接断开即中止，已生成部分已落盘为草稿。

    这个接口是给前端一个「显式收尾」的地方（例如刷新状态、提示已保存多少字）。
    """
    store = get_store(project_id)
    data = store.read_chapter(n)
    return {
        "ok": True,
        "chapter": n,
        "saved": {"words": data["words"], "paragraphs": len(data["paragraphs"]),
                  "status": data["status"]},
        "message": ("已停止。已生成的部分已保存为草稿，下次继续写会从断点续写。"
                    if data["paragraphs"] else "已停止。本章还没有内容。"),
    }


# ==========================================================================
# 审查 / 评审 / 去味 / 修订 / 定稿
# ==========================================================================

async def _step_endpoint(store, n: int, step: str, **kwargs: Any) -> dict[str, Any]:
    async def _run():
        async with make_client(store) as client:
            pipeline = Pipeline(store, client, make_meter(store))
            outcome = await pipeline.run_step(n, step, **kwargs)
        return outcome.public()

    return one(await guarded(store.id, _run()))


@router.post("/projects/{project_id}/chapters/{n}/audit")
async def run_audit(project_id: str, n: int, body: AuditBody | None = None) -> dict[str, Any]:
    store = get_store(project_id)
    dims = body.dims if body else None
    run_l2 = body.run_l2 if body else True

    async def _run():
        async with make_client(store) as client:
            meter = make_meter(store)
            auditor = Auditor(store, client, meter)
            report = await auditor.audit(n, dims=dims, run_l2=run_l2)
        return one(report, rules=rule_catalog())

    return await guarded(project_id, _run())


@router.post("/projects/{project_id}/chapters/{n}/review")
async def run_review(project_id: str, n: int) -> dict[str, Any]:
    store = get_store(project_id)

    async def _run():
        async with make_client(store) as client:
            reviewer = Reviewer(store, client, make_meter(store))
            report = await reviewer.review(n)
        return one(report)

    return await guarded(project_id, _run())


@router.post("/projects/{project_id}/chapters/{n}/deai")
async def run_deai(project_id: str, n: int) -> dict[str, Any]:
    store = get_store(project_id)
    return await _step_endpoint(store, n, "deai", force=True)


@router.post("/projects/{project_id}/chapters/{n}/revise")
async def run_revise(project_id: str, n: int, body: ReviseBody | None = None) -> dict[str, Any]:
    store = get_store(project_id)
    return await _step_endpoint(store, n, "revise")


@router.post("/projects/{project_id}/chapters/{n}/commit")
async def commit_chapter(project_id: str, n: int, force: bool = Query(False)) -> dict[str, Any]:
    store = get_store(project_id)
    return await _step_endpoint(store, n, "commit", force=force)


@router.post("/projects/{project_id}/chapters/{n}/findings/{dim}/decision")
def decide_finding(project_id: str, n: int, dim: str, body: DecisionBody) -> dict[str, Any]:
    """对某条发现做决策：接受修订 / 忽略 / 撤回。"""
    store = get_store(project_id)
    report = store.read_audit(n)
    if report is None:
        raise NotFound(f"第 {n} 章还没有审查报告。")
    action = body.action
    if action not in ("accept", "ignore", None):
        raise BadRequest("决策只能取 accept / ignore / 撤回。")

    hit = False
    for item in report.items:
        if item.dim == dim:
            item.decision = action  # type: ignore[assignment]
            item.fixed = action == "accept" and bool(item.patch)
            if action == "accept" and not item.patch:
                item.fixed = False
            hit = True
    if not hit:
        raise NotFound(f"第 {n} 章没有名为「{dim}」的发现。")

    report.stats = _restat(report)
    store.save_audit(report)
    return {"ok": True, "chapter": n, "dim": dim, "action": action,
            "stats": report.stats}


# ==========================================================================
# 项目级审查报告
# ==========================================================================

@router.get("/projects/{project_id}/audit")
def project_audit(project_id: str, chapter: int | None = None) -> dict[str, Any]:
    store = get_store(project_id)
    overview = store.chapters_overview()
    target = chapter
    if target is None:
        candidates = [c["n"] for c in overview if store.read_audit(c["n"]) is not None]
        target = max(candidates) if candidates else None
    if target is None:
        return {"chapter": None, "stats": {}, "items": [],
                "rules": rule_catalog(), "l1": [], "review": [], "diffs": [],
                "chapters": [c["n"] for c in overview], "message": "还没有任何审查报告。"}

    report = store.read_audit(target)
    if report is None:
        raise NotFound(f"第 {target} 章还没有审查报告。")
    payload = one(report, rules=rule_catalog(),
                  chapters=[c["n"] for c in overview if store.read_audit(c["n"]) is not None])
    return payload


# ==========================================================================
# 内部辅助
# ==========================================================================

def _para_index(ref: str) -> int:
    if not ref or "#" not in ref:
        return 0
    tail = ref.split("#", 1)[1]
    if tail.startswith("para-"):
        try:
            return int(tail[5:])
        except ValueError:
            return 0
    return 0


def _act_beats(store, act: dict[str, Any] | None, chapter: int) -> list[dict[str, Any]]:
    if act is None:
        return []
    graph = store.outline_graph()
    out: list[dict[str, Any]] = []
    for node in sorted(graph.nodes, key=lambda n: n.chapter):
        if node.chapter < act["from"] or node.chapter > (act["to"] or act["from"]):
            continue
        out.append({
            "chapter": node.chapter,
            "title": node.title,
            "goal": node.goal,
            "beats": node.beats,
            "status": "past" if node.chapter < chapter else ("current" if node.chapter == chapter else "future"),
        })
    return out


def _pipeline_view(store, chapter: int) -> dict[str, Any]:
    cp = CheckpointManager(store)
    progress = cp.progress(chapter)
    meter = Meter(store)
    entries = [e for e in meter.entries() if e.chapter == chapter]
    by_step: dict[str, dict[str, Any]] = {}
    for entry in entries:
        row = by_step.setdefault(entry.step or "draft",
                                 {"tokens": 0, "cost": 0.0, "calls": 0, "latencyMs": 0})
        row["tokens"] += entry.total_tokens or (entry.prompt_tokens + entry.completion_tokens)
        row["cost"] = round(row["cost"] + entry.cost, 4)
        row["calls"] += 1
        row["latencyMs"] += entry.latency_ms
    steps = []
    for item in progress["steps"]:
        extra = by_step.get(item["key"], {"tokens": 0, "cost": 0.0, "calls": 0, "latencyMs": 0})
        steps.append({**item, **extra})
    return {
        "steps": steps,
        "done": progress["done"],
        "active": progress["active"],
        "total": progress["total"],
        "next": progress["next"],
        "failed": progress["failed"],
        "lastCheckpointAt": progress["lastCheckpointAt"],
        "cost": round(sum(s["cost"] for s in steps), 4),
        "tokens": sum(s["tokens"] for s in steps),
    }


def _context_view(store, chapter: int) -> dict[str, Any]:
    node = store.outline_graph().node(chapter)
    draft = store.chapter_text(chapter)
    from ..deps import make_client
    try:
        window = make_client(store, with_usage=False).window_for("writer")
    except Exception:
        window = 32000
    bundle = build_context(store, chapter, purpose="writer", context_window=window,
                           node=node, draft=draft)
    return bundle.public()


#: 审查维度 → 鱼骨图上的「大骨」分类（归因用）
_CATEGORY_OF_DIM: dict[str, str] = {
    "设定冲突": "设定", "战力/等级漂移": "设定", "数值／等级矛盾": "设定",
    "OOC": "角色", "动机不足": "角色", "情感弧线断裂": "角色", "对话同质化": "角色",
    "节奏单调": "节奏", "场景重复": "节奏", "爽点缺失": "节奏",
    "因果断裂": "结构", "支线停滞": "结构", "时间线矛盾": "结构", "伏笔遗漏": "结构",
    "信息泄露": "结构",
    "文风偏移": "文风",
}


def _fishbone(store, chapter: int) -> dict[str, Any] | None:
    report = store.read_audit(chapter)
    if report is None or not report.items:
        return None
    buckets: dict[str, list[str]] = {}
    for item in report.items:
        category = _CATEGORY_OF_DIM.get(item.dim)
        if category is None:
            category = "文风" if item.dim.startswith("规则 · ") else "其他"
        label = item.dim if not item.dim.startswith("规则 · ") else item.dim
        buckets.setdefault(category, []).append(label)
    severity_rank = {"blocker": 0, "major": 1, "minor": 2}
    worst = min((i.severity for i in report.items), key=lambda s: severity_rank.get(s, 3),
                default="minor")
    return {
        "title": f"第 {chapter} 章的问题归因（共 {len(report.items)} 条）",
        "severity": worst,
        "causes": [{"category": cat, "items": labels}
                   for cat, labels in sorted(buckets.items(), key=lambda x: -len(x[1]))],
    }


def _restat(report) -> dict[str, int]:
    items = report.items
    fixed = sum(1 for i in items if i.fixed)
    total = len(items) or 1
    return {
        "l1": len(report.l1_violations),
        "l2": len([i for i in items if not i.dim.startswith("规则 · ")]),
        "fixed": fixed,
        "open": sum(1 for i in items if not i.fixed),
        "blocker": sum(1 for i in items if i.severity == "blocker" and not i.fixed),
        "major": sum(1 for i in items if i.severity == "major" and not i.fixed),
        "passRate": round(fixed / total * 100) if items else 100,
    }
