"""模型适配层：只依赖 OpenAI 兼容协议，换厂商不改业务代码。

职责（对应规划文档 §6）：

- **统一调用**：`complete()` 非流式 / `stream()` 流式 / `complete_json()` 带容错重试
- **降级链**：主力 → `fallbacks` → 其余可用服务商；全部失败才报错
- **能力探测 + 自动降级**：厂商对 `max_tokens` / `response_format` / `stream_options`
  支持度不一，遇到 400 参数类错误时**自动改写参数并重试一次**，探测结果写回
  `config/providers.json` 的 `probed` 字段（下次不再踩同一个坑）
- **稳定性**：429 / 5xx / 超时 → 指数退避 + 抖动，上限 `max_retries`；
  401/403 → **不重试**，直接换下一个服务商；4xx 参数错误 → 不重试
- **计量**：每次调用回调 `on_usage`，供 `core.metering` 记账与预算熔断

说明：规划文档原文提到「用官方 openai SDK 通过 base_url + api_key 切换厂商」。
此处改用 `httpx` 直接说同一套 HTTP 协议，原因是**能力探测需要看到厂商原文的 400 报文**
才能判断是哪个参数不被支持——SDK 会把它包装掉；同时少一个重依赖。
对外行为与「只依赖 OpenAI 兼容协议」的约束完全一致。
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Callable, Sequence

import httpx

from ..config import (
    ModelRoleSpec,
    ModelSpec,
    ProviderSpec,
    Settings,
    get_settings,
    load_providers,
    load_roles,
    save_providers,
)
from ..errors import (
    ConfigError,
    ModelOutputError,
    NotConfigured,
    ProviderAuthError,
    ProviderError,
)
from .jsonutil import JSONExtractError, extract_json

__all__ = ["LLMClient", "ChatResult", "Usage", "Message"]

Message = dict[str, str]

# 提示词全文是否入日志（复盘调优用）。默认关，避免密钥间接泄漏与日志膨胀。
LOG_PROMPTS = False


# ==========================================================================
# 结果容器
# ==========================================================================

@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    def merge(self, other: "Usage") -> None:
        self.prompt_tokens += other.prompt_tokens
        self.completion_tokens += other.completion_tokens
        total = other.total_tokens or (other.prompt_tokens + other.completion_tokens)
        self.total_tokens += total

    @property
    def empty(self) -> bool:
        return not (self.prompt_tokens or self.completion_tokens or self.total_tokens)

    def as_dict(self) -> dict[str, int]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens or (self.prompt_tokens + self.completion_tokens),
        }


@dataclass
class ChatResult:
    text: str
    provider: str
    model: str
    usage: Usage = field(default_factory=Usage)
    latency_ms: int = 0
    role: str = ""
    attempts: int = 1
    degraded_from: str | None = None
    cost: float = 0.0
    finish_reason: str | None = None
    truncation: bool = False
    adaptations: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        """给前端看的计量信息（作者语言：额度 / 花费）。"""
        return {
            "provider": self.provider,
            "model": self.model,
            "tokens": self.usage.as_dict(),
            "cost": round(self.cost, 4),
            "latencyMs": self.latency_ms,
            "degraded": self.degraded_from is not None,
        }


# ==========================================================================
# 内部：可自适应错误
# ==========================================================================

class _AdaptableError(Exception):
    """厂商因「参数不被支持」而 400。携带改写提示，改写后可重试一次。"""

    def __init__(self, hint: str, message: str) -> None:
        super().__init__(message)
        self.hint = hint
        self.message = message


_UNKNOWN_MARKERS = (
    "unknown", "unsupported", "not supported", "does not support",
    "unrecognized", "unexpected", "invalid parameter", "extra fields",
    "not allowed", "无此参数", "不支持", "未知参数",
)


def _looks_like_unknown_param(body: str) -> bool:
    low = body.lower()
    return any(m in low for m in _UNKNOWN_MARKERS)


# ==========================================================================
# 客户端
# ==========================================================================

class LLMClient:
    """一次业务请求内复用的模型客户端。用完记得 `aclose()`。"""

    def __init__(
        self,
        *,
        settings: Settings | None = None,
        providers: list[ProviderSpec] | None = None,
        roles: dict[str, ModelRoleSpec] | None = None,
        on_usage: Callable[[dict[str, Any]], None] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.providers = providers if providers is not None else load_providers()
        self.roles = roles if roles is not None else load_roles()
        self._on_usage = on_usage
        self._transport = transport
        self._http: httpx.AsyncClient | None = None
        self._probe_dirty = False
        #: 当前调用所处的业务位置，如 `{"chapter": 17, "step": "draft"}`。
        #: 编排层在每次调用前设置，计量回调据此归集账目。
        self.scope: dict[str, Any] = {}

    # ---------------- 生命周期 ----------------

    def _kv(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(transport=self._transport, follow_redirects=True)
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None
        if self._probe_dirty:
            self._persist_probes()

    async def __aenter__(self) -> "LLMClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    def _timeout(self) -> httpx.Timeout:
        s = self.settings
        return httpx.Timeout(connect=s.connect_timeout, read=s.read_timeout,
                             write=s.connect_timeout, pool=s.connect_timeout)

    # ---------------- 可用性与角色 ----------------

    def usable_providers(self) -> list[ProviderSpec]:
        """已启用 **且** 已配置密钥的服务商，按 priority 升序。"""
        return [p for p in self.providers if p.enabled and p.configured]

    def has_credentials(self) -> bool:
        return bool(self.usable_providers())

    def require_credentials(self) -> None:
        if not self.has_credentials():
            raise NotConfigured(
                "还没有配置可用的模型服务。请到「设置 · 服务商」填入至少一个 API Key 后重试。"
            )

    def role(self, key: str) -> ModelRoleSpec:
        spec = self.roles.get(key)
        if spec is None:
            raise ConfigError(f"模型角色未定义：{key}（请检查 config/model_roles.json）")
        return spec

    def window_for(self, key: str) -> int:
        """该环节首选模型的上下文窗口。用于上下文组装的分层预算。

        取不到时给保守默认（32k），宁可多裁一点，也不要撞上超窗报错。
        """
        try:
            role = self.role(key)
        except ConfigError:
            return 32_000
        cands = self._candidates(role, need_json=role.fmt in ("json", "patch"),
                                need_stream=role.fmt == "text")
        if not cands:
            return 32_000
        return max(8_192, int(cands[0][1].context_window or 32_000))

    def max_output_for(self, key: str) -> int:
        try:
            role = self.role(key)
        except ConfigError:
            return 4_096
        cands = self._candidates(role, need_json=role.fmt in ("json", "patch"),
                                need_stream=role.fmt == "text")
        return int(cands[0][1].max_output) if cands else role.max_tokens

    def _candidates(
        self, role: ModelRoleSpec, *, need_json: bool, need_stream: bool
    ) -> list[tuple[ProviderSpec, ModelSpec]]:
        """按优先级排出候选 (服务商, 模型) 列表 = 降级链。"""
        usable = self.usable_providers()
        by_name = {p.name: p for p in usable}
        out: list[tuple[ProviderSpec, ModelSpec]] = []
        seen: set[tuple[str, str]] = set()

        def ok(m: ModelSpec) -> bool:
            return (not need_json or m.supports_json) and (not need_stream or m.supports_stream)

        def add(prov_name: str, model_name: str) -> None:
            prov = by_name.get(prov_name)
            if prov is None:
                return
            model = prov.model(model_name)
            if model is None:
                # 用户可能在 providers.json 里没声明这个模型；仍允许尝试，能力按默认值
                model = ModelSpec(name=model_name)
            if not ok(model):
                return
            key = (prov.name, model.name)
            if key in seen:
                return
            seen.add(key)
            out.append((prov, model))

        # 1) 角色指定的服务商 + 模型
        if role.provider:
            add(role.provider, role.model)
        else:
            owner = next((p for p in usable if p.model(role.model)), None)
            if owner:
                add(owner.name, role.model)

        # 2) 显式 fallbacks
        for fb in role.fallbacks:
            prov_name, _, model_name = fb.partition("/")
            add(prov_name, model_name or role.model)

        # 3) 兜底：其余可用服务商各取第一个满足能力的模型
        for prov in usable:
            for model in prov.models:
                if ok(model):
                    add(prov.name, model.name)
                    break

        return out

    # ---------------- 结果与计量 ----------------

    def _emit(self, result: ChatResult) -> None:
        if self._on_usage is None:
            return
        entry = result.public()
        entry.update({
            "role": result.role,
            "attempts": result.attempts,
            "finishReason": result.finish_reason,
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        for key, value in self.scope.items():
            entry.setdefault(key, value)
        try:
            self._on_usage(entry)
        except Exception:  # 计量失败绝不能影响主流程
            pass

    def _persist_probes(self) -> None:
        try:
            save_providers(self.providers)
            self._probe_dirty = False
        except Exception:
            pass

    # ---------------- 报文构造与错误分类 ----------------

    def _build_payload(
        self,
        prov: ProviderSpec,
        model: ModelSpec,
        messages: Sequence[Message],
        temperature: float,
        max_tokens: int,
        want_json: bool,
        stream: bool,
    ) -> dict[str, Any]:
        probe = prov.probed
        payload: dict[str, Any] = {
            "model": model.name,
            "messages": list(messages),
            "temperature": temperature,
            probe.max_tokens_field or "max_tokens": max(1, max_tokens),
        }
        if want_json and probe.supports_response_format:
            payload["response_format"] = {"type": "json_object"}
        if stream:
            payload["stream"] = True
            if probe.supports_stream_options:
                payload["stream_options"] = {"include_usage": True}
        return payload

    def _detect_hint(self, prov: ProviderSpec, body: str) -> str | None:
        if not _looks_like_unknown_param(body):
            return None
        low = body.lower()
        if "stream_options" in low and prov.probed.supports_stream_options:
            return "stream_options"
        if "response_format" in low and prov.probed.supports_response_format:
            return "response_format"
        if "max_completion_tokens" in low and prov.probed.max_tokens_field == "max_tokens":
            return "max_tokens"
        if "max_tokens" in low and prov.probed.max_tokens_field == "max_completion_tokens":
            return "max_tokens"
        return None

    def _apply_adaptation(self, prov: ProviderSpec, hint: str) -> str:
        probe = prov.probed
        if hint == "max_tokens":
            probe.max_tokens_field = (
                "max_completion_tokens" if probe.max_tokens_field == "max_tokens" else "max_tokens"
            )
            note = f"{prov.name}：改用 {probe.max_tokens_field}"
        elif hint == "response_format":
            probe.supports_response_format = False
            note = f"{prov.name}：不支持 JSON 强制模式，改为提示词约束 + 容错解析"
        elif hint == "stream_options":
            probe.supports_stream_options = False
            note = f"{prov.name}：不支持流式用量回传，改为本地估算"
        else:
            return f"{prov.name}：未知适配 {hint}"
        self._probe_dirty = True
        return note

    def _classify(self, status: int, body: str, prov: ProviderSpec) -> Exception:
        """把 HTTP 响应分类成业务异常。返回 `_AdaptableError` 表示可改写参数重试。"""
        try:
            err = json.loads(body).get("error") or {}
            message = err.get("message") or body
        except Exception:
            message = body
        snippet = (message or "")[:300]

        if status in (401, 403):
            return ProviderAuthError(
                f"{prov.name} 拒绝了密钥（{status}）。请到「设置」核对 {prov.api_key_ref}。",
                detail=snippet,
            )
        if status == 402 or "insufficient" in snippet.lower() or "quota" in snippet.lower():
            return ProviderAuthError(
                f"{prov.name} 账户额度不足或已欠费。",
                detail=snippet,
            )
        if status in (400, 404, 422):
            hint = self._detect_hint(prov, body)
            if hint:
                return _AdaptableError(hint, snippet)
            if status == 404 or "model" in snippet.lower():
                return ProviderError(f"{prov.name} 上没有这个模型：{snippet}", detail=snippet)
            return ProviderError(f"{prov.name} 拒绝了请求：{snippet}", detail=snippet)
        if status == 429:
            return ProviderError(f"{prov.name} 限流（429），正在退避重试。", detail=snippet)
        if status >= 500:
            return ProviderError(f"{prov.name} 服务异常（{status}）。", detail=snippet)
        return ProviderError(f"{prov.name} 返回未预期状态 {status}：{snippet}", detail=snippet)

    # ---------------- 非流式 ----------------

    async def _post_json(self, prov: ProviderSpec, payload: dict[str, Any]) -> dict[str, Any]:
        url = prov.base_url.rstrip("/") + "/chat/completions"
        headers = {"Authorization": f"Bearer {prov.api_key}", "Content-Type": "application/json"}
        delay = self.settings.retry_base_delay
        last: Exception | None = None

        for attempt in range(1, self.settings.max_retries + 2):
            try:
                resp = await self._kv().post(url, json=payload, headers=headers, timeout=self._timeout())
            except httpx.TimeoutException as exc:
                last = ProviderError(f"连接 {prov.name} 超时（{type(exc).__name__}）。")
            except httpx.TransportError as exc:
                last = ProviderError(f"连接 {prov.name} 失败（{type(exc).__name__}）。")
            else:
                if resp.status_code < 400:
                    return resp.json()
                err = self._classify(resp.status_code, resp.text, prov)
                if isinstance(err, (_AdaptableError, ProviderAuthError)):
                    raise err
                last = err

            if attempt <= self.settings.max_retries:
                await asyncio.sleep(delay + random.uniform(0, delay * 0.3))
                delay *= 2

        raise last or ProviderError(f"{prov.name} 调用失败。")

    def _to_result(
        self, data: dict[str, Any], prov: ProviderSpec, model: ModelSpec,
        latency_ms: int, attempts: int, degraded_from: str | None, role_key: str,
        adaptations: list[str], streamed_text: str | None = None,
    ) -> ChatResult:
        choices = data.get("choices") or [{}]
        choice = choices[0] or {}
        message = choice.get("message") or {}
        text = streamed_text if streamed_text is not None else (message.get("content") or "")
        if not text:
            # deepseek-reasoner 等把推理过程放 reasoning_content；正文为空时退而取它
            text = message.get("reasoning_content") or ""

        raw_usage = data.get("usage") or {}
        usage = Usage(
            prompt_tokens=int(raw_usage.get("prompt_tokens") or 0),
            completion_tokens=int(raw_usage.get("completion_tokens") or 0),
            total_tokens=int(raw_usage.get("total_tokens") or 0),
        )
        finish = choice.get("finish_reason")
        cost = (usage.prompt_tokens / 1_000_000) * model.price_in + \
               (usage.completion_tokens / 1_000_000) * model.price_out

        return ChatResult(
            text=text,
            provider=prov.name,
            model=model.name,
            usage=usage,
            latency_ms=latency_ms,
            role=role_key,
            attempts=attempts,
            degraded_from=degraded_from,
            cost=cost,
            finish_reason=finish,
            truncation=(finish == "length"),
            adaptations=adaptations,
        )

    async def _complete_with_adaptation(
        self, prov: ProviderSpec, model: ModelSpec, role: ModelRoleSpec,
        messages: Sequence[Message], temperature: float, max_tokens: int,
        want_json: bool, degraded_from: str | None,
    ) -> ChatResult:
        applied: list[str] = []
        attempts = 0
        while True:
            attempts += 1
            payload = self._build_payload(prov, model, messages, temperature, max_tokens, want_json, False)
            started = time.perf_counter()
            try:
                data = await self._post_json(prov, payload)
            except _AdaptableError as exc:
                note = self._apply_adaptation(prov, exc.hint)
                if note in applied:  # 同一适配只做一次，避免来回翻转
                    raise ProviderError(f"{prov.name} 拒绝了请求：{exc.message}") from exc
                applied.append(note)
                continue
            latency = int((time.perf_counter() - started) * 1000)
            result = self._to_result(data, prov, model, latency, attempts, degraded_from,
                                    role.key, applied)
            self._emit(result)
            return result

    async def complete(
        self,
        role_key: str,
        messages: Sequence[Message],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        fmt: str | None = None,
    ) -> ChatResult:
        """非流式调用（结构化任务：大纲 / 审计 / 评审）。走完整降级链。"""
        role = self.role(role_key)
        eff_fmt = fmt or role.fmt
        want_json = eff_fmt in ("json", "patch")
        temp = role.temperature if temperature is None else temperature
        tokens = role.max_tokens if max_tokens is None else max_tokens

        self.require_credentials()
        cands = self._candidates(role, need_json=want_json, need_stream=False)
        if not cands:
            raise NotConfigured(
                f"「{role.label}」这个环节没有可用模型：候选服务商或模型都不支持所需的输出格式。"
            )

        first_label = f"{cands[0][0].name}/{cands[0][1].name}"
        last: Exception | None = None
        for idx, (prov, model) in enumerate(cands):
            degraded = None if idx == 0 else first_label
            try:
                return await self._complete_with_adaptation(
                    prov, model, role, messages, temp, tokens, want_json, degraded
                )
            except (ProviderAuthError, ProviderError, _AdaptableError) as exc:
                last = exc
                continue
        raise last or ProviderError("所有候选模型都调用失败。")

    async def complete_json(
        self,
        role_key: str,
        messages: Sequence[Message],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        retry_on_bad_json: bool = True,
    ) -> tuple[Any, ChatResult]:
        """要求 JSON 输出。解析失败时**带上错误信息重试一次**，仍失败则报错（不静默通过）。"""
        result = await self.complete(role_key, messages, temperature=temperature,
                                     max_tokens=max_tokens, fmt="json")
        parse_error: str | None = None
        try:
            return extract_json(result.text), result
        except JSONExtractError as exc:
            parse_error = str(exc)
            if not retry_on_bad_json:
                raise ModelOutputError(
                    f"「{self.role(role_key).label}」没有返回可用的结构化结果：{exc}"
                ) from exc

        corrective = list(messages) + [
            {"role": "assistant", "content": (result.text or "")[:2000]},
            {"role": "user", "content":
                f"上面的输出不是合法 JSON（解析错误：{parse_error}）。"
                "请只输出一个合法的 JSON 对象：不要任何解释文字、不要 Markdown 代码块围栏、"
                "不要尾随逗号，所有键名与字符串都用英文双引号。"},
        ]
        retry = await self.complete(role_key, corrective, temperature=temperature,
                                    max_tokens=max_tokens, fmt="json")
        try:
            return extract_json(retry.text), retry
        except JSONExtractError as exc2:
            raise ModelOutputError(
                f"「{self.role(role_key).label}」连续两次没有返回合法 JSON：{exc2}"
            ) from exc2

    # ---------------- 流式 ----------------

    @staticmethod
    def _parse_sse_line(line: str) -> tuple[str, Usage | None, str | None]:
        line = (line or "").strip()
        if not line or line.startswith(":"):
            return "", None, None
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line or line == "[DONE]":
            return "", None, None
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            return "", None, None

        usage: Usage | None = None
        raw_usage = obj.get("usage")
        if raw_usage:
            usage = Usage(
                prompt_tokens=int(raw_usage.get("prompt_tokens") or 0),
                completion_tokens=int(raw_usage.get("completion_tokens") or 0),
                total_tokens=int(raw_usage.get("total_tokens") or 0),
            )

        choices = obj.get("choices") or []
        if not choices:
            return "", usage, None
        choice = choices[0] or {}
        delta = choice.get("delta") or {}
        text = delta.get("content") or delta.get("reasoning_content") or ""
        return text, usage, choice.get("finish_reason")

    async def _stream_one(
        self, prov: ProviderSpec, model: ModelSpec, role: ModelRoleSpec,
        messages: Sequence[Message], temperature: float, max_tokens: int,
        degraded_from: str | None, holder: dict[str, Any], applied: list[str],
    ) -> AsyncIterator[str]:
        payload = self._build_payload(prov, model, messages, temperature, max_tokens, False, True)
        url = prov.base_url.rstrip("/") + "/chat/completions"
        headers = {"Authorization": f"Bearer {prov.api_key}", "Content-Type": "application/json"}

        delay = self.settings.retry_base_delay
        attempt = 0
        parts: list[str] = []
        usage = Usage()
        finish: str | None = None
        started = time.perf_counter()
        emitted = False

        while True:
            attempt += 1
            try:
                async with self._kv().stream("POST", url, json=payload, headers=headers,
                                             timeout=self._timeout()) as resp:
                    if resp.status_code >= 400:
                        body = (await resp.aread()).decode("utf-8", "ignore")
                        err = self._classify(resp.status_code, body, prov)
                        if isinstance(err, (_AdaptableError, ProviderAuthError)):
                            raise err
                        if attempt <= self.settings.max_retries:
                            await asyncio.sleep(delay + random.uniform(0, delay * 0.3))
                            delay *= 2
                            continue
                        raise err

                    async for line in resp.aiter_lines():
                        text, u, fr = self._parse_sse_line(line)
                        if u is not None:
                            usage = u
                        if fr:
                            finish = fr
                        if text:
                            emitted = True
                            parts.append(text)
                            yield text
                    break
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                if emitted or attempt > self.settings.max_retries:
                    raise ProviderError(
                        f"生成过程中与 {prov.name} 的连接中断（{type(exc).__name__}）。"
                        "已生成的部分已保留，可从断点继续。"
                    ) from exc
                await asyncio.sleep(delay + random.uniform(0, delay * 0.3))
                delay *= 2

        latency = int((time.perf_counter() - started) * 1000)
        if usage.empty and parts:
            # 厂商不支持流式用量回传 → 本地粗估（中文 ≈ 1.6 字/token），并标注为估算
            approx_out = max(1, int(len("".join(parts)) / 1.6))
            usage.completion_tokens = approx_out
            usage.total_tokens = approx_out
            applied.append(f"{prov.name}：用量为本地估算")

        result = ChatResult(
            text="".join(parts), provider=prov.name, model=model.name, usage=usage,
            latency_ms=latency, role=role.key, attempts=attempt,
            degraded_from=degraded_from,
            cost=(usage.prompt_tokens / 1_000_000) * model.price_in
                 + (usage.completion_tokens / 1_000_000) * model.price_out,
            finish_reason=finish, truncation=(finish == "length"), adaptations=applied,
        )
        holder["result"] = result
        self._emit(result)

    async def stream(
        self,
        role_key: str,
        messages: Sequence[Message],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        on_result: Callable[[ChatResult], None] | None = None,
    ) -> AsyncIterator[str]:
        """流式调用（正文生成）。逐段 yield 文本。

        降级语义：**只有在还没吐出任何内容时**才允许换服务商；
        一旦开始出字，中途断流就如实报错（已生成部分由调用方保留），绝不静默重来。
        """
        role = self.role(role_key)
        temp = role.temperature if temperature is None else temperature
        tokens = role.max_tokens if max_tokens is None else max_tokens

        self.require_credentials()
        cands = self._candidates(role, need_json=False, need_stream=True)
        if not cands:
            raise NotConfigured(f"「{role.label}」这个环节没有支持流式输出的可用模型。")

        first_label = f"{cands[0][0].name}/{cands[0][1].name}"
        last: Exception | None = None

        for idx, (prov, model) in enumerate(cands):
            degraded = None if idx == 0 else first_label
            holder: dict[str, Any] = {}
            applied: list[str] = []
            while True:
                emitted = False
                try:
                    async for delta in self._stream_one(prov, model, role, messages, temp,
                                                        tokens, degraded, holder, applied):
                        emitted = True
                        yield delta
                except _AdaptableError as exc:
                    note = self._apply_adaptation(prov, exc.hint)
                    if note in applied:
                        last = ProviderError(f"{prov.name} 拒绝了请求：{exc.message}")
                        break
                    applied.append(note)
                    continue  # 同服务商改写参数重试
                except ProviderAuthError as exc:
                    last = exc
                    break  # 换下一个服务商
                except ProviderError as exc:
                    last = exc
                    if emitted:
                        raise  # 已出字，不允许换服务商重来
                    break

                if holder.get("result") and on_result:
                    on_result(holder["result"])
                return

        raise last or ProviderError("所有候选模型都调用失败。")

    # ---------------- 连通性探测（设置页「测试」按钮） ----------------

    async def probe(self, provider_name: str, model_name: str | None = None) -> dict[str, Any]:
        prov = next((p for p in self.providers if p.name == provider_name), None)
        if prov is None:
            raise ConfigError(f"没有这个服务商：{provider_name}")
        if not prov.configured:
            raise NotConfigured(
                f"「{prov.name}」还没有填密钥。请设置环境变量 {prov.api_key_ref} 后重启服务。"
            )

        model = prov.model(model_name) if model_name else (prov.models[0] if prov.models else None)
        if model is None:
            raise ConfigError(f"「{prov.name}」没有配置任何模型。")

        started = time.perf_counter()
        ok = False
        error: str | None = None
        try:
            await self.complete(
                "chat",
                [{"role": "user", "content": "用两个字回答：收到"}],
                temperature=0.0,
                max_tokens=8,
                fmt="text",
            )
            ok = True
        except Exception as exc:  # 探测失败不应抛给设置页
            error = str(exc)
        latency = int((time.perf_counter() - started) * 1000)

        prov.probed = prov.probed.model_copy(update={
            "ok": ok,
            "latency_ms": latency,
            "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "error": error,
        })
        self._probe_dirty = True
        self._persist_probes()
        return prov.probed.model_dump()
