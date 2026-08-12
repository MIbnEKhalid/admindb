/* Views page: create / drop views, preview rows. */
(function () {
  'use strict';
  const cfgEl = document.getElementById('views-config');
  if (!cfgEl) return;

  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
  }

  function showError(el, msg) {
    el.classList.remove('hidden');
    el.innerHTML = '<div class="flex items-start gap-2.5 rounded-xl border border-error/40 bg-error/10 px-4 py-3 text-sm font-medium text-error"><span>' + escapeHtml(msg) + '</span></div>';
  }

  // ---- Editor gutter ------------------------------------------------------

  const editor = document.getElementById('view-sql');
  const gutter = document.getElementById('view-gutter');
  function updateGutter() {
    if (!gutter || !editor) return;
    const lines = editor.value.split('\n').length;
    let html = '';
    for (let i = 1; i <= lines; i++) html += i + '\n';
    gutter.textContent = html;
    gutter.scrollTop = editor.scrollTop;
  }
  if (editor && gutter) {
    editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
    editor.addEventListener('input', updateGutter);
    updateGutter();
  }

  // ---- New view form ------------------------------------------------------

  const newBtn = document.getElementById('new-view');
  const panel = document.getElementById('new-view-panel');
  const nameInput = document.getElementById('view-name');
  const sqlInput = document.getElementById('view-sql');
  const errEl = document.getElementById('view-error');
  const createBtn = document.getElementById('create-view');
  const cancelBtn = document.getElementById('cancel-view');
  const preview = document.getElementById('view-preview');
  const previewCode = document.getElementById('view-preview-code');
  const previewHint = document.getElementById('view-preview-hint');
  let previewTimer = null;

  function renderPreview() {
    clearTimeout(previewTimer);
    const name = (nameInput.value || '').trim();
    const sql = (sqlInput.value || '').trim();
    if (!name && !sql) {
      preview.classList.add('hidden');
      previewCode.textContent = '';
      if (previewHint) previewHint.classList.remove('hidden');
      return;
    }
    previewTimer = setTimeout(async () => {
      try {
        const data = await Api.post('/api/views/generate', { name, sql });
        previewCode.textContent = data.sql;
        preview.classList.remove('hidden');
        if (previewHint) previewHint.classList.add('hidden');
      } catch (e) {
        preview.classList.add('hidden');
        previewCode.textContent = '';
        if (previewHint) previewHint.classList.remove('hidden');
      }
    }, 250);
  }

  if (newBtn && panel) {
    newBtn.addEventListener('click', () => {
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) {
        errEl.classList.add('hidden');
        nameInput.focus();
        renderPreview();
      }
    });
  }
  if (nameInput) nameInput.addEventListener('input', renderPreview);
  if (sqlInput) sqlInput.addEventListener('input', renderPreview);

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      panel.classList.add('hidden');
      errEl.classList.add('hidden');
    });
  }

  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      errEl.classList.add('hidden');
      const name = (nameInput.value || '').trim();
      const sql = (sqlInput.value || '').trim();
      if (!name) return showError(errEl, 'View name is required.');
      if (!sql) return showError(errEl, 'A SELECT statement is required.');
      createBtn.disabled = true;
      try {
        const data = await Api.post('/api/views', { name, sql });
        UI.showToast(data.message || 'View created.', 'success');
        window.location.reload();
      } catch (e) {
        showError(errEl, e.message);
      } finally {
        createBtn.disabled = false;
      }
    });
  }

  // ---- Preview rows -------------------------------------------------------

  document.querySelectorAll('.view-browse').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.view;
      const tr = btn.closest('tr');
      const previewTr = tr && tr.nextElementSibling;
      if (!previewTr) return;
      const container = previewTr.querySelector('td > div');
      if (!container) return;
      if (!previewTr.classList.contains('hidden')) {
        previewTr.classList.add('hidden');
        return;
      }
      container.innerHTML = '<p class="text-sm text-base-content/45">Loading…</p>';
      try {
        const data = await Api.get('/api/views/' + encodeURIComponent(name) + '/rows');
        const rows = data.rows || [];
        if (!rows.length) {
          container.innerHTML = '<p class="text-sm text-base-content/45">View returned no rows.</p>';
          previewTr.classList.remove('hidden');
          return;
        }
        const cols = Object.keys(rows[0]);
        let html = '<div class="overflow-x-auto rounded-lg border border-base-200"><table class="table table-xs">' +
          '<thead><tr class="bg-base-200/70">' + cols.map((c) => '<th class="font-mono text-[11px]">' + escapeHtml(c) + '</th>').join('') + '</tr></thead><tbody>';
        const shown = rows.slice(0, 50);
        for (const row of shown) {
          html += '<tr>' + cols.map((c) => {
            const v = row[c];
            const s = v == null ? '' : String(v);
            const display = v == null ? '<span class="text-base-content/30">NULL</span>' : (s.length > 120 ? escapeHtml(s.slice(0, 120)) + '…' : escapeHtml(s));
            return '<td class="max-w-xs truncate font-mono text-[12px]">' + display + '</td>';
          }).join('') + '</tr>';
        }
        html += '</tbody></table></div>';
        if (rows.length > shown.length) {
          html += '<p class="mt-2 text-xs text-base-content/45">Showing first ' + shown.length + ' of ' + rows.length + ' row(s).</p>';
        }
        container.innerHTML = html;
        previewTr.classList.remove('hidden');
      } catch (e) {
        container.innerHTML = '<p class="text-sm font-medium text-error">' + escapeHtml(e.message) + '</p>';
        previewTr.classList.remove('hidden');
      }
    });
  });

  // ---- Drop view ----------------------------------------------------------

  document.querySelectorAll('.view-drop').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.view;
      if (!name) return;
      if (!window.confirm('Drop view "' + name + '" permanently?')) return;
      try {
        const data = await Api.del('/api/views/' + encodeURIComponent(name));
        UI.showToast(data.message || 'View dropped.', 'success');
        window.location.reload();
      } catch (e) {
        UI.showError(e.message);
      }
    });
  });
})();
