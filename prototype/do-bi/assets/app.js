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
  /* 子页归属：章节详情属于「结构」，拆书属于「我的作品」——否则子页进入后侧栏没有任何高亮 */
  var NAV_PARENT = { chapter: 'outline', disassemble: 'projects' };

  function markNav() {
    var page = document.body.dataset.page;
    if (!page) return;
    var target = NAV_PARENT[page] || page;
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      var on = a.dataset.nav === target;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
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

  /* 保存 innerHTML 而非 textContent —— 否则带图标的按钮在 loading 结束后图标永久丢失 */
  function loading(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset._html = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = label || '处理中…';
    } else {
      btn.disabled = false;
      if (btn.dataset._html) btn.innerHTML = btn.dataset._html;
    }
  }

  /* 把任意元素变成可键盘操作的按钮：补 role/tabindex、Enter/Space 触发、统一焦点环。
     role 传 false 表示「只补键盘能力，不覆盖原生语义」——用于 <tr> 这类已有隐式角色的元素。 */
  function clickable(el, handler, role) {
    if (!el) return el;
    if (role !== false) el.setAttribute('role', role || 'button');
    el.tabIndex = 0;
    el.addEventListener('click', handler);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        handler.call(el, e);
      }
    });
    return el;
  }

  /* type: 'ok' | 'warn' | 'error' | 省略（中性）。容器带 role="status"，读屏可播报 */
  function toast(msg, type) {
    var t = h('div', {
      class: 'card card-pad fs-13' + (type ? ' toast-' + type : ''),
      role: 'status',
      'aria-live': type === 'error' ? 'assertive' : 'polite',
      style: 'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:90;box-shadow:var(--sh-lg);background:var(--paper);'
    });
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1800);
  }

  /* 统一的失败兜底：把「加载失败 + 重试」渲染进容器，重试时重新调用 retry() */
  function fail(container, err, retry) {
    var box = typeof container === 'string' ? document.querySelector(container) : container;
    if (!box) return;
    box.innerHTML =
      '<div class="empty state-error">' +
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>' +
        '<span class="fs-13">加载失败' + (err && err.message ? '：' + err.message : '') + '</span>' +
        '<span class="fs-12 muted">这一块没能拿到数据，可重试；其余内容不受影响</span>' +
      '</div>';
    var btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.type = 'button';
    btn.textContent = '重试';
    btn.addEventListener('click', function () {
      box.innerHTML = '';
      retry();
    });
    box.querySelector('.state-error').appendChild(btn);
    return box;
  }

  window.App = {
    $: $, $$: $$, h: h, fmtInt: fmtInt, fmtMoney: fmtMoney,
    loading: loading, toast: toast, markNav: markNav, clickable: clickable, fail: fail
  };

  document.addEventListener('DOMContentLoaded', function () {
    markNav();
    stagger();
    initTabs();
    initSegs();
    initModals();
  });
})();
