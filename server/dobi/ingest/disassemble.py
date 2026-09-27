"""拆书：导入已有小说 → 反推结构 → 产出**提案**（规划文档 §3.2 ⑫）。

**不直接写真相文件**。六个阶段（切分章节 / 抽取角色与关系 / 抽取世界观规则 /
抽取伏笔与回收 / 生成文风档案 / 生成写入提案）跑完后，得到一批 `Proposal`，
逐个过 `TruthWriter.validate()`，有 error 的降级为待人工确认；**这一步不 commit**，
只把完整结果落盘到 `state/disassemble.json`。等前端调用 `decide()` 逐条确认，
`accept` 才真正经 `TruthWriter.commit()` 写入真相文件（校验不通过则拒绝写入，绝不绕过）。

阶段 1「切分章节」是**确定性**的，不调模型；其余阶段各调用一次模型（文风走
`consistency.style.analyze_style`，复用统一的文风分析实现）。

字段形状以 `prototype/do-bi/assets/mock.js` 的 `disassemble` 为准：
`source` / `stages` / `stats` / `extracted` / `proposals`。
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..agents.base import Agent, Usage
from ..consistency.style import analyze_style
from ..core.schema import (
    Character,
    Hook,
    Proposal,
    Relation,
    StyleProfile,
    WorldRule,
    now_iso,
)
from ..core.store import TruthWriter, count_words

__all__ = [
    "DisassembleSource",
    "DisassembleResult",
    "Disassembler",
    "split_chapters",
    "load",
    "STAGE_TITLES",
    "STATE_FILENAME",
]


STATE_FILENAME = "disassemble.json"

#: 六个阶段（key / 中文标题），顺序即执行顺序
STAGE_TITLES: tuple[tuple[str, str], ...] = (
    ("split", "切分章节"),
    ("roles", "抽取角色与关系"),
    ("world", "抽取世界观规则"),
    ("hooks", "抽取伏笔与回收"),
    ("style", "生成文风档案"),
    ("merge", "生成写入提案"),
)

#: 内部提案类型 → 给 UI 看的中文分类（与 mock.js 的 proposals[].kind 对齐）
KIND_LABELS: dict[str, str] = {
    "character_add": "角色",
    "world_add": "世界观",
    "hook_add": "伏笔",
    "style_update": "文风",
}

#: 超过这个字数就抽样，避免一次把整本塞进模型
SAMPLE_THRESHOLD_WORDS = 60_000


# ==========================================================================
# 阶段 1：确定性切分章节
# ==========================================================================

#: 中文数字（含常见异体）
_CN_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
              "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_CN_UNITS = {"十": 10, "百": 100, "千": 1000, "万": 10000}

#: 标题行候选：`第N章/回/节/卷`（N 为阿拉伯或中文数字），可带标题
_RE_ZH_CHAPTER = re.compile(
    r"^第\s*([0-9]+|[〇零一二两三四五六七八九十百千万]+)\s*([章回节卷])\s*(.*)$")
#: `Chapter 12 ...`
_RE_EN_CHAPTER = re.compile(r"^chapter\s+([0-9]+)\b\s*(.*)$", re.IGNORECASE)
#: 行首 `12. 标题` / `12、标题`
_RE_NUM_DOT = re.compile(r"^([0-9]+)\s*[\.、,，]\s*(.*)$")
#: 行首 `十二、标题`
_RE_CN_DOT = re.compile(r"^([〇零一二两三四五六七八九十百]+)\s*[、.．]\s*(.*)$")

#: 标题行长度上限——超过则更像正文段落，不作为标题（防误判）
_MAX_TITLE_LEN = 40


def _cn_to_int(token: str) -> int | None:
    """中文数字 / 阿拉伯数字 → int。识别失败返回 None。"""
    token = (token or "").strip()
    if not token:
        return None
    if token.isdigit():
        return int(token)
    total = 0
    section = 0
    number = 0
    found = False
    for ch in token:
        if ch in _CN_DIGITS:
            number = _CN_DIGITS[ch]
            found = True
        elif ch in _CN_UNITS:
            unit = _CN_UNITS[ch]
            found = True
            if unit == 10000:
                section = (section + number) * unit
                total += section
                section = 0
            else:
                if number == 0:
                    number = 1
                section += number * unit
            number = 0
        else:
            return None
    if not found:
        return None
    return total + section + number


def _match_heading(line: str) -> tuple[int | None, str] | None:
    """判断一行是否是章节标题。命中返回 (章号候选, 标题文本)，否则 None。"""
    s = (line or "").strip()
    if not s or len(s) > _MAX_TITLE_LEN:
        return None
    if m := _RE_ZH_CHAPTER.match(s):
        title = m.group(3).strip()
        return _cn_to_int(m.group(1)), (title or s)
    if m := _RE_EN_CHAPTER.match(s):
        title = m.group(2).strip()
        return _cn_to_int(m.group(1)), (title or s)
    if m := _RE_NUM_DOT.match(s):
        title = m.group(2).strip()
        # 纯编号（如页码「12.」）不算标题，必须带标题文字
        if title:
            return _cn_to_int(m.group(1)), title
    if m := _RE_CN_DOT.match(s):
        title = m.group(2).strip()
        if title:
            return _cn_to_int(m.group(1)), title
    return None


def _fallback_chapters(text: str, target: int = 3000) -> list[dict[str, Any]]:
    """识别不到标题时的兜底：按空行块切分，再按固定长度归并成章。"""
    blocks = [p.strip() for p in re.split(r"\n\s*\n+", text or "") if p.strip()]
    if not blocks:
        blocks = [text.strip()] if (text or "").strip() else []
    units: list[str] = []
    for b in blocks:
        if len(b) <= target:
            units.append(b)
        else:
            for i in range(0, len(b), target):
                units.append(b[i:i + target])
    chapters: list[list[str]] = []
    buf: list[str] = []
    size = 0
    for u in units:
        buf.append(u)
        size += len(u)
        if size >= target:
            chapters.append(buf)
            buf = []
            size = 0
    if buf:
        chapters.append(buf)
    return [{"n": i + 1, "title": f"第 {i + 1} 段", "text": "\n\n".join(c)}
            for i, c in enumerate(chapters)]


def split_chapters(text: str) -> list[dict[str, Any]]:
    """**确定性**切分章节（不调模型）。返回 `[{n, title, text}]`。

    覆盖的标题形式：
    - `第N章 / 第N回 / 第N节 / 第N卷`（N 为阿拉伯数字或中文数字）
    - `Chapter N ...`
    - 行首 `12. 标题` / `12、标题`
    - 行首 `十二、标题`
    识别不到标题时，按空行块 + 固定长度兜底切分。
    """
    lines = (text or "").splitlines()
    marks: list[tuple[int, int | None, str]] = []
    for i, raw in enumerate(lines):
        hit = _match_heading(raw)
        if hit is not None:
            marks.append((i, hit[0], hit[1]))

    if not marks:
        return _fallback_chapters(text)

    out: list[dict[str, Any]] = []
    for j, (idx, num, title) in enumerate(marks):
        start = idx + 1
        end = marks[j + 1][0] if j + 1 < len(marks) else len(lines)
        body = "\n".join(lines[start:end]).strip()
        out.append({"n": num, "title": title, "text": body})

    # 章号规整：用解析到的章号；缺失或非递增时回退为「上一章 + 1」，保证连续唯一
    prev = 0
    for ch in out:
        cand = ch["n"]
        if not isinstance(cand, int) or cand <= prev:
            cand = prev + 1
        ch["n"] = cand
        prev = cand
    return out


# ==========================================================================
# 提示词（放在本模块，不改 agents/prompts.py）
# ==========================================================================

ROLES_PROMPT = """你是一位小说结构分析师。任务：从下面这部**已有小说**的样本中，反向抽取**角色与人物关系**。

