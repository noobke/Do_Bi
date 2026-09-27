"""端到端生命周期测试：立项 → 写章 → 审查 → 评审 → 去味 → 修订 → 定稿 → 续跑。

跑在假模型上，所以**零额度消耗**，但走的全是真实代码路径：
真相文件闸门、规则校验、上下文组装、checkpoint、计量、提案提交。
"""

from __future__ import annotations

import pytest

import fake_llm
from dobi.agents import Archivist, ChatAgent, Writer
from dobi.agents.writer import split_paragraphs
from dobi.core.checkpoint import CheckpointManager
from dobi.core.context import build_context
from dobi.core.metering import Meter
from dobi.core.store import ProjectStore
from dobi.llm.provider import LLMClient
from dobi.orchestrator import BookRunner, ModeController, Pipeline, Planner, Steering


# ==========================================================================
# 立项
# ==========================================================================

async def test_bootstrap_builds_all_nine_truth_files(store: ProjectStore, client: LLMClient):
    meter = Meter(store)
    planner = Planner(store, client, meter)
    outcome = await planner.bootstrap()

    assert {"世界观", "角色", "大纲与依赖图"} <= set(outcome.changed)
    assert [r.id for r in store.world().rules] == ["w1", "w2", "w3", "w4"]
    assert [c.name for c in store.characters()] == ["沈砚", "崔十九"]
    # 关系里的姓名应被规整成 id
    assert store.character("沈砚").relationships[0].target == "char_002"

    graph = store.outline_graph()
    assert [n.chapter for n in graph.nodes] == [1, 2, 3]
    assert len(graph.volumes) == 2
    assert len(graph.edges) == 3
    assert graph.compass.endgame
    assert graph.node(1).timeline[0]["label"] == "雪夜换防"
    assert meter.totals()["calls"] >= 3

    coverage = planner.coverage()
    assert coverage["nodes"] == 3 and coverage["expandedVolumes"] == 1


async def test_rolling_plan_expands_skeleton_volume(store: ProjectStore, client: LLMClient):
    await Planner(store, client, Meter(store)).bootstrap()
    outcome = await Planner(store, client, Meter(store)).roll_next()

    graph = store.outline_graph()
    assert [n.chapter for n in graph.nodes] == [1, 2, 3, 4, 5, 6]
    assert all(v.status == "expanded" for v in graph.volumes)
    assert any("第 5 章" in e.note or e.from_chapter == 5 for e in graph.edges)


# ==========================================================================
# 单章流水线
# ==========================================================================

async def test_full_chapter_lifecycle(store: ProjectStore, client: LLMClient):
    planner = Planner(store, client, Meter(store))
    await planner.bootstrap()
    meter = Meter(store)
    pipeline = Pipeline(store, client, meter)

    streamed: list[str] = []
    run = await pipeline.run(
        1, respect_policy=False,
        on_event=lambda e: streamed.append(e.get("text", "")) if e.get("type") == "delta" else None,
    )

    assert run.ok, run.paused_reason
    steps = {o.step: o.status for o in run.outcomes}
    assert steps["draft"] == "ok" and steps["commit"] == "ok"

    # 正文真的落盘了
    data = store.read_chapter(1)
    assert data["status"] == "done"
    assert data["words"] > 100
    assert "".join(streamed).count("雪是后半夜落下来的") == 1     # 流式内容被上报过

    # 审查：编造证据与无证据的条目必须被丢弃
    report = store.read_audit(1)
    dims = [i.dim for i in report.items]
    assert "设定冲突" in dims
    assert "时间线矛盾" not in dims, "编造的原文证据必须被丢弃"
    assert "节奏单调" not in dims, "无证据的条目必须被丢弃"
    assert len(report.l1_checked) == 13
    assert report.stats["open"] >= 1

    # 评审：7 维齐备并给出综合分
    review = store.read_review(1)
    assert len(review.dims) == 7
    assert 0 < review.overall < 100

    # 定稿沉淀：摘要、伏笔、世界状态
    summary = store.summary(1)
    assert summary and summary.summary
    assert store.hooks(), "定稿必须沉淀伏笔"
    assert store.state().situation
    assert store.subplots(), "定稿必须更新情节线"
    assert any(c["n"] == 1 and c["status"] == "done" for c in store.chapters_overview())

    # 8 个环节都落 checkpoint
    progress = CheckpointManager(store).progress(1)
    assert progress["done"] == 8
    assert progress["next"] is None

    # 计量与成本
    assert meter.totals()["calls"] >= 5
    assert meter.budget()["used"] >= 0
    assert len(meter.by_chapter()) >= 1


