# Design Contract · Do_Bi 小说创作台原型

> 版本 **v1.11（批次十二 · 前端设计审计与修复）** · 单一真相源。所有页面必须逐字引用本契约，不得自创颜色 / 字号 / 圆角。
> 批次一：工作台 · 共创 · 角色 · 伏笔 · 设置
> 批次二：章纲与依赖图 · 审计报告 · 文风档案
> 批次三：项目列表（首页）· 拆书 · 设置页 MCP 面板
> 批次四：结构页多视图改造 · 文风页「提取 / 选择」双入口 · 新增世界观页
> 批次五：结构页新增故事树与节奏曲线，故事树设为默认视图
> 批次六：新增章节详情页，用五图呈现「一章怎么生产出来」
> 批次七：大纲页新增节拍骨架 / 全书时间线 / 生产流程图；章节页三处升级
> 批次八：大纲页 9 个视图按走向 / 时间 / 生产 / 明细重组为二级标签
> 批次九：清晰度通修——状态三重辨识通道、图表最小字号 11px、说明行升级为结论条
> 批次十：大纲页**全书时间线由横向双轨改为竖向主干 + 左右分支**，并按阶段分段（§58 已于批次十一被取代）
> 批次十一：大纲页**时间线由竖向主干改为剧情走向树**——主干按阶段着色、分枝到章节叶；视图条目「全书时间线」更名为**「剧情树」**
> 批次十二（本次）：**前端设计审计与修复**——修 4 条 P0 行为缺陷、可读性（令牌对比度 + 图表渲染契约）、键盘可达性、错误态兜底、数字单一真相源、朱砂语义拆分、工程黑话清理
> **入口页：`index.html`（我的作品）** · 共 12 页

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

### 批次三新增组件类（已写入 styles.css §33–37）

- **导航滚动保护**：`.nav { overflow-y:auto; min-height:0 }`（9 项导航需要）
- **项目卡**：`.proj-grid`（自适应网格）· `.proj-card`（`is-current` 表示当前作品）· `.proj-spine`（顶部书脊色条，`is-2/3/4` 换色）· `.proj-body` · `.proj-head` · `.proj-title` · `.proj-sub` · `.proj-logline`（衬线摘要）· `.proj-stats` · `.proj-foot` · `.proj-new`（虚线「新建作品」卡）
- **导入投放区**：`.dropzone`（`is-over` 表示拖入中）
- **步骤条**：`.steps` · `.step-item` · `.step-rail` · `.step-dot`（`is-done` / `is-active`）· `.step-line` · `.step-body` · `.step-title` · `.step-desc`
- **键值行 / 开关**：`.kv` · `.kv-row` · `.kv-key` · `.kv-val` · `.switch`（`is-on` 表示启用）

### 批次四新增组件类（已写入 styles.css §38–44）

- **多视图切换**：`.viewbar` · `.viewbar-tabs` · `.vtab`（`.active`；**视图切换各自实现，不复用 `.tab`**）
- **章节板**：`.board` · `.board-col` · `.board-col-head` · `.board-col-title` · `.board-body` · `.chap-card`（`.is-done/.is-audit/.is-draft/.is-todo/.is-selected`）· `.chap-top` · `.chap-no` · `.chap-name` · `.chap-meta` · `.intensity`（`> i` / `> i.on`）
- **情节线地铁图**：`.plotline` · `.pl-row` · `.pl-name`（`.dot` / `.pl-kind`）· `.pl-track` · `.pl-seg` · `.pl-node` · `.pl-axis` · `.pl-ticks` · `.pl-tick` · `.pl-cross`
- **结构矩阵**：`.matrix`（含 `.rowhead` 冻结列 / `.cell`（`.is-on` / `.is-peak`））
- **文风选择器**：`.style-grid` · `.style-card`（`.is-applied`）· `.style-card-head` · `.style-name` · `.style-tagline` · `.style-sample`（衬线样段，**选文风的唯一可靠依据**）· `.style-foot`
- **提取来源**：`.src-list` · `.src-row` · `.src-main`
- **世界观**：`.rule-card`（`.is-conflict/.is-soft/.is-unused`）· `.rule-text` · `.rule-meta` · `.ref-chips` · `.ref-chip` · `.cat-bar` · `.cat-name`

### 批次五新增组件类（已写入 styles.css §45–46）

- **故事树**：`.tree-wrap`（显式 viewBox 的 SVG 容器）· `.tree-vol-band`（卷分带）· `.tree-vol-label`（卷名）· `.tree-vol-split`（卷分隔虚线）· `.tree-trunk`（主干）· `.tree-node`（`.is-audit/.is-draft/.is-todo/.is-peak/.is-selected`）· `.tn-n`（章号）· `.tn-t`（关键章标题）· `.tn-s`（关键章副行）· `.tree-branch`（支线，`stroke` 取数据色）· `.tree-branch-dot` · `.tree-branch-label` · `.tree-branch-caption` · `.tree-axis` · `.tree-axis-line`
- **节奏曲线**：`.curve-wrap` · `.curve-band` · `.curve-grid` · `.curve-grid-strong`（中位参考线）· `.curve-area` · `.curve-line` · `.curve-dot`（`.is-peak/.is-low`）· `.curve-axis` · `.curve-label` · `.curve-peak-label`

