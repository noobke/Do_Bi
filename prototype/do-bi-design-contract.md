# Design Contract · Do_Bi 小说创作台原型

> 版本 **v1.1（批次二）** · 单一真相源。所有页面必须逐字引用本契约，不得自创颜色 / 字号 / 圆角。
> 批次一（已完成）：工作台 · 共创 · 角色 · 伏笔 · 设置
> 批次二（本次）：章纲与依赖图 · 审计报告 · 文风档案

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

### 批次二新增组件类（已写入 styles.css §26–32）

- **依赖图**：`.graph-wrap`（显式高度的 SVG 容器）· `.legend-item` / `.legend-swatch` · SVG 内 `.gnode` / `.gnode.is-active` / `.gnode.is-skeleton` / `.gedge` / `.gedge.is-skeleton` / `.gedge.is-active` / `.gedge-halo`
- **弧 / 卷卡**：`.arc-card` · `.arc-head` · `.arc-meta`
- **diff 预览**：`.diff` · `.diff-head` · `.diff-line` · `.diff-gutter` · `.diff-text`（配已有 `.diff-del` / `.diff-add`）
- **评分行**：`.score-row` · `.score-name` · `.score-bar` · `.score-val`
- **堆叠占比条**：`.stackbar`（子元素 `<i style="width:..">`，配 `.stackbar-legend`）
- **区间条**：`.rangebar` · `.rangebar > i`（用 inline `left/width` 表达 p50–p90 区间）
- **可删除 chip**：`.chip-removable`（内含 `<button class="chip-x">×</button>`）
- **规则行**：`.rule-row` · `.rule-row.is-hit` · `.rule-count`
- **章节小卡**：`.ch-card` · `.ch-card.is-selected`
- **引用块**：复用 `.audit-evidence`（等宽衬线小字 + 浅底）

## App Shell + Canonical Nav（多页必须逐字一致）

**权威来源：`do-bi/index.html`。其余页面必须从该文件复制 `<aside class="sidebar">…</aside>` 整块，一字不改。**

```html
<body data-page="<workbench|chat|characters|hooks|outline|audit|style|settings>">
  <aside class="sidebar"> … brand + nav + side-foot … </aside>
  <main class="main" id="main"> … 本页内容（含 .topbar） … </main>
</body>
```

nav items（**批次二扩为 8 项**，顺序冻结，禁止增删改序）：
| 顺序 | label | lucide | href | data-nav |
|---|---|---|---|---|
| 1 | 工作台 | pen-line | index.html | workbench |
| 2 | 共创 | messages-square | chat.html | chat |
| 3 | 角色 | users | characters.html | characters |
| 4 | 伏笔 | bookmark | hooks.html | hooks |
| 5 | **章纲** | **git-branch** | **outline.html** | **outline** |
| 6 | **审计** | **clipboard-check** | **audit.html** | **audit** |
| 7 | **文风** | **type** | **style.html** | **style** |
| 8 | 设置 | settings-2 | settings.html | settings |

nav positioning: `.sidebar` 固定左侧 `width:var(--sidebar-w)`；`.main` `margin-left:var(--sidebar-w)` —— 每页一致
active rule（唯一机制）: `app.js` 为 `[data-nav]` 中 `data-nav === document.body.dataset.page` 的项加 `.active`
mount: 每页内联 shell（默认），禁止 JS 注入

brand 区块（冻结）：`.brand` = `.brand-seal`（靛蓝方印 + 朱砂点）+ `.brand-name`（Do_Bi 衬线）+ `.brand-sub`（小说创作台）

`.topbar` 是每页内容的一部分（放在 `.main` 内第一块），结构固定：
`.topbar` > `.topbar-title`（含 `h1` + `.topbar-sub`）+ `.topbar-actions`

## Page List

| # | 文件 | 页面 | 批次 | 职责 | 关键组件 |
|---|---|---|---|---|---|
| 1 | index.html | 写作工作台 | 一 | 写作 + 确认 + 干预 | 三栏、手稿页边、助手面板、干预开关 |
| 2 | chat.html | 共创对话 | 一 | Chat-first 立项 | 对话流、选项卡、设定沉淀 |
| 3 | characters.html | 角色与关系 | 一 | 角色卡与关系 | 角色列表、详情、不可变特征 |
| 4 | hooks.html | 伏笔看板 | 一 | 伏笔追踪与回收率 | 统计条、状态泳道、时间线 |
| 5 | **outline.html** | **章纲与依赖图** | **二** | 分卷/分章结构 + 依赖边 + 思维链 | 罗盘卡、依赖图 SVG、边清单表、节点详情 |
| 6 | **audit.html** | **审计报告** | **二** | L1 规则 + L2 维度 + 可举证评审 + diff | 统计条、规则行、发现卡、评分行、diff 预览 |
| 7 | **style.html** | **文风档案** | **二** | 仿写分析结果、可编辑、注入预览 | 句式/视角/比例卡、可删 chip、区间条、注入对比 |
| 8 | settings.html | 设置 | 一 | Provider / 模型 / 预算 | Provider 列表、映射表、预算、成本 |

## Mock Schema（统一假数据，禁止 lorem ipsum）

统一世界观：**北境 · 文脉**（古风悬疑），主角「沈砚」。

批次一已有：
- `project`：`{ id, title:"雁回关", genre, mode, chaptersTotal:60, chaptersDone:17, words, budgetUsed, budgetTotal, costUnit }`
- `chapters[]`：`{ n, title, status:"done|draft|audit|todo", words, updated, summary }`
- `manuscript`、`modes[]`、`characters[]`、`hooks[]`、`audit`、`chatSeed`、`chatScript[]`、`providers[]`、`modelRoles[]`、`budgetSplit[]`、`usage[]`、`rules[]`

批次二新增：
- **`outlineGraph`**：
  - `compass`：`{ endgame, activeThreads[], scaleEstimate, refreshAt }`
  - `volumes[]`：`{ name, from, to, status:"expanded|skeleton", chapters }`
  - `nodes[]`：`{ chapter, title, arc, status:"written|planned|skeleton", goal, beats[], rationale }`
  - `edges[]`：`{ from, to, type:"motivation|setup|payoff|causality|parallel", note, confirmed:boolean }`
- **`auditReport`**：`{ chapter, title, stats:{l1,l2,fixed,open,passRate}, l1[{rule,hit,count,threshold,isHit}], findings[{dim,severity,evidence,suggestion,ref,fixed,decision}], review[{dim,score,evidence,note}], diffs[{dim,before[],after[]}] }`
- **`styleProfile`**：`{ source, analyzedAt, tokens, sentence:{mean,p50,p90,min,max}, narrative:{person,tense,povSwitch}, ratio:[{label,pct}], patterns[], banned[], lexicon[], injection:{text,tokens}, sample:{plain,styled} }`

## 交互约定（stub，不调真模型）

- 所有「生成 / 审计 / 分析 / 刷新」按钮：显示 loading → `setTimeout` 模拟 → 写回 mock 并重渲染
- `api.js` 暴露 `api.*` 全部返回 `Promise`，内部只读 `mock.js`，**不发起任何网络请求**
- 批次二新增交互：依赖图节点点击选中并高亮其边 + 联动节点详情；边清单表行点击高亮对应 SVG 边；审计发现「接受 / 忽略」切换决策并刷新统计；diff 折叠展开；文风档案禁用词增删；注入对比切换
