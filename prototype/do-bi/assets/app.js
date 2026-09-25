/* ==========================================================================
   app.js — 通用行为（数据驱动，页面只需加 data-* 属性）
   1) 导航高亮：body[data-page] → [data-nav] 加 .active
   2) 载入错落浮现：[data-reveal] 按文档顺序自动加 .reveal + 延迟
   3) 选项卡：[data-tabs] 内 .tab[data-tab] ↔ .tabpanel[data-panel]
   4) 分段控件：[data-seg] 内 button[data-value] → 派发 seg:change
   5) 模态：[data-open-modal="id"] / [data-close-modal]
   6) 工具：App.$ App.$$ App.h App.fmtInt App.fmtMoney App.loading App.toast
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- 1) 导航高亮（唯一机制） ---------- */
  function markNav() {
    var page = document.body.dataset.page;
    if (!page) return;
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      a.classList.toggle('active', a.dataset.nav === page);
    });
  }

  /* ---------- 2) 载入错落浮现 ---------- */
  function stagger() {
    var nodes = document.querySelectorAll('[data-reveal]');
    nodes.forEach(function (n, i) {
      n.classList.add('reveal', 'reveal-' + ((i % 6) + 1));
    });
  }

  /* ---------- 3) 选项卡 ---------- */
  /* 面板可能不在 [data-tabs] 的直接子级，故向上寻找最近的、真正包含 .tabpanel 的祖先 */
  function panelRoot(scope) {
    var n = scope.parentNode;
    while (n && n !== document.body) {
      if (n.querySelector('.tabpanel[data-panel]')) return n;
      n = n.parentNode;
    }
    return document;
  }

  function initTabs() {
    document.querySelectorAll('[data-tabs]').forEach(function (scope) {
      var tabs = scope.querySelectorAll('.tab[data-tab]');
      var panels = panelRoot(scope).querySelectorAll('.tabpanel[data-panel]');
      tabs.forEach(function (t) {
        t.addEventListener('click', function () {
          tabs.forEach(function (x) { x.classList.remove('active'); });
          t.classList.add('active');
          panels.forEach(function (p) {
            p.classList.toggle('active', p.dataset.panel === t.dataset.tab);
          });
        });
      });
    });
  }

  /* ---------- 4) 分段控件 ---------- */
  /* 用事件委托，使页面载入后「动态注入」的 .seg 按钮同样生效 */
  function initSegs() {
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-seg] button[data-value]') : null;
      if (!b) return;
      var group = b.closest('[data-seg]');
      if (!group || b.classList.contains('active')) return;
      group.querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      group.dispatchEvent(new CustomEvent('seg:change', {
        bubbles: true,
        detail: { value: b.dataset.value, group: group.dataset.seg }
      }));
    });
  }

  /* ---------- 5) 模态 ---------- */
  function initModals() {
    document.querySelectorAll('[data-open-modal]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var m = document.getElementById(btn.dataset.openModal);
        if (m) m.hidden = false;
      });
    });
    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) {
        if (e.target.closest('[data-close-modal]') || e.target.classList.contains('modal-veil')) {
          m.hidden = true;
        }
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal').forEach(function (m) { m.hidden = true; });
      }
    });
  }

  /* ---------- 6) 工具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function h(tag, attrs, html) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else el.setAttribute(k, attrs[k]);
    });
    if (html != null) el.innerHTML = html;
    return el;
  }

  function fmtInt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function fmtMoney(n, unit) { return (unit || '¥') + Number(n).toFixed(2); }

  function loading(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset._t = btn.textContent;
      btn.disabled = true;
      btn.textContent = label || '处理中…';
    } else {
      btn.disabled = false;
      if (btn.dataset._t) btn.textContent = btn.dataset._t;
    }
  }

  function toast(msg) {
    var t = h('div', {
      class: 'card card-pad fs-13',
      style: 'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:90;box-shadow:var(--sh-lg);background:var(--paper);'
    });
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1800);
  }

  window.App = {
    $: $, $$: $$, h: h, fmtInt: fmtInt, fmtMoney: fmtMoney,
    loading: loading, toast: toast, markNav: markNav
  };

  document.addEventListener('DOMContentLoaded', function () {
    markNav();
    stagger();
    initTabs();
    initSegs();
    initModals();
  });
})();
