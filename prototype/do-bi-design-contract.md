# Design Contract · Do_Bi 小说创作台原型

> 单一真相源。所有页面必须逐字引用本契约，不得自创颜色 / 字号 / 圆角。

## Tech stack & delivery
stack: plain HTML + CSS + vanilla JS
delivery: pure-static（零外部依赖，可离线双击打开）
font strategy: 系统可用字体栈（含中文衬线/黑体回退），不引 CDN
icon: Lucide 内联 SVG（禁止 emoji 图标），16 / 20 / 24px，stroke 1.5，currentColor

## Style tier & aesthetic direction
style: minimal-light
aesthetic: **literary / editorial —— 手稿与铅字美学（纸与墨）**
tone keywords: 安静、克制、编辑级排版、高可读性、有纸张温度

差异化记忆点（必须贯穿）：
1. **手稿页边栏**：正文编辑区左侧窄栏，衬线小字标注章节序号与状态，像印刷书页页边
2. **朱砂印色**：品牌标记为靛蓝方印 + 一点朱砂；朱砂仅用于品牌位与「伏笔」标记
3. **正文阅读优先**：编辑区正文 18px / line-height 1.95，明显优于一般 App

明确禁止：白底紫渐变、Inter/Roboto/Arial、emoji 图标、每张卡同样的重阴影、均匀铺开的彩色。

## Design Tokens

```css
/* 纸 */
--paper:       #FBF9F5;   /* 页面底 */
--paper-2:     #F5F1E8;   /* 卡片 / 次级面 */
--paper-3:     #EDE7DA;   /* 更深的静默面 */
--line:        #E3DCCB;   /* 常规边框 / 分隔 */
--line-strong: #D6CCB6;   /* 强调边框 */
/* 墨 */
--ink:         #211E19;   /* 主文本 */
--ink-2:       #4A4438;   /* 次文本 */
--ink-3:       #857D6D;   /* 注释 / 图标静默 */
--ink-4:       #A79F8E;   /* 最弱 */
/* 主色：靛蓝（花青） */
--accent:      #2C4A63;
--accent-hover:#22394D;
--accent-soft: #E8EEF3;
--accent-ink:  #1C3145;
/* 语义 */
--moss:        #4F6B4A;   /* 通过 / 已回收 */
--moss-soft:   #E9EFE6;
--amber:       #B0791F;   /* 待处理 / 预警 */
--amber-soft:  #F7EEDC;
--crimson:     #A6392E;   /* 冲突 / 未回收告警 */
--crimson-soft:#F7E8E5;
--seal:        #A6392E;   /* 朱砂，仅品牌印与伏笔标记 */

/* 字体 */
--font-display: "Noto Serif SC","Source Han Serif SC","Songti SC","STSong",Georgia,"Times New Roman",serif;
--font-body:    "Noto Sans SC","Source Han Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
--font-read:    var(--font-display);
--font-mono:    "JetBrains Mono","SF Mono",Menlo,Consolas,monospace;

/* 字号 */
--fs-11:11px; --fs-12:12px; --fs-13:13px; --fs-14:14px; --fs-16:16px;
--fs-20:20px; --fs-26:26px; --fs-34:34px;

/* 半径 */
--r-sm:6px; --r-md:10px; --r-lg:16px; --r-full:999px;

/* 间距（4 基数） */
--sp-4:4px; --sp-8:8px; --sp-12:12px; --sp-16:16px; --sp-20:20px;
--sp-24:24px; --sp-32:32px; --sp-48:48px; --sp-64:64px;

/* 阴影（克制、分层） */
--sh-sm:0 1px 2px rgba(33,30,25,.05);
--sh-md:0 2px 6px rgba(33,30,25,.06),0 1px 2px rgba(33,30,25,.04);
--sh-lg:0 12px 32px -8px rgba(33,30,25,.12),0 2px 8px rgba(33,30,25,.05);

/* 布局 */
--sidebar-w:244px;
--content-max:1320px;
--col-left:248px;
--col-right:372px;

/* 动效 */
--ease:cubic-bezier(.2,.7,.3,1);
--dur:480ms;
```
motion: 页面载入 fadeUp 错落浮现（animation-delay 逐项 +40ms）；hover/active 过渡 120ms；禁止散碎微交互
bg-texture: 极淡纸纹 = 暖色 radial 光晕 + 极低不透明度纤维纹（repeating-linear-gradient），不铺纯色

## Component Spec

- **btn**：`btn-primary`（靛蓝实底 / 纸色字）、`btn-ghost`（透明底 + 边框）、`btn-quiet`（无边框静默）
  状态：hover（加深底）· active（下沉 1px）· disabled（40% 不透明度，cursor:not-allowed）· focus-visible（2px 靛蓝外环）
  尺寸：`btn-sm`（28px 高）/ 默认（34px）/ `btn-lg`（40px）