> **数据零新增**：故事树与节奏曲线所需的「主轴、支线分岔/收束、高潮、状态、张力」全部从既有 `structureChapters` / `plotlines` / `outlineGraph.volumes` **派生**，未新增任何 mock 数据集。派生规则固定为：分岔章 = `min(active)`、收束章 = `max(active)`、高潮 = `intensity >= 4`（曲线标注仅取 `=== 5`）。

### 批次六新增组件类（已写入 styles.css §47–51）

- **生产流程（流程图 · HTML）**：`.pipe` · `.pipe-step` · `.pipe-node`（`.is-done/.is-active/.is-todo`）· `.pipe-name` · `.pipe-meta` · `.pipe-arrow`（`::after` 三角箭头）
- **四个 SVG 容器（统一约定）**：`.flow-wrap` / `.tl-wrap` / `.struct-wrap` / `.fish-wrap` —— 均须给 `> svg { width:100%; height:auto }`，且显式写 `viewBox`
- **场景流程图**：`.flow-pill` · `.flow-pill-text`（起止 pill）· `.flow-node`（`.is-conflict/.is-turn/.is-resolve`）· `.fn-t`（场景名）· `.fn-s`（序号）· `.flow-edge`（`.is-branch` 虚线支路）· `.flow-edge-label`
- **时间线图**：`.tl-line` · `.tl-tick` · `.tl-band` · `.tl-band-label` · `.tl-dot`（`.is-flashback/.is-future`）· `.tl-at`（时间）· `.tl-label`（事件）· `.tl-label-sub`（类型）
- **情节结构图**：`.struct-act`（幕块）· `.struct-act-line` · `.struct-area` · `.struct-curve` · `.struct-act-name` · `.struct-beat` · `.struct-marker-line` · `.struct-marker` · `.struct-label`
- **鱼骨图**：`.fish-spine` · `.fish-head` · `.fish-head-text` · `.fish-rib` · `.fish-cat` · `.fish-cause-dot` · `.fish-cause`

> **注意**：`.fs-11` **不是**本契约的工具类（不存在）；可用的字号工具类仅 `.fs-12 / .fs-13 / .fs-14 / .fs-16 / .fs-20`。需要更小时用 `.pipe-meta`、`.tl-at` 这类自带字号的组件类。

### 批次七新增组件类（已写入 styles.css §52–55）

- **双轨时间线**（大纲页全书时间线 + 章节页对照图共用）：`.tl2-wrap` · `.tl2-rail` · `.tl2-rail-label` · `.tl2-dot`（`.is-backstory` / `.is-future` / `.is-planned`）· `.tl2-link`（`.is-backstory`）· `.tl2-at` · `.tl2-label` · `.tl2-ch` · `.tl2-now` · `.tl2-now-label`
  > ⚠️ **`.tl2-dot` 没有 `is-flashback` 类**。闪回必须复用 `.is-backstory`，预叙用 `.is-future`，尚未写入用 `.is-planned`，顺叙不加类。
- **节拍骨架**（大纲页）：`.beat-wrap` · `.beat-act` · `.beat-act-name` · `.beat-block`（`.is-done` / `.is-active` / `.is-todo`）· `.beat-name` · `.beat-core` · `.beat-link` · `.beat-axis` · `.beat-axis-line` · `.beat-marker` · `.beat-marker-dot` · `.beat-marker-label`
- **生产流程图**（大纲页全书流程 + 章节页执行流程共用）：`.pflow-wrap` · `.pflow-node`（`.is-done` / `.is-active` / `.is-todo` / `.is-optional` / `.is-revise`）· `.pflow-name` · `.pflow-meta` · `.pflow-edge`（`.is-loop`）· `.pflow-edge-label` · `.pflow-decision` · `.pflow-decision-text` · `.pflow-pill` · `.pflow-pill-text`
- **幕内节拍序列**（章节页）：`.actline` · `.actline-beat`（`.is-past` / `.is-current`）· `.actline-name` · `.actline-meta` · `.actline-arrow`

> **绘图顺序约定**：SVG 中「边先于节点绘制」——先画 `.pflow-edge` / `.beat-link` 等连线，再画节点矩形，节点压线可避免连线穿过文字。
> **回环约定**：回环边一律 `.pflow-edge.is-loop`（琥珀虚线）并配 `.pflow-edge-label` 说明触发条件（如「否 · 续写下一章」「修订后重审」）。

### 批次八新增组件类（已写入 styles.css §56）

- **分组按钮**：`.viewbar-groups`（容器）· `.vgroup`（`.active` 表示当前分组）· `.vgroup-count`（组内视图数）
- **二级标签行**：`.viewbar-sub`（承载第二行视图标签 + 底部分隔线 + 24px 下边距）
- **`.viewbar.is-grouped` 修饰符**：仅去掉 `.viewbar` 自身的 `border-bottom` 与 `margin-bottom`，交由 `.viewbar-sub` 承担
  > ⚠️ **不得直接修改 `.viewbar` 本身**——`chapter.html` 仍是单级 `.viewbar`，改基类会破坏它的布局。二级标签必须用 `.viewbar.is-grouped`。

