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