【作品】{source}
【样本说明】{sample_note}

【样本正文】
{sample}

【要求】
1. 只抽取**具名**角色（有名字、或反复被指称的实体），宁精不滥。
2. `traits` 必须是**可判定的特征**——身体特征、惯用习惯、禁忌
   （如「左手使刀」「不饮酒」「左眉骨有旧疤」）。
   **禁止**写「性格坚毅」「为人正直」这类无法检验的评价。
3. `relations` 写该角色与其他角色的关系：`target` 填**姓名**，
   `type` 写关系类型，`note` 写一句来自样本的依据。
4. `merges` 用于归并**同一人的不同称呼**（简称、绰号、尊称）：
   `canonical` 写正式名，`aliases` 写其余称呼。
5. 只抽取样本中**真实出现**的信息，不要脑补。

【输出格式】只输出 JSON，不要解释、不要 Markdown 围栏：
{{"characters": [{{"name": "姓名", "role": "主角/女主/配角/反派等", "traits": ["可判定特征"],
  "relations": [{{"target": "另一角色姓名", "type": "关系类型", "note": "依据"}}]}}],
 "merges": [{{"canonical": "正式名", "aliases": ["别称1", "别称2"]}}]}}"""


WORLD_PROMPT = """你是一位小说设定师。任务：从下面这部**已有小说**的样本中，反向抽取**世界观规则**。

