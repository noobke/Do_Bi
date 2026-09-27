"""Archivist：定稿正文 → 摘要 / 事实抽取 / 伏笔更新 / 依赖边更新（规划文档 §7.1）。

这是「长期记忆」真正沉淀的地方。抽取结果一律走 **Proposal → Validate → Commit**，
冲突项降级为待人工确认 —— 模型说「某个已故角色登场了」不会被静默写进真相文件。

同时做两件事：
- 把章节标记为已定稿，章纲节点标记为 `written`
- 追加一条时序记忆（`memory.db`），供日后检索与回溯
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..core.schema import (
    ChapterSummary,
    Hook,
    Proposal,
    Subplot,
    now_iso,
)
from ..core.store import CommitResult
from . import prompts
from .architect import _fmt_characters, _fmt_hooks
from .base import Agent, Usage

__all__ = ["Archivist", "ArchiveResult"]


@dataclass
class ArchiveResult:
    chapter: int
    summary: ChapterSummary | None = None
    commit: CommitResult | None = None
    hooks_planted: list[str] = field(default_factory=list)
    hooks_resolved: list[str] = field(default_factory=list)
    state_changes: list[str] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)

    def public(self) -> dict[str, Any]:
        return {
            "chapter": self.chapter,
            "summary": self.summary.model_dump() if self.summary else None,
            "hooksPlanted": self.hooks_planted,
            "hooksResolved": self.hooks_resolved,
            "stateChanges": self.state_changes,
            "applied": len(self.commit.applied) if self.commit else 0,
            "pending": [p.model_dump() for p in self.commit.pending] if self.commit else [],
            "issues": [i.model_dump() for i in self.commit.issues] if self.commit else [],
            "usage": self.usage.public(),
        }


class Archivist(Agent):
    async def archive(self, chapter: int) -> ArchiveResult:
        store = self.store
        data = store.read_chapter(chapter)
        text = "\n\n".join(data["paragraphs"])
        if not text.strip():
            raise ValueError(f"第 {chapter} 章还没有正文，无法归档。")

        self.scope(chapter, "commit")
        self.budget_gate()
        obj, result = await self.client.complete_json("archivist", [{
            "role": "user",
            "content": prompts.ARCHIVIST.format(
                chapter=chapter, title=data["title"],
                text=text,
                hooks=_fmt_hooks(store.hooks(), only_pending=False),
                characters=_fmt_characters(store.characters()),
            ),
        }])
        self.usage.add(result)
        if not isinstance(obj, dict):
            raise ValueError("归档结果不是 JSON 对象，请重试。")

        proposals: list[Proposal] = []
        outcome = ArchiveResult(chapter=chapter)

        # ---------- 摘要 ----------
        present = [str(x).strip() for x in (obj.get("characters_present") or []) if str(x).strip()]
        summary = ChapterSummary(
            chapter=chapter,
            title=data["title"],
            summary=str(obj.get("summary") or "").strip(),
            words=data["words"],
            pov=data["pov"],
            key_facts=[str(x).strip() for x in (obj.get("key_facts") or []) if str(x).strip()],
            characters=present,
            hooks_planted=outcome.hooks_planted,
            hooks_resolved=outcome.hooks_resolved,
            updated_at=now_iso(),
        )
        outcome.summary = summary

        # ---------- 新伏笔 ----------
        for raw in (obj.get("hooks_planted") or []):
            if not isinstance(raw, dict) or not str(raw.get("content") or "").strip():
                continue
            hid = store.next_hook_id()
            while hid in outcome.hooks_planted:
                hid = f"hook_{int(hid.split('_')[1]) + 1:03d}"
            resolve_by = raw.get("suggested_resolve_by")
            try:
                resolve_by = int(resolve_by) if resolve_by is not None else None
            except (TypeError, ValueError):
                resolve_by = None
            hook = Hook(
                id=hid, content=str(raw["content"]).strip(), planted_chapter=chapter,
                status="planted", importance=("major" if str(raw.get("importance")) == "major" else "minor"),
                suggested_resolve_by=resolve_by,
            )
            outcome.hooks_planted.append(hid)
            proposals.append(Proposal(id=f"hook_{hid}", kind="hook_add",
                                      payload=hook.model_dump(),
                                      target_file="pending_hooks.jsonl",
                                      reason=f"第 {chapter} 章埋设", confidence="medium"))

        # ---------- 回收伏笔 ----------
        known = {h.id for h in store.hooks()}
        for raw in (obj.get("hooks_resolved") or []):
            hid = str(raw).strip()
            if hid and hid in known:
                outcome.hooks_resolved.append(hid)
                proposals.append(Proposal(id=f"resolve_{hid}", kind="hook_resolve",
                                          payload={"id": hid, "chapter": chapter},
                                          target_file="pending_hooks.jsonl",
                                          reason=f"第 {chapter} 章回收", confidence="high"))
        summary.hooks_resolved = outcome.hooks_resolved

        # ---------- 世界状态 / 事实 ----------
        state_raw = obj.get("state") or {}
        situation = str(state_raw.get("situation") or "").strip()
        location = str(state_raw.get("location_focus") or "").strip()
        questions = [str(q).strip() for q in (state_raw.get("open_questions") or []) if str(q).strip()]
        proposals.append(Proposal(
            id=f"fact_ch{chapter}", kind="fact_add",
            payload={"text": questions[0] if questions else "", "chapter": chapter,
                     "situation": situation, "location": location},
            target_file="current_state.md", reason=f"第 {chapter} 章后的世界状态",
            confidence="medium",
        ))

        # ---------- 情节线推进 ----------
        existing_subs = {s.name: s for s in store.subplots()}
        for raw in (obj.get("subplot_updates") or []):
            if not isinstance(raw, dict) or not str(raw.get("name") or "").strip():
                continue
            name = str(raw["name"]).strip()
            base = existing_subs.get(name)
            chapters = sorted({*(base.active if base else []), chapter})
            sub = Subplot(
                id=base.id if base else f"pl_{len(existing_subs) + 1}",
                name=name,
                kind=base.kind if base else "sub",
                summary=str(raw.get("summary") or (base.summary if base else "")),
                color=base.color if base else "#4F6B4A",
                active=chapters,
                peak=sorted({*(base.peak if base else []), chapter}) if base and base.peak else [chapter],
                status="active",
            )
            proposals.append(Proposal(id=f"subplot_{sub.id}", kind="subplot_upsert",
                                      payload=sub.model_dump(),
                                      target_file="subplot_board.md",
                                      reason=f"第 {chapter} 章推进", confidence="medium"))

        # ---------- 角色状态变更 ----------
        by_name = {c.name: c for c in store.characters()}
        allowed_keys = {"location", "status", "known_secrets"}
        for raw in (obj.get("character_state_changes") or []):
            if not isinstance(raw, dict):
                continue
            name = str(raw.get("name") or "").strip()
            changes = raw.get("changes")
            if name not in by_name or not isinstance(changes, dict):
                continue
            clean = {k: v for k, v in changes.items() if k in allowed_keys and v}
            if not clean:
                continue
            clean["updated_at_chapter"] = chapter
            outcome.state_changes.append(f"{name}: {'/'.join(f'{k}={v}' for k, v in clean.items())}")
            proposals.append(Proposal(
                id=f"state_{by_name[name].id}", kind="character_update",
                payload={"id": by_name[name].id, "changes": clean},
                target_file="characters.jsonl",
                reason=f"第 {chapter} 章状态变更", confidence="medium",
            ))

        # ---------- 摘要提案 ----------
        proposals.append(Proposal(id=f"summary_ch{chapter}", kind="summary_upsert",
                                  payload=summary.model_dump(),
                                  target_file="chapter_summaries.jsonl",
                                  reason=f"第 {chapter} 章摘要", confidence="high"))

        outcome.commit = self.commit(proposals)

        # ---------- 章节与章纲状态 ----------
        store.update_chapter_status(chapter, "done", title=data["title"], pov=data["pov"])
        graph = store.outline_graph()
        node = graph.node(chapter)
        if node is not None:
            node.status = "written"
            if not node.title and data["title"]:
                node.title = data["title"]
            store.save_outline_graph(graph)

        # ---------- 时序记忆 ----------
        try:
            from ..core.memory import MemoryIndex
            MemoryIndex(store).append_timeline(chapter=chapter, kind="commit", payload={
                "title": data["title"],
                "summary": summary.summary,
                "hooksPlanted": outcome.hooks_planted,
                "hooksResolved": outcome.hooks_resolved,
                "words": data["words"],
            })
        except Exception:
            pass

        # ---------- 计量对账 ----------
        try:
            self.meter.reconcile()
        except Exception:
            pass

        self.cp.finish(
            self.cp.begin(chapter, "commit"),
            output_ref=f"chapter_summaries.jsonl#{chapter}",
            cost=self.usage.cost,
            note=(f"摘要 {len(summary.summary)} 字 · 新埋 {len(outcome.hooks_planted)} 条伏笔 · "
                  f"回收 {len(outcome.hooks_resolved)} 条"),
        )
        return outcome
