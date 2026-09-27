"""配置系统。

三层：
1. **环境变量 / .env** → `Settings`（路径、服务、超时、预算）
2. **`config/providers.json`** → `ProviderSpec[]`（服务商与模型清单；**只存环境变量名，不存密钥**）
3. **`config/model_roles.json`** → `ModelRoleSpec[]`（哪个环节用哪档模型、温度、输出格式）

密钥解析规则：密钥值只从环境变量读取（`api_key_ref` 是变量名）。
`ProviderSpec.public()` 对外永远只暴露「已配置 / 未配置」，前端拿不到任何密钥片段。
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from dotenv import load_dotenv
from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .errors import ConfigError

SERVER_ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = SERVER_ROOT / "config"


# ==========================================================================
# 模型与服务商规格
# ==========================================================================

class ModelSpec(BaseModel):
    """单个模型的声明式能力。审计/评审需要 JSON 输出，正文需要流式——能力不足会在降级链中途断掉。"""

    name: str
    context_window: int = 128_000
    max_output: int = 4_096
    supports_json: bool = True
    supports_stream: bool = True
    supports_tools: bool = False
    # 计价（元 / 百万 token）。**示例参考价，请按服务商实际价目维护**；
    # 留 0 表示该模型不计价，此时预算熔断退化为「按 token 数阈值」判断。
    price_in: float = 0.0
    price_out: float = 0.0
    note: str = ""

    def public(self) -> dict[str, Any]:
        return self.model_dump()


class ProviderProbe(BaseModel):
    """运行时能力探测结果（首次调用后写回 providers.json 的 `probed` 字段）。"""

    ok: bool = False
    latency_ms: int | None = None
    checked_at: str | None = None
    error: str | None = None
    # 探测到的参数适配：部分厂商用 max_completion_tokens 而非 max_tokens
    max_tokens_field: Literal["max_tokens", "max_completion_tokens"] = "max_tokens"
    supports_response_format: bool = True
    supports_stream_options: bool = True
    supports_tools: bool = False


class ProviderSpec(BaseModel):
    name: str
    base_url: str
    api_key_ref: str
    models: list[ModelSpec] = Field(default_factory=list)
    priority: int = 1
    enabled: bool = True
    note: str = ""
    probed: ProviderProbe = Field(default_factory=ProviderProbe)

    # ---------- 密钥：只读环境变量，且只在本进程内可见 ----------
    @property
    def api_key(self) -> str | None:
        raw = os.environ.get(self.api_key_ref, "").strip()
        return raw or None

    @property
    def configured(self) -> bool:
        return self.api_key is not None

    def model(self, name: str) -> ModelSpec | None:
        for m in self.models:
            if m.name == name:
                return m
        return None

    def public(self, mask_keep: int = 4) -> dict[str, Any]:
        """对外视图。**绝不包含密钥本体**，只给「已配置 + 脱敏指纹」，便于用户核对是否配对。"""
        key = self.api_key
        return {
            "name": self.name,
            "base_url": self.base_url,
            "api_key_ref": self.api_key_ref,
            "configured": key is not None,
            "fingerprint": _mask(key, mask_keep) if key else None,
            "models": [m.public() for m in self.models],
            "priority": self.priority,
            "enabled": self.enabled,
            "note": self.note,
            "probed": self.probed.model_dump(),
        }


def _mask(secret: str | None, keep: int = 4) -> str | None:
    """密钥脱敏：只保留头尾极短片段，中间一律星号。日志与接口共用此函数。"""
    if not secret:
        return None
    keep = max(1, keep)
    if len(secret) <= keep * 2:
        return "*" * len(secret)
    return f"{secret[:keep]}{'*' * 8}{secret[-keep:]}"


# ==========================================================================
# 模型角色（哪个环节用哪档模型）
# ==========================================================================

class ModelRoleSpec(BaseModel):
    """一个流水线环节的模型配置。`key` 是内部标识，`label` 是给作者看的中文名。"""

    key: str
    label: str
    model: str
    temperature: float = 0.7
    fmt: Literal["json", "text", "patch"] = "json"
    max_tokens: int = 4_096
    provider: str | None = None          # 指定服务商；None = 按 priority 自动挑
    fallbacks: list[str] = Field(default_factory=list)  # ["ProviderName/model-name", ...]

    def public(self) -> dict[str, Any]:
        fmt_label = {"json": "JSON", "text": "流式文本", "patch": "JSON Patch"}[self.fmt]
        return {
            "step": self.label,
            "key": self.key,
            "model": self.model,
            "provider": self.provider,
            "temperature": f"{self.temperature:.2f}",
            "format": fmt_label,
        }


# ==========================================================================
# 环境配置
# ==========================================================================

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="DOBI_",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_dir: Path = Path("./data")
    #: 配置目录（providers.json / model_roles.json / mcp.json）。
    #: 留空则用仓库里的 `server/config/`；部署时可以把配置挂到别处（测试与多环境都用得上）。
    config_dir: Path | None = None
    host: str = "127.0.0.1"
    port: int = 8000
    cors_origins: str = "http://127.0.0.1:5173,http://localhost:5173"
    key_mask_keep: int = 4

    default_budget: float = 80.00
    connect_timeout: float = 15.0
    read_timeout: float = 300.0
    max_retries: int = 3
    retry_base_delay: float = 1.5
    output_reserve_pct: int = 20

    @field_validator("data_dir", mode="after")
    @classmethod
    def _abs_data_dir(cls, v: Path) -> Path:
        return v if v.is_absolute() else (SERVER_ROOT / v).resolve()

    @field_validator("config_dir", mode="after")
    @classmethod
    def _abs_config_dir(cls, v: Path | None) -> Path | None:
        if v is None:
            return None
        return v if v.is_absolute() else (SERVER_ROOT / v).resolve()

    @property
    def origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def projects_dir(self) -> Path:
        return self.data_dir / "projects"

    @property
    def providers_file(self) -> Path:
        return (self.config_dir or CONFIG_DIR) / "providers.json"

    @property
    def roles_file(self) -> Path:
        return (self.config_dir or CONFIG_DIR) / "model_roles.json"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.projects_dir.mkdir(parents=True, exist_ok=True)


# 上下文分层预算（规划文档 §6.5）。文风档案是「确定性必选」，不占配额、不参与检索竞争。
CONTEXT_BUDGET_SPLIT: dict[str, int] = {
    "system": 5,
    "cast": 15,
    "facts": 10,
    "summary": 20,
    "draft": 30,
    "output": 20,
}

# 审计严重度 → 是否阻塞定稿（契约第 10 条：对外用作者语言）
SEVERITY_LABELS: dict[str, str] = {
    "blocker": "阻塞定稿",
    "major": "重点",
    "minor": "建议",
}
SEVERITY_ORDER: dict[str, int] = {"blocker": 0, "major": 1, "minor": 2}


# ==========================================================================
# 载入器
# ==========================================================================

def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"配置文件不是合法 JSON：{path.name}（{exc}）") from exc


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    # 显式传入 `.env` 路径，保证「读」与「写」（save_secrets）用同一个文件。
    path = env_file_path()
    # 关键：把 `.env` 的键**灌进 os.environ**，否则 `ProviderSpec.api_key`
    # （读的是 os.environ）永远看不到密钥——「填 .env 就能用」会变成假象。
    # override=False：真实环境变量优先于 .env。
    if path.exists():
        load_dotenv(path, override=False)
    return Settings(_env_file=path)


def load_providers() -> list[ProviderSpec]:
    """读取服务商清单，按 priority 升序（= 降级链顺序）。"""
    raw = _read_json(get_settings().providers_file, {})
    items = raw.get("providers", raw if isinstance(raw, list) else [])
    specs = [ProviderSpec.model_validate(x) for x in items]
    return sorted(specs, key=lambda p: p.priority)


def load_roles() -> dict[str, ModelRoleSpec]:
    raw = _read_json(get_settings().roles_file, {})
    items = raw.get("roles", raw if isinstance(raw, list) else [])
    return {r["key"]: ModelRoleSpec.model_validate(r) for r in items}


def save_providers(specs: list[ProviderSpec]) -> None:
    path = get_settings().providers_file
    payload = {"providers": [s.model_dump() for s in sorted(specs, key=lambda p: p.priority)]}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def reload_config() -> None:
    """配置改动（如设置页写入 providers.json）后调用，清缓存。"""
    get_settings.cache_clear()


def env_file_path() -> Path:
    """`.env` 位置。默认 `server/.env`；`DOBI_ENV_FILE` 可指向别处（测试与多环境部署用）。

    密钥的**读**（`Settings`）与**写**（`save_secrets`）都以这里为准，
    否则「界面填的密钥」重启后会读不到。
    """
    raw = os.environ.get("DOBI_ENV_FILE", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return SERVER_ROOT / ".env"


def save_secrets(updates: dict[str, str | None]) -> Path:
    """把密钥写进 `.env` 并立即生效（同步更新 `os.environ`，无需重启）。

    `value=None` 或空串表示清除该变量。只改这几行，其余内容（含注释）原样保留。
    返回值是写入的路径，**不返回密钥本体**。
    """
    path = env_file_path()
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    pending = dict(updates)
    out: list[str] = []
    for line in lines:
        stripped = line.lstrip()
        name = stripped.split("=", 1)[0].strip() if "=" in stripped else ""
        if name in pending and not stripped.startswith("#"):
            value = pending.pop(name)
            out.append(f"{name}={value}" if value else f"{name}=")
        else:
            out.append(line)
    for name, value in pending.items():
        out.append(f"{name}={value}" if value else f"{name}=")

    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    for name, value in updates.items():
        if value:
            os.environ[name] = value
        else:
            os.environ.pop(name, None)
    return path


def mask(secret: str | None) -> str | None:
    return _mask(secret, get_settings().key_mask_keep)
