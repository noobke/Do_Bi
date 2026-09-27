"""CLI 入口（Typer）。

设计取向：CLI 是**P0 的验收方式**——不依赖浏览器就能跑通
「一句灵感 → 10 章正文 → 审查 → 断点续跑」并看到指标。
同时它也是排障时最趁手的工具（`dobi providers` / `dobi probe`）。

所有子命令都支持 `--project/-p` 指定作品；省略时用「当前作品」。
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any, Iterable, Optional

import typer

from .config import get_settings, load_providers, load_roles, mask
from .core.checkpoint import CheckpointManager
from .core.memory import MemoryIndex
from .core.metering import Meter
from .core.store import ProjectStore, slugify
from .errors import DobiError, NotConfigured
from .llm.provider import LLMClient
from .orchestrator import BookRunner, Pipeline, Planner, Steering

app = typer.Typer(
    add_completion=False,
    help="Do_Bi 小说创作台 · 后端 CLI。先 `dobi providers` 确认密钥，再 `dobi new` 开书。",
)
style_app = typer.Typer(help="文风仿写：分析样本、应用预设、管理禁用词。")
app.add_typer(style_app, name="style")


# ==========================================================================
# 基础设施
# ==========================================================================

def _root() -> Path:
    root = get_settings().projects_dir
    root.mkdir(parents=True, exist_ok=True)
    return root


def _resolve(project: str | None) -> ProjectStore:
    root = _root()
    if not project:
        current = get_settings().data_dir / "current.json"
        if current.exists():
            import json
            try:
                pid = json.loads(current.read_text(encoding="utf-8")).get("id")
            except Exception:
                pid = None
            if pid and (root / pid / "meta.json").exists():
                return ProjectStore(root / pid)
        stores = [ProjectStore(p) for p in sorted(root.iterdir())
                  if p.is_dir() and (p / "meta.json").exists()]
        if len(stores) == 1:
            return stores[0]
        raise typer.BadParameter("请用 --project 指定作品（当前没有唯一默认作品）。")

    target = root / project
    if (target / "meta.json").exists():
        return ProjectStore(target)
    matches = [p for p in sorted(root.iterdir())
               if p.is_dir() and (p / "meta.json").exists()
               and (project in p.name or project in ProjectStore(p).meta().title)]
    if len(matches) == 1:
        return ProjectStore(matches[0])
    if not matches:
        raise typer.BadParameter(f"找不到作品：{project}")
    names = "、".join(p.name for p in matches)
    raise typer.BadParameter(f"「{project}」匹配到多个作品：{names}")


def _client(store: ProjectStore) -> LLMClient:
    meter = Meter(store)
    from .core.schema import UsageEntry

    def on_usage(entry: dict[str, Any]) -> None:
        tokens = entry.get("tokens") or {}
        meter.record(UsageEntry(
            chapter=int(entry.get("chapter") or 0), step=str(entry.get("step") or ""),
            role=str(entry.get("role") or ""), provider=str(entry.get("provider") or ""),
            model=str(entry.get("model") or ""),
            prompt_tokens=int(tokens.get("prompt_tokens") or 0),
            completion_tokens=int(tokens.get("completion_tokens") or 0),
            total_tokens=int(tokens.get("total_tokens") or 0),
            cost=float(entry.get("cost") or 0.0),
            latency_ms=int(entry.get("latencyMs") or 0),
            attempts=int(entry.get("attempts") or 1),
            ts=str(entry.get("ts") or ""),
        ))

    return LLMClient(on_usage=on_usage)


def _run_async(coro):
    try:
        return asyncio.run(coro)
    except DobiError as exc:
        typer.secho(f"✗ {exc.message}", fg=typer.colors.RED, err=True)
        if exc.detail:
            typer.secho(f"  {exc.detail}", fg=typer.colors.BRIGHT_BLACK, err=True)
        raise typer.Exit(code=2)
    except KeyboardInterrupt:
        typer.secho("\n已中断。进度已按步保存，用 `dobi resume` 继续。", fg=typer.colors.YELLOW)
        raise typer.Exit(code=130)


def _ok(text: str) -> None:
    typer.secho(f"✓ {text}", fg=typer.colors.GREEN)


def _info(text: str) -> None:
    typer.secho(f"· {text}", fg=typer.colors.BRIGHT_BLACK)


def _fail(text: str) -> None:
    typer.secho(f"✗ {text}", fg=typer.colors.RED, err=True)


def _table(rows: Iterable[tuple[str, str]], *, gap: int = 2) -> None:
    rows = list(rows)
    if not rows:
        return
    width = max(len(r[0]) for r in rows)
    for left, right in rows:
        typer.echo(f"  {left.ljust(width)}{' ' * gap}{right}")


PROJECT_OPT = typer.Option(None, "--project", "-p", help="作品 id 或标题片段；省略则用当前作品")


# ==========================================================================
# 服务
# ==========================================================================

@app.command()
def serve(
    host: str = typer.Option(None, help="监听地址，默认取 DOBI_HOST"),
    port: int = typer.Option(None, help="端口，默认取 DOBI_PORT"),
    reload: bool = typer.Option(False, "--reload", help="改代码自动重载（开发用）"),
) -> None:
    """启动 API 服务。"""
    import uvicorn

    settings = get_settings()
    settings.ensure_dirs()
    typer.secho("Do_Bi 后端启动中…", fg=typer.colors.CYAN)
    _info(f"文档：http://{host or settings.host}:{port or settings.port}/docs")
    _info(f"数据目录：{settings.data_dir}")
    if not any(p.enabled and p.configured for p in load_providers()):
        _fail("尚未配置任何模型密钥 —— 生成类接口会返回 503。请先填写 .env。")
    uvicorn.run("dobi.main:app", host=host or settings.host, port=port or settings.port,
                reload=reload)


@app.command()
def health() -> None:
    """自检：密钥、数据目录、依赖。"""
    settings = get_settings()
    providers = load_providers()
    usable = [p for p in providers if p.enabled and p.configured]
    _table([
        ("数据目录", str(settings.data_dir)),
        ("已启用服务商", "、".join(p.name for p in providers if p.enabled) or "（无）"),
        ("已配置密钥", "、".join(f"{p.name}（{mask(p.api_key)}）" for p in usable) or "（无）"),
        ("降级链", " → ".join(p.name for p in usable) or "（空：配置密钥后自动建立）"),
        ("作品数", str(len([p for p in settings.projects_dir.iterdir()
                            if (p / 'meta.json').exists()])
                      if settings.projects_dir.exists() else 0)),
    ])
    if usable:
        _ok("可以开工。")
    else:
        _fail("还没有可用的模型密钥：复制 .env.example 为 .env 并至少填一个。")


@app.command("providers")
def list_providers() -> None:
    """列出服务商、模型分工与降级链。"""
    settings = get_settings()
    providers = load_providers()
    usable = [p for p in providers if p.enabled and p.configured]
    typer.secho("服务商", fg=typer.colors.CYAN, bold=True)
    for p in providers:
        mark = "✓" if p.configured else "✗"
        state = "已启用" if p.enabled else "已停用"
        key = mask(p.api_key) or f"未设置 {p.api_key_ref}"
        typer.echo(f"  [{p.priority}] {mark} {p.name}  {state}  密钥：{key}")
        typer.echo(f"       {p.base_url}")
        for m in p.models:
            pricing = (f"　{m.price_in:g}/{m.price_out:g} 元·百万"
                       if (m.price_in or m.price_out) else "　未标价")
            typer.echo(f"       · {m.name}　窗口 {m.context_window}{pricing}")
        if p.probed.checked_at:
            typer.echo(f"       探测：{'通' if p.probed.ok else '不通'}"
                       f"　{p.probed.latency_ms} ms　{p.probed.error or ''}")
    typer.echo()
    typer.secho("降级链", fg=typer.colors.CYAN, bold=True)
    typer.echo("  " + (" → ".join(p.name for p in usable) if usable else "（空）"))
    typer.echo()
    typer.secho("模型分工", fg=typer.colors.CYAN, bold=True)
    for role in load_roles().values():
        typer.echo(f"  {role.label:<16} {role.model:<24} 温度 {role.temperature:.2f}　{role.fmt}")


@app.command()
def probe(name: str = typer.Argument(..., help="服务商名称，如 DeepSeek")) -> None:
    """连通性测试：真发一次最小请求。"""
    provider = next((p for p in load_providers() if p.name == name), None)
    if provider is None:
        _fail(f"没有这个服务商：{name}")
        raise typer.Exit(code=1)
    if not provider.configured:
        _fail(f"「{name}」还没有填密钥：请在 .env 里设置 {provider.api_key_ref}")
        raise typer.Exit(code=1)

    async def _go():
        store = _probe_store()
        async with _client(store) as client:
            return await client.probe(name)

    result = _run_async(_go())
    if result.get("ok"):
        _ok(f"{name} 连通，{result.get('latency_ms')} ms")
    else:
        _fail(f"{name} 不通：{result.get('error')}")
        raise typer.Exit(code=1)


def _probe_store() -> ProjectStore:
    root = get_settings().data_dir / "_probe"
    if not (root / "meta.json").exists():
        ProjectStore.create(root.parent, "_probe", title="连通性探测")
    return ProjectStore(root)


# ==========================================================================
# 作品
# ==========================================================================

@app.command()
def new(
    title: str = typer.Argument(..., help="作品标题"),
    genre: str = typer.Option("待定", "--genre", "-g"),
    premise: str = typer.Option("", "--premise", help="一句话灵感"),
    chapters: int = typer.Option(0, "--chapters", help="预计总章数，0 表示由大纲自行估计"),
    budget: float = typer.Option(None, "--budget", help="预算上限（元）"),
    mode: str = typer.Option("semi-auto", "--mode", help="auto / semi-auto / manual"),
) -> None:
    """新建作品（一句灵感即可开工）。"""
    import hashlib

    base = slugify(title, fallback="")
    if not base:
        base = "novel-" + hashlib.sha1(title.encode("utf-8")).hexdigest()[:8]
    root = _root()
    pid, i = base, 2
    while (root / pid / "meta.json").exists():
        pid = f"{base}-{i}"
        i += 1

    store = ProjectStore.create(root, pid, title=title, genre=genre, premise=premise,
                                logline=premise, mode=mode, budget_total=budget)
    if chapters:
        meta = store.meta()
        meta.chapters_total = chapters
        store.save_meta(meta)
    MemoryIndex(store).reindex()
    (get_settings().data_dir / "current.json").write_text(
        '{"id": "%s"}' % pid, encoding="utf-8")
    _ok(f"已创建《{title}》　id={pid}")
    _info(f"下一步：dobi plan {pid}")


@app.command("list")
def list_projects() -> None:
    """列出全部作品与进度。"""
    root = _root()
    stores = [ProjectStore(p) for p in sorted(root.iterdir())
              if p.is_dir() and (p / "meta.json").exists()]
    if not stores:
        typer.echo("还没有作品。用 `dobi new <标题>` 开一本。")
        return
    for store in stores:
        s = store.project_summary()
        hooks = store.hook_stats()
        typer.secho(f"  {s['title']}　({store.id})", bold=True)
        typer.echo(f"      题材 {s['genre']}　进度 {s['chaptersDone']}/{s['chaptersTotal']} 章"
                   f"　{s['words']} 字　伏笔回收 {hooks['resolved']}/{hooks['total']}"
                   f"（{hooks['rate']}%）")
        typer.echo(f"      预算 {s['budgetUsed']:.2f}/{s['budgetTotal']:.2f}　"
                   f"模式 {s['mode']}　更新 {s['updatedAt']}")


@app.command()
def plan(
    project: str = typer.Option(None, "--project", "-p"),
    targets: str = typer.Option("world,characters,outline", "--targets",
                                help="world / characters / outline，逗号分隔"),
    volumes: int = typer.Option(2, "--volumes", help="初始规划几卷"),
    roll: bool = typer.Option(False, "--roll", help="展开下一卷骨架弧（滚动规划）"),
) -> None:
    """生成或刷新世界观、角色、大纲与依赖图。"""
    store = _resolve(project)

    async def _go():
        async with _client(store) as client:
            planner = Planner(store, client, Meter(store))
            return await (planner.roll_next() if roll else planner.bootstrap(
                volumes=volumes, targets=[t.strip() for t in targets.split(",") if t.strip()]))

    result = _run_async(_go())
    _ok(f"完成：{'、'.join(result.changed)}")
    for note in result.notes:
        _info(note)
    if result.issues:
        typer.secho("校验提示：", fg=typer.colors.YELLOW)
        for issue in result.issues:
            typer.echo(f"  [{issue['level']}] {issue['message']}")
    if result.pending:
        typer.secho(f"有 {len(result.pending)} 条未通过校验，已降级为待人工确认（未写入）。",
                    fg=typer.colors.YELLOW)


@app.command()
def write(
    chapter: int = typer.Argument(..., help="章号"),
    project: str = typer.Option(None, "--project", "-p"),
    quiet: bool = typer.Option(False, "--quiet", help="不逐字打印，只报结果"),
) -> None:
    """生成正文（流式打印）。"""
    store = _resolve(project)

    async def _go():
        async with _client(store) as client:
            pipeline = Pipeline(store, client, Meter(store))

            def on_event(event: dict[str, Any]) -> None:
                if event.get("type") == "delta" and not quiet:
                    sys.stdout.write(event.get("text", ""))
                    sys.stdout.flush()
                elif event.get("type") == "step" and event.get("status") == "running":
                    if not quiet:
                        typer.secho(f"\n— {event.get('label')} —", fg=typer.colors.BRIGHT_BLACK)

            return await pipeline.run(chapter, steps=["plan", "context", "draft"],
                                      on_event=on_event, respect_policy=False)

    run = _run_async(_go())
    typer.echo()
    for outcome in run.outcomes:
        if outcome.status == "ok":
            _ok(f"{outcome.label}：{outcome.note}")
        elif outcome.status == "skipped":
            _info(f"{outcome.label}：{outcome.note}")
    _info(f"本章花费 {run.cost:.4f} 元")


@app.command()
def audit(chapter: int = typer.Argument(...),
          project: str = typer.Option(None, "--project", "-p")) -> None:
    """审查：规则校验（13 条）+ 模型审查（按维度开关）。"""
    store = _resolve(project)

    async def _go():
        async with _client(store) as client:
            pipeline = Pipeline(store, client, Meter(store))
            return await pipeline.run_step(chapter, "audit")

    outcome = _run_async(_go())
    _ok(outcome.note)
    report = store.read_audit(chapter)
    if report is not None:
        typer.secho("规则校验", fg=typer.colors.CYAN, bold=True)
        for row in report.l1_checked:
            mark = "✗" if row.get("isHit") else "·"
            colour = typer.colors.RED if row.get("isHit") else typer.colors.BRIGHT_BLACK
            hit = f"　{row.get('hit')}（{row.get('count')}/{row.get('threshold')}）" \
                if row.get("isHit") else ""
            typer.secho(f"  {mark} {row.get('rule')}{hit}", fg=colour)
        if report.items:
            typer.secho("发现问题", fg=typer.colors.CYAN, bold=True)
            for item in report.items:
                colour = {"blocker": typer.colors.RED, "major": typer.colors.YELLOW,
                          "minor": typer.colors.BRIGHT_BLACK}.get(item.severity, 0)
                typer.secho(f"  [{item.severity}] {item.dim}", fg=colour)
                typer.echo(f"      证据：{item.evidence}")
                typer.echo(f"      建议：{item.suggestion}")


@app.command()
def review(chapter: int = typer.Argument(...),
           project: str = typer.Option(None, "--project", "-p")) -> None:
    """可举证质量评审（7 维，每维必须引用原文）。"""
    store = _resolve(project)

    async def _go():
        async with _client(store) as client:
            pipeline = Pipeline(store, client, Meter(store))
            return await pipeline.run_step(chapter, "review")

    outcome = _run_async(_go())
    _ok(outcome.note)
    report = store.read_review(chapter)
    if report is not None:
        for dim in report.dims:
            bar = "█" * max(1, dim.score // 10)
            typer.echo(f"  {dim.dim:<10} {dim.score:>3}  {bar}")
            if dim.evidence:
                typer.secho(f"      证据：{dim.evidence}", fg=typer.colors.BRIGHT_BLACK)


@app.command()
def deai(chapter: int = typer.Argument(...),
         project: str = typer.Option(None, "--project", "-p")) -> None:
    """去 AI 味：定位 → 定点改写 → 重跑规则校验。"""
    store = _resolve(project)

    async def _go():
        async with _client(store) as client:
            pipeline = Pipeline(store, client, Meter(store))
            return await pipeline.run_step(chapter, "deai", force=True)

    outcome = _run_async(_go())
    _ok(outcome.note)


@app.command()
def revise(chapter: int = typer.Argument(...),
           project: str = typer.Option(None, "--project", "-p")) -> None:
    """按审查结论定点修复（blocker / major），改完重跑规则校验。"""
    store = _resolve(project)

    async def _go():
        async with _client(store) as client:
            pipeline = Pipeline(store, client, Meter(store))
            return await pipeline.run_step(chapter, "revise")

    outcome = _run_async(_go())
    _ok(outcome.note)
    detail = outcome.detail or {}
    for diff in detail.get("diffs", []):
        typer.secho(f"  · {diff.get('dim')}", fg=typer.colors.CYAN)
        typer.secho(f"      - {diff.get('before')}", fg=typer.colors.RED)
        typer.secho(f"      + {diff.get('after')}", fg=typer.colors.GREEN)
    if detail.get("needsHuman"):
        typer.secho("  达到改写轮次上限，剩余问题请人工处理。", fg=typer.colors.YELLOW)


@app.command()
def commit(chapter: int = typer.Argument(...),
           project: str = typer.Option(None, "--project", "-p"),
           force: bool = typer.Option(False, "--force", help="跳过审查直接定稿（不推荐）"),
           ) -> None:
    """定稿：抽取摘要与事实、更新伏笔与依赖边、写入真相文件。"""
    store = _resolve(project)

    async def _go():
        async with _client(store) as client:
            pipeline = Pipeline(store, client, Meter(store))
            return await pipeline.run_step(chapter, "commit", force=force)

    outcome = _run_async(_go())
    _ok(outcome.note)
    for note in (outcome.detail or {}).get("notes", []):
        _info(note)
    hooks = store.hook_stats()
    _info(f"伏笔回收率：{hooks['resolved']}/{hooks['total']}（{hooks['rate']}%）")


@app.command()
def run(
    project: str = typer.Option(None, "--project", "-p"),
    max_chapters: int = typer.Option(20, "--max-chapters", "-n"),
    from_chapter: int = typer.Option(None, "--from", help="从第几章开始"),
) -> None:
    """整本生产：跑到完成或命中熔断条件。"""
    store = _resolve(project)

    async def _go():
        async with _client(store) as client:
            runner = BookRunner(store, client, Meter(store))

            def on_event(event: dict[str, Any]) -> None:
                kind = event.get("type")
                if kind == "resume":
                    plan = event.get("plan") or {}
                    _info(f"恢复判断：{plan.get('label')}（第 {plan.get('chapter')} 章）")
                elif kind == "chapter_start":
                    typer.secho(f"\n▶ 第 {event.get('chapter')} 章", bold=True)
                elif kind == "delta":
                    sys.stdout.write(event.get("text", ""))
                    sys.stdout.flush()
                elif kind == "step" and event.get("status") == "running":
                    typer.secho(f"\n  — {event.get('label')} —", fg=typer.colors.BRIGHT_BLACK)
                elif kind == "chapter_done":
                    typer.echo()
                    _ok(f"第 {event.get('chapter')} 章"
                        f"　{event.get('words')} 字"
                        f"　{'已定稿' if event.get('committed') else '未定稿'}"
                        f"　待处理 {event.get('openIssues')} 条")
                elif kind == "paused":
                    typer.secho(f"\n⏸ {event.get('reason')}", fg=typer.colors.YELLOW)
                elif kind == "stopped":
                    typer.secho("\n已停止。", fg=typer.colors.YELLOW)

            return await runner.run(max_chapters=max_chapters,
                                    from_chapter=from_chapter, on_event=on_event)

    report = _run_async(_go())
    typer.echo()
    typer.secho("— 本次生产 —", fg=typer.colors.CYAN, bold=True)
    _table([
        ("处理章节", "、".join(str(c["chapter"]) for c in report.chapters) or "（无）"),
        ("其中定稿", str(report.completions)),
        ("花费", f"{report.cost:.4f} 元"),
        ("额度", str(report.tokens)),
    ])
    if report.stopped_reason:
        typer.secho(f"停止原因：{report.stopped_reason}", fg=typer.colors.YELLOW)
    hooks = store.hook_stats()
    _info(f"伏笔回收率：{hooks['resolved']}/{hooks['total']}（{hooks['rate']}%）")


@app.command()
def resume(project: str = typer.Option(None, "--project", "-p"),
           go: bool = typer.Option(False, "--run", help="确认后直接继续跑")) -> None:
    """断点恢复：判断该从哪一步接着做。"""
    store = _resolve(project)
    cp = CheckpointManager(store)
    plan = cp.diagnose()
    typer.secho(f"下一步：{plan.public()['label']}", fg=typer.colors.CYAN, bold=True)
    _info(plan.reason)
    _info(f"位置：第 {plan.chapter} 章 · {plan.public()['stepLabel']}")
    if go:
        run(project=project, max_chapters=1, from_chapter=plan.chapter)


@app.command()
def hooks(project: str = typer.Option(None, "--project", "-p")) -> None:
    """伏笔看板：回收率与超期告警。"""
    store = _resolve(project)
    current = max((c["n"] for c in store.chapters_overview()), default=0)
    stats = store.hook_stats(current)
    _table([
        ("总数", str(stats["total"])),
        ("待回收", str(stats["planted"])),
        ("已回收", str(stats["resolved"])),
        ("已弃用", str(stats["abandoned"])),
        ("超期", str(stats["overdue"])),
        ("回收率", f"{stats['rate']}%"),
    ])
    typer.echo()
    for hook in store.hooks():
        if hook.status == "planted":
            flag = "⚠️ 超期" if hook.overdue(current) else "　　"
            typer.secho(f"  {flag} {hook.id}　第 {hook.planted_chapter} 章埋　"
                        f"建议第 {hook.suggested_resolve_by or '—'} 章前回收", fg=(
                            typer.colors.RED if hook.overdue(current) else None))
            typer.echo(f"        {hook.content}")


@app.command()
def usage(project: str = typer.Option(None, "--project", "-p")) -> None:
    """成本与额度统计。"""
    store = _resolve(project)
    meter = Meter(store)
    data = meter.public()
    typer.secho("总览", fg=typer.colors.CYAN, bold=True)
    _table([
        ("调用次数", str(data["totals"]["calls"])),
        ("额度", str(data["totals"]["tokens"])),
        ("花费", f"{data['totals']['cost']:.4f} 元"),
        ("预算", f"{data['budget']['used']:.2f} / {data['budget']['total']:.2f} 元"
                 f"（{data['budget']['level']}）"),
    ])
    if data["byChapter"]:
        typer.echo()
        typer.secho("按章", fg=typer.colors.CYAN, bold=True)
        for row in data["byChapter"]:
            typer.echo(f"  第 {row['chapter']} 章　{row['totalTokens']} 额度　"
                       f"{row['cost']:.4f} 元　{row['calls']} 次")
    if data["byStep"]:
        typer.echo()
        typer.secho("按环节", fg=typer.colors.CYAN, bold=True)
        for row in data["byStep"]:
            typer.echo(f"  {row['step']:<10} {row['tokens']:>8} 额度　"
                       f"{row['cost']:.4f} 元　{row['calls']} 次")


# ==========================================================================
# 文风
# ==========================================================================

@style_app.command("analyze")
def style_analyze(
    project: str = typer.Option(None, "--project", "-p"),
    file: Optional[Path] = typer.Option(None, "--file", exists=True, dir_okay=False,
                                        help="参考样本文件（txt / md）"),
    text: str = typer.Option("", "--text", help="或直接给一段样本"),
    from_book: bool = typer.Option(False, "--from-book", help="从本书已定稿章节提取"),
    merge: bool = typer.Option(False, "--merge", help="与当前档案合并而非覆盖"),
) -> None:
    """分析参考样本，产出文风档案。"""
    from .consistency.style import analyze_style, merge_profile

    store = _resolve(project)
    sample = text
    label = "命令行传入的样本"
    if file is not None:
        sample = file.read_text(encoding="utf-8")
        label = f"样本文件 {file.name}"
    if from_book and not sample:
        chunks = [store.chapter_text(c["n"]) for c in store.chapters_overview()
                  if c["status"] in ("done", "revise", "audit")]
        sample = "\n\n".join(chunks)
        label = "从本书已定稿章节提取"
    if not sample.strip():
        _fail("没有样本。用 --file 指定文件、--text 给一段，或 --from-book 从本书提取。")
        raise typer.Exit(code=1)

    async def _go():
        async with _client(store) as client:
            return await analyze_style(client, sample, source_label=label)

    profile, tokens = _run_async(_go())
    if merge:
        profile = merge_profile(store.style(), profile)
    import time
    profile.analyzed_at = time.strftime("%Y-%m-%d %H:%M")
    profile.tokens = tokens
    store.save_style(profile)
    _ok(f"文风档案已更新（消耗 {tokens} 额度）")
    _info(f"句长均值 {profile.sentence.mean:g} · {profile.narrative.person} · "
          f"禁用表达 {len(profile.banned_expressions)} 条")


@style_app.command("apply")
def style_apply(
    project: str = typer.Option(None, "--project", "-p"),
    preset: str = typer.Option(None, "--preset", help="预设 id，如 sp_mystery"),
    show: bool = typer.Option(False, "--list", help="列出可用预设"),
) -> None:
    """应用一个文风预设。"""
    from .consistency.style import preset_profile, presets

    store = _resolve(project)
    if show or not preset:
        typer.secho("可用文风预设", fg=typer.colors.CYAN, bold=True)
        for p in presets():
            typer.echo(f"  {p['id']:<14} {p['name']}　{p.get('tagline', '')}")
        return
    profile = preset_profile(preset)
    if profile is None:
        _fail(f"没有这个预设：{preset}")
        raise typer.Exit(code=1)
    store.save_style(profile)
    _ok(f"已应用文风：{profile.source}")


@style_app.command("banned")
def style_banned(
    project: str = typer.Option(None, "--project", "-p"),
    add: Optional[str] = typer.Option(None, "--add"),
    remove: Optional[str] = typer.Option(None, "--remove"),
) -> None:
    """管理禁用表达。"""
    store = _resolve(project)
    profile = store.style()
    if add and add.strip() not in profile.banned_expressions:
        profile.banned_expressions.append(add.strip())
        store.save_style(profile)
        _ok(f"已加入禁用：{add.strip()}")
    if remove:
        before = len(profile.banned_expressions)
        profile.banned_expressions = [x for x in profile.banned_expressions if x != remove]
        store.save_style(profile)
        if len(profile.banned_expressions) < before:
            _ok(f"已移除：{remove}")
    typer.echo("当前禁用表达：")
    for expr in profile.banned_expressions:
        typer.echo(f"  · {expr}")


# ==========================================================================
# 拆书
# ==========================================================================

@app.command()
def disassemble(
    file: Path = typer.Argument(..., exists=True, dir_okay=False,
                                help="要导入的小说文件（txt / md）"),
    project: str = typer.Option(None, "--project", "-p"),
    accept_all: bool = typer.Option(False, "--accept-all",
                                    help="全部提案直接接受（会写入真相文件）"),
) -> None:
    """拆书：导入已有作品，反推角色 / 世界观 / 伏笔 / 文风，产出写入提案。"""
    from .ingest.disassemble import Disassembler

    store = _resolve(project)
    text = file.read_text(encoding="utf-8", errors="ignore")

    async def _go():
        async with _client(store) as client:
            worker = Disassembler(store, client, Meter(store))
            result = await worker.run(filename=file.name, text=text)
            if accept_all:
                for proposal in worker.pending():
                    await worker.decide(proposal["id"], "accept")
            return result

    result = _run_async(_go())
    data = result.public()
    typer.secho("反推完成", fg=typer.colors.CYAN, bold=True)
    for stage in data["stages"]:
        mark = {"done": "✓", "active": "▶", "todo": "·"}.get(stage["status"], "·")
        typer.echo(f"  {mark} {stage['title']}　{stage['desc']}")
    stats = data["stats"]
    _table([
        ("章节", str(stats.get("chapters", 0))),
        ("角色", str(stats.get("characters", 0))),
        ("世界观规则", str(stats.get("worldRules", 0))),
        ("伏笔", f"{stats.get('hooks', 0)}（匹配回收 {stats.get('hooksMatched', 0)}）"),
        ("消耗额度", str(stats.get("tokens", 0))),
    ])
    typer.echo()
    typer.secho("写入提案", fg=typer.colors.CYAN, bold=True)
    for proposal in data["proposals"]:
        decision = proposal.get("decision") or "待确认"
        typer.echo(f"  [{proposal['confidence']}] {proposal['kind']}　"
                   f"{proposal['content']}　→ {decision}")
    if not accept_all:
        _info("在「拆书」页逐条接受，或重跑时加 --accept-all。")


@app.command()
def sort(project: str = typer.Option(None, "--project", "-p")) -> None:
    """重建检索索引（真相文件被手工改动后使用）。"""
    store = _resolve(project)
    count = MemoryIndex(store).reindex()
    _ok(f"索引已重建：{count} 个片段")


if __name__ == "__main__":
    app()