【作品】{source}
【样本说明】{sample_note}

【样本正文】
{sample}

【要求】
1. 只抽取样本中**能被检验**的规则（违反了能在后文被发现），不要写抽象氛围。
2. `kind` 只能取 `hard`（不可违反的硬约束）或 `soft`（可被正文反推改写的软设定）。
3. `category` 建议取值：器物 / 体系 / 地理 / 组织 / 历史 / 风俗。
4. 每条给一句 `note` 注明依据（来自样本的哪处）。

【输出格式】只输出 JSON，不要解释、不要围栏：
{{"rules": [{{"category": "", "kind": "hard", "rule": "规则正文", "note": "依据"}}]}}"""


HOOKS_PROMPT = """你是一位小说结构分析师。任务：从下面这部**已有小说**的样本中，反向抽取**伏笔（埋设）与回收点**。

【作品】{source}
【章号对照】样本涉及的真实章号：{chapter_index}
【样本说明】{sample_note}

【样本正文】
{sample}

【要求】
1. `content` 写伏笔内容——刻意的、有回收价值的线索。
2. `planted_chapter` / `resolved_chapter` 必须填**真实章号**（对照上面的章号）。
   后续找不到回收点的，`resolved_chapter` 填 `null`。
3. `importance` 取 `major` / `minor`。
4. `evidence` 引一句样本中的**原文**作为依据。

