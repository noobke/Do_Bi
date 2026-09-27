"""Reviewer：正文 + 章纲 + 依赖图 → 7 维可举证质量评审。

与 Audtor 的分工：**审查看设定与逻辑，评审看写作质量**。
硬要求：每维必须引用原文，无证据的维度记 0 分并注明「未取到可举证的原文」，
不进入报告结论 —— 这条约束的意义是让反馈可执行、可申诉（规划文档 §8.3）。
"""

from __future__ import annotations

from ..consistency.review import REVIEW_DIMS, ReviewRequest, review_chapter
from ..core.schema import ReviewReport
from .base import Agent

__all__ = ["Reviewer"]


class Reviewer(Agent):
    async def review(self, chapter: int) -> ReviewReport:
        store = self.store
        data = store.read_chapter(chapter)
        text = "\n\n".join(data["paragraphs"])
        if not text.strip():
            raise ValueError(f"第 {chapter} 章还没有正文，先写出来再评审。")

        graph = store.outline_graph()
        node = graph.node(chapter)
        summaries = [s for s in store.summaries() if s.chapter < chapter][-4:]
        summary_context = "\n".join(f"- 第 {s.chapter} 章《{s.title}》：{s.summary}"
                                    for s in summaries)

        self.scope(chapter, "review")
        self.budget_gate()
        report = await review_chapter(self.client, ReviewRequest(
            chapter=chapter,
            title=data["title"] or (node.title if node else ""),
            text=text,
            outline_node=node,
            hooks=store.hooks(),
            style=store.style(),
            summary_context=summary_context,
        ))
        self.usage.calls += 1
        if not report.dims:
            report.dims = []
        store.save_review(report)

        # 同步进审计报告——作者只看一个地方
        audit = store.read_audit(chapter)
        if audit is not None:
            audit.review = [d.model_dump() for d in report.dims]
            store.save_audit(audit)

        self.cp.finish(
            self.cp.begin(chapter, "review"),
            output_ref=f"reviews/ch_{chapter:04d}.json",
            cost=self.usage.cost,
            note=f"{len(report.dims)}/{len(REVIEW_DIMS)} 维 · 综合 {report.overall} 分",
        )
        return report
