"""故事时间推导（确定性，无模型调用）。

「剧情树」与「章节页双轨时间线」都需要**故事时间**这个维度，但故事时间是自由文本
（「二十年前」「三日前」「当夜」）。这里做两件确定性的事：

1. `story_time_key()` —— 把自由文本映射成可排序的键。
   规则明确、可解释：**回溯类事件排在前面**（`N年前` → 负年数），
   同年代内部按**首次出现章号**排序（叙述顺序）。这是启发式，不是语义解析。
2. `book_anchors()` —— 汇总全书时间锚点，每条记录它被哪些章叙述。
   这就是数据契约里「数组顺序即故事时间顺序」的来源。

匹配规则与设计契约逐字一致（批次七）：
对本章每个事件，在锚点中取第一个满足「`e.label` 与 `ev.label` 双向包含」的锚点；
匹配不到就不画连线。
"""

from __future__ import annotations

import re
from typing import Any, Sequence

from .store import ProjectStore

__all__ = ["story_time_key", "book_anchors", "chapter_events", "match_anchor",
           "KIND_LABELS", "story_kind"]

KIND_LABELS: dict[str, str] = {
    "backstory": "前史",
    "flashback": "闪回",
    "now": "顺叙",
    "future": "预叙",
    "planned": "未写入",
}

_KINDS = set(KIND_LABELS)

_CN_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
              "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def _cn_number(token: str) -> int | None:
    if token.isdigit():
        return int(token)
    total, section, current = 0, 0, 0
    for ch in token:
        if ch in _CN_DIGITS:
            current = _CN_DIGITS[ch]
        elif ch == "十":
            section += (current or 1) * 10
            current = 0
        elif ch == "百":
            section += (current or 1) * 100
            current = 0
        elif ch == "千":
            section += (current or 1) * 1000
            current = 0
        else:
            return None
    return total + section + current if (total or section or current) else None


_YEARS_AGO = re.compile(r"([0-9一二三四五六七八九十百千两零〇]+)\s*年前")
_DAYS_AGO = re.compile(r"([0-9一二三四五六七八九十百千两零〇]+)\s*(?:日|天)前")
_HOURS = re.compile(r"(当夜|今夜|当晚|次夜|次日|第二天|翌日|黎明|清晨|上午|正午|午后|黄昏|傍晚|入夜|夜|子时|后半夜)")


def story_time_key(story_at: str, chapter: int) -> tuple[float, int]:
    """排序键 `(时间刻度, 首次出现章号)`。数值越小越靠前（越早）。"""
    text = (story_at or "").strip()
    if not text:
        return (0.0, chapter)

    if m := _YEARS_AGO.search(text):
        if (n := _cn_number(m.group(1))) is not None:
            return (float(-n * 365), chapter)
    if m := _DAYS_AGO.search(text):
        if (n := _cn_number(m.group(1))) is not None:
            return (float(-n), chapter)
    if "第二卷" in text or "第三卷" in text:
        if (n := _cn_number(text.replace("第", "").replace("卷", ""))) is not None:
            return (float(n * 365), chapter)
    if _HOURS.search(text):
        # 顺叙内部：同一天内的先后关系按叙述顺序排，不做小时级语义解析
        return (0.0, chapter)
    return (0.0, chapter)


def story_kind(story_at: str, default: str = "now") -> str:
    text = story_at or ""
    if re.search(r"\d+\s*年前|年前|前史|战前", text):
        return "backstory"
    if story_at and _HOURS.search(text) and _DAYS_AGO.search(text):
        return "flashback"
    if re.search(r"翌日|次日|第二天|十日后|三日后|将|预", text) and "前" not in text:
        return "future"
    return default if default in _KINDS else "now"


def chapter_events(store: ProjectStore, chapter: int) -> list[dict[str, str]]:
    """本章事件序列。优先用章纲里的 `timeline`；没有就从节拍派生，标注为派生。"""
    node = store.outline_graph().node(chapter)
    if node is None:
        return []
    events: list[dict[str, str]] = []
    for raw in node.timeline:
        if not isinstance(raw, dict):
            continue
        label = str(raw.get("label") or "").strip()
        if not label:
            continue
        kind = str(raw.get("kind") or "").strip()
        events.append({
            "at": str(raw.get("at") or node.story_at or "").strip(),
            "label": label,
            "kind": kind if kind in _KINDS else story_kind(node.story_at),
        })
    if events:
        return events

    # 兜底：节拍当事件，整章共用一个故事时间
    kind = story_kind(node.story_at)
    return [{"at": node.story_at, "label": b, "kind": kind, "derived": "true"}
            for b in node.beats if b.strip()]


def book_anchors(store: ProjectStore) -> list[dict[str, Any]]:
    """全书时间锚点，**数组顺序即故事时间顺序**（设计契约的硬约定）。"""
    graph = store.outline_graph()
    buckets: dict[str, dict[str, Any]] = {}
    for node in sorted(graph.nodes, key=lambda n: n.chapter):
        for event in chapter_events(store, node.chapter):
            label = event["label"]
            key = event["at"] or label
            bucket = buckets.get(key)
            if bucket is None:
                bucket = {
                    "id": f"bt_{len(buckets) + 1}",
                    "storyAt": event["at"] or "（未标注）",
                    "label": label,
                    "kind": event["kind"],
                    "chapters": [],
                    "note": "",
                }
                buckets[key] = bucket
            if node.chapter not in bucket["chapters"]:
                bucket["chapters"].append(node.chapter)
            if not bucket["note"] and node.rationale:
                bucket["note"] = node.rationale[:60]
    anchors = list(buckets.values())
    anchors.sort(key=lambda a: story_time_key(a["storyAt"], min(a["chapters"] or [0])))
    for anchor in anchors:
        anchor["chapters"].sort()
    return anchors


def match_anchor(event_label: str, anchors: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    """双向包含匹配（设计契约批次七的规定）。"""
    label = (event_label or "").strip()
    if not label:
        return None
    for anchor in anchors:
        other = str(anchor.get("label") or "").strip()
        if not other:
            continue
        if label in other or other in label:
            return anchor
    return None
