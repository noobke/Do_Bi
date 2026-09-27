"""Chat-first 立项（规划文档 §1.3「Chat-first：从一句话灵感开始，不填表」）。

多轮追问沉淀设定：每一轮不仅回话，还顺手把已确定的信息写进 `meta.json` 与
`state/chat.json`，所以「聊完就能开工」——不需要作者再去填一遍表单。
"""

from __future__ import annotations

from typing import Any

from . import prompts
from .base import Agent

__all__ = ["ChatAgent"]

_FIELDS = ("genre", "premise", "protagonist", "conflict", "tone")


class ChatAgent(Agent):
    # ---------------- 会话状态 ----------------

    @property
    def _state_path(self):
        return self.store.state_dir / "chat.json"

    def records(self) -> dict[str, Any]:
        raw = self.store.read_json(self._state_path, {}) or {}
        return {k: str(raw.get(k) or "") for k in _FIELDS}

    def history(self) -> list[dict[str, str]]:
        raw = self.store.read_json(self._state_path, {}) or {}
        return list(raw.get("history") or [])

    def _save(self, records: dict[str, Any], history: list[dict[str, str]]) -> None:
        self.store.write_json(self._state_path, {
            "records": records, "history": history[-40:],
        })

    # ---------------- 对话 ----------------

    async def reply(self, message: str) -> dict[str, Any]:
        meta = self.store.meta()
        history = self.history()
        records = self.records()

        self.scope(0, "plan")
        self.budget_gate()
        transcript = "\n".join(
            f"{'作者' if m.get('role') == 'me' else '助手'}：{m.get('text', '')}"
            for m in history[-10:]
        ) or "（这是第一轮）"

        obj, result = await self.client.complete_json("chat", [{
            "role": "user",
            "content": prompts.CHAT.format(
                genre=meta.genre or "（待定）",
                premise=meta.premise or "（未填）",
                protagonist=records.get("protagonist") or "（未定）",
                conflict=records.get("conflict") or "（未定）",
                tone=records.get("tone") or "（未定）",
                history=transcript,
                message=message,
            ),
        }])
        self.usage.add(result)

        data = obj if isinstance(obj, dict) else {}
        incoming = data.get("records") if isinstance(data.get("records"), dict) else {}
        for key in _FIELDS:
            value = str(incoming.get(key) or "").strip()
            if value:
                records[key] = value
        if not records.get("premise"):
            records["premise"] = meta.premise

        reply_text = str(data.get("reply") or "").strip() or "（模型没有给出回话，请重试）"
        options = [str(o).strip() for o in (data.get("options") or []) if str(o).strip()]
        if not any("自己" in o for o in options):
            options.append("我自己说")

        history.append({"role": "me", "text": message})
        history.append({"role": "ai", "text": reply_text})
        self._save(records, history)
        self._persist_meta(records)

        return {
            "reply": reply_text,
            "options": options[:4],
            "records": {k: (v or "（尚未确立）") for k, v in records.items()},
            "ready": bool(data.get("ready")),
            "usage": self.usage.public(),
        }

    # ---------------- 设定沉淀 ----------------

    def _persist_meta(self, records: dict[str, Any]) -> None:
        """已确定的信息落进 meta ——「聊完就能开工」靠的就是这一步。"""
        meta = self.store.meta()
        changed = False
        genre = records.get("genre", "").strip()
        if genre and genre != meta.genre and genre != "待定":
            meta.genre = genre
            changed = True
        premise = records.get("premise", "").strip()
        if premise and premise != meta.premise:
            meta.premise = premise
            if not meta.logline:
                meta.logline = premise
            changed = True
        parts = [x for x in (records.get("protagonist"), records.get("conflict")) if x.strip()]
        if parts:
            line = "；".join(p.strip() for p in parts)
            if line != meta.logline:
                meta.logline = line
                changed = True
        if changed:
            self.store.save_meta(meta)

    def seed(self) -> dict[str, Any]:
        """首屏展示的立项要点（对应原型的「项目记录」面板）。"""
        meta = self.store.meta()
        records = self.records()
        ready = bool(meta.premise) and meta.genre not in ("", "待定")
        return {
            "genre": meta.genre,
            "premise": meta.premise or "（尚未确立）",
            "protagonist": records.get("protagonist") or "（尚未确立）",
            "coreConflict": records.get("conflict") or "（尚未确立）",
            "tone": records.get("tone") or "（尚未确立）",
            "readyForPlan": ready,
            "updatedAt": meta.updated_at,
        }
