"""HTTP 契约测试：跑在假模型上，验证路由、错误体、SSE 与序列化约定。

这些用例的价值不在「功能对不对」，而在**契约稳不稳**：
前端 `web/src/api/client.ts` 依赖的每个路径与字段，都在这里被钉住。
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from dobi.main import app


@pytest.fixture()
def http(env, monkeypatch) -> TestClient:
    import fake_llm
    from conftest import install_fake_transport

    install_fake_transport(monkeypatch, fake_llm.fake_transport())
    fake_llm.OVERRIDES.clear()
    with TestClient(app) as client:
        yield client
    fake_llm.OVERRIDES.clear()


@pytest.fixture()
def project(http: TestClient) -> str:
    resp = http.post("/api/projects", json={
        "title": "雁回关", "genre": "古风悬疑",
        "premise": "一个北境小吏追查失踪案，却发现王朝正在被「文脉」的力量吞噬。",
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["project"]["id"]


# ==========================================================================
# 基础
# ==========================================================================

class TestBasics:
    def test_health(self, http: TestClient):
        data = http.get("/api/health").json()
        assert data["ok"] is True
        assert data["providers"]["configured"] is True

    def test_health_without_keys(self, env, monkeypatch):
        for name in ("DOBI_KEY_DEEPSEEK", "DOBI_KEY_MIMO", "DOBI_KEY_OPENAI",
                     "DOBI_KEY_DASHSCOPE", "DOBI_KEY_SILICONFLOW"):
            monkeypatch.delenv(name, raising=False)
        from dobi.config import reload_config
        reload_config()
        data = TestClient(app).get("/api/health").json()
        assert data["providers"]["configured"] is False
        assert "尚未配置" in data["providers"]["message"]

    def test_error_shape_is_author_facing(self, http: TestClient):
        resp = http.get("/api/projects/does-not-exist")
        assert resp.status_code == 404
        body = resp.json()
        assert set(body) >= {"code", "message"}
        assert body["code"] == "not_found"
        # 文案面向作者，不出现研发语汇
        for word in ("traceback", "None", "KeyError", "provider", "token"):
            assert word not in body["message"]

    def test_validation_error_is_400_with_chinese_message(self, http: TestClient):
        resp = http.post("/api/projects", json={"title": ""})
        assert resp.status_code == 400
        assert resp.json()["code"] == "bad_request"

    def test_generation_without_project_returns_404(self, http: TestClient):
        assert http.get("/api/projects/none/chapters").status_code == 404


# ==========================================================================
# 项目与规划
# ==========================================================================

class TestProjects:
    def test_create_list_open_delete(self, http: TestClient, project: str):
        listing = http.get("/api/projects").json()
        assert listing["current"] == project
        assert listing["projects"][0]["isCurrent"] is True

        # 中文标题也能生成可读的 id
        assert project.startswith("novel-") or project.isascii()

        detail = http.get(f"/api/projects/{project}").json()
        assert detail["project"]["title"] == "雁回关"
        assert len(detail["mode"]["steps"]) == 8

        assert http.delete(f"/api/projects/{project}").json()["ok"] is True
        assert http.get(f"/api/projects/{project}").status_code == 404

    def test_traversal_project_ids_are_rejected(self, http: TestClient, project: str):
        """project_id 来自路径参数，必须先过白名单：非法 id 一律 404，绝不落到真实目录。"""
        for bad in ("..", "%2E%2E", "..%2F..", "%2e%2e"):
            for resp in (http.get(f"/api/projects/{bad}"),
                         http.delete(f"/api/projects/{bad}")):
                assert resp.status_code == 404, (bad, resp.status_code)

        # 编码后的穿越没被客户端归一化，会走到我们的校验：按普通「不存在的作品」处理
        encoded = http.get("/api/projects/%2E%2E")
        assert encoded.json()["code"] == "not_found"
        assert "没有这个作品" in encoded.json()["message"]

        # 正常 id 不能被白名单误杀
        assert http.get(f"/api/projects/{project}").status_code == 200

    def test_mode_switching(self, http: TestClient, project: str):
        data = http.post(f"/api/projects/{project}/mode", json={"mode": "auto"}).json()
        assert data["mode"] == "auto"
        assert all(s["policy"] == "auto" for s in data["steps"])

        data = http.post(f"/api/projects/{project}/mode",
                         json={"step": "audit", "policy": "manual"}).json()
        audit = next(s for s in data["steps"] if s["key"] == "audit")
        assert audit["policy"] == "manual"
        assert audit["needsConfirmation"] is True

    def test_plan_then_structure(self, http: TestClient, project: str):
        plan = http.post(f"/api/projects/{project}/plan", json={}).json()
        assert len(plan["changed"]) >= 3
        assert not plan["pending"]

        structure = http.get(f"/api/projects/{project}/structure").json()
        assert [n["chapter"] for n in structure["nodes"]] == [1, 2, 3]
        assert len(structure["edges"]) == 3
        assert structure["compass"]["endgame"]
        # 全书故事时间锚点（剧情树 / 双轨时间线的数据源）
        assert structure["anchors"], "结构接口必须给出时间锚点，否则剧情树画不出来"
        assert structure["anchors"][0]["storyAt"] == "二十年前"      # 回溯类排最前
        # camelCase 契约（前端按这个写）
        assert "storyAt" in structure["nodes"][0]
        assert "fromChapter" in structure["edges"][0]

        coverage = http.get(f"/api/projects/{project}/plan/coverage").json()
        assert coverage["nodes"] == 3

        graph = http.get(f"/api/projects/{project}/outline/graph").json()
        assert graph["volumes"][0]["status"] == "expanded"

    def test_rolling_plan(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        result = http.post(f"/api/projects/{project}/plan/rolling").json()
        assert result["changed"]
        assert len(http.get(f"/api/projects/{project}/structure").json()["nodes"]) == 6

    def test_overview_aggregates(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        data = http.get(f"/api/projects/{project}/overview").json()
        assert {"project", "chapters", "hooks", "usage", "mode", "resume"} <= set(data)
        assert data["resume"]["label"]

    def test_chat_round_trip(self, http: TestClient, project: str):
        seed = http.get(f"/api/projects/{project}/chat").json()
        assert seed["seed"]["genre"] == "古风悬疑"

        reply = http.post(f"/api/projects/{project}/chat",
                          json={"message": "一个北境小吏追查失踪案。"}).json()
        assert reply["options"] and reply["records"]["protagonist"]
        assert http.get(f"/api/projects/{project}/chat").json()["messages"]


# ==========================================================================
# 章节全流程
# ==========================================================================

class TestChapterFlow:
    def test_generate_is_sse_and_persists_draft(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        resp = http.post(f"/api/projects/{project}/chapters/1/generate", json={})
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert "event: delta" in resp.text
        assert "event: done" in resp.text
        assert "雪是后半夜落下来的" in resp.text

        chapter = http.get(f"/api/projects/{project}/chapters/1").json()["chapter"]
        assert chapter["status"] == "draft"
        assert chapter["paragraphs"]

    def test_full_pipeline_over_http(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        http.post(f"/api/projects/{project}/chapters/1/generate", json={})

        audit = http.post(f"/api/projects/{project}/chapters/1/audit", json={}).json()
        assert len(audit["l1Checked"]) == 13
        assert audit["stats"]["open"] >= 1

        review = http.post(f"/api/projects/{project}/chapters/1/review").json()
        assert len(review["dims"]) == 7

        deai = http.post(f"/api/projects/{project}/chapters/1/deai").json()
        assert deai["status"] in ("ok", "skipped")

        commit = http.post(f"/api/projects/{project}/chapters/1/commit").json()
        assert commit["status"] == "ok"
        assert http.get(f"/api/projects/{project}/chapters/1").json()["chapter"]["status"] == "done"

    def test_finding_decision_updates_stats(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        http.post(f"/api/projects/{project}/chapters/1/generate", json={})
        before = http.post(f"/api/projects/{project}/chapters/1/audit", json={}).json()

        resp = http.post(f"/api/projects/{project}/chapters/1/findings/设定冲突/decision",
                         json={"action": "ignore"})
        assert resp.status_code == 200
        after = resp.json()["stats"]
        assert after["open"] <= before["stats"]["open"]

        # 撤回决策
        resp = http.post(f"/api/projects/{project}/chapters/1/findings/设定冲突/decision",
                         json={"action": None})
        assert resp.status_code == 200

        bad = http.post(f"/api/projects/{project}/chapters/1/findings/设定冲突/decision",
                        json={"action": "whatever"})
        assert bad.status_code == 400

    def test_commit_before_audit_is_refused(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        http.post(f"/api/projects/{project}/chapters/1/generate", json={})
        outcome = http.post(f"/api/projects/{project}/chapters/1/commit").json()
        assert outcome["status"] == "skipped"
        assert "审查" in outcome["note"]

    def test_stop_keeps_partial(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        data = http.post(f"/api/projects/{project}/chapters/1/stop").json()
        assert data["ok"] and "已停止" in data["message"]

    def test_manuscript_and_detail(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        http.post(f"/api/projects/{project}/chapters/1/generate", json={})

        ms = http.get(f"/api/projects/{project}/chapters/1/manuscript").json()
        assert ms["paragraphs"][0]["gutter"] == "1.1"

        detail = http.get(f"/api/projects/{project}/chapters/1/detail").json()
        assert {"pipeline", "timeline", "fishbone", "acts", "beats", "context"} <= set(detail)
        assert detail["pipeline"]["total"] == 8
        assert detail["timeline"]["anchors"], "剧情树必须有真实锚点"
        # 双轨时间线的匹配结果必须自洽
        assert detail["timeline"]["located"] <= detail["timeline"]["total"]

    def test_checkpoints_and_run_state(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        http.post(f"/api/projects/{project}/chapters/1/generate", json={})
        cp = http.get(f"/api/projects/{project}/chapters/1/checkpoints").json()
        assert cp["progress"]["done"] >= 1
        state = http.get(f"/api/projects/{project}/run/state").json()
        assert state["resume"]["action"] == "re_audit"

    def test_project_level_audit(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        assert http.get(f"/api/projects/{project}/audit").json()["chapter"] is None

        http.post(f"/api/projects/{project}/chapters/1/generate", json={})
        http.post(f"/api/projects/{project}/chapters/1/audit", json={})
        data = http.get(f"/api/projects/{project}/audit").json()
        assert data["chapter"] == 1
        assert len(data["rules"]) == 13


# ==========================================================================
# 真相文件视图
# ==========================================================================

class TestTruthViews:
    def test_characters(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        data = http.get(f"/api/projects/{project}/characters").json()
        assert data["stats"]["total"] == 2
        assert "全部" in data["roles"]

        one = http.get(f"/api/projects/{project}/characters/沈砚").json()
        assert one["immutableTraits"]

        updated = http.post(f"/api/projects/{project}/characters/沈砚/state",
                            json={"status": "左臂刀伤已愈", "chapter": 5}).json()
        assert updated["character"]["state"]["status"] == "左臂刀伤已愈"

    def test_character_state_cannot_touch_immutable_traits(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        # 接口层面就没有这个入口；用更新不可变特征的提案去撞校验器
        from dobi.core.schema import Proposal
        from dobi.core.store import ProjectStore, TruthWriter
        from dobi.api.deps import get_store
        store = get_store(project)
        result = TruthWriter(store).commit([Proposal(
            id="x", kind="character_update",
            payload={"id": "char_001", "changes": {"immutable_traits": []}})])
        assert result.pending

    def test_hooks_and_resolve(self, http: TestClient, project: str):
        resp = http.post(f"/api/projects/{project}/hooks", json={
            "content": "青铜小灯的灯芯为何自明", "planted_chapter": 1,
            "importance": "major", "suggested_resolve_by": 2})
        assert resp.status_code == 201
        hook_id = resp.json()["hooks"][0]["id"]

        over = http.get(f"/api/projects/{project}/hooks").json()
        assert over["hooks"][0]["overdue"] in (True, False)

        resolved = http.post(f"/api/projects/{project}/hooks/{hook_id}/resolve",
                             json={"chapter": 2}).json()
        assert resolved["stats"]["rate"] == 100

        assert http.post(f"/api/projects/{project}/hooks/nope/resolve",
                         json={}).status_code == 404

    def test_world_and_conflict_resolution(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        world = http.get(f"/api/projects/{project}/world").json()
        assert world["stats"]["hard"] >= 3
        assert "硬约束" in world["markdown"]

        kind = http.post(f"/api/projects/{project}/world/w2/kind", json={"kind": "soft"}).json()
        assert kind["stats"]["hard"] >= 2

        shot = http.post(f"/api/projects/{project}/world/w1/resolve",
                         json={"resolution": "keep_text"}).json()
        assert shot["resolution"] == "keep_text"
        assert http.post(f"/api/projects/{project}/world/w1/resolve",
                         json={"resolution": "乱写"}).status_code == 400

    def test_style_presets_and_banned(self, http: TestClient, project: str):
        data = http.get(f"/api/projects/{project}/style").json()
        assert len(data["presets"]) == 9
        assert data["sources"]

        applied = http.post(f"/api/projects/{project}/style/apply",
                            json={"preset_id": "sp_mystery"}).json()
        assert applied["profile"]["source"]

        add = http.post(f"/api/projects/{project}/style/banned", json={"expr": "心中一凛"}).json()
        assert "心中一凛" in add["banned"]
        rm = http.request("DELETE", f"/api/projects/{project}/style/banned",
                          params={"expr": "心中一凛"}).json()
        assert "心中一凛" not in rm["banned"]

        assert http.post(f"/api/projects/{project}/style/apply",
                         json={"preset_id": "nope"}).status_code == 404

    def test_style_analyze_from_sample(self, http: TestClient, project: str):
        sample = "灯是旧的。柄上有一道缺口，缺口里积着黑垢。他盯着那道缺口，许久没有动。" * 6
        data = http.post(f"/api/projects/{project}/style/analyze",
                         json={"sample": sample, "source_ids": []}).json()
        assert data["profile"]["analyzedAt"]
        assert data["profile"]["sentence"]["mean"] > 0

        assert http.post(f"/api/projects/{project}/style/analyze",
                         json={"sample": "  "}).status_code == 400

    def test_usage_and_stats(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        usage = http.get(f"/api/projects/{project}/usage").json()
        assert usage["totals"]["calls"] >= 1
        assert usage["budget"]["total"] > 0

        stats = http.get(f"/api/projects/{project}/stats").json()
        assert stats["worldRules"] == 4
        assert stats["memory"]["chunks"] >= 1


# ==========================================================================
# 干预 / 生产 / 设置
# ==========================================================================

class TestOps:
    def test_steer_current_and_committed(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        http.post(f"/api/projects/{project}/chapters/1/generate", json={})

        current = http.post(f"/api/projects/{project}/steer",
                            json={"text": "节奏太慢，压缩一下"}).json()
        assert current["applied"] is True
        assert current["intent"]["actionLabel"]

        import fake_llm
        fake_llm.OVERRIDES["干预解析器"] = fake_llm.STEER_COMMITTED
        try:
            pending = http.post(f"/api/projects/{project}/steer",
                                json={"text": "改掉旧疤来历"}).json()
            assert pending["pendingConfirmation"] is True
            assert pending["applied"] is False

            confirmed = http.post(
                f"/api/projects/{project}/steer/{pending['directiveId']}",
                json={"action": "confirm"}).json()
            assert confirmed["ok"] is True

            dismissed = http.post(
                f"/api/projects/{project}/steer/{pending['directiveId']}",
                json={"action": "dismiss"}).json()
            assert dismissed["ok"] is True
        finally:
            fake_llm.OVERRIDES.clear()

        assert http.post(f"/api/projects/{project}/steer/steer_999",
                         json={"action": "confirm"}).json()["ok"] is False

    def test_run_is_sse(self, http: TestClient, project: str):
        resp = http.post(f"/api/projects/{project}/run", json={"max_chapters": 1})
        assert resp.status_code == 200
        text = resp.text
        assert "event: resume" in text
        assert "event: chapter_done" in text
        assert "event: run_done" in text
        assert http.get(f"/api/projects/{project}/chapters/1").json()["chapter"]["status"] == "done"

    def test_run_stops_midway_without_keys(self, http: TestClient, project: str, monkeypatch):
        """没配密钥时必须明确报 503，而不是静默跑出一个空结果。"""
        from dobi.config import reload_config
        monkeypatch.delenv("DOBI_KEY_DEEPSEEK", raising=False)
        monkeypatch.delenv("DOBI_KEY_MIMO", raising=False)
        monkeypatch.delenv("DOBI_KEY_OPENAI", raising=False)
        monkeypatch.delenv("DOBI_KEY_DASHSCOPE", raising=False)
        monkeypatch.delenv("DOBI_KEY_SILICONFLOW", raising=False)
        reload_config()
        resp = http.post(f"/api/projects/{project}/plan", json={})
        assert resp.status_code == 503
        assert resp.json()["code"] == "not_configured"

    def test_disassemble_does_not_write_until_accepted(self, http: TestClient, project: str):
        raw = "第1章 江上行\n那年水来得早。江砚舟把刀插在船板上。\n\n第2章 旧刀\n刀是十年前的旧刀。\n"
        data = http.post(f"/api/projects/{project}/disassemble",
                         json={"filename": "寒江独钓.txt", "text": raw * 8}).json()
        assert data["source"]["chapters"] >= 2
        assert data["proposals"]
        assert http.get(f"/api/projects/{project}/characters").json()["stats"]["total"] == 0

        first = data["proposals"][0]["id"]
        decided = http.post(
            f"/api/projects/{project}/disassemble/proposals/{first}/decision",
            json={"action": "accept"}).json()
        assert decided["ok"] is True

        saved = http.get(f"/api/projects/{project}/disassemble").json()
        assert saved["proposals"]

    def test_settings_providers(self, http: TestClient):
        data = http.get("/api/settings/providers").json()
        assert [p["name"] for p in data["providers"]][:2] == ["DeepSeek", "MiMo"]
        assert len(data["roles"]) == 11
        # 密钥永不外泄：只给脱敏指纹
        for provider in data["providers"]:
            assert "api_key" not in provider
            assert "sk-test-deepseek-0001" not in json.dumps(provider)
            if provider["configured"]:
                assert provider["fingerprint"].startswith("sk-t")
                assert "*" in provider["fingerprint"]

        updated = http.put("/api/settings/providers/OpenAI", json={"enabled": False}).json()
        assert next(p for p in updated["providers"] if p["name"] == "OpenAI")["enabled"] is False
        assert http.put("/api/settings/providers/nope", json={}).status_code == 404

    def test_set_api_key_from_settings_page(self, http: TestClient):
        """设置页可以直接填密钥：写进 `.env`、立即生效、且不回显。"""
        marker = "sk-ui-typed-9f3a1c"
        resp = http.put("/api/settings/providers/MiMo", json={"apiKey": marker})
        assert resp.status_code == 200, resp.text
        mimo = next(p for p in resp.json()["providers"] if p["name"] == "MiMo")
        assert mimo["configured"] is True
        # 响应里不能出现密钥本体
        assert marker not in json.dumps(resp.json())

        # 立即生效：探测不再报「未配置」
        assert http.post("/api/settings/providers/MiMo/probe").json()["ok"] is True

        # 落盘到隔离的 .env（测试绝不碰真实 server/.env）
        import os
        from pathlib import Path
        env_file = Path(os.environ["DOBI_ENV_FILE"])
        assert f"DOBI_KEY_MIMO={marker}" in env_file.read_text(encoding="utf-8")

        # 清除
        cleared = http.put("/api/settings/providers/MiMo", json={"apiKey": ""}).json()
        assert next(p for p in cleared["providers"] if p["name"] == "MiMo")["configured"] is False

    def test_probe_provider(self, http: TestClient):
        data = http.post("/api/settings/providers/DeepSeek/probe").json()
        assert data["ok"] is True
        assert data["probe"]["latencyMs"] is not None
        assert http.post("/api/settings/providers/nope/probe").status_code == 404

    def test_mcp_is_optional_and_degrades(self, http: TestClient, project: str):
        servers = http.get("/api/settings/mcp").json()
        assert len(servers["servers"]) == 3
        assert "回落" in servers["note"]
        assert [s["name"] for s in servers["servers"]] == [
            "本地档案库 local-archive", "Obsidian 笔记库 obsidian-vault",
            "资料检索 reference-search"]

        # 随附的本地示例服务是真能连上的；短标识 local-archive 也能匹配到
        tested = http.post("/api/settings/mcp/local-archive/test").json()
        assert tested["ok"] is True
        assert {"lookup_setting", "search_reference"} <= set(tested["result"]["tools"])

        # 占位地址必然连不上，但必须给出可读原因，且不抛异常
        broken = http.post("/api/settings/mcp/reference-search/test").json()
        assert broken["ok"] is False
        assert broken["result"]["error"]

        # 切换启用状态
        toggled = http.post("/api/settings/mcp/toggle",
                            json={"name": "reference-search"}).json()
        assert toggled["ok"]
        assert next(s for s in toggled["servers"]
                    if s["name"].endswith("reference-search"))["enabled"] is True

        # 外部工具不可用时，检索必须自动回落为内置实现
        search = http.get(f"/api/projects/{project}/tools/search",
                          params={"q": "铜灯", "k": 3}).json()
        assert search.get("ok") is True

    async def test_mcp_resolves_relative_command_from_any_cwd(
            self, env, monkeypatch, tmp_path):
        """stdin 命令是相对路径（以 server/ 为基准）。把工作目录切走后仍要连得上，
        否则换目录启动后端会静默降级成内置检索（测试恰好在 server/ 下跑，掩盖了这点）。"""
        from dobi.integrations.mcp import McpRegistry

        away = tmp_path / "away"
        away.mkdir()
        monkeypatch.chdir(away)
        result = await McpRegistry().test("local-archive")
        assert result["ok"] is True, result

    def test_update_role_from_settings_page(self, http: TestClient):
        """模型分工可改：换服务商 / 换模型 / 调温度，立即生效并回显。"""
        data = http.put("/api/settings/roles/writer",
                        json={"provider": "MiMo", "model": "mimo-v2.6-flash",
                              "temperature": 0.5}).json()
        assert data["ok"] is True
        writer = next(r for r in data["roles"] if r["key"] == "writer")
        assert writer["provider"] == "MiMo"
        assert writer["model"] == "mimo-v2.6-flash"
        assert writer["temperature"] == "0.50"          # 对外是两位小数字符串
        assert data["fallbackChain"] == ["DeepSeek", "MiMo"]

        # 目录里没有的模型名也允许填（厂商上新很快），但会给一句提醒
        noted = http.put("/api/settings/roles/writer",
                         json={"model": "brand-new-model-x"}).json()
        assert noted["ok"] is True and noted["note"]

        assert http.put("/api/settings/roles/nope", json={"model": "x"}).status_code == 404
        assert http.put("/api/settings/roles/writer", json={"model": "   "}).status_code == 400

    def test_update_mcp_servers_crud(self, http: TestClient):
        """外部工具能新增 / 编辑 / 删除；删光不会回落成出厂默认。"""
        added = http.put("/api/settings/mcp", json={"servers": [
            {"name": "本地档案库 local-archive", "transport": "stdio",
             "command": "python3 mcp/example_server.py",
             "tools": ["lookup_setting"], "enabled": True},
            {"name": "我的新工具 my-tool", "transport": "http",
             "url": "https://example.com/mcp", "tools": ["do_thing"], "enabled": True},
        ]}).json()
        assert added["ok"] is True
        assert [s["name"] for s in added["servers"]] == [
            "本地档案库 local-archive", "我的新工具 my-tool"]

        # 删光：空清单是合法状态
        emptied = http.put("/api/settings/mcp", json={"servers": []}).json()
        assert emptied["servers"] == []
        assert http.get("/api/settings/mcp").json()["servers"] == []

        # 校验：stdio 缺命令 / http 地址不合法 / 重名
        assert http.put("/api/settings/mcp", json={"servers": [
            {"name": "x", "transport": "stdio", "command": ""}]}).status_code == 400
        assert http.put("/api/settings/mcp", json={"servers": [
            {"name": "y", "transport": "http", "url": "ftp://bad"}]}).status_code == 400
        assert http.put("/api/settings/mcp", json={"servers": [
            {"name": "z", "transport": "stdio", "command": "echo"},
            {"name": "z", "transport": "stdio", "command": "echo"}]}).status_code == 400

    def test_update_project_budget(self, http: TestClient, project: str):
        """本书总预算可写：落到项目 meta、立即生效；0 表示不设上限。"""
        ok = http.put(f"/api/projects/{project}/budget", json={"total": 120})
        assert ok.status_code == 200, ok.text
        assert ok.json()["budget"]["total"] == 120.0
        assert ok.json()["budget"]["unlimited"] is False

        # 立即生效：meta 与成本接口都能看到新值
        assert http.get(f"/api/projects/{project}").json()["meta"]["budgetTotal"] == 120.0
        assert http.get(f"/api/projects/{project}/usage").json()["budget"]["total"] == 120.0

        # 0 表示不设上限
        assert http.put(f"/api/projects/{project}/budget",
                        json={"total": 0}).json()["budget"]["unlimited"] is True

        # 负数不合法（校验错 → 400 + 中文文案）
        bad = http.put(f"/api/projects/{project}/budget", json={"total": -1})
        assert bad.status_code == 400

    def test_budget_cannot_go_below_spent(self, http: TestClient, project: str):
        """预算下限：不得低于已发生的成本，否则一保存就熔断。"""
        from dobi.api.deps import get_store
        from dobi.core.metering import Meter
        from dobi.core.schema import UsageEntry

        Meter(get_store(project)).record(UsageEntry(chapter=1, step="draft", cost=5.0))
        resp = http.put(f"/api/projects/{project}/budget", json={"total": 1})
        assert resp.status_code == 400
        assert "不得低于" in resp.json()["message"]

        # 高于已用成本就放行
        assert http.put(f"/api/projects/{project}/budget",
                        json={"total": 8}).status_code == 200


# ==========================================================================
# 知识库：实体索引 / 跨类检索 / 关系图谱 / 双向链接
# ==========================================================================

class TestKnowledge:
    """知识库全部由真相文件派生，只读。这里直接写真相文件来铺关系，不经过模型。"""

    @staticmethod
    def _seed(store) -> None:
        from dobi.core.schema import (Character, Hook, OutlineGraph, OutlineNode,
                                      Relation, Subplot, WorldDoc, WorldRule)

        store.save_characters([
            Character(id="char_001", name="沈砚", role="主角", lead=True,
                      aliases=["沈大人"], first_appearance=1,
                      relationships=[Relation(target="陆青梧", type="师徒")]),
            Character(id="char_002", name="陆青梧", role="配角", first_appearance=2),
        ])
        store.save_hooks([
            Hook(id="hook_001", content="青铜灯在子时自行熄灭", planted_chapter=1,
                 importance="major", linked_characters=["char_001"],
                 suggested_resolve_by=9),
        ])
        store.save_world(WorldDoc(rules=[
            WorldRule(id="rule_001", category="器物", kind="hard",
                      rule="青铜灯灭时，亡者复归", refs=[1, 2]),
        ]))
        store.save_subplots([
            Subplot(id="sp_001", name="文脉之秘", kind="main", active=[1, 2]),
        ])
        # 章节是这张网的枢纽：设定引用它、支线活跃在它、角色出场于它。
        store.save_outline_graph(OutlineGraph(nodes=[
            OutlineNode(chapter=1, title="灯灭", status="written"),
            OutlineNode(chapter=2, title="名单", status="planned"),
        ]))

    def test_index_lists_entities_with_author_facing_labels(self, http: TestClient, store):
        self._seed(store)
        data = http.get(f"/api/projects/{store.root.name}/knowledge").json()
        assert data["stats"]["characters"] == 2
        assert data["stats"]["hooks"] == 1
        assert data["stats"]["rules"] == 1
        assert data["stats"]["links"] > 0

        char = next(e for e in data["entities"] if e["id"] == "char_001")
        assert char["key"] == "character:char_001"
        assert char["kindLabel"] == "角色"          # 面向作者，不是内部类型名
        assert "主角" in char["tags"]
        assert {e["kind"] for e in data["entities"]} >= {"character", "hook", "rule", "subplot"}

        # degree 让清单能按「牵连多少」排序：串起师徒与伏笔的沈砚，一定多于没写关系的角色
        assert char["degree"] >= 2
        assert char["degree"] > next(e for e in data["entities"] if e["id"] == "char_002")["degree"]

    def test_graph_scope_controls_which_kinds_are_drawn(self, http: TestClient, store):
        self._seed(store)
        pid = store.root.name

        core = http.get(f"/api/projects/{pid}/knowledge/graph?scope=core").json()
        assert {n["kind"] for n in core["nodes"]} == {"character", "hook"}
        types = {e["type"] for e in core["edges"]}
        assert "relation" in types            # 人物关系
        assert "hook_character" in types      # 伏笔 ⇄ 角色
        assert all(n["degree"] >= 1 for n in core["nodes"])
        assert core["legend"]

        wider = http.get(f"/api/projects/{pid}/knowledge/graph?scope=all").json()
        assert {"rule", "subplot"} <= {n["kind"] for n in wider["nodes"]}
        assert wider["stats"]["edges"] >= core["stats"]["edges"]

    def test_entity_detail_has_both_directions(self, http: TestClient, store):
        self._seed(store)
        pid = store.root.name
        detail = http.get(f"/api/projects/{pid}/knowledge/entity/character/char_001").json()
        assert detail["entity"]["title"] == "沈砚"
        assert "陆青梧" in {r["title"] for r in detail["outbound"]}     # 出链：师徒
        assert "hook_character" in {r["type"] for r in detail["inbound"]}  # 入链：伏笔

        assert http.get(f"/api/projects/{pid}/knowledge/entity/character/nope").status_code == 404
        assert http.get(f"/api/projects/{pid}/knowledge/entity/unknown/1").status_code == 400

    def test_search_finds_across_kinds(self, http: TestClient, store):
        self._seed(store)
        pid = store.root.name
        data = http.get(f"/api/projects/{pid}/knowledge/search",
                        params={"q": "青铜灯", "k": 5}).json()
        assert data["hits"], data
        assert {"world", "hook"} & {h["kind"] for h in data["hits"]}
        assert data["hits"][0]["kindLabel"]

        blank = http.get(f"/api/projects/{pid}/knowledge/search", params={"q": "  "}).json()
        assert blank["hits"] == []


# ==========================================================================
# 序列化契约：前端只认 camelCase
# ==========================================================================

def _assert_camel(value: object, path: str = "") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            assert "_" not in str(key), f"{path}.{key} 是 snake_case，前端契约要求 camelCase"
            _assert_camel(child, f"{path}.{key}")
    elif isinstance(value, list):
        for i, child in enumerate(value):
            _assert_camel(child, f"{path}[{i}]")


class TestSerializationContract:
    """前端 `web/src/api/client.ts` 直接按 camelCase 取值，任何 snake_case 泄漏都是破坏性变更。"""

    ENDPOINTS = [
        "/api/projects",
        "/api/projects/{pid}",
        "/api/projects/{pid}/overview",
        "/api/projects/{pid}/stats",
        "/api/projects/{pid}/structure",
        "/api/projects/{pid}/outline/graph",
        "/api/projects/{pid}/plan/coverage",
        "/api/projects/{pid}/chapters",
        "/api/projects/{pid}/chapters/1",
        "/api/projects/{pid}/chapters/1/manuscript",
        "/api/projects/{pid}/chapters/1/detail",
        "/api/projects/{pid}/chapters/1/audit",
        "/api/projects/{pid}/chapters/1/review",
        "/api/projects/{pid}/chapters/1/checkpoints",
        "/api/projects/{pid}/chapters/1/context",
        "/api/projects/{pid}/audit",
        "/api/projects/{pid}/characters",
        "/api/projects/{pid}/hooks",
        "/api/projects/{pid}/world",
        "/api/projects/{pid}/style",
        "/api/projects/{pid}/usage",
        "/api/projects/{pid}/run/state",
        "/api/projects/{pid}/chat",
        "/api/projects/{pid}/plan/coverage",
        "/api/projects/{pid}/knowledge",
        "/api/projects/{pid}/knowledge/graph",
        "/api/settings/providers",
        "/api/settings/mcp",
        "/api/health",
    ]

    def test_no_snake_case_leaks(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        http.post(f"/api/projects/{project}/chapters/1/generate", json={})
        http.post(f"/api/projects/{project}/chapters/1/audit", json={})
        http.post(f"/api/projects/{project}/chapters/1/review", json={})
        http.post(f"/api/projects/{project}/steer", json={"text": "节奏慢一点"})
        http.post(f"/api/projects/{project}/disassemble", json={
            "filename": "样本.txt", "text": "第1章 江上行\n那年水来得早。" * 20})

        for endpoint in self.ENDPOINTS:
            path = endpoint.replace("{pid}", project)
            resp = http.get(path)
            assert resp.status_code == 200, f"{path} → {resp.status_code} {resp.text[:200]}"
            _assert_camel(resp.json(), path)

    def test_sse_frames_are_camel(self, http: TestClient, project: str):
        """SSE 的 data 也是响应的一部分，同样不得泄漏 snake_case。"""
        http.post(f"/api/projects/{project}/plan", json={})
        resp = http.post(f"/api/projects/{project}/chapters/1/generate", json={})
        assert resp.status_code == 200
        seen = 0
        for block in resp.text.split("\n\n"):
            data = [ln[5:].strip() for ln in block.splitlines() if ln.startswith("data:")]
            if not data:
                continue
            payload = json.loads("\n".join(data))
            if isinstance(payload, dict):
                _assert_camel(payload)
                seen += 1
        assert seen >= 2, "至少要看到 delta 与 done 两类数据帧"

    def test_write_endpoints_are_camel_too(self, http: TestClient, project: str):
        # 注意：generate / run 返回的是 SSE，不是 JSON，不在此列。
        # 这里连**错误体**一起检查——错误体也是契约的一部分。
        for resp in (
            http.post("/api/projects", json={"title": "铜灯不熄"}),
            http.post(f"/api/projects/{project}/mode", json={"mode": "auto"}),
            http.post(f"/api/projects/{project}/plan", json={}),
            http.post(f"/api/projects/{project}/hooks", json={
                "content": "铜灯的来历", "planted_chapter": 1}),
            http.post(f"/api/projects/{project}/chapters/1/stop"),
            http.post(f"/api/projects/{project}/chapters/1/audit", json={}),   # 无正文 → 400
            http.post("/api/settings/providers/DeepSeek/probe"),
        ):
            assert resp.headers["content-type"].startswith("application/json"), resp.text[:120]
            _assert_camel(resp.json(), f"write({resp.status_code})")


class TestRequestBodyContract:
    """请求体也走 camelCase——与响应同一套规则（`serialize.api_alias`）。

    前端 `client.ts` 一律发 camelCase（`plantedChapter` / `knownSecrets` / `runL2`）。
    这些用例验证它**真的被接住**，而不是被 pydantic 当未知字段静默丢弃
    （曾经就是这样：接口 2xx 但入参没生效）。
    """

    def test_project_fields_from_camel_body(self, http: TestClient):
        resp = http.post("/api/projects", json={
            "title": "铜灯记", "genre": "悬疑", "premise": "灯灭人归。",
            "budgetTotal": 12.5, "chaptersTotal": 9})
        assert resp.status_code == 201, resp.text
        pid = resp.json()["project"]["id"]
        meta = http.get(f"/api/projects/{pid}").json()["meta"]
        assert meta["budgetTotal"] == 12.5
        assert meta["chaptersTotal"] == 9

    def test_hook_from_camel_body(self, http: TestClient, project: str):
        resp = http.post(f"/api/projects/{project}/hooks", json={
            "content": "青铜灯为何在无风时自明", "plantedChapter": 4,
            "suggestedResolveBy": 12})
        assert resp.status_code == 201, resp.text
        hook = resp.json()["hooks"][0]
        assert hook["plantedChapter"] == 4
        assert hook["suggestedResolveBy"] == 12

    def test_audit_run_l2_flag_from_camel_body(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={})
        http.post(f"/api/projects/{project}/chapters/1/generate", json={})
        resp = http.post(f"/api/projects/{project}/chapters/1/audit",
                         json={"runL2": False})
        assert resp.status_code == 200, resp.text
        assert resp.json()["stats"]["l2"] == 0

    def test_character_state_from_camel_body(self, http: TestClient, project: str):
        http.post(f"/api/projects/{project}/plan", json={"targets": ["characters"]})
        chars = http.get(f"/api/projects/{project}/characters").json()["characters"]
        key = chars[0]["id"]
        resp = http.post(f"/api/projects/{project}/characters/{key}/state",
                         json={"knownSecrets": ["灯下名单"]})
        assert resp.status_code == 200, resp.text
        assert resp.json()["character"]["state"]["knownSecrets"] == ["灯下名单"]

    def test_snake_case_body_still_works(self, http: TestClient, project: str):
        """脚本 / CLI 侧仍可发 snake_case，两种写法必须都认。"""
        resp = http.post(f"/api/projects/{project}/hooks", json={
            "content": "雪夜的旧信从未被拆开", "planted_chapter": 2})
        assert resp.status_code == 201, resp.text
        assert resp.json()["hooks"][0]["plantedChapter"] == 2
