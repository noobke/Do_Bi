"""确定性模块的单元测试：JSON 容错、真相文件闸门、规则校验、计量、checkpoint、故事时间。

这些全部零模型成本，是回归的主力。
"""

from __future__ import annotations

import pytest

from dobi.agents.writer import split_paragraphs
from dobi.consistency.l1 import L1Input, check_l1, rule_catalog
from dobi.core.checkpoint import CheckpointManager
from dobi.core.metering import Meter, estimate_tokens
from dobi.core.schema import (
    ChapterSummary,
    Character,
    Hook,
    OutlineNode,
    Proposal,
    UsageEntry,
    WorldRule,
)
from dobi.core.store import ProjectStore, TruthWriter, count_words
from dobi.core.story import book_anchors, chapter_events, story_time_key
from dobi.errors import BudgetExceeded
from dobi.llm.jsonutil import JSONExtractError, extract_json

SAMPLE = (
    "雪是后半夜落下来的。沈砚站在城楼上，看着那些碎白的东西一层层盖住关外的车辙。\n\n"
    "他左眉骨的那道旧疤在冷风里隐隐发紧。他心中不由自主地一凛，空气仿佛凝固了。\n\n"
    "「你也在看这个。」崔十九把一只青铜小灯放在雪地上。灯没有点，灯芯那一小截却是亮的。\n\n"
    "沈砚把灯收进袖中，转身下了城楼。仿佛什么都没发生过，仿佛那盏灯从未亮过。"
)


# ==========================================================================
# JSON 容错解析
# ==========================================================================

class TestJsonUtil:
    def test_plain(self):
        assert extract_json('{"a": 1}') == {"a": 1}

    def test_fenced(self):
        assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}
        assert extract_json('```\n{"a": 1}\n```') == {"a": 1}

    def test_with_prose_around(self):
        text = '好的，结果如下：{"a": 1, "b": [1,2]} 希望有帮助。'
        assert extract_json(text)["b"] == [1, 2]

    def test_trailing_comma_and_bare_key(self):
        assert extract_json('{"a": 1, "b": [1,2,], }')["b"] == [1, 2]
        assert extract_json('{a: 1}')["a"] == 1

    def test_smart_quotes(self):
        assert extract_json('{\u201ca\u201d: 1}')["a"] == 1

    def test_truncated_gets_repaired_or_raises(self):
        # 被 max_tokens 截断：能补就补，补不了就如实报错，不得返回半截数据
        try:
            data = extract_json('{"items": [{"dim": "设定冲突"')
        except JSONExtractError:
            return
        assert isinstance(data, dict)

    def test_empty_raises(self):
        with pytest.raises(JSONExtractError):
            extract_json("   ")

    def test_garbage_raises(self):
        with pytest.raises(JSONExtractError):
            extract_json("这不是 JSON，完全没有花括号。")


# ==========================================================================
# Proposal → Validate → Commit
# ==========================================================================