### 批次九新增规范（已写入 styles.css §57）· 清晰度通修

**起因（实测数据）**：图表原以 tokens 的 `*-soft` 浅色底表达状态，对纸底对比度仅 **1.10–1.17:1**（WCAG 图形元素要求 ≥ 3:1），且「已完成 / 进行中 / 未写」两两之间只有 **1.00–1.07:1** —— 数学上无法区分，这是"不够一目了然"的根因。

**三条强制规范：**

1. **状态必须走三重辨识通道**，不得只靠颜色：
   | 状态 | 色相（描边） | 线宽 | 线型 | 填充 |
   |---|---|---|---|---|
   | 已完成 / 通过 | 苔绿 `--moss` (5.65:1) | 2px | 实线 | `moss 14%` 混纸 |
   | 进行中 / 待处理 | 琥珀 `--amber` (3.57:1) | **3px** | 实线 | `amber 18%` 混纸 |
   | 修订 / 回退 | 朱砂 `--crimson` (6.15:1) | 2px | **点线 `2 3`** | `crimson 14%` 混纸 |
   | 未开始 | 灰 `--ink-4` | 2px | **虚线 `5 4`** | `--paper-3` |
   三者叠起来 = 即使色觉异常也能靠线宽/线型区分。**新增状态时必须补齐这三通道，不得只给一个 fill。**

2. **图表字号权威层为 styles.css §57.2**。图表内最小字号不得低于 **11px**（中文可读下限；原 10px 在 viewBox 缩放后实际仅 ≈9.6px）。调整任何图表文字大小，**只改 §57.2**，不要改各组件原始声明。

3. **每张图必须配一条结论条 `.chart-note`**，格式固定为「**结论**（含数字，用 `<strong>` / `<em>` 标出）· 读法」——结论在前、读法在后。数字必须由真实 mock 数据**运行时计算**，不得写死。
   - 语义变体：`.is-ok`（一切正常）· `.is-warn`（有风险）· `.is-danger`（有冲突）
   - ⚠️ `.chart-note` 必须是 `display:block` —— 若改成 flex，`<strong>结论</strong> · 读法` 这类单段内联文案会被拆成多个 flex 项并排成两栏。

### 批次十规范（§58 已被批次十一取代，仅保留方向决策）

- **方向约定（仍在生效）**：**时间类图表一律竖向**（时间自上而下推进）。横向时间轴在章节数一多时，中文标签必然要靠错位/截断才能不重叠，可读性差 —— 这是批次十改向的原因，批次十一沿用。
- > 批次十的 `.vtl-*` 系列（竖向主干）**已随批次十一整体删除**，此前仅大纲页使用；`.tl2-*`（横向双轨）**仍被 `chapter.html` 使用，不得删除**。

### 批次十一新增规范（已写入 styles.css §58）· 剧情走向树

- **变更动机**：批次十的竖向主干仍是「一条线」——左列文字 / 中央节点 / 右列 chips 看不出「同一事件被分散在多章叙述」这层分岔。本次改为**树状图**：主干 = 故事时间，分枝 = 时间锚点，叶 = 该锚点在「叙述顺序」里落地的章节。
- **组件类（新）**：`.vtr-wrap`（SVG 容器）· `.vtr-trunk`（主干）· `.vtr-branch`（分枝）· `.vtr-twig`（细枝）· `.vtr-arrow` · `.vtr-root` · `.vtr-head`（列头）· `.vtr-band`（阶段分段带）· `.vtr-band-dot` · `.vtr-band-t` · `.vtr-dot` · `.vtr-at` · `.vtr-label` · `.vtr-note` · `.vtr-leaf`（`.is-now` / `.is-todo`）· `.vtr-leaf-t`（同上）· `.vtr-leaf-g`（可点击叶组）· `.vtr-now` / `.vtr-now-t`
- **阶段配色（描边与填充分两组工具类）**：`.vtr-s-<stage>` 置 `stroke`（主干 / 分枝 / 细枝共用）· `.vtr-f-<stage>` 置 `fill`（分段带圆点）；`<stage>` ∈ `backstory | flashback | now | future`，`planned` 归入 `future`
- **固定坐标**（`VTR` 常量）：`W=760` · `PAD=26` · `ROOT_GAP=40` · `BAND=34` · `ROW=84`；主干 `TRUNK=300` · 左列右对齐 `TEXT_R=286` · 分岔点 `SPLIT=356` · 叶列 `LEAF0=390` / `LEAF_W=160` / `LEAF_H=24` / `LEAF_GAP=26`
- **四层结构（自上而下）**：根节点「全书剧情走向」（`ROOT_Y = PAD + 14`）→ 阶段分段带（4 条，按阶段着色）→ 主干逐段着色（首段自根节点起）→ 左列「时间 / 事件 / 备注」+ 主干节点 → 分枝 `M TRUNK+7,cy H SPLIT` → 细枝扇形连叶 → 章节叶（`第 n 章 · 章名`）
- **同锚点多章＝分岔**：叶按 `cy + (i - (n-1)/2) * LEAF_GAP` 纵向等距排开，与细枝构成扇形；`n === 1` 时单叶直连
- **叶的状态**（与 §57 三重通道一致）：`.is-todo` 未写 = `--paper-3` + 虚线 `4 3`；`.is-now` 第 17 章 = 靛蓝实心 + 2px；点击叶 → `chapter.html#n`
- **高度自算**：`H = PAD + ROOT_GAP + 4×BAND + 10×ROW + PAD + 12`，渲染后由 JS 写回 `viewBox`（实测 `0 0 760 1080`）
- **条目更名**：大纲页视图标签「全书时间线」→ **「剧情树」**（仍在「时间」分组），`VIEW_HINT` 同步改写
- > 与「走向」分组已有视图**「故事树」的分工**：故事树＝**章节结构**视角（横向主干 1→20 章 + 支线分岔合流）；剧情树＝**故事时间**视角（纵向主干 + 锚点分岔到章节叶）。两者不合并。

