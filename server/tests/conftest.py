"""测试夹具。

三条纪律：
1. **测试不碰真实厂商**：所有模型调用走 `httpx.MockTransport`（见 `fake_llm.py`）。
   产品路径依然必须配真实密钥——这不是 mock provider。
2. **每个用例一个独立数据目录**：`DOBI_DATA_DIR` 指向 tmp_path，测完即弃。
3. **配置也隔离**：`config/` 整份复制到 tmp_path 再改指过去，
   这样「切换服务商启用状态」这类测试不会把状态写回仓库里的真实配置。
4. **`.env` 也隔离**：`DOBI_ENV_FILE` 指向 tmp_path，
   否则「在设置页填密钥」这类测试会覆盖开发者真实的 `server/.env`。
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

#: 必须在导入任何被测模块**之前**执行：`dobi.main` 在导入期就会读一次 `Settings`
#: （CORS 白名单），若此时 `DOBI_ENV_FILE` 未设置，开发者真实的 `server/.env`
#: 会被灌进 `os.environ`，污染整个测试会话（真实密钥泄漏进断言）。
os.environ.setdefault(
    "DOBI_ENV_FILE", str(Path(tempfile.gettempdir()) / "dobi-tests-no-such.env"))

import httpx  # noqa: E402
import pytest  # noqa: E402

import dobi.config as config_mod  # noqa: E402
from dobi.config import get_settings, reload_config  # noqa: E402
from dobi.core.store import ProjectStore  # noqa: E402
from dobi.llm.provider import LLMClient  # noqa: E402

import fake_llm  # noqa: E402

_SHIPPED_CONFIG = Path(config_mod.__file__).resolve().parent.parent / "config"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    # ---- 数据目录隔离 ----
    monkeypatch.setenv("DOBI_DATA_DIR", str(tmp_path / "data"))
    # ---- 配置目录隔离 ----
    tmp_config = tmp_path / "config"
    tmp_config.mkdir(parents=True, exist_ok=True)
    for name in ("providers.json", "model_roles.json", "mcp.json"):
        src = _SHIPPED_CONFIG / name
        if src.exists():
            shutil.copy(src, tmp_config / name)
    monkeypatch.setattr(config_mod, "CONFIG_DIR", tmp_config)
    # ---- .env 隔离（写密钥的接口会落盘到这个文件）----
    tmp_env = tmp_path / ".env"
    monkeypatch.setenv("DOBI_ENV_FILE", str(tmp_env))
    # 清掉慢启动时可能已写入的探测结果，保证每次从干净配置开始
    for name in ("providers.json", "mcp.json"):
        path = tmp_config / name
        if path.exists():
            text = path.read_text(encoding="utf-8")
            if '"probed"' in text or '"status": "failed"' in text:
                shutil.copy(_SHIPPED_CONFIG / name, path)

    # ---- 密钥与稳定性参数 ----
    monkeypatch.setenv("DOBI_KEY_DEEPSEEK", "sk-test-deepseek-0001")
    monkeypatch.setenv("DOBI_KEY_OPENAI", "sk-test-openai-0002")
    monkeypatch.setenv("DOBI_KEY_DASHSCOPE", "sk-test-dashscope-0003")
    monkeypatch.setenv("DOBI_MAX_RETRIES", "1")
    monkeypatch.setenv("DOBI_RETRY_BASE_DELAY", "0.01")

    reload_config()
    settings = get_settings()
    settings.ensure_dirs()
    yield settings
    reload_config()


@pytest.fixture()
def store(env) -> ProjectStore:
    return ProjectStore.create(
        env.projects_dir, "yan-hui-guan",
        title="雁回关", genre="古风悬疑",
        premise="一个北境小吏追查失踪案，却发现王朝正在被「文脉」的力量吞噬。",
    )


def install_fake_transport(monkeypatch, transport: httpx.MockTransport) -> None:
    """把 LLMClient 的 HTTP 客户端换成假传输。

    注意 `_kv` 必须是**同步**方法——`provider.py` 里写的是 `await self._kv().post(...)`，
    属性访问先于 await 绑定，返回协程就会炸。
    """

    def _kv(self: LLMClient) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(transport=transport)
        return self._http

    monkeypatch.setattr(LLMClient, "_kv", _kv)


@pytest.fixture()
def fake(monkeypatch) -> httpx.MockTransport:
    transport = fake_llm.fake_transport()
    install_fake_transport(monkeypatch, transport)
    fake_llm.OVERRIDES.clear()
    return transport


@pytest.fixture()
def client(store, fake) -> LLMClient:
    """带计量的客户端——和 API 层一样把每次调用记进本项目流水，
    这样 `Meter` 的断言才有意义。"""
    from dobi.core.metering import Meter

    meter = Meter(store)

    def on_usage(entry: dict) -> None:
        tokens = entry.get("tokens") or {}
        from dobi.core.schema import UsageEntry
        meter.record(UsageEntry(
            chapter=int(entry.get("chapter") or 0),
            step=str(entry.get("step") or ""),
            role=str(entry.get("role") or ""),
            provider=str(entry.get("provider") or ""),
            model=str(entry.get("model") or ""),
            prompt_tokens=int(tokens.get("prompt_tokens") or 0),
            completion_tokens=int(tokens.get("completion_tokens") or 0),
            total_tokens=int(tokens.get("total_tokens") or 0),
            cost=float(entry.get("cost") or 0.0),
            latency_ms=int(entry.get("latencyMs") or 0),
        ))

    return LLMClient(on_usage=on_usage)
