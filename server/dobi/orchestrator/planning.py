"""滚动规划（规划文档 §7.3）。

不一次性规划全部章节 —— 大纲到 300 章必然空心化。三层结构：

- **罗盘 Compass**：终局方向 + 活跃长线 + 规模估计，每个卷边界刷新
- **骨架弧**：只记 `目标 + 预估章数`，写到该弧才展开详细章纲
- **渐进细化**：展开时参考前文摘要、角色快照、风格规则

初始只规划前 2 卷。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from ..agents import Architect
from ..core.metering import Meter
from ..core.store import ProjectStore
from ..llm.provider import LLMClient

__all__ = ["Planner", "PlanOutcome"]


@dataclass
class PlanOutcome:
    action: str = ""
    changed: list[str] = field(default_factory=list)
    cost: float = 0.0
    notes: list[str] = field(default_factory=list)
    issues: list[dict[str, Any]] = field(default_factory=list)
    pending: list[dict[str, Any]] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "changed": self.changed,
            "cost": round(self.cost, 4),
            "notes": self.notes,
            "issues": self.issues,
            "pending": self.pending,
        }


class Planner:
    def __init__(self, store: ProjectStore, client: LLMClient,
                 meter: Meter | None = None) -> None:
        self.store = store
        self.client = client
        self.meter = meter or Meter(store)
        self.architect = Architect(store, client, self.meter)

    # ---------------- 立项：世界观 → 角色 → 大纲 ----------------

    async def bootstrap(
        self, *, volumes: int = 2, targets: Sequence[str] = ("world", "characters", "outline"),
    ) -> PlanOutcome:
        outcome = PlanOutcome(action="bootstrap")
        cost_before = self.meter.used

        if "world" in targets:
            res = await self.architect.build_world()
            outcome.changed.append("世界观")
            outcome.notes.extend(res.notes)
            _collect(outcome, res.commit)
        if "characters" in targets:
            res = await self.architect.build_characters()
            outcome.changed.append("角色")
            _collect(outcome, res.commit)
        if "outline" in targets:
            res = await self.architect.build_outline(volumes=volumes)
            outcome.changed.append("大纲与依赖图")
            outcome.notes.extend(res.notes)
            _collect(outcome, res.commit)

        outcome.cost = round(self.meter.used - cost_before, 4)
        graph = self.store.outline_graph()
        outcome.notes.append(
            f"当前规划：{len(graph.volumes)} 卷 · {len(graph.nodes)} 条章纲 · "
            f"{len(graph.edges)} 条依赖边"
        )
        return outcome

    # ---------------- 展开下一卷骨架 ----------------

    async def roll_next(self) -> PlanOutcome:
        outcome = PlanOutcome(action="roll")
        cost_before = self.meter.used
        res = await self.architect.roll_volume(-1)
        outcome.changed.extend(res.targets)
        outcome.notes.extend(res.notes)
        _collect(outcome, res.commit)
        outcome.cost = round(self.meter.used - cost_before, 4)
        return outcome

    # ---------------- 覆盖率视图 ----------------

    def coverage(self) -> dict[str, Any]:
        graph = self.store.outline_graph()
        nodes = {n.chapter: n for n in graph.nodes}
        expanded = [v for v in graph.volumes if v.status == "expanded"]
        skeleton = [v for v in graph.volumes if v.status == "skeleton"]
        detail_nodes = [n for n in graph.nodes if n.goal and n.beats]
        return {
            "compass": graph.compass.model_dump(),
            "volumes": [{
                "name": v.name, "from": v.from_chapter, "to": v.to_chapter,
                "status": v.status, "goal": v.goal, "chapters": v.chapters,
            } for v in graph.volumes],
            "expandedVolumes": len(expanded),
            "skeletonVolumes": len(skeleton),
            "nodes": len(graph.nodes),
            "detailedNodes": len(detail_nodes),
            "edges": len(graph.edges),
            "unconfirmedEdges": len([e for e in graph.edges if not e.confirmed]),
            "chapterRange": [min(nodes) if nodes else 0, max(nodes) if nodes else 0],
            "skeletonChapters": sorted(n.chapter for n in graph.nodes if n.status == "skeleton"),
        }

    # ---------------- 写第 N 章前的规划保障 ----------------

    async def ensure_for_chapter(self, chapter: int) -> PlanOutcome | None:
        """若第 N 章落在未展开的骨架卷里，先展开；若章纲缺失，补一条。"""
        graph = self.store.outline_graph()
        volume = next((v for v in graph.volumes
                       if v.from_chapter <= chapter <= (v.to_chapter or v.from_chapter + max(1, v.est_chapters) - 1)),
                      None)
        if volume is not None and volume.status == "skeleton":
            index = graph.volumes.index(volume)
            outcome = PlanOutcome(action="roll")
            cost_before = self.meter.used
            res = await self.architect.roll_volume(index)
            outcome.changed.extend(res.targets)
            outcome.notes.extend(res.notes)
            _collect(outcome, res.commit)
            outcome.cost = round(self.meter.used - cost_before, 4)
            return outcome

        node = graph.node(chapter)
        if node is None or not node.beats:
            outcome = PlanOutcome(action="plan_chapter")
            cost_before = self.meter.used
            res = await self.architect.plan_chapter(chapter)
            outcome.changed.append(f"第 {chapter} 章章纲")
            _collect(outcome, res.commit)
            outcome.cost = round(self.meter.used - cost_before, 4)
            return outcome
        return None


def _collect(outcome: PlanOutcome, commit) -> None:
    if commit is None:
        return
    outcome.issues.extend(i.model_dump() for i in commit.issues)
    outcome.pending.extend(p.model_dump() for p in commit.pending)
