"""测试用的假模型：把「模型会说的一切」都换成确定性的罐头响应。

**这不是产品的 mock provider** —— 产品路径必须配真实密钥（用户明确要求）。
这里只是为了让确定性代码（真相文件、规则校验、流水线状态机、API 契约）
能在 CI 里被真正跑通，而不消耗任何额度。

路由方式：读请求里的提示词特征串，判断这是哪个环节的调用。
"""

from __future__ import annotations

import json
from typing import Any, Callable

import httpx

# ==========================================================================
# 罐头内容
# ==========================================================================

CHAPTER_PARAGRAPHS = [
    "雪是后半夜落下来的。沈砚站在城楼上，看着那些碎白的东西一层层盖住关外的车辙。",
    "他左眉骨的那道旧疤在冷风里隐隐发紧。他没有回头，也知道身后是谁。",
    "「你也在看这个。」崔十九把一只青铜小灯放在雪地上。灯没有点，灯芯那一小截却是亮的。",
    "沈砚把灯收进袖中，转身下了城楼。",
]

WORLD = {
    "rules": [
        {"id": "w1", "category": "器物", "kind": "hard",
         "rule": "铜灯须以血引方燃，燃一次持灯者失一段记忆", "note": ""},
        {"id": "w2", "category": "体系", "kind": "hard",
         "rule": "文脉以「名」为薪：被抹名者将从所有人的记忆中消失", "note": ""},
        {"id": "w3", "category": "组织", "kind": "hard",
         "rule": "文脉司不受兵部节制，可先斩后奏", "note": ""},
        {"id": "w4", "category": "地理", "kind": "soft",
         "rule": "雁回关以北只有驿站与烽燧", "note": ""},
    ]
}

CHARACTERS = {
    "characters": [
        {"id": "char_001", "name": "沈砚", "role": "主角", "lead": True,
         "immutable_traits": ["左眉骨有旧疤", "不饮酒", "惯用左手"],
         "personality": "沉默寡言，重承诺。", "speech_style": "短句，很少用感叹词。",
         "relationships": [{"target": "崔十九", "type": "旧识", "note": "彼此试探"}],
         "state": {"location": "北境·雁回关", "status": "左臂有刀伤"},
         "first_appearance": 1, "deceased": False},
        {"id": "char_002", "name": "崔十九", "role": "关键配角", "lead": False,
         "immutable_traits": ["右手缺两指", "总按着刀柄"],
         "personality": "亦正亦邪。", "speech_style": "爱用反问。",
         "relationships": [], "state": {"location": "雁回关·城楼", "status": "未受伤"},
         "first_appearance": 1, "deceased": False},
    ]
}

