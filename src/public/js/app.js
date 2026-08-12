/* Shared UI helpers: HTML escaping, toasts, theme toggle, sidebar filtering. */
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var ICONS = {
    error:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>',
    success:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>',
    info:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>',
    warning:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>',
    sun:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>',
    moon:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>',
  };

  var PALETTES = {
    error: 'border-error/40 bg-error/10 text-error',
    success: 'border-success/40 bg-success/10 text-success',
    info: 'border-info/40 bg-info/10 text-info',
    warning: 'border-warning/40 bg-warning/10 text-warning',
  };

  function showToast(message, type) {
    var container = document.getElementById('toast-container');
    if (!container) return;
    type = type || 'info';
    var el = document.createElement('div');
    el.className =
      'toast-item pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-base-100 px-4 py-3 shadow-lift ' +
      (PALETTES[type] || PALETTES.info);
    el.innerHTML =
      '<span class="mt-0.5 shrink-0">' + (ICONS[type] || ICONS.info) + '</span>' +
      '<span class="flex-1 text-sm font-medium text-base-content">' + escapeHtml(message) + '</span>' +
      '<button type="button" class="toast-close mt-0.5 shrink-0 text-base-content/40 transition-colors hover:text-base-content" aria-label="Dismiss">&times;</button>';
    container.appendChild(el);

    var remove = function () {
      el.style.transition = 'opacity .18s ease, transform .18s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-6px) scale(0.98)';
      setTimeout(function () { el.remove(); }, 180);
    };
    el.querySelector('.toast-close').addEventListener('click', remove);
    setTimeout(remove, 4200);
  }

  // ---- Theme -------------------------------------------------------------

  function applyTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'admindbDark' : 'admindb');
    try {
      localStorage.setItem('admindb-theme', dark ? 'dark' : 'light');
    } catch (e) { /* ignore */ }
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.innerHTML = dark ? ICONS.sun : ICONS.moon;
  }

  function initTheme() {
    var stored = null;
    try {
      stored = localStorage.getItem('admindb-theme');
    } catch (e) { /* ignore */ }
    var dark = stored === 'dark' ||
      (!stored && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    applyTheme(dark);
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', function () {
        var current = document.documentElement.getAttribute('data-theme') === 'admindbDark';
        applyTheme(!current);
      });
    }
  }

  // ---- Sidebar table filter ----------------------------------------------

  function initTableFilter() {
    var input = document.getElementById('table-search');
    var list = document.getElementById('table-list');
    var countEl = document.getElementById('table-count');
    if (!input || !list) return;
    var items = Array.prototype.slice.call(list.querySelectorAll('.table-item'));
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      items.forEach(function (item) {
        var name = (item.getAttribute('data-name') || '').toLowerCase();
        var show = !q || name.indexOf(q) !== -1;
        item.style.display = show ? '' : 'none';
        if (show) shown += 1;
      });
      if (countEl) countEl.textContent = String(shown);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    initTableFilter();
  });

  window.UI = {
    escapeHtml: escapeHtml,
    showToast: showToast,
    showError: function (message) { showToast(message, 'error'); },
    applyTheme: applyTheme,
  };
})();