class TestTruthGate:
    def test_add_and_read_back(self, store: ProjectStore):
        writer = TruthWriter(store)
        result = writer.commit([Proposal(
            id="c1", kind="character_add",
            payload=Character(id="char_001", name="沈砚", lead=True,
                              immutable_traits=["左眉骨有旧疤"]).model_dump())])
        assert [p.id for p in result.applied] == ["c1"]
        assert store.character("沈砚").immutable_traits == ["左眉骨有旧疤"]

    def test_duplicate_name_in_same_batch_is_blocked(self, store: ProjectStore):
        """同一批里新增两个同名角色也必须被拦下。"""
        writer = TruthWriter(store)
        result = writer.commit([
            Proposal(id="a", kind="character_add",
                     payload=Character(id="char_001", name="沈砚",
                                       immutable_traits=["x"]).model_dump()),
            Proposal(id="b", kind="character_add",
                     payload=Character(id="char_002", name="沈砚",
                                       immutable_traits=["y"]).model_dump()),
        ])
        assert [p.id for p in result.applied] == ["a"]
        assert [p.id for p in result.pending] == ["b"]
        assert any(i.kind == "重复角色" for i in result.issues)
        assert len(store.characters()) == 1

    def test_immutable_trait_cannot_be_removed(self, store: ProjectStore):
        writer = TruthWriter(store)
        writer.commit([Proposal(id="c", kind="character_add",
                                payload=Character(id="char_001", name="沈砚",
                                                  immutable_traits=["不饮酒", "惯用左手"]).model_dump())])
        result = writer.commit([Proposal(
            id="u", kind="character_update",
            payload={"id": "char_001", "changes": {"immutable_traits": ["不饮酒"]}})])
        assert result.pending and not result.applied
        assert any(i.kind == "违背不可变特征" for i in result.issues)
        assert len(store.character("沈砚").immutable_traits) == 2

    def test_dead_character_cannot_revive(self, store: ProjectStore):
        writer = TruthWriter(store)
        writer.commit([Proposal(id="c", kind="character_add", payload=Character(
            id="char_004", name="沈定山", deceased=True,
            state={"location": "—", "status": "第 3 章确认亡故"}).model_dump())])
        result = writer.commit([Proposal(
            id="r", kind="character_update",
            payload={"id": "char_004", "changes": {"deceased": False}})])
        assert result.pending
        assert any(i.kind == "角色复活" for i in result.issues)

    def test_duplicate_hook_blocked_by_similarity(self, store: ProjectStore):
        writer = TruthWriter(store)
        writer.commit([Proposal(id="h1", kind="hook_add", payload=Hook(
            id="hook_001", content="沈砚幼年见过的青铜灯并未熄灭", planted_chapter=4,
            suggested_resolve_by=25).model_dump())])
        result = writer.commit([Proposal(id="h2", kind="hook_add", payload=Hook(
            id="hook_002", content="沈砚幼时见过的青铜灯并未熄灭", planted_chapter=5).model_dump())])
        assert result.pending
        assert any(i.kind == "重复伏笔" for i in result.issues)

    def test_loosely_related_hook_is_allowed(self, store: ProjectStore):
        """只是同题材、并非重复的伏笔必须放行——否则会挡住正常埋设。"""
        writer = TruthWriter(store)
        writer.commit([Proposal(id="h1", kind="hook_add", payload=Hook(
            id="hook_001", content="青铜灯的灯芯为何自明", planted_chapter=4).model_dump())])
        result = writer.commit([Proposal(id="h2", kind="hook_add", payload=Hook(
            id="hook_002", content="验尸文书上少了一页", planted_chapter=5).model_dump())])
        assert result.applied
        assert len(result.issues) == 0

    def test_hook_resolve_flow(self, store: ProjectStore):
        writer = TruthWriter(store)
        writer.commit([Proposal(id="h1", kind="hook_add", payload=Hook(
            id="hook_001", content="青铜灯的灯芯为何自明", planted_chapter=1,
            suggested_resolve_by=3).model_dump())])
        result = writer.commit([Proposal(id="r", kind="hook_resolve",
                                         payload={"id": "hook_001", "chapter": 3})])
        assert result.applied
        hook = store.hook("hook_001")
        assert hook.status == "resolved" and hook.resolved_chapter == 3
        assert store.hook_stats(3)["rate"] == 100

    def test_hook_resolve_before_plant_is_blocked(self, store: ProjectStore):
        writer = TruthWriter(store)
        writer.commit([Proposal(id="h1", kind="hook_add", payload=Hook(
            id="hook_001", content="某条伏笔", planted_chapter=10).model_dump())])
        result = writer.commit([Proposal(id="r", kind="hook_resolve",
                                         payload={"id": "hook_001", "chapter": 2})])
        assert result.pending
        assert any(i.kind == "时序矛盾" for i in result.issues)

    def test_outline_and_edges_round_trip(self, store: ProjectStore):
        writer = TruthWriter(store)
        result = writer.commit([
            Proposal(id="n1", kind="outline_upsert", payload=OutlineNode(
                chapter=1, title="雪夜换防", goal="引入铜灯", beats=["雪夜巡查"],
                rationale="为第 3 章铺垫", story_at="当夜",
                timeline=[{"at": "当夜", "label": "雪夜换防", "kind": "now"}]).model_dump()),
            Proposal(id="e1", kind="edge_add", payload={
                "from_chapter": 3, "to_chapter": 1, "type": "setup",
                "note": "第 3 章的铜灯呼应追溯到第 1 章"}),
        ])
        assert not result.pending, result.issues
        graph = store.outline_graph()
        assert graph.node(1).title == "雪夜换防"
        assert graph.node(1).story_at == "当夜"
        assert len(graph.edges) == 1
        # 第 3 章依赖第 1 章 → 反查「第 3 章的前因」应能查到第 1 章
        assert [e.to_chapter for e in graph.motivations_for(3)] == [1]
        # outline.json 是派生投影，必须同步生成
        assert store.read_json(store.outline_path)["chapters"][0]["chapter"] == 1

    def test_reversed_dependency_edge_is_flagged(self, store: ProjectStore):
        """方向反了不阻塞写入，但必须提示——否则「前因」永远查不出来。"""
        result = TruthWriter(store).commit([Proposal(
            id="e", kind="edge_add", payload={
                "from_chapter": 1, "to_chapter": 3, "type": "setup", "note": "写反了"})])
        assert result.applied
        assert any(i.kind == "依赖边方向可疑" for i in result.issues)
        assert store.outline_graph().motivations_for(3) == []

    def test_markdown_projection_regenerated(self, store: ProjectStore):
        writer = TruthWriter(store)
        writer.commit([Proposal(id="w", kind="world_add", payload=WorldRule(
            id="w1", category="器物", kind="hard",
            rule="铜灯须以血引方燃").model_dump())])
        assert "铜灯须以血引方燃" in store.read_text(store.world_md)

    def test_force_bypasses_error_but_keeps_warning_logged(self, store: ProjectStore):
        writer = TruthWriter(store)
        writer.commit([Proposal(id="c", kind="character_add", payload=Character(
            id="char_001", name="沈砚", immutable_traits=["不饮酒"]).model_dump())])
        result = writer.commit([Proposal(id="d", kind="character_add", payload=Character(
            id="char_002", name="沈砚", immutable_traits=["x"]).model_dump())], force=True)
        assert result.applied
        assert any(i.level == "error" for i in result.issues)