OUTLINE = {
    "compass": {"endgame": "沈砚揭开王朝以活人为薪的真相，亲手熄灭铜灯。",
                "active_threads": ["青铜灯与文脉同源", "沈定山之死被掩盖"],
                "scale_estimate": "预计 2 卷 · 约 6 章"},
    "volumes": [
        {"name": "第一卷 · 雁回关篇", "from_chapter": 1, "to_chapter": 3,
         "goal": "识破通敌，铜灯初亮", "est_chapters": 3, "status": "expanded"},
        {"name": "第二卷 · 风起文脉", "from_chapter": 4, "to_chapter": 6,
         "goal": "文脉司登场", "est_chapters": 3, "status": "skeleton"},
    ],
    "nodes": [
        {"chapter": 1, "title": "雪夜换防", "volume": "第一卷 · 雁回关篇", "arc": "雁回关篇",
         "goal": "引入铜灯与主角处境", "beats": ["雪夜巡查", "遇崔十九", "铜灯初现"],
         "rationale": "把铜灯第一次露面放在第 1 章，为第 3 章的显性呼应做铺垫。",
         "pov": "沈砚", "intensity": 3, "status": "planned",
         "story_at": "当夜",
         "timeline": [{"at": "当夜", "label": "雪夜换防", "kind": "now"},
                      {"at": "二十年前", "label": "黑水营溃口", "kind": "backstory"}]},
        {"chapter": 2, "title": "验尸文书", "volume": "第一卷 · 雁回关篇", "arc": "雁回关篇",
         "goal": "埋下父亲死因的疑点", "beats": ["收到文书", "缺页", "决定深查"],
         "rationale": "为第二卷的文脉真相埋线。", "pov": "沈砚", "intensity": 3,
         "status": "planned", "story_at": "次日",
         "timeline": [{"at": "次日", "label": "文书缺页", "kind": "now"}]},
        {"chapter": 3, "title": "铜灯初亮", "volume": "第一卷 · 雁回关篇", "arc": "雁回关篇",
         "goal": "铜灯显性呼应，卷末钩子", "beats": ["对峙", "放走旧友", "灯芯自亮"],
         "rationale": "放走旧友是第 5 章反水的动机铺垫。", "pov": "沈砚", "intensity": 5,
         "status": "planned", "story_at": "第三日",
         "timeline": [{"at": "第三日", "label": "铜灯初亮", "kind": "now"}]},
    ],
    # 依赖边的方向约定：from = 后章（它依赖别人），to = 前章（被依赖）
    "edges": [
        {"from": 3, "to": 1, "type": "setup", "note": "第 3 章的铜灯呼应追溯到第 1 章"},
        {"from": 3, "to": 2, "type": "causality", "note": "第 3 章深查的动因来自第 2 章"},
        {"from": 5, "to": 3, "type": "motivation", "note": "第 5 章反水依赖第 3 章的放走行为"},
    ],
}

CHAPTER_PLAN = {
    "node": {"chapter": 2, "title": "验尸文书", "goal": "确认父亲之死另有隐情",
             "beats": ["接收文书", "发现缺页", "不再按规矩来"],
             "rationale": "本章只给疑点不给结论，把推断留到第 3 章。",
             "pov": "沈砚", "intensity": 4, "story_at": "次日",
             "timeline": [{"at": "次日", "label": "文书缺页", "kind": "now"}]},
    "new_edges": [{"from": 2, "to": 1, "type": "setup", "note": "第 2 章承接第 1 章的铜灯"}],
}

ROLL_VOLUME = {
    "nodes": [
        {"chapter": 4, "title": "入境", "goal": "文脉司正式登场", "beats": ["验灯", "传召"],
         "rationale": "第 1 章的铜灯在此兑现。", "pov": "沈砚", "intensity": 4,
         "story_at": "十日后", "timeline": [{"at": "十日后", "label": "文脉司入境", "kind": "now"}]},
        {"chapter": 5, "title": "旧友刀锋", "goal": "旧友反水", "beats": ["重逢", "反水"],
         "rationale": "依赖第 3 章的放走行为。", "pov": "沈砚", "intensity": 5,
         "story_at": "同月", "timeline": [{"at": "同月", "label": "旧友反水", "kind": "now"}]},
        {"chapter": 6, "title": "以血引灯", "goal": "揭示铜灯与活人祭祀的关系",
         "beats": ["验灯", "以血引燃"], "rationale": "卷末收束。", "pov": "沈砚",
         "intensity": 5, "story_at": "同月末",
         "timeline": [{"at": "同月末", "label": "以血引灯", "kind": "now"}]},
    ],
    "edges": [{"from": 5, "to": 3, "type": "payoff", "note": "第 3 章埋的伏笔在此回收"}],
    "compass": {"refresh_at": "第 1 卷末刷新"},
}

CHAT = {
    "reply": "先问一个：这个「小吏」是哪种人？这决定了他查案时的所有选择。",
    "options": ["认死理、不肯低头的硬骨头", "圆滑求生、但被逼到墙角", "我自己说"],
    "records": {"genre": "古风悬疑", "premise": "北境小吏追查失踪案，牵出文脉真相",
                "protagonist": "沈砚，关城小吏，沉默、认死理",
                "conflict": "查案 → 发现至亲之死被掩盖", "tone": "冷峻、克制"},
    "ready": False,
}

