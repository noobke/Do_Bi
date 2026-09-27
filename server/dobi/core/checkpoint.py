"""step 级 checkpoint 与断点恢复（规划文档 §5.2 checkpoints、§7.4）。

恢复粒度：`plan / draft / audit / revise / commit`（本项目细化为 8 个 step）。
幂等：每个 step 带 `idempotency_key`，写入前查重，重放不会重复落盘。

**5 类中断场景**（`diagnose()` 的返回值直接对应恢复动作）：

| 中断时机 | 恢复行为 |
|---|---|
| 规划阶段 | 检查已保存设定，自动补全缺失项 |
| 某章写作中（有草稿未提交） | 读已有草稿继续 |
| 审查进行中 | 重新触发审查 |
| 修订队列未清空 | 继续处理待修订项 |
| 弧/卷展开中断 | 检测骨架弧，自动触发展开 |
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Literal

from .schema import PIPELINE_STEPS, STEP_LABELS, Checkpoint, now_iso
from .store import ProjectStore

__all__ = ["CheckpointManager", "ResumePlan"]

ResumeAction = Literal[
    "none", "replan", "expand_volume", "write_next",
    "continue_draft", "re_audit", "continue_revise",
]

ACTION_LABELS: dict[str, str] = {
    "none": "无需恢复",
    "replan": "补全缺失的设定与大綱",
    "expand_volume": "展开下一卷骨架",
    "write_next": "续写下一章",
    "continue_draft": "从已有草稿继续写",
    "re_audit": "重新审查本章",
    "continue_revise": "继续处理待修订项",
}


@dataclass
class ResumePlan:
    action: ResumeAction
    chapter: int
    step: str = "plan"
    reason: str = ""
    detail: dict[str, Any] = field(default_factory=dict)

    def public(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "label": ACTION_LABELS.get(self.action, self.action),
            "chapter": self.chapter,
            "step": self.step,
            "stepLabel": STEP_LABELS.get(self.step, self.step),
            "reason": self.reason,
            "detail": self.detail,
        }


class CheckpointManager:
    def __init__(self, store: ProjectStore) -> None:
        self.store = store

    # ---------------- 幂等键 ----------------

    @staticmethod
    def key(chapter: int, step: str, salt: str = "") -> str:
        raw = f"{chapter}:{step}:{salt}".encode("utf-8")
        return hashlib.sha256(raw).hexdigest()[:16]

    def applied_keys(self, chapter: int | None = None) -> set[str]:
        return {cp.idempotency_key for cp in self.store.checkpoints(chapter)
                if cp.status in ("ok", "skipped") and cp.idempotency_key}

    def already_applied(self, key: str) -> bool:
        return key in self.applied_keys()

    # ---------------- 写入 ----------------

    def begin(self, chapter: int, step: str, *, note: str = "", salt: str = "") -> Checkpoint:
        cp = Checkpoint(
            chapter=chapter, step=step,  # type: ignore[arg-type]
            status="running", attempt=self._next_attempt(chapter, step),
            idempotency_key=self.key(chapter, step, salt), note=note,
        )
        self.store.save_checkpoint(cp)
        return cp

    def finish(self, cp: Checkpoint, *, status: str = "ok", output_ref: str = "",
               tokens: int = 0, cost: float = 0.0, note: str = "") -> Checkpoint:
        cp.status = status  # type: ignore[assignment]
        cp.output_ref = output_ref
        cp.tokens = tokens
        cp.cost = round(cost, 4)
        if note:
            cp.note = note
        cp.timestamp = now_iso()
        self.store.save_checkpoint(cp)
        return cp

    def fail(self, cp: Checkpoint, *, note: str = "", tokens: int = 0, cost: float = 0.0) -> Checkpoint:
        return self.finish(cp, status="failed", tokens=tokens, cost=cost, note=note)

    def skip(self, chapter: int, step: str, *, note: str = "已完成，跳过") -> Checkpoint:
        cp = Checkpoint(chapter=chapter, step=step,  # type: ignore[arg-type]
                        status="skipped", idempotency_key=self.key(chapter, step), note=note)
        self.store.save_checkpoint(cp)
        return cp

    def done(self, chapter: int, step: str) -> Checkpoint | None:
        rows = [cp for cp in self.store.checkpoints(chapter) if cp.step == step]
        for cp in reversed(rows):
            if cp.status in ("ok", "skipped"):
                return cp
        return None

    def is_done(self, chapter: int, step: str) -> bool:
        return self.done(chapter, step) is not None

    def reset_from(self, chapter: int, *, step: str | None = None) -> int:
        """清掉某章（或某步）之后的 checkpoint，用于强制重跑。返回删除数。"""
        removed = 0
        for path in sorted(self.store.checkpoints_dir.glob("*.json")):
            raw = self.store.read_json(path)
            if not raw:
                continue
            try:
                cp = Checkpoint.model_validate(raw)
            except Exception:
                continue
            should = cp.chapter > chapter or (cp.chapter == chapter and step is not None and cp.step == step)
            if should:
                path.unlink()
                removed += 1
        return removed

    def _next_attempt(self, chapter: int, step: str) -> int:
        rows = [cp for cp in self.store.checkpoints(chapter) if cp.step == step]
        return len(rows) + 1

    # ---------------- 进度视图 ----------------

    def progress(self, chapter: int) -> dict[str, Any]:
        rows = self.store.checkpoints(chapter)
        by_step: dict[str, str] = {}
        for cp in rows:
            by_step[cp.step] = cp.status
        done = [s for s in PIPELINE_STEPS if by_step.get(s) in ("ok", "skipped")]
        running = next((s for s in PIPELINE_STEPS if by_step.get(s) == "running"), None)
        failed = [s for s in PIPELINE_STEPS if by_step.get(s) == "failed"]
        nxt = next((s for s in PIPELINE_STEPS if s not in done), None)
        return {
            "chapter": chapter,
            "steps": [{"key": s, "label": STEP_LABELS[s], "status": by_step.get(s, "todo")}
                      for s in PIPELINE_STEPS],
            "done": len(done),
            "total": len(PIPELINE_STEPS),
            "active": running,
            "next": nxt,
            "failed": failed,
            "lastCheckpointAt": rows[-1].timestamp if rows else None,
        }

    # ---------------- 5 类中断场景诊断 ----------------

    def diagnose(self, *, target_chapter: int | None = None) -> ResumePlan:
        store = self.store
        overview = store.chapters_overview()
        meta = store.meta()

        # 场景 1：规划阶段中断 —— 真相文件缺失
        missing: list[str] = []
        if not store.world().rules:
            missing.append("world")
        if not store.characters():
            missing.append("characters")
        graph = store.outline_graph()
        if not graph.nodes:
            missing.append("outline")
        if missing:
            return ResumePlan(
                action="replan", chapter=target_chapter or 1, step="plan",
                reason="世界观 / 角色 / 大纲尚未建立完整，需要先补全设定。",
                detail={"missing": missing},
            )

        written = [c for c in overview if c["status"] in ("draft", "audit", "revise", "done")]
        committed = [c for c in overview if c["status"] == "done"]
        last_chapter = max((c["n"] for c in overview), default=0)

        # 场景 5：卷展开中断 —— 存在骨架弧且已写到它附近
        current = target_chapter or max((c["n"] for c in written), default=0) or last_chapter
        skeleton = [n for n in graph.nodes if n.status == "skeleton" and n.chapter <= current + 1]
        if not skeleton:
            next_vol = next((v for v in graph.volumes if v.status == "skeleton"
                             and v.from_chapter <= last_chapter + 1), None)
            if next_vol is None and graph.volumes and last_chapter >= (
                    max(v.to_chapter for v in graph.volumes if v.status == "expanded") or 0):
                return ResumePlan(
                    action="expand_volume", chapter=last_chapter + 1, step="plan",
                    reason="当前卷已写完，下一卷仍是骨架弧，需要展开为详细章纲。",
                    detail={"volumes": [v.model_dump() for v in graph.volumes]},
                )

        # 取「最近一个未走完的章」
        pending = [c for c in overview if c["status"] not in ("todo", "planned")]
        if target_chapter is not None:
            pending = [c for c in overview if c["n"] == target_chapter] or pending

        for item in sorted(pending, key=lambda c: -c["n"]):
            n = item["n"]
            status = item["status"]
            audit = store.read_audit(n)

            # 场景 4：修订队列未清空
            if audit is not None:
                open_major = [i for i in audit.items
                              if i.decision is None and i.severity in ("blocker", "major")]
                if status in ("audit", "revise") and open_major:
                    return ResumePlan(
                        action="continue_revise", chapter=n, step="revise",
                        reason=f"第 {n} 章还有 {len(open_major)} 条重点问题未处理。",
                        detail={"open": [i.dim for i in open_major]},
                    )

            # 场景 3：审查进行中（有正文但没审查报告）
            if status in ("draft", "audit") and audit is None:
                return ResumePlan(
                    action="re_audit", chapter=n, step="audit",
                    reason=f"第 {n} 章已有正文但尚未审查。",
                    detail={"words": item.get("words", 0)},
                )

            # 场景 2：写作中断（草稿未定稿）
            if status in ("draft", "audit", "revise"):
                data = store.read_chapter(n)
                if data["paragraphs"]:
                    return ResumePlan(
                        action="continue_draft", chapter=n, step="draft",
                        reason=f"第 {n} 章有未定稿的草稿（{data['words']} 字），可继续写。",
                        detail={"words": data["words"]},
                    )

        # 兜底：接着写「第一个还没有正文的章」。
        # 不能用「最后一章 + 1」——大纲可能已经铺到第 6 章，而第 2 章还没写，
        # 那样会直接跳到第 7 章，把 2–6 章空过去。
        first_empty: int | None = None
        for item in sorted(overview, key=lambda c: c["n"]):
            if not store.read_chapter(item["n"])["paragraphs"]:
                first_empty = item["n"]
                break
        nxt = target_chapter or first_empty or (last_chapter + 1 if last_chapter else 1)
        return ResumePlan(
            action="write_next", chapter=nxt, step="plan",
            reason=f"前面的章节都已处理完，可以继续第 {nxt} 章。"
                   f"（本书目标 {meta.chapters_total or '未定'} 章，已定稿 {len(committed)} 章）",
            detail={"committed": len(committed)},
        )

    def public_state(self, *, target_chapter: int | None = None) -> dict[str, Any]:
        plan = self.diagnose(target_chapter=target_chapter)
        return {
            "resume": plan.public(),
            "recent": [cp.model_dump() for cp in self.store.checkpoints()[-12:]][::-1],
        }
