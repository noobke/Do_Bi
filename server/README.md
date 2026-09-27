# Do_Bi 小说创作台 · 后端

> 一个「写得出、不崩、可干预」的长篇小说创作工具的后端内核。
> Python 3.10+ · FastAPI · SQLite · 只依赖 OpenAI 兼容协议（不含本地模型）

---

## 1. 它是什么

人和 AI 共用同一条创作流水线：既能陪写，也能全自动跑完整本。
后端的核心不是「调模型」，而是**让模型只负责叙述，由应用负责记住真相**。

| 能力 | 落位 | 说明 |
|---|---|---|
| 真相文件 / 长期记忆 | `core/store` + `core/context` | 9 个结构化文件承载长期记忆，跨几十万字不漂移 |
| 审计深度 | `consistency/l1` + `l2` | 规则校验 13 条（零模型成本）+ 模型审查 5 → 15 维 |
| 反 AIGC / 去 AI 味 | `consistency/deai` | 检测 → 定位 → 定点改写 → 重跑规则校验的闭环 |
| 文风仿写 | `consistency/style` | 样本分析 → `style_profile.json` → 确定性必选注入 |
| MCP 扩展 | `integrations/mcp` | 外部工具服务器接入，**不可用时强制降级不阻塞** |
| 滚动规划 | `orchestrator/planning` | 罗盘 + 骨架弧 + 渐进细化，只管近期卷 |
| 断点恢复 | `core/checkpoint` | step 级快照，kill -9 后精确续跑 |
| 可举证评审 | `consistency/review` | 7 维质量评审，每条结论必须引用原文 |
| 实时干预 | `orchestrator/steer` | 不暂停生产注入意见，自动评估影响范围 |
| 伏笔可视化 | 数据层 `pending_hooks.jsonl` | 回收率可统计，超期自动告警 |
| 章纲依赖图 / 思维链 | `outline_graph.json` | 有向依赖边 + `rationale`，**被上下文组装真实消费** |
| 拆书 | `ingest/disassemble` | 导入已有作品反推结构，产出**提案**而非直接写入 |
| 整本生产流程 | `orchestrator/pipeline` | 从一句灵感跑到完成或熔断 |

---

## 2. 快速开始

### 2.1 安装

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
```

### 2.2 配置密钥（**必需**）

后端**不含任何 mock 模型**，必须配置真实 API Key 才能产出内容。

```bash
cp .env.example .env
```

编辑 `.env`，至少填一个：

```ini
DOBI_KEY_DEEPSEEK=sk-xxxxxxxxxxxxxxxx
```

密钥解析规则：

- 密钥**只**从环境变量读取，`config/providers.json` 里只写**环境变量名**（`api_key_ref`）
- 密钥永不写进项目数据目录，永不返回给前端（设置接口只返回「已配置 / 未配置」+ 脱敏指纹）
- 日志与错误信息对密钥脱敏

可用的服务商与降级链顺序由 `config/providers.json` 的 `priority` 决定。
哪个环节用哪档模型由 `config/model_roles.json` 决定。

### 2.3 生成第一本书

```bash
# 1. 看服务商状态
dobi providers

# 2. 新建项目（一句话即可）
dobi new 雁回关 --genre 古风悬疑 \
  --premise "一个北境小吏追查失踪案，却发现王朝正在被「文脉」的力量吞噬"

# 3. 生成世界观 / 角色 / 大纲
dobi plan yan-hui-guan

# 4. 写一章（流式打印）
dobi write yan-hui-guan 1

# 5. 审计 → 评审 → 修订 → 定稿
dobi audit  yan-hui-guan 1
dobi commit yan-hui-guan 1