# ==========================================================================
# 规则校验（13 条）
# ==========================================================================

class TestL1:
    def test_catalog_has_13_rules(self):
        catalog = rule_catalog()
        assert len(catalog) == 13
        assert all({"key", "rule"} <= set(r) for r in catalog)

    def test_checked_always_contains_all_13(self):
        result = check_l1(L1Input(text="很短的一段。", chapter=1))
        assert len(result.checked) == 13
        assert {r["rule"] for r in result.checked} == {c["rule"] for c in rule_catalog()}

    def test_detects_expected_violations(self, store: ProjectStore):
        store.save_characters([
            Character(id="char_001", name="沈砚", lead=True,
                      immutable_traits=["左眉骨有旧疤", "不饮酒"]),
            Character(id="char_004", name="沈定山", deceased=True,
                      state={"location": "—", "status": "第 3 章确认亡故"}),
        ])
        store.save_hooks([Hook(id="hook_005", content="不该有的车辙",
                               planted_chapter=5, suggested_resolve_by=1)])
        text = SAMPLE + "\n\n沈定山站在门口，端起酒盏饮了一口。"
        result = check_l1(L1Input(
            text=text, chapter=17,
            characters=store.characters(), hooks=store.hooks(),
            world_rules=store.world().rules, style=store.style(),
            characters_present=["沈定山"],
        ))
        hit = {v.rule for v in result.violations}
        assert "角色已死亡仍出场" in hit
        assert "不可变特征被违背" in hit
        assert "套话密度超阈值" in hit
        assert "伏笔超期未回收" in hit

    def test_empty_text_does_not_crash(self):
        result = check_l1(L1Input(text="", chapter=1))
        assert len(result.checked) == 13

    def test_no_evidence_no_fabrication(self, store: ProjectStore):
        """干净的文本不应报出大量违规——误报率是这条规则的生命线。"""
        clean = ("城楼上的雪积了一夜。他数过砖缝里的冰碴，一共十七处。"
                 "风从北面来，带着枯草的味道。他把手拢进袖中，等了很久。")
        result = check_l1(L1Input(text=clean, chapter=1))
        assert len(result.violations) <= 3


# ==========================================================================
# 计量与预算熔断
# ==========================================================================

