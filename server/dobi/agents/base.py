"""Agent 公共基类。

三件事：**计量归集**、**checkpoint 打点**、**提案提交**。子类只管业务逻辑。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..core.checkpoint import CheckpointManager
from ..core.metering import Meter
from ..core.schema import Proposal
from ..core.store import CommitResult, ProjectStore, TruthWriter
from ..llm.provider import ChatResult, LLMClient

__all__ = ["Agent", "Usage", "ROLE_TO_STEP"]

#: 模型角色 → 流水线 step。计量回调靠这张表把账目归到正确的环节。
ROLE_TO_STEP: dict[str, str] = {
    "architect": "plan",
    "chapter_plan": "plan",
    "chat": "plan",
    "writer": "draft",
    "audit_l2": "audit",
    "review": "review",
    "deai": "deai",
    "steer": "steer",
    "archivist": "commit",
    "style_analyze": "style",
    "disassemble": "disassemble",
}


@dataclass
class Usage:
    """一次业务动作累计消耗，便于回传前端显示「本章花了多少」。"""

    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost: float = 0.0
    latency_ms: int = 0
    models: list[str] = field(default_factory=list)
    adapted: list[str] = field(default_factory=list)

    def add(self, result: ChatResult | None) -> None:
        if result is None:
            return
        self.calls += 1
        self.prompt_tokens += result.usage.prompt_tokens
        self.completion_tokens += result.usage.completion_tokens
        self.cost += result.cost
        self.latency_ms += result.latency_ms
        label = f"{result.provider}/{result.model}"
        if label not in self.models:
            self.models.append(label)
        for note in result.adaptations:
            if note not in self.adapted:
                self.adapted.append(note)

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def public(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "tokens": {
                "prompt_tokens": self.prompt_tokens,
                "completion_tokens": self.completion_tokens,
                "total_tokens": self.total_tokens,
            },
            "cost": round(self.cost, 4),
            "latencyMs": self.latency_ms,
            "models": self.models,
            "adaptations": self.adapted,
        }


class Agent:
    def __init__(self, store: ProjectStore, client: LLMClient,
                 meter: Meter | None = None) -> None:
        self.store = store
        self.client = client
        self.meter = meter or Meter(store)
        self.cp = CheckpointManager(store)
        self.usage = Usage()

    # ---------------- 便捷方法 ----------------

    def scope(self, chapter: int, step: str) -> None:
        """告诉计量层「现在在哪个环节」，账目才能归对位置。"""
        self.client.scope = {"chapter": chapter, "step": step}

    def commit(self, proposals: list[Proposal], *, force: bool = False) -> CommitResult:
        return TruthWriter(self.store).commit(proposals, force=force)

    def budget_gate(self, *, estimated: float = 0.0) -> None:
        """模型调用前的预算预检。超额抛 `BudgetExceeded`，由上层挂起。"""
        self.meter.check_budget(estimated_next=estimated)
