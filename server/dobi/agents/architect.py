"""Architect：灵感 → 世界观 / 角色 / 大纲 / 依赖图（规划文档 §7.1）。

**滚动规划**：初始只规划前 2 卷，写到该卷才展开详细章纲（`roll_volume`）。
一次铺到 300 章的大纲必然空心化 —— 这是规划文档 §7.3 的核心判断。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from ..core.schema import (
    Compass,
    Character,
    CharacterState,
    Hook,
    OutlineEdge,
    OutlineNode,
    Proposal,
    Relation,
    Volume,
    WorldRule,
)
from ..core.store import CommitResult
from ..llm.provider import LLMClient
from . import prompts
from .base import Agent, Usage

__all__ = ["Architect", "ArchitectResult"]


@dataclass
class ArchitectResult:
    targets: list[str] = field(default_factory=list)
    proposals: list[Proposal] = field(default_factory=list)
    commit: CommitResult | None = None
    usage: Usage = field(default_factory=Usage)
    notes: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return {
            "targets": self.targets,
            "proposalCount": len(self.proposals),
            "applied": len(self.commit.applied) if self.commit else 0,
            "pending": [p.model_dump() for p in self.commit.pending] if self.commit else [],
            "issues": [i.model_dump() for i in self.commit.issues] if self.commit else [],
            "usage": self.usage.public(),
            "notes": self.notes,
        }


def _fmt_characters(chars: Sequence[Character]) -> str:
    if not chars:
        return "（尚未建立）"
    lines = []
    for c in chars:
        traits = "；".join(c.immutable_traits) or "无"
        state = f"{c.state.location}／{c.state.status}"
        lines.append(f"- {c.name}（{c.role}）：特征 {traits}｜状态 {state}｜{c.personality}")
    return "\n".join(lines)


def _fmt_world(store) -> str:
    rules = store.world().rules
    if not rules:
        return "（尚未建立）"
    return "\n".join(f"- [{r.kind}/{r.category}] {r.rule}" for r in rules)


def _fmt_hooks(hooks: Sequence[Hook], *, only_pending: bool = True) -> str:
    picked = [h for h in hooks if h.status == "planted"] if only_pending else list(hooks)
    if not picked:
        return "（无）"
    return "\n".join(
        f"- {h.id}：{h.content}（埋于第 {h.planted_chapter} 章，"
        f"建议第 {h.suggested_resolve_by or '未定'} 章前回收）"
        for h in picked
    )


def present_characters(store, text: str) -> list[str]:
    """从一段文本里挑出「可能出场」的角色名，用于上下文组装时优先带他们的角色卡。"""
    if not text:
        return []
    names = []
    for c in store.characters():
        if c.name and c.name in text:
            names.append(c.name)
        else:
            for alias in c.aliases:
                if alias and alias in text:
                    names.append(c.name)
                    break
    return names


class Architect(Agent):
    # ---------------- 世界观 ----------------

    async def build_world(self) -> ArchitectResult:
        meta = self.store.meta()
        self.scope(1, "plan")
        self.budget_gate()
        prompt = prompts.WORLD.format(
            genre=meta.genre, premise=meta.premise or meta.logline or "（未填写）",
            tone=meta.logline or "克制、细节向",
            existing=_fmt_world(self.store),
        )
        data, result = await self.client.complete_json(
            "architect", [{"role": "user", "content": prompt}],
        )
        self.usage.add(result)

        rules = data.get("rules") if isinstance(data, dict) else None
        if not isinstance(rules, list) or not rules:
            raise ValueError("设定生成结果里没有 rules，请重试或换一个更强的模型。")

        proposals: list[Proposal] = []
        existing_ids = {r.id for r in self.store.world().rules}
        for i, raw in enumerate(rules, start=1):
            if not isinstance(raw, dict) or not str(raw.get("rule") or "").strip():
                continue
            rid = str(raw.get("id") or f"w{i}")
            if rid in existing_ids:
                rid = f"w{i}"
            rule = WorldRule(
                id=rid,
                category=str(raw.get("category") or "其他"),
                kind="soft" if str(raw.get("kind")) == "soft" else "hard",
                rule=str(raw["rule"]).strip(),
                note=str(raw.get("note") or ""),
            )
            proposals.append(Proposal(id=f"world_{rid}", kind="world_add",
                                      payload=rule.model_dump(), target_file="world.md",
                                      reason="Architect 建立世界观", confidence="high"))

        commit = self.commit(proposals)
        return ArchitectResult(targets=["world"], proposals=proposals, commit=commit,
                               usage=self.usage)

    # ---------------- 角色 ----------------

    async def build_characters(self) -> ArchitectResult:
        meta = self.store.meta()
        self.scope(1, "plan")
        self.budget_gate()
        existing = self.store.characters()
        prompt = prompts.CHARACTERS.format(
            genre=meta.genre, premise=meta.premise or meta.logline or "（未填写）",
            world=_fmt_world(self.store),
        )
        if existing:
            prompt += ("\n\n【已有角色（不要重复，如需增补只给新角色）】\n"
                       + _fmt_characters(existing))
        data, result = await self.client.complete_json(
            "architect", [{"role": "user", "content": prompt}],
        )
        self.usage.add(result)

        raw_chars = data.get("characters") if isinstance(data, dict) else None
        if not isinstance(raw_chars, list) or not raw_chars:
            raise ValueError("角色生成结果里没有 characters，请重试或换一个更强的模型。")

        used_ids = {c.id for c in existing}
        used_names = {c.name for c in existing}
        proposals: list[Proposal] = []
        created: list[Character] = []

        for i, raw in enumerate(raw_chars, start=1):
            if not isinstance(raw, dict) or not str(raw.get("name") or "").strip():
                continue
            name = str(raw["name"]).strip()
            if name in used_names:
                continue
            cid = str(raw.get("id") or "").strip()
            if not cid or cid in used_ids:
                cid = self.store.next_character_id()
                while cid in used_ids:
                    cid = f"char_{len(used_ids) + 1:03d}"
            used_ids.add(cid)
            used_names.add(name)

            rels = []
            for rel in (raw.get("relationships") or []):
                if not isinstance(rel, dict) or not str(rel.get("target") or "").strip():
                    continue
                rels.append(Relation(target=str(rel["target"]).strip(),
                                     type=str(rel.get("type") or "关联"),
                                     note=str(rel.get("note") or "")))
            state_raw = raw.get("state") or {}
            char = Character(
                id=cid, name=name,
                role=str(raw.get("role") or "配角"),
                lead=bool(raw.get("lead")),
                immutable_traits=[str(t).strip() for t in (raw.get("immutable_traits") or [])
                                  if str(t).strip()],
                personality=str(raw.get("personality") or ""),
                speech_style=str(raw.get("speech_style") or ""),
                relationships=rels,
                state=CharacterState(
                    location=str(state_raw.get("location") or "—"),
                    status=str(state_raw.get("status") or "—"),
                    known_secrets=[str(s) for s in (state_raw.get("known_secrets") or [])],
                ),
                first_appearance=int(raw.get("first_appearance") or 1),
                deceased=bool(raw.get("deceased")),
            )
            created.append(char)
            proposals.append(Proposal(id=f"char_{cid}", kind="character_add",
                                      payload=char.model_dump(), target_file="characters.jsonl",
                                      reason="Architect 建立角色", confidence="high"))

        commit = self.commit(proposals)
        if commit.applied:
            self._normalize_relations()
        return ArchitectResult(targets=["characters"], proposals=proposals, commit=commit,
                               usage=self.usage)

    def _normalize_relations(self) -> None:
        """把关系里的「角色姓名」统一成 id —— 姓名会变，id 不会。"""
        chars = self.store.characters()
        by_name = {c.name: c.id for c in chars}
        changed = False
        for c in chars:
            for rel in c.relationships:
                if rel.target in by_name and by_name[rel.target] != rel.target:
                    rel.target = by_name[rel.target]
                    changed = True
        if changed:
            self.store.save_characters(chars)

    # ---------------- 大纲 ----------------

    async def build_outline(self, *, volumes: int = 2) -> ArchitectResult:
        meta = self.store.meta()
        graph = self.store.outline_graph()
        self.scope(1, "plan")
        self.budget_gate()
        prompt = prompts.OUTLINE.format(
            genre=meta.genre, premise=meta.premise or meta.logline or "（未填写）",
            chapters_total=meta.chapters_total or "自由估计",
            volumes=volumes,
            compass_hint=graph.compass.endgame or "（尚未确定终局方向，请你定）",
            characters=_fmt_characters(self.store.characters()),
            world=_fmt_world(self.store),
            existing=(graph.model_dump_json(indent=1)[:3000] if graph.nodes else "（无）"),
        )
        data, result = await self.client.complete_json(
            "architect", [{"role": "user", "content": prompt}],
        )
        self.usage.add(result)

        proposals, notes = self._outline_to_proposals(data)
        commit = self.commit(proposals)

        # 罗盘与卷是「结构」级信息，直接落盘（它们是规划产物不是事实提案，无需校验）
        graph = self.store.outline_graph()
        compass_raw = data.get("compass") if isinstance(data, dict) else None
        if isinstance(compass_raw, dict) and compass_raw.get("endgame"):
            graph.compass = Compass(
                endgame=str(compass_raw.get("endgame") or ""),
                active_threads=[str(t) for t in (compass_raw.get("active_threads") or [])],
                scale_estimate=str(compass_raw.get("scale_estimate") or ""),
                refresh_at="第 1 卷末刷新",
            )
        vols = self._parse_volumes(data.get("volumes") if isinstance(data, dict) else None)
        if vols:
            graph.volumes = vols
            total = max((v.to_chapter for v in vols if v.to_chapter), default=0)
            if total:
                meta = self.store.meta()
                meta.chapters_total = max(meta.chapters_total, total)
                self.store.save_meta(meta)
        self.store.save_outline_graph(graph)

        notes.append(f"罗盘已设定：{graph.compass.endgame[:40]}…"
                     if graph.compass.endgame else "罗盘未生成")
        return ArchitectResult(targets=["outline"], proposals=proposals, commit=commit,
                               usage=self.usage, notes=notes)

    # ---------------- 滚动规划：展开骨架卷 ----------------

    async def roll_volume(self, index: int = -1) -> ArchitectResult:
        graph = self.store.outline_graph()
        if not graph.volumes:
            raise ValueError("还没有卷纲，先执行一次大纲生成。")
        if index < 0:
            skeleton = [v for v in graph.volumes if v.status == "skeleton"]
            if not skeleton:
                raise ValueError("没有待展开的骨架卷——所有卷都已经是详细章纲了。")
            volume = skeleton[0]
        else:
            if index >= len(graph.volumes):
                raise ValueError(f"卷序号超出范围（共 {len(graph.volumes)} 卷）。")
            volume = graph.volumes[index]
            if volume.status == "expanded":
                raise ValueError(f"「{volume.name}」已经是详细章纲，无需重复展开。")

        frm = volume.from_chapter
        to = volume.to_chapter or (frm + max(1, volume.est_chapters) - 1)
        previous = self.store.summaries()
        previous = "\n".join(f"- 第 {s.chapter} 章《{s.title}》：{s.summary}"
                             for s in previous[-12:]) or "（这是第一卷，无前情）"

        self.scope(frm, "plan")
        self.budget_gate()
        prompt = prompts.ROLL_VOLUME.format(
            genre=self.store.meta().genre,
            endgame=graph.compass.endgame or "（未定）",
            volume_name=volume.name, from_chapter=frm, to_chapter=to,
            goal=volume.goal or "（未定）",
            previous=previous,
            threads="、".join(graph.compass.active_threads) or "（无）",
            characters=_fmt_characters(self.store.characters()),
            hooks=_fmt_hooks(self.store.hooks()),
        )
        data, result = await self.client.complete_json(
            "architect", [{"role": "user", "content": prompt}],
            max_tokens=self.client.max_output_for("architect"),
        )
        self.usage.add(result)

        nodes_raw = data.get("nodes") if isinstance(data, dict) else None
        if not isinstance(nodes_raw, list) or not nodes_raw:
            raise ValueError("展开结果里没有 nodes，请重试。")
        proposals = self._nodes_to_proposals(nodes_raw, volume=volume, default_pov="")
        edge_raw = data.get("edges") if isinstance(data, dict) else None
        proposals.extend(self._edges_to_proposals(edge_raw))
        commit = self.commit(proposals)

        graph = self.store.outline_graph()
        for i, v in enumerate(graph.volumes):
            if v.name == volume.name:
                v.status = "expanded"
                v.to_chapter = to
        compass_raw = data.get("compass") if isinstance(data, dict) else None
        if isinstance(compass_raw, dict):
            if compass_raw.get("refresh_at"):
                graph.compass.refresh_at = str(compass_raw["refresh_at"])
            threads = compass_raw.get("active_threads")
            if isinstance(threads, list) and threads:
                graph.compass.active_threads = [str(t) for t in threads]
        self.store.save_outline_graph(graph)

        return ArchitectResult(targets=[f"volume:{volume.name}"], proposals=proposals,
                               commit=commit, usage=self.usage,
                               notes=[f"已展开 {volume.name}（第 {frm}–{to} 章）"])

    # ---------------- 单章章纲 ----------------

    async def plan_chapter(self, chapter: int) -> ArchitectResult:
        graph = self.store.outline_graph()
        node = graph.node(chapter)
        neighbours = [n for n in graph.nodes if abs(n.chapter - chapter) == 1]
        incoming = graph.motivations_for(chapter)
        self.scope(chapter, "plan")
        self.budget_gate()
        prompt = prompts.CHAPTER_PLAN.format(
            chapter=chapter, genre=self.store.meta().genre,
            endgame=graph.compass.endgame or "（未定）",
            volume=node.volume if node else "",
            volume_goal=next((v.goal for v in graph.volumes if node and v.name == node.volume), ""),
            neighbours="；".join(f"第 {n.chapter} 章《{n.title}》{n.goal}" for n in neighbours) or "（无）",
            previous="\n".join(f"- 第 {s.chapter} 章：{s.summary}" for s in self.store.summaries()[-5:]) or "（无）",
            characters=_fmt_characters(self.store.characters()),
            hooks=_fmt_hooks(self.store.hooks()),
            incoming="\n".join(f"- 依赖第 {e.to_chapter} 章：{e.note}" for e in incoming) or "（无）",
        )
        data, result = await self.client.complete_json(
            "chapter_plan", [{"role": "user", "content": prompt}],
        )
        self.usage.add(result)

        raw = data.get("node") if isinstance(data, dict) else None
        if not isinstance(raw, dict):
            raise ValueError("章纲生成结果里没有 node，请重试。")
        volume = node.volume if node else ""
        proposals = self._nodes_to_proposals([raw], volume=None, default_pov="",
                                            volume_name=volume)
        proposals.extend(self._edges_to_proposals(
            data.get("new_edges") if isinstance(data, dict) else None))
        commit = self.commit(proposals)
        return ArchitectResult(targets=[f"chapter:{chapter}"], proposals=proposals,
                               commit=commit, usage=self.usage)

    # ---------------- 解析辅助 ----------------

    def _outline_to_proposals(self, data: Any) -> tuple[list[Proposal], list[str]]:
        notes: list[str] = []
        if not isinstance(data, dict):
            raise ValueError("大纲生成结果不是 JSON 对象，请重试。")
        nodes = self._parse_nodes(data.get("nodes"))
        if not nodes:
            raise ValueError("大纲生成结果里没有有效的 nodes，请重试。")
        volume_of: dict[int, str] = {}
        for v in self._parse_volumes(data.get("volumes")):
            for n in range(v.from_chapter, (v.to_chapter or v.from_chapter) + 1):
                volume_of[n] = v.name
        proposals: list[Proposal] = []
        for node in nodes:
            if not node.volume and node.chapter in volume_of:
                node.volume = volume_of[node.chapter]
            proposals.append(self._node_proposal(node))
        proposals.extend(self._edges_to_proposals(data.get("edges")))
        notes.append(f"已生成 {len(nodes)} 条章纲")
        return proposals, notes

    def _nodes_to_proposals(self, raw_nodes: Any, *, volume: Volume | None,
                            default_pov: str, volume_name: str = "") -> list[Proposal]:
        nodes = self._parse_nodes(raw_nodes, volume=volume, default_pov=default_pov,
                                  volume_name=volume_name)
        return [self._node_proposal(n) for n in nodes]

    @staticmethod
    def _node_proposal(node: OutlineNode) -> Proposal:
        return Proposal(id=f"outline_ch{node.chapter}", kind="outline_upsert",
                        payload=node.model_dump(), target_file="outline_graph.json",
                        reason=f"第 {node.chapter} 章章纲", confidence="high")

    def _parse_nodes(self, raw_nodes: Any, *, volume: Volume | None = None,
                     default_pov: str = "", volume_name: str = "") -> list[OutlineNode]:
        out: list[OutlineNode] = []
        if not isinstance(raw_nodes, list):
            return out
        for raw in raw_nodes:
            if not isinstance(raw, dict):
                continue
            try:
                chapter = int(raw.get("chapter"))
            except (TypeError, ValueError):
                continue
            if chapter <= 0:
                continue
            beats = [str(b).strip() for b in (raw.get("beats") or []) if str(b).strip()]
            timeline: list[dict[str, str]] = []
            for ev in (raw.get("timeline") or []):
                if not isinstance(ev, dict):
                    continue
                label = str(ev.get("label") or "").strip()
                if not label:
                    continue
                kind = str(ev.get("kind") or "").strip()
                timeline.append({
                    "at": str(ev.get("at") or "").strip(),
                    "label": label,
                    "kind": kind if kind in ("backstory", "flashback", "now", "future") else "now",
                })
            out.append(OutlineNode(
                chapter=chapter,
                title=str(raw.get("title") or "").strip(),
                arc=str(raw.get("arc") or (volume.name.split("·")[-1].strip() if volume else "")),
                volume=str(raw.get("volume") or volume_name or (volume.name if volume else "")),
                status="planned",
                goal=str(raw.get("goal") or "").strip(),
                beats=beats,
                rationale=str(raw.get("rationale") or "").strip(),
                pov=str(raw.get("pov") or default_pov),
                intensity=max(1, min(5, int(raw.get("intensity") or 3))),
                story_at=str(raw.get("story_at") or "").strip(),
                timeline=timeline[:6],
            ))
        out.sort(key=lambda n: n.chapter)
        return out

    @staticmethod
    def _parse_volumes(raw_vols: Any) -> list[Volume]:
        out: list[Volume] = []
        if not isinstance(raw_vols, list):
            return out
        for raw in raw_vols:
            if not isinstance(raw, dict) or not str(raw.get("name") or "").strip():
                continue
            try:
                frm = int(raw.get("from_chapter") or 1)
            except (TypeError, ValueError):
                frm = 1
            try:
                to = int(raw.get("to_chapter") or 0)
            except (TypeError, ValueError):
                to = 0
            status = "expanded" if str(raw.get("status")) == "expanded" else "skeleton"
            out.append(Volume(
                name=str(raw["name"]).strip(), from_chapter=frm, to_chapter=to,
                goal=str(raw.get("goal") or ""),
                est_chapters=int(raw.get("est_chapters") or (to - frm + 1 if to else 0)),
                status=status,  # type: ignore[arg-type]
                arc=str(raw.get("arc") or raw["name"].split("·")[-1].strip()),
            ))
        return out

    @staticmethod
    def _edges_to_proposals(raw_edges: Any) -> list[Proposal]:
        out: list[Proposal] = []
        if not isinstance(raw_edges, list):
            return out
        allowed = {"motivation", "setup", "payoff", "causality", "parallel"}
        for i, raw in enumerate(raw_edges, start=1):
            if not isinstance(raw, dict):
                continue
            try:
                frm = int(raw.get("from") or raw.get("from_chapter"))
                to = int(raw.get("to") or raw.get("to_chapter"))
            except (TypeError, ValueError):
                continue
            if frm == to:
                continue
            etype = str(raw.get("type") or "causality")
            if etype not in allowed:
                etype = "causality"
            edge = OutlineEdge(from_chapter=frm, to_chapter=to,  # type: ignore[arg-type]
                               type=etype,  # type: ignore[arg-type]
                               note=str(raw.get("note") or ""), confirmed=False)
            out.append(Proposal(id=f"edge_{frm}_{to}_{etype}_{i}", kind="edge_add",
                                payload=edge.model_dump(), target_file="outline_graph.json",
                                reason="依赖边", confidence="medium"))
        return out