- **input / textarea / select**：纸白底 + `--line` 1px 边框；focus 边框转 `--accent` + 外环；placeholder 用 `--ink-4`
- **card**：`--paper-2` 面 + `--line` 1px 边框 + `--r-md`；**不用**统一重阴影，仅浮层用 `--sh-lg`
- **card-head**：标题 `--font-display` 16px/600，右侧可放静默操作
- **tag**：胶囊 `--r-full`，13px，五种：`tag-ok`(moss) / `tag-warn`(amber) / `tag-danger`(crimson) / `tag-info`(accent) / `tag-quiet`(ink-3)
- **list-row / table**：行高 ≥44px，分隔线 `--line`，hover 背景 `--paper-3`
- **modal**：遮罩 `rgba(33,30,25,.36)` + 纸面卡片 + `--sh-lg`；默认隐藏
- **nav-item**：见 App Shell
- **empty-state**：居中文案 + 静默图标，禁止 emoji
- **progress**：细条（高 4px），底 `--paper-3`，填充 `--accent`
- **kbd / code**：`--font-mono`，底 `--paper-3`，13px

## App Shell + Canonical Nav（多页必须逐字一致）

**权威来源：`do-bi/index.html`。其余页面必须从该文件复制 `<aside class="sidebar">…</aside>` 整块，一字不改。**

```html
<body data-page="<workbench|chat|characters|hooks|settings>">
  <aside class="sidebar"> … brand + nav + side-foot … </aside>
  <main class="main" id="main"> … 本页内容（含 .topbar） … </main>
</body>
```

nav items（顺序冻结，禁止增删改序）：
| label | lucide | href | data-nav |
|---|---|---|---|
| 工作台 | pen-line | index.html | workbench |
| 共创 | messages-square | chat.html | chat |
| 角色 | users | characters.html | characters |
| 伏笔 | bookmark | hooks.html | hooks |
| 设置 | settings-2 | settings.html | settings |

nav positioning: `.sidebar` 固定左侧 `width:var(--sidebar-w)`；`.main` `margin-left:var(--sidebar-w)` —— 每页一致
active rule（唯一机制）: `app.js` 为 `[data-nav]` 中 `data-nav === document.body.dataset.page` 的项加 `.active`
mount: 每页内联 shell（默认），禁止 JS 注入

brand 区块（冻结）：`.brand` = `.brand-seal`（靛蓝方印 + 朱砂点）+ `.brand-name`（Do_Bi 衬线）+ `.brand-sub`（小说创作台）

`.topbar` 是每页内容的一部分（放在 `.main` 内第一块），结构固定：
`.topbar` > `.topbar-title`（含 `h1` + `.topbar-sub`）+ `.topbar-actions`

## Page List

| # | 文件 | 页面 | 职责 | 关键组件 |
|---|---|---|---|---|
| 1 | index.html | 写作工作台 | 写作 + 确认 + 干预（核心页） | 三栏布局、章节目录、手稿编辑区、助手面板、干预开关、审计内联卡 |
| 2 | chat.html | 共创对话 | Chat-first 立项，多轮追问沉淀设定 | 对话流、消息气泡、选项卡、右侧「设定沉淀」实时预览 |
| 3 | characters.html | 角色与关系 | 管理角色卡与关系 | 角色列表、角色详情、关系列表、不可变特征标记 |
| 4 | hooks.html | 伏笔看板 | 追踪伏笔，未回收告警 | 统计条、伏笔时间线、状态泳道、告警行 |
| 5 | settings.html | 设置 | Provider / 模型映射 / 预算 | Provider 列表、模型角色映射表、预算熔断、成本统计 |

## Mock Schema（统一假数据，禁止 lorem ipsum）

统一世界观：**北境 · 文脉**（古风悬疑），主角「沈砚」。

- `project`：`{ id, title:"雁回关", genre:"古风悬疑", mode:"semi-auto", chaptersTotal:60, chaptersDone:17, words:86420, budgetUsed:12.6, budgetTotal:80, costUnit:"¥" }`
- `chapter`：`{ n, title, status:"done|draft|audit|todo", words, updated, summary }`
- `character`：`{ id, name, role, immutableTraits[], personality, speechStyle, state{location,status}, relations[{target,type,note}] }`
- `hook`：`{ id, content, plantedChapter, status:"planted|resolved|overdue", resolvedChapter, importance:"major|minor", suggestedResolveBy }`
- `audit`：`{ chapter, items[{ dim, severity:"blocker|major|minor", evidence, suggestion, fixed }], rulesViolated }`
- `provider`：`{ name, baseUrl, models[], configured:true, priority }`
- `modelRole`：`{ step, model, temperature, format }`
- `usage`：`{ chapter, promptTokens, completionTokens, cost }`

## 交互约定（stub，不调真模型）

- 所有「生成 / 审计 / 修订」按钮：显示 loading → `setTimeout` 模拟 → 写入 mock 结果并刷新视图
- `api.js` 暴露 `api.*` 全部返回 `Promise`，内部只读 `mock.js`，**不发起任何网络请求**
- 主要交互：干预模式切换、章节目录切换、助手面板 Tab 切换、伏笔筛选、接受/拒绝修订、modal 开关、Provider 切换
