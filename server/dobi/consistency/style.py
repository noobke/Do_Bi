"""文风仿写（规划文档 §8.5）。

流程：先跑 `local_metrics` 得到**确定性事实基线**（句长分布、描写/对话/动作比例、
人称、段长、高频短语），再让模型在基线上补充 `preferred_patterns /
banned_expressions / lexicon / narrative` 判断。模型返回的数字若与本地基线偏差
超过 25%，**以本地基线为准**——确定性优先。

另提供 9 个预设文风（逐字移植自 `prototype/do-bi/assets/mock.js` 的 stylePresets），
其 `StyleProfile` 由样段跑 `local_metrics` 现算并缓存。
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

from ..core.schema import (
    NarrativeStyle,
    SentenceStats,
    StyleProfile,
    StyleRatio,
    now_iso,
)
from ..llm.provider import LLMClient
from .l1 import STOPWORDS_2_3, _CJK_RUN_RE, _cjk_len, _percentile, text_ratio

__all__ = [
    "local_metrics",
    "analyze_style",
    "presets",
    "preset_profile",
    "merge_profile",
    "PRESET_SEEDS",
]

_SENT_RE = re.compile(r"[^。！？…\n]+[。！？…]?")


# ==========================================================================
# 本地确定性指标
# ==========================================================================

def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT_RE.findall(text or "") if s.strip()]


def _phrases(text: str, top: int = 12) -> list[dict[str, Any]]:
    """高频 2–4 字短语（步长 1 的 n-gram 计数，排除停用词）。"""
    counts: dict[str, int] = {}
    for n in (2, 3, 4):
        for run in _CJK_RUN_RE.findall(text or ""):
            for i in range(len(run) - n + 1):
                g = run[i:i + n]
                if g in STOPWORDS_2_3:
                    continue
                counts[g] = counts.get(g, 0) + 1
    ranked = sorted(counts.items(), key=lambda x: (-x[1], -len(x[0])))
    return [{"phrase": g, "count": c} for g, c in ranked[:top]]


def local_metrics(text: str) -> dict:
    """确定性文风指标：句长分布 / 比例 / 人称 / 段长 / 高频短语。"""
    raw = text or ""
    lengths = [max(_cjk_len(s), 1) for s in _sentences(raw)]
    if lengths:
        mean = sum(lengths) / len(lengths)
        sent = {
            "mean": round(mean, 2),
            "p50": round(_percentile(lengths, 0.5), 2),
            "p90": round(_percentile(lengths, 0.9), 2),
            "min": float(min(lengths)),
            "max": float(max(lengths)),
        }
    else:
        sent = {"mean": 0.0, "p50": 0.0, "p90": 0.0, "min": 0.0, "max": 0.0}

    counts = text_ratio(raw)
    total = sum(counts.values())
    ratio = ([{"label": k, "pct": round(v / total * 100)}
              for k, v in counts.items()] if total else [])

    first = raw.count("我")
    third = max(raw.count("他") + raw.count("她") - raw.count("其他"), 0)
    if first > third * 1.5 and first >= 2:
        person = "第一人称"
    elif third > 0:
        person = "第三人称限知"
    else:
        person = ""

    paras = [p for p in re.split(r"\n\s*\n+", raw) if p.strip()]
    plens = [max(_cjk_len(p), 1) for p in paras]
    if plens:
        pmean = sum(plens) / len(plens)
        pstd = math.sqrt(sum((x - pmean) ** 2 for x in plens) / len(plens))
    else:
        pmean = pstd = 0.0

    return {
        "sentence": sent,
        "ratio": ratio,
        "narrative": {"person": person, "tense": "", "pov_switch": "rare"},
        "paragraph": {"count": len(paras), "mean": round(pmean, 2), "std": round(pstd, 2)},
        "phrases": _phrases(raw),
    }


# ==========================================================================
# 模型分析
# ==========================================================================

def _pick(local: float, model: Any, tol: float = 0.25) -> float:
    """模型数字与本地基线偏差 > tol 时以本地为准。"""
    try:
        mv = float(model)
    except (TypeError, ValueError):
        return local
    if mv <= 0:
        return local
    if local <= 0:
        return mv
    if abs(mv - local) / local > tol:
        return local
    return mv


def _extract_obj(obj: Any) -> dict[str, Any]:
    if isinstance(obj, dict):
        for key in ("profile", "style", "data", "result"):
            if isinstance(obj.get(key), dict):
                return obj[key]
        return obj
    return {}


def _build_messages(sample: str, source_label: str, base: dict) -> list[dict[str, str]]:
    system = (
        "你是一位文学风格分析师。下面给你一段参考样本与已算好的**确定性基线指标**，"
        "请在基线上补充风格判断。\n"
        "硬性要求：\n"
        "1. sentence.mean / sentence.p90 若你给出数字，必须与基线接近（偏差不超过 25%），"
        "不要凭空编造；\n"
        "2. preferred_patterns 用一句话描述可复用的写法手法（不要罗列具体句子）；\n"
        "3. banned_expressions 列出该样本回避的、AI 腔的套话表达；\n"
        "4. lexicon 是「用词偏好」键值对；\n"
        "5. narrative 判断人称 / 时态 / 视角切换频率 / 锚点人物。\n"
        '只输出一个 JSON 对象：{"sentence":{"mean":数值,"p90":数值},'
        '"narrative":{"person":"","tense":"","pov_switch":"","anchor":""},'
        '"preferred_patterns":["..."],"banned_expressions":["..."],'
        '"lexicon":[{"key":"","value":""}],"sample_styled":"一句仿写的样例"}。'
        "不要输出解释文字、不要 Markdown 代码块围栏。"
    )
    user = [
        f"# 参考样本来源：{source_label}",
        "## 确定性基线指标（以这些为准）",
        json.dumps(base, ensure_ascii=False, indent=2),
        "## 参考样本正文",
        sample,
    ]
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n".join(user)},
    ]


async def analyze_style(client: LLMClient, sample: str,
                        *, source_label: str) -> tuple[StyleProfile, int]:
    """分析参考样本，返回 (文风档案, 消耗 token 数)。"""
    base = local_metrics(sample)
    obj, result = await client.complete_json(
        "style_analyze", _build_messages(sample, source_label, base)
    )
    data = _extract_obj(obj)

    local_sent = base["sentence"]
    model_sent = data.get("sentence") or {}
    sentence = SentenceStats(
        mean=_pick(local_sent["mean"], model_sent.get("mean")),
        p50=local_sent["p50"],
        p90=_pick(local_sent["p90"], model_sent.get("p90")),
        min=local_sent["min"],
        max=local_sent["max"],
        scale=80.0,
    )

    local_nar = base["narrative"]
    model_nar = data.get("narrative") or {}
    narrative = NarrativeStyle(
        person=str(model_nar.get("person") or local_nar.get("person") or ""),
        tense=str(model_nar.get("tense") or local_nar.get("tense") or ""),
        pov_switch=str(model_nar.get("pov_switch") or local_nar.get("pov_switch") or "rare"),
        anchor=str(model_nar.get("anchor") or ""),
    )

    ratio = [StyleRatio(label=r["label"], pct=int(r["pct"])) for r in base["ratio"]]

    patterns = [str(x) for x in (data.get("preferred_patterns") or []) if str(x).strip()]
    banned = [str(x) for x in (data.get("banned_expressions") or []) if str(x).strip()]
    lexicon = [{"key": str(x.get("key", "")), "value": str(x.get("value", ""))}
               for x in (data.get("lexicon") or []) if isinstance(x, dict)]

    profile = StyleProfile(
        source=source_label,
        analyzed_at=now_iso(),
        tokens=int(result.usage.total_tokens or 0),
        sentence=sentence,
        narrative=narrative,
        ratio=ratio,
        preferred_patterns=patterns,
        banned_expressions=banned,
        lexicon=lexicon,
        sample_plain=str(data.get("sample_plain") or ""),
        sample_styled=str(data.get("sample_styled") or ""),
    )
    return profile, int(result.usage.total_tokens or 0)


# ==========================================================================
# 预设（逐字移植 mock.js 的 stylePresets）
# ==========================================================================

#: 预设种子：id/name/tagline/sample/category 五要素（与 mock.js 逐字一致）
PRESET_SEEDS: list[dict[str, str]] = [
    {"id": "sp_lean", "name": "冷峻纪实", "tagline": "短句、实感，动作压过内心独白",
     "category": "通用",
     "sample": "雪停了。他把刀插回鞘里，手指冻得发僵。远处有火光，不大，像是有人在烧什么东西。他没有立刻过去。他先数了数地上的脚印——四双，两进两出。"},
    {"id": "sp_lyrical", "name": "长句绵密", "tagline": "长句层叠，感官累积，神话式语调",
     "category": "通用",
     "sample": "雪是后半夜落下来的，一层一层盖住关外的车辙，像是有人执意要把什么痕迹重新抹平，而风偏偏不肯，一遍遍把新雪掀开，露出底下那些不肯安分的旧印子。"},
    {"id": "sp_voice", "name": "声腔叙述", "tagline": "叙述者有自己的脉搏，冷幽默压着苦事",
     "category": "通用",
     "sample": "我在关城做了七年小吏，最大的本事是知道什么时候该看不见。这天晚上我看见了不该看的，还得假装没看见——这活儿我熟。"},
    {"id": "sp_mystery", "name": "古风悬疑", "tagline": "克制的冷笔，线索藏进器物细节",
     "category": "悬疑",
     "sample": "灯是旧的。柄上有一道缺口，缺口里积着黑垢。他盯着那道缺口，许久没有动。"},
    {"id": "sp_zhiguai", "name": "志怪笔记", "tagline": "笔记体，志异而不惊怪",
     "category": "志怪",
     "sample": "北人言铜灯者，多不实。余亲见其一，灯不燃而芯自明，持之者三日内必失一亲。不知其理，记之待考。"},
    {"id": "sp_wuxia", "name": "武侠硬派", "tagline": "刀法写实，招招见骨，少用虚词",
     "category": "武侠",
     "sample": "刀从下往上。他没有格，只侧了半步，刀锋擦着肋过去，割开了棉袄。对手收刀时手腕一沉——这是沉境的毛病，改不掉。"},
    {"id": "sp_urban", "name": "都市冷感", "tagline": "白描都市，情绪藏在动作里",
     "category": "都市",
     "sample": "地铁到站，他没下。对面的人换了三拨，他还在看那份文件。第十七页的数字他背了下来，但他还是再看了一遍，因为他不信自己。"},
    {"id": "sp_epic", "name": "玄幻史诗", "tagline": "宏大修辞，力量体系明确，节奏外放",
     "category": "玄幻",
     "sample": "那一剑落下时，整座雁回关的雪都停了半息。不是风止，是天地先听懂了这一剑的分量，才敢继续落雪。"},
    {"id": "sp_extracted", "name": "寒江独钓 · 从样本提取",
     "tagline": "本书当前文风（提取自参考样本前 8 章）",
     "category": "我的",
     "sample": "退隐的刀客在江边钓了十年鱼。第十一年，那把刀顺流而下，自己漂了回来。他看了很久，然后把它捡起来，插回腰上，没说话。"},
]

_PRESET_PROFILE_CACHE: dict[str, StyleProfile] = {}


def _profile_from_sample(preset: dict[str, str]) -> StyleProfile:
    base = local_metrics(preset.get("sample", ""))
    s = base["sentence"]
    return StyleProfile(
        source=f"预设 · {preset['name']}",
        analyzed_at=now_iso(),
        tokens=0,
        sentence=SentenceStats(mean=s["mean"], p50=s["p50"], p90=s["p90"],
                               min=s["min"], max=s["max"], scale=80.0),
        narrative=NarrativeStyle(person=base["narrative"]["person"],
                                 tense=base["narrative"]["tense"],
                                 pov_switch=base["narrative"]["pov_switch"]),
        ratio=[StyleRatio(label=r["label"], pct=int(r["pct"])) for r in base["ratio"]],
        preferred_patterns=[preset.get("tagline", "")],
    )


def presets() -> list[dict]:
    """9 个预设文风（id/name/tagline/sample/category + 完整 StyleProfile）。"""
    out: list[dict] = []
    for seed in PRESET_SEEDS:
        pid = seed["id"]
        if pid not in _PRESET_PROFILE_CACHE:
            _PRESET_PROFILE_CACHE[pid] = _profile_from_sample(seed)
        out.append({
            "id": pid,
            "name": seed["name"],
            "tagline": seed["tagline"],
            "sample": seed["sample"],
            "category": seed["category"],
            "profile": _PRESET_PROFILE_CACHE[pid],
        })
    return out


def preset_profile(preset_id: str) -> StyleProfile | None:
    for seed in PRESET_SEEDS:
        if seed["id"] == preset_id:
            if preset_id not in _PRESET_PROFILE_CACHE:
                _PRESET_PROFILE_CACHE[preset_id] = _profile_from_sample(seed)
            return _PRESET_PROFILE_CACHE[preset_id]
    return None


# ==========================================================================
# 合并
# ==========================================================================

_BASE_WEIGHT = 0.6


def _blend(base: float, inc: float, w: float = _BASE_WEIGHT) -> float:
    """数值加权平均：base 权重 0.6。任一侧为 0 时直接取另一侧。"""
    if not inc:
        return base
    if not base:
        return inc
    return round(base * w + inc * (1 - w), 4)


def _dedup(seq: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in seq:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def merge_profile(base: StyleProfile, incoming: StyleProfile) -> StyleProfile:
    """与当前档案合并：禁用词取并集，数值取加权平均（base 权重 0.6）。"""
    bs, iss = base.sentence, incoming.sentence
    sentence = SentenceStats(
        mean=_blend(bs.mean, iss.mean),
        p50=_blend(bs.p50, iss.p50),
        p90=_blend(bs.p90, iss.p90),
        # min/max 是极值，取更极的一端比加权平均更符合语义
        min=min([x for x in (bs.min, iss.min) if x > 0] or [0.0]),
        max=max(bs.max, iss.max),
        scale=bs.scale or iss.scale or 80.0,
    )

    ratio_map: dict[str, StyleRatio] = {r.label: r for r in base.ratio}
    for r in incoming.ratio:
        if r.label in ratio_map:
            old = ratio_map[r.label]
            ratio_map[r.label] = StyleRatio(
                label=r.label, pct=int(round(_blend(old.pct, r.pct))), color=old.color or r.color)
        else:
            ratio_map[r.label] = r
    ratio = list(ratio_map.values())

    narrative = NarrativeStyle(
        person=base.narrative.person or incoming.narrative.person,
        tense=base.narrative.tense or incoming.narrative.tense,
        pov_switch=base.narrative.pov_switch or incoming.narrative.pov_switch,
        anchor=base.narrative.anchor or incoming.narrative.anchor,
    )

    lexicon: list[dict[str, str]] = list(base.lexicon)
    have = {x.get("key") for x in lexicon}
    for x in incoming.lexicon:
        if x.get("key") not in have:
            lexicon.append(x)
            have.add(x.get("key"))

    sources = [s for s in (base.source, incoming.source) if s]
    return StyleProfile(
        source=" + ".join(dict.fromkeys(sources)),
        analyzed_at=now_iso(),
        tokens=(base.tokens or 0) + (incoming.tokens or 0),
        sentence=sentence,
        narrative=narrative,
        ratio=ratio,
        preferred_patterns=_dedup(list(base.preferred_patterns) + list(incoming.preferred_patterns)),
        banned_expressions=_dedup(list(base.banned_expressions) + list(incoming.banned_expressions)),
        lexicon=lexicon,
        sample_plain=base.sample_plain or incoming.sample_plain,
        sample_styled=base.sample_styled or incoming.sample_styled,
    )
