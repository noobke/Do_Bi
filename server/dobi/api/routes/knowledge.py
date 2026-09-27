"""知识库：全库实体索引、跨类检索、关系图谱、实体反查。

全部**只读**——数据由 `core.knowledge` 从真相文件实时派生，这里不写任何东西，
因此不接项目锁、也不碰提案闸门。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from ...core.knowledge import KIND_LABEL, entity_detail, graph_of, index_of
from ...core.memory import MemoryIndex
from ...errors import BadRequest, NotFound
from ..deps import get_store

router = APIRouter(tags=["knowledge"])


@router.get("/projects/{project_id}/knowledge")
def knowledge_index(project_id: str) -> dict[str, Any]:
    """全库实体索引（角色 / 伏笔 / 设定 / 支线 / 章节）+ 统计。"""
    return index_of(get_store(project_id))


@router.get("/projects/{project_id}/knowledge/search")
def knowledge_search(project_id: str, q: str, k: int = Query(default=8, ge=1, le=50)) -> dict[str, Any]:
    """跨类检索：一次在 摘要 / 正文 / 设定 / 角色 / 伏笔 / 章纲 里找。"""
    store = get_store(project_id)
    query = (q or "").strip()
    if not query:
        return {"query": "", "hits": [], "note": "输入关键词后，会在全库范围里找。"}

    index = MemoryIndex(store)
    # 首次使用（索引还没建）时先补建，否则会「搜不到任何东西」
    if index.stats().get("chunks", 0) == 0:
        try:
            index.reindex()
        except Exception:  # 建索引失败不该让整页报错
            pass
    hits = index.search(query, k=k)
    return {
        "query": query,
        "hits": hits,
        "note": f"在 {len(hits)} 处找到「{query}」；结果按相关度排序。",
    }


@router.get("/projects/{project_id}/knowledge/graph")
def knowledge_graph(project_id: str, scope: str = "core") -> dict[str, Any]:
    """关系图谱。`scope=core` 只含角色与伏笔（推荐），`scope=all` 含设定与支线。"""
    return graph_of(get_store(project_id), scope=scope)


@router.get("/projects/{project_id}/knowledge/entity/{kind}/{entity_id}")
def knowledge_entity(project_id: str, kind: str, entity_id: str) -> dict[str, Any]:
    """单个实体的双向链接（它指向谁 / 谁指向它）。"""
    if kind not in KIND_LABEL:
        raise BadRequest(f"不认识的类型：{kind}")
    detail = entity_detail(get_store(project_id), kind, entity_id)
    if detail is None:
        raise NotFound(f"知识库里没有这个{kind}：{entity_id}")
    return detail
