"""真相文件与派生结构的 schema。

**唯一真相源**：本文件的字段名与规划文档 §5.2 的数据结构逐字对应（snake_case）。
对外 API 一律经 `camelize()` 转成前端惯用的 camelCase，转换是机械的、不丢字段。

9 个真相文件 → 本文件的模型：
| 文件 | 模型 |
|---|---|
| `meta.json` | `ProjectMeta` |
| `world.md`（+ `state/world.json` 机器镜像） | `WorldRule` / `WorldDoc` |
| `characters.jsonl` | `Character` |
| `current_state.md`（+ `state/current_state.json`） | `CurrentState` |
| `pending_hooks.jsonl` | `Hook` |
| `chapter_summaries.jsonl` | `ChapterSummary` |
| `subplot_board.md`（+ `state/subplots.json`） | `Subplot` |
| `outline_graph.json` | `OutlineGraph` |
| `style_profile.json` | `StyleProfile` |

另有 `outline.json`（滚动规划产物）与 `audits/` / `reviews/` / `checkpoints/`。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

# ==========================================================================
# 枚举（用 Literal 而非 str Enum —— 直接 JSON 友好，也便于前端对照）
# ==========================================================================

ChapterStatus = Literal["todo", "planned", "draft", "audit", "revise", "done"]
Severity = Literal["blocker", "major", "minor"]
HookStatus = Literal["planted", "resolved", "abandoned"]
HookImportance = Literal["major", "minor"]
EdgeType = Literal["motivation", "setup", "payoff", "causality", "parallel"]
IntervMode = Literal["auto", "semi-auto", "manual"]
StepPolicy = Literal["auto", "confirm", "manual"]
PipelineStep = Literal["plan", "context", "draft", "audit", "review", "deai", "revise", "commit"]
Decision = Optional[Literal["accept", "ignore"]]
L1RuleKey = str

PIPELINE_STEPS: tuple[str, ...] = (
    "plan", "context", "draft", "audit", "review", "deai", "revise", "commit",
)
STEP_LABELS: dict[str, str] = {
    "plan": "章纲", "context": "上下文组装", "draft": "草稿", "audit": "规则与模型审查",
    "review": "可举证评审", "deai": "去 AI 味", "revise": "修订", "commit": "定稿",
}
STOP_CONDITIONS: tuple[str, ...] = (
    "audit.blocker_exists", "budget.exceeded", "audit.fail_streak", "steer.affects_committed",
)
STOP_CONDITION_LABELS: dict[str, str] = {
    "audit.blocker_exists": "出现阻塞定稿级问题",
    "budget.exceeded": "预算用尽",
    "audit.fail_streak": "连续 3 章审查不通过",
    "steer.affects_committed": "干预波及已定稿章节",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# ==========================================================================
# meta.json
# ==========================================================================

class StepPolicies(BaseModel):
    plan: StepPolicy = "confirm"
    context: StepPolicy = "auto"
    draft: StepPolicy = "auto"
    audit: StepPolicy = "confirm"
    review: StepPolicy = "auto"
    deai: StepPolicy = "auto"
    revise: StepPolicy = "auto"
    commit: StepPolicy = "confirm"

    def get(self, step: str) -> StepPolicy:
        return getattr(self, step, "auto")  # type: ignore[return-value]


class ProjectMeta(BaseModel):
    id: str
    title: str = "未命名作品"
    genre: str = "待定"
    logline: str = ""
    premise: str = ""
    mode: IntervMode = "semi-auto"
    steps: StepPolicies = Field(default_factory=StepPolicies)
    stop_conditions: list[str] = Field(
        default_factory=lambda: ["audit.blocker_exists", "budget.exceeded", "steer.affects_committed"]
    )
    chapters_total: int = 0
    words: int = 0
    words_per_chapter: int = 3000
    budget_total: float = 80.0
    budget_used: float = 0.0
    cost_unit: str = "¥"
    # 已启用的模型审查维度（关掉不关心的维度省钱）
    audit_dims: list[str] = Field(default_factory=list)
    audit_dims_extended: bool = False
    style_locked: bool = False
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)

    @property
    def budget_remaining(self) -> float:
        return max(0.0, self.budget_total - self.budget_used)

    @property
    def budget_exceeded(self) -> bool:
        return self.budget_total > 0 and self.budget_used >= self.budget_total


# ==========================================================================
# 世界观（world.md 的机器镜像）
# ==========================================================================

class WorldRule(BaseModel):
    id: str
    category: str = "其他"          # 器物 / 体系 / 地理 / 组织 / 历史 …
    kind: Literal["hard", "soft"] = "hard"
    rule: str
    refs: list[int] = Field(default_factory=list)   # 引用章号
    note: str = ""
    status: Literal["ok", "conflict", "unused"] = "ok"


class WorldDoc(BaseModel):
    rules: list[WorldRule] = Field(default_factory=list)
    updated_at: str = Field(default_factory=now_iso)


# ==========================================================================
# characters.jsonl —— 不可变特征 vs 可变状态，这是防崩核心
# ==========================================================================

class Relation(BaseModel):
    target: str
    type: str
    note: str = ""


class CharacterState(BaseModel):
    location: str = "—"
    status: str = "—"
    known_secrets: list[str] = Field(default_factory=list)


class Character(BaseModel):
    id: str
    name: str
    role: str = "配角"
    lead: bool = False
    immutable_traits: list[str] = Field(default_factory=list)
    personality: str = ""
    speech_style: str = ""
    relationships: list[Relation] = Field(default_factory=list)
    state: CharacterState = Field(default_factory=CharacterState)
    first_appearance: int = 1
    updated_at_chapter: int = 0
    aliases: list[str] = Field(default_factory=list)
    deceased: bool = False


class CurrentState(BaseModel):
    """`current_state.md` 的机器镜像：世界当前状态快照。"""

    chapter: int = 0
    location_focus: str = ""
    situation: str = ""
    open_questions: list[str] = Field(default_factory=list)
    updated_at: str = Field(default_factory=now_iso)


# ==========================================================================
# pending_hooks.jsonl
# ==========================================================================

class Hook(BaseModel):
    id: str
    content: str
    planted_chapter: int
    status: HookStatus = "planted"
    resolved_chapter: int | None = None
    importance: HookImportance = "minor"
    linked_characters: list[str] = Field(default_factory=list)
    suggested_resolve_by: int | None = None

    def overdue(self, current_chapter: int) -> bool:
        """前端派生的 `overdue`：仍处 planted 且已超过建议回收章。"""
        if self.status != "planted" or self.suggested_resolve_by is None:
            return False
        return current_chapter > self.suggested_resolve_by


# ==========================================================================
# chapter_summaries.jsonl
# ==========================================================================

class ChapterSummary(BaseModel):
    chapter: int
    title: str = ""
    summary: str = ""
    words: int = 0
    pov: str = ""
    key_facts: list[str] = Field(default_factory=list)
    characters: list[str] = Field(default_factory=list)
    hooks_planted: list[str] = Field(default_factory=list)
    hooks_resolved: list[str] = Field(default_factory=list)
    updated_at: str = Field(default_factory=now_iso)


# ==========================================================================
# subplot_board.md 的机器镜像
# ==========================================================================

class Subplot(BaseModel):
    id: str
    name: str
    kind: Literal["main", "sub"] = "sub"
    summary: str = ""
    color: str = "#4F6B4A"
    active: list[int] = Field(default_factory=list)
    peak: list[int] = Field(default_factory=list)
    status: Literal["active", "stalled", "closed"] = "active"


# ==========================================================================
# outline.json（滚动规划产物：罗盘 + 卷 + 章纲）
# ==========================================================================

class Compass(BaseModel):
    endgame: str = ""
    active_threads: list[str] = Field(default_factory=list)
    scale_estimate: str = ""
    refresh_at: str = "尚未刷新"


class Volume(BaseModel):
    name: str
    from_chapter: int = 1
    to_chapter: int = 0          # 0 = 尚未定死（骨架弧）
    goal: str = ""
    est_chapters: int = 0
    status: Literal["skeleton", "expanded"] = "skeleton"
    arc: str = ""

    @property
    def chapters(self) -> int:
        if self.to_chapter:
            return max(0, self.to_chapter - self.from_chapter + 1)
        return self.est_chapters


class OutlineNode(BaseModel):
    chapter: int
    title: str = ""
    arc: str = ""
    volume: str = ""
    status: Literal["skeleton", "planned", "written", "audit", "draft"] = "skeleton"
    goal: str = ""
    beats: list[str] = Field(default_factory=list)
    rationale: str = ""          # 思维链：为什么这样安排
    pov: str = ""
    intensity: int = 3
    # 本章主线事件发生在**故事时间**的什么时候（如「三日前」「二十年前」）。
    # 这是双轨时间线与剧情树的排序依据 —— 没有它，闪回就没法画在正确的位置上。
    story_at: str = ""
    # 本章的事件序列：[{at, label, kind}]，kind ∈ backstory/flashback/now/future
    timeline: list[dict[str, str]] = Field(default_factory=list)


class OutlineEdge(BaseModel):
    from_chapter: int
    to_chapter: int
    type: EdgeType = "causality"
    note: str = ""
    confirmed: bool = False


class OutlineGraph(BaseModel):
    """`outline_graph.json`：章纲依赖图 + 思维链。"""

    compass: Compass = Field(default_factory=Compass)
    volumes: list[Volume] = Field(default_factory=list)
    nodes: list[OutlineNode] = Field(default_factory=list)
    edges: list[OutlineEdge] = Field(default_factory=list)
    updated_at: str = Field(default_factory=now_iso)

    def node(self, chapter: int) -> OutlineNode | None:
        return next((n for n in self.nodes if n.chapter == chapter), None)

    def motivations_for(self, chapter: int) -> list[OutlineEdge]:
        """反查「本章依赖的前因」——上下文组装真实消费这张图，避免它沦为摆设。"""
        return [e for e in self.edges if e.from_chapter == chapter and e.type in ("motivation", "setup")]

    def dependents_of(self, chapter: int) -> list[OutlineEdge]:
        """反查「哪些后续章节依赖本章」——实时干预评估影响范围时用。"""
        return [e for e in self.edges if e.to_chapter == chapter]


# ==========================================================================
# style_profile.json
# ==========================================================================

class SentenceStats(BaseModel):
    mean: float = 0.0
    p50: float = 0.0
    p90: float = 0.0
    min: float = 0.0
    max: float = 0.0
    scale: float = 80.0


class NarrativeStyle(BaseModel):
    person: str = ""
    tense: str = ""
    pov_switch: str = "rare"
    anchor: str = ""


class StyleRatio(BaseModel):
    label: str
    pct: int
    color: str = "#2C4A63"


class StyleProfile(BaseModel):
    source: str = ""
    analyzed_at: str = ""
    tokens: int = 0
    sentence: SentenceStats = Field(default_factory=SentenceStats)
    narrative: NarrativeStyle = Field(default_factory=NarrativeStyle)
    ratio: list[StyleRatio] = Field(default_factory=list)
    preferred_patterns: list[str] = Field(default_factory=list)
    banned_expressions: list[str] = Field(default_factory=list)
    lexicon: list[dict[str, str]] = Field(default_factory=list)
    sample_plain: str = ""
    sample_styled: str = ""

    @property
    def is_empty(self) -> bool:
        return not self.source and not self.preferred_patterns

    def injection_text(self) -> str:
        """注入 Writer 的**确定性必选上下文**（不占配额、不参与检索竞争）。"""
        lines = ["# 文风档案（确定性必选，优先级高于一般上下文）"]
        if self.source:
            lines.append(f"来源：{self.source}")
        if self.sentence.mean:
            lines.append(f"句长：均值 {self.sentence.mean:g} 字 · p50 {self.sentence.p50:g} · p90 {self.sentence.p90:g}")
        if self.narrative.person:
            lines.append(
                f"叙述：{self.narrative.person} / {self.narrative.tense} / "
                f"视角切换{self.narrative.pov_switch}"
                + (f"；{self.narrative.anchor}" if self.narrative.anchor else "")
            )
        if self.ratio:
            lines.append("描写/对话/动作比例：" + " · ".join(f"{r.label} {r.pct}%" for r in self.ratio))
        if self.preferred_patterns:
            lines.append("偏好手法：" + "；".join(self.preferred_patterns))
        if self.banned_expressions:
            lines.append("禁用表达：" + " / ".join(self.banned_expressions))
        for item in self.lexicon:
            lines.append(f"{item.get('key', '')}：{item.get('value', '')}")
        return "\n".join(lines)


# ==========================================================================
# audits/ · reviews/
# ==========================================================================

class L1Violation(BaseModel):
    rule: str
    hit: str = ""
    count: int = 0
    threshold: int = 1
    samples: list[str] = Field(default_factory=list)


class AuditItem(BaseModel):
    dim: str
    severity: Severity = "minor"
    evidence: str = ""            # 必须是原文引用，无证据的结论不得进入报告
    suggestion: str = ""
    ref: str = ""                 # ch_0017.md#para-5
    fixed: bool = False
    decision: Decision = None
    patch: dict[str, Any] | None = None


class AuditReport(BaseModel):
    chapter: int
    title: str = ""
    l1_violations: list[L1Violation] = Field(default_factory=list)
    l1_checked: list[dict[str, Any]] = Field(default_factory=list)  # 全量规则清单（含未命中）
    items: list[AuditItem] = Field(default_factory=list)
    review: list[dict[str, Any]] = Field(default_factory=list)
    diffs: list[dict[str, Any]] = Field(default_factory=list)
    stats: dict[str, int] = Field(default_factory=dict)
    generated_at: str = Field(default_factory=now_iso)

    @field_validator("stats", mode="before")
    @classmethod
    def _no_none(cls, v: Any) -> Any:
        return v or {}


class ReviewDimension(BaseModel):
    dim: str
    score: int = 0
    evidence: str = ""
    note: str = ""


class ReviewReport(BaseModel):
    chapter: int
    dims: list[ReviewDimension] = Field(default_factory=list)
    overall: int = 0
    generated_at: str = Field(default_factory=now_iso)


# ==========================================================================
# 提案（Proposal → Validate → Commit）
# ==========================================================================

class Proposal(BaseModel):
    id: str
    kind: str                       # 角色 / 世界观 / 伏笔 / 大纲 / 文风 / 事实
    payload: dict[str, Any] = Field(default_factory=dict)
    reason: str = ""
    confidence: Literal["high", "medium", "low"] = "medium"
    decision: Decision = None
    target_file: str = ""


class ValidationIssue(BaseModel):
    level: Literal["error", "warning"] = "error"
    kind: str = ""                  # 与 immutable_traits 冲突 / 与硬设定矛盾 / 伏笔重复 …
    message: str
    proposal_id: str = ""


class Checkpoint(BaseModel):
    chapter: int
    step: PipelineStep
    status: Literal["running", "ok", "failed", "skipped"] = "ok"
    attempt: int = 1
    idempotency_key: str = ""
    output_ref: str = ""            # 产出文件相对路径
    tokens: int = 0
    cost: float = 0.0
    note: str = ""
    timestamp: str = Field(default_factory=now_iso)


class UsageEntry(BaseModel):
    chapter: int = 0
    step: str = ""
    role: str = ""
    provider: str = ""
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost: float = 0.0
    latency_ms: int = 0
    attempts: int = 1
    ts: str = ""