class TestMetering:
    def test_estimate_tokens_scales_with_length(self):
        assert estimate_tokens("") == 0
        short, long = estimate_tokens("你好"), estimate_tokens("你好" * 200)
        assert 0 < short < long

    def test_cost_and_budget(self, store: ProjectStore):
        meter = Meter(store)
        meter.record(UsageEntry(chapter=1, step="draft", cost=10.0, total_tokens=1000))
        assert meter.totals()["cost"] == 10.0
        assert meter.budget()["level"] == "ok"

        meter.record(UsageEntry(chapter=2, step="draft", cost=60.0, total_tokens=2000))
        assert meter.budget()["level"] == "warning"      # 70/80 ≥ 80%
        assert meter.warning() is not None
        assert len(meter.by_chapter()) == 2

    def test_budget_exceeded_raises(self, store: ProjectStore):
        meta = store.meta()
        meta.budget_total = 5.0
        store.save_meta(meta)
        Meter(store).record(UsageEntry(chapter=1, step="draft", cost=5.0))
        with pytest.raises(BudgetExceeded):
            Meter(store).check_budget()

    def test_zero_budget_means_unlimited(self, store: ProjectStore):
        meta = store.meta()
        meta.budget_total = 0
        store.save_meta(meta)
        Meter(store).record(UsageEntry(chapter=1, step="draft", cost=9999.0))
        Meter(store).check_budget()          # 不应抛
        assert Meter(store).budget()["unlimited"] is True

    def test_reconcile_fixes_drifted_meta(self, store: ProjectStore):
        meter = Meter(store)
        meter.record(UsageEntry(chapter=1, step="draft", cost=3.5))
        meta = store.meta()
        meta.budget_used = 999.0
        store.save_meta(meta)
        assert meter.reconcile() == 3.5
        assert store.meta().budget_used == 3.5


# ==========================================================================
# checkpoint 与断点恢复
# ==========================================================================

class TestCheckpoint:
    def test_progress_and_idempotency(self, store: ProjectStore):
        cp = CheckpointManager(store)
        key = CheckpointManager.key(1, "draft")
        assert not cp.already_applied(key)
        cp.finish(cp.begin(1, "draft"))
        assert cp.already_applied(key)
        assert cp.is_done(1, "draft")
        assert cp.progress(1)["done"] == 1
        assert cp.progress(1)["next"] == "plan"      # 只完成了 draft，plan 还没做

    def test_reset_from(self, store: ProjectStore):
        cp = CheckpointManager(store)
        for step in ("plan", "draft", "audit"):
            cp.finish(cp.begin(1, step))
        assert cp.progress(1)["done"] == 3
        cp.reset_from(1, step="draft")
        assert cp.is_done(1, "plan")
        assert not cp.is_done(1, "draft")

    def test_diagnose_replan_when_truth_empty(self, store: ProjectStore):
        plan = CheckpointManager(store).diagnose()
        assert plan.action == "replan"
        assert "missing" in plan.detail

    def test_diagnose_re_audit_then_continue_revise(self, store: ProjectStore):
        writer = TruthWriter(store)
        writer.commit([
            Proposal(id="w", kind="world_add", payload=WorldRule(
                id="w1", category="器物", rule="铜灯须以血引方燃").model_dump()),
            Proposal(id="c", kind="character_add", payload=Character(
                id="char_001", name="沈砚", immutable_traits=["不饮酒"]).model_dump()),
            Proposal(id="n", kind="outline_upsert", payload=OutlineNode(
                chapter=1, title="雪夜", goal="引入", beats=["巡查"]).model_dump()),
        ])
        cp = CheckpointManager(store)

        # 场景 3：有正文但没审查报告
        store.write_chapter(1, split_paragraphs(SAMPLE), title="雪夜", status="draft")
        assert cp.diagnose().action == "re_audit"

        # 场景 4：有审查报告但重点问题未处理
        from dobi.core.schema import AuditItem, AuditReport
        store.save_audit(AuditReport(chapter=1, title="雪夜", items=[
            AuditItem(dim="设定冲突", severity="major", evidence="灯没有点",
                      suggestion="改为以血引燃")]))
        store.update_chapter_status(1, "audit")
        plan = cp.diagnose()
        assert plan.action == "continue_revise"
        assert plan.detail["open"] == ["设定冲突"]


# ==========================================================================
# 故事时间推导
# ==========================================================================

