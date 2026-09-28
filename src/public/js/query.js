/* Query editor: Fast, zero-desync SQL IDE with real-time token syntax coloring,
 * Undo/Redo history stack (Ctrl+Z / Ctrl+Y), line numbers gutter, smart indentation,
 * error analysis & visual pointers, save/load, smooth results sliding, and export. */
(function () {
  'use strict';
  const dbId = encodeURIComponent((window.APP && window.APP.dbId) || '');

  const textarea = document.getElementById('query-sql');
  const highlightCode = document.getElementById('query-code');
  const highlightPre = document.getElementById('query-highlight');
  const gutter = document.getElementById('query-gutter');
  const cursorPosEl = document.getElementById('editor-cursor-pos');
  const statsEl = document.getElementById('editor-stats');
  const runBtn = document.getElementById('run-query');
  const formatBtn = document.getElementById('format-query');
  const copyBtn = document.getElementById('copy-query');
  const clearBtn = document.getElementById('clear-query');
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
  let errorLineNum = null;

  const escapeHtml = window.Utils ? window.Utils.escapeHtml : function(s) { return String(s == null ? '' : s); };
  const highlightSql = window.Utils ? window.Utils.highlightSql : function(s) { return escapeHtml(s); };

  // ---------------------------------------------------------------------------
  // History Manager (Undo / Redo Stack)
  // ---------------------------------------------------------------------------

  class HistoryManager {
    constructor(limit = 100) {
      this.stack = [];
      this.index = -1;
      this.limit = limit;
      this.lastRecordTime = 0;
    }

    record(text, selection, debounceMs = 250) {
      const now = Date.now();
      const current = this.index >= 0 ? this.stack[this.index] : null;

      if (current && current.text === text) {
        current.selection = selection;
        return;
      }

      // Group rapid character typing into same snapshot unless whitespace/punctuation
      if (current && now - this.lastRecordTime < debounceMs && Math.abs(text.length - current.text.length) === 1 && !/\s|[;(),]/.test(text.slice(-1))) {
        current.text = text;
        current.selection = selection;
        this.lastRecordTime = now;
        return;
      }

      // Truncate redo stack when new edits happen
      this.stack = this.stack.slice(0, this.index + 1);
      this.stack.push({ text: text, selection: selection });

      if (this.stack.length > this.limit) {
        this.stack.shift();
      } else {
        this.index++;
      }
      this.lastRecordTime = now;
    }

    undo() {
      if (this.index > 0) {
        this.index--;
        return this.stack[this.index];
      }
      return null;
    }

    redo() {
      if (this.index < this.stack.length - 1) {
        this.index++;
        return this.stack[this.index];
      }
      return null;
    }
  }

  const history = new HistoryManager(100);

  // ---------------------------------------------------------------------------
  // Editor Text & Highlighting Sync
  // ---------------------------------------------------------------------------

  function getEditorText() {
    return textarea ? textarea.value : '';
  }

  function syncHighlight() {
    if (!textarea || !highlightCode) return;
    const val = textarea.value;
    // Add extra space/newline to prevent <pre> height collapse on trailing newlines
    highlightCode.innerHTML = highlightSql(val) + (val.endsWith('\n') ? ' ' : '');
    updateGutter();
    updateCursorStats();
    syncScroll();
  }

  function syncScroll() {
    if (!textarea) return;
    if (highlightPre) {
      highlightPre.scrollTop = textarea.scrollTop;
      highlightPre.scrollLeft = textarea.scrollLeft;
    }
    if (gutter) {
      gutter.scrollTop = textarea.scrollTop;
    }
  }

  function setEditorValue(val, recordHistory = true) {
    if (!textarea) return;
    textarea.value = val || '';
    syncHighlight();
    if (recordHistory) {
      const len = (val || '').length;
      history.record(val || '', { start: len, end: len }, 0);
    }
  }

  function doUndo() {
    const item = history.undo();
    if (!item) return;
    textarea.value = item.text;
    syncHighlight();
    if (item.selection) {
      textarea.setSelectionRange(item.selection.start, item.selection.end);
    }
    textarea.focus();
    errorLineNum = null;
    updateGutter();
    updateCursorStats();
  }

  function doRedo() {
    const item = history.redo();
    if (!item) return;
    textarea.value = item.text;
    syncHighlight();
    if (item.selection) {
      textarea.setSelectionRange(item.selection.start, item.selection.end);
    }
    textarea.focus();
    errorLineNum = null;
    updateGutter();
    updateCursorStats();
  }

  // ---------------------------------------------------------------------------
  // Gutter & Cursor Stats
  // ---------------------------------------------------------------------------

  function updateGutter() {
    if (!textarea || !gutter) return;
    const text = textarea.value;
    const lines = text.split('\n');
    const lineCount = Math.max(1, lines.length);

    let gutterHtml = '';
    for (let i = 1; i <= lineCount; i++) {
      const isErr = errorLineNum != null && i === errorLineNum;
      gutterHtml += '<div class="sql-gutter-line' + (isErr ? ' has-error' : '') + '" data-line="' + i + '" title="' + (isErr ? 'Error on line ' + i : 'Line ' + i) + '">' + i + '</div>';
    }
    gutter.innerHTML = gutterHtml;
    gutter.scrollTop = textarea.scrollTop;
  }

  function updateCursorStats() {
    if (!textarea || !cursorPosEl) return;
    const text = textarea.value;
    const selStart = textarea.selectionStart || 0;
    const selEnd = textarea.selectionEnd || 0;
    const textBefore = text.slice(0, selStart);
    const lines = textBefore.split('\n');
    const line = lines.length;
    const col = lines[lines.length - 1].length + 1;

    cursorPosEl.textContent = 'Ln ' + line + ', Col ' + col;

    if (statsEl) {
      const totalLen = text.length;
      const totalLines = text.split('\n').length;
      const selLen = Math.abs(selEnd - selStart);
      if (selLen > 0) {
        statsEl.textContent = totalLen + ' chars (' + selLen + ' selected) · ' + totalLines + ' lines';
      } else {
        statsEl.textContent = totalLen + ' chars · ' + totalLines + ' lines';
      }
    }
  }

  function jumpToLine(line, col) {
    if (!textarea) return;
    const text = textarea.value;
    const lines = text.split('\n');
    const targetLine = Math.max(1, Math.min(lines.length, line || 1));
    let charPos = 0;
    for (let i = 0; i < targetLine - 1; i++) {
      charPos += lines[i].length + 1;
    }
    if (col && col > 1) {
      charPos += Math.min(lines[targetLine - 1].length, col - 1);
    }
    textarea.focus();
    textarea.setSelectionRange(charPos, charPos);
    const lineHeight = 21;
    textarea.scrollTop = Math.max(0, (targetLine - 3) * lineHeight);
    syncScroll();
    updateCursorStats();
  }

  // ---------------------------------------------------------------------------
  // SQL Formatter (Beautify)
  // ---------------------------------------------------------------------------

  function formatSql(raw) {
    if (!raw) return '';
    let sql = raw.trim().replace(/\r\n/g, '\n').replace(/\t/g, '  ');

    const clauseKeywords = [
      'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'GROUP BY', 'HAVING', 'ORDER BY',
      'LIMIT', 'OFFSET', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN',
      'FULL JOIN', 'JOIN', 'UNION ALL', 'UNION', 'INSERT INTO', 'VALUES',
      'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE'
    ];

    clauseKeywords.forEach(function (kw) {
      const reg = new RegExp('\\b' + kw.replace(' ', '\\s+') + '\\b', 'gi');
      sql = sql.replace(reg, '\n' + kw.toUpperCase());
    });

    const formattedLines = sql.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });

    const indented = formattedLines.map(function (line) {
      const upper = line.toUpperCase();
      if (upper.startsWith('WHERE') || upper.startsWith('AND') || upper.startsWith('OR') ||
          upper.startsWith('JOIN') || upper.startsWith('LEFT') || upper.startsWith('RIGHT') ||
          upper.startsWith('INNER') || upper.startsWith('ON') || upper.startsWith('SET') ||
          upper.startsWith('VALUES') || upper.startsWith('HAVING') || upper.startsWith('ORDER') ||
          upper.startsWith('GROUP') || upper.startsWith('LIMIT') || upper.startsWith('OFFSET')) {
        return '  ' + line;
      }
      return line;
    });

    return indented.join('\n');
  }

  if (formatBtn) {
    formatBtn.addEventListener('click', function () {
      const text = getEditorText();
      if (!text.trim()) return;
      setEditorValue(formatSql(text));
      textarea.focus();
      if (window.UI && UI.showToast) UI.showToast('SQL formatted.', 'info');
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      const text = getEditorText();
      if (!text.trim()) return;
      navigator.clipboard.writeText(text).then(function () {
        if (window.UI && UI.showToast) UI.showToast('SQL copied to clipboard.', 'success');
      });
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      setEditorValue('');
      errorLineNum = null;
      setMessage('', 'info');
      textarea.focus();
    });
  }

  document.querySelectorAll('.js-snippet').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      const snippet = a.getAttribute('data-snippet');
      if (!snippet) return;
      setEditorValue(snippet.replace(/\\n/g, '\n'));
      errorLineNum = null;
      setMessage('', 'info');
      textarea.focus();
    });
  });

  if (gutter) {
    gutter.addEventListener('click', function (e) {
      const lineEl = e.target.closest('.sql-gutter-line');
      if (!lineEl) return;
      const l = parseInt(lineEl.dataset.line, 10);
      if (l) jumpToLine(l, 1);
    });
  }

  // ---------------------------------------------------------------------------
  // Editor Event Listeners
  // ---------------------------------------------------------------------------

  if (textarea) {
    textarea.addEventListener('input', function () {
      errorLineNum = null;
      syncHighlight();
      history.record(textarea.value, { start: textarea.selectionStart, end: textarea.selectionEnd }, 250);
    });

    textarea.addEventListener('scroll', syncScroll);
    textarea.addEventListener('click', updateCursorStats);
    textarea.addEventListener('keyup', updateCursorStats);
    textarea.addEventListener('select', updateCursorStats);

    textarea.addEventListener('keydown', function (e) {
      // 1. Undo: Ctrl+Z / Cmd+Z (when not shift)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        doUndo();
        return;
      }

      // 2. Redo: Ctrl+Y / Cmd+Y / Ctrl+Shift+Z / Cmd+Shift+Z
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
          ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')) {
        e.preventDefault();
        doRedo();
        return;
      }

      // 3. Ctrl+Enter / Cmd+Enter -> Run query
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        run();
        return;
      }

      // 4. Enter -> Clean newline with auto-indent
      if (e.key === 'Enter') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = textarea.value;
        const textBefore = text.slice(0, start);
        const lastLine = textBefore.split('\n').pop() || '';
        const match = lastLine.match(/^(\s+)/);
        const indent = match ? match[1] : '';
        const insertion = '\n' + indent;

        textarea.setRangeText(insertion, start, end, 'end');
        syncHighlight();
        history.record(textarea.value, { start: textarea.selectionStart, end: textarea.selectionEnd }, 0);
        return;
      }

      // 5. Ctrl+/ or Cmd+/ -> Toggle line comment
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = textarea.value;

        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        let lineEnd = text.indexOf('\n', end);
        if (lineEnd === -1) lineEnd = text.length;

        const selBlock = text.slice(lineStart, lineEnd);
        const lines = selBlock.split('\n');
        const allCommented = lines.every(function (l) { return l.trim().startsWith('--'); });

        const modified = lines.map(function (l) {
          if (allCommented) {
            return l.replace(/^(\s*)--\s?/, '$1');
          } else {
            return l ? '-- ' + l : l;
          }
        }).join('\n');

        textarea.setRangeText(modified, lineStart, lineEnd, 'preserve');
        textarea.setSelectionRange(lineStart, lineStart + modified.length);
        syncHighlight();
        history.record(textarea.value, { start: lineStart, end: lineStart + modified.length }, 0);
        return;
      }

      // 6. Tab / Shift+Tab -> Indentation
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = textarea.value;

        if (start === end && !e.shiftKey) {
          textarea.setRangeText('  ', start, end, 'end');
          syncHighlight();
          history.record(textarea.value, { start: textarea.selectionStart, end: textarea.selectionEnd }, 0);
        } else {
          const lineStart = text.lastIndexOf('\n', start - 1) + 1;
          let lineEnd = text.indexOf('\n', end);
          if (lineEnd === -1) lineEnd = text.length;
          const selLines = text.slice(lineStart, lineEnd).split('\n');

          const transformed = selLines.map(function (l) {
            if (e.shiftKey) {
              return l.replace(/^(  |\t| )/, '');
            } else {
              return '  ' + l;
            }
          }).join('\n');

          textarea.setRangeText(transformed, lineStart, lineEnd, 'preserve');
          textarea.setSelectionRange(lineStart, lineStart + transformed.length);
          syncHighlight();
          history.record(textarea.value, { start: lineStart, end: lineStart + transformed.length }, 0);
        }
        return;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Error Explainer Card
  // ---------------------------------------------------------------------------

  function setDetailedError(err) {
    if (!messageEl) return;
    const details = err && err.details;
    const msg = (err && err.message) || (details && details.message) || 'Query failed.';

    if (!details || (!details.snippet && !details.cause && !details.suggestion)) {
      setMessage(msg, 'error');
      return;
    }

    errorLineNum = details.line || null;
    updateGutter();

    let html = '<div class="sql-error-card space-y-3">';

    // Header
    html += '<div class="flex flex-wrap items-center justify-between gap-2 border-b border-error/20 pb-2.5">';
    html += '<div class="flex items-center gap-2">';
    html += '<span class="grid h-6 w-6 place-items-center rounded-lg bg-error/15 text-error font-bold">✕</span>';
    html += '<span class="font-bold text-sm text-error">' + escapeHtml(msg) + '</span>';
    html += '</div>';

    if (details.line) {
      html += '<div class="flex items-center gap-1.5">';
      html += '<span class="badge badge-sm badge-error font-mono font-bold">Line ' + details.line + (details.column ? ', Col ' + details.column : '') + '</span>';
      html += '<button type="button" class="btn btn-xs btn-outline btn-error js-jump-err-line" data-line="' + details.line + '" data-col="' + (details.column || 1) + '">Jump to line</button>';
      html += '</div>';
    }
    html += '</div>';

    // Snippet with pointer
    if (details.snippet) {
      html += '<div>';
      html += '<p class="text-[11px] font-bold uppercase tracking-wider text-base-content/45 mb-1.5">Code Snippet</p>';
      html += '<pre class="sql-error-snippet">' + escapeHtml(details.snippet) + '</pre>';
      html += '</div>';
    }

    // Possible Cause & Suggested Fix
    if (details.cause || details.suggestion) {
      html += '<div class="grid grid-cols-1 md:grid-cols-2 gap-2.5 pt-1">';
      if (details.cause) {
        html += '<div class="rounded-lg border border-base-300 bg-base-100/90 p-3 shadow-xs">';
        html += '<div class="flex items-center gap-1.5 text-xs font-bold text-base-content/80 mb-1">';
        html += '<span>💡</span><span>Possible Cause</span>';
        html += '</div>';
        html += '<p class="text-xs text-base-content/70 leading-relaxed">' + escapeHtml(details.cause) + '</p>';
        html += '</div>';
      }
      if (details.suggestion) {
        html += '<div class="rounded-lg border border-primary/30 bg-primary/5 p-3 shadow-xs">';
        html += '<div class="flex items-center gap-1.5 text-xs font-bold text-primary mb-1">';
        html += '<span>🔧</span><span>Suggested Fix</span>';
        html += '</div>';
        html += '<p class="text-xs text-base-content/80 font-medium leading-relaxed">' + escapeHtml(details.suggestion) + '</p>';
        html += '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
    messageEl.innerHTML = html;

    const jumpBtn = messageEl.querySelector('.js-jump-err-line');
    if (jumpBtn) {
      jumpBtn.addEventListener('click', function () {
        const l = parseInt(jumpBtn.dataset.line, 10);
        const c = parseInt(jumpBtn.dataset.col, 10);
        jumpToLine(l, c);
      });
    }
  }

  function setMessage(text, type) {
    if (!messageEl) return;
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

  // ---------------------------------------------------------------------------
  // Export & Results Table
  // ---------------------------------------------------------------------------

  function setExportEnabled(enabled) {
    if (exportCsvBtn) exportCsvBtn.disabled = !enabled;
    if (exportJsonBtn) exportJsonBtn.disabled = !enabled;
  }

  async function exportResults(format) {
    const sql = getEditorText().trim();
    if (!sql) return;
    try {
      const res = await fetch(Api.url('/api/query/' + dbId + '/export'), {
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
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      if (window.Utils && window.Utils.downloadBlob) {
        window.Utils.downloadBlob(blob, 'query-' + stamp + '.' + format);
      }
      if (window.UI && UI.showToast) UI.showToast('Exported as ' + format.toUpperCase() + '.', 'success');
    } catch (e) {
      setMessage(e.message, 'error');
    }
  }

  if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => exportResults('csv'));
  if (exportJsonBtn) exportJsonBtn.addEventListener('click', () => exportResults('json'));

  const isJsonStr = window.Utils ? window.Utils.isJson : function(s) { return false; };
  const isHexBlobStr = window.Utils ? window.Utils.isHexBlob : function(s) { return false; };

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

  if (bodyEl) {
    let queryPeekTimer = null;

    bodyEl.addEventListener('click', function (e) {
      const inspectBtn = e.target.closest('.js-query-inspect');
      const cell = e.target.closest('.js-query-cell');
      if (!inspectBtn && (!cell || (e.detail < 2 && !e.altKey))) return;
      const targetCell = inspectBtn ? inspectBtn.closest('.js-query-cell') : cell;
      if (!targetCell) return;

      const col = targetCell.dataset.col || 'Result';
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

    // Quick peek on mouse hover
    bodyEl.addEventListener('mouseover', function (e) {
      const cell = e.target.closest('.js-query-cell');
      if (!cell) return;
      clearTimeout(queryPeekTimer);
      queryPeekTimer = setTimeout(function () {
        const val = cell.dataset.value || '';
        if (!val || val.length < 30) return;
        const col = cell.dataset.col || 'Result';
        const isBlob = cell.dataset.blob === 'true';
        const isJson = cell.dataset.json === 'true';
        if (window.Inspector && window.Inspector.peek) {
          window.Inspector.peek(cell, {
            col: col,
            value: val,
            isBlob: isBlob,
            isJson: isJson,
            readonly: true,
          });
        }
      }, 450);
    });

    bodyEl.addEventListener('mouseout', function (e) {
      clearTimeout(queryPeekTimer);
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
    const sql = getEditorText().trim();
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
    errorLineNum = null;
    updateGutter();
    messageEl.innerHTML = '';
    resultEl.classList.add('hidden');
    setExportEnabled(false);

    const originalBtnHtml = runBtn ? runBtn.innerHTML : '';
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.innerHTML = '<span class="loading loading-spinner loading-xs"></span> Running…';
    }

    const started = performance.now();
    try {
      const data = await Api.post('/api/query/' + dbId, { sql });
      const elapsed = Math.max(1, Math.round(performance.now() - started));
      
      resultEl.classList.remove('hidden');
      resultEl.classList.remove('js-result-slide');
      void resultEl.offsetWidth;
      resultEl.classList.add('js-result-slide');

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

      // Smoothly slide / scroll to results
      setTimeout(function () {
        resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);

    } catch (e) {
      resultEl.classList.add('hidden');
      setDetailedError(e);
      setTimeout(function () {
        messageEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    } finally {
      if (runBtn) {
        runBtn.disabled = false;
        runBtn.innerHTML = originalBtnHtml;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Saved Queries
  // ---------------------------------------------------------------------------

  async function refreshQueries(selectName) {
    try {
      queriesCache = await Api.get('/api/queries/' + dbId);
    } catch (e) {
      queriesCache = [];
    }
    selectEl.innerHTML = '<option value="">— select a saved query —</option>' + queriesCache.map((q) =>
      '<option value="' + q.id + '"' + (selectName && q.name === selectName ? ' selected' : '') + '>' + escapeHtml(q.name) + '</option>',
    ).join('');
    deleteBtn.disabled = true;
  }

  async function saveQuery() {
    const sql = getEditorText().trim();
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
      await Api.post('/api/queries/' + dbId, { name, sql });
      if (window.UI && UI.showToast) UI.showToast('Query saved.', 'success');
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
      await Api.del('/api/queries/' + dbId + '/' + id);
      if (window.UI && UI.showToast) UI.showToast('Query deleted.', 'success');
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
        setEditorValue(q.sql);
        saveName.value = q.name;
        errorLineNum = null;
        setMessage('Loaded "' + q.name + '".', 'info');
        textarea.focus();
      }
    });
  }
  if (deleteBtn) deleteBtn.addEventListener('click', deleteQuery);

  // Initialize
  const initialText = getEditorText();
  if (initialText) {
    setEditorValue(initialText, true);
  } else {
    history.record('', { start: 0, end: 0 }, 0);
  }
  syncHighlight();
})();