### 批次十二规范（审计修复）· 十条硬约定

本批次依据一次完整前端审计（五维技术评审 + Nielsen 十项启发式）修复。**以下十条约定的优先级高于本契约此前任何表述**，冲突时以本节为准。

**1. 文字层与图形层必须分离（令牌语义）**
`:root` 令牌按用途分两层，不得混用：
- **文字层**（`--ink` / `--ink-2` / `--ink-3`）：任何时候都必须对纸底 ≥ **4.5:1**。
- **图形层**（`--ink-4` / `--line` / `--line-strong`）：仅用于边框 / 轴线 / 箭头 / 图标等非文字元素，≥ **3:1**。
- ⛔ **`--ink-4` 不得用于任何文字**（它是图形层）。文字需要更淡的一档时用 `--ink-3`。
- 实测验收值：`--ink-3 #6B6455` = paper 5.58 / paper-2 5.21 / paper-3 4.76；`--ink-4 #8F8778` = paper 3.38 / paper-2 3.16。

**2. 控件边界用 `--line-ctl`，装饰边框才用 `--line` / `--line-strong`**
`--line-ctl #948871`（paper 上 3.32:1）专供 `.input` / `.select` / `.textarea` / `.gnode rect` 等「靠边界识别控件」的场景（WCAG 1.4.11）。卡片、表格等装饰性边框仍用 `--line` / `--line-strong`，不参与 3:1 要求。

**3. 朱砂语义收权：`--crimson` 是「标记笔」，错误用 `--error`**
- `--crimson #A6392E`（朱砂）**只**用于：品牌印、伏笔标记（`.tag-seal`）、本章位置、闪回、当前进度线——即「在人稿上做标注」这一族语义。
- **错误 / 阻塞**改用新增的 `--error #7E2A33` + `--error-soft #F2E2E2`（paper 8.81 / error-soft 7.39）。`.tag-danger`、`.audit-item.sev-blocker`、失败态图标均走 `--error`。
- 理由：`.tag-seal`（伏笔）与 `.tag-danger`（报错）此前视觉几乎不可分（同为 `crimson-soft` 底 + `crimson` 字），作者看到一片红分不清「伏笔」还是「有问题」。

**4. 图表渲染契约（styles.css §59）：图表永不缩放到低于 1:1**
⛔ 禁止让固定 viewBox 的 SVG 图表随容器缩到 1:1 以下——那会让 §57.2 设定的 11px 图表字号名不副实（980 宽图在 755px 容器里只有 0.77×，11px 实际渲染 8.47px）。
约定：`.tree-wrap` / `.beat-wrap` / `.curve-wrap` / `.vtr-wrap` / `.pflow-wrap` / `.graph-wrap` / `.flow-wrap` / `.tl-wrap` / `.tl2-wrap` / `.struct-wrap` / `.fish-wrap` 一律 `overflow-x:auto`，其内 svg 带 `min-width`（= viewBox 宽）。**空间不足时横向滚动，绝不缩小文字。**
> **v1.12 修正**：`.vtr-wrap > svg` 的 `min-width` 由 `740px` 改为 `760px`，与批次十一的固定坐标 `W=760` 对齐（原值会让剧情树渲染成 0.974×，11px 字号实际只有 10.7px，与本节「永不缩到 1:1 以下」自相矛盾）。其余容器已是 1:1。

**5. 图表字号的唯一权威层仍是 §57.2**
修改图表字号**只改 §57.2**，不要改各组件原始声明（原始声明是历史记录，故意保留）。
⚠️ 警告：§57.2 的覆盖依赖选择器特异性。若某组件原始声明用了**后代选择器**（如 `.flow-node .fn-s`），§57.2 里必须写同等的 `.flow-node .fn-s`，只写 `.fn-s` 会被原始声明反超（曾真实踩坑）。

**6. `[hidden]` 必须真正生效**
`styles.css §2` 已有 `[hidden] { display:none !important; }`。**不得**再为绕过它而写内联 `style.display`——那说明你遇到的是组件 `display:flex/inline-flex` 覆盖 UA 样式的问题，根因已统一修复。

