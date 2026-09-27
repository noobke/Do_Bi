"""模型层：OpenAI 兼容协议适配。"""

from .jsonutil import extract_json, looks_like_json
from .provider import ChatResult, LLMClient, Usage

__all__ = ["LLMClient", "ChatResult", "Usage", "extract_json", "looks_like_json"]