AUDIT_L2 = {
    "items": [
        # 证据在正文里真实存在 → 应保留
        {"dim": "设定冲突", "severity": "major",
         "evidence": "灯没有点，灯芯那一小截却是亮的",
         "suggestion": "与硬约束「铜灯须以血引方燃」冲突，建议改为割破指尖后自行亮起。"},
        # 证据在正文里不存在 → 必须被丢弃
        {"dim": "时间线矛盾", "severity": "blocker",
         "evidence": "这一段原文里根本不存在的内容",
         "suggestion": "编造的证据，应被丢弃。"},
        # 无证据 → 必须被丢弃
        {"dim": "节奏单调", "severity": "minor", "evidence": "", "suggestion": "感觉有点慢。"},
    ]
}

REVIEW = {
    "dims": [
        {"dim": "设定一致性", "score": 72, "evidence": "灯没有点，灯芯那一小截却是亮的",
         "note": "1 处 major 冲突待裁定"},
        {"dim": "角色行为", "score": 66, "evidence": "他左眉骨的那道旧疤在冷风里隐隐发紧",
         "note": "辨认依据略薄"},
        {"dim": "节奏", "score": 84, "evidence": "雪是后半夜落下来的", "note": "推进紧凑"},
        {"dim": "叙事连贯", "score": 88, "evidence": "沈砚把灯收进袖中，转身下了城楼", "note": ""},
        {"dim": "伏笔", "score": 79, "evidence": "把一只青铜小灯放在雪地上", "note": "伏笔显性呼应"},
        {"dim": "钩子", "score": 91, "evidence": "灯芯那一小截却是亮的", "note": "卷末指向明确"},
        {"dim": "审美品质", "score": 81, "evidence": "雪是后半夜落下来的",
         "note": "描写质感佳；对话区分度偏弱"},
    ]
}

ARCHIVIST = {
    "summary": "沈砚在雪夜城楼上遇到崔十九，对方留下一只青铜小灯。灯未点燃，灯芯却自明，"
               "沈砚收灯回关，疑云未解。",
    "key_facts": ["青铜小灯未点火而灯芯自明", "崔十九主动向沈砚示好"],
    "characters_present": ["沈砚", "崔十九"],
    "hooks_planted": [{"content": "青铜小灯的灯芯为何自明", "suggested_resolve_by": 3,
                       "importance": "major"}],
    "hooks_resolved": [],
    "state": {"situation": "沈砚得到一只来历不明的铜灯，北境局势因通敌案紧张。",
              "location_focus": "雁回关·城楼",
              "open_questions": ["铜灯的来历", "崔十九究竟站在哪一边"]},
    "subplot_updates": [{"name": "追查失踪案", "summary": "从驿馆火案到雁回关通敌",
                         "chapters": [1]}],
    "character_state_changes": [{"name": "沈砚",
                                 "changes": {"location": "北境·雁回关", "status": "得到铜灯"}}],
}

REVISE = {
    "patches": [
        {"para": 3, "before": "灯没有点，灯芯那一小截却是亮的。",
         "after": "沈砚割破指尖，血珠落在灯芯上。那一小截，亮了。",
         "reason": "兑现硬约束「铜灯须以血引方燃」"},
    ]
}

DEAI = {
    "patches": [
        {"para": 2, "before": "他左眉骨的那道旧疤在冷风里隐隐发紧。",
         "after": "冷风掠过左眉骨，那道旧疤紧了紧。",
         "reason": "消除书面化的副词堆叠，改为动作化表达"},
    ]
}

STEER_CURRENT = {
    "intent": "把第 1 章的雪夜场景压缩一些，节奏更紧。",
    "action": "compress", "target_chapter": 1, "scope": "current",
    "affected_chapters": [1], "steps": ["压缩雪景描写", "对白往前挪"],
    "requires_confirmation": False, "reason": "只影响当前章，不触及已定稿内容。",
}

STEER_COMMITTED = {
    "intent": "把主角的旧疤来历改掉。",
    "action": "adjust_character", "target_chapter": 1, "scope": "committed",
    "affected_chapters": [1], "steps": ["改写第 1 章相关描写"],
    "requires_confirmation": True, "reason": "第 1 章已定稿。",
}