**7. 交互元素必须键盘可达**
- 原生控件（`button` / `a` / `input` / `select` / `textarea`）直接用。
- `div` / `span` / SVG `g` 承载点击时，**必须**走 `App.clickable(el, handler)`：它补 `role="button"` + `tabindex="0"` + Enter/Space 触发。
- 已有隐式语义的元素（如 `<tr>`）用 `App.clickable(el, handler, false)`——只补键盘能力，不覆盖原生 role。
- 焦点环由全局 `:focus-visible` 提供，组件不得移除。

**8. 加载失败必须可补救**
- 页面初始化加载一律接 `.catch` → `App.fail(容器选择器, err, 重试函数)`，渲染统一的「加载失败 + 重试」态。
- 容器选择器必须是**该请求真正写入的主内容容器**；目标是 SVG 元素时须指向其外层 wrapper（`innerHTML` 在 `<svg>` 上不生效），目标是 `<tbody>` 时须指向其外层容器。
- 原型下可用 `?fail=1` 或 `api.setFailRate(1)` 注入失败以验收。

**9. 同一指标只能有一个数据来源**
⛔ 禁止「HTML 写死的静态值」与「JS 运行时的计算值」并存——首屏会跳变，且两处会互相矛盾（曾同时存在：成本 ¥0.84/¥1.89、规则违规 2/4、硬约束 5/6、章节数 60/7）。
静态初值一律写 `—`，由脚本填真实值。真正需要两套口径的（如「项目累计已用」vs「用量明细合计」）必须在文案里写明各自口径。

**10. 面向作者，不面向工程师（文案层级）**
用户可见文案里**不得出现**研发语汇：`L1` / `L2`、`blocker` / `major` / `minor`、`spot-fix`、`JSON Patch`、`tokens`、`p50` / `p90`、`OOC`、`Proposal → Validate → Commit`、`personality` / `speechStyle`。
替换规则：`L1`→`规则校验`、`L2`→`模型审查`、`blocker/major/minor`→`阻塞定稿/重点/建议`、`tokens`→`额度`、`spot-fix`→`定点改写`。**原术语收进 `title` 属性**，信息不丢、但不在正文里挡路。

**本批次新增组件类与 API**

| 类型 | 新增 | 说明 |
|---|---|---|
| 令牌 | `--line-ctl` · `--error` · `--error-soft` | 见上 1–3 条；`--ink-3` / `--ink-4` / `--amber` 取值已调整 |
| CSS 类 | `.crumb`（面包屑）· `.state-error`（加载失败态）· `.toast-ok` / `.toast-warn` / `.toast-error`（toast 分型） | styles.css §2 / §10 / §59 |
| JS API | `App.clickable(el, handler[, role])` · `App.fail(container, err, retry)` · `App.toast(msg[, type])` · `api.setFailRate(r)` | 见上 7–8 条 |
| JS 约定 | `NAV_PARENT = { chapter:'outline', knowledge:'outline', disassemble:'projects' }` | 子页在侧栏的归属映射，子页进入后侧栏必须有 active 与 `aria-current="page"` |
| 结构 | 每个子页须有面包屑；`.card-head` 内标题统一 `<h2>`；页面层级为 `h1 → h2`（卡片） | 不得跳级 |

> **框架约定（v1.3 修订）**：`.seg` 的分段控件改用**事件委托**（见 app.js `initSegs`），因此**页面载入后动态注入的 `.seg` 按钮同样生效**；页面不得再自行派发 `seg:change`，只监听即可。

## App Shell + Canonical Nav（多页必须逐字一致）

**权威来源：`do-bi/index.html`。其余页面必须从该文件复制 `<aside class="sidebar">…</aside>` 整块，一字不改。**

```html
<body data-page="<projects|workbench|chat|characters|hooks|outline|world|audit|style|settings|disassemble>">
  <aside class="sidebar"> … brand + nav + side-foot … </aside>
  <main class="main" id="main"> … 本页内容（含 .topbar） … </main>
</body>
```

nav items（**批次四扩为 10 项**，顺序冻结，禁止增删改序）：
| 顺序 | label | lucide | href | data-nav |
|---|---|---|---|---|
| 1 | 项目 | library | index.html | projects |
| 2 | 工作台 | pen-line | workbench.html | workbench |
| 3 | 共创 | messages-square | chat.html | chat |
| 4 | 角色 | users | characters.html | characters |
| 5 | 伏笔 | bookmark | hooks.html | hooks |
| 6 | **结构** | git-branch | outline.html | outline |
| 7 | **世界观** | **globe** | **world.html** | **world** |
| 8 | 审计 | clipboard-check | audit.html | audit |
| 9 | 文风 | type | style.html | style |
| 10 | 设置 | settings-2 | settings.html | settings |

> 注：`outline.html` 的 label 由「章纲」改为「结构」（覆盖大纲/章节/情节线/依赖图四个视图），但 `data-nav` 键与文件名保持不变以避免无谓改动。