async def test_second_chapter_and_resume_diagnosis(store: ProjectStore, client: LLMClient):
    """第 1 章定稿后，恢复判断应该指向第 2 章（而不是回头再写第 1 章）。"""
    await Planner(store, client, Meter(store)).bootstrap()
    pipeline = Pipeline(store, client, Meter(store))
    await pipeline.run(1, respect_policy=False)

    plan = CheckpointManager(store).diagnose()
    assert plan.action == "write_next"
    assert plan.chapter == 2

    # 第 2 章的章纲走「单章补齐」路径
    outcome = await Planner(store, client, Meter(store)).ensure_for_chapter(2)
    assert outcome is None or outcome.action in ("plan_chapter",)


async def test_generate_then_audit_splits_into_two_runs(store: ProjectStore, client: LLMClient):
    """半自动模式：写作与审查是两次触发，中间靠 checkpoint 接续。"""
    await Planner(store, client, Meter(store)).bootstrap()
    pipeline = Pipeline(store, client, Meter(store))

    first = await pipeline.run(1, steps=["plan", "context", "draft"], respect_policy=False)
    assert first.ok
    assert store.read_chapter(1)["status"] == "draft"
    assert store.read_audit(1) is None

    cp = CheckpointManager(store)
    assert cp.is_done(1, "draft") and not cp.is_done(1, "audit")
    assert cp.diagnose().action == "re_audit"

    second = await pipeline.run(1, steps=["audit", "review"], respect_policy=False)
    assert second.ok
    assert store.read_audit(1) is not None
    assert store.read_review(1) is not None


async def test_confirm_policy_pauses_and_resumes(store: ProjectStore, client: LLMClient):
    """半自动模式下，审查环节必须停下等人确认。"""
    await Planner(store, client, Meter(store)).bootstrap()
    controller = ModeController(store)
    controller.set_mode("semi-auto")
    pipeline = Pipeline(store, client, Meter(store))

    run = await pipeline.run(1, respect_policy=True)
    assert run.paused_at == "plan"          # semi-auto 下 plan 需确认
    assert "确认" in run.paused_reason

    resumed = await pipeline.run(1, steps=["plan", "context", "draft"], respect_policy=False)
    assert resumed.ok


async def test_writer_keeps_partial_draft_on_stop(store: ProjectStore, client: LLMClient):
    """中途停止不丢稿。"""
    await Planner(store, client, Meter(store)).bootstrap()
    writer = Writer(store, client, Meter(store))
    calls = {"n": 0}

    def should_stop() -> bool:
        calls["n"] += 1
        return calls["n"] > 2          # 读到第 3 段就停

    result = await writer.write(1, should_stop=should_stop)
    assert result.cancelled
    assert 0 < len(result.paragraphs) < len(fake_llm.CHAPTER_PARAGRAPHS)
    assert store.read_chapter(1)["paragraphs"], "已生成的部分必须落盘"


# ==========================================================================
# 上下文组装
# ==========================================================================

