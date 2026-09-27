"""模型输出的 JSON 容错解析。

对应规划文档 §6.6「输出非法 JSON」对策，四级降级：

1. 直接 `json.loads`
2. 剥离 ```json … ``` 代码块（含四种围栏写法）后重试
3. 截取首个**括号平衡**的 `{…}` / `[…]` 片段，再修掉尾逗号、单引号键、中文全角引号
4. 全失败 → 抛 `ValueError`，由调用方带上错误信息重试一次

不做的事情：不猜语义、不补字段。解析成功 ≠ 内容合法，字段校验交给 pydantic。
"""

from __future__ import annotations

import json
import re
from typing import Any

__all__ = ["extract_json", "looks_like_json", "JSONExtractError"]


class JSONExtractError(ValueError):
    """文本中找不到任何可解析的 JSON。"""


_FENCE_RE = re.compile(r"```(?:json|JSON|javascript|js)?\s*\n?(.*?)```", re.DOTALL)
_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")
_SMART_QUOTES = {
    "\u201c": '"', "\u201d": '"',   # “ ”
    "\u2018": "'", "\u2019": "'",   # ‘ ’
    "\uff02": '"',                  # ＂
}
# 形如  { key: ... } / , key: ... 的裸键（模型偶尔漏引号）
_BARE_KEY_RE = re.compile(r'([{,]\s*)([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff\-]*)(\s*:)')
_TRAILING_TEXT_RE = re.compile(r"[\s。．，,.]+$")


def looks_like_json(text: str) -> bool:
    stripped = (text or "").strip()
    return stripped.startswith("{") or stripped.startswith("[")


def _balanced_slice(text: str) -> str | None:
    """截取首个括号平衡片段。字符串内的括号不计入深度。"""
    start = None
    opener = closer = ""
    for idx, ch in enumerate(text):
        if ch in "{[":
            start = idx
            opener, closer = ch, "}" if ch == "{" else "]"
            break
    if start is None:
        return None

    depth = 0
    in_str = False
    escape = False
    for idx in range(start, len(text)):
        ch = text[idx]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return text[start:idx + 1]
    # 未闭合：模型被 max_tokens 截断。返回剩余全部，交给下面的修补赌一把。
    return text[start:]


def _repair(fragment: str) -> str:
    fixed = fragment
    for bad, good in _SMART_QUOTES.items():
        fixed = fixed.replace(bad, good)
    fixed = _TRAILING_COMMA_RE.sub(r"\1", fixed)
    fixed = _BARE_KEY_RE.sub(r'\1"\2"\3', fixed)
    # 截断补救：补齐未闭合的引号与括号
    if fixed.count('"') % 2 == 1:
        fixed += '"'
    for opener, closer in (("{", "}"), ("[", "]")):
        diff = fixed.count(opener) - fixed.count(closer)
        if diff > 0:
            fixed += closer * diff
    return _TRAILING_TEXT_RE.sub("", fixed)


def extract_json(text: str) -> Any:
    """把模型输出解析成 Python 对象。失败抛 `JSONExtractError`。"""
    raw = (text or "").strip()
    if not raw:
        raise JSONExtractError("模型返回了空内容")

    # 1) 直接解析
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    candidates: list[str] = []

    # 2) 代码块
    for match in _FENCE_RE.finditer(raw):
        candidates.append(match.group(1))

    # 3) 平衡片段
    sliced = _balanced_slice(raw)
    if sliced:
        candidates.append(sliced)

    candidates.append(raw)

    for cand in candidates:
        for attempt in (cand, _repair(cand)):
            try:
                return json.loads(attempt.strip())
            except (json.JSONDecodeError, ValueError):
                continue

    preview = raw[:400].replace("\n", " ")
    raise JSONExtractError(f"无法从模型输出中解析出 JSON。原文开头：{preview}")