nav positioning: `.sidebar` 固定左侧 `width:var(--sidebar-w)`；`.main` `margin-left:var(--sidebar-w)` —— 每页一致
active rule（唯一机制）: `app.js` 为 `[data-nav]` 中 `data-nav === document.body.dataset.page` 的项加 `.active`
mount: 每页内联 shell（默认），禁止 JS 注入

brand 区块（冻结）：`.brand` = `.brand-seal`（靛蓝方印 + 朱砂点）+ `.brand-name`（Do_Bi 衬线）+ `.brand-sub`（小说创作台）

`.topbar` 是每页内容的一部分（放在 `.main` 内第一块），结构固定：
`.topbar` > `.topbar-title`（含 `h1` + `.topbar-sub`）+ `.topbar-actions`

## Page List

| # | 文件 | 页面 | 批次 | 职责 | 关键组件 |
|---|---|---|---|---|---|
| 1 | **index.html** | **我的作品（首页）** | **三** | 项目总览、新建、拆书入口、最近记录 | 项目卡网格、继续创作卡、新建模态 |
| 2 | **workbench.html** | 写作工作台 | 一 | 写作 + 确认 + 干预 | 三栏、手稿页边、助手面板、干预开关 |
| 3 | chat.html | 共创对话 | 一 | Chat-first 立项 | 对话流、选项卡、设定沉淀 |
| 4 | characters.html | 角色与关系 | 一 | 角色卡与关系 | 角色列表、详情、不可变特征 |
| 5 | hooks.html | 伏笔看板 | 一 | 伏笔追踪与回收率 | 统计条、状态泳道、时间线 |
| 6 | outline.html | **结构与大纲** | 二/四/五/七/十/十一 | **九视图**：故事树（默认）/ 节拍骨架 / 节奏曲线 / 剧情树 / 情节线 / 生产流程 / 总纲 / 章节板 / 依赖图 | **故事树** + **节拍骨架**（幕→节拍→章节三层）+ **剧情树（纵向主干按阶段着色 + 分枝到章节叶）** + **生产流程图**（判定 + 2 处回环）、节奏曲线（张力折线 + 自动诊断）、情节线地铁图、罗盘卡 + 章节×情节线矩阵、章节板、依赖图 SVG |
| 7 | chapter.html | **章节详情** | 六/七 | 五视图：生产流程 / 场景流程 / 时间线 / 结构位置 / 问题鱼骨 | 生产流程（步骤条 + **执行流程图含判定与回环**）、场景流程图、故事内时间线（**+ 与全书时间锚点双轨对照**）、情节结构位置图（**+ 本幕节拍序列**）、问题归因鱼骨图 |
| 8 | world.html | 世界观 | 四 | 设定清单、冲突裁定、与情节线对齐 | 统计条、冲突裁定卡、分类规则卡、引用章 chips、`world.md` 片段 |
| 9 | audit.html | 审计报告 | 二 | L1 规则 + L2 维度 + 可举证评审 + diff | 统计条、规则行、发现卡、评分行、diff 预览 |
| 10 | style.html | 文风档案 | 二/四 | 当前文风 + 提取入口 + 选择入口 + 分析结果 | 当前文风卡、文风选择器网格（含样段）、提取模态、句式/视角/比例卡、禁用 chip、注入对比 |
| 11 | settings.html | 设置 | 一/三 | Provider / 模型 / 预算 / MCP | Provider 列表、映射表、预算、成本、MCP 面板 |
| 12 | disassemble.html | 拆书 | 三 | 导入已有作品反推结构化设定 | 投放区、反推流水线步骤条、抽取结果选项卡、写入提案 |
| 13 | **knowledge.html**（`/knowledge`） | **知识库** | 十二 | **把散在各页的设定 / 角色 / 伏笔 / 支线 / 章节连成一张可漫游的网**（只读派生：数据来自真相文件里已有的关系字段，不新增真相文件） | 统计条、全库检索、**关系网**（按类型分列的节点 + 带箭头的关系连线，点节点即漫游）、条目详情（它指向谁 / 谁指向它）、条目清单（按类型筛选） |

**知识库页为「结构」下的子页**：导航 10 项仍冻结（不得增删改序），本页无独立导航项，侧栏归属「结构」（`NAV_PARENT`），入口在结构页顶栏的「知识库」按钮。图谱沿用 `.graph-wrap` / `.gnode` / `.gedge` / `.legend` / `.chart-note`，`viewBox` 固定 720 宽（`.graph-wrap > svg { min-width:720px }`）；列数一多就收窄节点，绝不把列挤出画布。

**导航高亮特例（两页，均为刻意行为）**：
- `disassemble.html`（`data-page="disassemble"`）在导航中无对应项——拆书是「项目」下的任务流，不是日常工作面。顶部提供「← 返回全部作品」回链。
- `chapter.html`（`data-page="chapter"`）同样无导航高亮——章节是**明细页**，由结构页的故事树节点 / 章节卡 / 依赖图节点详情按钮进入，通过 `location.hash`（如 `chapter.html#17`）传递章号。顶部提供「在结构页查看」回链。

