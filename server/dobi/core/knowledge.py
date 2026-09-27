"""知识库：把散在各真相文件里的实体与关系，聚合成一张可漫游的网。

**纯派生、只读**：不新增真相文件，也不碰 `Proposal → Validate → Commit` 闸门。
真相文件改了，这里下次读取即同步——不存在「第二份真相」。

它消费的关系全都是真相文件里**已有**的字段，不额外要求作者录数据：

| 来源字段 | 连出的关系 |
|---|---|
| 角色 `relationships[target/type]` | 人物关系 |
| 伏笔 `linked_characters` | 伏笔 ⇄ 角色 |
| 章节摘要 `characters` / `hooks_planted` / `hooks_resolved` | 章节 ⇄ 角色 / 伏笔 |
| 世界规则 `refs[章号]` | 设定 → 引用章节 |
| 支线 `active` / `peak` | 支线 ⇄ 活跃章节 |
| 角色 `first_appearance`、伏笔 `planted_chapter` | 归位到章节 |

对外文案遵守设计契约第 10 条：不出现研发语汇。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from .store import ProjectStore

__all__ = [
    "Entity", "Link", "KIND_LABEL", "LINK_LABEL",
    "build", "index_of", "graph_of", "entity_detail",
]

#: 实体类型 → 面向作者的中文名
KIND_LABEL: dict[str, str] = {
    "character": "角色",
    "hook": "伏笔",
    "rule": "设定",
    "subplot": "支线",
    "chapter": "章节",
}

#: 关系类型 → 面向作者的中文名
LINK_LABEL: dict[str, str] = {
    "relation": "人物关系",
    "hook_character": "关联角色",
    "chapter_character": "出场",
    "chapter_hook_plant": "埋设伏笔",
    "chapter_hook_resolve": "回收伏笔",
    "hook_chapter": "所在章",
    "rule_chapter": "引用章节",
    "subplot_chapter": "活跃章节",
    "character_chapter": "首次出场",
}

#: 图谱范围。`core` = 只画角色与伏笔（节点少、看得清）；`all` = 连设定、支线、章节一起画。
#: 章节是这张网的**枢纽**（设定引用它、支线活跃在它、角色出场于它），所以 `all` 必须带上它，
#: 否则设定与支线会成为没有连线的孤点。代价是章节多时图会很高——默认 scope 是 `core`。
SCOPE_KINDS: dict[str, set[str]] = {
    "core": {"character", "hook"},
    "all": {"character", "hook", "rule", "subplot", "chapter"},
}

_STATUS_LABEL: dict[str, str] = {
    "skeleton": "骨架", "planned": "已规划", "draft": "草稿",
    "written": "已成稿", "audit": "已审", "todo": "未开写",
}
_HOOK_STATUS_LABEL: dict[str, str] = {
    "planted": "待回收", "resolved": "已回收", "abandoned": "已弃用",
}


# ==========================================================================
# 数据结构
# ==========================================================================

@dataclass
class Entity:
    """知识库里的一个节点。`key` 是全库唯一标识（`kind:id`）。"""

    kind: str
    id: str
    title: str
    subtitle: str = ""
    chapter: int | None = None
    tags: list[str] = field(default_factory=list)

    @property
    def key(self) -> str:
        return f"{self.kind}:{self.id}"

    def public(self) -> dict[str, Any]:
        return {
            "key": self.key, "kind": self.kind,
            "kindLabel": KIND_LABEL.get(self.kind, self.kind),
            "id": self.id, "title": self.title, "subtitle": self.subtitle,
            "chapter": self.chapter, "tags": list(self.tags),
        }


@dataclass
class Link:
    """一条有向关系：`src` 指向 `dst`。"""

    src: str
    dst: str
    type: str
    label: str = ""

    @property
    def type_label(self) -> str:
        return LINK_LABEL.get(self.type, self.type)

    def public(self) -> dict[str, Any]:
        return {"from": self.src, "to": self.dst, "type": self.type,
                "typeLabel": self.type_label, "label": self.label}


def _clip(text: str, limit: int = 28) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


# ==========================================================================
# 构建
# ==========================================================================

def build(store: ProjectStore) -> tuple[list[Entity], list[Link]]:
    """从真相文件派生全部实体与关系。读不出来的部分按「没有」处理，绝不抛异常。"""
    entities: list[Entity] = []
    links: list[Link] = []

    characters = store.characters()
    hooks = store.hooks()
    world = store.world()
    subplots = store.subplots()
    summaries = {s.chapter: s for s in store.summaries()}
    outlines = {n.chapter: n for n in store.outline_graph().nodes}

    # ---- 角色 ----
    for c in characters:
        tags: list[str] = []
        for tag in (c.role, "主角" if c.lead else "", "已故" if c.deceased else ""):
            if tag and tag not in tags:
                tags.append(tag)
        status = (c.state.status or "").strip()
        subtitle = c.role if status in ("", "—") else f"{c.role} · {status}"
        entities.append(Entity(
            kind="character", id=c.id, title=c.name,
            subtitle=subtitle, chapter=c.first_appearance or None, tags=tags,
        ))

    # ---- 伏笔 ----
    for h in hooks:
        tags = [("主线" if h.importance == "major" else "支线")]
        entities.append(Entity(
            kind="hook", id=h.id, title=_clip(h.content),
            subtitle=_HOOK_STATUS_LABEL.get(h.status, h.status),
            chapter=h.planted_chapter or None, tags=tags,
        ))

    # ---- 世界观规则 ----
    for r in world.rules:
        entities.append(Entity(
            kind="rule", id=r.id, title=_clip(r.rule),
            subtitle=f"{r.category} · {'硬约束' if r.kind == 'hard' else '软约束'}",
            tags=[r.category],
        ))

    # ---- 支线 ----
    for s in subplots:
        entities.append(Entity(
            kind="subplot", id=s.id, title=s.name,
            subtitle="主线" if s.kind == "main" else "支线", tags=[],
        ))

    # ---- 章节 ----
    chapters = sorted(set(store.chapter_numbers()) | set(summaries) | set(outlines))
    for n in chapters:
        node = outlines.get(n)
        summary = summaries.get(n)
        title = (node.title if node else "") or (summary.title if summary else "")
        status = _STATUS_LABEL.get(node.status, "") if node else ""
        entities.append(Entity(
            kind="chapter", id=str(n),
            title=f"第 {n} 章" + (f" · {title}" if title else ""),
            subtitle=status or ("已沉淀摘要" if summary else "未开写"),
            chapter=n, tags=[],
        ))

    # ---- 名字 / 别名 → 角色 key（关系里的 target 是人名，需要归一到 id）----
    char_key: dict[str, str] = {}
    for c in characters:
        key = f"character:{c.id}"
        for alias in [c.id, c.name, *c.aliases]:
            if alias:
                char_key.setdefault(alias, key)

    def resolve_char(ref: str) -> str | None:
        ref = (ref or "").strip()
        if not ref:
            return None
        if ref in char_key:
            return char_key[ref]
        # 关系里可能写成「沈砚（主角）」这类带注的写法，退一步按前缀匹配
        for alias, key in char_key.items():
            if len(alias) >= 2 and (ref.startswith(alias) or alias in ref):
                return key
        return None

    hook_key_by_id = {h.id: f"hook:{h.id}" for h in hooks}
    chapter_key = {n: f"chapter:{n}" for n in chapters}

    def link(src: str | None, dst: str | None, type_: str, label: str = "") -> None:
        if src and dst and src != dst:
            links.append(Link(src=src, dst=dst, type=type_, label=label))

    # ---- 人物关系（角色 → 角色）----
    for c in characters:
        src = f"character:{c.id}"
        for rel in c.relationships:
            link(src, resolve_char(rel.target), "relation", rel.type or "关联")

    # ---- 伏笔 → 角色（方向：伏笔指向它关联的角色，于是角色页上它是「入链」）----
    for h in hooks:
        src = hook_key_by_id[h.id]
        for ref in h.linked_characters:
            link(src, resolve_char(ref), "hook_character")
        link(chapter_key.get(h.planted_chapter), src, "hook_chapter", "埋于")
        if h.resolved_chapter:
            link(chapter_key.get(h.resolved_chapter), src, "hook_chapter", "回收于")

    # ---- 角色 → 首次出场章 ----
    for c in characters:
        link(f"character:{c.id}", chapter_key.get(c.first_appearance),
             "character_chapter", "首次出场")

    # ---- 章节 ⇄ 角色 / 伏笔（来自章节摘要，标注更全）----
    for n, s in summaries.items():
        ch = chapter_key.get(n)
        for ref in s.characters:
            link(ch, resolve_char(ref), "chapter_character")
        for hid in s.hooks_planted:
            link(ch, hook_key_by_id.get(hid), "chapter_hook_plant", "埋设")
        for hid in s.hooks_resolved:
            link(ch, hook_key_by_id.get(hid), "chapter_hook_resolve", "回收")

    # ---- 设定 → 引用章节 ----
    for r in world.rules:
        for n in r.refs:
            link(f"rule:{r.id}", chapter_key.get(n), "rule_chapter", f"第 {n} 章")

    # ---- 支线 → 活跃 / 高潮章 ----
    for s in subplots:
        for n in s.active:
            link(f"subplot:{s.id}", chapter_key.get(n), "subplot_chapter", "活跃")
        for n in s.peak:
            link(f"subplot:{s.id}", chapter_key.get(n), "subplot_chapter", "高潮")

    # 去重（同一对实体可能从多条路径连出同一种关系）
    seen: set[tuple[str, str, str, str]] = set()
    unique: list[Link] = []
    for link_item in links:
        sig = (link_item.src, link_item.dst, link_item.type, link_item.label)
        if sig in seen:
            continue
        seen.add(sig)
        unique.append(link_item)
    return entities, unique


# ==========================================================================
# 对外形态
# ==========================================================================

def _stats(entities: Iterable[Entity], links: Iterable[Link]) -> dict[str, int]:
    counts: dict[str, int] = {kind: 0 for kind in KIND_LABEL}
    for e in entities:
        counts[e.kind] = counts.get(e.kind, 0) + 1
    return {
        "characters": counts.get("character", 0),
        "hooks": counts.get("hook", 0),
        "rules": counts.get("rule", 0),
        "subplots": counts.get("subplot", 0),
        "chapters": counts.get("chapter", 0),
        "links": len(list(links)),
    }


def index_of(store: ProjectStore) -> dict[str, Any]:
    """全库实体索引：给「知识库」页的清单用。"""
    entities, links = build(store)
    # 每个条目牵连多少条关系——清单按它降序排，先看到「结」再看到边角。
    degree: dict[str, int] = {}
    for l in links:
        degree[l.src] = degree.get(l.src, 0) + 1
        degree[l.dst] = degree.get(l.dst, 0) + 1
    rows: list[dict[str, Any]] = []
    for e in entities:
        row = e.public()
        row["degree"] = degree.get(e.key, 0)
        rows.append(row)
    return {
        "stats": _stats(entities, links),
        "entities": rows,
        "note": "知识库由真相文件实时派生，只读；在别的页面改了设定后，这里同步更新。",
    }


def graph_of(store: ProjectStore, *, scope: str = "core") -> dict[str, Any]:
    """图谱：节点 + 带类型的关系。`scope=core` 只含角色与伏笔，最易读。"""
    kinds = SCOPE_KINDS.get(scope, SCOPE_KINDS["core"])
    entities, links = build(store)
    in_scope = [e for e in entities if e.kind in kinds]
    keys = {e.key for e in in_scope}
    edges = [l for l in links if l.src in keys and l.dst in keys]

    degree: dict[str, int] = {e.key: 0 for e in in_scope}
    for l in edges:
        degree[l.src] = degree.get(l.src, 0) + 1
        degree[l.dst] = degree.get(l.dst, 0) + 1

    # 不画孤点：一个没有任何连线的节点在图上只会是个没有意义的方块。
    # 被略过多少个如实报出来，页面会写明「有 N 个条目暂无连线」。
    kept = [e for e in in_scope if degree.get(e.key, 0) > 0]
    omitted = len(in_scope) - len(kept)

    nodes = []
    for e in kept:
        row = e.public()
        row["degree"] = degree.get(e.key, 0)
        nodes.append(row)

    used_types = sorted({l.type for l in edges})
    return {
        "scope": scope if scope in SCOPE_KINDS else "core",
        "nodes": nodes,
        "edges": [l.public() for l in edges],
        "legend": [{"type": t, "typeLabel": LINK_LABEL.get(t, t)} for t in used_types],
        "omitted": omitted,
        "stats": {**_stats(entities, links), "nodes": len(nodes), "edges": len(edges)},
        "note": "只画真相文件里已有的关系；没有连线的条目不会出现在图里，可在下方「全部条目」里找到。",
    }


def entity_detail(store: ProjectStore, kind: str, id: str) -> dict[str, Any] | None:
    """单个实体 + 双向链接（谁指向它、它指向谁）——「反查」的底座。"""
    entities, links = build(store)
    target = next((e for e in entities if e.kind == kind and e.id == id), None)
    if target is None:
        return None
    by_key = {e.key: e for e in entities}

    def rows(direction: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for l in links:
            src, dst = (l.src, l.dst) if direction == "out" else (l.dst, l.src)
            if src != target.key:
                continue
            other = by_key.get(dst)
            if other is None:
                continue
            row = other.public()
            row.update({"type": l.type, "typeLabel": l.type_label, "label": l.label})
            out.append(row)
        return out

    inbound = rows("in")
    outbound = rows("out")
    return {
        "entity": target.public(),
        "outbound": outbound,
        "inbound": inbound,
        "stats": {"outbound": len(outbound), "inbound": len(inbound)},
        "note": "反向链接来自真相文件里已有的关系字段，只读。",
    }
