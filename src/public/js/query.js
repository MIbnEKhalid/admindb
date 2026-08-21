/* Query editor: run arbitrary SQL, save/load named queries, render results. */
(function () {
  'use strict';
  const editor = document.getElementById('query-sql');
  const gutter = document.getElementById('query-gutter');
  const runBtn = document.getElementById('run-query');
  const messageEl = document.getElementById('query-message');
  const resultEl = document.getElementById('query-result');
  const headEl = document.getElementById('query-result-head');
  const bodyEl = document.getElementById('query-result-body');
  const resultSummary = document.getElementById('result-summary');
  const saveBtns = Array.prototype.slice.call(document.querySelectorAll('#save-query, #save-query-inline'));
  const saveName = document.getElementById('save-query-name');
  const selectEl = document.getElementById('saved-query-select');
  const deleteBtn = document.getElementById('delete-query');
  const exportCsvBtn = document.getElementById('export-csv');
  const exportJsonBtn = document.getElementById('export-json');

  let queriesCache = [];

  function setExportEnabled(enabled) {
    if (exportCsvBtn) exportCsvBtn.disabled = !enabled;
    if (exportJsonBtn) exportJsonBtn.disabled = !enabled;
  }

  // ---- Export results ------------------------------------------------------

  async function exportResults(format) {
    const sql = editor.value.trim();
    if (!sql) return;
    try {
      const res = await fetch(Api.url('/api/query/export'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, format }),
      });
      if (!res.ok) {
        let msg = 'Export failed (' + res.status + ').';
        try {
          const data = await res.json();
          if (data && data.error) msg = data.error;
        } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = 'query-' + stamp + '.' + format;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      UI.showToast('Exported as ' + format.toUpperCase() + '.', 'success');
    } catch (e) {
      setMessage(e.message, 'error');
    }
  }

  if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => exportResults('csv'));
  if (exportJsonBtn) exportJsonBtn.addEventListener('click', () => exportResults('json'));

  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
  }

  function setMessage(text, type) {
    if (!text) {
      messageEl.innerHTML = '';
      return;
    }
    const palette = {
      error: 'border-error/40 bg-error/10 text-error',
      success: 'border-success/40 bg-success/10 text-success',
      info: 'border-info/40 bg-info/10 text-info',
      warning: 'border-warning/40 bg-warning/10 text-warning',
    };
    messageEl.innerHTML = '<div class="flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm font-medium ' +
      (palette[type] || palette.info) + '"><span>' + escapeHtml(text) + '</span></div>';
  }

  function isJsonStr(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return false;
    try { JSON.parse(t); return true; } catch { return false; }
  }

  function isHexBlobStr(s) {
    return typeof s === 'string' && /^0x[0-9a-f]{4,}$/i.test(s.trim());
  }

  function renderTable(columns, rows) {
    headEl.innerHTML = '<tr>' + columns.map((c) => '<th class="whitespace-nowrap font-semibold"><span class="font-mono normal-case">' + escapeHtml(c) + '</span></th>').join('') + '</tr>';
    if (!rows.length) {
      bodyEl.innerHTML = '<tr><td colspan="' + Math.max(1, columns.length) + '" class="py-10 text-center text-base-content/45">No rows returned.</td></tr>';
      return;
    }
    bodyEl.innerHTML = rows.map((row) =>
      '<tr class="hover:bg-primary/[0.04]">' + columns.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) {
          return '<td class="align-middle"><span class="chip chip-null">NULL</span></td>';
        }
        const s = String(v);
        const json = isJsonStr(s);
        const blob = isHexBlobStr(s);
        const short = s.length > 140 ? s.slice(0, 140) + '…' : s;

        if (json) {
          return '<td class="max-w-xs align-middle js-query-cell" data-col="' + escapeHtml(c) + '" data-value="' + escapeHtml(s) + '" data-json="true">' +
            '<div class="flex items-center gap-1.5">' +
            '<span class="inline-flex items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-[11px] font-mono font-medium text-info">{ } JSON</span>' +
            '<span class="block max-w-[120px] truncate font-mono text-[12px] text-base-content/70">' + escapeHtml(short) + '</span>' +
            '<button type="button" class="btn btn-ghost btn-xs btn-circle js-query-inspect" title="Inspect JSON"><svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg></button>' +
            '</div></td>';
        }

        if (blob) {
          return '<td class="max-w-xs align-middle js-query-cell" data-col="' + escapeHtml(c) + '" data-value="' + escapeHtml(s) + '" data-blob="true">' +
            '<div class="flex items-center gap-1.5">' +
            '<span class="inline-flex items-center gap-1 rounded-md bg-secondary/10 px-1.5 py-0.5 text-[11px] font-mono font-medium text-secondary">🗃️ BLOB</span>' +
            '<span class="block max-w-[120px] truncate font-mono text-[12px] text-base-content/70">' + escapeHtml(short) + '</span>' +
            '<button type="button" class="btn btn-ghost btn-xs btn-circle js-query-inspect" title="Inspect BLOB"><svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg></button>' +
            '</div></td>';
        }

        return '<td class="max-w-xs align-middle js-query-cell" data-col="' + escapeHtml(c) + '" data-value="' + escapeHtml(s) + '">' +
          '<div class="flex items-center justify-between gap-1 group/cell">' +
          '<span class="truncate font-mono text-[13px]" title="' + escapeHtml(s) + '">' + escapeHtml(short) + '</span>' +
          (s.length > 25 ? '<button type="button" class="btn btn-ghost btn-xs btn-circle opacity-0 group-hover/cell:opacity-100 transition-opacity js-query-inspect shrink-0" title="Inspect text"><svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg></button>' : '') +
          '</div></td>';
      }).join('') + '</tr>',
    ).join('');
  }

  // Delegate inspection click
  if (bodyEl) {
    bodyEl.addEventListener('click', function (e) {
      const inspectBtn = e.target.closest('.js-query-inspect');
      const cell = e.target.closest('.js-query-cell');
      if (!inspectBtn && (!cell || e.detail < 2)) return;
      const targetCell = inspectBtn ? inspectBtn.closest('.js-query-cell') : cell;
      if (!targetCell) return;

      const col = targetCell.dataset.col || 'result';
      const val = targetCell.dataset.value || '';
      const isBlob = targetCell.dataset.blob === 'true';
      const isJson = targetCell.dataset.json === 'true';

      if (window.Inspector && window.Inspector.open) {
        window.Inspector.open({
          col: col,
          value: val,
          isNull: false,
          isBlob: isBlob,
          isJson: isJson,
          readonly: true,
        });
      }
    });
  }

  function renderMessageRow(text, kindLabel) {
    headEl.innerHTML = '';
    bodyEl.innerHTML = '<tr><td class="px-4 py-8 text-center"><p class="text-2xl font-extrabold text-primary">' +
      escapeHtml(text) + '</p><p class="mt-1 text-sm text-base-content/45">' + escapeHtml(kindLabel) + '</p></td></tr>';
  }

  function setSummary(text) {
    if (resultSummary) resultSummary.textContent = text;
  }

  function isDestructiveSql(sql) {
    var cleaned = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (/\b(drop\s+(table|view|index|trigger)|truncate\b)/i.test(cleaned)) return true;
    if (/\bdelete\s+from\b/i.test(cleaned) && !/\bwhere\b/i.test(cleaned)) return true;
    return false;
  }

  async function run() {
    const sql = editor.value.trim();
    if (!sql) {
      setMessage('Enter a SQL statement first.', 'warning');
      return;
    }
    if (isDestructiveSql(sql)) {
      const confirmed = await UI.confirm({
        title: 'Execute Destructive SQL',
        message: 'This SQL statement contains potentially destructive operations (e.g. DROP, TRUNCATE, or unrestricted DELETE) that may permanently erase database schemas or data.',
        detailsHtml: '<pre class="font-mono text-xs text-base-content/85 whitespace-pre-wrap break-all">' + escapeHtml(sql.length > 350 ? sql.slice(0, 350) + '…' : sql) + '</pre>',
        confirmText: 'Execute anyway',
        danger: true,
      });
      if (!confirmed) return;
    }
    messageEl.innerHTML = '';
    resultEl.classList.add('hidden');
    setExportEnabled(false);
    const started = performance.now();
    try {
      const data = await Api.post('/api/query', { sql });
      const elapsed = Math.max(1, Math.round(performance.now() - started));
      resultEl.classList.remove('hidden');
      if (data.kind === 'count') {
        renderMessageRow(String(data.count), 'count');
        setSummary('Count query · ' + elapsed + 'ms');
      } else if (data.kind === 'select') {
        renderTable(data.columns, data.rows);
        setSummary(data.rows.length + ' row(s) · ' + elapsed + 'ms');
        setExportEnabled(true);
      } else {
        renderMessageRow(data.message || 'Statement executed.', 'write');
        setSummary(data.changes != null ? data.changes + ' row(s) affected · ' + elapsed + 'ms' : elapsed + 'ms');
      }
    } catch (e) {
      resultEl.classList.add('hidden');
      setMessage(e.message, 'error');
    }
  }

  // ---- Line numbers ------------------------------------------------------

  function updateGutter() {
    if (!gutter) return;
    const lines = editor.value.split('\n').length;
    let html = '';
    for (let i = 1; i <= lines; i++) html += i + '\n';
    gutter.textContent = html;
    gutter.scrollTop = editor.scrollTop;
  }

  if (editor && gutter) {
    editor.addEventListener('scroll', () => {
      gutter.scrollTop = editor.scrollTop;
    });
    editor.addEventListener('input', updateGutter);
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
    updateGutter();
  }

  // ---- Saved queries -----------------------------------------------------

  async function refreshQueries(selectName) {
    try {
      queriesCache = await Api.get('/api/queries');
    } catch (e) {
      queriesCache = [];
    }
    selectEl.innerHTML = '<option value="">— select a saved query —</option>' + queriesCache.map((q) =>
      '<option value="' + q.id + '"' + (selectName && q.name === selectName ? ' selected' : '') + '>' + escapeHtml(q.name) + '</option>',
    ).join('');
    deleteBtn.disabled = true;
  }

  async function saveQuery() {
    const sql = editor.value.trim();
    const name = saveName.value.trim();
    if (!sql) {
      setMessage('Write some SQL before saving.', 'warning');
      return;
    }
    if (!name) {
      setMessage('Give the query a name.', 'warning');
      return;
    }
    try {
      await Api.post('/api/queries', { name, sql });
      UI.showToast('Query saved.', 'success');
      await refreshQueries(name);
    } catch (e) {
      setMessage(e.message, 'error');
    }
  }

  async function deleteQuery() {
    const id = selectEl.value;
    if (!id) return;
    const q = queriesCache.find((x) => String(x.id) === String(id));
    const queryName = q ? q.name : 'Saved query';
    const confirmed = await UI.confirm({
      title: 'Delete Saved Query',
      message: 'Are you sure you want to delete the saved query "' + queryName + '"?',
      item: queryName,
      itemType: 'Saved Query',
      confirmText: 'Delete query',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await Api.del('/api/queries/' + id);
      UI.showToast('Query deleted.', 'success');
      await refreshQueries();
    } catch (e) {
      setMessage(e.message, 'error');
    }
  }

  if (runBtn) runBtn.addEventListener('click', run);
  saveBtns.forEach((btn) => btn.addEventListener('click', saveQuery));
  if (selectEl) {
    selectEl.addEventListener('change', () => {
      const id = selectEl.value;
      deleteBtn.disabled = !id;
      if (!id) return;
      const q = queriesCache.find((x) => String(x.id) === String(id));
      if (q) {
        editor.value = q.sql;
        saveName.value = q.name;
        updateGutter();
        setMessage('Loaded "' + q.name + '".', 'info');
      }
    });
  }
  if (deleteBtn) deleteBtn.addEventListener('click', deleteQuery);
})();
