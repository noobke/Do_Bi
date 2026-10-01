# Do_Bi · AI 小说创作台

> 把天马行空的想法，写成一本不崩设定的长篇。

Do_Bi 是一个「**写得出、不崩、可干预**」的长篇小说创作工具：人和 AI 共用同一条创作流水线，既能陪你一章一章地写，也能全自动跑完整本。

现有工具大多两极分化——**重表单型**要先填十几个字段才有产出，**一键傻瓜型**前 5 章惊艳、第 10 章开始人设崩塌、伏笔遗忘、无限水文。Do_Bi 站在中间：从一句话灵感开始，用结构化「真相文件」承载长期记忆，跨几十万字不漂移。

## 核心能力

- **八步流水线**：章纲 → 上下文组装 → 草稿 → 规则与模型审查 → 可举证评审 → 去 AI 味 → 修订 → 定稿。每步可单独配置 `auto / confirm / manual`，人机协同与全自动是同一条流水线的两种取值，随时切换
- **真相文件**：世界观规则、角色档案、伏笔台账、支线进度、文风档案、卷与章纲、章节台账——机器可校验，人可读可改
- **可举证审计**：L1 确定性规则（13 条，零模型成本）先行，L2 模型审查补充，每条结论都附原文证据，不给「感觉不对」的模糊反馈
- **去 AI 味与文风仿写**：套话词表、句长与段落节奏检测；可提取你过往作品的文风档案，再据此仿写
- **拆书反推**：导入已有作品，六个阶段反推出角色、世界观、伏笔与文风，直接成为新作的底子
- **实时干预与断点恢复**：长篇生产必然跨天跨周，任何一步都能精确续跑
- **多模型接入**：DeepSeek / MiMo / OpenAI / 通义千问 / 硅基流动，按角色分工分配
- **作品导出**：全书 TXT、全书 Markdown、单章导出或复制、完整真相文件

## 项目结构

| 目录 | 说明 |
|---|---|
| `server/` | 后端：Python 3.10+ · FastAPI · SQLite。**只出 API，不做静态托管** |
| `web/` | 前端：React 18 + TypeScript + Vite 5（正式工程，走 HTTP 调后端） |
| `app/` | 移动端：React 18 + TypeScript + Vite + Capacitor 6 → Android APK。后端为**同包本地核心**（领域逻辑用 TS 重写、跑在浏览器内），数据存 localStorage，可完全离线 |
| `prototype/do-bi/` | 高保真静态原型与设计契约（视觉基准，多页必须逐字一致） |
| `docs/` | 项目计划等文档 |
| `scripts/` | 一键部署脚本 |

## 一键部署

> **前提约定：后端不做静态托管**（见 [main.py](server/dobi/main.py) 顶部说明），前端又用相对路径请求 `/api`，
> 所以生产部署**必须由一层反向代理把 `/api` 同源转发到后端 8000 端口**。下面两种方式都已内置这层代理。

### 方式 A：Docker Compose（推荐）

需要本机安装 Docker（含 `docker compose` v2）。

```bash
./scripts/deploy-docker.sh          # 构建并后台启动
```

启动后访问 **http://localhost:8080**。

```bash
./scripts/deploy-docker.sh logs     # 跟踪日志
./scripts/deploy-docker.sh down     # 停止并移除容器
```

架构：`web`（nginx）托管前端 `dist` 并把 `/api` 反代到 `api`（uvicorn:8000）。
宿主机的 `server/data`、`server/config`、`server/.env` 以卷挂载进容器，重建容器不丢数据，且可直接编辑。
改端口：`DOBI_WEB_PORT=9000 ./scripts/deploy-docker.sh`。

### 方式 B：本机原生（不需要 Docker）

需要本机安装 `uv`（Python 包管理器）、Node.js 18+ 与 npm。

```bash
./scripts/deploy-local.sh
```

脚本会：装后端依赖 → 装前端依赖 → 构建前端 → 启动后端 → 用 `vite preview` 托管 `dist`
并把 `/api` 同源反代到后端（规则见 [vite.config.ts](web/vite.config.ts) 的 `preview.proxy`）。
启动后访问 **http://127.0.0.1:4173**，按 Ctrl+C 同时停止前后端。

### 配置模型密钥

两种方式都会在首次运行时从 `server/.env.example` 生成 `server/.env`。
**至少填入一个模型密钥**（`DOBI_KEY_DEEPSEEK` / `DOBI_KEY_MIMO` / `DOBI_KEY_OPENAI` / `DOBI_KEY_DASHSCOPE` / `DOBI_KEY_SILICONFLOW`），
否则所有需要模型的接口会返回 503。也可以启动后在「设置 → 模型服务」页面里填写。

> `.env` 已在 `.gitignore` 中，**切勿提交**。

## 开发模式

```bash
# 后端（127.0.0.1:8000）
cd server && uv sync && uv run dobi serve --reload

# 前端（127.0.0.1:5173，Vite 开发代理把 /api 转发到 :8000）
cd web && npm install && npm run dev
```

## 许可

GPL-3.0-or-later，见 [LICENSE](LICENSE)。