async def test_context_respects_budget_and_injects_style(store: ProjectStore, client: LLMClient):
    await Planner(store, client, Meter(store)).bootstrap()
    # 写一段远超额度上限的草稿（中文按字计 token，2 万字 ≈ 12500 额度）
    store.write_chapter(1, ["雪" * 20000], title="雪夜", status="draft")

    bundle = build_context(store, 1, purpose="writer", context_window=8000,
                           node=store.outline_graph().node(1),
                           draft=store.chapter_text(1))

    assert bundle.used_tokens <= bundle.window
    assert bundle.notes, "裁剪了内容就必须如实说明裁了什么"
    assert any("已截断" in n for n in bundle.notes)
    sections = {s.key: s for s in bundle.sections}
    assert sections["system"].mandatory
    assert sections["draft"].truncated
    assert bundle.messages[0]["role"] == "system"
    # 不引用后文
    assert all(h.get("chapter", 0) <= 1 for h in bundle.related)


async def test_context_includes_dependency_graph_and_steering(store: ProjectStore, client: LLMClient):
    await Planner(store, client, Meter(store)).bootstrap()
    store.append_steering({"text": "节奏太慢，压缩到三段", "steps": ["压缩雪景"],
                           "target_chapter": 1})

    bundle = build_context(store, 1, purpose="writer", context_window=32000,
                           node=store.outline_graph().node(1))
    facts = next(s for s in bundle.sections if s.key == "facts")
    assert "作者干预意见" in facts.text
    assert "压缩到三段" in facts.text


# ==========================================================================
# 实时干预
# ==========================================================================

async def test_steer_on_current_chapter_is_applied(store: ProjectStore, client: LLMClient):
    """只写出草稿（未定稿）时，干预当前章应直接生效。"""
    await Planner(store, client, Meter(store)).bootstrap()
    await Pipeline(store, client, Meter(store)).run(
        1, steps=["plan", "context", "draft"], respect_policy=False)
    assert store.read_chapter(1)["status"] == "draft"

    steering = Steering(store, client, Meter(store))
    result = await steering.apply("第 1 章节奏太慢，压缩一下")
    assert result.applied and not result.pending_confirmation
    assert result.changed == ["第 1 章"]
    # 该章的后续 checkpoint 被清掉，重写时会自动带上这条意见
    assert not CheckpointManager(store).is_done(1, "audit")
    assert steering.pending_directives()
    assert "压缩一下" in (steering.pending_directives()[0].get("text") or "")


async def test_steer_on_committed_chapter_requires_confirmation(store: ProjectStore, client: LLMClient):
    """波及已定稿章节时**绝不静默改历史**——这是硬约束。"""
    await Planner(store, client, Meter(store)).bootstrap()
    await Pipeline(store, client, Meter(store)).run(1, respect_policy=False)

    fake_llm.OVERRIDES["干预解析器"] = fake_llm.STEER_COMMITTED
    try:
        steering = Steering(store, client, Meter(store))
        result = await steering.apply("把主角的旧疤来历改掉")
        assert result.pending_confirmation
        assert not result.applied
        assert "确认" in result.message
        # 未确认时不得动到已定稿内容
        assert store.read_chapter(1)["status"] == "done"

        # 即使模型说 scope=current，只要波及已定稿章也要强制转人工
        fake_llm.OVERRIDES["干预解析器"] = {
            **fake_llm.STEER_CURRENT, "scope": "current", "affected_chapters": [1]}
        result2 = await steering.apply("压缩第 1 章")
        assert result2.pending_confirmation, "安全兜底必须覆盖模型的自评"
    finally:
        fake_llm.OVERRIDES.clear()


async def test_confirm_directive_applies_it(store: ProjectStore, client: LLMClient):
    await Planner(store, client, Meter(store)).bootstrap()
    await Pipeline(store, client, Meter(store)).run(1, respect_policy=False)

    fake_llm.OVERRIDES["干预解析器"] = fake_llm.STEER_COMMITTED
    try:
        steering = Steering(store, client, Meter(store))
        result = await steering.apply("改掉旧疤来历")
        confirmed = steering.confirm_directive(result.directive_id)
        assert confirmed["ok"]
        assert store.read_chapter(1)["status"] == "draft"
    finally:
        fake_llm.OVERRIDES.clear()


# ==========================================================================
# 共创对话
# ==========================================================================

