/* ==========================================================================
   api.js — 原型接口层（stub）
   约定：全部返回 Promise；内部只读 mock.js；不发起任何网络请求。
   真实后端接入时，仅需替换本文件实现，页面调用方式不变。
   ========================================================================== */
window.api = (function () {
  'use strict';
  var M = window.MOCK;

  function delay(data, ms) {
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(JSON.parse(JSON.stringify(data))); }, ms == null ? 320 : ms);
    });
  }

  return {
    /* ---------- 项目 ---------- */
    getProject: function () { return delay(M.project); },

    setMode: function (mode) {
      M.project.mode = mode;
      return delay({ ok: true, mode: mode }, 160);
    },

    /* ---------- 章节 ---------- */
    listChapters: function () { return delay(M.chapters); },

    getManuscript: function (n) { return delay(M.manuscript); },

    /* 生成正文（模拟流式：onChunk 逐段回传） */
    generateChapter: function (n, onChunk) {
      var paras = M.manuscript.paragraphs;
      return new Promise(function (resolve) {
        var i = 0;
        var timer = setInterval(function () {
          if (i >= paras.length) {
            clearInterval(timer);
            resolve({ ok: true, chapter: n });
            return;
          }
          if (onChunk) onChunk(paras[i], i);
          i++;
        }, 300);
      });
    },

    /* ---------- 审计 ---------- */
    getAudit: function (n) { return delay(M.audit); },

    runAudit: function (n) { return delay(M.audit, 900); },

    resolveAuditItem: function (chapter, dim, accepted) {
      var hit = M.audit.items.filter(function (x) { return x.dim === dim; })[0];
      if (hit) hit.fixed = !!accepted;
      return delay({ ok: true, dim: dim, fixed: !!accepted }, 260);
    },

    listRules: function () { return delay(M.rules); },

    /* ---------- 角色 / 伏笔 ---------- */
    listCharacters: function () { return delay(M.characters); },
    listHooks: function () { return delay(M.hooks); },
    listModes: function () { return delay(M.modes); },

    /* ---------- 共创对话 ---------- */
    getChatSeed: function () { return delay(M.chatSeed); },
    getChatScript: function () { return delay(M.chatScript, 220); },

    /* ---------- 设置 ---------- */
    listProviders: function () { return delay(M.providers); },
    listModelRoles: function () { return delay(M.modelRoles); },
    listBudgetSplit: function () { return delay(M.budgetSplit); },
    listUsage: function () { return delay(M.usage); },

    /* ---------- 批次五：章节详情（生产流程 / 场景 / 时间线 / 结构 / 鱼骨） ---------- */
    getPipelineSteps: function () { return delay(M.pipelineSteps); },
    getStructureActs: function () { return delay(M.structureActs); },

    /* 章节详情：done = 已完成步数；active = 进行中步序号（1 起），全部完成则为 null */
    getChapterDetail: function (n) {
      n = Number(n) || 17;
      var ch = M.structureChapters.filter(function (c) { return c.n === n; })[0] || M.structureChapters[0];
      var doneMap = { done: 8, audit: 3, draft: 2, todo: 0 };
      var done = doneMap[ch.status];
      if (done == null) done = 0;
      var total = M.pipelineSteps.length;
      var active = (done >= total) ? null : (done === 0 ? 1 : done + 1);
      var detail = M.chapterDetails[ch.n] || { beat: '—', scenes: [], timeline: [], problem: null };
      var acts = M.structureActs;
      var act = acts.filter(function (a) { return ch.n >= a.from && ch.n <= a.to; })[0] || null;
      return delay({
        chapter: ch,
        detail: detail,
        steps: M.pipelineSteps,
        acts: acts,
        act: act,
        pipeline: { done: done, active: active, total: total }
      });
    },

    /* ---------- 批次四：结构多视图 ---------- */
    getStructure: function () {
      return delay({ chapters: M.structureChapters, plotlines: M.plotlines,
                     volumes: M.outlineGraph.volumes, nodes: M.outlineGraph.nodes,
                     edges: M.outlineGraph.edges, compass: M.outlineGraph.compass });
    },

    getPlotlines: function () { return delay(M.plotlines); },

    /* 章节 × 情节线矩阵 */
    getMatrix: function () {
      var maxCh = 20;
      var rows = M.plotlines.map(function (pl) {
        var cells = [];
        for (var c = 1; c <= maxCh; c++) {
          cells.push({ chapter: c, level: pl.peak.indexOf(c) >= 0 ? 2 : (pl.active.indexOf(c) >= 0 ? 1 : 0) });
        }
        return { id: pl.id, name: pl.name, kind: pl.kind, color: pl.color, cells: cells };
      });
      return delay({ maxChapter: maxCh, rows: rows, chapters: M.structureChapters });
    },

    /* ---------- 批次四：文风预设与提取 ---------- */
    listStylePresets: function () { return delay(M.stylePresets); },

    listStyleCategories: function () {
      var set = [];
      M.stylePresets.forEach(function (p) { if (set.indexOf(p.category) < 0) set.push(p.category); });
      return delay(['全部'].concat(set));
    },

    applyStylePreset: function (id) {
      M.stylePresets.forEach(function (p) { p.applied = (p.id === id); });
      var hit = M.stylePresets.filter(function (p) { return p.id === id; })[0];
      if (hit) {
        M.styleProfile.source = hit.name + '（预设）';
        M.styleProfile.analyzedAt = '刚刚';
      }
      return delay({ ok: true, id: id, name: hit ? hit.name : '' }, 420);
    },

    listStyleSources: function () { return delay(M.styleSources); },

    /* 从选中的来源提取文风（模拟） */
    extractStyle: function (sourceIds) {
      M.styleProfile.source = '从本书已定稿章节提取（第 1 – 16 章）';
      M.styleProfile.analyzedAt = '刚刚';
      return delay({ ok: true, sources: sourceIds, tokens: 96400 }, 1200);
    },

    /* ---------- 批次四：世界观 ---------- */
    listWorldSettings: function () { return delay(M.worldSettings); },

    worldCategories: function () {
      var set = [];
      M.worldSettings.forEach(function (w) { if (set.indexOf(w.category) < 0) set.push(w.category); });
      return delay(['全部'].concat(set));
    },

    setWorldRuleKind: function (id, kind) {
      var hit = M.worldSettings.filter(function (w) { return w.id === id; })[0];
      if (hit) hit.kind = kind;
      return delay({ ok: true, id: id, kind: kind }, 220);
    },

    /* 解决冲突：保留正文并改写规则 */
    resolveWorldConflict: function (id, resolution) {
      var hit = M.worldSettings.filter(function (w) { return w.id === id; })[0];
      if (hit) {
        hit.status = 'ok';
        if (resolution === 'keep_text') {
          hit.rule = '铜灯可自行燃起，但每燃一次，持灯者会失去一段记忆';
          hit.note = '已按正文改写规则（原规则：铜灯须以血引方燃）';
        } else {
          hit.note = '已按规则修改正文（第 17 章第 17.5 段）';
        }
      }
      return delay({ ok: true, id: id, resolution: resolution }, 320);
    },

    /* ---------- 批次三：项目列表 ---------- */
    listProjects: function () { return delay(M.projects); },

    createProject: function (title) {
      M.projects.unshift({
        id: 'proj_new_' + Date.now(), title: title || '未命名作品', genre: '待定', spine: 4, isCurrent: false,
        logline: '（尚未确立）', chaptersDone: 0, chaptersTotal: 40, words: 0, mode: 'semi-auto',
        budgetUsed: 0, budgetTotal: 60.00, updatedAt: '刚刚',
        hooksResolved: 0, hooksTotal: 0, auditPass: 0
      });
      return delay(M.projects, 500);
    },

    /* ---------- 批次三：拆书 ---------- */
    getDisassemble: function () { return delay(M.disassemble); },

    /* 执行拆书（模拟：推进流水线阶段） */
    runDisassemble: function () {
      var order = ['split', 'roles', 'world', 'hooks', 'style', 'merge'];
      var cur = M.disassemble.stages.filter(function (s) { return s.status !== 'done'; })[0];
      if (cur) {
        M.disassemble.stages.forEach(function (s) {
          if (s.key === cur.key) s.status = 'done';
        });
        var idx = order.indexOf(cur.key);
        if (idx >= 0 && idx + 1 < order.length) {
          M.disassemble.stages.forEach(function (s) {
            if (s.key === order[idx + 1]) s.status = 'active';
          });
        }
      }
      return delay(M.disassemble, 1000);
    },

    /* 对拆书提案做决策：accept / reject / null */
    decideProposal: function (id, action) {
      var hit = M.disassemble.proposals.filter(function (x) { return x.id === id; })[0];
      if (hit) hit.decision = action;
      return delay({ ok: true, id: id, action: action }, 240);
    },

    /* ---------- 批次三：MCP 扩展 ---------- */
    listMcpServers: function () { return delay(M.mcpServers); },

    toggleMcp: function (name) {
      var hit = M.mcpServers.filter(function (x) { return x.name.indexOf(name) === 0 || x.name === name; })[0];
      if (hit) {
        hit.enabled = !hit.enabled;
        hit.status = hit.enabled ? (hit.status === 'failed' ? 'ok' : hit.status) : 'idle';
      }
      return delay({ ok: true, servers: M.mcpServers }, 220);
    },

    testMcp: function (name) {
      return delay({ ok: true, name: name, latency: 60 + Math.floor(Math.random() * 180) }, 800);
    },

    /* ---------- 批次二：章纲与依赖图 ---------- */
    getCompass: function () { return delay(M.outlineGraph.compass); },

    getOutlineGraph: function () {
      return delay({ compass: M.outlineGraph.compass, volumes: M.outlineGraph.volumes,
                     nodes: M.outlineGraph.nodes, edges: M.outlineGraph.edges });
    },

    /* 刷新罗盘（模拟建筑师更新终局方向） */
    refreshCompass: function () {
      M.outlineGraph.compass.refreshAt = '第 1 卷末刷新（刚刚）';
      return delay(M.outlineGraph.compass, 900);
    },

    /* ---------- 批次二：审计报告 ---------- */
    getAuditReport: function () { return delay(M.auditReport); },

    runFullAudit: function () {
      M.auditReport.stats.passRate = 88;
      return delay(M.auditReport, 1000);
    },

    /* 对某条发现做出决策：accept（接受修订）/ ignore（忽略）/ null（撤回） */
    decideFinding: function (dim, action) {
      var hit = M.auditReport.findings.filter(function (x) { return x.dim === dim; })[0];
      if (hit) {
        hit.decision = action;
        hit.fixed = action === 'accept';
      }
      M.auditReport.stats.open = M.auditReport.findings.filter(function (x) { return !x.fixed; }).length;
      M.auditReport.stats.fixed = M.auditReport.findings.filter(function (x) { return x.fixed; }).length;
      return delay({ ok: true, dim: dim, action: action,
                     open: M.auditReport.stats.open, fixed: M.auditReport.stats.fixed }, 260);
    },

    /* ---------- 批次二：文风档案 ---------- */
    getStyleProfile: function () { return delay(M.styleProfile); },

    /* 重新分析样本（模拟） */
    analyzeStyle: function () {
      M.styleProfile.analyzedAt = '刚刚';
      return delay(M.styleProfile, 1100);
    },

    addBanned: function (expr) {
      var t = String(expr || '').trim();
      if (t && M.styleProfile.banned.indexOf(t) < 0) M.styleProfile.banned.push(t);
      return delay(M.styleProfile.banned, 200);
    },

    removeBanned: function (expr) {
      M.styleProfile.banned = M.styleProfile.banned.filter(function (x) { return x !== expr; });
      return delay(M.styleProfile.banned, 200);
    },

    /* ---------- 派生统计 ---------- */
    hookStats: function () {
      var planted = M.hooks.filter(function (x) { return x.status === 'planted'; }).length;
      var resolved = M.hooks.filter(function (x) { return x.status === 'resolved'; }).length;
      var overdue = M.hooks.filter(function (x) { return x.status === 'overdue'; }).length;
      var total = M.hooks.length;
      return delay({ planted: planted, resolved: resolved, overdue: overdue, total: total, rate: Math.round(resolved / total * 100) });
    }
  };
})();