以上均为契约规定行为，不是缺陷。

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
- **`styleProfile`**：`{ source, analyzedAt, tokens, sentence:{mean,p50,p90,min,max,scale}, narrative:{person,tense,povSwitch,anchor}, ratio:[{label,pct,color}], patterns[], banned[], lexicon:[{key,value}], injection:{text,tokens}, sample:{plain,styled} }`

批次三新增：
- **`projects[]`**：`{ id, title, genre, spine, isCurrent, logline, chaptersDone, chaptersTotal, words, mode, budgetUsed, budgetTotal, updatedAt, hooksResolved, hooksTotal, auditPass }`
- **`disassemble`**：`{ source:{name,chapters,words,format,size}, stages:[{key,title,desc,status:'done|active|todo'}], stats:{chapters,characters,worldRules,hooks,hooksMatched,tokens}, extracted:{characters[{name,role,traits[],relations}], hooks[{content,plantedChapter,matched,importance}], worldRules[], style:{sentence,pov,ratio}}, proposals:[{id,kind,content,confidence:'high|medium|low',decision}] }`
- **`mcpServers[]`**：`{ name, transport:'stdio|http', command|url, tools[], enabled, status:'ok|idle|failed', latency, calls, error? }`

批次四新增：
- **`structureChapters[]`**：`{ n, title, volume, arc, status:'done|audit|draft|todo', words, pov, intensity:1-5 }`（1–20 章，供章节板 / 矩阵 / 情节线共用）
- **`plotlines[]`**：`{ id, name, kind:'main'|'sub', color, summary, active:[章号], peak:[章号] }`
- **`stylePresets[]`**：`{ id, name, tagline, sample, category, applied }`（`sample` 为样段，是选择文风的核心依据；`category:'我的'` 表示从样本/本书提取所得）
- **`styleSources[]`**：`{ id, kind:'file'|'book'|'merge', label, hint, checked }`
- **`worldSettings[]`**：`{ id, category, kind:'hard'|'soft', status:'ok'|'conflict'|'unused', rule, refs:[章号], note }`

批次五：**无新增数据集**（故事树与节奏曲线全部由 `structureChapters` + `plotlines` + `outlineGraph.volumes` 派生，见「批次五新增组件类」下的派生规则）。

批次六新增：
- **`pipelineSteps[]`**：`{ key, name, hint, minutes, tokens }` —— 内容生产流水线 8 环节（章纲 / 上下文组装 / 草稿 / 审计 L1+L2 / 可举证评审 / 去 AI 味 / 修订 / 定稿）。`minutes`/`tokens` 为**流水线典型值**，页面须注明真实计量以本地账本为准
- **`structureActs[]`**：`{ name, from, to, note }` —— 情节结构模板（三幕四段）
- **`chapterDetails{}`**：键为章号（1–20），值 `{ beat, scenes:[string], timeline:[{at,label,kind:'now'|'flashback'|'future'}], problem?:{title, causes:[{category, items:[string]}]} }`
- `api.getChapterDetail(n)` 返回 `{ chapter, detail, steps, acts, act, pipeline:{done, active, total} }`；`done` 由章节状态映射（done→8 / audit→3 / draft→2 / todo→0），`active = done < total ? done + 1 : null`

批次七新增（全部为大纲级）：
- **`bookTimeline[]`**：`{ id, storyAt, label, kind:'backstory'|'flashback'|'now'|'future'|'planned', chapters:[章号], note }` —— **数组顺序即故事时间顺序**，共 10 条
- **`beatSheet[]`**：`{ act, from, to, beats:[{ name, from, to, core, status:'done'|'audit'|'draft'|'todo' }] }` —— 4 幕 12 节拍
- **`bookPipeline[]`**：`{ key, name, meta, status, optional? }` —— 全书生产 8 阶段
- `api.getBookTimeline()` → `{ events, chapters }`；`api.getBeatSheet()` → 数组；`api.getBookPipeline()` → `{ stages, project }`
- **章节事件 ↔ 全书锚点匹配规则**：对本章每个事件，在 `bookTimeline` 中取第一个满足「`e.label.indexOf(ev.label) >= 0 || ev.label.indexOf(e.label) >= 0`」的锚点（双向包含匹配），匹配不到则不画连线

## 交互约定（stub，不调真模型）

