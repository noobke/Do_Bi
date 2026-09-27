"""干预策略层（规划文档 §9）。

**「人机协同」与「全自动」统一的关键**：两者是同一条流水线上「干预策略」的不同取值。

- 每 step 取值 `auto` / `confirm` / `manual`
- 运行中可随时切换：全自动跑到一半想接管，切 `confirm` 即在下个确认点停下
- `stop_conditions` 是**全自动模式的安全阀**：不失控烧钱、不产出崩溃内容
- **实时干预独立于 mode**：任何模式下都可注入，但影响已定稿章时强制转人工确认
"""

from __future__ import annotations

from typing import Any, Sequence

from ..core.schema import (
    PIPELINE_STEPS,
    STEP_LABELS,
    STOP_CONDITION_LABELS,
    AuditReport,
    IntervMode,
    StepPolicies,
)
from ..core.store import ProjectStore

__all__ = ["ModeController", "MODE_LABELS"]

MODE_LABELS: dict[str, str] = {
    "auto": "全自动",
    "semi-auto": "半自动",
    "manual": "手动逐步",
}

MODE_HINTS: dict[str, str] = {
    "auto": "全部环节自动执行，仅在阻塞时暂停",
    "semi-auto": "章纲与审查报告需人工确认",
    "manual": "每个环节都停下等待确认",
}

#: 切模式时各 step 被赋予的策略
MODE_PRESETS: dict[str, dict[str, str]] = {
    "auto": {s: "auto" for s in PIPELINE_STEPS},
    "semi-auto": {**{s: "auto" for s in PIPELINE_STEPS},
                  "plan": "confirm", "audit": "confirm", "commit": "confirm"},
    "manual": {s: "manual" for s in PIPELINE_STEPS},
}


class ModeController:
    def __init__(self, store: ProjectStore) -> None:
        self.store = store

    # ---------------- 读写 ----------------

    @property
    def mode(self) -> str:
        return self.store.meta().mode

    @property
    def policies(self) -> StepPolicies:
        return self.store.meta().steps

    def set_mode(self, mode: str) -> str:
        if mode not in MODE_PRESETS:
            raise ValueError(f"未知模式：{mode}")
        meta = self.store.meta()
        meta.mode = mode  # type: ignore[assignment]
        meta.steps = StepPolicies(**MODE_PRESETS[mode])
        self.store.save_meta(meta)
        return mode

    def set_step(self, step: str, policy: str) -> str:
        if step not in PIPELINE_STEPS:
            raise ValueError(f"未知环节：{step}")
        if policy not in ("auto", "confirm", "manual"):
            raise ValueError(f"未知策略：{policy}")
        meta = self.store.meta()
        setattr(meta.steps, step, policy)
        # 手工改过环节策略后，模式标记为「自定义」——避免界面显示与实际不符
        preset = MODE_PRESETS.get(meta.mode, {})
        if any(preset.get(s) != getattr(meta.steps, s) for s in PIPELINE_STEPS):
            meta.mode = "manual" if all(getattr(meta.steps, s) == "manual" for s in PIPELINE_STEPS) else "semi-auto"
        self.store.save_meta(meta)
        return policy

    def policy_for(self, step: str) -> str:
        return self.policies.get(step)

    def needs_confirmation(self, step: str) -> bool:
        """`confirm` 与 `manual` 都需要人工点头；区别在 `manual` 会连 `auto` 环节也停。"""
        return self.policy_for(step) in ("confirm", "manual")

    def set_stop_conditions(self, conditions: Sequence[str]) -> list[str]:
        meta = self.store.meta()
        meta.stop_conditions = [c for c in conditions if c in STOP_CONDITION_LABELS]
        self.store.save_meta(meta)
        return meta.stop_conditions

    # ---------------- 熔断判定 ----------------

    def check_stop(
        self,
        *,
        chapter: int,
        audit: AuditReport | None = None,
        fail_streak: int = 0,
        budget_exceeded: bool = False,
        steer_affects_committed: bool = False,
    ) -> str | None:
        """返回命中的熔断条件 key，未命中返回 None。"""
        active = set(self.store.meta().stop_conditions)

        if "budget.exceeded" in active and budget_exceeded:
            return "budget.exceeded"
        if "audit.blocker_exists" in active and audit is not None:
            blockers = [i for i in audit.items
                        if i.severity == "blocker" and not i.fixed and i.decision != "ignore"]
            if blockers:
                return "audit.blocker_exists"
        if "audit.fail_streak" in active and fail_streak >= 3:
            return "audit.fail_streak"
        if "steer.affects_committed" in active and steer_affects_committed:
            return "steer.affects_committed"
        return None

    @staticmethod
    def stop_reason(key: str) -> str:
        base = STOP_CONDITION_LABELS.get(key, key)
        extra = {
            "budget.exceeded": "已挂起当前进度，调高预算或换更便宜的模型后可继续。",
            "audit.blocker_exists": "请先处理阻塞定稿的问题，或把该问题标记为忽略。",
            "audit.fail_streak": "连续多章未通过审查，建议人工看一遍再继续。",
            "steer.affects_committed": "干预波及已定稿章节，需要你确认后才改动历史。",
        }.get(key, "")
        return f"{base}。{extra}".strip()

    # ---------------- 视图 ----------------

    def public(self) -> dict[str, Any]:
        meta = self.store.meta()
        return {
            "mode": meta.mode,
            "modeLabel": MODE_LABELS.get(meta.mode, meta.mode),
            "modeHint": MODE_HINTS.get(meta.mode, ""),
            "modes": [{"value": k, "label": MODE_LABELS[k], "hint": MODE_HINTS[k]}
                      for k in ("auto", "semi-auto", "manual")],
            "steps": [{
                "key": s, "label": STEP_LABELS[s],
                "policy": self.policy_for(s),
                "needsConfirmation": self.needs_confirmation(s),
            } for s in PIPELINE_STEPS],
            "stopConditions": [{
                "key": c, "label": STOP_CONDITION_LABELS[c],
                "active": c in meta.stop_conditions,
            } for c in STOP_CONDITION_LABELS],
        }
