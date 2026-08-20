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

  // ---- Universal Confirm Dialog -------------------------------------------

  function confirmDialog(options) {
    return new Promise(function (resolve) {
      if (typeof options === 'string') {
        options = { message: options };
      }
      options = options || {};
      var title = options.title || 'Confirm action';
      var message = options.message || 'Are you sure you want to proceed?';
      var confirmText = options.confirmText || (options.danger !== false ? 'Delete' : 'Confirm');
      var cancelText = options.cancelText || 'Cancel';
      var isDanger = options.danger !== false;
      var requireMatch = options.requireInputMatch ? String(options.requireInputMatch).trim() : null;

      var overlay = document.createElement('div');
      overlay.className =
        'fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 opacity-0 transition-opacity duration-200';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');

      var card = document.createElement('div');
      card.className =
        'app-card w-full max-w-lg overflow-hidden shadow-2xl border border-base-300 transform scale-95 transition-transform duration-200';

      var badgeColor = isDanger ? 'bg-error/10 text-error border-error/20' : 'bg-warning/10 text-warning border-warning/20';
      var confirmBtnClass = isDanger ? 'btn-error text-white' : 'btn-primary';

      var itemHtml = '';
      if (options.item) {
        var itemTypeLabel = options.itemType ? escapeHtml(options.itemType) + ': ' : '';
        itemHtml =
          '<div class="mb-3.5 flex items-center gap-2 rounded-xl border border-base-300 bg-base-200/60 px-3.5 py-2.5">' +
          '<span class="text-xs font-semibold uppercase tracking-wider text-base-content/50">' + itemTypeLabel + '</span>' +
          '<span class="font-mono text-sm font-bold text-base-content break-all">' + escapeHtml(options.item) + '</span>' +
          '</div>';
      }

      var inputMatchHtml = '';
      if (requireMatch) {
        inputMatchHtml =
          '<div class="mt-4 space-y-1.5">' +
          '<label class="text-xs font-medium text-base-content/70">To confirm, type <span class="font-mono font-bold text-base-content select-all">' + escapeHtml(requireMatch) + '</span> below:</label>' +
          '<input type="text" class="field-input font-mono js-confirm-input" placeholder="' + escapeHtml(options.requireInputPlaceholder || requireMatch) + '" autocomplete="off" spellcheck="false" />' +
          '</div>';
      }

      var detailsHtml = options.detailsHtml ? '<div class="mt-3.5 max-h-48 overflow-y-auto rounded-xl border border-base-200 bg-base-200/40 p-3 text-xs leading-relaxed text-base-content/75">' + options.detailsHtml + '</div>' : '';

      card.innerHTML =
        '<div class="flex items-start justify-between gap-3 border-b border-base-200 px-6 py-4">' +
        '  <div class="flex items-center gap-3">' +
        '    <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl border ' + badgeColor + '">' +
        (isDanger ? ICONS.warning : ICONS.info) +
        '    </div>' +
        '    <div>' +
        '      <h3 class="text-base font-bold text-base-content">' + escapeHtml(title) + '</h3>' +
        '      <p class="text-xs text-base-content/50 font-medium">' + (isDanger ? 'Destructive Action' : 'Action Confirmation') + '</p>' +
        '    </div>' +
        '  </div>' +
        '  <button type="button" class="btn btn-ghost btn-xs btn-circle js-modal-cancel text-base-content/40 hover:text-base-content" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="px-6 py-5">' +
        itemHtml +
        '  <p class="text-sm text-base-content/80 leading-relaxed">' + escapeHtml(message) + '</p>' +
        detailsHtml +
        inputMatchHtml +
        '</div>' +
        '<div class="flex flex-wrap items-center justify-end gap-2.5 border-t border-base-200 bg-base-200/30 px-6 py-4">' +
        '  <button type="button" class="btn btn-ghost btn-sm js-modal-cancel">' + escapeHtml(cancelText) + '</button>' +
        '  <button type="button" class="btn ' + confirmBtnClass + ' btn-sm js-modal-confirm" ' + (requireMatch ? 'disabled' : '') + '>' + escapeHtml(confirmText) + '</button>' +
        '</div>';

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      requestAnimationFrame(function () {
        overlay.classList.remove('opacity-0');
        overlay.classList.add('opacity-100');
        card.classList.remove('scale-95');
        card.classList.add('scale-100');
      });

      var confirmBtn = card.querySelector('.js-modal-confirm');
      var cancelBtns = card.querySelectorAll('.js-modal-cancel');
      var inputEl = card.querySelector('.js-confirm-input');

      if (inputEl) {
        inputEl.addEventListener('input', function () {
          var val = inputEl.value.trim();
          confirmBtn.disabled = val !== requireMatch;
        });
        inputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !confirmBtn.disabled) {
            e.preventDefault();
            finish(true);
          }
        });
        setTimeout(function () { inputEl.focus(); }, 50);
      } else {
        var cancelBtn = card.querySelector('.js-modal-cancel');
        if (cancelBtn) setTimeout(function () { cancelBtn.focus(); }, 50);
      }

      var finished = false;
      function finish(result) {
        if (finished) return;
        finished = true;
        document.removeEventListener('keydown', onKeyDown);
        overlay.classList.remove('opacity-100');
        overlay.classList.add('opacity-0');
        card.classList.remove('scale-100');
        card.classList.add('scale-95');
        setTimeout(function () {
          overlay.remove();
          resolve(result);
        }, 180);
      }

      function onKeyDown(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }
      document.addEventListener('keydown', onKeyDown);

      cancelBtns.forEach(function (btn) {
        btn.addEventListener('click', function () { finish(false); });
      });

      confirmBtn.addEventListener('click', function () {
        if (!confirmBtn.disabled) finish(true);
      });

      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) finish(false);
      });
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
    confirm: confirmDialog,
    applyTheme: applyTheme,
  };
})();
