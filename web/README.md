# Do_Bi 小说创作台 · Web 前端

「Do_Bi 小说创作台」的正式前端，与 `/workspace/server` 的 FastAPI 后端对接。

本仓库目前只包含**脚手架与共享层**（App Shell、设计契约样式、API 客户端、当前项目上下文、
通用工具与图标），页面目录里是占位组件，业务实现由后续批次补齐。

## 技术栈

- **Vite** + **React 18** + **TypeScript**
- 路由：`react-router-dom` v6（`BrowserRouter`）
- 样式：**不使用 Tailwind / CSS-in-JS / 任何组件库**，全部走设计契约里冻结的类名（`src/styles/contract.css`）
- 图标：`src/components/Icon.tsx` 内联的 Lucide SVG（禁止 emoji、禁止 CDN）

## 常用命令

```bash
npm install      # 安装依赖
npm run dev      # 启动开发服务器（默认 http://localhost:5173）
npm run build    # 类型检查 + 生产构建，产物在 dist/
npm run preview  # 本地预览 dist/ 产物
npx tsc --noEmit # 只做类型检查
```

开发服务器已配置代理：`/api` → `http://127.0.0.1:8000`，因此本地开发无需处理 CORS。
构建时 `base: './'`，`dist/` 可用相对路径直接作为静态资源托管。

## 先启动后端

前端依赖后端接口，开发前请先启动后端服务：

```bash
cd ../server
dobi serve
```

## 目录结构

```
src/
├── api/client.ts        # 后端 API 客户端（含 SSE 流式解析、ApiError）
├── components/
│   ├── Icon.tsx         # 内联 Lucide 图标
│   ├── Layout.tsx       # App Shell：Sidebar + TopBar + Crumb + <Outlet/>
│   ├── ErrorState.tsx   # 统一的「加载失败 + 重试」态
│   └── Loading.tsx      # 加载态占位
├── lib/ui.ts            # 通用工具（$ / $$ / fmtInt / fmtMoney / toast / clickable / classNames）
├── pages/               # 12 个页面（当前为占位）
├── state/project.ts     # 当前项目上下文（localStorage: dobi.currentProject）
└── styles/contract.css  # 设计契约样式（逐字复制，见下）
```

## 样式约定（重要）

`src/styles/contract.css` 是**逐字复制**自设计契约
`prototype/do-bi/assets/styles.css`，**不得改写其中任何一行**。

- 不得自创颜色 / 字号 / 圆角 / 间距 —— 一律使用 `contract.css` 里的 CSS 变量与已冻结的类名；
- 组件里用到的类名必须先在 `contract.css` 里存在；
- 视觉一致性的唯一真相源是设计契约文档 `prototype/do-bi-design-contract.md`；
  修改任何 token 或组件样式，必须同步回设计契约。
