"""真相文件视图：角色、伏笔、世界观、文风、成本。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query
from pydantic import Field

from ...agents import Architect
from ...consistency.style import (analyze_style, merge_profile, preset_profile,
                                 presets)
from ...core.schema import Proposal, WorldRule
from ...core.store import TruthWriter, count_words
from ...errors import BadRequest, NotFound
from ..deps import get_store, guarded, make_client, make_meter, projects_root
from ..serialize import ApiBody, one, table, to_api

router = APIRouter(tags=["truth"])


# ==========================================================================
# 角色
# ==========================================================================

@router.get("/projects/{project_id}/characters")
def list_characters(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    chars = store.characters()
    roles: list[str] = []
    for c in chars:
        if c.role not in roles:
            roles.append(c.role)
    return {
        "characters": to_api(chars),
        "roles": ["全部"] + roles,
        "stats": {
            "total": len(chars),
            "lead": sum(1 for c in chars if c.lead),
            "deceased": sum(1 for c in chars if c.deceased),
            "traits": sum(len(c.immutable_traits) for c in chars),
        },
    }


@router.get("/projects/{project_id}/characters/{key}")
def get_character(project_id: str, key: str) -> dict[str, Any]:
    store = get_store(project_id)
    char = store.character(key)
    if char is None:
        raise NotFound(f"没有这个角色：{key}")
    # 与该角色相关的伏笔
    hooks = [h for h in store.hooks() if char.id in h.linked_characters or char.name in h.content]
    return one(char, hooks=to_api(hooks))


class CharacterStateBody(ApiBody):
    location: str | None = None
    status: str | None = None
    known_secrets: list[str] | None = None
    chapter: int | None = None


@router.post("/projects/{project_id}/characters/{key}/state")
def set_character_state(project_id: str, key: str, body: CharacterStateBody) -> dict[str, Any]:
    """改角色状态。走提案闸门——**不可变特征不能在这里被动到**。"""
    store = get_store(project_id)
    char = store.character(key)
    if char is None:
        raise NotFound(f"没有这个角色：{key}")
    changes: dict[str, Any] = {}
    if body.location is not None:
        changes["location"] = body.location
    if body.status is not None:
        changes["status"] = body.status
    if body.known_secrets is not None:
        changes["known_secrets"] = body.known_secrets
    if not changes:
        raise BadRequest("没有要改的内容。")
    if body.chapter:
        changes["updated_at_chapter"] = body.chapter

    writer = TruthWriter(store)
    result = writer.commit([Proposal(
        id=f"manual_state_{char.id}", kind="character_update",
        payload={"id": char.id, "changes": {"state": changes}},
        target_file="characters.jsonl", reason="作者手工修改", confidence="high",
    )], force=True)
    if result.pending:
        raise BadRequest(result.issues[0].message if result.issues else "这条修改没能通过校验。")
    return {"ok": True, "character": to_api(store.resolve_character(char.id))}


# ==========================================================================
# 伏笔
# ==========================================================================

@router.get("/projects/{project_id}/hooks")
def list_hooks(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    hooks = store.hooks()
    current = max((c["n"] for c in store.chapters_overview()), default=0)
    items = []
    for h in hooks:
        row = h.model_dump()
        row["overdue"] = h.overdue(current)
        items.append(row)
    return {
        "hooks": to_api(items),
        "stats": store.hook_stats(current),
        "currentChapter": current,
    }


class HookBody(ApiBody):
    content: str = Field(min_length=2)
    planted_chapter: int = 1
    importance: str = "minor"
    suggested_resolve_by: int | None = None
    linked_characters: list[str] = Field(default_factory=list)


@router.post("/projects/{project_id}/hooks", status_code=201)
def create_hook(project_id: str, body: HookBody) -> dict[str, Any]:
    store = get_store(project_id)
    from ...core.schema import Hook
    hook = Hook(
        id=store.next_hook_id(), content=body.content,
        planted_chapter=body.planted_chapter,
        importance="major" if body.importance == "major" else "minor",
        suggested_resolve_by=body.suggested_resolve_by,
        linked_characters=body.linked_characters,
    )
    result = TruthWriter(store).commit([Proposal(
        id=f"manual_{hook.id}", kind="hook_add", payload=hook.model_dump(),
        target_file="pending_hooks.jsonl", reason="作者手工登记", confidence="high")])
    if result.pending:
        raise BadRequest(result.issues[0].message if result.issues else "这条伏笔没能通过校验。")
    return {"ok": True, "hooks": to_api(store.hooks()), "stats": store.hook_stats()}


class HookResolveBody(ApiBody):
    chapter: int | None = None


@router.post("/projects/{project_id}/hooks/{hook_id}/resolve")
def resolve_hook(project_id: str, hook_id: str, body: HookResolveBody) -> dict[str, Any]:
    store = get_store(project_id)
    if store.hook(hook_id) is None:
        raise NotFound(f"没有这条伏笔：{hook_id}")
    current = max((c["n"] for c in store.chapters_overview()), default=1)
    result = TruthWriter(store).commit([Proposal(
        id=f"manual_resolve_{hook_id}", kind="hook_resolve",
        payload={"id": hook_id, "chapter": body.chapter or current},
        target_file="pending_hooks.jsonl", reason="作者手工回收", confidence="high")])
    if result.pending:
        raise BadRequest(result.issues[0].message if result.issues else "没能标记回收。")
    return {"ok": True, "hooks": to_api(store.hooks()), "stats": store.hook_stats()}


@router.post("/projects/{project_id}/hooks/{hook_id}/abandon")
def abandon_hook(project_id: str, hook_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    if store.hook(hook_id) is None:
        raise NotFound(f"没有这条伏笔：{hook_id}")
    TruthWriter(store).commit([Proposal(
        id=f"manual_abandon_{hook_id}", kind="hook_abandon",
        payload={"id": hook_id}, target_file="pending_hooks.jsonl",
        reason="作者决定弃用", confidence="high")])
    return {"ok": True, "hooks": to_api(store.hooks()), "stats": store.hook_stats()}


# ==========================================================================
# 世界观
# ==========================================================================

@router.get("/projects/{project_id}/world")
def get_world(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    doc = store.world()
    categories: list[str] = []
    for r in doc.rules:
        if r.category not in categories:
            categories.append(r.category)
    return {
        "rules": to_api(doc.rules),
        "categories": ["全部"] + categories,
        "stats": {
            "total": len(doc.rules),
            "hard": sum(1 for r in doc.rules if r.kind == "hard"),
            "soft": sum(1 for r in doc.rules if r.kind == "soft"),
            "conflict": sum(1 for r in doc.rules if r.status == "conflict"),
            "unused": sum(1 for r in doc.rules if r.status == "unused"),
        },
        "updatedAt": doc.updated_at,
        "markdown": store.read_text(store.world_md),
    }


class WorldKindBody(ApiBody):
    kind: str


@router.post("/projects/{project_id}/world/{rule_id}/kind")
def set_world_kind(project_id: str, rule_id: str, body: WorldKindBody) -> dict[str, Any]:
    store = get_store(project_id)
    if body.kind not in ("hard", "soft"):
        raise BadRequest("只能改为硬约束或软设定。")
    if not any(r.id == rule_id for r in store.world().rules):
        raise NotFound(f"没有这条设定：{rule_id}")
    TruthWriter(store).commit([Proposal(
        id=f"manual_kind_{rule_id}", kind="world_update",
        payload={"id": rule_id, "changes": {"kind": body.kind}},
        target_file="world.md", reason="作者调整约束强度", confidence="high",
    )], force=True)
    return one(get_world(project_id))


class WorldResolveBody(ApiBody):
    resolution: str
    note: str = ""


@router.post("/projects/{project_id}/world/{rule_id}/resolve")
def resolve_world_conflict(project_id: str, rule_id: str,
                           body: WorldResolveBody) -> dict[str, Any]:
    """裁定设定与正文的冲突：保留正文并改写规则 / 按规则修改正文。

    两种选择都只是**记录裁定结论**——正文的实际修改仍要走正常的修订流程，
    不做静默改写（这是「不静默改写历史」在设定层的落地）。
    """
    store = get_store(project_id)
    rule = next((r for r in store.world().rules if r.id == rule_id), None)
    if rule is None:
        raise NotFound(f"没有这条设定：{rule_id}")
    if body.resolution not in ("keep_text", "keep_rule"):
        raise BadRequest("裁定只能是「保留正文改写规则」或「按规则修改正文」。")

    changes: dict[str, Any] = {"status": "ok"}
    if body.resolution == "keep_text":
        changes["kind"] = "soft"
        changes["note"] = body.note or "已按正文反推改为软设定"
    else:
        changes["note"] = body.note or "已确认按规则执行，正文待修订"
    TruthWriter(store).commit([Proposal(
        id=f"manual_resolve_{rule_id}", kind="world_update",
        payload={"id": rule_id, "changes": changes}, target_file="world.md",
        reason="作者裁定冲突", confidence="high")], force=True)
    return one(get_world(project_id), resolution=body.resolution)


# ==========================================================================
# 文风
# ==========================================================================

def _style_sources(store) -> list[dict[str, Any]]:
    overview = store.chapters_overview()
    committed = [c for c in overview if c["status"] == "done"]
    words = sum(c["words"] for c in committed)
    profile = store.style()
    return [
        {"id": "src_upload", "kind": "file", "label": "上传或粘贴参考样本",
         "hint": "txt / md，建议 ≥ 8000 字；样本越纯，提取越准", "checked": True},
        {"id": "src_book", "kind": "book", "label": "从本书已定稿章节提取",
         "hint": (f"已定稿 {len(committed)} 章 · 约 {words} 字"
                  if committed else "还没有已定稿的章节"),
         "checked": False, "disabled": not committed},
        {"id": "src_merge", "kind": "merge", "label": "与当前档案合并（保留禁用词）",
         "hint": "合并而非覆盖，适合逐步调教", "checked": bool(profile.source)},
    ]


@router.get("/projects/{project_id}/style")
def get_style(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    return {
        "profile": to_api(store.style()),
        "presets": to_api(presets()),
        "sources": to_api(_style_sources(store)),
    }


class StyleAnalyzeBody(ApiBody):
    source_ids: list[str] = Field(default_factory=list)
    sample: str = ""
    merge: bool = False
    from_chapter: int | None = None
    to_chapter: int | None = None


@router.post("/projects/{project_id}/style/analyze")
async def analyze(project_id: str, body: StyleAnalyzeBody) -> dict[str, Any]:
    store = get_store(project_id)
    sample = body.sample.strip()
    label = "粘贴的参考样本"

    if not sample and "src_book" in body.source_ids:
        frm = body.from_chapter or 1
        to = body.to_chapter or 10 ** 6
        chunks: list[str] = []
        for item in store.chapters_overview():
            if item["status"] in ("done", "revise", "audit") and frm <= item["n"] <= to:
                chunks.append(store.chapter_text(item["n"]))
        sample = "\n\n".join(chunks)
        label = f"从本书已定稿章节提取（第 {frm}–{to if to < 10**6 else '当前'} 章）"

    if not sample.strip():
        raise BadRequest("没有可用于提取的文本：请粘贴样本，或先定稿一些章节。")

    async def _run():
        async with make_client(store) as client:
            meter = make_meter(store)
            profile, tokens = await analyze_style(client, sample, source_label=label)
            if body.merge or "src_merge" in body.source_ids:
                profile = merge_profile(store.style(), profile)
            profile.analyzed_at = __import__("time").strftime("%Y-%m-%d %H:%M")
            profile.tokens = tokens
            store.save_style(profile)
            # 估算成本：文风分析只走一次调用，这里按 token 记账
            meter.record(_style_usage_entry(project_id, tokens))
        return {"ok": True, "profile": to_api(store.style()),
                "sources": to_api(_style_sources(store)), "tokens": tokens}

    return await guarded(project_id, _run())


def _style_usage_entry(project_id: str, tokens: int):
    from ...core.schema import UsageEntry
    return UsageEntry(chapter=0, step="style", role="style_analyze",
                      provider="(文风分析)", model="", prompt_tokens=tokens,
                      completion_tokens=0, total_tokens=tokens, cost=0.0)


class StyleApplyBody(ApiBody):
    preset_id: str


@router.post("/projects/{project_id}/style/apply")
def apply_style(project_id: str, body: StyleApplyBody) -> dict[str, Any]:
    store = get_store(project_id)
    profile = preset_profile(body.preset_id)
    if profile is None:
        raise NotFound(f"没有这个文风预设：{body.preset_id}")
    store.save_style(profile)
    return {"ok": True, "profile": to_api(store.style()),
            "presets": to_api(presets())}


class BannedBody(ApiBody):
    expr: str = Field(min_length=1)


@router.post("/projects/{project_id}/style/banned")
def add_banned(project_id: str, body: BannedBody) -> dict[str, Any]:
    store = get_store(project_id)
    profile = store.style()
    expr = body.expr.strip()
    if expr and expr not in profile.banned_expressions:
        profile.banned_expressions.append(expr)
        store.save_style(profile)
    return {"ok": True, "banned": profile.banned_expressions}


@router.delete("/projects/{project_id}/style/banned")
def remove_banned(project_id: str, expr: str = Query(..., min_length=1)) -> dict[str, Any]:
    store = get_store(project_id)
    profile = store.style()
    profile.banned_expressions = [x for x in profile.banned_expressions if x != expr]
    store.save_style(profile)
    return {"ok": True, "banned": profile.banned_expressions}


# ==========================================================================
# 成本
# ==========================================================================

@router.get("/projects/{project_id}/usage")
def get_usage(project_id: str) -> dict[str, Any]:
    store = get_store(project_id)
    return to_api(make_meter(store).public(recent=30))
