"""项目状态层：真相文件的读写与 Proposal → Validate → Commit。

**双形态落盘**：schema 校验的 JSON 是唯一权威；Markdown（`world.md` /
`current_state.md` / `subplot_board.md`）是**自动生成的可读投影**，每次写入后重建。
要改内容请改 JSON（或走 API / CLI），改 Markdown 会被下次写入覆盖——这样才不会
出现「两份真相互相矛盾」。

**写入规则**（规划文档 §5.3）：所有对真相文件的写入必经 Proposal → Validate → Commit，
冲突降级为「待人工确认项」，不自动写入。
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from ..config import SEVERITY_ORDER, get_settings
from ..errors import Conflict, NotFound, ValidationFailed
from .schema import (
    AuditItem,
    AuditReport,
    ChapterSummary,
    Character,
    Checkpoint,
    Compass,
    CurrentState,
    Hook,
    OutlineEdge,
    OutlineGraph,
    OutlineNode,
    ProjectMeta,
    Proposal,
    ReviewReport,
    StyleProfile,
    Subplot,
    ValidationIssue,
    Volume,
    WorldDoc,
    WorldRule,
    now_iso,
)

__all__ = ["ProjectStore", "CommitResult", "count_words", "slugify"]

log = logging.getLogger(__name__)


# ==========================================================================
# 工具
# ==========================================================================

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_LATIN_WORD_RE = re.compile(r"[A-Za-z0-9']+")
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def count_words(text: str) -> int:
    """中文字符数 + 拉丁词数。中文按字计，这是网文平台通行口径。"""
    if not text:
        return 0
    return len(_CJK_RE.findall(text)) + len(_LATIN_WORD_RE.findall(text))


def slugify(text: str, fallback: str = "project") -> str:
    ascii_part = _SLUG_RE.sub("-", (text or "").strip().lower()).strip("-")
    return ascii_part or fallback


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def _norm(text: str) -> str:
    return re.sub(r"[\s，。！？、；：,.!?;:\"'（）()【】\[\]]+", "", text or "")


# ==========================================================================
# 提案提交结果
# ==========================================================================

@dataclass
class CommitResult:
    applied: list[Proposal] = field(default_factory=list)
    pending: list[Proposal] = field(default_factory=list)
    issues: list[ValidationIssue] = field(default_factory=list)
    changed_files: list[str] = field(default_factory=list)

    @property
    def blocked(self) -> bool:
        return bool(self.pending)

    def public(self) -> dict[str, Any]:
        return {
            "applied": [p.model_dump() for p in self.applied],
            "pending": [p.model_dump() for p in self.pending],
            "issues": [i.model_dump() for i in self.issues],
            "changedFiles": self.changed_files,
        }


# ==========================================================================
# 项目存储
# ==========================================================================

class ProjectStore:
    """绑定到一个项目目录。所有读写都在这里，别处不直接碰文件系统。"""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()
        self.id = self.root.name
        # 纵深防御：store 只应指向数据目录之下（作品在 data/projects/，
        # CLI 与「测试连通性」用的探测目录在 data/_probe/）。越出 data/ 只可能是
        # 上游把未校验的输入拼进了路径，直接暴露为开发期错误，别让它变成越权读写。
        data_dir = get_settings().data_dir
        try:
            self.root.relative_to(Path(data_dir).resolve())
        except ValueError as exc:
            raise AssertionError(
                f"ProjectStore 路径越出数据目录：{self.root}（data_dir={data_dir}）") from exc
        # 供 commit 后置钩子使用（如写 memory.db 索引），由外部注入，避免循环依赖
        self._on_truth_changed: Callable[[str], None] | None = None

    # ---------------- 路径 ----------------

    @property
    def meta_path(self) -> Path: return self.root / "meta.json"
    @property
    def world_md(self) -> Path: return self.root / "world.md"
    @property
    def world_json(self) -> Path: return self.root / "state" / "world.json"
    @property
    def characters_path(self) -> Path: return self.root / "characters.jsonl"
    @property
    def current_state_md(self) -> Path: return self.root / "current_state.md"
    @property
    def current_state_json(self) -> Path: return self.root / "state" / "current_state.json"
    @property
    def hooks_path(self) -> Path: return self.root / "pending_hooks.jsonl"
    @property
    def summaries_path(self) -> Path: return self.root / "chapter_summaries.jsonl"
    @property
    def subplot_md(self) -> Path: return self.root / "subplot_board.md"
    @property
    def subplot_json(self) -> Path: return self.root / "state" / "subplots.json"
    @property
    def outline_graph_path(self) -> Path: return self.root / "outline_graph.json"
    @property
    def outline_path(self) -> Path: return self.root / "outline.json"
    @property
    def style_path(self) -> Path: return self.root / "style_profile.json"
    @property
    def chapters_dir(self) -> Path: return self.root / "chapters"
    @property
    def audits_dir(self) -> Path: return self.root / "audits"
    @property
    def reviews_dir(self) -> Path: return self.root / "reviews"
    @property
    def checkpoints_dir(self) -> Path: return self.root / "checkpoints"
    @property
    def state_dir(self) -> Path: return self.root / "state"
    @property
    def usage_path(self) -> Path: return self.root / "usage.jsonl"
    @property
    def db_path(self) -> Path: return self.root / "memory.db"

    def chapter_path(self, n: int) -> Path: return self.chapters_dir / f"ch_{n:04d}.md"
    def audit_path(self, n: int) -> Path: return self.audits_dir / f"ch_{n:04d}.json"
    def review_path(self, n: int) -> Path: return self.reviews_dir / f"ch_{n:04d}.json"

    @property
    def exists(self) -> bool:
        return self.meta_path.exists()

    # ---------------- 通用 IO ----------------

    def read_json(self, path: Path, default: Any = None) -> Any:
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return default

    def write_json(self, path: Path, obj: Any) -> None:
        _atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=2))

    def read_jsonl(self, path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        rows: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return rows

    def write_jsonl(self, path: Path, rows: Iterable[Any]) -> None:
        lines = []
        for row in rows:
            data = row.model_dump() if hasattr(row, "model_dump") else row
            lines.append(json.dumps(data, ensure_ascii=False))
        _atomic_write(path, "\n".join(lines) + ("\n" if lines else ""))

    def read_text(self, path: Path, default: str = "") -> str:
        return path.read_text(encoding="utf-8") if path.exists() else default

    def write_text(self, path: Path, content: str) -> None:
        _atomic_write(path, content)

    # ---------------- 创建 ----------------

    @classmethod
    def create(cls, projects_root: Path, project_id: str, *, title: str, genre: str = "待定",
               premise: str = "", logline: str = "", mode: str = "semi-auto",
               budget_total: float | None = None) -> "ProjectStore":
        root = Path(projects_root) / project_id
        if root.exists() and (root / "meta.json").exists():
            raise Conflict(f"项目已存在：{project_id}")
        store = cls(root)
        for d in (store.chapters_dir, store.audits_dir, store.reviews_dir,
                  store.checkpoints_dir, store.state_dir):
            d.mkdir(parents=True, exist_ok=True)

        settings = get_settings()
        meta = ProjectMeta(
            id=project_id, title=title, genre=genre, premise=premise, logline=logline,
            mode=mode,  # type: ignore[arg-type]
            budget_total=settings.default_budget if budget_total is None else budget_total,
        )
        store.save_meta(meta)
        store.write_jsonl(store.characters_path, [])
        store.write_jsonl(store.hooks_path, [])
        store.write_jsonl(store.summaries_path, [])
        store.save_world(WorldDoc())
        store.save_outline_graph(OutlineGraph())
        store.save_style(StyleProfile())
        store.save_state(CurrentState())
        store.save_subplots([])
        store.write_text(store.usage_path, "")
        return store

    def delete(self) -> None:
        if self.root.exists():
            shutil.rmtree(self.root)

    # ---------------- meta ----------------

    def meta(self) -> ProjectMeta:
        raw = self.read_json(self.meta_path)
        if raw is None:
            raise NotFound(f"项目不存在或 meta.json 缺失：{self.id}")
        return ProjectMeta.model_validate(raw)

    def save_meta(self, meta: ProjectMeta) -> None:
        meta.updated_at = now_iso()
        self.write_json(self.meta_path, meta.model_dump())

    def touch_meta(self, **changes: Any) -> ProjectMeta:
        meta = self.meta()
        for key, value in changes.items():
            setattr(meta, key, value)
        self.save_meta(meta)
        return meta

    # ---------------- characters ----------------

    def characters(self) -> list[Character]:
        return [Character.model_validate(r) for r in self.read_jsonl(self.characters_path)]

    def save_characters(self, items: Sequence[Character]) -> None:
        self.write_jsonl(self.characters_path, items)
        self._changed("characters.jsonl")

    def character(self, key: str) -> Character | None:
        for c in self.characters():
            if c.id == key or c.name == key or key in c.aliases:
                return c
        return None

    def resolve_character(self, key: str) -> Character:
        found = self.character(key)
        if found is None:
            raise NotFound(f"没有这个角色：{key}")
        return found

    def next_character_id(self) -> str:
        used = {int(m.group(1)) for c in self.characters()
                if (m := re.match(r"char_(\d+)$", c.id))}
        return f"char_{(max(used) + 1) if used else 1:03d}"

    # ---------------- hooks ----------------

    def hooks(self) -> list[Hook]:
        return [Hook.model_validate(r) for r in self.read_jsonl(self.hooks_path)]

    def save_hooks(self, items: Sequence[Hook]) -> None:
        self.write_jsonl(self.hooks_path, items)
        self._changed("pending_hooks.jsonl")

    def hook(self, hook_id: str) -> Hook | None:
        return next((h for h in self.hooks() if h.id == hook_id), None)

    def next_hook_id(self) -> str:
        used = {int(m.group(1)) for h in self.hooks()
                if (m := re.match(r"hook_(\d+)$", h.id))}
        return f"hook_{(max(used) + 1) if used else 1:03d}"

    def hook_stats(self, current_chapter: int | None = None) -> dict[str, int]:
        """伏笔回收率——**核心质量指标**（规划文档 §6.7）。"""
        hooks = self.hooks()
        if current_chapter is None:
            current_chapter = max((h.planted_chapter for h in hooks), default=0)
        total = len(hooks)
        planted = sum(1 for h in hooks if h.status == "planted")
        resolved = sum(1 for h in hooks if h.status == "resolved")
        abandoned = sum(1 for h in hooks if h.status == "abandoned")
        overdue = sum(1 for h in hooks if h.overdue(current_chapter))
        return {
            "total": total, "planted": planted, "resolved": resolved,
            "abandoned": abandoned, "overdue": overdue,
            "rate": round(resolved / total * 100) if total else 0,
        }

    # ---------------- 世界观 ----------------

    def world(self) -> WorldDoc:
        raw = self.read_json(self.world_json)
        if raw is None:
            return WorldDoc()
        return WorldDoc.model_validate(raw)

    def save_world(self, doc: WorldDoc) -> None:
        doc.updated_at = now_iso()
        self.write_json(self.world_json, doc.model_dump())
        self.write_text(self.world_md, self._render_world_md(doc))
        self._changed("world.md")

    def hard_rules(self) -> list[WorldRule]:
        return [r for r in self.world().rules if r.kind == "hard"]

    @staticmethod
    def _render_world_md(doc: WorldDoc) -> str:
        lines = ["# 世界观规则", "",
                 "> 本文件是 `state/world.json` 的可读投影，**请勿直接编辑**（改动会被覆盖）。",
                 "> 硬约束违反即阻塞定稿；软设定可被正文反推改写。", ""]
        by_cat: dict[str, list[WorldRule]] = {}
        for rule in doc.rules:
            by_cat.setdefault(rule.category, []).append(rule)
        for cat, rules in by_cat.items():
            lines.append(f"## {cat}")
            lines.append("")
            for r in rules:
                flag = "硬约束" if r.kind == "hard" else "软设定"
                refs = "、".join(f"第 {n} 章" for n in r.refs) or "尚未引用"
                lines.append(f"- **[{flag}]** {r.rule}")
                lines.append(f"  - 引用：{refs}")
                if r.note:
                    lines.append(f"  - 备注：{r.note}")
            lines.append("")
        if not doc.rules:
            lines.append("_（尚未建立世界观规则）_")
        return "\n".join(lines) + "\n"

    # ---------------- 当前状态 ----------------

    def state(self) -> CurrentState:
        raw = self.read_json(self.current_state_json)
        return CurrentState.model_validate(raw) if raw else CurrentState()

    def save_state(self, state: CurrentState) -> None:
        state.updated_at = now_iso()
        self.write_json(self.current_state_json, state.model_dump())
        lines = [
            "# 世界当前状态", "",
            "> 本文件是 `state/current_state.json` 的可读投影，请勿直接编辑。", "",
            f"- 进度：截至第 {state.chapter} 章",
            f"- 焦点场景：{state.location_focus or '—'}",
            f"- 局势：{state.situation or '—'}",
            "",
        ]
        if state.open_questions:
            lines.append("## 悬而未决")
            lines.append("")
            lines.extend(f"- {q}" for q in state.open_questions)
            lines.append("")
        self.write_text(self.current_state_md, "\n".join(lines))
        self._changed("current_state.md")

    # ---------------- 支线 ----------------

    def subplots(self) -> list[Subplot]:
        raw = self.read_json(self.subplot_json, []) or []
        return [Subplot.model_validate(x) for x in raw]

    def save_subplots(self, items: Sequence[Subplot]) -> None:
        self.write_json(self.subplot_json, [s.model_dump() for s in items])
        lines = ["# 支线进度板", "",
                 "> 本文件是 `state/subplots.json` 的可读投影，请勿直接编辑。", ""]
        for s in items:
            kind = "主线" if s.kind == "main" else "支线"
            active = "、".join(f"{n}" for n in s.active) or "—"
            lines.append(f"## {s.name}（{kind}·{s.status}）")
            lines.append("")
            lines.append(f"- {s.summary or '（无摘要）'}")
            lines.append(f"- 活跃章：{active}")
            lines.append("")
        if not items:
            lines.append("_（尚未登记情节线）_")
        self.write_text(self.subplot_md, "\n".join(lines) + "\n")
        self._changed("subplot_board.md")

    # ---------------- 章纲依赖图 ----------------

    def outline_graph(self) -> OutlineGraph:
        raw = self.read_json(self.outline_graph_path)
        return OutlineGraph.model_validate(raw) if raw else OutlineGraph()

    def save_outline_graph(self, graph: OutlineGraph) -> None:
        graph.updated_at = now_iso()
        self.write_json(self.outline_graph_path, graph.model_dump())
        # outline.json 是同一个结构的可读扁平投影（**由本文件派生，不是第二份真相**）
        projection = {
            "_derived_from": "outline_graph.json",
            "compass": graph.compass.model_dump(),
            "volumes": [v.model_dump() for v in graph.volumes],
            "chapters": [
                {"chapter": n.chapter, "title": n.title, "volume": n.volume, "arc": n.arc,
                 "status": n.status, "goal": n.goal, "beats": n.beats, "pov": n.pov,
                 "intensity": n.intensity}
                for n in sorted(graph.nodes, key=lambda x: x.chapter)
            ],
            "edge_count": len(graph.edges),
        }
        self.write_json(self.outline_path, projection)
        self._changed("outline_graph.json")

    # ---------------- 章节摘要 ----------------

    def summaries(self) -> list[ChapterSummary]:
        return [ChapterSummary.model_validate(r) for r in self.read_jsonl(self.summaries_path)]

    def summary(self, chapter: int) -> ChapterSummary | None:
        return next((s for s in self.summaries() if s.chapter == chapter), None)

    def upsert_summary(self, summary: ChapterSummary) -> None:
        items = [s for s in self.summaries() if s.chapter != summary.chapter]
        items.append(summary)
        items.sort(key=lambda s: s.chapter)
        self.write_jsonl(self.summaries_path, items)
        self._changed("chapter_summaries.jsonl")

    # ---------------- 正文（带 front matter） ----------------

    _FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)

    def read_chapter(self, n: int) -> dict[str, Any]:
        """返回 `{chapter,title,status,words,pov,updated,paragraphs[]}`。"""
        path = self.chapter_path(n)
        if not path.exists():
            return {"chapter": n, "title": "", "status": "todo", "words": 0,
                    "pov": "", "updated": "", "paragraphs": []}
        raw = path.read_text(encoding="utf-8")
        front: dict[str, Any] = {}
        body = raw
        if m := self._FM_RE.match(raw):
            for line in m.group(1).splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    front[k.strip()] = v.strip()
            body = raw[m.end():]
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", body.strip()) if p.strip()]
        words = int(front.get("words") or count_words("\n".join(paragraphs)))
        return {
            "chapter": n,
            "title": front.get("title", ""),
            "status": front.get("status", "todo"),
            "words": words,
            "pov": front.get("pov", ""),
            "updated": front.get("updated", ""),
            "paragraphs": paragraphs,
        }

    def chapter_text(self, n: int) -> str:
        return "\n\n".join(self.read_chapter(n)["paragraphs"])

    def write_chapter(self, n: int, paragraphs: Sequence[str], *, title: str = "",
                      status: str = "draft", pov: str = "") -> dict[str, Any]:
        body = "\n\n".join(p.strip() for p in paragraphs if p.strip())
        words = count_words(body)
        front = [
            "---",
            f"chapter: {n}",
            f"title: {title}",
            f"status: {status}",
            f"words: {words}",
            f"pov: {pov}",
            f"updated: {now_iso()}",
            "---",
            "",
        ]
        heading = f"# 第 {n} 章 · {title}\n\n" if title else ""
        self.write_text(self.chapter_path(n), "\n".join(front) + heading + body + "\n")
        self._changed(f"chapters/ch_{n:04d}.md")
        return {"chapter": n, "title": title, "status": status, "words": words,
                "pov": pov, "updated": now_iso(), "paragraphs": list(paragraphs)}

    def update_chapter_status(self, n: int, status: str, **extra: Any) -> dict[str, Any]:
        data = self.read_chapter(n)
        return self.write_chapter(
            n, data["paragraphs"], title=extra.get("title", data["title"]),
            status=status, pov=extra.get("pov", data["pov"]),
        )

    def chapter_numbers(self) -> list[int]:
        if not self.chapters_dir.exists():
            return []
        out = []
        for p in sorted(self.chapters_dir.glob("ch_*.md")):
            if m := re.match(r"ch_(\d+)\.md$", p.name):
                out.append(int(m.group(1)))
        return out

    # ---------------- 审计 / 评审 ----------------

    def read_audit(self, n: int) -> AuditReport | None:
        raw = self.read_json(self.audit_path(n))
        return AuditReport.model_validate(raw) if raw else None

    def save_audit(self, report: AuditReport) -> None:
        report.generated_at = now_iso()
        self.write_json(self.audit_path(report.chapter), report.model_dump())
        self._changed(f"audits/ch_{report.chapter:04d}.json")

    def read_review(self, n: int) -> ReviewReport | None:
        raw = self.read_json(self.review_path(n))
        return ReviewReport.model_validate(raw) if raw else None

    def save_review(self, report: ReviewReport) -> None:
        report.generated_at = now_iso()
        self.write_json(self.review_path(report.chapter), report.model_dump())
        self._changed(f"reviews/ch_{report.chapter:04d}.json")

    # ---------------- 文风 ----------------

    def style(self) -> StyleProfile:
        raw = self.read_json(self.style_path)
        return StyleProfile.model_validate(raw) if raw else StyleProfile()

    def save_style(self, profile: StyleProfile) -> None:
        self.write_json(self.style_path, profile.model_dump())
        self._changed("style_profile.json")

    # ---------------- checkpoint ----------------

    def checkpoints(self, chapter: int | None = None) -> list[Checkpoint]:
        rows: list[Checkpoint] = []
        if not self.checkpoints_dir.exists():
            return rows
        for p in sorted(self.checkpoints_dir.glob("*.json")):
            raw = self.read_json(p)
            if not raw:
                continue
            try:
                cp = Checkpoint.model_validate(raw)
            except Exception:
                continue
            if chapter is None or cp.chapter == chapter:
                rows.append(cp)
        rows.sort(key=lambda c: (c.chapter, c.timestamp))
        return rows

    def save_checkpoint(self, cp: Checkpoint) -> None:
        name = f"ch_{cp.chapter:04d}_{cp.step}.json"
        self.write_json(self.checkpoints_dir / name, cp.model_dump())

    def latest_checkpoint(self, chapter: int | None = None) -> Checkpoint | None:
        rows = self.checkpoints(chapter)
        return rows[-1] if rows else None

    # ---------------- 派生概览（给首页 / 工作台） ----------------

    def chapters_overview(self) -> list[dict[str, Any]]:
        """章节列表：优先取章纲，其次取落盘正文，最后取摘要。"""
        graph = self.outline_graph()
        nodes = {n.chapter: n for n in graph.nodes}
        numbers = sorted(set(nodes) | set(self.chapter_numbers())
                         | {s.chapter for s in self.summaries()})
        out: list[dict[str, Any]] = []
        for n in numbers:
            node = nodes.get(n)
            data = self.read_chapter(n)
            summary = self.summary(n)
            status = data["status"]
            if status == "todo" and node and node.status in ("planned", "skeleton"):
                status = "planned"
            out.append({
                "n": n,
                "title": data["title"] or (node.title if node else "") or (summary.title if summary else ""),
                "status": status,
                "words": data["words"],
                "pov": data["pov"] or (node.pov if node else ""),
                "volume": node.volume if node else "",
                "arc": node.arc if node else "",
                "intensity": node.intensity if node else 3,
                "updated": data["updated"][:10] if data["updated"] else "—",
                "summary": (summary.summary if summary else "") or (node.goal if node else ""),
            })
        return out

    def project_summary(self, budget_used: float | None = None) -> dict[str, Any]:
        meta = self.meta()
        overview = self.chapters_overview()
        words = sum(c["words"] for c in overview)
        done = sum(1 for c in overview if c["status"] == "done")
        stats = self.hook_stats()
        audits = [self.read_audit(c["n"]) for c in overview if c["status"] in ("audit", "revise", "done")]
        pass_rate = 0
        if audits:
            clean = sum(1 for a in audits if a and not any(
                i.severity in ("blocker", "major") for i in a.items))
            pass_rate = round(clean / len(audits) * 100)
        total = max(meta.chapters_total, len(overview))
        return {
            "id": self.id,
            "title": meta.title,
            "genre": meta.genre,
            "logline": meta.logline or meta.premise,
            "mode": meta.mode,
            "chaptersDone": done,
            "chaptersTotal": total,
            "words": words or meta.words,
            "budgetUsed": round(meta.budget_used if budget_used is None else budget_used, 2),
            "budgetTotal": round(meta.budget_total, 2),
            "updatedAt": meta.updated_at.replace("T", " ")[:16],
            "hooksResolved": stats["resolved"],
            "hooksTotal": stats["total"],
            "auditPass": pass_rate,
        }

    # ---------------- 实时干预指令（steer） ----------------

    @property
    def steering_path(self) -> Path: return self.state_dir / "steering.jsonl"

    def steering_directives(self, *, chapter: int | None = None,
                            include_resolved: bool = False) -> list[dict[str, Any]]:
        """作者的干预意见。未消费的会被注入写作上下文——**否则干预就只是记了个笔记**。"""
        rows = self.read_jsonl(self.steering_path)
        out: list[dict[str, Any]] = []
        for row in rows:
            if not include_resolved and row.get("resolved"):
                continue
            if chapter is not None:
                target = row.get("target_chapter")
                if target is not None and int(target) > chapter:
                    continue
            out.append(row)
        return out

    def append_steering(self, directive: dict[str, Any]) -> dict[str, Any]:
        rows = self.read_jsonl(self.steering_path)
        directive.setdefault("id", f"steer_{len(rows) + 1:03d}")
        directive.setdefault("resolved", False)
        directive.setdefault("created_at", now_iso())
        rows.append(directive)
        self.write_jsonl(self.steering_path, rows)
        return directive

    def resolve_steering(self, ids: Sequence[str]) -> int:
        wanted = set(ids)
        rows = self.read_jsonl(self.steering_path)
        hit = 0
        for row in rows:
            if row.get("id") in wanted:
                row["resolved"] = True
                row["resolved_at"] = now_iso()
                hit += 1
        if hit:
            self.write_jsonl(self.steering_path, rows)
        return hit

    def _changed(self, rel: str) -> None:
        if self._on_truth_changed:
            try:
                self._on_truth_changed(rel)
            except Exception:
                pass


# ==========================================================================
# Proposal → Validate → Commit
# ==========================================================================

class TruthWriter:
    """真相文件的唯一写入闸门。"""

    #: 允许的提案类型 → 目标文件
    KINDS: dict[str, str] = {
        "character_add": "characters.jsonl",
        "character_update": "characters.jsonl",
        "hook_add": "pending_hooks.jsonl",
        "hook_resolve": "pending_hooks.jsonl",
        "hook_abandon": "pending_hooks.jsonl",
        "world_add": "world.md",
        "world_update": "world.md",
        "outline_upsert": "outline_graph.json",
        "edge_add": "outline_graph.json",
        "subplot_upsert": "subplot_board.md",
        "summary_upsert": "chapter_summaries.jsonl",
        "style_update": "style_profile.json",
        "fact_add": "current_state.md",
    }

    def __init__(self, store: ProjectStore) -> None:
        self.store = store

    # ---------------- 校验 ----------------

    def validate(self, proposals: Sequence[Proposal]) -> list[ValidationIssue]:
        issues: list[ValidationIssue] = []
        meta = self.store.meta()
        characters = {c.id: c for c in self.store.characters()}
        by_name = {c.name: c for c in self.store.characters()}
        hooks = list(self.store.hooks())
        graph = self.store.outline_graph()
        world = self.store.world()

        # 同一批提案内部也会互相冲突（例如同批新增两个同名角色），
        # 所以按顺序**增量**登记，而不是只看落盘状态。
        for p in proposals:
            if p.kind not in self.KINDS:
                issues.append(ValidationIssue(kind="未知提案类型",
                                              message=f"不认识的提案类型：{p.kind}",
                                              proposal_id=p.id))
                continue
            handler = getattr(self, f"_validate_{p.kind}", None)
            if handler is not None:
                issues.extend(handler(p, meta=meta, characters=characters, by_name=by_name,
                                      hooks=hooks, graph=graph, world=world))
            self._register(p, characters=characters, by_name=by_name,
                           hooks=hooks, graph=graph, world=world)
        return issues

    def _register(self, p: Proposal, **ctx: Any) -> None:
        """把提案登记进校验上下文，让后续提案能看见它。"""
        try:
            if p.kind == "character_add":
                char = Character.model_validate(p.payload)
                ctx["characters"][char.id] = char
                ctx["by_name"].setdefault(char.name, char)
            elif p.kind == "character_update":
                key = p.payload.get("id") or p.payload.get("name")
                target = ctx["characters"].get(key) or ctx["by_name"].get(key)
                if target is not None:
                    data = target.model_dump()
                    for k, v in (p.payload.get("changes") or {}).items():
                        if k == "state" and isinstance(v, dict):
                            data["state"] = {**data["state"], **v}
                        else:
                            data[k] = v
                    updated = Character.model_validate(data)
                    ctx["characters"][updated.id] = updated
                    ctx["by_name"][updated.name] = updated
            elif p.kind == "hook_add":
                ctx["hooks"].append(Hook.model_validate(p.payload))
            elif p.kind == "hook_resolve":
                hook_id = p.payload.get("id") or p.payload.get("hook_id")
                for h in ctx["hooks"]:
                    if h.id == hook_id:
                        h.status = "resolved"
                        h.resolved_chapter = p.payload.get("chapter") or h.resolved_chapter
            elif p.kind == "hook_abandon":
                hook_id = p.payload.get("id") or p.payload.get("hook_id")
                for h in ctx["hooks"]:
                    if h.id == hook_id:
                        h.status = "abandoned"
            elif p.kind == "world_add":
                rule = WorldRule.model_validate(p.payload)
                ctx["world"].rules = [r for r in ctx["world"].rules if r.id != rule.id] + [rule]
            elif p.kind == "outline_upsert":
                node = OutlineNode.model_validate(p.payload)
                ctx["graph"].nodes = [n for n in ctx["graph"].nodes
                                      if n.chapter != node.chapter] + [node]
                ctx["graph"].nodes.sort(key=lambda n: n.chapter)
            elif p.kind == "edge_add":
                ctx["graph"].edges.append(OutlineEdge.model_validate(p.payload))
        except Exception:
            pass

    # -- 各类型的校验规则 --

    def _validate_character_add(self, p: Proposal, **ctx: Any) -> list[ValidationIssue]:
        out: list[ValidationIssue] = []
        try:
            char = Character.model_validate(p.payload)
        except Exception as exc:
            log.warning("角色提案字段校验失败：%s", exc)
            return [ValidationIssue(kind="字段非法", message="角色字段不合法",
                                    proposal_id=p.id)]

        if char.id in ctx["characters"]:
            out.append(ValidationIssue(kind="重复角色", proposal_id=p.id,
                                       message=f"角色 id 已存在：{char.id}"))
        if char.name in ctx["by_name"] and ctx["by_name"][char.name].id != char.id:
            out.append(ValidationIssue(kind="重复角色", proposal_id=p.id,
                                       message=f"角色姓名已存在：{char.name}"))
        if not char.immutable_traits:
            out.append(ValidationIssue(level="warning", kind="缺少不可变特征", proposal_id=p.id,
                                       message=f"「{char.name}」没有不可变特征，防崩能力会打折"))
        # 已故角色不得以在世状态新增
        if char.deceased and char.state.status and "亡" not in char.state.status and "死" not in char.state.status:
            out.append(ValidationIssue(kind="状态矛盾", proposal_id=p.id,
                                       message=f"「{char.name}」标记为已故，但状态写的是「{char.state.status}」"))
        return out

    def _validate_character_update(self, p: Proposal, **ctx: Any) -> list[ValidationIssue]:
        out: list[ValidationIssue] = []
        key = p.payload.get("id") or p.payload.get("name") or ""
        target = ctx["characters"].get(key) or ctx["by_name"].get(key)
        if target is None:
            return [ValidationIssue(kind="角色不存在", proposal_id=p.id,
                                    message=f"要更新的角色不存在：{key}")]
        changes: dict[str, Any] = p.payload.get("changes") or {}

        # 硬规则：不可变特征只能增补，不能改写或删除
        if "immutable_traits" in changes:
            new_traits = list(changes["immutable_traits"] or [])
            removed = [t for t in target.immutable_traits if t not in new_traits]
            if removed:
                out.append(ValidationIssue(
                    kind="违背不可变特征", proposal_id=p.id,
                    message=f"不得删除「{target.name}」的不可变特征：{'、'.join(removed)}"
                            "（如需变更，必须人工在设置里显式解除锁定）"))
        if changes.get("deceased") is False and target.deceased:
            out.append(ValidationIssue(
                kind="角色复活", proposal_id=p.id,
                message=f"「{target.name}」已标记亡故，不得直接复活；"
                        "如需复活请在提案里说明依据并人工确认"))
        if "state" in changes and not isinstance(changes["state"], dict):
            out.append(ValidationIssue(kind="字段非法", proposal_id=p.id,
                                       message="角色状态的格式不正确"))
        return out

    def _validate_hook_add(self, p: Proposal, **ctx: Any) -> list[ValidationIssue]:
        out: list[ValidationIssue] = []
        try:
            hook = Hook.model_validate(p.payload)
        except Exception as exc:
            log.warning("伏笔提案字段校验失败：%s", exc)
            return [ValidationIssue(kind="字段非法", message="伏笔字段不合法",
                                    proposal_id=p.id)]

        norm = _norm(hook.content)
        for existing in ctx["hooks"]:
            if existing.id == hook.id:
                out.append(ValidationIssue(kind="重复伏笔", proposal_id=p.id,
                                           message=f"伏笔 id 已存在：{hook.id}"))
                continue
            if _similar(norm, _norm(existing.content)) >= 0.82:
                out.append(ValidationIssue(
                    kind="重复伏笔", proposal_id=p.id,
                    message=f"与已有伏笔「{existing.content}」高度相似，疑似重复埋设"))
        if hook.suggested_resolve_by and hook.suggested_resolve_by <= hook.planted_chapter:
            out.append(ValidationIssue(kind="字段非法", proposal_id=p.id,
                                       message="建议回收章必须晚于埋设章"))
        return out

    def _validate_hook_resolve(self, p: Proposal, **ctx: Any) -> list[ValidationIssue]:
        hook_id = p.payload.get("id") or p.payload.get("hook_id")
        chapter = int(p.payload.get("chapter") or 0)
        hooks = {h.id: h for h in ctx["hooks"]}
        if hook_id not in hooks:
            return [ValidationIssue(kind="伏笔不存在", proposal_id=p.id,
                                    message=f"要回收的伏笔不存在：{hook_id}")]
        hook = hooks[hook_id]
        if hook.status == "resolved":
            return [ValidationIssue(level="warning", kind="重复回收", proposal_id=p.id,
                                    message=f"伏笔「{hook.content}」已在第 {hook.resolved_chapter} 章回收")]
        if chapter and chapter < hook.planted_chapter:
            return [ValidationIssue(kind="时序矛盾", proposal_id=p.id,
                                    message="回收章早于埋设章")]
        return []

    def _validate_hook_abandon(self, p: Proposal, **ctx: Any) -> list[ValidationIssue]:
        hook_id = p.payload.get("id") or p.payload.get("hook_id")
        if hook_id not in {h.id for h in ctx["hooks"]}:
            return [ValidationIssue(kind="伏笔不存在", proposal_id=p.id,
                                    message=f"要放弃的伏笔不存在：{hook_id}")]
        return [ValidationIssue(level="warning", kind="伏笔弃用", proposal_id=p.id,
                                message="伏笔被标记为弃用，会拉低回收率，请确认这是有意为之")]

    def _validate_world_add(self, p: Proposal, **ctx: Any) -> list[ValidationIssue]:
        out: list[ValidationIssue] = []
        try:
            rule = WorldRule.model_validate(p.payload)
        except Exception as exc:
            log.warning("世界观提案字段校验失败：%s", exc)
            return [ValidationIssue(kind="字段非法", message="世界观字段不合法",
                                    proposal_id=p.id)]

        norm = _norm(rule.rule)
        for existing in ctx["world"].rules:
            if existing.id == rule.id:
                out.append(ValidationIssue(kind="重复设定", proposal_id=p.id,
                                           message=f"设定 id 已存在：{rule.id}"))
            elif _similar(norm, _norm(existing.rule)) >= 0.85:
                out.append(ValidationIssue(
                    kind="重复设定", proposal_id=p.id,
                    message=f"与已有设定高度相似：「{existing.rule}」"))
        if rule.kind == "hard" and not rule.rule.strip():
            out.append(ValidationIssue(kind="字段非法", proposal_id=p.id, message="硬约束不能为空"))
        return out

    def _validate_outline_upsert(self, p: Proposal, **ctx: Any) -> list[ValidationIssue]:
        out: list[ValidationIssue] = []
        try:
            node = OutlineNode.model_validate(p.payload)
        except Exception as exc:
            log.warning("章纲提案字段校验失败：%s", exc)
            return [ValidationIssue(kind="字段非法", message="章纲字段不合法",
                                    proposal_id=p.id)]
        existing = ctx["graph"].node(node.chapter)
        if existing and existing.status == "written" and _norm(existing.goal) != _norm(node.goal):
            out.append(ValidationIssue(
                level="warning", kind="改动已成稿章纲", proposal_id=p.id,
                message=f"第 {node.chapter} 章已有正文，改动章纲会影响已定稿内容，需人工确认"))
        return out

    def _validate_edge_add(self, p: Proposal, **ctx: Any) -> list[ValidationIssue]:
        try:
            edge = OutlineEdge.model_validate(p.payload)
        except Exception as exc:
            log.warning("依赖边提案字段校验失败：%s", exc)
            return [ValidationIssue(kind="字段非法", message="依赖边字段不合法",
                                    proposal_id=p.id)]
        if edge.from_chapter == edge.to_chapter:
            return [ValidationIssue(kind="字段非法", proposal_id=p.id,
                                    message="依赖边的起点与终点不能是同一章")]
        if edge.from_chapter < edge.to_chapter:
            # 方向反了会让「本章依赖的前因」查不出来，也会让关联章节推荐引到后文
            return [ValidationIssue(
                level="warning", kind="依赖边方向可疑", proposal_id=p.id,
                message=(f"依赖边的方向看起来反了：约定是「后章 → 它依赖的前章」，"
                         f"但这里是第 {edge.from_chapter} 章 → 第 {edge.to_chapter} 章。"))]
        return []

    def _validate_subplot_upsert(self, p: Proposal, **ctx: Any) -> list[ValidationIssue]:
        try:
            Subplot.model_validate(p.payload)
        except Exception as exc:
            log.warning("情节线提案字段校验失败：%s", exc)
            return [ValidationIssue(kind="字段非法", message="情节线字段不合法",
                                    proposal_id=p.id)]
        return []

    def _validate_summary_upsert(self, p: Proposal, **ctx: Any) -> list[ValidationIssue]:
        try:
            ChapterSummary.model_validate(p.payload)
        except Exception as exc:
            log.warning("章节摘要提案字段校验失败：%s", exc)
            return [ValidationIssue(kind="字段非法", message="章节摘要字段不合法",
                                    proposal_id=p.id)]
        return []

    def _validate_style_update(self, p: Proposal, **ctx: Any) -> list[ValidationIssue]:
        try:
            StyleProfile.model_validate(p.payload)
        except Exception as exc:
            log.warning("文风档案提案字段校验失败：%s", exc)
            return [ValidationIssue(kind="字段非法", message="文风档案字段不合法",
                                    proposal_id=p.id)]
        return []

    def _validate_fact_add(self, p: Proposal, **ctx: Any) -> list[ValidationIssue]:
        if not (p.payload.get("text") or "").strip():
            return [ValidationIssue(kind="字段非法", proposal_id=p.id, message="事实内容为空")]
        return []

    # ---------------- 提交 ----------------

    def commit(self, proposals: Sequence[Proposal], *, force: bool = False) -> CommitResult:
        """校验后落盘。`force=True` 表示人工已确认，跳过 error 级阻断（warning 仍需记录）。"""
        result = CommitResult()
        issues = self.validate(proposals)
        result.issues = issues
        errors_by_proposal: dict[str, list[ValidationIssue]] = {}
        for issue in issues:
            if issue.level == "error":
                errors_by_proposal.setdefault(issue.proposal_id, []).append(issue)

        changed: set[str] = set()
        for p in proposals:
            if errors_by_proposal.get(p.id) and not force:
                result.pending.append(p)          # 降级为待人工确认，不写入
                continue
            try:
                rel = self._apply(p)
            except Exception as exc:              # 应用失败同样不写入
                log.warning("提案应用失败 %s：%s", p.id, exc)
                result.issues.append(ValidationIssue(
                    kind="应用失败", proposal_id=p.id,
                    message=f"提案 {p.id} 写入失败"))
                result.pending.append(p)
                continue
            p.decision = p.decision or "accept"
            result.applied.append(p)
            if rel:
                changed.add(rel)

        result.changed_files = sorted(changed)
        if changed:
            self._refresh_indexes()
        return result

    def _apply(self, p: Proposal) -> str:
        store = self.store
        kind = p.kind

        if kind == "character_add":
            char = Character.model_validate(p.payload)
            items = store.characters()
            items = [c for c in items if c.id != char.id] + [char]
            store.save_characters(items)
            return "characters.jsonl"

        if kind == "character_update":
            key = p.payload.get("id") or p.payload.get("name")
            items = store.characters()
            target = next((c for c in items if c.id == key or c.name == key), None)
            if target is None:
                raise NotFound(f"角色不存在：{key}")
            data = target.model_dump()
            for k, v in (p.payload.get("changes") or {}).items():
                if k == "state" and isinstance(v, dict):
                    data["state"] = {**data["state"], **v}
                else:
                    data[k] = v
            updated = Character.model_validate(data)
            store.save_characters([updated if c.id == target.id else c for c in items])
            return "characters.jsonl"

        if kind == "hook_add":
            hook = Hook.model_validate(p.payload)
            items = [h for h in store.hooks() if h.id != hook.id] + [hook]
            items.sort(key=lambda h: (h.planted_chapter, h.id))
            store.save_hooks(items)
            return "pending_hooks.jsonl"

        if kind == "hook_resolve":
            hook_id = p.payload.get("id") or p.payload.get("hook_id")
            chapter = int(p.payload.get("chapter") or 0)
            items = store.hooks()
            hit = False
            for h in items:
                if h.id == hook_id:
                    h.status = "resolved"
                    h.resolved_chapter = chapter or h.resolved_chapter
                    hit = True
            if not hit:
                raise NotFound(f"伏笔不存在：{hook_id}")
            store.save_hooks(items)
            return "pending_hooks.jsonl"

        if kind == "hook_abandon":
            hook_id = p.payload.get("id") or p.payload.get("hook_id")
            items = store.hooks()
            hit = False
            for h in items:
                if h.id == hook_id:
                    h.status = "abandoned"
                    hit = True
            if not hit:
                raise NotFound(f"伏笔不存在：{hook_id}")
            store.save_hooks(items)
            return "pending_hooks.jsonl"

        if kind == "world_add":
            rule = WorldRule.model_validate(p.payload)
            doc = store.world()
            doc.rules = [r for r in doc.rules if r.id != rule.id] + [rule]
            store.save_world(doc)
            return "world.md"

        if kind == "world_update":
            rule_key = p.payload.get("id")
            changes = p.payload.get("changes") or {}
            doc = store.world()
            hit = False
            for r in doc.rules:
                if r.id == rule_key:
                    for k, v in changes.items():
                        setattr(r, k, v)
                    hit = True
            if not hit:
                raise NotFound(f"设定不存在：{rule_key}")
            store.save_world(doc)
            return "world.md"

        if kind == "outline_upsert":
            node = OutlineNode.model_validate(p.payload)
            graph = store.outline_graph()
            graph.nodes = [n for n in graph.nodes if n.chapter != node.chapter] + [node]
            graph.nodes.sort(key=lambda n: n.chapter)
            store.save_outline_graph(graph)
            return "outline_graph.json"

        if kind == "edge_add":
            edge = OutlineEdge.model_validate(p.payload)
            graph = store.outline_graph()
            key = (edge.from_chapter, edge.to_chapter, edge.type)
            graph.edges = [e for e in graph.edges
                           if (e.from_chapter, e.to_chapter, e.type) != key] + [edge]
            store.save_outline_graph(graph)
            return "outline_graph.json"

        if kind == "subplot_upsert":
            sub = Subplot.model_validate(p.payload)
            items = [s for s in store.subplots() if s.id != sub.id] + [sub]
            store.save_subplots(items)
            return "subplot_board.md"

        if kind == "summary_upsert":
            store.upsert_summary(ChapterSummary.model_validate(p.payload))
            return "chapter_summaries.jsonl"

        if kind == "style_update":
            store.save_style(StyleProfile.model_validate(p.payload))
            return "style_profile.json"

        if kind == "fact_add":
            state = store.state()
            text = p.payload.get("text", "").strip()
            chapter = int(p.payload.get("chapter") or state.chapter or 0)
            state.chapter = max(state.chapter, chapter)
            if p.payload.get("situation"):
                state.situation = p.payload["situation"]
            if p.payload.get("location"):
                state.location_focus = p.payload["location"]
            if text and text not in state.open_questions:
                state.open_questions.append(text)
            store.save_state(state)
            return "current_state.md"

        raise ValidationFailed(f"未知提案类型：{kind}")

    def _refresh_indexes(self) -> None:
        """提交后刷新检索索引（延迟导入，避免 core ↔ memory 循环依赖）。"""
        try:
            from .memory import MemoryIndex
            MemoryIndex(self.store).reindex()
        except Exception:
            pass