DISASSEMBLE = {
    "characters": [
        {"name": "江砚舟", "role": "主角", "traits": ["左手使刀", "常年戴斗笠"],
         "relations": [{"target": "秦九娘", "type": "旧识", "note": "彼此试探"}]},
    ],
    "merges": [],
}

DISASSEMBLE_WORLD = {
    "rules": [{"category": "体系", "kind": "hard",
               "rule": "刀法分「沉、滞、断」三境，入断境需以命换", "note": ""}],
}

DISASSEMBLE_HOOKS = {
    "hooks": [{"content": "江砚舟丢刀那年的江汛异常提前", "planted_chapter": 2,
               "resolved_chapter": 27, "importance": "major",
               "evidence": "那年水来得早"}],
}


# ==========================================================================
# 路由
# ==========================================================================

def _prompt_text(body: dict[str, Any]) -> str:
    return "\n".join(str(m.get("content") or "") for m in (body.get("messages") or []))


_ROUTES: list[tuple[str, Any]] = [
    # 拆书的三个抽取提示词必须排在前面：它们也含「世界观规则」「伏笔」等字样
    ("角色与人物关系", DISASSEMBLE),
    ("抽取**世界观规则**", DISASSEMBLE_WORLD),
    ("伏笔（埋设）与回收点", DISASSEMBLE_HOOKS),
    ("档案管理员", ARCHIVIST),
    ("小说修订编辑", REVISE),
    ("专门消除", DEAI),
    ("干预解析器", STEER_CURRENT),
    ("立项助手", CHAT),
    # 以下五个用**完整句式**做标记。不能用「世界观规则」「详细章纲」这类短语：
    # OUTLINE / CHAPTER_PLAN 的提示词里会内嵌角色卡与世界规则，短语会互相误命中。
    ("建立**世界观规则**", WORLD),
    ("建立**角色矩阵**", CHARACTERS),
    ("设计**滚动规划**的前", OUTLINE),
    ("把一卷**骨架弧**展开为详细章纲", ROLL_VOLUME),
    ("写**详细章纲**", CHAPTER_PLAN),
    ("严谨的中文长篇小说审校", AUDIT_L2),
    ("资深中文小说编辑", REVIEW),
]

#: 允许测试替换某些环节的返回（键是提示词特征串，命中最先匹配者）
OVERRIDES: dict[str, Any] = {}


def route_payload(prompt: str) -> Any:
    for marker, payload in OVERRIDES.items():
        if marker in prompt:
            return payload
    for marker, payload in _ROUTES:
        if marker in prompt:
            return payload
    return {"ok": True}


# ==========================================================================
# httpx 传输层
# ==========================================================================

def make_handler(record: list[dict[str, Any]] | None = None) -> Callable[[httpx.Request], httpx.Response]:
    def handler(request: httpx.Request) -> httpx.Response:
        try:
            body = json.loads(request.content.decode("utf-8"))
        except Exception:
            body = {}
        prompt = _prompt_text(body)
        if record is not None:
            record.append({"model": body.get("model"), "stream": bool(body.get("stream")),
                           "prompt": prompt[:200]})

        if body.get("stream"):
            lines = []
            for chunk in CHAPTER_PARAGRAPHS:
                lines.append("data: " + json.dumps(
                    {"choices": [{"delta": {"content": chunk + "\n\n"}, "finish_reason": None}]},
                    ensure_ascii=False))
            lines.append("data: " + json.dumps(
                {"choices": [{"delta": {}, "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 1200, "completion_tokens": 320,
                           "total_tokens": 1520}}, ensure_ascii=False))
            lines.append("data: [DONE]")
            return httpx.Response(200, text="\n\n".join(lines) + "\n\n",
                                  headers={"content-type": "text/event-stream"})

        payload = route_payload(prompt)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 800, "completion_tokens": 240, "total_tokens": 1040},
        })

    return handler


def fake_transport(record: list[dict[str, Any]] | None = None) -> httpx.MockTransport:
    return httpx.MockTransport(make_handler(record))
