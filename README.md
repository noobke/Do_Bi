# Do_Bi

本项目致力于把天马行空的想法转化为一个个精彩的故事。我想大多数人都有对生活的某一时刻具有各种有趣的想法，正值 ai 发展，通过我们或许可以把想法转变为一个个精彩的故事。

## 项目结构

| 目录 | 说明 |
|---|---|
| `server/` | 后端：Python 3.10+ · FastAPI · SQLite。**只出 API，不做静态托管** |
| `web/` | 前端：React 18 + TypeScript + Vite 5（正式工程） |
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
