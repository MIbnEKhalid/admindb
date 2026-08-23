/* Home page — Bulk table operations (select, drop, truncate).
 * Runs only in write mode (the script tag is inside {{#unless readonly}}).
 */
(function () {
  'use strict';

  // ---- Helpers ----
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- DOM refs ----
  var toolbar      = document.getElementById('home-bulk-toolbar');
  var countNumEl   = document.getElementById('home-bulk-count-num');
  var selectAllChk = document.getElementById('home-select-all');
  var deselectBtn  = document.getElementById('home-bulk-deselect');

  var clearNormalBtn = document.getElementById('home-clear-normal');
  var clearForceBtn  = document.getElementById('home-clear-force');
  var dropNormalBtn  = document.getElementById('home-drop-normal');
  var dropForceBtn   = document.getElementById('home-drop-force');

  if (!toolbar || !selectAllChk) return; // No tables or readonly — nothing to do.

  var checkboxes = Array.prototype.slice.call(
    document.querySelectorAll('.home-table-checkbox')
  );

  // ---- Selection state ----
  function getSelected() {
    return checkboxes.filter(function (c) { return c.checked; }).map(function (c) { return c.dataset.table; });
  }

  function syncToolbar() {
    var selected = getSelected();
    var n = selected.length;

    // Update count badge
    if (countNumEl) countNumEl.textContent = String(n);

    // Animate toolbar in / out
    if (n > 0) {
      // 1. Start the slide-in with overflow:hidden so the height animates cleanly
      toolbar.style.overflow = 'hidden';
      toolbar.style.maxHeight = toolbar.scrollHeight + 80 + 'px';
      toolbar.style.opacity = '1';
      toolbar.setAttribute('aria-hidden', 'false');
      // 2. After the transition finishes, switch to overflow:visible so DaisyUI
      //    dropdown menus aren't clipped by the toolbar container.
      clearTimeout(toolbar._overflowTimer);
      toolbar._overflowTimer = setTimeout(function () {
        if (getSelected().length > 0) {
          toolbar.style.overflow = 'visible';
          toolbar.style.maxHeight = 'none';
        }
      }, 250); // matches transition duration
    } else {
      // Collapse: restore overflow:hidden first, then animate height to 0
      clearTimeout(toolbar._overflowTimer);
      toolbar.style.overflow = 'hidden';
      toolbar.style.maxHeight = toolbar.scrollHeight + 'px'; // pin current height
      // Force a reflow so the browser registers the pinned height before collapsing
      void toolbar.offsetHeight;
      toolbar.style.maxHeight = '0';
      toolbar.style.opacity = '0';
      toolbar.setAttribute('aria-hidden', 'true');
    }

    // Sync "select all" checkbox indeterminate state
    if (selectAllChk) {
      if (n === 0) {
        selectAllChk.checked = false;
        selectAllChk.indeterminate = false;
      } else if (n === checkboxes.length) {
        selectAllChk.checked = true;
        selectAllChk.indeterminate = false;
      } else {
        selectAllChk.checked = false;
        selectAllChk.indeterminate = true;
      }
    }

    // Highlight selected rows
    checkboxes.forEach(function (c) {
      var row = c.closest('tr');
      if (!row) return;
      if (c.checked) {
        row.classList.add('bg-primary/5');
      } else {
        row.classList.remove('bg-primary/5');
      }
    });
  }

  // ---- Wire checkboxes ----
  checkboxes.forEach(function (c) {
    c.addEventListener('change', syncToolbar);
  });

  selectAllChk.addEventListener('change', function () {
    var checked = selectAllChk.checked;
    checkboxes.forEach(function (c) { c.checked = checked; });
    syncToolbar();
  });

  deselectBtn && deselectBtn.addEventListener('click', function () {
    checkboxes.forEach(function (c) { c.checked = false; });
    syncToolbar();
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', function (e) {
    document.querySelectorAll('#home-dd-clear, #home-dd-drop').forEach(function (dd) {
      if (!dd.contains(e.target)) {
        var ul = dd.querySelector('ul');
        if (ul) ul.removeAttribute('tabindex'); // DaisyUI closes on blur; this forces it
      }
    });
  });

  // ---- Reload after success ----
  function reloadPage() {
    window.location.reload();
  }

  // ---- Build details HTML for confirm dialog ----
  function buildTableListHtml(tables) {
    return tables.map(function (t) {
      return '<span class="inline-flex items-center gap-1 font-mono text-[12px] bg-base-200 rounded px-1.5 py-0.5 mb-1 mr-1">' + esc(t) + '</span>';
    }).join('');
  }

  // ---- Show result summary toast ----
  function showResultToast(type, verb, succeeded, failed) {
    if (window.UI && UI.showToast) {
      if (succeeded.length > 0) {
        UI.showToast(
          verb + ' ' + succeeded.length + ' table' + (succeeded.length !== 1 ? 's' : '') + '.',
          'success'
        );
      }
      if (failed.length > 0) {
        UI.showToast(
          failed.length + ' table' + (failed.length !== 1 ? 's' : '') + ' failed: ' +
          failed.map(function (f) { return f.table + ' — ' + f.error; }).join('; '),
          'error'
        );
      }
    }
  }

  // ---- API call wrapper ----
  async function callBulkApi(endpoint, tables, force) {
    try {
      return await Api.post(endpoint, { tables: tables, force: force });
    } catch (err) {
      if (window.UI && UI.showError) UI.showError(err.message || 'Request failed.');
      return null;
    }
  }

  // ---- Confirm + execute helpers ----
  async function executeClear(force) {
    var selected = getSelected();
    if (!selected.length) return;

    var confirmed = await UI.confirm({
      title: force ? 'Force Clear Rows' : 'Clear Rows',
      message: (force
        ? 'FK checks will be DISABLED. All rows in the selected ' + selected.length + ' table(s) will be permanently deleted regardless of any foreign key references.'
        : 'All rows in the selected ' + selected.length + ' table(s) will be permanently deleted. This will fail if other tables reference them via FK constraints.'),
      confirmText: force ? 'Force Clear' : 'Clear Rows',
      danger: true,
      detailsHtml: buildTableListHtml(selected),
      requireInputMatch: String(selected.length),
      requireInputPlaceholder: 'Type ' + selected.length + ' to confirm',
    });

    if (!confirmed) return;

    var res = await callBulkApi('/api/tables/bulk-truncate', selected, force);
    if (!res) return;

    showResultToast('truncate', 'Cleared', res.cleared || [], res.failed || []);
    if ((res.cleared || []).length > 0) reloadPage();
  }

  async function executeDrop(force) {
    var selected = getSelected();
    if (!selected.length) return;

    var confirmed = await UI.confirm({
      title: force ? 'Force Drop Tables' : 'Drop Tables',
      message: (force
        ? 'FK checks will be DISABLED. The selected ' + selected.length + ' table(s) and ALL their data will be PERMANENTLY deleted, ignoring any foreign key constraints.'
        : 'The selected ' + selected.length + ' table(s) and ALL their data will be PERMANENTLY deleted. This cannot be undone.'),
      confirmText: force ? 'Force Drop' : 'Drop Tables',
      danger: true,
      detailsHtml: buildTableListHtml(selected),
      requireInputMatch: String(selected.length),
      requireInputPlaceholder: 'Type ' + selected.length + ' to confirm',
    });

    if (!confirmed) return;

    var res = await callBulkApi('/api/tables/bulk-drop', selected, force);
    if (!res) return;

    showResultToast('drop', 'Dropped', res.dropped || [], res.failed || []);
    if ((res.dropped || []).length > 0) reloadPage();
  }

  // ---- Wire action buttons ----
  clearNormalBtn && clearNormalBtn.addEventListener('click', function () { executeClear(false); });
  clearForceBtn  && clearForceBtn.addEventListener('click',  function () { executeClear(true); });
  dropNormalBtn  && dropNormalBtn.addEventListener('click',  function () { executeDrop(false); });
  dropForceBtn   && dropForceBtn.addEventListener('click',   function () { executeDrop(true); });

  // ---- Initial sync ----
  syncToolbar();
})();