【输出格式】只输出 JSON，不要解释、不要围栏：
{{"hooks": [{{"content": "", "planted_chapter": 1, "resolved_chapter": null,
  "importance": "major", "evidence": "原文引用"}}]}}"""


# ==========================================================================
# 数据容器
# ==========================================================================

@dataclass
class DisassembleSource:
    name: str
    chapters: int
    words: int
    format: str
    size: str

    def public(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DisassembleResult:
    source: DisassembleSource
    stages: list[dict[str, Any]]
    stats: dict[str, Any]
    extracted: dict[str, Any]
    proposals: list[dict[str, Any]]
    usage: Usage
    #: 完整文风档案（供构造 style_update 提案与调试；`extracted["style"]` 只放可读字符串）
    style_profile: StyleProfile | None = None

    def public(self) -> dict[str, Any]:
        return {
            "source": self.source.public(),
            "stages": self.stages,
            "stats": self.stats,
            "extracted": self.extracted,
            "proposals": self.proposals,
            "usage": self.usage.public(),
        }


# ==========================================================================
# 工具
# ==========================================================================

def _human_size(nbytes: int) -> str:
    if nbytes < 1024:
        return f"{nbytes} B"
    if nbytes < 1024 * 1024:
        return f"{nbytes / 1024:.0f} KB"
    return f"{nbytes / (1024 * 1024):.1f} MB"


def _state_path(store) -> Path:
    return store.state_dir / STATE_FILENAME


def load(store) -> dict[str, Any] | None:
    """读取上次的拆书结果（含 source/stages/stats/extracted/proposals/decisions）。"""
    return store.read_json(_state_path(store), None)


def _save_state(store, state: dict[str, Any]) -> None:
    store.write_json(_state_path(store), state)


def _sample_text(chapters: list[dict[str, Any]], ratio: float
                 ) -> tuple[str, bool, list[dict[str, Any]]]:
    """按字数决定是否抽样。返回 (样本正文, 是否抽样, 被抽中的章节)。"""
    full_words = count_words("\n".join(ch["text"] for ch in chapters))
    if full_words <= SAMPLE_THRESHOLD_WORDS:
        text = "\n\n".join(f"第{ch['n']}章 {ch['title']}\n{ch['text']}" for ch in chapters)
        return text, False, chapters

    k = max(1, round(2 * max(0.1, ratio)))
    n = len(chapters)
    if n <= k * 3:
        picked = list(chapters)
    else:
        head = chapters[:k]
        mid_start = max(0, n // 2 - k // 2)
        mid = chapters[mid_start:mid_start + k]
        tail = chapters[-k:]
        seen: set[int] = set()
        picked = []
        for ch in head + mid + tail:
            if ch["n"] not in seen:
                seen.add(ch["n"])
                picked.append(ch)
    text = "\n\n".join(f"第{ch['n']}章 {ch['title']}\n{ch['text']}" for ch in picked)
    return text, True, picked


def _sample_note(sampled: bool, picked: list[dict[str, Any]]) -> str:
    if not sampled:
        return "全书正文（未抽样）。"
    return (f"正文超过 6 万字，此处按「前 2 章 + 中间 2 章 + 最后 2 章」抽样，"
            f"共 {len(picked)} 章作为样本。据此推断时请注意覆盖面有限。")


def _merge_characters(raw_chars: Any, merges: Any) -> list[dict[str, Any]]:
    """归并同人异名，得到内部角色列表。"""
    alias_map: dict[str, str] = {}
    for m in (merges or []):
        if not isinstance(m, dict):
            continue
        canonical = str(m.get("canonical") or "").strip()
        if not canonical:
            continue
        for a in (m.get("aliases") or []):
            alias = str(a).strip()
            if alias and alias != canonical:
                alias_map[alias] = canonical

    by_name: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for raw in (raw_chars or []):
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if not name:
            continue
        canonical = alias_map.get(name, name)
        rels: list[dict[str, str]] = []
        for rel in (raw.get("relations") or []):
            if not isinstance(rel, dict):
                continue
            target = str(rel.get("target") or "").strip()
            if not target:
                continue
            rels.append({"target": alias_map.get(target, target),
                         "type": str(rel.get("type") or "关联"),
                         "note": str(rel.get("note") or "")})
        traits = [str(t).strip() for t in (raw.get("traits") or []) if str(t).strip()]
        aliases = sorted({name} | {a for a, c in alias_map.items() if c == canonical})
        if canonical not in by_name:
            by_name[canonical] = {
                "name": canonical,
                "role": str(raw.get("role") or "配角"),
                "traits": traits,
                "relations": rels,
                "aliases": [a for a in aliases if a != canonical],
            }
            order.append(canonical)
        else:
            item = by_name[canonical]
            for t in traits:
                if t not in item["traits"]:
                    item["traits"].append(t)
            item["relations"].extend(rels)
            if item["role"] in ("", "配角"):
                item["role"] = str(raw.get("role") or item["role"])
    return [by_name[n] for n in order]


class Disassembler(Agent):
    """拆书 Agent。一次 `run()` 跑完六个阶段并落盘提案，`decide()` 逐条确认写入。"""

    # ---------------- 阶段执行 ----------------

    async def run(self, *, filename: str, text: str,
                  sample_ratio: float = 1.0) -> DisassembleResult:
        source_name = Path(filename).name or "未命名样本"
        fmt = (Path(filename).suffix.lstrip(".") or "txt").lower()
        raw_bytes = len((text or "").encode("utf-8"))
        self.scope(0, "disassemble")

        stages: list[dict[str, Any]] = [
            {"key": k, "title": t, "desc": "", "status": "todo"} for k, t in STAGE_TITLES
        ]

        # ---- 1. split（确定性）----
        stages[0]["status"] = "active"
        chapters = split_chapters(text or "")
        has_headings = any(
            _match_heading(line) is not None for line in (text or "").splitlines()
        )
        if has_headings:
            stages[0]["desc"] = f"按标题与空行推断章节边界，识别 {len(chapters)} 章"
        else:
            stages[0]["desc"] = f"未识别到章节标题，按空行与长度兜底切分为 {len(chapters)} 段"
        stages[0]["status"] = "done"

        full_text = "\n".join(ch["text"] for ch in chapters)
        words = count_words(full_text)
        sample, sampled, picked = _sample_text(chapters, sample_ratio)
        note = _sample_note(sampled, picked)

        # ---- 2. roles ----
        stages[1]["status"] = "active"
        self.budget_gate()
        roles_data, roles_result = await self.client.complete_json(
            "disassemble",
            [{"role": "user", "content": ROLES_PROMPT.format(
                source=source_name, sample_note=note, sample=sample)}],
        )
        self.usage.add(roles_result)
        raw_chars = roles_data.get("characters") if isinstance(roles_data, dict) else None
        merges = roles_data.get("merges") if isinstance(roles_data, dict) else None
        characters = _merge_characters(raw_chars, merges)
        stages[1]["desc"] = (f"识别 {len(characters)} 个具名实体，"
                             f"归并同人异名 {len(merges) if isinstance(merges, list) else 0} 组")
        stages[1]["status"] = "done"

        # ---- 3. world ----
        stages[2]["status"] = "active"
        self.budget_gate()
        world_data, world_result = await self.client.complete_json(
            "disassemble",
            [{"role": "user", "content": WORLD_PROMPT.format(
                source=source_name, sample_note=note, sample=sample)}],
        )
        self.usage.add(world_result)
        raw_rules = world_data.get("rules") if isinstance(world_data, dict) else None
        rules: list[dict[str, str]] = []
        for raw in (raw_rules or []):
            if not isinstance(raw, dict) or not str(raw.get("rule") or "").strip():
                continue
            rules.append({
                "category": str(raw.get("category") or "其他"),
                "kind": "soft" if str(raw.get("kind")) == "soft" else "hard",
                "rule": str(raw["rule"]).strip(),
                "note": str(raw.get("note") or ""),
            })
        stages[2]["desc"] = f"提取门派、地理、体系与硬约束 {len(rules)} 条"
        stages[2]["status"] = "done"

        # ---- 4. hooks ----
        stages[3]["status"] = "active"
        self.budget_gate()
        chapter_index = "、".join(f"第{p['n']}章《{p['title']}》" for p in picked[:12])
        hooks_data, hooks_result = await self.client.complete_json(
            "disassemble",
            [{"role": "user", "content": HOOKS_PROMPT.format(
                source=source_name, sample_note=note,
                chapter_index=chapter_index or "（无）", sample=sample)}],
        )
        self.usage.add(hooks_result)
        raw_hooks = hooks_data.get("hooks") if isinstance(hooks_data, dict) else None
        total_chapters = len(chapters)
        hooks: list[dict[str, Any]] = []
        for raw in (raw_hooks or []):
            if not isinstance(raw, dict) or not str(raw.get("content") or "").strip():
                continue
            planted = self._clamp_chapter(raw.get("planted_chapter"), total_chapters) or 1
            resolved = self._clamp_chapter(raw.get("resolved_chapter"), total_chapters)
            if resolved is not None and resolved <= planted:
                resolved = None
            hooks.append({
                "content": str(raw["content"]).strip(),
                "planted_chapter": planted,
                "resolved_chapter": resolved,
                "importance": "major" if str(raw.get("importance")) == "major" else "minor",
                "evidence": str(raw.get("evidence") or ""),
            })
        matched = sum(1 for h in hooks if h["resolved_chapter"])
        stages[3]["desc"] = f"识别 {len(hooks)} 处埋设点，匹配到 {matched} 处回收点"
        stages[3]["status"] = "done"

        # ---- 5. style ----
        stages[4]["status"] = "active"
        self.budget_gate()
        profile, style_tokens = await analyze_style(
            self.client, sample, source_label=f"拆书 · {source_name}")
        stages[4]["desc"] = "句长、视角、描写比例与禁用表达"
        stages[4]["status"] = "done"

        extracted_style = self._readable_style(profile)

        # ---- 6. merge（生成提案 + 校验，不 commit）----
        stages[5]["status"] = "active"
        proposals, detailed = self._build_proposals(characters, rules, hooks, profile)
        stages[5]["desc"] = f"生成 {len(proposals)} 条写入提案，待你确认后才写入真相文件"
        stages[5]["status"] = "done"

        extracted = {
            "characters": [
                {"name": c["name"], "role": c["role"], "traits": c["traits"],
                 # 与 mock.js 对齐：关系以「条数」呈现
                 "relations": len(c["relations"])}
                for c in characters
            ],
            "hooks": [
                {"content": h["content"], "plantedChapter": h["planted_chapter"],
                 "matched": h["resolved_chapter"], "importance": h["importance"]}
                for h in hooks
            ],
            "worldRules": [r["rule"] for r in rules],
            "style": extracted_style,
        }

        stats = {
            "chapters": len(chapters),
            "characters": len(characters),
            "worldRules": len(rules),
            "hooks": len(hooks),
            "hooksMatched": matched,
            # 文风分析只回传 token 数（不是 ChatResult），单独并入总用量
            "tokens": self.usage.total_tokens + int(style_tokens or 0),
        }

        source = DisassembleSource(
            name=source_name, chapters=len(chapters), words=words,
            format=fmt, size=_human_size(raw_bytes),
        )
        result = DisassembleResult(
            source=source, stages=stages, stats=stats, extracted=extracted,
            proposals=proposals, usage=self.usage, style_profile=profile,
        )

        state = {
            "source": source.public(),
            "stages": stages,
            "stats": stats,
            "extracted": extracted,
            "proposals": detailed,
            "decisions": {item["id"]: None for item in detailed},
            "usage": self.usage.public(),
            "generatedAt": now_iso(),
        }
        _save_state(self.store, state)
        return result

    # ---------------- 决策 ----------------

    async def decide(self, proposal_id: str, action: str) -> dict[str, Any]:
        """对单条提案做出决策。`action` ∈ accept / reject / null。

        `accept` 会经 `TruthWriter.commit(force=False)` 写入；**校验有 error 则拒绝写入**
        并保持 `decision=None`（绝不绕过校验）。
        """
        state = load(self.store)
        if not state:
            return {"ok": False, "message": "还没有可确认的拆书结果，请先执行拆书。"}
        items = state.get("proposals") or []
        item = next((p for p in items if p.get("id") == proposal_id), None)
        if item is None:
            return {"ok": False, "message": "找不到这条提案。"}

        if action in ("null", "withdraw", "", "none") or action is None:
            item["decision"] = None
            self._persist(item, state)
            return {"ok": True, "id": proposal_id, "decision": None}

        if action == "reject":
            item["decision"] = "ignore"
            self._persist(item, state)
            return {"ok": True, "id": proposal_id, "decision": "ignore"}

        if action != "accept":
            return {"ok": False, "message": "不认识的操作，只支持 accept / reject / null。"}

        proposal = Proposal(
            id=str(item.get("id")),
            kind=str(item.get("proposal_kind") or ""),
            payload=item.get("payload") or {},
            reason=str(item.get("reason") or ""),
            confidence=str(item.get("confidence") or "medium"),
            target_file=str(item.get("target_file") or ""),
        )
        result = TruthWriter(self.store).commit([proposal], force=False)
        errors = [i.message for i in result.issues
                  if i.level == "error" and i.proposal_id == proposal.id]
        if result.pending or errors:
            # 保持 decision=None，等作者处理完冲突再来确认
            item["decision"] = None
            item["issues"] = errors
            self._persist(item, state)
            reason = "；".join(errors) or "这条提案还有未解决的冲突。"
            return {"ok": False, "message": f"这条提案未写入：{reason}"}

        item["decision"] = "accept"
        item["issues"] = []
        self._persist(item, state)
        return {"ok": True, "id": proposal_id, "decision": "accept",
                "changedFiles": result.changed_files}

    def pending(self) -> list[dict[str, Any]]:
        """待确认的提案摘要（decision 仍为 None）。"""
        state = load(self.store) or {}
        out: list[dict[str, Any]] = []
        for item in (state.get("proposals") or []):
            if item.get("decision") is None:
                out.append(self._summary(item))
        return out

    @classmethod
    def load(cls, store) -> dict[str, Any] | None:
        return load(store)

    # ---------------- 内部 ----------------

    def _persist(self, item: dict[str, Any], state: dict[str, Any]) -> None:
        decisions = state.get("decisions")
        if not isinstance(decisions, dict):
            decisions = {}
        decisions[item["id"]] = item.get("decision")
        state["decisions"] = decisions
        _save_state(self.store, state)

    @staticmethod
    def _clamp_chapter(value: Any, total: int) -> int | None:
        try:
            n = int(value)
        except (TypeError, ValueError):
            return None
        if n <= 0:
            return None
        if total and n > total:
            return total
        return n

    @staticmethod
    def _readable_style(profile: StyleProfile) -> dict[str, str]:
        mean = profile.sentence.mean or 0.0
        if mean <= 0:
            sentence = "样本过短，未判定"
        else:
            label = "偏短" if mean < 22 else ("中等" if mean < 35 else "偏长")
            sentence = f"{label}，均值 {mean:g} 字"
        ratio = " · ".join(f"{r.label} {r.pct}%" for r in profile.ratio) or "未判定"
        return {
            "sentence": sentence,
            "pov": profile.narrative.person or "未判定",
            "ratio": ratio,
        }

    def _build_proposals(
        self,
        characters: list[dict[str, Any]],
        rules: list[dict[str, str]],
        hooks: list[dict[str, Any]],
        profile: StyleProfile,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """把各阶段结果转成 Proposal，逐个校验，有 error 的降级为待确认。"""
        writer = TruthWriter(self.store)

        used_char_ids = {c.id for c in self.store.characters()}
        used_names = {c.name for c in self.store.characters()}
        used_rule_ids = {r.id for r in self.store.world().rules}
        used_hook_ids = {h.id for h in self.store.hooks()}

        def alloc_char_id() -> str:
            i = 1
            while f"char_{i:03d}" in used_char_ids:
                i += 1
            cid = f"char_{i:03d}"
            used_char_ids.add(cid)
            return cid

        def alloc_rule_id() -> str:
            i = 1
            while f"w{i}" in used_rule_ids:
                i += 1
            rid = f"w{i}"
            used_rule_ids.add(rid)
            return rid

        def alloc_hook_id() -> str:
            i = 1
            while f"hook_{i:03d}" in used_hook_ids:
                i += 1
            hid = f"hook_{i:03d}"
            used_hook_ids.add(hid)
            return hid

        proposals: list[Proposal] = []
        contents: dict[str, str] = {}

        # 角色
        for c in characters:
            name = c["name"]
            if name in used_names:
                continue
            used_names.add(name)
            cid = alloc_char_id()
            is_lead = c["role"] in ("主角", "男主", "女主")
            char = Character(
                id=cid, name=name, role=c["role"], lead=is_lead,
                immutable_traits=list(c["traits"]),
                relationships=[Relation(target=r["target"], type=r["type"], note=r["note"])
                               for r in c["relations"]],
                first_appearance=1, aliases=list(c.get("aliases") or []),
            )
            p = Proposal(id=f"dis_char_{cid}", kind="character_add",
                         payload=char.model_dump(), target_file="characters.jsonl",
                         reason="拆书反推角色", confidence="high" if is_lead else "medium")
            proposals.append(p)
            contents[p.id] = (f"新增角色「{name}」，含 {len(c['traits'])} 条不可变特征"
                              f"与 {len(c['relations'])} 条关系")

        # 世界观
        for r in rules:
            rid = alloc_rule_id()
            rule = WorldRule(id=rid, category=r["category"],
                             kind=r["kind"],  # type: ignore[arg-type]
                             rule=r["rule"], note=r["note"])
            p = Proposal(id=f"dis_world_{rid}", kind="world_add",
                         payload=rule.model_dump(), target_file="world.md",
                         reason="拆书反推世界观",
                         confidence="high" if r["kind"] == "hard" else "medium")
            proposals.append(p)
            contents[p.id] = f"写入设定：[{'硬约束' if r['kind'] == 'hard' else '软设定'}] {r['rule']}"

        # 伏笔
        for h in hooks:
            hid = alloc_hook_id()
            hook = Hook(id=hid, content=h["content"], planted_chapter=h["planted_chapter"],
                        status="resolved" if h["resolved_chapter"] else "planted",
                        resolved_chapter=h["resolved_chapter"],
                        importance=h["importance"],  # type: ignore[arg-type]
                        linked_characters=[])
            matched_text = f"，第 {h['resolved_chapter']} 章回收" if h["resolved_chapter"] else "，未匹配到回收点"
            p = Proposal(id=f"dis_hook_{hid}", kind="hook_add",
                         payload=hook.model_dump(), target_file="pending_hooks.jsonl",
                         reason="拆书反推伏笔",
                         confidence="high" if h["resolved_chapter"] else "low")
            proposals.append(p)
            contents[p.id] = f"写入伏笔：{h['content']}（第 {h['planted_chapter']} 章埋设{matched_text}）"

        # 文风
        style_p = Proposal(id="dis_style", kind="style_update",
                           payload=profile.model_dump(), target_file="style_profile.json",
                           reason="拆书生成文风档案", confidence="high")
        proposals.append(style_p)
        contents[style_p.id] = "生成 style_profile.json 并设为必选上下文"

        # 逐个校验，收集 error
        issues = writer.validate(proposals)
        errors_by_id: dict[str, list[str]] = {}
        for issue in issues:
            if issue.level == "error":
                errors_by_id.setdefault(issue.proposal_id, []).append(issue.message)

        summaries: list[dict[str, Any]] = []
        detailed: list[dict[str, Any]] = []
        for p in proposals:
            errs = errors_by_id.get(p.id, [])
            if errs:
                # 有 error → 降级为待确认（confidence 降为 low，decision 留空）
                p.confidence = "low"
            summary = {
                "id": p.id,
                "kind": KIND_LABELS.get(p.kind, p.kind),
                "content": contents.get(p.id, p.kind),
                "confidence": p.confidence,
                "decision": p.decision,
            }
            summaries.append(summary)
            detailed.append({
                **summary,
                "proposal_kind": p.kind,
                "payload": p.payload,
                "reason": p.reason,
                "target_file": p.target_file,
                "issues": errs,
            })
        return summaries, detailed

    @staticmethod
    def _summary(item: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": item.get("id"),
            "kind": item.get("kind"),
            "content": item.get("content"),
            "confidence": item.get("confidence"),
            "decision": item.get("decision"),
        }
