"""SQLite 时序记忆 + BM25 检索（规划文档 §5.1 `memory.db`、§6.8 检索方案）。

**为什么不用 SQLite FTS5**：FTS5 的 `unicode61` 分词器会把整段连续中文当成**一个 token**，
中文检索基本失效；而 ICU 分词器依赖 SQLite 编译选项，不便携。所以这里：
- `memory.db` 负责**时序记忆**（可查询、可持久、可回溯）
- BM25 用 `rank_bm25` 在内存里算，中文按**字符二元组（bigram）**切词
  —— 无需分词器、零额外依赖、离线可用、短文本效果好

`reindex()` 从真相文件重建索引，真相文件是唯一权威，索引随时可丢可重建。
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Sequence

from rank_bm25 import BM25Okapi

from .store import ProjectStore

__all__ = ["MemoryIndex", "tokenize", "CHUNK_KINDS"]

CHUNK_KINDS: dict[str, str] = {
    "summary": "章节摘要",
    "chapter": "正文片段",
    "world": "世界规则",
    "character": "角色卡",
    "hook": "伏笔",
    "outline": "章纲与思维链",
}

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_LATIN_RE = re.compile(r"[A-Za-z0-9']+")
_PUNCT_RE = re.compile(r"[\s，。！？、；：,.!?;:\"'（）()【】\[\]—…·]+")

# 中文停用字：单字不成词，切 bigram 时若两侧都是停用字则丢弃
_STOP_CHARS = set("的了是在有和就都而及与着或一个上下来去这那为以其于")

_CHUNK_CHARS = 900      # 正文片段窗口大小
_CHUNK_OVERLAP = 180    # 相邻片段重叠，避免答案正好被切断


def tokenize(text: str) -> list[str]:
    """中文二元组 + 拉丁小写词。这是给 BM25 用的切词，不是给模型看的。"""
    if not text:
        return []
    tokens: list[str] = []
    for word in _LATIN_RE.findall(text):
        tokens.append(word.lower())
    # 按标点切句，句内做 1-gram + 2-gram（1-gram 保证单字查询也能命中）
    for segment in _PUNCT_RE.split(text):
        cjk = [ch for ch in segment if _CJK_RE.match(ch)]
        if not cjk:
            continue
        for ch in cjk:
            if ch not in _STOP_CHARS:
                tokens.append(ch)
        for i in range(len(cjk) - 1):
            bi = cjk[i] + cjk[i + 1]
            if bi[0] in _STOP_CHARS and bi[1] in _STOP_CHARS:
                continue
            tokens.append(bi)
    return tokens


def _split_windows(text: str, size: int = _CHUNK_CHARS, overlap: int = _CHUNK_OVERLAP) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]
    out: list[str] = []
    step = max(1, size - overlap)
    for start in range(0, len(text), step):
        piece = text[start:start + size]
        if piece.strip():
            out.append(piece)
        if start + size >= len(text):
            break
    return out


class MemoryIndex:
    """一个项目一个索引文件（`memory.db`）。"""

    def __init__(self, store: ProjectStore) -> None:
        self.store = store
        self._bm25: BM25Okapi | None = None
        self._docs: list[dict[str, Any]] = []
        self._fingerprint: tuple[int, int] | None = None

    # ---------------- 连接与建表 ----------------

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.store.db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS chunks (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                chapter INTEGER NOT NULL DEFAULT 0,
                kind    TEXT    NOT NULL,
                ref     TEXT    NOT NULL DEFAULT '',
                title   TEXT    NOT NULL DEFAULT '',
                text    TEXT    NOT NULL,
                created_at TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_kind    ON chunks(kind);
            CREATE INDEX IF NOT EXISTS idx_chunks_chapter ON chunks(chapter);

            CREATE TABLE IF NOT EXISTS timeline (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                chapter INTEGER NOT NULL DEFAULT 0,
                kind    TEXT    NOT NULL,
                payload TEXT    NOT NULL,
                created_at TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_timeline_chapter ON timeline(chapter);
            """
        )
        return conn

    # ---------------- 重建索引 ----------------

    def reindex(self) -> int:
        """从真相文件重建全部片段。返回写入的片段数。"""
        store = self.store
        rows: list[tuple[int, str, str, str, str]] = []

        # 1) 章节摘要
        for s in store.summaries():
            text = " ".join(x for x in [s.title, s.summary, "；".join(s.key_facts)] if x)
            rows.append((s.chapter, "summary", f"chapter_summaries.jsonl#{s.chapter}",
                         s.title or f"第 {s.chapter} 章", text))

        # 2) 正文（按窗口切片）
        for n in store.chapter_numbers():
            data = store.read_chapter(n)
            body = "\n\n".join(data["paragraphs"])
            for i, piece in enumerate(_split_windows(body)):
                rows.append((n, "chapter", f"ch_{n:04d}.md#win-{i + 1}",
                             data["title"] or f"第 {n} 章", piece))

        # 3) 世界观规则
        for r in store.world().rules:
            rows.append((0, "world", f"world.md#{r.id}", r.category, r.rule + (" " + r.note if r.note else "")))

        # 4) 角色卡
        for c in store.characters():
            text = " ".join(x for x in [
                c.name, c.role, c.personality, c.speech_style,
                "；".join(c.immutable_traits),
                f"状态：{c.state.location} {c.state.status}",
                "；".join(f"{rel.target}({rel.type}){rel.note}" for rel in c.relationships),
            ] if x)
            rows.append((c.first_appearance, "character", f"characters.jsonl#{c.id}", c.name, text))

        # 5) 伏笔
        for h in store.hooks():
            text = (f"{h.content}（埋于第 {h.planted_chapter} 章"
                    f"{'，已于第 %d 章回收' % h.resolved_chapter if h.resolved_chapter else '，尚未回收'}）")
            rows.append((h.planted_chapter, "hook", f"pending_hooks.jsonl#{h.id}", h.content[:24], text))

        # 6) 章纲与思维链
        for node in store.outline_graph().nodes:
            text = " ".join(x for x in [
                node.title, node.goal, "；".join(node.beats), node.rationale,
            ] if x)
            rows.append((node.chapter, "outline", f"outline_graph.json#ch{node.chapter}",
                         node.title or f"第 {node.chapter} 章", text))

        conn = self._conn()
        try:
            with conn:
                conn.execute("DELETE FROM chunks")
                conn.executemany(
                    "INSERT INTO chunks(chapter, kind, ref, title, text, created_at) "
                    "VALUES(?,?,?,?,?,datetime('now'))",
                    rows,
                )
        finally:
            conn.close()

        self._bm25 = None
        self._docs = []
        self._fingerprint = None
        return len(rows)

    # ---------------- BM25 ----------------

    def _ensure_index(self) -> None:
        conn = self._conn()
        try:
            cur = conn.execute("SELECT COUNT(*), COALESCE(MAX(id),0) FROM chunks")
            fingerprint = tuple(cur.fetchone())  # type: ignore[assignment]
            if self._bm25 is not None and fingerprint == self._fingerprint:
                return
            cur = conn.execute("SELECT id, chapter, kind, ref, title, text FROM chunks")
            self._docs = [
                {"id": r[0], "chapter": r[1], "kind": r[2], "ref": r[3],
                 "title": r[4], "text": r[5]}
                for r in cur.fetchall()
            ]
            self._fingerprint = fingerprint  # type: ignore[assignment]
        finally:
            conn.close()

        if not self._docs:
            self._bm25 = None
            return
        corpus = [tokenize(d["text"]) or ["∅"] for d in self._docs]
        self._bm25 = BM25Okapi(corpus)

    # ---------------- 检索 ----------------

    def search(
        self,
        query: str,
        *,
        k: int = 8,
        kinds: Sequence[str] | None = None,
        exclude_chapters: Iterable[int] = (),
        up_to_chapter: int | None = None,
    ) -> list[dict[str, Any]]:
        """BM25 检索。返回按相关度降序的片段。

        `up_to_chapter` 用于「只看前文」——审计与写作都不应该引用后文，
        否则会出现「第 17 章引用了第 24 章才知道的事」这类倒果为因。
        """
        self._ensure_index()
        if self._bm25 is None:
            return []

        tokens = tokenize(query)
        if not tokens:
            return []
        scores = self._bm25.get_scores(tokens)

        exclude = set(exclude_chapters)
        allowed = set(kinds) if kinds else None
        ranked: list[tuple[float, dict[str, Any]]] = []
        for i, doc in enumerate(self._docs):
            score = float(scores[i])
            if score <= 0:
                continue
            if allowed and doc["kind"] not in allowed:
                continue
            if doc["chapter"] and doc["chapter"] in exclude:
                continue
            if up_to_chapter is not None and doc["chapter"] and doc["chapter"] > up_to_chapter:
                continue
            ranked.append((score, doc))
        ranked.sort(key=lambda x: -x[0])

        out: list[dict[str, Any]] = []
        for score, doc in ranked[:k]:
            out.append({
                "score": round(score, 4),
                "chapter": doc["chapter"],
                "kind": doc["kind"],
                "kindLabel": CHUNK_KINDS.get(doc["kind"], doc["kind"]),
                "ref": doc["ref"],
                "title": doc["title"],
                "text": doc["text"],
            })
        return out

    def related_chapters(self, chapter: int, query: str, *, k: int = 5) -> list[dict[str, Any]]:
        """关联章节推荐：BM25 相关度 + 依赖图邻接 + 时间近邻，三者加权。

        依赖图那一项是**必须真实消费**的（规划文档 §14 风险表：依赖图不能变成摆设）。

        方向约定：依赖边是「后章 → 它依赖的前章」（`from` 依赖 `to`）。
        所以只有 `edge.from_chapter == chapter` 的 `to_chapter` 才是**前因**；
        `edge.to_chapter == chapter` 的那些是**后续章节**，绝不能作为上下文推荐
        —— 那会造成「第 17 章引用了第 24 章才知道的事」。
        """
        self._ensure_index()
        graph = self.store.outline_graph()
        neighbours: dict[int, float] = {}
        for edge in graph.edges:
            if edge.from_chapter == chapter and 0 < edge.to_chapter < chapter:
                neighbours[edge.to_chapter] = max(neighbours.get(edge.to_chapter, 0), 1.0)

        scores: dict[int, float] = {}
        for hit in self.search(query, k=k * 4, up_to_chapter=chapter):
            n = hit["chapter"]
            if not n or n == chapter:
                continue
            weight = 1.0 if hit["kind"] != "outline" else 0.8
            scores[n] = scores.get(n, 0.0) + hit["score"] * weight

        for n, boost in neighbours.items():
            scores[n] = scores.get(n, 0.0) + boost * 1.5

        for n in range(max(1, chapter - 3), chapter):
            if n in scores:
                scores[n] += 0.6

        ranked = sorted((s for s in scores.items() if s[1] > 0), key=lambda x: -x[1])[:k]
        out = []
        for n, score in ranked:
            node = graph.node(n)
            summary = self.store.summary(n)
            out.append({
                "chapter": n,
                "title": (node.title if node else "") or (summary.title if summary else ""),
                "score": round(score, 3),
                "viaGraph": n in neighbours,
                "reason": ("依赖图直连" if n in neighbours else
                           ("前情近邻" if chapter - 3 <= n < chapter else "内容相关")),
            })
        return out

    # ---------------- 时序记忆 ----------------

    def append_timeline(self, *, chapter: int, kind: str, payload: dict[str, Any]) -> None:
        conn = self._conn()
        try:
            with conn:
                conn.execute(
                    "INSERT INTO timeline(chapter, kind, payload, created_at) "
                    "VALUES(?,?,?,datetime('now'))",
                    (chapter, kind, json.dumps(payload, ensure_ascii=False)),
                )
        finally:
            conn.close()

    def timeline(self, *, chapter: int | None = None, limit: int = 100) -> list[dict[str, Any]]:
        conn = self._conn()
        try:
            if chapter is None:
                cur = conn.execute(
                    "SELECT chapter, kind, payload, created_at FROM timeline "
                    "ORDER BY id DESC LIMIT ?", (limit,))
            else:
                cur = conn.execute(
                    "SELECT chapter, kind, payload, created_at FROM timeline "
                    "WHERE chapter=? ORDER BY id ASC LIMIT ?", (chapter, limit))
            rows = cur.fetchall()
        finally:
            conn.close()
        out = []
        for chapter_no, kind, payload, created in rows:
            try:
                data = json.loads(payload)
            except json.JSONDecodeError:
                data = {"raw": payload}
            out.append({"chapter": chapter_no, "kind": kind, "payload": data,
                        "createdAt": created})
        return out

    def stats(self) -> dict[str, Any]:
        conn = self._conn()
        try:
            chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            by_kind = dict(conn.execute(
                "SELECT kind, COUNT(*) FROM chunks GROUP BY kind").fetchall())
            events = conn.execute("SELECT COUNT(*) FROM timeline").fetchone()[0]
        finally:
            conn.close()
        return {"chunks": chunks, "byKind": by_kind, "timelineEvents": events,
                "engine": "rank_bm25 + 中文 bigram"}