class TestStoryTime:
    def test_years_ago_sorts_before_now(self):
        assert story_time_key("二十年前", 1) < story_time_key("当夜", 1)
        assert story_time_key("三日前", 5) < story_time_key("当夜", 1)

    def test_anchors_ordered_and_deduped(self, store: ProjectStore):
        writer = TruthWriter(store)
        writer.commit([
            Proposal(id="n1", kind="outline_upsert", payload=OutlineNode(
                chapter=1, title="雪夜", goal="引入", beats=["巡查"], story_at="当夜",
                timeline=[{"at": "当夜", "label": "雪夜换防", "kind": "now"},
                          {"at": "二十年前", "label": "黑水营溃口", "kind": "backstory"}]).model_dump()),
            Proposal(id="n3", kind="outline_upsert", payload=OutlineNode(
                chapter=3, title="铜灯", goal="呼应", beats=["对峙"], story_at="第三日",
                timeline=[{"at": "第三日", "label": "铜灯初亮", "kind": "now"}]).model_dump()),
        ])
        anchors = book_anchors(store)
        assert anchors[0]["storyAt"] == "二十年前"       # 回溯类排最前
        assert anchors[-1]["storyAt"] == "第三日"
        assert [e["label"] for e in chapter_events(store, 1)] == ["雪夜换防", "黑水营溃口"]


# ==========================================================================
# 文本工具
# ==========================================================================

class TestTextTools:
    def test_prompt_placeholders_are_all_named_fields(self):
        """提示词里出现未转义的花括号会直接炸掉 `.format()`（曾经真的踩过：
        「每条 `{at, label, kind}`」被当成字段名，抛 `KeyError: 'at, label, kind'`）。"""
        import string

        from dobi.agents import prompts

        offenders: dict[str, list[str]] = {}
        for name in dir(prompts):
            value = getattr(prompts, name)
            if not isinstance(value, str):
                continue
            for _, field, _, _ in string.Formatter().parse(value):
                if field is None:
                    continue
                if not field.isidentifier():
                    offenders.setdefault(name, []).append(field)
        assert not offenders, f"这些提示词的花括号没转义：{offenders}"

    def test_count_words_counts_cjk_by_char(self):
        assert count_words("四个汉字") == 4
        assert count_words("hello world") == 2
        assert count_words("中文 abc 三个字") == 6

    def test_split_paragraphs_strips_heading_and_enders(self):
        raw = "第 17 章 雪落雁回\n\n第一段内容。\n\n第二段内容。\n\n（本章完）"
        assert split_paragraphs(raw) == ["第一段内容。", "第二段内容。"]


class TestSecretsFromEnvFile:
    """密钥写进 `.env` 就必须生效。

    曾经的真实故障：`Settings` 会把 `.env` 读进模型字段，但 `ProviderSpec.api_key`
    读的是 `os.environ`，两者不通——文档说的「复制 .env.example 填密钥」完全是假象，
    只有 `export` 出来的进程环境变量才算数。
    """

    def test_key_in_env_file_is_visible_to_providers(self, tmp_path, monkeypatch):
        from dobi.config import load_providers, reload_config

        monkeypatch.delenv("DOBI_KEY_DEEPSEEK", raising=False)
        env_file = tmp_path / ".env"
        env_file.write_text("DOBI_KEY_DEEPSEEK=sk-from-dotenv-file-7777\n",
                            encoding="utf-8")
        monkeypatch.setenv("DOBI_ENV_FILE", str(env_file))
        reload_config()
        try:
            deepseek = next(p for p in load_providers() if p.name == "DeepSeek")
            assert deepseek.configured is True
            assert deepseek.api_key == "sk-from-dotenv-file-7777"
        finally:
            reload_config()

    def test_real_env_var_wins_over_env_file(self, tmp_path, monkeypatch):
        """进程环境变量优先——部署时用 `export` 覆盖 `.env` 是合理预期。"""
        from dobi.config import load_providers, reload_config

        env_file = tmp_path / ".env"
        env_file.write_text("DOBI_KEY_DEEPSEEK=sk-from-file\n", encoding="utf-8")
        monkeypatch.setenv("DOBI_ENV_FILE", str(env_file))
        monkeypatch.setenv("DOBI_KEY_DEEPSEEK", "sk-from-process-env")
        reload_config()
        try:
            deepseek = next(p for p in load_providers() if p.name == "DeepSeek")
            assert deepseek.api_key == "sk-from-process-env"
        finally:
            reload_config()
