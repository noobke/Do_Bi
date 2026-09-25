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
    { name: '伏笔超期未回收', hit: 1 }, { name: '数值设定矛盾', hit: 0 },
    { name: '词汇疲劳', hit: 2 }
  ];

  /* ---------- 去 AI 味报告 ---------- */
  const aigcReport = {
    chapter: 17,
    deterministicRules: [
      { rule: '套话密度', hits: 1, samples: ['极其', '不由得'] },
      { rule: '连续「了」字句', hits: 1, samples: ['他看了看，又走了走'] },
      { rule: '词汇疲劳', hits: 2, samples: ['雪（本章 14 次）', '冷冷地（本章 5 次）'] }
    ],
    externalDetector: { provider: '未启用', score: null },
    spotfixApplied: 1
  };

  /* ---------- 文风档案 ---------- */
  const styleProfile = {
    source: '参考样例 · 3 章 · 共 18,400 字',
    hash: 'sfp_9c21',
    updatedAt: '2026-09-23',
    sentence: { avgLength: 22, shortRatio: 0.41, variance: '中' },
    lexicon: { preferred: ['雪', '关', '灯', '灰'], banned: ['极其', '瞬间', '不禁'], register: '冷峻书面' },
    dialogue: { ratio: 0.18, tagStyle: '极少标签，动作代引' },
    narrative: { pov: '第三人称限知', tense: '过去', descriptionRatio: 0.34 },
    genreRules: [
      { genre: '古风悬疑', enabled: true,  note: '禁用现代词汇；对话不带引号标签；环境描写占比 30%–40%' },
      { genre: '玄幻',     enabled: false, note: '境界体系须与账本数值一致；战斗段落节奏密度提高' },
      { genre: '仙侠',     enabled: false, note: '避免现代科技词；道法描写需成体系' },
      { genre: '都市',     enabled: false, note: '口语化对话；场景切换需时间锚点' }
    ]
  };

  /* ---------- 大纲 / 依赖图 / 思维链 ---------- */
  const outline = {
    project: '雁回关',
    volumes: [
      { id: 'vol_1', title: '第一卷 · 雪落雁回', status: 'writing', chapters: '1–20', progress: 85 },
      { id: 'vol_2', title: '第二卷 · 文脉司来人', status: 'skeleton', chapters: '21–36', progress: 0 },
      { id: 'vol_3', title: '第三卷 · 铜牌合流', status: 'skeleton', chapters: '37–48', progress: 0 }
    ],
    arcs: [
      { id: 'arc_1', title: '雁回关失踪案', goal: '沈砚查清驿馆失踪案', est: 8, status: 'done' },
      { id: 'arc_2', title: '铜灯与文脉', goal: '让铜灯线索浮出水面', est: 12, status: 'writing' },
      { id: 'arc_3', title: '文脉司对峙', goal: '与文脉司正面冲突', est: 16, status: 'skeleton' }
    ],
    nodes: [
      { id: 'ch_015', label: '15 夜访烛龙巷', kind: 'chapter', status: 'done' },
      { id: 'ch_016', label: '16 副将的靴印', kind: 'chapter', status: 'done' },
      { id: 'ch_017', label: '17 雪落雁回',   kind: 'chapter', status: 'audit' },
      { id: 'ch_018', label: '18 铜灯不熄',   kind: 'chapter', status: 'draft' },
      { id: 'ch_019', label: '19 文脉司来人', kind: 'chapter', status: 'todo' },
      { id: 'hook_007', label: 'H7 铜灯未熄', kind: 'hook', status: 'planted' },
      { id: 'hook_011', label: 'H11 半枚铜牌', kind: 'hook', status: 'planted' },
      { id: 'hook_004', label: 'H4 验尸文书', kind: 'hook', status: 'planted' }
    ],
    edges: [
      { from: 'ch_015', to: 'ch_016', kind: 'causality' },
      { from: 'ch_016', to: 'ch_017', kind: 'causality' },
      { from: 'ch_017', to: 'ch_018', kind: 'causality' },
      { from: 'hook_007', to: 'ch_018', kind: 'payoff' },
      { from: 'ch_018', to: 'hook_011', kind: 'setup' },
      { from: 'hook_004', to: 'ch_019', kind: 'payoff' },
      { from: 'ch_019', to: 'ch_017', kind: 'subplot' }
    ],
    compass: {
      endgame: '沈砚查明父亲死因，揭穿文脉司以「文脉」吞噬北境的真相',
      longLines: ['父亲的死因（hook_004）', '铜灯与铜牌的来源（hook_007 / hook_011）', '崔十九的真实立场（hook_009）'],
      scale: '预计 60 章 · 约 30 万字',
      refreshedAt: '第 20 章边界'
    },
    reasoning: [
      { step: 1, note: '先让铜灯亮起（呼应 hook_007），再引出文脉司', decision: '把铜灯作为卷一收束的钩子' },
      { step: 2, note: '第 19 章让文脉司正式登场，与周崇线合流', decision: '反派升级节奏放在卷边界后' },
      { step: 3, note: '第 20 章安排第二枚铜牌，与 hook_011 合流', decision: '避免支线长期悬空' }
    ]
  };

  /* ---------- MCP 服务器 ---------- */
  const mcpServers = [
    { name: '史料检索', transport: 'stdio', command: 'mcp-history', enabled: true,  readonly: true,
      tools: ['search_historical_records', 'get_era_customs', 'verify_title'] },
    { name: '地理词条', transport: 'stdio', command: 'mcp-geo',     enabled: true,  readonly: true,
      tools: ['lookup_place', 'distance_between'] },
    { name: '时间线校验器', transport: 'sse', url: 'http://127.0.0.1:8731/sse', enabled: false, readonly: true,
      tools: ['validate_timeline'] }
  ];

  /* ---------- 实时干预示例 ---------- */
  const steerSamples = [
    '这一章节奏太慢，把追查部分压缩到三段以内',
    '把周崇的反应写得更克制，不要直接摊牌',
    '雪景描写太多，删掉一半'
  ];

  return {
    project, chapters, manuscript, modes, characters, hooks, audit,
    chatSeed, chatScript, providers, modelRoles, budgetSplit, usage, rules,
    aigcReport, styleProfile, outline, mcpServers, steerSamples
  };
})();
