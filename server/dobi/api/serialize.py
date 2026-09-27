"""API 序列化：内部 snake_case ⇄ 前端 camelCase。

内部数据模型与规划文档 §5.2 逐字对应（snake_case）；前端沿用原型时代就定下的 camelCase。
转换是**机械的**——只改键名大小写，不改结构、不丢字段。

⚠️ 踩过的坑：必须**递归进列表**。早期版本对「pydantic 模型组成的列表」直接返回原对象，
FastAPI 就按 snake_case 序列化了，前端拿到 `story_at` 而不是 `storyAt`。
"""

from __future__ import annotations

import re
from dataclasses import asdict, is_dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict

__all__ = ["camelize", "to_api", "table", "one", "api_alias", "ApiBody"]

# 已经是前端约定的键，不参与转换
_KEEP = {"from", "to", "id", "n", "ref", "url", "command"}

_CAMEL_RE = re.compile(r"_([a-z0-9])")


def _key(k: Any) -> Any:
    name = str(k)
    if name in _KEEP or not name:
        return name
    return _CAMEL_RE.sub(lambda m: m.group(1).upper(), name)


def to_api(value: Any) -> Any:
    """pydantic 模型 / dataclass / dict / list → 前端可用的 camelCase 结构。

    递归处理，列表与嵌套结构一律穿透。
    """
    if value is None:
        return None
    if isinstance(value, dict):
        return {_key(k): to_api(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_api(v) for v in value]

    public = getattr(value, "public", None)
    if callable(public):
        return to_api(public())
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return to_api(dump())
    if is_dataclass(value) and not isinstance(value, type):
        return to_api(asdict(value))
    # 枚举 / 基本类型原样返回
    return value


#: 兼容别名：老代码里用 `camelize` 的地方仍然可用
camelize = to_api


def api_alias(name: str) -> str:
    """字段名 → 前端 camelCase。与 `to_api` 同一套规则，保证**收发对称**。"""
    return _key(name)


class ApiBody(BaseModel):
    """所有请求体的基类。

    前端一律发 camelCase（`plantedChapter` / `sourceIds` / `runL2`）；
    这里用同一个别名生成器接住，同时保留 snake_case 以方便脚本与测试。
    """

    model_config = ConfigDict(
        alias_generator=api_alias,
        validate_by_name=True,
        validate_by_alias=True,
    )


def table(items: Any, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"items": to_api(items)}
    payload.update({key: to_api(value) for key, value in extra.items()})
    return payload


def one(item: Any, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = to_api(item) or {}
    payload.update({key: to_api(value) for key, value in extra.items()})
    return payload