- 所有「生成 / 审计 / 分析 / 刷新」按钮：显示 loading → `setTimeout` 模拟 → 写回 mock 并重渲染
- `api.js` 暴露 `api.*` 全部返回 `Promise`，内部只读 `mock.js`，**不发起任何网络请求**
- 批次二新增交互：依赖图节点点击选中并高亮其边 + 联动节点详情；边清单表行点击高亮对应 SVG 边；审计发现「接受 / 忽略」切换决策并刷新统计；diff 折叠展开；文风档案禁用词增删；注入对比切换
- 批次三新增交互：项目卡「打开 / 开始立项」跳转；新建作品模态创建后重渲染列表；拆书投放区 dragover/drop 高亮；「继续执行」推进流水线阶段；提案逐条接受 / 拒绝 / 撤回 + 全部接受 / 拒绝；MCP 开关切换与连通性测试
- 批次四新增交互：
  - **结构页四视图切换**（`setView`，独立实现，不复用 `data-tabs`）；章节卡点击选中；情节线 hover 不做额外态；矩阵仅作展示
  - **文风页**：顶栏「提取文风」开模态、「选择文风」滚动定位；选择器分类筛选（监听 `#style-cat` 的 `seg:change`）；点「应用」→ `api.applyStylePreset` → 重渲当前文风卡 + 选择器 + 顶栏副标题
  - **提取模态**：勾选来源（`src-list`）+ 可选粘贴样本；空来源且空粘贴时拦截并提示；成功后重渲当前文风卡
  - **世界观页**：分类筛选（`#world-cat` 的 `seg:change`）；「改为硬约束 / 改为软设定」切换；冲突裁定两选项（保留正文改写规则 / 按规则修改正文）；「查看引用章」提示章号
- 批次五新增交互：
  - **结构页六视图切换**：视图顺序 `tree · curve · plotlines · overview · board · graph`，默认 `tree`；`.vtab` 的 `data-view` 与 `#view-*` 容器一一对应（`hidden` 必须加在**无 class 的外层容器**上，否则 `.stack-24` 的 `display:flex` 会覆盖 UA 的 `[hidden]{display:none}`）
  - **故事树**：点击章节节点 → **跳转章节详情**（v1.5 起由 `is-selected` + toast 改为 `location.href`，见批次六）；节点内含 `<title>` 提示「第N章 · 标题 · 强度X」；支线颜色取自 `plotlines[].color`
  - **节奏曲线**：纯前端诊断（连续低强度段 → `sev-major`；全书最低点 → `sev-minor`；5 级高潮分布 → 说明行）；`#curve-risk-tag` 随风险数切换文案与配色
- 批次六新增交互：
  - **结构页 → 章节详情**：故事树节点、章节板卡片的点击均改为 `location.href = 'chapter.html#' + n`（不再是 toast）；依赖图节点详情卡在选中节点存在 `chapter` 字段时追加「打开第 N 章详情 →」按钮
  - **章节详情页 hash 路由**：从 `location.hash` 解析章号（非法或缺省回退 **17**）；切换时写 hash 并用标记位抑制自触发的 `hashchange`，同时监听 `hashchange` 以支持浏览器前进/后退；渲染用 `Promise.all([getChapterDetail(n), getStructure()])` 并配 `seq` 序号防止乱序覆盖
  - **章节详情页五视图**：顺序 `pipeline · flow · timeline · structure · fishbone`，默认 `pipeline`；上一章/下一章按钮在边界章 `disabled`；章号 `select` 可直达
- 批次七新增交互：
  - **大纲页二级标签（v1.7）**：9 个视图固定归属 4 个分组——**走向** `[tree, beats, curve]` · **时间** `[timeline, plotlines]` · **生产** `[pipeline]` · **明细** `[overview, board, graph]`；默认分组 `arc`、默认视图 `tree`。分组按钮点击后自动进入该组**上次看过的视图**（`groupMemory`），无记忆则取组内第一个；`setView` 是唯一入口，内部负责同步分组高亮、重渲标签、切换面板与提示文案。视图标签与分组成员由 `VIEW_META` / `VIEW_GROUPS` **动态渲染**，不得在 HTML 中写死 `.vtab`。
  - **大纲页生产流程图**：判定「全书定稿？」分出两条边——「是」→ 全书组装 → 完结校验；**回环 1**「否 · 续写下一章」回到「章纲」，**回环 2**「有新定稿章 · 重跑」从「全书组装」回到「逐章流水线」
  - **章节页执行流程图**：判定「审计通过？」——「不通过」→ 修订 → **回环**回到「审计 L1+L2」重审；「通过」→ 可举证评审 → 去 AI 味 → 定稿；节点状态映射须与页面既有 `.pipe` 步骤条**保持一致**（按步骤**名称**在 `steps` 中查序号）
  - **章节页双轨时间线**：上轨本章事件、下轨全书锚点，连线按「双向包含匹配」规则；`#tl2-tag` 显示「N / M 个事件已定位」，匹配不到的事件不画线
  - **章节页本幕节拍序列**：从 `beatSheet` 取与当前 `act` 同名的一幕，按 beats 顺序渲染；`beat.to < 当前章` → `.is-past`，覆盖当前章 → `.is-current`
- 批次九新增交互：
  - **每张图配结论条**：大纲页 9 个视图、章节页 8 处（含执行流程图 / 双轨对照 / 本幕节拍序列三处补充）均有 `.chart-note`；文案结论在前、数字运行时计算
  - **`.card-head` 状态计数**：故事树 / 节拍骨架 / 章节板 / 生产流程四处，右侧 tag 改为状态计数三连（`tag-ok` 已完成 / `tag-warn` 进行中 / `tag-quiet` 未写），计数为 0 的标签不渲染，避免「0 未写」这类噪声
  - **图例必带可见色样**：`.legend-item` 文字走 12px，每项须配 `.legend-swatch`，色样取对应状态原色
