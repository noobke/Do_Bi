"""调用计量与成本统计（规划文档 §6.5 第 3、4 道闸门）。

**单一数据来源**：`usage.jsonl` 是权威流水，`meta.json` 的 `budget_used` 只是缓存。
这样即使有人手改了 meta，重算一次就能对齐——不会出现「两个口径互相矛盾」。

预算熔断：
- 用度 ≥ 80% → 返回 `warning`，前端提示
- 用度 ≥ 100% → 抛 `BudgetExceeded`，**挂起 checkpoint 而不是静默继续烧钱**
- `budget_total = 0` 视为不限制
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from ..errors import BudgetExceeded
from .schema import UsageEntry, now_iso
from .store import ProjectStore

__all__ = ["Meter", "estimate_tokens"]

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_LATIN_RE = re.compile(r"[A-Za-z0-9']+")
_PUNCT_RE = re.compile(r"[\s，。！？、；：,.!?;:\"'（）()【】\[\]—…·]+")

# 中文 ≈ 1.6 字 / token；拉丁词 ≈ 1.3 token / 词。这是**估算**，
# 真实计量以厂商返回的 usage 为准；仅在本地预算预检时使用。
_CJK_PER_TOKEN = 1.6
_LATIN_TOKENS_PER_WORD = 1.3

WARN_RATIO = 0.8


def estimate_tokens(text: str) -> int:
    """本地 token 估算。用于上下文预算预检，不用于记账。

    中文按 1.6 字/token；拉丁文本同时看「词数」与「字符数」取大者 ——
    否则一段没有空格的长串（模型有时会吐出这种）会被严重低估。
    """
    if not text:
        return 0
    cjk = len(_CJK_RE.findall(text))
    words = _LATIN_RE.findall(text)
    latin_chars = sum(len(w) for w in words)
    latin = max(len(words) * _LATIN_TOKENS_PER_WORD, latin_chars / 4.0)
    punct = len(_PUNCT_RE.findall(text))
    return int(cjk / _CJK_PER_TOKEN + latin + punct * 0.5) + 1


class Meter:
    """绑定到一个项目的计量器。"""

    def __init__(self, store: ProjectStore) -> None:
        self.store = store

    # ---------------- 写入 ----------------

    def make_callback(self, *, chapter: int, step: str, role: str = "") -> Callable[[dict[str, Any]], None]:
        """给 `LLMClient(on_usage=...)` 用。回调只在内存里累加，由调用方决定何时 flush。"""

        def _cb(entry: dict[str, Any]) -> None:
            tokens = entry.get("tokens") or {}
            self.record(UsageEntry(
                chapter=chapter,
                step=step,
                role=role or str(entry.get("role") or ""),
                provider=str(entry.get("provider") or ""),
                model=str(entry.get("model") or ""),
                prompt_tokens=int(tokens.get("prompt_tokens") or 0),
                completion_tokens=int(tokens.get("completion_tokens") or 0),
                total_tokens=int(tokens.get("total_tokens") or 0),
                cost=float(entry.get("cost") or 0.0),
                latency_ms=int(entry.get("latencyMs") or 0),
                attempts=int(entry.get("attempts") or 1),
                ts=str(entry.get("ts") or now_iso()),
            ))

        return _cb

    def record(self, entry: UsageEntry) -> None:
        path = self.store.usage_path
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry.model_dump(), ensure_ascii=False) + "\n")
        # 同步 meta 缓存
        try:
            meta = self.store.meta()
            meta.budget_used = round(self.used, 4)
            meta.words = sum(c["words"] for c in self.store.chapters_overview())
            self.store.save_meta(meta)
        except Exception:
            pass

    # ---------------- 读取 ----------------

    def entries(self) -> list[UsageEntry]:
        rows: list[UsageEntry] = []
        for raw in self.store.read_jsonl(self.store.usage_path):
            try:
                rows.append(UsageEntry.model_validate(raw))
            except Exception:
                continue
        return rows

    @property
    def used(self) -> float:
        return round(sum(e.cost for e in self.entries()), 4)

    @property
    def total_tokens(self) -> int:
        return sum(e.total_tokens or (e.prompt_tokens + e.completion_tokens) for e in self.entries())

    def by_chapter(self) -> list[dict[str, Any]]:
        agg: dict[int, dict[str, Any]] = {}
        for e in self.entries():
            row = agg.setdefault(e.chapter, {
                "chapter": e.chapter, "promptTokens": 0, "completionTokens": 0,
                "totalTokens": 0, "cost": 0.0, "calls": 0, "steps": [],
            })
            row["promptTokens"] += e.prompt_tokens
            row["completionTokens"] += e.completion_tokens
            row["totalTokens"] += e.total_tokens or (e.prompt_tokens + e.completion_tokens)
            row["cost"] = round(row["cost"] + e.cost, 4)
            row["calls"] += 1
            if e.step and e.step not in row["steps"]:
                row["steps"].append(e.step)
        return [agg[k] for k in sorted(agg)]

    def by_step(self) -> list[dict[str, Any]]:
        agg: dict[str, dict[str, Any]] = {}
        for e in self.entries():
            row = agg.setdefault(e.step or "未标注", {
                "step": e.step or "未标注", "calls": 0, "tokens": 0, "cost": 0.0,
            })
            row["calls"] += 1
            row["tokens"] += e.total_tokens or (e.prompt_tokens + e.completion_tokens)
            row["cost"] = round(row["cost"] + e.cost, 4)
        return sorted(agg.values(), key=lambda r: -r["cost"])

    def by_day(self) -> list[dict[str, Any]]:
        agg: dict[str, dict[str, Any]] = {}
        for e in self.entries():
            day = (e.ts or "")[:10] or date.today().isoformat()
            row = agg.setdefault(day, {"day": day, "calls": 0, "tokens": 0, "cost": 0.0})
            row["calls"] += 1
            row["tokens"] += e.total_tokens or (e.prompt_tokens + e.completion_tokens)
            row["cost"] = round(row["cost"] + e.cost, 4)
        return [agg[k] for k in sorted(agg)]

    def totals(self) -> dict[str, Any]:
        entries = self.entries()
        return {
            "calls": len(entries),
            "tokens": self.total_tokens,
            "cost": self.used,
            "unpriced": sum(1 for e in entries if e.cost == 0 and (e.total_tokens or 0) > 0),
        }

    def budget(self) -> dict[str, Any]:
        meta = self.store.meta()
        used = self.used
        total = meta.budget_total
        ratio = (used / total) if total > 0 else 0.0
        return {
            "used": used,
            "total": round(total, 2),
            "remaining": round(max(0.0, total - used), 2),
            "ratio": round(ratio, 4),
            "unit": meta.cost_unit,
            "unlimited": total <= 0,
            "level": ("exceeded" if total > 0 and used >= total
                      else "warning" if total > 0 and ratio >= WARN_RATIO else "ok"),
            "tokens": self.total_tokens,
        }

    # ---------------- 闸门 4：预算熔断 ----------------

    def check_budget(self, *, estimated_next: float = 0.0) -> None:
        """调用模型**之前**预检。超额直接抛错，由上层挂起 checkpoint。"""
        meta = self.store.meta()
        if meta.budget_total <= 0:
            return
        used = self.used
        if used + max(0.0, estimated_next) >= meta.budget_total:
            raise BudgetExceeded(
                f"本书预算已用尽（{meta.cost_unit}{used:.2f} / "
                f"{meta.cost_unit}{meta.budget_total:.2f}）。"
                "已挂起当前进度，调高预算或切换更便宜的模型后可继续。",
                detail={"used": used, "total": meta.budget_total},
            )

    def warning(self) -> str | None:
        b = self.budget()
        if b["level"] in ("warning", "exceeded") and not b["unlimited"]:
            return (f"本书预算已用 {b['unit']}{b['used']:.2f} / "
                    f"{b['unit']}{b['total']:.2f}，接近上限。")
        return None

    def reconcile(self) -> float:
        """按流水重算 meta.budget_used，消除手工改动造成的口径漂移。"""
        used = self.used
        try:
            meta = self.store.meta()
            if abs(meta.budget_used - used) > 1e-6:
                meta.budget_used = used
                self.store.save_meta(meta)
        except Exception:
            pass
        return used

    def public(self, *, recent: int = 20) -> dict[str, Any]:
        entries = self.entries()
        return {
            "totals": self.totals(),
            "budget": self.budget(),
            "byChapter": self.by_chapter(),
            "byStep": self.by_step(),
            "byDay": self.by_day(),
            "recent": [e.model_dump() for e in entries[-recent:]][::-1],
        }
