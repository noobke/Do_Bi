"""统一错误类型。

约定：所有面向用户的错误都带 `code`（机器可读）与 `message`（**面向作者的中文**），
`detail` 放工程细节（不入正文，仅日志与排查用）。错误文案遵守设计契约第 10 条
「面向作者，不面向工程师」——不得出现 provider / token / JSON Schema 这类词汇。
"""

from __future__ import annotations

from typing import Any


class DobiError(Exception):
    """所有业务错误的基类。"""

    status_code: int = 500
    code: str = "internal"

    def __init__(self, message: str, *, detail: Any = None, code: str | None = None,
                 status_code: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.detail is not None:
            payload["detail"] = self.detail
        return payload


class BadRequest(DobiError):
    status_code = 400
    code = "bad_request"


class NotFound(DobiError):
    status_code = 404
    code = "not_found"


class Conflict(DobiError):
    """并发冲突：同一本书同时被两个写入者操作（项目级锁）。"""

    status_code = 409
    code = "conflict"


class ValidationFailed(DobiError):
    """Proposal 校验未通过——**不写入**真相文件。"""

    status_code = 422
    code = "validation_failed"


class NotConfigured(DobiError):
    """未配置可用的模型密钥。用户需去「设置」里配置一个服务商。"""

    status_code = 503
    code = "not_configured"


class BudgetExceeded(DobiError):
    """预算熔断：达阈值后挂起，不静默烧钱。"""

    status_code = 402
    code = "budget_exceeded"


class ConfigError(DobiError):
    """配置文件缺失 / 非法。属于部署问题，需要用户按文档修正。"""

    status_code = 500
    code = "config_error"


class ProviderError(DobiError):
    """模型服务返回错误（网络 / 5xx / 超时）。"""

    status_code = 502
    code = "provider_error"


class ProviderAuthError(ProviderError):
    """密钥无效或权限不足——**不重试**。"""

    code = "provider_auth"


class ModelOutputError(ProviderError):
    """模型输出不是合法 JSON，且容错解析与一次带错重试后仍失败。"""

    code = "model_output"


class StopRequested(Exception):
    """用户在中途请求停止（流式生成 / 整本生产）。不是错误，是控制流。"""


class PausedByStopCondition(Exception):
    """全自动模式命中 stop_condition，挂起等待人工。"""

    def __init__(self, reason: str, detail: Any = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail
