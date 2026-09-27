"""模型适配层的协议契约测试（全部走 httpx.MockTransport，不碰真实厂商）。

覆盖规划文档 §6.6 稳定性设计里的每一条对策：
超时 / 429 / 5xx 重试、401 不重试改降级、400 参数不重试但可自适应、
非法 JSON 带错重试、流式中断不换服务商、能力探测写回。
"""

from __future__ import annotations

import json

import httpx
import pytest

from dobi.config import load_providers, save_providers
from dobi.errors import ModelOutputError, NotConfigured, ProviderAuthError, ProviderError
from dobi.llm.jsonutil import extract_json
from dobi.llm.provider import LLMClient

from conftest import install_fake_transport

MESSAGES = [{"role": "user", "content": "你好"}]


def _ok(content: str = '{"a": 1}', *, model: str = "deepseek-chat") -> httpx.Response:
    return httpx.Response(200, json={
        "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    })


def _sse(chunks: list[str], *, usage: bool = True) -> httpx.Response:
    lines = ["data: " + json.dumps(
        {"choices": [{"delta": {"content": c}, "finish_reason": None}]}, ensure_ascii=False)
        for c in chunks]
    lines.append("data: " + json.dumps(
        {"choices": [{"delta": {}, "finish_reason": "stop"}]}, ensure_ascii=False))
    if usage:
        lines.append("data: " + json.dumps(
            {"choices": [], "usage": {"prompt_tokens": 30, "completion_tokens": 12,
                                      "total_tokens": 42}}, ensure_ascii=False))
    lines.append("data: [DONE]")
    return httpx.Response(200, text="\n\n".join(lines) + "\n\n",
                          headers={"content-type": "text/event-stream"})


def client_with(handler, monkeypatch) -> LLMClient:
    transport = httpx.MockTransport(handler)
    install_fake_transport(monkeypatch, transport)
    return LLMClient()


# ==========================================================================
# 可用性与降级链
# ==========================================================================

class TestCredentials:
    def test_missing_key_raises_not_configured(self, env, monkeypatch):
        for name in ("DOBI_KEY_DEEPSEEK", "DOBI_KEY_OPENAI", "DOBI_KEY_DASHSCOPE"):
            monkeypatch.delenv(name, raising=False)
        client = LLMClient()
        assert not client.has_credentials()
        with pytest.raises(NotConfigured):
            import asyncio
            asyncio.run(client.complete("writer", MESSAGES))

    def test_fallback_chain_order(self, env):
        client = LLMClient()
        names = [p.name for p in client.usable_providers()]
        assert names == ["DeepSeek", "OpenAI", "通义千问"]   # 按 priority
        assert "硅基流动" not in names                       # enabled=false

    def test_disabled_provider_excluded(self, env):
        providers = load_providers()
        for p in providers:
            if p.name == "OpenAI":
                p.enabled = False
        save_providers(providers)
        assert "OpenAI" not in [p.name for p in LLMClient().usable_providers()]


# ==========================================================================
# 稳定性
# ==========================================================================

class TestRetryAndFallback:
    def test_retries_5xx_then_succeeds(self, env, monkeypatch):
        """HTTP 重试对调用方是透明的，所以断言打在请求次数上，而不是 `attempts`。"""
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(500, json={"error": {"message": "server exploded"}})
            return _ok()

        client = client_with(handler, monkeypatch)
        import asyncio
        result = asyncio.run(client.complete("architect", MESSAGES))
        assert calls["n"] == 2
        assert result.text == '{"a": 1}'
        assert result.provider == "DeepSeek"

    def test_retries_429_then_degrades_to_next_provider(self, env, monkeypatch):
        """429 会重试；重试次数用尽后**降级到下一个服务商**，而不是把错误抛给作者。"""
        hits: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            hits.append(request.url.host)
            if "deepseek" in request.url.host:
                return httpx.Response(429, json={"error": {"message": "rate limited"}})
            return _ok()

        client = client_with(handler, monkeypatch)
        import asyncio
        result = asyncio.run(client.complete("architect", MESSAGES))

        assert hits.count("api.deepseek.com") == 2      # 首次 + 1 次重试（DOBI_MAX_RETRIES=1）
        assert result.provider == "OpenAI"
        assert result.degraded_from == "DeepSeek/deepseek-reasoner"

    def test_auth_error_does_not_retry_but_falls_back(self, env, monkeypatch):
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            host = request.url.host
            seen.append(host)
            if "deepseek" in host:
                return httpx.Response(401, json={"error": {"message": "invalid api key"}})
            return _ok()

        client = client_with(handler, monkeypatch)
        import asyncio
        result = asyncio.run(client.complete("architect", MESSAGES))
        assert result.provider == "OpenAI"
        assert result.degraded_from == "DeepSeek/deepseek-reasoner"
        # DeepSeek 只被敲了一次（401 不重试）
        assert seen.count("api.deepseek.com") == 1

    def test_all_providers_down_raises(self, env, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"error": {"message": "down"}})

        client = client_with(handler, monkeypatch)
        import asyncio
        with pytest.raises(ProviderError):
            asyncio.run(client.complete("architect", MESSAGES))

    def test_timeout_is_retried_then_reported(self, env, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("timed out")

        client = client_with(handler, monkeypatch)
        import asyncio
        with pytest.raises(ProviderError):
            asyncio.run(client.complete("architect", MESSAGES))


# ==========================================================================
# 能力探测与自动降级
# ==========================================================================

class TestCapabilityProbe:
    def test_switches_max_tokens_field_on_400(self, env, monkeypatch):
        bodies: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode())
            bodies.append(body)
            if "max_tokens" in body:
                return httpx.Response(400, json={"error": {
                    "message": "Unsupported parameter: 'max_tokens' is not supported. "
                               "Use 'max_completion_tokens' instead."}})
            return _ok()

        client = client_with(handler, monkeypatch)
        import asyncio
        result = asyncio.run(client.complete("architect", MESSAGES))
        assert result.text
        assert "max_completion_tokens" in bodies[-1]
        assert bodies[-1]["max_completion_tokens"] > 0

    def test_drops_response_format_when_unsupported(self, env, monkeypatch):
        bodies: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode())
            bodies.append(body)
            if "response_format" in body:
                return httpx.Response(400, json={"error": {
                    "message": "Unsupported parameter: response_format"}})
            return _ok()

        client = client_with(handler, monkeypatch)
        import asyncio
        result = asyncio.run(client.complete_json("audit_l2", MESSAGES))
        assert result[0] == {"a": 1}
        assert "response_format" not in bodies[-1]

    def test_similar_but_unrelated_400_is_not_adapted(self, env, monkeypatch):
        """400 里出现 max_tokens 字样但语义不是「参数不支持」时，不得瞎改写。"""
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, json={"error": {
                "message": "max_tokens must be less than 4097 for this model"}})

        client = client_with(handler, monkeypatch)
        import asyncio
        with pytest.raises(ProviderError):
            asyncio.run(client.complete("architect", MESSAGES))


# ==========================================================================
# JSON 与流式
# ==========================================================================

class TestJsonAndStream:
    def test_bad_json_is_retried_with_feedback(self, env, monkeypatch):
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                return _ok("这不是 JSON")
            return _ok('{"ok": true}')

        client = client_with(handler, monkeypatch)
        import asyncio
        data, _ = asyncio.run(client.complete_json("audit_l2", MESSAGES))
        assert data == {"ok": True}
        assert calls["n"] == 2

    def test_twice_bad_json_raises_model_output_error(self, env, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return _ok("永远不是 JSON")

        client = client_with(handler, monkeypatch)
        import asyncio
        with pytest.raises(ModelOutputError):
            asyncio.run(client.complete_json("audit_l2", MESSAGES))

    def test_stream_yields_deltas_and_usage(self, env, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return _sse(["第一段。", "第二段。"])

        client = client_with(handler, monkeypatch)
        import asyncio
        chunks: list[str] = []
        holder: dict = {}

        async def _go():
            async for piece in client.stream(
                    "writer", MESSAGES, on_result=lambda r: holder.update(result=r)):
                chunks.append(piece)

        asyncio.run(_go())
        assert chunks == ["第一段。", "第二段。"]
        assert holder["result"].usage.total_tokens == 42

    def test_stream_estimates_usage_when_provider_omits_it(self, env, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return _sse(["一二三四五六七八九十"], usage=False)

        client = client_with(handler, monkeypatch)
        import asyncio
        holder: dict = {}

        async def _go():
            async for _ in client.stream(
                    "writer", MESSAGES, on_result=lambda r: holder.update(result=r)):
                pass

        asyncio.run(_go())
        assert holder["result"].usage.completion_tokens > 0
        assert any("本地估算" in a for a in holder["result"].adaptations)

    def test_stream_does_not_switch_provider_after_output(self, env, monkeypatch):
        """已经出字之后断流，必须如实报错，不能换个服务商从头再来。"""
        hits: list[str] = []

        class _Breaking(httpx.AsyncByteStream):
            async def __aiter__(self):
                payload = json.dumps(
                    {"choices": [{"delta": {"content": "开头"}, "finish_reason": None}]},
                    ensure_ascii=False)
                yield ("data: " + payload + "\n\n").encode("utf-8")
                raise httpx.ReadError("connection lost")

            async def aclose(self) -> None:
                return None

        def handler(request: httpx.Request) -> httpx.Response:
            hits.append(request.url.host)
            return httpx.Response(200, stream=_Breaking(),
                                  headers={"content-type": "text/event-stream"})

        client = client_with(handler, monkeypatch)
        import asyncio
        got: list[str] = []

        async def _go():
            async for piece in client.stream("writer", MESSAGES):
                got.append(piece)

        with pytest.raises(ProviderError):
            asyncio.run(_go())
        assert got == ["开头"]                  # 已产出的内容没有被丢掉
        assert hits == ["api.deepseek.com"]     # 没有换服务商重来


# ==========================================================================
# 计量归集
# ==========================================================================

class TestMeteringHook:
    def test_scope_merges_into_usage_entry(self, env, monkeypatch):
        entries: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            return _ok()

        install_fake_transport(monkeypatch, httpx.MockTransport(handler))
        client = LLMClient(on_usage=entries.append)
        client.scope = {"chapter": 7, "step": "draft"}
        import asyncio
        asyncio.run(client.complete("writer", MESSAGES, fmt="text"))
        assert entries and entries[0]["chapter"] == 7 and entries[0]["step"] == "draft"
        assert entries[0]["tokens"]["total_tokens"] == 15
