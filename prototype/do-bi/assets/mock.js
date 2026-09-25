/* ==========================================================================
   mock.js — 统一假数据（世界观：北境 · 文脉 / 古风悬疑）
   禁止 lorem ipsum。api.js 只读本文件，不发起任何网络请求。
   ========================================================================== */
window.MOCK = (function () {
  const project = {
    id: 'proj_shenyan',
    title: '雁回关',
    genre: '古风悬疑',
    logline: '一个北境小吏追查失踪案，却发现王朝正在被「文脉」的力量吞噬。',
    mode: 'semi-auto',
    chaptersTotal: 60,
    chaptersDone: 17,
    words: 86420,
    wordsPerChapter: 5080,
    budgetUsed: 12.60,
    budgetTotal: 80.00,
    costUnit: '¥',
    updatedAt: '2026-09-24 22:10'
  };

  const chapters = [
    { n: 14, title: '灰烬里的名字', status: 'done',  words: 4820, updated: '09-20', summary: '沈砚在焚毁的驿馆灰烬中找到半枚铜牌。' },
    { n: 15, title: '夜访烛龙巷',   status: 'done',  words: 5110, updated: '09-21', summary: '崔十九首次透露「文脉」二字，随即噤声。' },
    { n: 16, title: '副将的靴印',   status: 'done',  words: 5360, updated: '09-22', summary: '雪地靴印指向副将周崇，沈砚起疑。' },
    { n: 17, title: '雪落雁回',     status: 'audit', words: 5240, updated: '09-24', summary: '沈砚识破周崇通敌，却在雪夜放走了旧友，青铜灯第一次亮起。' },
    { n: 18, title: '铜灯不熄',     status: 'draft', words: 1180, updated: '09-24', summary: '（草稿）沈砚带着铜灯回到关内。' },
    { n: 19, title: '文脉司来人',   status: 'todo',  words: 0,    updated: '—',    summary: '' },
    { n: 20, title: '第二枚铜牌',   status: 'todo',  words: 0,    updated: '—',    summary: '' }
  ];

  /* 第 17 章正文（分段，供手稿编辑区渲染） */
  const manuscript = {
    n: 17,
    title: '雪落雁回',
    status: 'audit',
    words: 5240,
    paragraphs: [
      { gutter: '17.1', text: '雪是后半夜落下来的。沈砚站在城楼上，看着那些碎白的东西一层层盖住关外的车辙，像有人试图把什么痕迹重新抹平。' },
      { gutter: '17.2', text: '他左眉骨的那道旧疤在冷风里隐隐发紧——每逢要出事，它总是先知道。', mark: 'hz', note: '不可变特征：左眉骨旧疤（伏笔 hook_002 呼应）' },
      { gutter: '17.3', text: '周崇的靴印从西门一直延伸到粮仓后墙，脚印间距离很宽，说明他走得极快。沈砚蹲下去，用指腹量了量鞋尖的弧度。' },
      { gutter: '17.4', text: '「你也在看这个。」身后传来声音。沈砚没有回头。他知道那是崔十九，也知道这人右手一直按在刀柄上。', mark: 'hl', note: '审计：视角跳跃 minor —— 同段内从沈砚视角短暂滑向全知' },
      { gutter: '17.5', text: '崔十九从怀里取出一只青铜小灯，放在雪地上。灯没有点，可沈砚分明看见，灯芯那一小截，是亮的。', mark: 'hl', note: '审计：设定冲突 major —— 与 world.md「铜灯须以血引方燃」矛盾' },
      { gutter: '17.6', text: '「拿回去。」崔十九说，「别让人看见你拿着它。尤其是别让文脉司的人看见。」' },
      { gutter: '17.7', text: '沈砚想问他为什么。但他最终只是把灯收进袖中，转身下了城楼，没有回头。', mark: 'hz', note: '伏笔 hook_007 埋设于第 4 章，本段为第一次显性呼应' }
    ]
  };

  const modes = [
    { value: 'auto',    label: '全自动', hint: '全部环节自动执行，仅在阻塞时暂停' },
    { value: 'semi-auto', label: '半自动', hint: '章纲与审计报告需人工确认' },
    { value: 'manual',  label: '手动逐步', hint: '每个环节都停下等待确认' }
  ];

  const characters = [
    {
      id: 'char_001', name: '沈砚', role: '主角', lead: true,
      immutableTraits: ['左眉骨有旧疤', '不饮酒', '惯用左手', '惧水'],
      personality: '沉默寡言，重承诺，认死理。',
      speechStyle: '短句，很少用感叹词；习惯用「嗯」代替回答。',
      state: { location: '北境·雁回关', status: '左臂有刀伤，未愈' },
      firstAppearance: 1, updatedAtChapter: 17,
      relations: [
        { target: 'char_002', type: '旧识', note: '曾同守黑水营，心存愧疚' },
        { target: 'char_003', type: '上司', note: '表面恭顺，暗中防备' },
        { target: 'char_004', type: '亡故', note: '其父，第 3 章确认死讯' }
      ]
    },
    {
      id: 'char_002', name: '崔十九', role: '关键配角', lead: false,
      immutableTraits: ['右手缺两指', '总按着刀柄'],
      personality: '亦正亦邪，说话留半句。',
      speechStyle: '爱用反问，从不直接回答。',
      state: { location: '雁回关·城楼', status: '未受伤' },
      firstAppearance: 9, updatedAtChapter: 17,
      relations: [
        { target: 'char_001', type: '旧识', note: '彼此试探，尚不信任' },
        { target: 'char_005', type: '隶属', note: '疑似听命于文脉司' }
      ]
    },
    {
      id: 'char_003', name: '周崇', role: '副将', lead: false,
      immutableTraits: ['左脸有灼伤疤'],
      personality: '刚愎，好面子，极重军功。',
      speechStyle: '语调高，爱用军令式短句。',
      state: { location: '雁回关·中军帐', status: '已被软禁' },
      firstAppearance: 6, updatedAtChapter: 17,
      relations: [{ target: 'char_001', type: '敌对', note: '通敌事败，记恨沈砚' }]
    },
    {
      id: 'char_004', name: '沈定山', role: '沈砚之父', lead: false,
      immutableTraits: ['已故'],
      personality: '（生前）严苛，寡言。',
      speechStyle: '（生前）只讲事实。',
      state: { location: '—', status: '第 3 章确认亡故' },
      firstAppearance: 3, updatedAtChapter: 3,
      relations: [{ target: 'char_001', type: '父子', note: '死因存疑' }]
    }
  ];

  const hooks = [
    { id: 'hook_002', content: '沈砚左眉骨的旧疤——来历从未交代', plantedChapter: 1, status: 'planted', resolvedChapter: null, importance: 'major', suggestedResolveBy: 30 },
    { id: 'hook_004', content: '沈定山之死并非战殁，验尸文书上少了一页', plantedChapter: 3, status: 'planted', resolvedChapter: null, importance: 'major', suggestedResolveBy: 45 },
    { id: 'hook_007', content: '沈砚幼年见过的青铜灯并未熄灭', plantedChapter: 4, status: 'planted', resolvedChapter: null, importance: 'major', suggestedResolveBy: 25 },
    { id: 'hook_009', content: '崔十九右手缺的两指，是被谁削去的', plantedChapter: 9, status: 'planted', resolvedChapter: null, importance: 'minor', suggestedResolveBy: 35 },
    { id: 'hook_011', content: '驿馆灰烬中的半枚铜牌，与铜灯同源', plantedChapter: 14, status: 'planted', resolvedChapter: null, importance: 'major', suggestedResolveBy: 28 },
    { id: 'hook_003', content: '黑水营那场败仗的溃口，并非敌军所为', plantedChapter: 2, status: 'resolved', resolvedChapter: 12, importance: 'major', suggestedResolveBy: 20 },
    { id: 'hook_006', content: '酒肆老板提到「文脉司三年未收人」', plantedChapter: 7, status: 'resolved', resolvedChapter: 15, importance: 'minor', suggestedResolveBy: 18 },
    { id: 'hook_005', content: '老驿卒说雪夜会有「不该有的车辙」', plantedChapter: 5, status: 'overdue', resolvedChapter: null, importance: 'minor', suggestedResolveBy: 16 }
  ];

  const audit = {
    chapter: 17,
    rulesViolated: 2,
    items: [
      { dim: '设定冲突', severity: 'major', fixed: false,
        evidence: '「灯没有点，可灯芯那一小截，是亮的」',
        suggestion: '与 world.md「铜灯须以血引方燃」冲突。建议改为：沈砚割破指尖，灯芯自行亮起。' },
      { dim: 'OOC', severity: 'major', fixed: false,
        evidence: '「沈砚没有回头……他知道那是崔十九」',
        suggestion: '沈砚在第 15 章明确说过未见过崔十九，此处不应瞬间辨声。建议补一句辨认依据（如缺指的脚步声）。' },
      { dim: '视角跳跃', severity: 'minor', fixed: true,
        evidence: '17.4 段内由沈砚限知短暂滑向全知',
        suggestion: '已改：删去「他知道这人右手一直按在刀柄上」的旁白式陈述。' },
      { dim: '伏笔遗漏', severity: 'minor', fixed: false,
        evidence: 'hook_005「不该有的车辙」已超过建议回收章（16）',
        suggestion: '可在本章雪夜场景补一笔车辙的呼应，避免悬置过久。' },
      { dim: '文风偏移', severity: 'minor', fixed: false,
        evidence: '17.6 出现「尤其是别让文脉司的人看见」——口语化偏高',
        suggestion: '对照 style_profile.json，建议改为「莫叫文脉司瞧见」。' }
    ]
  };

  /* 共创对话脚本 */
  const chatSeed = {
    genre: '古风悬疑',
    premise: '北境小吏追查失踪案，牵出「文脉」吞噬王朝的真相',
    protagonist: '沈砚，三十上下，关城小吏，沉默、认死理',
    coreConflict: '查案 → 发现至亲之死被掩盖 → 面对整个文脉司',
    tone: '冷峻、克制，重细节与环境，少对话标签'
  };

  const chatScript = [
    { role: 'me', text: '一个北境小吏追查失踪案，发现王朝正在被文脉力量吞噬。' },
    { role: 'ai', title: '先确认主角', text: '好底子。先问一个：这个「小吏」是哪种人？这决定了他查案时的所有选择。', options: ['认死理、不肯低头的硬骨头', '圆滑求生、但被逼到墙角', '我自己说'] },
    { role: 'me', text: '认死理、不肯低头的硬骨头。' },
    { role: 'ai', title: '再确认代价', text: '那他的执拗必须有代价。你希望这个代价落在谁身上？', options: ['至亲（父亲的死因存疑）', '同袍（旧友被牵连）', '他自己（身体/名声）'] },
    { role: 'me', text: '至亲。父亲的死因存疑。' },
    { role: 'ai', title: '设定已沉淀', text: '已写入右侧项目记录：主角档案、核心冲突、悬置伏笔 3 条。可以开始生成世界观与大纲了。', options: ['生成世界观与大纲', '再补一条世界观规则'] }
  ];

  const providers = [
    { name: 'DeepSeek',      baseUrl: 'https://api.deepseek.com/v1',        models: ['deepseek-chat', 'deepseek-reasoner'], configured: true,  priority: 1 },
    { name: 'OpenAI',        baseUrl: 'https://api.openai.com/v1',          models: ['gpt-4.1', 'gpt-4.1-mini'],             configured: true,  priority: 2 },
    { name: '通义千问',       baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus'], configured: true, priority: 3 },
    { name: '硅基流动',       baseUrl: 'https://api.siliconflow.cn/v1',      models: ['deepseek-ai/DeepSeek-V3'],             configured: false, priority: 4 }
  ];

  const modelRoles = [
    { step: '世界观 / 大纲', model: 'deepseek-reasoner',     temperature: '0.75', format: 'JSON' },
    { step: '章纲',          model: 'deepseek-reasoner',     temperature: '0.60', format: 'JSON' },
    { step: '正文生成',      model: 'deepseek-chat',         temperature: '0.92', format: '流式文本' },
    { step: '审计（L2）',    model: 'qwen-plus',             temperature: '0.15', format: 'JSON' },
    { step: '修订',          model: 'deepseek-reasoner',     temperature: '0.40', format: 'JSON Patch' },
    { step: '摘要 / 事实抽取', model: 'gpt-4.1-mini',         temperature: '0.10', format: 'JSON' },
    { step: '对话式共创',    model: 'deepseek-chat',         temperature: '0.70', format: 'JSON + 文本' }
  ];

  const budgetSplit = [
    { label: '系统规则',   pct: 5 },
    { label: '角色/世界观', pct: 15 },
    { label: '动态事实',   pct: 10 },
    { label: '历史摘要',   pct: 20 },
    { label: '当前草稿',   pct: 30 },
    { label: '输出预留',   pct: 20 }
  ];

  const usage = [
    { chapter: 15, promptTokens: 41200, completionTokens: 8600, cost: 0.72 },
    { chapter: 16, promptTokens: 44800, completionTokens: 9100, cost: 0.79 },
    { chapter: 17, promptTokens: 47600, completionTokens: 9400, cost: 0.84 },
    { chapter: 18, promptTokens: 12400, completionTokens: 2100, cost: 0.21 }
  ];

  const rules = [
    { name: '称呼/姓名不一致', hit: 0 }, { name: '角色已死亡仍出场', hit: 0 },
    { name: '不可变特征被违背', hit: 0 }, { name: '套话密度超阈值', hit: 1 },
    { name: '连续「了/的」字句', hit: 1 }, { name: '段落长度异常', hit: 0 },
    { name: '视角切换未标注', hit: 1 }, { name: '时间线倒错', hit: 0 },
    { name: '伏笔超期未回收', hit: 1 }, { name: '数值设定矛盾', hit: 0 }
  ];

  /* ====================== 批次二新增数据 ====================== */

  /* 章纲与依赖图 —— 支撑「滚动规划」与「章纲依赖图 / 思维链」 */
  const outlineGraph = {
    compass: {
      endgame: '沈砚以「文脉」为引，揭开王朝以活人为薪的真相，最终亲手熄灭铜灯——代价是失去关于父亲的记忆。',
      activeThreads: ['青铜灯与文脉同源', '沈定山之死被掩盖', '崔十九的来历与断指', '文脉司为何三年未收人'],
      scaleEstimate: '预计 4 卷 · 约 60 章 · 30 万字',
      refreshAt: '第 2 卷末刷新'
    },
    volumes: [
      { name: '第一卷 · 雁回关篇', from: 1,  to: 18, status: 'expanded', chapters: 18 },
      { name: '第二卷 · 风起文脉', from: 19, to: 36, status: 'expanded', chapters: 18 },
      { name: '第三卷 · 铜灯不熄', from: 37, to: 60, status: 'skeleton', chapters: 24 }
    ],
    nodes: [
      { chapter: 4,  title: '灰烬里的名字', arc: '雁回关篇', status: 'written',  goal: '引入铜灯的来历',
        beats: ['驿馆火场', '半枚铜牌', '铜灯首次出现'],
        rationale: '把铜灯第一次露面放在第 4 章，是为了让第 17 章的显性呼应不显突兀——读者需要先见过它。' },
      { chapter: 14, title: '半枚铜牌',     arc: '雁回关篇', status: 'written',  goal: '让铜牌与铜灯建立关联',
        beats: ['灰烬搜索', '纹样对照'],
        rationale: '本章只给纹样线索、不给结论，把推断留给第 17 章，维持悬疑节奏。' },
      { chapter: 16, title: '副将的靴印',   arc: '雁回关篇', status: 'written',  goal: '锁定周崇，制造压迫感',
        beats: ['雪地靴印', '量鞋尖弧度'],
        rationale: '先立「周崇有问题」的直觉，第 17 章的识破才有落点。' },
      { chapter: 17, title: '雪落雁回',     arc: '雁回关篇', status: 'audit',    goal: '识破周崇通敌，放走旧友，铜灯初亮',
        beats: ['雪夜巡查', '当面对质', '放走旧友', '铜灯初亮'],
        rationale: '此处放走旧友，是为第 24 章其反水做动机铺垫；若改成杀掉旧友，第 24 章必须整体重写。' },
      { chapter: 18, title: '铜灯不熄',     arc: '雁回关篇', status: 'draft',    goal: '把铜灯带回关内，指向文脉司',
        beats: ['夜路', '灯自亮', '接文脉司传令'],
        rationale: '卷末钩子，把线头交给第二卷。' },
      { chapter: 24, title: '旧友刀锋',     arc: '风起文脉', status: 'planned',  goal: '旧友反水',
        beats: ['重逢', '反水', '崔十九出手'],
        rationale: '依赖第 17 章的放走行为，动机闭环在此收束。' },
      { chapter: 31, title: '文脉司来人',   arc: '风起文脉', status: 'planned',  goal: '文脉司正式登场',
        beats: ['入境', '验灯', '传召'],
        rationale: '第 17 章埋下的「莫叫文脉司瞧见」在此兑现。' },
      { chapter: 40, title: '以血引灯',     arc: '铜灯不熄', status: 'skeleton', goal: '（骨架）揭示铜灯与活人祭祀的关系',
        beats: [], rationale: '骨架弧，待第二卷结束后由建筑师展开为详细章纲。' }
    ],
    edges: [
      { from: 4,  to: 17, type: 'setup',      note: '铜灯来源追溯到第 4 章，第 17 章的呼应才合法', confirmed: true },
      { from: 14, to: 17, type: 'causality',  note: '半枚铜牌的纹样与铜灯同源，是识破的关键', confirmed: true },
      { from: 16, to: 17, type: 'causality',  note: '靴印指向周崇，构成当面对质的前提', confirmed: true },
      { from: 17, to: 24, type: 'motivation', note: '第 17 章放走旧友 → 第 24 章旧友反水', confirmed: true },
      { from: 17, to: 31, type: 'setup',      note: '「莫叫文脉司瞧见」→ 第 31 章文脉司登门', confirmed: true },
      { from: 24, to: 31, type: 'causality',  note: '旧友反水供出文脉司，触发第 31 章入境', confirmed: false }
    ]
  };

  /* 审计报告 —— 支撑「审计深度 / 可举证评审 / 反 AIGC」 */
  const auditReport = {
    chapter: 17,
    title: '雪落雁回',
    stats: { l1: 3, l2: 5, fixed: 1, open: 4, passRate: 88 },
    l1: [
      { rule: '称呼／姓名不一致',   hit: '',            count: 0, threshold: 1, isHit: false },
      { rule: '角色已死亡仍出场',   hit: '',            count: 0, threshold: 1, isHit: false },
      { rule: '不可变特征被违背',   hit: '',            count: 0, threshold: 1, isHit: false },
      { rule: '禁用句式命中',       hit: '心中一凛',    count: 1, threshold: 1, isHit: true  },
      { rule: '套话密度超阈值',     hit: '',            count: 0, threshold: 3, isHit: false },
      { rule: '连续「了／的」字句', hit: '了…的…了',    count: 2, threshold: 2, isHit: true  },
      { rule: '词汇疲劳',           hit: '仿佛',        count: 6, threshold: 3, isHit: true  },
      { rule: '段落长度异常',       hit: '',            count: 0, threshold: 1, isHit: false },
      { rule: '视角切换未标注',     hit: '',            count: 0, threshold: 1, isHit: false },
      { rule: '时间线倒错',         hit: '',            count: 0, threshold: 1, isHit: false },
      { rule: '伏笔超期未回收',     hit: '',            count: 0, threshold: 1, isHit: false },
      { rule: '数值／等级矛盾',     hit: '',            count: 0, threshold: 1, isHit: false },
      { rule: '描写／对话比例偏离', hit: '',            count: 0, threshold: 1, isHit: false }
    ],
    findings: [
      { dim: '设定冲突', severity: 'major', fixed: false, decision: null,
        evidence: '「灯没有点，可灯芯那一小截，是亮的」',
        suggestion: '与 world.md「铜灯须以血引方燃」冲突。建议改为：沈砚割破指尖，灯芯才自行亮起。',
        ref: 'ch_0017.md · 第 17.5 段' },
      { dim: 'OOC', severity: 'major', fixed: false, decision: null,
        evidence: '「沈砚没有回头。他知道那是崔十九」',
        suggestion: '第 15 章明确写过沈砚未见过崔十九，此处不应瞬间辨声。建议补一句辨认依据（缺指的脚步声）。',
        ref: 'ch_0017.md · 第 17.4 段' },
      { dim: '视角跳跃', severity: 'minor', fixed: true, decision: 'accept',
        evidence: '17.4 段内由沈砚限知短暂滑向全知',
        suggestion: '已改：删去「他知道这人右手一直按在刀柄上」的旁白式陈述。',
        ref: 'ch_0017.md · 第 17.4 段' },
      { dim: '伏笔遗漏', severity: 'minor', fixed: false, decision: null,
        evidence: 'hook_005「不该有的车辙」已超过建议回收章（第 16 章）',
        suggestion: '可在本章雪夜场景补一笔车辙的呼应，避免悬置过久。',
        ref: 'pending_hooks.jsonl · hook_005' },
      { dim: '文风偏移', severity: 'minor', fixed: false, decision: null,
        evidence: '「尤其是别让文脉司的人看见」',
        suggestion: '口语化偏高。对照 style_profile.json，建议改为「莫叫文脉司瞧见」。',
        ref: 'ch_0017.md · 第 17.6 段' }
    ],
    review: [
      { dim: '设定一致性', score: 72, evidence: '「铜灯须以血引方燃」vs 正文「灯没有点，可灯芯是亮的」', note: '1 处 major 冲突待裁定' },
      { dim: '角色行为',   score: 66, evidence: '「沈砚没有回头。他知道那是崔十九」',                     note: '辨认依据缺失，削弱了可信度' },
      { dim: '节奏',       score: 84, evidence: '17.1 → 17.5 五段内完成勘察到初亮，推进紧凑',              note: '雪夜段可再压两句' },
      { dim: '叙事连贯',   score: 88, evidence: '靴印 → 对质 → 放走，因果链完整',                        note: '' },
      { dim: '伏笔',       score: 79, evidence: 'hook_007 在此第一次显性呼应',                           note: 'hook_005 仍悬置' },
      { dim: '钩子',       score: 91, evidence: '「灯芯那一小截，是亮的」收束本章',                        note: '卷末指向明确' },
      { dim: '审美品质',   score: 81, evidence: '「雪是后半夜落下来的……像有人试图把什么痕迹重新抹平」',   note: '描写质感佳；对话区分度偏弱，崔十九与沈砚语气接近' }
    ],
    diffs: [
      { dim: '设定冲突', before: ['崔十九从怀里取出一只青铜小灯，放在雪地上。', '灯没有点，可沈砚分明看见，灯芯那一小截，是亮的。'],
        after: ['崔十九从怀里取出一只青铜小灯，放在雪地上。', '沈砚割破指尖，血珠落上灯芯。灯芯那一小截，亮了。'] },
      { dim: 'OOC', before: ['「你也在看这个。」身后传来声音。沈砚没有回头。', '他知道那是崔十九，也知道这人右手一直按在刀柄上。'],
        after: ['「你也在看这个。」身后传来声音。沈砚没有回头。', '脚步声很轻，右足落地时少了两分力——是缺了两指的人。他不必回头。'] }
    ]
  };

  /* 文风档案 —— 支撑「文风仿写」 */
  const styleProfile = {
    source: '参考样本《寒江独钓》前 8 章（约 2.4 万字）',
    analyzedAt: '2026-09-24 21:40',
    tokens: 41200,
    sentence: { mean: 21.4, p50: 18, p90: 46, min: 8, max: 78, scale: 80 },
    narrative: { person: '第三人称限知', tense: '过去时', povSwitch: 'rare', anchor: '始终锚定沈砚' },
    ratio: [
      { label: '描写', pct: 46, color: '#2C4A63' },
      { label: '对话', pct: 31, color: '#4F6B4A' },
      { label: '动作', pct: 23, color: '#B0791F' }
    ],
    patterns: [
      '短句收尾成段，制造停顿感',
      '环境描写承托情绪，不直写心理',
      '用器物细节替代形容词',
      '对话不作提示语修饰，靠动作承接'
    ],
    banned: ['不由自主地', '心中一凛', '空气仿佛凝固', '不由自主', '眼中闪过一丝'],
    lexicon: [
      { key: '语气词', value: '极少，全章不超过 2 处' },
      { key: '四字格', value: '克制，回避成语堆叠' },
      { key: '颜色词', value: '低饱和，偏冷（灰、青、白）' }
    ],
    injection: {
      tokens: 740,
      text: '# style_profile.json（确定性必选上下文）\n'
        + 'sentence_length.mean = 21.4   p90 = 46\n'
        + 'narrative = 第三人称限知 / 过去时 / 视角切换罕见\n'
        + 'ratio = 描写 46% · 对话 31% · 动作 23%\n'
        + 'preferred = 短句收尾成段；环境承托情绪；器物替代形容词\n'
        + 'banned = 不由自主地 / 心中一凛 / 空气仿佛凝固 / 眼中闪过一丝'
    },
    sample: {
      plain: '他心中不由自主地一凛，感到空气仿佛凝固了。那盏灯的样子让他想起了很多往事，他的情绪变得非常复杂，几乎无法控制自己的表情。',
      styled: '灯是旧的。柄上有一道缺口，缺口里积着黑垢。他盯着那道缺口，许久没有动。'
    }
  };

  /* ====================== 批次三新增数据 ====================== */

  /* 项目列表 —— 支撑首页 */
  const projects = [
    { id: 'proj_shenyan', title: '雁回关', genre: '古风悬疑', spine: 1, isCurrent: true,
      logline: '一个北境小吏追查失踪案，却发现王朝正在被「文脉」的力量吞噬。',
      chaptersDone: 17, chaptersTotal: 60, words: 86420, mode: 'semi-auto',
      budgetUsed: 12.60, budgetTotal: 80.00, updatedAt: '2026-09-24 22:10',
      hooksResolved: 2, hooksTotal: 8, auditPass: 88 },
    { id: 'proj_tongdeng', title: '铜灯不熄', genre: '玄幻', spine: 2, isCurrent: false,
      logline: '灯燃一次，便有一人从世上被抹去名字。少年守着灯，也守着所有人的记忆。',
      chaptersDone: 42, chaptersTotal: 120, words: 214600, mode: 'auto',
      budgetUsed: 47.30, budgetTotal: 200.00, updatedAt: '2026-09-19 03:41',
      hooksResolved: 11, hooksTotal: 26, auditPass: 94 },
    { id: 'proj_hanjiang', title: '寒江独钓', genre: '武侠', spine: 3, isCurrent: false,
      logline: '退隐的刀客在江边钓了十年鱼，直到那把他丢掉的刀顺流而下，自己漂了回来。',
      chaptersDone: 9, chaptersTotal: 40, words: 43100, mode: 'manual',
      budgetUsed: 6.10, budgetTotal: 60.00, updatedAt: '2026-09-12 19:02',
      hooksResolved: 1, hooksTotal: 7, auditPass: 79 },
    { id: 'proj_wenmai', title: '文脉司残卷', genre: '古风悬疑', spine: 4, isCurrent: false,
      logline: '一部被查禁的残卷，记录着所有被官方删去的名字。抄书人把它抄进了自己的骨头里。',
      chaptersDone: 0, chaptersTotal: 30, words: 0, mode: 'semi-auto',
      budgetUsed: 0, budgetTotal: 60.00, updatedAt: '2026-09-25 08:15',
      hooksResolved: 0, hooksTotal: 0, auditPass: 0 }
  ];

  /* 拆书 —— 支撑导入已有作品反推结构 */
  const disassemble = {
    source: { name: '《寒江独钓》全本.txt', chapters: 40, words: 186400, format: 'txt', size: '742 KB' },
    stages: [
      { key: 'split',  title: '切分章节',       desc: '按标题与空行推断章节边界，识别 40 章', status: 'done' },
      { key: 'roles',  title: '抽取角色与关系', desc: '识别 23 个具名实体，归并同人异名 4 组', status: 'done' },
      { key: 'world',  title: '抽取世界观规则', desc: '提取门派、地理、武力体系与硬约束 17 条', status: 'done' },
      { key: 'hooks',  title: '抽取伏笔与回收', desc: '识别 31 处埋设点，匹配到 24 处回收点', status: 'done' },
      { key: 'style',  title: '生成文风档案',   desc: '句长、视角、描写比例与禁用表达', status: 'active' },
      { key: 'merge',  title: '生成写入提案',   desc: '待你确认后才写入真相文件', status: 'todo' }
    ],
    stats: { chapters: 40, characters: 23, worldRules: 17, hooks: 31, hooksMatched: 24, tokens: 268400 },
    extracted: {
      characters: [
        { name: '江砚舟', role: '主角', traits: ['左手使刀', '不杀无名之辈', '常年戴斗笠'], relations: 6 },
        { name: '秦九娘', role: '女主', traits: ['善用毒', '怕水'], relations: 4 },
        { name: '老渔翁', role: '关键配角', traits: ['哑巴', '识水性'], relations: 3 },
        { name: '白面判官', role: '反派', traits: ['左脸有烙印'], relations: 5 }
      ],
      hooks: [
        { content: '江砚舟丢刀那年的江汛异常提前', plantedChapter: 2, matched: 27, importance: 'major' },
        { content: '秦九娘的毒囊上有官制火漆',     plantedChapter: 8, matched: 33, importance: 'major' },
        { content: '老渔翁的哑，是被割舌而非天生', plantedChapter: 5, matched: null, importance: 'minor' }
      ],
      worldRules: [
        '刀法分「沉、滞、断」三境，断境需以命换',
        '寒江渡口之外，江湖人不许动兵刃',
        '毒分「明毒」「暗毒」，暗毒无色无味但三日必发'
      ],
      style: { sentence: '偏短，均值 19.2 字', pov: '第三人称限知', ratio: '描写 41% · 对话 34% · 动作 25%' }
    },
    proposals: [
      { id: 'p1', kind: '角色', content: '新增角色「江砚舟」，含 3 条不可变特征与 6 条关系', confidence: 'high',   decision: null },
      { id: 'p2', kind: '角色', content: '新增角色「秦九娘」「老渔翁」「白面判官」等 22 个实体', confidence: 'high',   decision: null },
      { id: 'p3', kind: '世界观', content: '写入 17 条硬设定（含武力体系与地理约束）',           confidence: 'medium', decision: null },
      { id: 'p4', kind: '伏笔', content: '写入 31 条伏笔，其中 24 条已匹配到回收章',             confidence: 'high',   decision: null },
      { id: 'p5', kind: '伏笔', content: '「老渔翁的哑」未匹配到回收点，建议标记为 abandoned',   confidence: 'low',    decision: null },
      { id: 'p6', kind: '文风', content: '生成 style_profile.json 并设为必选上下文',              confidence: 'high',   decision: null }
    ]
  };

  /* MCP 扩展 —— 支撑设置页 MCP 面板 */
  const mcpServers = [
    { name: '设定库 setting-vault', transport: 'stdio', command: 'npx -y @dobi/mcp-setting-vault',
      tools: ['lookup_setting', 'list_settings'], enabled: true,  status: 'ok',     latency: 42,  calls: 128 },
    { name: '资料检索 reference-search', transport: 'http', url: 'https://mcp.local/reference/mcp',
      tools: ['search_reference'], enabled: true,  status: 'ok',     latency: 186, calls: 47 },
    { name: '历史存档 archive-local', transport: 'stdio', command: 'node ./mcp/archive.js',
      tools: ['fetch_history'], enabled: false, status: 'idle',   latency: null, calls: 0 },
    { name: '百科拓展 wiki-bridge', transport: 'http', url: 'https://mcp.local/wiki/mcp',
      tools: ['search_reference'], enabled: false, status: 'failed', latency: null, calls: 0,
      error: 'connection refused（上次尝试 2026-09-24 21:02）' }
  ];

  /* ====================== 批次四新增数据 ====================== */

  /* 章节结构（1–20 章，供章节板 / 矩阵 / 情节线共用） */
  const structureChapters = [
    { n: 1,  title: '黑水营的雪',   volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 4620, pov: '沈砚',   intensity: 3 },
    { n: 2,  title: '溃口',         volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 4880, pov: '沈砚',   intensity: 4 },
    { n: 3,  title: '验尸文书',     volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 5010, pov: '沈砚',   intensity: 3 },
    { n: 4,  title: '驿馆火起',     volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 5240, pov: '沈砚',   intensity: 5 },
    { n: 5,  title: '不该有的车辙', volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 4760, pov: '沈砚',   intensity: 2 },
    { n: 6,  title: '副将周崇',     volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 4930, pov: '沈砚',   intensity: 3 },
    { n: 7,  title: '酒肆闲话',     volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 4180, pov: '沈砚',   intensity: 1 },
    { n: 8,  title: '生面孔',       volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 4450, pov: '沈砚',   intensity: 2 },
    { n: 9,  title: '断指',         volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 5120, pov: '崔十九', intensity: 4 },
    { n: 10, title: '空印',         volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 4380, pov: '沈砚',   intensity: 2 },
    { n: 11, title: '夜巡',         volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 4210, pov: '沈砚',   intensity: 2 },
    { n: 12, title: '溃口真相',     volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 5460, pov: '周崇',   intensity: 5 },
    { n: 13, title: '一页之差',     volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 4670, pov: '沈砚',   intensity: 3 },
    { n: 14, title: '灰烬里的名字', volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 4820, pov: '沈砚',   intensity: 4 },
    { n: 15, title: '夜访烛龙巷',   volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 5110, pov: '沈砚',   intensity: 3 },
    { n: 16, title: '副将的靴印',   volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'done',  words: 5360, pov: '沈砚',   intensity: 4 },
    { n: 17, title: '雪落雁回',     volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'audit', words: 5240, pov: '沈砚',   intensity: 5 },
    { n: 18, title: '铜灯不熄',     volume: '第一卷 · 雁回关篇', arc: '雁回关篇', status: 'draft', words: 1180, pov: '沈砚',   intensity: 4 },
    { n: 19, title: '文脉司来人',   volume: '第二卷 · 风起文脉', arc: '风起文脉', status: 'todo',  words: 0,    pov: '沈砚',   intensity: 4 },
    { n: 20, title: '第二枚铜牌',   volume: '第二卷 · 风起文脉', arc: '风起文脉', status: 'todo',  words: 0,    pov: '沈砚',   intensity: 3 }
  ];

  /* 情节线（主线 / 支线）—— 支撑地铁图与结构矩阵 */
  const plotlines = [
    { id: 'pl_m1', name: '追查失踪案',   kind: 'main', color: '#2C4A63',
      summary: '从驿馆火案到雁回关通敌', active: [1,2,3,4,5,6,9,14,15,16,17,18,19,20], peak: [4,17] },
    { id: 'pl_m2', name: '文脉真相',     kind: 'main', color: '#1C3145',
      summary: '文脉与铜灯同源，以「名」为薪', active: [3,7,14,17,18,19,20], peak: [19] },
    { id: 'pl_s1', name: '崔十九的来历', kind: 'sub',  color: '#4F6B4A',
      summary: '断指与师门旧账', active: [8,9,15,17], peak: [9] },
    { id: 'pl_s2', name: '旧友反目',     kind: 'sub',  color: '#B0791F',
      summary: '第 17 章放走 → 后续反水', active: [6,17,18], peak: [17] },
    { id: 'pl_s3', name: '文脉司登场',   kind: 'sub',  color: '#A6392E',
      summary: '三年未收人的秘密', active: [7,17,18,19], peak: [19] },
    { id: 'pl_s4', name: '沈定山之死',   kind: 'sub',  color: '#857D6D',
      summary: '验尸文书缺页', active: [3,13,20], peak: [3] }
  ];

  /* 文风预设（支撑文风选择器）—— 样段是选择的唯一可靠依据 */
  const stylePresets = [
    { id: 'sp_lean', name: '冷峻纪实', tagline: '短句、实感，动作压过内心独白', category: '通用', applied: false,
      sample: '雪停了。他把刀插回鞘里，手指冻得发僵。远处有火光，不大，像是有人在烧什么东西。他没有立刻过去。他先数了数地上的脚印——四双，两进两出。' },
    { id: 'sp_lyrical', name: '长句绵密', tagline: '长句层叠，感官累积，神话式语调', category: '通用', applied: false,
      sample: '雪是后半夜落下来的，一层一层盖住关外的车辙，像是有人执意要把什么痕迹重新抹平，而风偏偏不肯，一遍遍把新雪掀开，露出底下那些不肯安分的旧印子。' },
    { id: 'sp_voice', name: '声腔叙述', tagline: '叙述者有自己的脉搏，冷幽默压着苦事', category: '通用', applied: false,
      sample: '我在关城做了七年小吏，最大的本事是知道什么时候该看不见。这天晚上我看见了不该看的，还得假装没看见——这活儿我熟。' },
    { id: 'sp_mystery', name: '古风悬疑', tagline: '克制的冷笔，线索藏进器物细节', category: '悬疑', applied: false,
      sample: '灯是旧的。柄上有一道缺口，缺口里积着黑垢。他盯着那道缺口，许久没有动。' },
    { id: 'sp_zhiguai', name: '志怪笔记', tagline: '笔记体，志异而不惊怪', category: '志怪', applied: false,
      sample: '北人言铜灯者，多不实。余亲见其一，灯不燃而芯自明，持之者三日内必失一亲。不知其理，记之待考。' },
    { id: 'sp_wuxia', name: '武侠硬派', tagline: '刀法写实，招招见骨，少用虚词', category: '武侠', applied: false,
      sample: '刀从下往上。他没有格，只侧了半步，刀锋擦着肋过去，割开了棉袄。对手收刀时手腕一沉——这是沉境的毛病，改不掉。' },
    { id: 'sp_urban', name: '都市冷感', tagline: '白描都市，情绪藏在动作里', category: '都市', applied: false,
      sample: '地铁到站，他没下。对面的人换了三拨，他还在看那份文件。第十七页的数字他背了下来，但他还是再看了一遍，因为他不信自己。' },
    { id: 'sp_epic', name: '玄幻史诗', tagline: '宏大修辞，力量体系明确，节奏外放', category: '玄幻', applied: false,
      sample: '那一剑落下时，整座雁回关的雪都停了半息。不是风止，是天地先听懂了这一剑的分量，才敢继续落雪。' },
    { id: 'sp_extracted', name: '寒江独钓 · 从样本提取', tagline: '本书当前文风（提取自参考样本前 8 章）', category: '我的', applied: true,
      sample: '退隐的刀客在江边钓了十年鱼。第十一年，那把刀顺流而下，自己漂了回来。他看了很久，然后把它捡起来，插回腰上，没说话。' }
  ];

  /* 文风提取来源（支撑提取入口） */
  const styleSources = [
    { id: 'src_upload', kind: 'file', label: '上传或粘贴参考样本', hint: 'txt / md / docx，建议 ≥ 8000 字；样本越纯，提取越准', checked: true },
    { id: 'src_book_a', kind: 'book', label: '从本书已定稿章节提取', hint: '第 1 – 16 章 · 17 章中 16 章已定稿 · 约 7.8 万字', checked: false },
    { id: 'src_book_b', kind: 'book', label: '从本书指定章节提取',   hint: '可勾选范围；建议避开未审计章节', checked: false },
    { id: 'src_merge',  kind: 'merge', label: '与当前档案合并（保留禁用词）', hint: '合并而非覆盖，适合逐步调教', checked: true }
  ];

  /* 世界观设定（支撑世界观页） */
  const worldSettings = [
    { id: 'w1', category: '器物', kind: 'hard', status: 'conflict',
      rule: '铜灯须以血引方燃',
      refs: [4, 17], note: '与第 17 章正文「灯没有点，可灯芯是亮的」冲突，待裁定' },
    { id: 'w2', category: '体系', kind: 'hard', status: 'ok',
      rule: '文脉以「名」为薪：被抹名者将从所有人的记忆中消失，只余文书上的空缺',
      refs: [3, 19], note: '第 3 章首次暗示，第 19 章将正面展开' },
    { id: 'w3', category: '地理', kind: 'hard', status: 'ok',
      rule: '雁回关以北无城池，只有驿站与烽燧，最远的驿站在冰河对岸',
      refs: [14, 16], note: '' },
    { id: 'w4', category: '组织', kind: 'hard', status: 'ok',
      rule: '文脉司不受兵部节制，可先斩后奏，关将不得阻拦其入境',
      refs: [17, 19], note: '第 17 章借崔十九之口点出' },
    { id: 'w5', category: '历史', kind: 'hard', status: 'ok',
      rule: '二十年前黑水营溃口并非敌军所为，是有人自内开门',
      refs: [2, 12], note: '第 12 章回收' },
    { id: 'w6', category: '器物', kind: 'soft', status: 'ok',
      rule: '铜牌与铜灯同源，纹样为「三足乌」',
      refs: [14], note: '' },
    { id: 'w7', category: '地理', kind: 'soft', status: 'ok',
      rule: '烛龙巷夜禁后只点青灯，不点火把',
      refs: [15], note: '' },
    { id: 'w8', category: '体系', kind: 'soft', status: 'unused',
      rule: '刀法分「沉、滞、断」三境，入断境需以命换',
      refs: [], note: '已写入但尚未在任何章节使用' },
    { id: 'w9', category: '组织', kind: 'soft', status: 'unused',
      rule: '雁回关守军分「关兵」与「屯兵」，关兵不入屯籍',
      refs: [], note: '已写入但尚未在任何章节使用' }
  ];

  /* ====================== 批次五新增数据（章节详情可视化） ====================== */

  /* 内容生产流水线的 8 个环节（典型耗时与 Token，供流程图标注） */
  const pipelineSteps = [
    { key: 'outline', name: '章纲',       hint: '生成本章目标与节拍',            minutes: 1.2, tokens: 3200 },
    { key: 'context', name: '上下文组装', hint: 'Token 预算 + 检索 + 文风注入', minutes: 0.1, tokens: 0 },
    { key: 'draft',   name: '草稿',       hint: '流式生成正文',                minutes: 4.8, tokens: 9600 },
    { key: 'audit',   name: '审计 L1+L2', hint: '13 条规则 + 5 维维度审计',     minutes: 1.6, tokens: 5400 },
    { key: 'review',  name: '可举证评审', hint: '7 维质量评审，须引用原文',      minutes: 1.4, tokens: 4800 },
    { key: 'deai',    name: '去 AI 味',   hint: '定点修复 + 重跑 L1',           minutes: 0.9, tokens: 2600 },
    { key: 'revise',  name: '修订',       hint: 'JSON Patch 定点修复',          minutes: 1.1, tokens: 3400 },
    { key: 'commit',  name: '定稿',       hint: '更新真相文件',                minutes: 0.2, tokens: 900 }
  ];

  /* 情节结构模板（三幕四段） */
  const structureActs = [
    { name: '第一幕 · 建置', from: 1,  to: 6,  note: '交代处境，落定激励事件' },
    { name: '第二幕 · 上升', from: 7,  to: 13, note: '中点转向，代价开始累积' },
    { name: '第二幕 · 崩塌', from: 14, to: 18, note: '转折点二后冲向高潮' },
    { name: '第三幕 · 重启', from: 19, to: 20, note: '第二卷开端，赌注升级' }
  ];

  /* 章节详情：结构节拍 / 场景节拍 / 故事内时间线 / 问题根因（鱼骨） */
  const chapterDetails = {
    1:  { beat: '开场画面', scenes: ['雪夜换防', '冻毙的驿卒', '记下第一个疑点'],
          timeline: [{ at: '二十年前', label: '黑水营溃口', kind: 'flashback' }, { at: '当夜', label: '巡城遇驿卒', kind: 'now' }] },
    2:  { beat: '激励事件', scenes: ['翻查旧档', '质问老驿卒', '溃口记载与实际不符'],
          timeline: [{ at: '二十年前', label: '溃口（真相未揭）', kind: 'flashback' }, { at: '次日', label: '查档', kind: 'now' }] },
    3:  { beat: '激励事件', scenes: ['收到父亲死讯', '验尸文书缺一页', '决定继续查'],
          timeline: [{ at: '十年前', label: '父亲下葬', kind: 'flashback' }, { at: '午后', label: '接收文书', kind: 'now' }] },
    4:  { beat: '第一次尝试', scenes: ['驿馆火起', '灰烬中寻得半枚铜牌', '铜灯首次出现'],
          timeline: [{ at: '黄昏', label: '火起', kind: 'now' }, { at: '入夜', label: '余烬翻找', kind: 'now' }],
          problem: { title: '铜灯首次登场，但缺少代价铺垫', causes: [
            { category: '设定', items: ['铜灯燃法未交代', '铜牌纹样只写一半'] },
            { category: '节奏', items: ['火起到寻获仅两段，场面略仓促'] },
            { category: '角色', items: ['面对大火情绪反应偏淡'] } ] } },
    5:  { beat: '第一次尝试', scenes: ['发现不该有的车辙', '比对雪势', '疑有人夜里出关'],
          timeline: [{ at: '三日前', label: '那场雪', kind: 'flashback' }, { at: '清晨', label: '勘验车辙', kind: 'now' }] },
    6:  { beat: '转折点一', scenes: ['初见周崇', '被警告不要多事', '旧友出现'],
          timeline: [{ at: '正午', label: '中军帐', kind: 'now' }] },
    7:  { beat: '转折点一', scenes: ['酒肆闲话', '得知文脉司三年未收人', '借口离席'],
          timeline: [{ at: '傍晚', label: '酒肆', kind: 'now' }] },
    8:  { beat: '中点', scenes: ['生面孔入城', '暗中跟随', '跟丢'],
          timeline: [{ at: '夜', label: '城门', kind: 'now' }] },
    9:  { beat: '中点', scenes: ['崔十九的断指', '师门旧账', '交换情报'],
          timeline: [{ at: '十二年前', label: '断指之因', kind: 'flashback' }, { at: '夜', label: '烛龙巷外', kind: 'now' }] },
    10: { beat: '中点', scenes: ['调阅空印文书', '同一批人反复出现', '锁定文脉司'],
          timeline: [{ at: '次日', label: '档房', kind: 'now' }] },
    11: { beat: '一切尽失', scenes: ['夜巡遇袭', '证人被杀', '线索断了一半'],
          timeline: [{ at: '子时', label: '遇袭', kind: 'now' }] },
    12: { beat: '一切尽失', scenes: ['周崇视角', '溃口真相', '决定灭口'],
          timeline: [{ at: '二十年前', label: '溃口真凶', kind: 'flashback' }, { at: '夜', label: '中军帐密议', kind: 'now' }],
          problem: { title: '视角切到反派，缺少回切的锚点', causes: [
            { category: '结构', items: ['主线连续两章离开主角视角'] },
            { category: '角色', items: ['周崇动机充分，但沈砚线断开'] },
            { category: '节奏', items: ['强度峰值与前章落差过大'] } ] } },
    13: { beat: '一切尽失', scenes: ['一页之差', '确认父亲之死另有隐情', '不再按规矩来'],
          timeline: [{ at: '清晨', label: '文书比对', kind: 'now' }] },
    14: { beat: '转折点二', scenes: ['灰烬里的名字', '半枚铜牌对上了', '决定设局'],
          timeline: [{ at: '黄昏', label: '灰烬再勘', kind: 'now' }] },
    15: { beat: '转折点二', scenes: ['夜访烛龙巷', '崔十九透露「文脉」二字', '对方随即噤声'],
          timeline: [{ at: '夜禁后', label: '青灯巷口', kind: 'now' }] },
    16: { beat: '高潮', scenes: ['副将的靴印', '量鞋尖弧度', '证据链合上'],
          timeline: [{ at: '后半夜', label: '西门足迹', kind: 'now' }] },
    17: { beat: '高潮', scenes: ['雪夜巡查', '当面对质', '放走旧友', '铜灯初亮'],
          timeline: [{ at: '三日前', label: '驿馆火起', kind: 'flashback' },
                     { at: '后半夜', label: '雪落雁回', kind: 'now' },
                     { at: '黎明前', label: '铜灯初亮', kind: 'now' }],
          problem: { title: '张力够高，但设定与人物一致性存在硬伤', causes: [
            { category: '设定', items: ['铜灯燃法与世界规则冲突', '铜牌纹样未在本章兑现'] },
            { category: '角色', items: ['未见过崔十九却瞬间辨声', '放走旧友缺心理过渡'] },
            { category: '节奏', items: ['对质到放走仅两段，转折过快'] },
            { category: '文风', items: ['「尤其是别让文脉司的人看见」口语化偏高', '「仿佛」6 次，词汇疲劳'] } ] } },
    18: { beat: '收束', scenes: ['夜路上灯自亮', '接文脉司传令', '决定带灯回关'],
          timeline: [{ at: '黎明', label: '回关路上', kind: 'now' }, { at: '三日后', label: '文脉司传令', kind: 'future' }] },
    19: { beat: '第二幕 · 重启', scenes: ['文脉司来人', '验灯', '传召入京'],
          timeline: [{ at: '十日后', label: '入境', kind: 'now' }] },
    20: { beat: '第二幕 · 重启', scenes: ['第二枚铜牌现身', '旧友的下落', '赌注升级'],
          timeline: [{ at: '同月', label: '铜牌再现', kind: 'now' }] }
  };

  return {
    project, chapters, manuscript, modes, characters, hooks, audit,
    chatSeed, chatScript, providers, modelRoles, budgetSplit, usage, rules,
    outlineGraph, auditReport, styleProfile,
    projects, disassemble, mcpServers,
    structureChapters, plotlines, stylePresets, styleSources, worldSettings,
    pipelineSteps, structureActs, chapterDetails
  };
})();
