"""上下文组装（规划文档 §4 第 ④ 层、§6.5 第 2 道闸门）。

**分层预算**：系统规则 5% / 角色与世界观 15% / 动态事实 10% / 历史摘要 20% /
当前草稿 30% / 输出预留 20%。**文风档案是「确定性必选」——不占配额、不参与检索竞争**，
因为它体量小，而每章文风一致是硬需求。

两条硬约定：
1. **超预算不报错**，按优先级裁剪低价值内容，并在 `notes` 里如实说明省略了什么。
2. **不引用后文**：所有检索都带 `up_to_chapter`，避免「第 17 章引用了第 24 章才知道的事」。
3. **依赖图必须被真实消费**：本章的 `motivation` / `setup` 入边会作为「前因约束」
   进入动态事实区——这是规划文档 §14 风险表里点名的「依赖图不能变成摆设」。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from ..config import CONTEXT_BUDGET_SPLIT, get_settings
from .memory import MemoryIndex
from .metering import estimate_tokens
from .schema import Character, Hook, OutlineNode, ProjectMeta, StyleProfile
from .store import ProjectStore

__all__ = ["build_context", "ContextBundle", "ContextSection", "BASE_SYSTEM", "PURPOSES"]

#: 各区块在超预算时的牺牲顺序（越靠前越先被裁）
SACRIFICE_ORDER: tuple[str, ...] = ("summary", "facts", "cast", "draft")

BASE_SYSTEM = """你是一名长篇小说写作助手，服务于一位中文作者。
工作原则：
1. **只负责叙述，不负责改设定**。世界观、角色状态、伏笔归属由系统维护，你不得擅自变更。
2. 严格延续给定的文风档案与上文语境，不引入新的人名、地名、称谓，除非章纲明确要求。
3. 不写作者旁白、不写章节总结、不写「本章完」。直接给正文。
4. 段落自然分段；对话与叙述混排时不做额外标记。
5. 如果章纲里有你无法自然衔接的地方，宁可写得克制，也不要编造设定去圆场。"""

PURPOSES: dict[str, str] = {
    "writer": "撰写章节正文",
    "audit": "审查章节与设定的一致性",
    "review": "评审章节的写作质量",
    "plan": "规划章节与依赖关系",
    "revise": "按审查结论定点修订",
}


def _chars_for(tokens: int) -> int:
    """token 预算 → 中文字符预算（与 metering.estimate_tokens 同一换算口径）。"""
    return max(0, int(tokens * 1.6))


def _truncate(text: str, token_budget: int) -> tuple[str, bool]:
    if token_budget <= 0:
        return "", bool(text.strip())
    if estimate_tokens(text) <= token_budget:
        return text, False
    limit = _chars_for(token_budget)
    clipped = text[:limit]
    cut = max(clipped.rfind("\n"), clipped.rfind("。"))
    if cut > limit * 0.5:
        clipped = clipped[:cut + 1]
    return clipped.rstrip() + "\n…（此处因上下文额度不足被截断）", True


@dataclass
class ContextSection:
    key: str
    label: str
    text: str = ""
    tokens: int = 0
    cap: int = 0
    mandatory: bool = False
    truncated: bool = False
    omitted: bool = False

    def public(self) -> dict[str, Any]:
        return {
            "key": self.key, "label": self.label, "tokens": self.tokens,
            "cap": self.cap, "mandatory": self.mandatory,
            "truncated": self.truncated, "omitted": self.omitted,
            "chars": len(self.text),
        }


@dataclass
class ContextBundle:
    chapter: int
    purpose: str
    window: int
    output_reserve: int
    sections: list[ContextSection] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    related: list[dict[str, Any]] = field(default_factory=list)
    messages: list[dict[str, str]] = field(default_factory=list)

    @property
    def used_tokens(self) -> int:
        return sum(s.tokens for s in self.sections if not s.omitted)

    @property
    def mandatory_tokens(self) -> int:
        return sum(s.tokens for s in self.sections if s.mandatory and not s.omitted)

    def section(self, key: str) -> ContextSection | None:
        return next((s for s in self.sections if s.key == key), None)

    def public(self) -> dict[str, Any]:
        return {
            "chapter": self.chapter,
            "purpose": self.purpose,
            "window": self.window,
            "outputReserve": self.output_reserve,
            "usedTokens": self.used_tokens,
            "mandatoryTokens": self.mandatory_tokens,
            "sections": [s.public() for s in self.sections],
            "notes": self.notes,
            "related": self.related,
            "budgetSplit": CONTEXT_BUDGET_SPLIT,
        }


# ==========================================================================
# 各区块内容
# ==========================================================================

def _render_characters(chars: Sequence[Character], present: Sequence[str] | None) -> str:
    if present:
        names = set(present)
        picked = [c for c in chars if c.name in names or c.id in names]
        rest = [c for c in chars if c not in picked]
    else:
        picked, rest = [], list(chars)

    lines: list[str] = []
    ordered = picked + rest[:4]     # 未指明出场时，只带最近更新的 4 个，其余靠检索
    for c in ordered:
        head = f"### {c.name}（{c.role}{'·主角' if c.lead else ''}）"
        lines.append(head)
        if c.immutable_traits:
            lines.append(f"- 不可变特征：{'；'.join(c.immutable_traits)}（**不得违背**）")
        if c.personality:
            lines.append(f"- 性格：{c.personality}")
        if c.speech_style:
            lines.append(f"- 说话方式：{c.speech_style}")
        lines.append(f"- 当前状态：{c.state.location}／{c.state.status}")
        if c.deceased:
            lines.append("- ⚠️ 已亡故：**不得作为在场人物出现**，只能出现在回忆或他人转述中")
        if c.relationships:
            rel = "；".join(f"{r.target}({r.type}){('：' + r.note) if r.note else ''}"
                            for r in c.relationships[:4])
            lines.append(f"- 关系：{rel}")
        lines.append("")
    if len(rest) > 4:
        lines.append(f"_（另有 {len(rest) - 4} 个未出场角色，需要时再检索）_")
    return "\n".join(lines).strip()


def _render_world(store: ProjectStore) -> str:
    rules = store.world().rules
    hard = [r for r in rules if r.kind == "hard"]
    if not hard:
        return ""
    lines = ["### 硬约束（违反即阻塞定稿）", ""]
    for r in hard:
        mark = " ⚠️待裁定冲突" if r.status == "conflict" else ""
        lines.append(f"- [{r.category}] {r.rule}{mark}")
    return "\n".join(lines)


def _render_facts(
    store: ProjectStore,
    chapter: int,
    node: OutlineNode | None,
    hooks: Sequence[Hook],
) -> str:
    lines: list[str] = []

    # 作者的实时干预意见 —— 最高优先级，写在最前面
    directives = store.steering_directives(chapter=chapter)
    if directives:
        lines.append("### 作者干预意见（**必须遵守，优先级最高**）")
        for d in directives:
            steps = d.get("steps") or []
            lines.append(f"- {d.get('text', '')}"
                         + (f"（要求：{'；'.join(str(s) for s in steps)}）" if steps else ""))
        lines.append("")

    state = store.state()
    if state.situation:
        lines.append(f"### 当前局势\n{state.situation}\n")

    # 依赖图反查：本章依赖的前因（motivation / setup 入边）
    if node is not None:
        graph_paths = store.outline_graph().motivations_for(chapter)
        if graph_paths:
            lines.append("### 本章依赖的前因（来自依赖图，**必须衔接上**）")
            for e in graph_paths:
                src = store.outline_graph().node(e.to_chapter)
                src_title = src.title if src else ""
                lines.append(f"- 依赖第 {e.to_chapter} 章《{src_title}》：{e.note}"
                             f"（类型：{e.type}）")
            lines.append("")

    pending = [h for h in hooks if h.status == "planted"]
    overdue = [h for h in pending if h.overdue(chapter)]
    if overdue:
        lines.append("### 已超期的伏笔（建议本章或近期给出呼应）")
        for h in overdue:
            lines.append(f"- {h.id}：{h.content}"
                         f"（埋于第 {h.planted_chapter} 章，原计划第 {h.suggested_resolve_by} 章前回收）")
        lines.append("")
    return "\n".join(lines).strip()


def _format_search_hits(hits: Sequence[dict[str, Any]]) -> str:
    lines: list[str] = []
    for h in hits:
        tag = h.get("kindLabel", "")
        chapter = h.get("chapter") or 0
        where = f"第 {chapter} 章" if chapter else "设定库"
        lines.append(f"- [{tag}] {where}《{h.get('title', '')}》：{h.get('text', '')[:220]}")
    return "\n".join(lines)


# ==========================================================================
# 组装
# ==========================================================================

def build_context(
    store: ProjectStore,
    chapter: int,
    *,
    purpose: str = "writer",
    context_window: int,
    node: OutlineNode | None = None,
    draft: str = "",
    query: str = "",
    system_text: str = "",
    characters_present: Sequence[str] | None = None,
    target_text: str = "",
    output_reserve_pct: int | None = None,
) -> ContextBundle:
    """组装一次模型调用所需的全部上下文。

    `purpose='audit' / 'review'` 时，被审查的正文通过 `target_text` 传入，
    它会占据「当前草稿」这一档配额。
    """
    settings = get_settings()
    meta: ProjectMeta = store.meta()
    style: StyleProfile = store.style()
    graph = store.outline_graph()
    reserve_pct = settings.output_reserve_pct if output_reserve_pct is None else output_reserve_pct

    window = max(1024, int(context_window or 32000))
    output_reserve = int(window * reserve_pct / 100)
    avail = window - output_reserve

    # 审查 / 评审时被审正文才是主角，需要更大额度；其余区块相应压缩。
    # 权重之和恒等于 (100 - output_reserve_pct)，即「可用额度」那一档。
    split = dict(CONTEXT_BUDGET_SPLIT)
    if purpose in ("audit", "review"):
        split.update({"cast": 12, "facts": 8, "summary": 15, "draft": 45})

    def cap_for(key: str) -> int:
        return int(avail * split.get(key, 0) / (100 - reserve_pct))

    bundle = ContextBundle(chapter=chapter, purpose=purpose, window=window,
                           output_reserve=output_reserve)

    # ---- 必选：系统规则 + 文风档案（不占配额）----
    sys_parts = [system_text or BASE_SYSTEM]
    if purpose:
        sys_parts.append(f"本次任务：{PURPOSES.get(purpose, purpose)}。")
    bundle.sections.append(ContextSection(
        key="system", label="系统规则", text="\n\n".join(sys_parts),
        tokens=estimate_tokens("\n\n".join(sys_parts)), mandatory=True,
    ))
    if not style.is_empty:
        injection = style.injection_text()
        bundle.sections.append(ContextSection(
            key="style", label="文风档案（必选）", text=injection,
            tokens=estimate_tokens(injection), mandatory=True,
        ))

    # ---- 历史摘要（BM25 + 关联章节推荐）----
    lookups = (query or "").strip() or " ".join(
        x for x in [(node.goal if node else ""), " ".join(node.beats) if node else "",
                    (node.rationale if node else "")] if x)
    memory = MemoryIndex(store)
    related = memory.related_chapters(chapter, lookups or "章节", k=5) if lookups else []
    bundle.related = related

    summary_parts: list[str] = []
    recent = [s for s in store.summaries() if s.chapter < chapter]
    recent.sort(key=lambda s: s.chapter, reverse=True)
    for s in recent[:3]:
        summary_parts.append(f"- 第 {s.chapter} 章《{s.title}》：{s.summary}")
    if recent[3:8]:
        summary_parts.append("")
        summary_parts.append("更早（按相关度）：")
        for s in recent[3:8]:
            summary_parts.append(f"- 第 {s.chapter} 章《{s.title}》：{s.summary[:120]}")
    hits = memory.search(lookups or "章节", k=6, up_to_chapter=chapter) if lookups else []
    hits = [h for h in hits if h.get("chapter") != chapter]
    if hits:
        summary_parts.append("")
        summary_parts.append("相关片段（检索所得）：")
        summary_parts.append(_format_search_hits(hits))

    # ---- 草稿区（写作时是已写内容，审查时是被审正文）----
    draft_text = target_text if purpose in ("audit", "review") else draft

    raw_sections: dict[str, tuple[str, str, bool]] = {
        # key: (label, text, mandatory)
        "cast": ("角色与世界观", "\n\n".join(x for x in [
            _render_characters(store.characters(), characters_present),
            _render_world(store),
        ] if x.strip()), False),
        "facts": ("动态事实", _render_facts(store, chapter, node, store.hooks()), False),
        "summary": ("前情摘要", "\n".join(summary_parts).strip(), False),
        "draft": ("当前草稿" if purpose == "writer" else "待审正文",
                  draft_text, purpose in ("audit", "review")),
    }

    for key, (label, text, mandatory) in raw_sections.items():
        cap = cap_for(key)
        if purpose == "writer" and key == "draft" and not text:
            bundle.sections.append(ContextSection(key=key, label=label, cap=cap,
                                                  mandatory=mandatory, omitted=True))
            continue
        clipped, truncated = _truncate(text, cap)
        section = ContextSection(key=key, label=label, text=clipped,
                                 tokens=estimate_tokens(clipped), cap=cap,
                                 mandatory=mandatory, truncated=truncated,
                                 omitted=not clipped.strip())
        if truncated:
            bundle.notes.append(
                f"「{label}」超出本档额度（{section.tokens} / {cap}），已截断到最新内容。")
        bundle.sections.append(section)

    # ---- 超预算：按牺牲顺序继续裁剪（不报错）----
    for key in SACRIFICE_ORDER:
        if bundle.used_tokens <= avail:
            break
        section = bundle.section(key)
        if section is None or section.mandatory or section.omitted:
            continue
        over = bundle.used_tokens - avail
        keep = max(0, section.tokens - over)
        clipped, _ = _truncate(section.text, keep)
        new_tokens = estimate_tokens(clipped)
        if new_tokens <= 0:
            lost = section.tokens
            section.text, section.tokens, section.omitted = "", 0, True
            bundle.notes.append(f"额度不足，已整块省略「{section.label}」（省下约 {lost} 额度）")
        else:
            lost = section.tokens - new_tokens
            section.text, section.tokens, section.truncated = clipped, new_tokens, True
            bundle.notes.append(f"额度不足，已压缩「{section.label}」约 {lost} 额度")

    if bundle.used_tokens > avail:
        bundle.notes.append(
            f"上下文仍超出额度 {bundle.used_tokens - avail}（必选区块不可裁），"
            "已交由模型侧自行取舍。"
        )

    if meta.budget_used and meta.budget_total and meta.budget_used / meta.budget_total >= 0.8:
        bundle.notes.append(
            f"本书预算已用 {meta.cost_unit}{meta.budget_used:.2f} / {meta.cost_unit}{meta.budget_total:.2f}。")

    bundle.messages = _compose_messages(bundle, purpose)
    return bundle


def _compose_messages(bundle: ContextBundle, purpose: str) -> list[dict[str, str]]:
    """把区块拼成 messages。系统规则与文风档案进 system，其余进 user。"""
    system_parts = [s.text for s in bundle.sections
                    if s.key in ("system", "style") and not s.omitted]
    user_parts: list[str] = []
    for s in bundle.sections:
        if s.key in ("system", "style") or s.omitted or not s.text.strip():
            continue
        user_parts.append(f"## {s.label}\n{s.text}")
    if bundle.related:
        lines = ["## 关联章节（供参考，不必全部提及）"]
        for r in bundle.related:
            lines.append(f"- 第 {r['chapter']} 章《{r.get('title', '')}》"
                         f"（{r.get('reason', '')}）")
        user_parts.append("\n".join(lines))
    return [
        {"role": "system", "content": "\n\n".join(system_parts)},
        {"role": "user", "content": "\n\n".join(user_parts)},
    ]