async def test_chat_persists_settings(store: ProjectStore, client: LLMClient):
    agent = ChatAgent(store, client, Meter(store))
    seed = agent.seed()
    assert seed["genre"] == "古风悬疑"
    assert seed["readyForPlan"] is True       # 建项目时已给题材与前提
    assert seed["protagonist"] == "（尚未确立）"

    reply = await agent.reply("一个北境小吏追查失踪案，发现王朝正在被文脉吞噬。")
    assert reply["options"] and "我自己说" in reply["options"]
    assert reply["records"]["protagonist"]

    # 聊过的内容必须沉淀进 meta，做到「聊完就能开工」
    meta = store.meta()
    assert meta.genre == "古风悬疑"
    assert "文脉" in meta.premise
    assert agent.history()


# ==========================================================================
# 整本生产
# ==========================================================================

async def test_run_book_writes_multiple_chapters(store: ProjectStore, client: LLMClient):
    runner = BookRunner(store, client, Meter(store))
    report = await runner.run(max_chapters=2)

    data = report.public()
    assert data["completedChapters"] == [1, 2]
    assert report.cost > 0
    assert len(store.chapters_overview()) >= 3
    assert store.hook_stats()["total"] >= 1

    summary = runner.summary()
    assert summary["words"] > 0
    assert summary["committed"] == 2
    assert summary["audits"] and summary["hooks"]["total"] >= 1


async def test_run_stops_at_budget_ceiling(store: ProjectStore, client: LLMClient):
    meta = store.meta()
    meta.budget_total = 0.0001          # 几乎一有花费就熔断
    store.save_meta(meta)

    runner = BookRunner(store, client, Meter(store))
    report = await runner.run(max_chapters=5)
    assert report.stop_condition == "budget.exceeded"
    assert "预算" in report.stopped_reason


async def test_run_respects_stop_condition_on_blocker(store: ProjectStore, client: LLMClient, monkeypatch):
    """命中 blocker 时必须挂起，不继续往下写。"""
    fake_llm.OVERRIDES["严谨的中文长篇小说审校"] = {"items": [
        {"dim": "设定冲突", "severity": "blocker",
         "evidence": "灯没有点，灯芯那一小截却是亮的",
         "suggestion": "改为以血引燃"},
    ]}
    try:
        runner = BookRunner(store, client, Meter(store))
        report = await runner.run(max_chapters=3)
        assert report.stop_condition == "audit.blocker_exists"
        assert len(report.chapters) == 1
        assert store.read_audit(1).stats["blocker"] >= 1
    finally:
        fake_llm.OVERRIDES.clear()


# ==========================================================================
# 拆书
# ==========================================================================

RAW_NOVEL = """第1章 江上行
那年水来得早。江砚舟把刀插在船板上，戴着斗笠看江面。
秦九娘从舱里出来，手里捏着一只毒囊，囊口有官制火漆。
「你不该回来。」她说。
江砚舟没有答话。

第2章 旧刀
刀是十年前的旧刀。他左手使刀，刀锋上有缺口。
老渔翁在岸边看着，没有说话。他是哑的，但识水性。
江砚舟想起丢刀那年的江汛异常提前。

第3章 渡口
寒江渡口之外，江湖人不许动兵刃。
白面判官站在渡口，左脸有烙印。
江砚舟把刀收进斗笠下面。
"""


async def test_disassemble_produces_proposals_without_writing_truth(store: ProjectStore, client: LLMClient):
    from dobi.ingest.disassemble import Disassembler

    worker = Disassembler(store, client, Meter(store))
    result = await worker.run(filename="寒江独钓.txt", text=RAW_NOVEL)
    data = result.public()

    assert data["source"]["chapters"] == 3
    assert data["stats"]["characters"] >= 1
    assert data["stats"]["worldRules"] >= 1
    assert data["proposals"], "必须产出写入提案"

    # 关键：拆书**不直接写真相文件**，等人接受
    assert store.characters() == [] or all(
        c.name != "江砚舟" for c in store.characters())

    accepted = await worker.decide(data["proposals"][0]["id"], "accept")
    assert accepted["ok"]
    assert store.characters(), "接受后必须真的写入"