# 6. 看伏笔回收率与成本
dobi hooks yan-hui-guan
dobi usage yan-hui-guan
```

### 2.4 全自动跑一本

```bash
dobi run yan-hui-guan --max-chapters 20
```

跑到完成或命中熔断条件即停。运行中可随时 Ctrl-C，之后 `dobi resume` 精确续跑。

### 2.5 启动 API 服务（给前端用）

```bash
dobi serve --reload
# → http://127.0.0.1:8000/docs   （OpenAPI 交互文档）
```

---

## 3. 目录结构

```
server/
├─ config/
│  ├─ providers.json        服务商与模型清单（含计价与能力声明）
│  └─ model_roles.json      环节 → 模型档位 / 温度 / 输出格式 / 降级链
├─ dobi/
│  ├─ config.py             配置系统（环境变量 / 路径 / 上下文预算）
│  ├─ errors.py             统一错误（含面向作者的中文文案）
│  ├─ llm/
│  │  ├─ provider.py        模型适配层：降级链 / 能力探测 / 重试 / 计量
│  │  └─ jsonutil.py        模型输出的 JSON 四级容错解析
│  ├─ core/
│  │  ├─ schema.py          9 个真相文件 + 派生结构的 schema（唯一真相源）
│  │  ├─ store.py           真相文件读写 + Proposal → Validate → Commit
│  │  ├─ memory.py          SQLite 时序记忆 + BM25 检索
│  │  ├─ context.py         上下文组装（Token 分层预算 + 文风必选注入）
│  │  ├─ checkpoint.py      step 级快照与 5 类中断场景恢复
│  │  └─ metering.py        调用计量 / 成本统计 / 预算熔断
│  ├─ consistency/
│  │  ├─ l1.py              13 条确定性规则（零模型成本）
│  │  ├─ l2.py              15 维模型审查（含原文证据定位）
│  │  ├─ review.py          7 维可举证质量评审
│  │  ├─ deai.py            反 AIGC 管线
│  │  └─ style.py           文风分析与档案注入
│  ├─ agents/
│  │  ├─ architect.py       灵感 → 世界观 / 角色 / 大纲 / 依赖图
│  │  ├─ writer.py          章纲 → 正文（流式）
│  │  ├─ auditor.py         正文 → 审计报告（含证据）
│  │  ├─ reviewer.py        正文 → 可举证评审
│  │  ├─ reviser.py         审计结果 → JSON Patch 定点修复
│  │  └─ archivist.py       定稿 → 摘要 / 事实抽取 / 伏笔与依赖边更新
│  ├─ orchestrator/
│  │  ├─ pipeline.py        单章流水线状态机（8 step）
│  │  ├─ planning.py        滚动规划（罗盘 / 骨架弧 / 渐进细化）
│  │  ├─ mode.py            干预策略层（auto / semi-auto / manual + 熔断）
│  │  ├─ steer.py           实时干预（意图解析 + 影响范围评估）
│  │  └─ runner.py          整本生产 run
│  ├─ ingest/disassemble.py 拆书：导入 → 反推 → 提案
│  ├─ integrations/mcp.py   MCP 客户端（可关闭，失败强制降级）
│  ├─ api/                  FastAPI 路由与依赖
│  └─ cli.py                Typer CLI
└─ tests/
```

**每个项目的运行期数据**（与代码分离，全部在 `DOBI_DATA_DIR` 下）：

```
data/projects/<project-id>/
├─ meta.json                 元信息：题材、篇幅、模式、预算、启用的审查维度
├─ world.md                  世界观规则（人读）
├─ characters.jsonl          角色矩阵（不可变特征 vs 可变状态）
├─ current_state.md          世界当前状态快照
├─ pending_hooks.jsonl       伏笔池
├─ chapter_summaries.jsonl   章节摘要（累积）
├─ subplot_board.md          支线进度板
├─ outline_graph.json        章纲依赖图 + 思维链
├─ style_profile.json        文风档案
├─ outline.json              罗盘 + 卷 + 章纲（滚动规划产物）
├─ chapters/ch_0017.md       正文
├─ audits/ch_0017.json       审计报告（含原文证据）
├─ reviews/ch_0017.json      可举证质量评审
├─ checkpoints/              step 级执行快照
├─ state/*.json              真相文件的机器可校验镜像
├─ usage.jsonl               调用计量流水
└─ memory.db                 SQLite 时序记忆 + FTS5 检索索引
```

---

## 4. 关键设计约定

### 4.1 所有写入必经 Proposal → Validate → Commit

1. Agent 产出**提案**（新增事实 / 修改角色状态 / 新增伏笔 / 调整大纲）
2. 校验器检查：字段合法性 → 与 `immutable_traits` 是否冲突 → 与硬设定是否矛盾 → 伏笔是否重复
3. 通过才落盘；**冲突降级为「待人工确认项」，不自动写入**

### 4.2 真相落盘为「纯文本 + 结构化」双形态

`schema` 校验的 JSON 为准，Markdown 投影供人读，可 Git 版本化。
`state/*.json` 是可校验镜像——人改了 Markdown，重新导入即可对齐。

### 4.3 文风是确定性必选上下文

`style_profile.json` 注入 Writer 时**不占 Token 配额、不参与检索竞争**——保证每章文风一致。

### 4.4 审计必须可举证

任何审计与评审结论都要带**原文证据**，无证据的结论直接丢弃、不进入报告。
这样才能「可执行、可申诉」，而不是给作者一堆无法落地的形容词。

### 4.5 下游步骤的输入必须来自落盘数据

不依赖内存对话历史 —— 这是断点可续的前提。

### 4.6 同环节主备模型必须都支持所需输出格式

否则降级链会中途断掉。`config/model_roles.json` 的注释里写明了这条约束。

### 4.7 收发同一个命名契约（对外 camelCase / 对内 snake_case）

真相文件与内部模型一律 snake_case（与规划文档 §5.2 逐字对应）；HTTP 层对外
**收发都是 camelCase**：

- 响应：`api/serialize.to_api()` 递归转换（**必须穿透列表**）
- 请求：所有请求体继承 `api/serialize.ApiBody`，用同一个 `api_alias` 生成别名，
  同时 `validate_by_name=True` 兼容脚本侧发 snake_case

两边共用一套规则，才不会出现「接口 200 但入参没生效」这类静默故障。
契约由 `tests/test_api.py` 的 `TestSerializationContract` + `TestRequestBodyContract` 钉住。

---

## 5. 稳定性设计

| 问题 | 对策 |
|---|---|
| 超时 | 连接与读取超时分开配置，长文本给足读取超时 |
| 429 / 5xx | 指数退避重试，上限 3 次，加抖动 |
| 401 / 403 | **不重试**，直接换下一个服务商 |
| 4xx 参数错误 | **不重试**；若判定为「参数不被支持」则改写参数重试一次并记住 |
| 输出非法 JSON | 四级容错解析（剥离围栏 → 括号平衡切片 → 修补尾逗号/裸键 → 仍失败带错误重试一次） |
| 主力模型不可用 | 降级链：主力 → 备用 → 挂起 checkpoint 并提示 |
| 重试导致重复写入 | 每 step 带 `idempotency_key`，写入前查重 |
| 并发写同一本书 | 项目级锁串行；不同项目可并行 |
| MCP 服务不可用 | 自动降级为内置检索，**不阻塞主流程** |
| 上下文超窗 | 按分层预算裁剪；预算内取最相关信息 |
| 流式生成中途断流 | **已出字则不换服务商重来**，如实报错并保留半成品 |

### 能力探测

各厂商对 `max_tokens` / `max_completion_tokens` / `response_format` / `stream_options`
的支持度不一致。适配层遇到 400 参数类错误时会**自动改写参数并重试一次**，
结果写回 `config/providers.json` 的 `probed` 字段，下次不再踩同一个坑。

---

## 6. 预算与成本（四道闸门）

1. **每章 Token 预算上限**：超出则裁剪低优先级上下文，不报错
2. **上下文分层预算**：系统规则 5% / 角色与世界观 15% / 动态事实 10% /
   历史摘要 20% / 当前草稿 30% / 输出预留 20%（文风档案不占配额）
3. **调用计量**：记录 `model / step / prompt_tokens / completion_tokens / cost / latency`，
   按项目 / 章 / 天聚合
4. **预算熔断**：达阈值提示，超额挂起 checkpoint，**不静默烧钱**

> `config/providers.json` 里的 `price_in` / `price_out` 是**示例参考价（元 / 百万 token）**，
> 请按服务商实际价目核对后维护。留 `0` 表示不计价，此时熔断退化为按 token 数阈值判断。

---

## 7. CLI 一览

| 命令 | 作用 |
|---|---|
| `dobi new <标题>` | 新建项目（可只给一句话） |
| `dobi list` | 列出全部项目 |
| `dobi providers` | 服务商状态与降级链顺序 |
| `dobi probe <服务商>` | 连通性测试 |
| `dobi plan <项目> [--roll] [--volume N]` | 生成 / 刷新世界观、角色、大纲；`--roll` 触发滚动规划下一卷 |
| `dobi write <项目> <章号>` | 生成正文（流式打印） |
| `dobi audit <项目> <章号>` | 审计（规则校验 + 模型审查） |
| `dobi review <项目> <章号>` | 可举证质量评审 |
| `dobi deai <项目> <章号>` | 去 AI 味定点改写 |
| `dobi revise <项目> <章号>` | 按审计结果修订 |
| `dobi commit <项目> <章号>` | 定稿并更新真相文件 |
| `dobi run <项目> [--max-chapters N]` | 整本生产（跑到完成或熔断） |
| `dobi resume <项目>` | 断点恢复 |
| `dobi hooks <项目>` | 伏笔看板与回收率 |
| `dobi style analyze <项目> --file X` | 文风仿写：分析样本 |
| `dobi style apply <项目> --preset <名称>` | 应用文风预设 |
| `dobi disassemble <项目> --file X` | 拆书：导入反推结构 |
| `dobi usage <项目>` | Token 与成本统计 |
| `dobi serve` | 启动 API 服务 |

---

## 8. 测试

```bash
cd server
pytest -q
```

确定性模块（规则校验 / 真相文件 / checkpoint / 预算 / JSON 容错）全覆盖，
不消耗任何 API 额度。需要真实模型的路径以 `httpx.MockTransport` 注入假响应验证协议契约。

---

## 9. 许可

GPL-3.0-or-later（与仓库根目录 `LICENSE` 一致）。
