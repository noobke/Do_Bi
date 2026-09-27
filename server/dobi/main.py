"""FastAPI 应用入口。

- 所有业务错误统一转成 `{code, message, detail?}`，`message` 是**面向作者的中文**
- CORS 白名单来自 `DOBI_CORS_ORIGINS`（默认放行 Vite 开发服务器）
- **不做静态文件托管**：前端是独立的 React 工程（`web/`），生产部署时由它自己的
  服务器托管，或把 `web/dist` 交给任意静态服务器。后端只出 API。
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .api.routes import api_router
from .config import get_settings, load_providers
from .errors import DobiError

log = logging.getLogger("dobi")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    settings.ensure_dirs()
    providers = load_providers()
    usable = [p.name for p in providers if p.enabled and p.configured]
    if usable:
        log.info("可用服务商：%s（按 priority 构成降级链）", "、".join(usable))
    else:
        log.warning("尚未配置任何模型密钥。生成类接口会返回 503 —— "
                    "请复制 .env.example 为 .env 并至少填一个密钥。")
    log.info("数据目录：%s", settings.data_dir)
    yield


app = FastAPI(
    title="Do_Bi 小说创作台 · API",
    version=__version__,
    description=(
        "一致性内核 + 双模式全自动流水线。\n\n"
        "约定：错误体统一为 `{code, message, detail?}`，`message` 已是面向作者的文案，"
        "前端可直接展示。"
    ),
    lifespan=lifespan,
)

_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-Id"],
)


# ==========================================================================
# 统一错误出口
# ==========================================================================

@app.exception_handler(DobiError)
async def handle_dobi_error(request: Request, exc: DobiError) -> JSONResponse:
    if exc.status_code >= 500:
        log.exception("业务错误 %s：%s", exc.code, exc.message)
    return JSONResponse(status_code=exc.status_code, content=exc.to_dict())


#: pydantic 错误类型 → 面向作者的中文（设计契约第 10 条：不向作者暴露工程文案）。
#: 英文原文一概只进 `detail`，供排查，不进 `message`。
_VALIDATION_MESSAGES: dict[str, str] = {
    "missing": "必填",
    "string_too_short": "太短了",
    "string_too_long": "太长了",
    "string_type": "要填文字",
    "int_parsing": "要填数字",
    "int_type": "要填数字",
    "float_parsing": "要填数字",
    "float_type": "要填数字",
    "bool_parsing": "要填「是」或「否」",
    "list_type": "要填列表",
    "dict_type": "格式不正确",
    "enum": "不是可选项",
    "value_error": "填写有误",
}


def _validation_message(err: dict[str, Any]) -> str:
    return _VALIDATION_MESSAGES.get(str(err.get("type") or ""), "填写有误")


@app.exception_handler(RequestValidationError)
async def handle_validation(request: Request, exc: RequestValidationError) -> JSONResponse:
    first = (exc.errors() or [{}])[0]
    loc = ".".join(str(x) for x in first.get("loc", []) if x not in ("body", "query"))
    message = _validation_message(first)
    return JSONResponse(status_code=400, content={
        "code": "bad_request",
        "message": f"「{loc}」{message}" if loc else message,
        "detail": exc.errors()[:5],
    })


@app.exception_handler(ValueError)
async def handle_value_error(request: Request, exc: ValueError) -> JSONResponse:
    """业务层的 `ValueError` 多为「参数不对/前置条件没满足」，按 400 处理而不是 500。"""
    return JSONResponse(status_code=400, content={
        "code": "bad_request", "message": str(exc) or "请求无法执行。",
    })


@app.exception_handler(Exception)
async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
    log.exception("未预期错误：%s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={
        "code": "internal",
        "message": "服务内部出错了。详情已写入服务端日志，可重试一次；若持续出现请查看日志。",
        "detail": {"path": request.url.path, "error": type(exc).__name__},
    })


app.include_router(api_router)


@app.get("/", include_in_schema=False)
def root() -> dict[str, Any]:
    return {
        "name": "Do_Bi 小说创作台 · API",
        "version": __version__,
        "docs": "/docs",
        "health": "/api/health",
    }
