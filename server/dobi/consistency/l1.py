"""L1 确定性规则：13 条零模型成本的检查（规划文档 §8.1）。

设计取舍（对应 §2「先确定性，后智能」）：

- 全部用正则与规则判定，**不调用模型**，因此可以每章、每轮无成本重跑；
- 规则清单与阈值抄自 `prototype/do-bi/assets/mock.js` 的 `auditReport.l1`，
  逐条同名同阈值；`checked` 必须返回全量 13 行（含未命中），供前端表格渲染；
- 允许启发式粗糙：每条规则都真实实现、能跑出结果，宁可在注释里写清误报风险，
  也不返回「永远为空」的占位实现。

口径约定（与 mock 的 `count / threshold / isHit` 对齐）：
  命中与否由 `isHit` 显式给出，前端不要自行用 `count >= threshold` 反推。
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from ..core.schema import Character, Hook, L1Violation, StyleProfile, WorldRule
from ..core.store import count_words

__all__ = [
    "L1Input",
    "L1Result",
    "check_l1",
    "rule_catalog",
    "text_ratio",
    "RULES",
    "CLICHE_PATTERNS",
    "TRAIT_CONFLICTS",
]


# ==========================================================================
# 规则清单（逐字对齐 mock.js 的 auditReport.l1 —— 名称与阈值不可改）
# ==========================================================================

#: (key, 规则名, 阈值, 说明)
RULES: tuple[tuple[str, str, int, str], ...] = (
    ("name_mismatch", "称呼／姓名不一致", 1,
     "正文出现与已登记角色名相似度 ≥0.6 但不完全相等的人名候选（同音／形近异写）"),
    ("deceased_onstage", "角色已死亡仍出场", 1,
     "本章出场名单中含已标记亡故（deceased 或状态含「亡／死」）的角色"),
    ("immutable_violation", "不可变特征被违背", 1,
     "角色不可变特征与正文出现的显式相反词冲突（如「不饮酒」却出现「饮酒」）"),
    ("banned_expression", "禁用句式命中", 1,
     "命中文风档案 banned_expressions 中的禁用表达"),
    ("cliche_density", "套话密度超阈值", 3,
     "内置套话句式出现次数超过阈值（阈值按每千字 3 次折算）"),
    ("consecutive_particles", "连续「了／的」字句", 2,
     "段内「了」≥3 或「的」≥4 的段落数（阈值 2 为高发参考线）"),
    ("word_fatigue", "词汇疲劳", 3,
     "同一 2–3 字词（排除停用词）在章内出现次数 > 阈值"),
    ("paragraph_length", "段落长度异常", 1,
     "全篇段长过于均匀（标准差 < 均值×0.18），或存在单段 > 均值×4 的超长段"),
    ("pov_switch", "视角切换未标注", 1,
     "第一人称与第三人称人称代词占比均 ≥15%，或出现全知式旁白启发式信号"),
    ("timeline_order", "时间线倒错", 1,
     "「次日／第二天」出现在「当夜」之前，或「后来」出现而前文未建立时间跳跃"),
    ("hook_overdue", "伏笔超期未回收", 1,
     "仍处 planted 且已超过 suggested_resolve_by 的伏笔"),
    ("numeric_conflict", "数值／等级矛盾", 1,
     "同一量词出现两个不同数值且指向同类事物（数量／距离／年龄／银两等）"),
    ("ratio_deviation", "描写／对话比例偏离", 1,
     "描写／对话／动作占比与文风档案任一维度偏差 > 15 个百分点"),
)

_RULES_BY_KEY: dict[str, tuple[str, int, str]] = {r[0]: (r[1], r[2], r[3]) for r in RULES}

#: 阈值常量
NAME_SIMILARITY = 0.6          # 人名相似度阈值
CLICHE_PER_1000 = 3            # 套话密度：每千字 3 次
WORD_FATIGUE_THRESHOLD = 3     # 词汇疲劳：超过 3 次
RATIO_TOLERANCE_PP = 15        # 比例偏差容忍度（百分点）
PARA_UNIFORM_RATIO = 0.18      # 段长均匀判定：标准差 < 均值×0.18
PARA_OVERLONG_RATIO = 4.0      # 超长段判定：单段 > 均值×4

#: 文风档案缺失时的兜底比例，保证第 13 条规则始终可判定（取自 mock styleProfile）
DEFAULT_RATIO: tuple[tuple[str, int], ...] = (("描写", 46), ("对话", 31), ("动作", 23))


# ==========================================================================
# 内置词表
# ==========================================================================

#: 套话句式（古风悬疑语境，≥15 条）
CLICHE_PATTERNS: tuple[str, ...] = (
    "心中一凛", "心中一紧", "心下了然", "心头一震", "心中五味杂陈",
    "不由自主地", "不由自主", "下意识地", "下意识", "鬼使神差",
    "空气仿佛凝固", "空气瞬间凝固", "冷汗直流", "如坠冰窟", "毛骨悚然",
    "眼中闪过一丝", "眼中闪过一抹", "哭笑不得", "五味杂陈", "思绪万千",
    "久久不能平静", "莫名地", "不易察觉地", "几不可闻", "说不出地",
    "复杂难言", "令人窒息", "宛如游龙",
)

#: 不可变特征的显式相反检索表（key 命中 trait 子串即启用）
TRAIT_CONFLICTS: dict[str, list[str]] = {
    "不饮酒": ["饮酒", "喝了", "酒盏", "举杯", "斟酒", "酒碗", "痛饮", "饮下"],
    "惧水": ["下水", "涉水", "游泳", "渡河", "凫水", "入水", "游过去"],
    "惯用左手": ["右手持", "右手握", "右手拔", "右手按", "右手使"],
    "左手使刀": ["右手使刀", "右手持刀", "改用右手"],
    "哑": ["开口说", "朗声", "高声说", "开口道", "出声答"],
    "常年戴斗笠": ["摘下斗笠", "没戴斗笠", "不戴斗笠"],
    "右手缺两指": ["右手拇指", "五指俱全", "右手完好"],
    "左脸有灼伤疤": ["右脸有疤", "脸上没有疤", "左脸完好"],
}

#: 词汇疲劳的停用词（避免把功能词当成「疲劳词」）
STOPWORDS_2_3: frozenset[str] = frozenset({
    "一个", "一种", "一样", "一直", "一起", "一切", "一些", "一定",
    "没有", "什么", "这个", "那个", "这样", "那样", "这些", "那些",
    "自己", "知道", "已经", "还是", "如果", "因为", "所以", "但是",
    "可是", "然而", "于是", "然后", "起来", "出来", "过来", "下来",
    "上去", "下去", "进来", "出去", "回来", "此时", "此刻", "时候",
    "地方", "东西", "事情", "他们", "她们", "我们", "你们", "人们",
    "不可", "不是", "不能", "不会", "只是", "就是", "便是", "于是",
    "时候", "仿佛",  # 「仿佛」是 mock 示例，但真实判定时仍应计入 → 见下注释
})

#: 「仿佛」在 mock 中被判为疲劳词，故从停用词中移除，让它可被检出
STOPWORDS_2_3 = frozenset(w for w in STOPWORDS_2_3 if w != "仿佛")

#: 动作动词（用于描写/动作粗分）
ACTION_VERBS: tuple[str, ...] = (
    "走", "跑", "站", "坐", "蹲", "跪", "躺", "拿", "放", "抬", "低",
    "转身", "侧身", "握", "推", "拉", "看", "望", "瞥", "盯", "听",
    "拔", "插", "按", "收", "递", "点头", "摇头", "起身", "退", "迈",
    "挥", "掷", "撞", "掀", "量", "摸", "拍", "敲", "踢", "跨", "挪",
    "靠", "俯", "撑", "抓", "拽", "扯", "挥下", "探", "缩", "折",
)

#: 人称代词
_PRON_FIRST = ("我", "我们")
_PRON_THIRD = ("他", "她", "他们", "她们")

#: 时间词
_TIME_LATE = ("次日", "第二天", "翌日", "隔日")
_TIME_NIGHT = ("当夜", "当晚", "是夜", "入夜", "此夜")
_FLASHBACK_WORDS = ("三日前", "三日后", "十年前", "二十年前", "十二年前",
                    "年前", "此前", "当年", "幼年", "多年前", "早年")

#: 数量词量词表（用于数值矛盾）
_QUANTIFIERS = "个名人只匹辆尺丈里岁枚块条间座盏斤把枝卷页份道层次步"
_NUM_CLASS = "零一二三四五六七八九十百千万两0-9"
_CN_DIGITS = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
              "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_CN_UNITS = {"十": 10, "百": 100, "千": 1000}


# ==========================================================================
# 输入 / 输出
# ==========================================================================

@dataclass
class L1Input:
    text: str
    chapter: int
    characters: list[Character] = field(default_factory=list)
    hooks: list[Hook] = field(default_factory=list)
    world_rules: list[WorldRule] = field(default_factory=list)
    style: StyleProfile | None = None
    characters_present: list[str] = field(default_factory=list)   # 本章出场角色名（可空）


@dataclass
class L1Result:
    violations: list[L1Violation] = field(default_factory=list)
    checked: list[dict] = field(default_factory=list)   # 全量 13 行，含未命中

    def to_dict(self) -> dict:
        return {
            "violations": [v.model_dump() for v in self.violations],
            "checked": self.checked,
        }

    @property
    def hit_count(self) -> int:
        return len(self.violations)


@dataclass
class _Outcome:
    """单条规则的判定结果。`violations` 非空即视为命中。"""

    violations: list[L1Violation] = field(default_factory=list)
    count: int = 0
    hit_label: str = ""
    samples: list[str] = field(default_factory=list)

    @property
    def hit(self) -> bool:
        return bool(self.violations)


def _mk(key: str, hit: str, count: int, samples: list[str] | None = None) -> L1Violation:
    name, threshold, _ = _RULES_BY_KEY[key]
    return L1Violation(rule=name, hit=hit, count=count, threshold=threshold,
                       samples=list(samples or []))


# ==========================================================================
# 通用工具
# ==========================================================================

_PARA_RE = re.compile(r"\n\s*\n+")
_SENT_RE = re.compile(r"[^。！？…\n]+[。！？…]?")
_DIALOG_RE = re.compile(r"[「『“\"]([^」』”\"]*)[」』”\"]")
_CJK_RUN_RE = re.compile(r"[\u4e00-\u9fff]+")


def _paragraphs(text: str) -> list[str]:
    return [p.strip() for p in _PARA_RE.split(text or "") if p.strip()]


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT_RE.findall(text or "") if s.strip()]


def _percentile(values: list[int], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    if len(s) == 1:
        return float(s[0])
    k = (len(s) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return float(s[int(k)])
    return s[lo] * (hi - k) + s[hi] * (k - lo)


def _cjk_len(text: str) -> int:
    """中文字符数（按字计，不是按连续汉字段数）。"""
    return sum(len(r) for r in _CJK_RUN_RE.findall(text or ""))


def text_ratio(text: str) -> dict[str, int]:
    """把正文粗分为「描写 / 对话 / 动作」三类的字符数。

    统一规则（第 13 条规则与文风档案 local_metrics 共用）：
    - 成对引号「」/『』/“”/""内的字符计为**对话**；
    - 其余句子中含动作动词的计为**动作**；
    - 剩下的计为**描写**。
    """
    raw = text or ""
    dialogue = sum(len(m) for m in _DIALOG_RE.findall(raw))
    rest = _DIALOG_RE.sub("", raw)
    action = 0
    desc = 0
    for sent in _sentences(rest):
        n = _cjk_len(sent) or len(sent)
        if any(v in sent for v in ACTION_VERBS):
            action += n
        else:
            desc += n
    return {"描写": desc, "对话": dialogue, "动作": action}


def _pct_of(counts: dict[str, int]) -> dict[str, float]:
    total = sum(counts.values())
    if total <= 0:
        return {k: 0.0 for k in counts}
    return {k: v / total * 100 for k, v in counts.items()}


# ==========================================================================
# 各规则实现
# ==========================================================================

# ---- 1. 称呼／姓名不一致 -------------------------------------------------
_QUOTE_CAND_RE = re.compile(r"[「『“\"]([\u4e00-\u9fff]{2,4})")
_SUFFIX_CAND_RE = re.compile(r"([\u4e00-\u9fff]{2,4})(?=[说道问答喊叫冷笑怒喝应声])")


def _name_candidates(text: str) -> list[str]:
    """抽出正文中的中文人名候选（2–4 字，带「」或后接说/道等上下文）。"""
    found: list[str] = []
    for rx in (_QUOTE_CAND_RE, _SUFFIX_CAND_RE):
        for m in rx.findall(text or ""):
            if isinstance(m, tuple):
                m = next((x for x in m if x), "")
            if 2 <= len(m) <= 4:
                found.append(m)
    return found


def _r_name_mismatch(d: L1Input) -> _Outcome:
    names = {n for c in d.characters for n in ([c.name] + list(c.aliases)) if n}
    if not names:
        return _Outcome()
    seen: set[str] = set()
    hits: list[tuple[str, str, float]] = []
    for cand in _name_candidates(d.text):
        if cand in seen or cand in names:
            continue
        seen.add(cand)
        # 若候选本身包含某个已登记名，说明只是多截了字的窗口，跳过
        if any(reg in cand for reg in names):
            continue
        for reg in names:
            if abs(len(cand) - len(reg)) > 1:
                continue
            r = SequenceMatcher(None, cand, reg).ratio()
            if r >= NAME_SIMILARITY:
                hits.append((cand, reg, r))
                break
    if not hits:
        return _Outcome()
    vs = [_mk("name_mismatch", f"{cand}（疑为「{reg}」）", 1, [f"{cand}≈{reg}({r:.2f})"])
          for cand, reg, r in hits]
    return _Outcome(violations=vs, count=len(hits), hit_label=vs[0].hit,
                    samples=[f"{c}≈{g}" for c, g, _ in hits])


# ---- 2. 角色已死亡仍出场 -------------------------------------------------
def _resolve_char(d: L1Input, key: str) -> Character | None:
    for c in d.characters:
        if c.id == key or c.name == key or key in c.aliases:
            return c
    return None


def _r_deceased_onstage(d: L1Input) -> _Outcome:
    vs: list[L1Violation] = []
    samples: list[str] = []
    for name in d.characters_present:
        c = _resolve_char(d, name)
        if c is None:
            continue
        status = c.state.status if c.state else ""
        dead = c.deceased or ("亡" in status) or ("死" in status) or ("殁" in status)
        if dead:
            reason = "已标记亡故" if c.deceased else f"状态为「{status}」"
            vs.append(_mk("deceased_onstage", c.name, 1, [f"{c.name}：{reason}"]))
            samples.append(f"{c.name}（{reason}）")
    return _Outcome(violations=vs, count=len(vs),
                    hit_label=vs[0].hit if vs else "", samples=samples)


# ---- 3. 不可变特征被违背 -------------------------------------------------
def _r_immutable_violation(d: L1Input) -> _Outcome:
    vs: list[L1Violation] = []
    samples: list[str] = []
    text = d.text or ""
    for c in d.characters:
        for trait in c.immutable_traits:
            key = next((k for k in TRAIT_CONFLICTS
                        if k in trait or trait in k), None)
            if key is None:
                continue
            if key == "已故":
                # 「已故」特征：只要本章仍以在世口吻出场即视为违背
                if c.name in text:
                    hit = f"{trait} ←→ {c.name}仍出场"
                    vs.append(_mk("immutable_violation", hit, 1, [trait]))
                    samples.append(hit)
                continue
            for word in TRAIT_CONFLICTS[key]:
                if word in text:
                    hit = f"{trait} ←→ {word}"
                    vs.append(_mk("immutable_violation", hit, 1, [trait, word]))
                    samples.append(hit)
                    break
    return _Outcome(violations=vs, count=len(vs),
                    hit_label=vs[0].hit if vs else "", samples=samples)


# ---- 4. 禁用句式命中 -----------------------------------------------------
def _r_banned_expression(d: L1Input) -> _Outcome:
    banned = (d.style.banned_expressions if d.style else []) or []
    text = d.text or ""
    total = 0
    found: list[str] = []
    for b in banned:
        if not b:
            continue
        cnt = text.count(b)
        if cnt > 0:
            total += cnt
            found.append(f"{b}×{cnt}")
    if not found:
        return _Outcome()
    hit = found[0].split("×")[0]
    vs = [_mk("banned_expression", hit, total, found)]
    return _Outcome(violations=vs, count=total, hit_label=hit, samples=found)


# ---- 5. 套话密度超阈值 ---------------------------------------------------
def _r_cliche_density(d: L1Input) -> _Outcome:
    text = d.text or ""
    words = max(count_words(text), 1)
    found: list[str] = []
    occ = 0
    for p in CLICHE_PATTERNS:
        cnt = text.count(p)
        if cnt:
            occ += cnt
            found.append(f"{p}×{cnt}")
    if occ == 0:
        return _Outcome(count=0)
    # 阈值按每千字 3 次折算（长章要求按比例提高次数，短章不低于 3 次）
    eff = max(CLICHE_PER_1000, int(round(CLICHE_PER_1000 * words / 1000)))
    if occ < eff:
        # 未过阈值时也把次数带出去，便于前端展示密度
        return _Outcome(count=occ)
    hit = found[0].split("×")[0]
    vs = [_mk("cliche_density", hit, occ, found)]
    return _Outcome(violations=vs, count=occ, hit_label=hit, samples=found)


# ---- 6. 连续「了／的」字句 -----------------------------------------------
def _r_consecutive_particles(d: L1Input) -> _Outcome:
    paras = _paragraphs(d.text)
    heavy: list[str] = []
    for i, p in enumerate(paras, 1):
        n_le = p.count("了")
        n_de = p.count("的")
        if n_le >= 3 or n_de >= 4:
            heavy.append(f"第 {i} 段（了×{n_le}／的×{n_de}）")
    if not heavy:
        return _Outcome(count=0)
    hit = heavy[0]
    vs = [_mk("consecutive_particles", hit, len(heavy), heavy)]
    return _Outcome(violations=vs, count=len(heavy), hit_label=hit, samples=heavy)


# ---- 7. 词汇疲劳 ---------------------------------------------------------
def _cn_ngrams(text: str, n: int) -> list[str]:
    out: list[str] = []
    for run in _CJK_RUN_RE.findall(text or ""):
        for i in range(len(run) - n + 1):
            g = run[i:i + n]
            if g in STOPWORDS_2_3:
                continue
            out.append(g)
    return out


def _r_word_fatigue(d: L1Input) -> _Outcome:
    counts: dict[str, int] = {}
    for n in (2, 3):
        for g in _cn_ngrams(d.text, n):
            counts[g] = counts.get(g, 0) + 1
    # 角色名／别名本身就是高频复现的（人物总要被叫），不算「疲劳词」；
    # 同时排除作为角色名子串的 n-gram（如「崔十」之于「崔十九」）。
    names = {n for c in d.characters for n in ([c.name] + list(c.aliases)) if n}
    if names:
        counts = {g: c for g, c in counts.items()
                  if g not in names and not any(g in name for name in names)}
    # 只保留 2 字或 3 字、且出现次数超过阈值的候选
    candidates = [(g, c) for g, c in counts.items() if c > WORD_FATIGUE_THRESHOLD]
    if not candidates:
        top = max(counts.values()) if counts else 0
        return _Outcome(count=top)
    candidates.sort(key=lambda x: (-x[1], -len(x[0])))
    # 去重：若某 2 字词被同次数的 3 字词包含，优先报 3 字词，避免重复刷屏
    picked: list[tuple[str, int]] = []
    for g, c in candidates:
        if len(g) == 2 and any((g in h and hc >= c) for h, hc in candidates if len(h) == 3):
            continue
        picked.append((g, c))
    picked = picked[:5]
    samples = [f"{g}×{c}" for g, c in picked]
    top_word, top_cnt = picked[0]
    vs = [_mk("word_fatigue", top_word, top_cnt, samples)]
    return _Outcome(violations=vs, count=top_cnt, hit_label=top_word, samples=samples)


# ---- 8. 段落长度异常 -----------------------------------------------------
def _r_paragraph_length(d: L1Input) -> _Outcome:
    paras = _paragraphs(d.text)
    if len(paras) < 3:
        return _Outcome(count=0)
    lens = [max(count_words(p), 1) for p in paras]
    mean = sum(lens) / len(lens)
    var = sum((x - mean) ** 2 for x in lens) / len(lens)
    std = math.sqrt(var)
    signals: list[str] = []
    if mean > 0 and std < mean * PARA_UNIFORM_RATIO:
        signals.append(f"全篇段长过于均匀（标准差 {std:.1f} < 均值 {mean:.1f}×0.18）")
    overlon = [i + 1 for i, L in enumerate(lens) if L > mean * PARA_OVERLONG_RATIO]
    if overlon:
        signals.append("超长段落：" + "、".join(f"第 {i} 段" for i in overlon))
    if not signals:
        return _Outcome(count=0)
    hit = signals[0]
    vs = [_mk("paragraph_length", hit, len(signals), signals)]
    return _Outcome(violations=vs, count=len(signals), hit_label=hit, samples=signals)


# ---- 9. 视角切换未标注 ---------------------------------------------------
def _r_pov_switch(d: L1Input) -> _Outcome:
    text = d.text or ""
    first = sum(text.count(p) for p in _PRON_FIRST) - text.count("我们") * 0  # 字面统计
    # 更稳的做法：按字符计数人称代词本体
    first = text.count("我")
    third = (text.count("他") + text.count("她")) - text.count("其他")
    third = max(third, 0)
    total = first + third
    signals: list[str] = []
    if total >= 5:
        rf = first / total
        rt = third / total
        if rf >= 0.15 and rt >= 0.15:
            signals.append(f"第一人称 {rf:.0%} 与第三人称 {rt:.0%} 并存，视角未注明切换")
    # 全知式旁白启发式
    if ("他知道" in text or "她知道" in text) and ("其实" in text or "原来" in text):
        signals.append("出现「他知道…其实…」式的全知旁白，与限知视角冲突")
    if not signals:
        return _Outcome(count=0)
    hit = signals[0]
    vs = [_mk("pov_switch", hit, len(signals), signals)]
    return _Outcome(violations=vs, count=len(signals), hit_label=hit, samples=signals)


# ---- 10. 时间线倒错 ------------------------------------------------------
def _first_index(text: str, words: tuple[str, ...]) -> tuple[int, str]:
    best = -1
    best_w = ""
    for w in words:
        i = text.find(w)
        if i != -1 and (best == -1 or i < best):
            best, best_w = i, w
    return best, best_w


def _r_timeline_order(d: L1Input) -> _Outcome:
    text = d.text or ""
    signals: list[str] = []
    late_i, late_w = _first_index(text, _TIME_LATE)
    night_i, night_w = _first_index(text, _TIME_NIGHT)
    if late_i != -1 and night_i != -1 and late_i < night_i:
        signals.append(f"「{late_w}」出现在「{night_w}」之前，时间线倒错")
    # 「后来」出现在段首，而前文未建立时间跳跃
    for idx, p in enumerate(_paragraphs(text)):
        if p.startswith("后来"):
            prefix = text[:text.find(p)] if p in text else ""
            if not any(f in prefix for f in _FLASHBACK_WORDS):
                signals.append("「后来」出现在段首，但前文未见时间跳跃的锚点")
                break
    if not signals:
        return _Outcome(count=0)
    hit = signals[0]
    vs = [_mk("timeline_order", hit, len(signals), signals)]
    return _Outcome(violations=vs, count=len(signals), hit_label=hit, samples=signals)


# ---- 11. 伏笔超期未回收 --------------------------------------------------
def _r_hook_overdue(d: L1Input) -> _Outcome:
    vs: list[L1Violation] = []
    samples: list[str] = []
    for h in d.hooks:
        try:
            overdue = h.overdue(d.chapter)
        except Exception:
            overdue = False
        if overdue:
            summary = (h.content or "")[:18]
            hit = f"{h.id}：{summary}"
            vs.append(_mk("hook_overdue", hit, 1,
                          [f"{h.id} 建议第 {h.suggested_resolve_by} 章前回收，当前第 {d.chapter} 章仍悬置"]))
            samples.append(hit)
    return _Outcome(violations=vs, count=len(vs),
                    hit_label=vs[0].hit if vs else "", samples=samples)


# ---- 12. 数值／等级矛盾 --------------------------------------------------
_NUM_Q_RE = re.compile(rf"([{_NUM_CLASS}]{{1,6}})([{_QUANTIFIERS}])")
_TAEL_RE = re.compile(rf"([{_NUM_CLASS.replace('两','')}]{{1,6}})两")


def _cn_to_int(token: str) -> int | None:
    if not token:
        return None
    if token.isdigit():
        return int(token)
    total = 0
    number = 0
    for ch in token:
        if ch in _CN_DIGITS:
            number = _CN_DIGITS[ch]
        elif ch in _CN_UNITS:
            total += (number or 1) * _CN_UNITS[ch]
            number = 0
        else:
            return None
    return total + number


def _r_numeric_conflict(d: L1Input) -> _Outcome:
    text = d.text or ""
    # 注意：此处**刻意排除**「年／日／月／时」这类纯时间量词（如「二十年前」「十年前」），
    # 它们指向不同时间点而非同类事物的数量矛盾，纳入会大量误报。
    groups: dict[str, set[int]] = {}
    raw: dict[str, set[str]] = {}
    for num, q in _NUM_Q_RE.findall(text):
        v = _cn_to_int(num)
        if v is None or v == 0:
            continue
        groups.setdefault(q, set()).add(v)
        raw.setdefault(q, set()).add(num)
    for num in _TAEL_RE.findall(text):
        v = _cn_to_int(num)
        if v is None or v == 0:
            continue
        groups.setdefault("两", set()).add(v)
        raw.setdefault("两", set()).add(num)
    conflicts = [(q, sorted(vs)) for q, vs in groups.items() if len(vs) > 1]
    if not conflicts:
        return _Outcome(count=0)
    samples = [f"{q}：{'、'.join(map(str, vs))}" for q, vs in conflicts]
    hit = samples[0]
    vs = [_mk("numeric_conflict", hit, len(conflicts), samples)]
    return _Outcome(violations=vs, count=len(conflicts), hit_label=hit, samples=samples)


# ---- 13. 描写／对话比例偏离 ----------------------------------------------
def _r_ratio_deviation(d: L1Input) -> _Outcome:
    counts = text_ratio(d.text)
    if sum(counts.values()) < 30:  # 文本太短，比例不可靠
        return _Outcome(count=0)
    actual = _pct_of(counts)
    expected = {r.label: r.pct for r in (d.style.ratio if d.style and d.style.ratio else [])}
    if not expected:
        expected = dict(DEFAULT_RATIO)
    devs: list[str] = []
    for label, exp in expected.items():
        act = actual.get(label)
        if act is None:
            continue
        diff = abs(act - exp)
        if diff > RATIO_TOLERANCE_PP:
            devs.append(f"{label}：实际 {act:.0f}% vs 档案 {exp}%（偏差 {diff:.0f} 个百分点）")
    if not devs:
        return _Outcome(count=0)
    hit = devs[0]
    vs = [_mk("ratio_deviation", hit, len(devs), devs)]
    return _Outcome(violations=vs, count=len(devs), hit_label=hit, samples=devs)


#: key → 实现
_IMPL = {
    "name_mismatch": _r_name_mismatch,
    "deceased_onstage": _r_deceased_onstage,
    "immutable_violation": _r_immutable_violation,
    "banned_expression": _r_banned_expression,
    "cliche_density": _r_cliche_density,
    "consecutive_particles": _r_consecutive_particles,
    "word_fatigue": _r_word_fatigue,
    "paragraph_length": _r_paragraph_length,
    "pov_switch": _r_pov_switch,
    "timeline_order": _r_timeline_order,
    "hook_overdue": _r_hook_overdue,
    "numeric_conflict": _r_numeric_conflict,
    "ratio_deviation": _r_ratio_deviation,
}


# ==========================================================================
# 对外入口
# ==========================================================================

def check_l1(data: L1Input) -> L1Result:
    """跑完 13 条确定性规则。

    任何一条都不抛异常（单条内部出错降级为「未命中」），保证审计流程不被打断。
    """
    violations: list[L1Violation] = []
    checked: list[dict] = []
    for key, name, threshold, _desc in RULES:
        fn = _IMPL[key]
        try:
            outcome = fn(data)
        except Exception:  # 单条规则出错不影响其余规则
            outcome = _Outcome()
        violations.extend(outcome.violations)
        checked.append({
            "rule": name,
            "hit": outcome.hit_label if outcome.hit else "",
            "count": int(outcome.count),
            "threshold": threshold,
            "isHit": outcome.hit,
        })
    return L1Result(violations=violations, checked=checked)


def rule_catalog() -> list[dict]:
    """13 条规则的清单，供 API 与前端渲染（key 稳定、rule 会随文案微调）。"""
    return [{"key": k, "rule": n, "threshold": t, "describe": ds}
            for k, n, t, ds in RULES]
