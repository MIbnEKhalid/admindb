/* Table browse page.
 *
 * Features:
 *  - Inline (spreadsheet-style) cell editing — double-click a cell, edit in
 *    place with a type-aware control (FK dropdown, boolean toggle, date picker,
 *    number input, text input). Changes are staged in the grid and marked as
 *    pending; press "Apply" to write them all at once (single transaction), or
 *    "Discard" to revert every pending cell back to the server values.
 *  - Type-aware row filters — the filter form adapts to each column's type
 *    (FK dropdowns, boolean toggles, date/number ranges, plain text).
 *  - Bulk row operations — row checkboxes + batch delete (with FK-impact
 *    warnings) and batch CSV/JSON export.
 *  - Plus the existing single-row delete, page-size, CSV import and
 *    related-rows expander.
 */
(function () {
  'use strict';

  const base = (window.APP && window.APP.basePath) || '';
  const readonly = !!(window.APP && window.APP.readonly);

  const cfgEl = document.getElementById('browse-config');
  const cfg = cfgEl
    ? JSON.parse(cfgEl.textContent)
    : { table: '', filters: {}, pkCols: [], hasPk: false, readonly: readonly };
  const t = encodeURIComponent(cfg.table);

  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
  }

  let info = null; // TableInfoData from /api/tables/:table/info
  let fkOptions = {}; // { [from]: [{ value, label }] }

  function colInfo(name) {
    return info ? info.columns.find((c) => c.name === name) : null;
  }
  function isPk(name) {
    return !!info && info.primaryKey.indexOf(name) !== -1;
  }
  function fkFor(name) {
    return info ? info.foreignKeys.find((f) => f.from === name) : null;
  }

  // ---- Single row delete --------------------------------------------------

  function initRowDelete() {
    document.querySelectorAll('.js-delete-row').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const table = btn.dataset.table;
        const pk = btn.dataset.pk;
        if (!table || !pk) return;
        const confirmed = await UI.confirm({
          title: 'Delete Row',
          message: 'Are you sure you want to permanently delete this row? This action cannot be undone.',
          item: pk,
          itemType: 'Primary Key',
          confirmText: 'Delete row',
          danger: true,
        });
        if (!confirmed) return;
        Api.del('/api/tables/' + encodeURIComponent(table) + '/row/' + encodeURIComponent(pk))
          .then(() => {
            UI.showToast('Row deleted.', 'success');
            window.location.reload();
          })
          .catch((e) => UI.showError(e.message));
      });
    });
  }

  // ---- Page size (keeps current filters) ----------------------------------

  function initPageSize() {
    const sizeSel = document.getElementById('page-size');
    if (!sizeSel) return;
    sizeSel.addEventListener('change', () => {
      const table = sizeSel.dataset.table;
      const size = sizeSel.value;
      const orderBy = sizeSel.dataset.orderby || '';
      const orderDir = sizeSel.dataset.orderdir || 'asc';
      const filters = sizeSel.dataset.filters || '';
      let href =
        base + '/tables/' + encodeURIComponent(table) + '?page=1&size=' + encodeURIComponent(size) +
        '&orderBy=' + encodeURIComponent(orderBy) + '&orderDir=' + encodeURIComponent(orderDir);
      if (filters) href += '&' + filters;
      window.location.href = href;
    });
  }

  // ---- Type-aware row filters ---------------------------------------------

  function filterCondArray(existing) {
    if (existing == null) return [];
    if (Array.isArray(existing)) {
      return existing.filter((x) => x && typeof x === 'object' && typeof x.op === 'string');
    }
    if (typeof existing === 'object') return [existing];
    return [];
  }
  function legacyString(existing) {
    return typeof existing === 'string' ? existing : null;
  }
  function condVal(conds, op) {
    const c = conds.find((x) => x.op === op);
    return c ? (c.value ?? null) : null;
  }
  function condBetween(conds) {
    const c = conds.find((x) => x.op === 'between');
    return c ? { min: c.value ?? null, max: c.max ?? null } : { min: null, max: null };
  }

  function toDateInputValue(v, dateOnly, timeOnly) {
    if (v == null || v === '') return '';
    const s = String(v);
    if (dateOnly) {
      const dm = s.match(/^(\d{4}-\d{2}-\d{2})/);
      return dm ? dm[1] : '';
    }
    if (timeOnly) {
      const tm = s.match(/(\d{2}:\d{2}(?::\d{2})?)/);
      return tm ? tm[1] : '';
    }
    const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return '';
    return m[1] + 'T' + (m[2] ? m[2] + ':' + m[3] + (m[4] ? ':' + m[4] : '') : '00:00:00');
  }

  function addOption(sel, value, label) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
    return opt;
  }

  function buildFilterField(col) {
    const wrap = document.createElement('label');
    wrap.className = 'block';
    const label = document.createElement('span');
    label.className = 'field-label !mb-1 font-mono';
    label.textContent = col.name;
    wrap.appendChild(label);

    const fk = fkFor(col.name);
    const type = (col.type || '').toUpperCase();
    const isBool = type === 'BOOLEAN' || type === 'BOOL';
    const isNum = type.startsWith('INT') || type === 'REAL' || type === 'NUMERIC' || type.startsWith('DECIMAL') || type === 'FLOAT' || type === 'DOUBLE' || type.startsWith('BIGINT') || type.startsWith('SMALLINT') || type.startsWith('SERIAL') || type === 'MONEY';
    const isDateOnly = type === 'DATE';
    const isTimeOnly = type === 'TIME' || type === 'TIMETZ' || type.startsWith('TIME ') || type.startsWith('TIME(');
    const isTimestamp = type === 'DATETIME' || type.includes('TIMESTAMP');
    const isDate = isDateOnly || isTimeOnly || isTimestamp;
    const existing = cfg.filters[col.name];
    const conds = filterCondArray(existing);
    const legacy = legacyString(existing);

    // FK dropdown — exact match on the referenced value.
    if (fk) {
      const sel = document.createElement('select');
      sel.className = 'filter-input field-select !py-1.5 !text-[13px]';
      sel.dataset.column = col.name;
      sel.dataset.kind = 'fk';
      addOption(sel, '', '(any)');
      addOption(sel, '__NULL__', '(not set / NULL)');
      (fkOptions[col.name] || []).forEach((o) => addOption(sel, String(o.value), o.label === '' ? String(o.value) : o.label));
      let selVal = condVal(conds, 'eq');
      if (selVal == null && legacy && legacy.startsWith('=')) selVal = legacy.slice(1);
      if (selVal === '__NULL__') sel.value = '__NULL__';
      else if (selVal != null && [...sel.options].some((o) => o.value === String(selVal))) sel.value = String(selVal);
      wrap.appendChild(sel);
      return wrap;
    }

    // Boolean toggle.
    if (isBool) {
      const sel = document.createElement('select');
      sel.className = 'filter-input field-select !py-1.5 !text-[13px]';
      sel.dataset.column = col.name;
      sel.dataset.kind = 'bool';
      addOption(sel, '', '(any)');
      addOption(sel, '1', 'true');
      addOption(sel, '0', 'false');
      let selVal = condVal(conds, 'eq');
      if (selVal == null && legacy && legacy.startsWith('=')) selVal = legacy.slice(1);
      if (selVal === '1' || selVal === '0' || selVal === 'true' || selVal === 'false') {
        sel.value = selVal === 'true' || selVal === '1' ? '1' : '0';
      }
      wrap.appendChild(sel);
      return wrap;
    }

    // Date / datetime range, or numeric range.
    if (isDate || isNum) {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-1.5';
      const lo = document.createElement('input');
      const hi = document.createElement('input');
      if (isDate) {
        lo.type = hi.type = isDateOnly ? 'date' : (isTimeOnly ? 'time' : 'datetime-local');
        if (isTimeOnly || isTimestamp) lo.step = hi.step = '1';
      } else {
        lo.type = hi.type = 'number';
        const isInteger = type.startsWith('INTEGER') || type === 'INT' || type.startsWith('BIGINT') || type.startsWith('SMALLINT') || type.startsWith('SERIAL');
        lo.step = hi.step = isInteger ? '1' : 'any';
      }
      lo.className = 'filter-input field-input !py-1.5 !text-[13px]';
      hi.className = 'filter-input field-input !py-1.5 !text-[13px]';
      lo.dataset.column = col.name;
      lo.dataset.bound = 'min';
      lo.placeholder = isDate ? 'from' : 'min';
      hi.dataset.column = col.name;
      hi.dataset.bound = 'max';
      hi.placeholder = isDate ? 'to' : 'max';
      const bt = condBetween(conds);
      const minV = condVal(conds, 'gte') ?? condVal(conds, 'gt') ?? bt.min;
      const maxV = condVal(conds, 'lte') ?? condVal(conds, 'lt') ?? bt.max;
      if (minV != null) lo.value = isDate ? toDateInputValue(minV, isDateOnly, isTimeOnly) : String(minV);
      if (maxV != null) hi.value = isDate ? toDateInputValue(maxV, isDateOnly, isTimeOnly) : String(maxV);
      row.appendChild(lo);
      row.appendChild(hi);
      wrap.appendChild(row);
      return wrap;
    }


    // Text / BLOB / anything else — legacy operator syntax.
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'filter-input field-input !py-1.5 !text-[13px]';
    input.dataset.column = col.name;
    input.dataset.kind = 'text';
    input.placeholder = type === 'BLOB' ? '0x… or text' : 'filter…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    let textVal = legacy;
    if (textVal == null) {
      const prefix = condVal(conds, 'prefix');
      const eq = condVal(conds, 'eq');
      const like = condVal(conds, 'like');
      if (prefix != null) textVal = String(prefix) + '*';
      else if (eq != null) textVal = '=' + String(eq);
      else if (like != null) textVal = String(like);
    }
    if (textVal != null) input.value = textVal;
    wrap.appendChild(input);
    return wrap;
  }

  function collectFilters() {
    const filters = {};
    const byCol = {};
    document.querySelectorAll('#filter-fields .filter-input').forEach((el) => {
      const col = el.dataset.column;
      if (!col) return;
      (byCol[col] = byCol[col] || []).push(el);
    });
    for (const col of Object.keys(byCol)) {
      const els = byCol[col];
      const first = els[0];
      const kind = first.dataset.kind || '';
      if (kind === 'fk') {
        const v = first.value;
        if (v === '') continue;
        filters[col] = v === '__NULL__' ? { op: 'null' } : { op: 'eq', value: v };
      } else if (kind === 'bool') {
        const v = first.value;
        if (v === '') continue;
        filters[col] = { op: 'eq', value: v };
      } else if (els.length === 2 && first.dataset.bound) {
        const minEl = els.find((e) => e.dataset.bound === 'min');
        const maxEl = els.find((e) => e.dataset.bound === 'max');
        const minV = minEl && minEl.value !== '' ? minEl.value : null;
        const maxV = maxEl && maxEl.value !== '' ? maxEl.value : null;
        if (minV != null && maxV != null) filters[col] = { op: 'between', value: minV, max: maxV };
        else if (minV != null) filters[col] = { op: 'gte', value: minV };
        else if (maxV != null) filters[col] = { op: 'lte', value: maxV };
      } else {
        const v = (first.value || '').trim();
        if (v) filters[col] = v; // legacy string syntax
      }
    }
    return filters;
  }

  function navigate(filters) {
    let table = '';
    const m = window.location.pathname.match(/\/tables\/([^/]+)(?:\/|$)/);
    if (m) table = decodeURIComponent(m[1]);
    if (!table) return;
    const sizeSel = document.getElementById('page-size');
    const qs = new URLSearchParams({ page: '1', size: sizeSel ? sizeSel.value : '50' });
    const keys = Object.keys(filters);
    if (keys.length) qs.set('f', JSON.stringify(filters));
    window.location.href = base + '/tables/' + encodeURIComponent(table) + '?' + qs.toString();
  }

  function initFilters() {
    const filterForm = document.getElementById('filter-form');
    const clearBtn = document.getElementById('clear-filter');
    const fields = document.getElementById('filter-fields');
    if (filterForm && fields && info) {
      info.columns.forEach((col) => fields.appendChild(buildFilterField(col)));
      filterForm.addEventListener('submit', (e) => {
        e.preventDefault();
        navigate(collectFilters());
      });
    }
    if (clearBtn) clearBtn.addEventListener('click', () => navigate({}));
  }

  // ---- Inline (spreadsheet-style) cell editing & Keyboard Navigation --------

  let focusedCell = null;

  function clearFocusedCell() {
    if (focusedCell) {
      focusedCell.classList.remove('cell-focused');
      focusedCell = null;
    }
  }

  function setFocusedCell(td) {
    if (!td || td === focusedCell || td.classList.contains('js-editing')) return;
    clearFocusedCell();
    focusedCell = td;
    td.classList.add('cell-focused');
    td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function revertCell(td) {
    const tr = td.closest('tr');
    const pk = tr && tr.dataset.pk;
    const col = td.dataset.col;
    if (!pk || !col) return;
    const origVal = td.dataset.origValue;
    const origNull = td.dataset.origNull === 'true';
    renderCellValue(td, origNull ? null : origVal);
    td.classList.remove('cell-dirty');
    delete td.dataset.origValue;
    delete td.dataset.origNull;
    pendingChanges.delete(pk + '::' + col);
    updateChangesBar();
    UI.showToast('Reverted edit in column "' + col + '".', 'info');
  }

  function renderCellValue(td, value) {
    const isNull = value === null || value === undefined;
    const display = isNull ? '' : String(value);
    td.dataset.null = String(isNull);
    td.dataset.value = display;
    td.classList.remove('js-editing', 'opacity-60');

    const isDirty = td.dataset.origValue !== undefined;
    const origVal = td.dataset.origValue;
    const origNull = td.dataset.origNull === 'true';
    const dirtyTitle = isDirty
      ? 'Staged edit: ' + (isNull ? 'NULL' : display) + ' (Saved: ' + (origNull ? 'NULL' : origVal) + ')'
      : display;

    const revertBtnHtml = isDirty
      ? '<button type="button" class="cell-revert-btn js-revert-cell" title="Revert this field to saved value">↺</button>'
      : '';

    if (isNull) {
      td.innerHTML = '<div class="flex items-center justify-between gap-1"><span class="chip chip-null js-cell-value">NULL</span>' + revertBtnHtml + '</div>';
      return;
    }

    const col = td.dataset.col;
    const c = colInfo(col);
    const colType = (c?.type || td.dataset.type || '').toUpperCase();
    const isBlob = td.dataset.blob === 'true' || colType.includes('BLOB') || /^0x[0-9a-f]{8,}$/i.test(display);
    const isJson = td.dataset.json === 'true' || ((display.startsWith('{') && display.endsWith('}')) || (display.startsWith('[') && display.endsWith(']')));

    if (isBlob) {
      const bytesLen = display.startsWith('0x') ? Math.floor((display.length - 2) / 2) : display.length;
      td.innerHTML =
        '<div class="flex items-center justify-between gap-1 js-cell-value">' +
        '<div class="flex items-center gap-1.5 min-w-0">' +
        '<span class="inline-flex items-center gap-1 rounded-md bg-secondary/10 px-1.5 py-0.5 text-[11px] font-mono font-medium text-secondary">🗃️ BLOB · ' + bytesLen + ' B</span>' +
        '<button type="button" class="btn btn-ghost btn-xs btn-circle opacity-0 group-hover:opacity-100 transition-opacity js-inspect-btn" title="Inspect BLOB">' +
        '<svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>' +
        '</button>' +
        '</div>' +
        revertBtnHtml +
        '</div>';
    } else if (isJson) {
      td.innerHTML =
        '<div class="flex items-center justify-between gap-1 js-cell-value">' +
        '<div class="flex items-center gap-1.5 min-w-0">' +
        '<span class="inline-flex items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-[11px] font-mono font-medium text-info">{ } JSON</span>' +
        '<span class="block max-w-[140px] truncate font-mono text-[12px] text-base-content/70" title="' + escapeHtml(dirtyTitle) + '">' + escapeHtml(display) + '</span>' +
        '<button type="button" class="btn btn-ghost btn-xs btn-circle opacity-0 group-hover:opacity-100 transition-opacity js-inspect-btn" title="Inspect JSON">' +
        '<svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>' +
        '</button>' +
        '</div>' +
        revertBtnHtml +
        '</div>';
    } else {
      td.innerHTML =
        '<div class="flex items-center justify-between gap-1 group/cell">' +
        '<span class="js-cell-value block max-w-xs truncate font-mono text-[13px]" title="' + escapeHtml(dirtyTitle) + '">' + escapeHtml(display.length > 120 ? display.slice(0, 120) + '…' : display) + '</span>' +
        '<div class="flex items-center gap-0.5 shrink-0">' +
        revertBtnHtml +
        (display.length > 30 ?
          '<button type="button" class="btn btn-ghost btn-xs btn-circle opacity-0 group-hover/cell:opacity-100 transition-opacity js-inspect-btn shrink-0" title="Inspect text">' +
          '<svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>' +
          '</button>' : '') +
        '</div>' +
        '</div>';
    }
  }

  function currentCellValue(td) {
    return td.dataset.null === 'true' ? null : (td.dataset.value ?? '');
  }

  function createEditor(td) {
    const col = td.dataset.col;
    const c = colInfo(col);
    if (!c) return null;
    const fk = fkFor(col);
    const type = (c.type || '').toUpperCase();
    const isBool = type === 'BOOLEAN' || type === 'BOOL';
    const isDateOnly = type === 'DATE';
    const isTimeOnly = type === 'TIME' || type === 'TIMETZ' || type.startsWith('TIME ') || type.startsWith('TIME(');
    const isTimestamp = type === 'DATETIME' || type.includes('TIMESTAMP');
    const isDate = isDateOnly || isTimeOnly || isTimestamp;
    const isNum = type.startsWith('INT') || type === 'REAL' || type === 'NUMERIC' || type.startsWith('DECIMAL') || type === 'FLOAT' || type === 'DOUBLE' || type.startsWith('BIGINT') || type.startsWith('SMALLINT') || type.startsWith('SERIAL') || type === 'MONEY';
    const isBlob = type === 'BLOB' || type === 'BYTEA' || type === 'BINARY';
    const isUuid = type === 'UUID';
    const isJson = type.includes('JSON');
    const isArray = type.endsWith('[]') || type.startsWith('_') || type.includes('ARRAY');
    const isInterval = type === 'INTERVAL';
    const isGeometry = type === 'POINT' || type === 'GEOMETRY' || type === 'BOX' || type === 'CIRCLE' || type === 'POLYGON';
    const isBit = type === 'BIT' || type === 'VARBIT' || type.startsWith('BIT(') || type.startsWith('VARBIT(');
    const value = currentCellValue(td);
    const nullish = value === null || value === '';

    let el;
    if (isBool) {
      el = document.createElement('input');
      el.type = 'checkbox';
      el.className = 'checkbox checkbox-primary checkbox-sm js-inline-ctrl';
      el.checked = value === 1 || value === true || value === '1' || value === 'true';
    } else if (fk) {
      el = document.createElement('select');
      el.className = 'field-select !w-64 !py-1.5 !text-[13px] js-inline-ctrl';
      addOption(el, '', '(not set / NULL)');
      (fkOptions[col] || []).forEach((o) => {
        const opt = addOption(el, String(o.value), o.label === '' ? String(o.value) : o.label);
        if (!nullish && String(value) === String(o.value)) opt.selected = true;
      });
    } else if (isDate) {
      el = document.createElement('input');
      el.type = isDateOnly ? 'date' : (isTimeOnly ? 'time' : 'datetime-local');
      if (isTimeOnly || isTimestamp) el.step = '1';
      el.className = 'field-input !w-64 !py-1.5 !text-[13px] js-inline-ctrl font-mono';
      if (!nullish) el.value = toDateInputValue(String(value), isDateOnly, isTimeOnly);
      setTimeout(() => {
        if (typeof el.showPicker === 'function') {
          try { el.showPicker(); } catch (e) {}
        }
      }, 50);
    } else if (isNum) {
      el = document.createElement('input');
      el.type = 'number';
      const isInteger = type.startsWith('INTEGER') || type === 'INT' || type.startsWith('BIGINT') || type.startsWith('SMALLINT') || type.startsWith('SERIAL');
      el.step = isInteger ? '1' : 'any';
      el.className = 'field-input !w-48 !py-1.5 !text-[13px] js-inline-ctrl font-mono';
      if (!nullish) el.value = String(value);
    } else if (isUuid) {
      el = document.createElement('input');
      el.type = 'text';
      el.className = 'field-input font-mono !w-64 !py-1.5 !text-[12px] js-inline-ctrl';
      el.placeholder = '00000000-0000-0000-0000-000000000000';
      if (!nullish) el.value = String(value);
    } else if (isArray) {
      el = document.createElement('input');
      el.type = 'text';
      el.className = 'field-input font-mono !w-64 !py-1.5 !text-[12px] js-inline-ctrl';
      el.placeholder = '{item1, item2}';
      if (!nullish) el.value = String(value);
    } else if (isInterval) {
      el = document.createElement('input');
      el.type = 'text';
      el.className = 'field-input font-mono !w-64 !py-1.5 !text-[12px] js-inline-ctrl';
      el.placeholder = "e.g. '1 day'";
      if (!nullish) el.value = String(value);
    } else if (isGeometry) {
      el = document.createElement('input');
      el.type = 'text';
      el.className = 'field-input font-mono !w-64 !py-1.5 !text-[12px] js-inline-ctrl';
      el.placeholder = "(x, y)";
      if (!nullish) el.value = String(value);
    } else if (isBit) {
      el = document.createElement('input');
      el.type = 'text';
      el.className = 'field-input font-mono !w-64 !py-1.5 !text-[12px] js-inline-ctrl';
      el.placeholder = "101010";
      if (!nullish) el.value = String(value);
    } else {
      el = document.createElement('input');
      el.type = 'text';
      el.className = 'field-input !w-64 !py-1.5 !text-[13px] js-inline-ctrl';
      el.placeholder = isBlob ? (type === 'BYTEA' ? '\\x… or 0x… hex' : '0x… hex or text') : (isJson ? '{"key":"value"}' : '');
      if (!nullish) el.value = String(value);
    }
    return el;
  }



  function restoreCell(td) {
    renderCellValue(td, td._origNull ? null : td._origValue);
    td.classList.remove('js-editing');
  }

  // ---- Staged cell edits --------------------------------------------------

  const pendingChanges = new Map(); // key: `${pk}::${col}` → staged change

  function stageCell(tr, td, el) {
    const pk = tr.dataset.pk;
    const col = td.dataset.col;
    if (!pk || !col) return;
    const c = colInfo(col);
    if (!c) return;

    let rawValue;
    let setNull = false;
    if (el.type === 'checkbox') {
      rawValue = el.checked ? '1' : '0';
    } else {
      const v = el.value === undefined ? '' : String(el.value);
      if (v === '' || v === '__NULL__') { rawValue = ''; setNull = true; }
      else rawValue = v;
    }

    if (td.dataset.origValue === undefined) {
      td.dataset.origValue = td.dataset.value;
      td.dataset.origNull = td.dataset.null === 'true' ? 'true' : 'false';
    }

    renderCellValue(td, setNull ? null : rawValue);

    pendingChanges.set(pk + '::' + col, {
      td,
      pk,
      col,
      rawValue,
      setNull,
      isPk: isPk(col),
      isFk: !!fkFor(col),
      origValue: td.dataset.origValue,
      origNull: td.dataset.origNull === 'true',
    });

    td.classList.add('cell-dirty');
    updateChangesBar();
  }

  function updateChangesBar() {
    if (!changesBar || !changesCount) return;
    const n = pendingChanges.size;
    changesCount.textContent = String(n);
    changesBar.classList.toggle('hidden', n === 0);
  }

  function applyPending() {
    if (!pendingChanges.size || readonly) return;
    const byRow = new Map();
    for (const ch of pendingChanges.values()) {
      let entry = byRow.get(ch.pk);
      if (!entry) {
        entry = { id: ch.pk, values: {}, nulls: [] };
        byRow.set(ch.pk, entry);
      }
      if (ch.setNull) entry.nulls.push(ch.col);
      else entry.values[ch.col] = ch.rawValue;
    }
    const updates = [...byRow.values()];
    if (applyBtn) applyBtn.disabled = true;
    Api.post('/api/tables/' + t + '/rows/bulk-update', { updates })
      .then((data) => {
        UI.showToast(data.message || 'Changes applied.', 'success');
        window.location.reload();
      })
      .catch((e) => {
        UI.showError(e.message);
        if (applyBtn) applyBtn.disabled = false;
      });
  }

  async function discardPending() {
    const n = pendingChanges.size;
    if (!n) return;
    const confirmed = await UI.confirm({
      title: 'Discard Changes',
      message: 'You have ' + n + ' pending inline edit(s). Are you sure you want to discard all staged changes and revert to the saved values?',
      confirmText: 'Discard ' + n + ' change(s)',
      danger: true,
    });
    if (!confirmed) return;
    for (const ch of pendingChanges.values()) {
      renderCellValue(ch.td, ch.origNull ? null : ch.origValue);
      ch.td.classList.remove('cell-dirty');
      delete ch.td.dataset.origValue;
      delete ch.td.dataset.origNull;
    }
    pendingChanges.clear();
    updateChangesBar();
    UI.showToast('Pending edits discarded.', 'info');
  }

  function openReviewChangesModal() {
    if (!pendingChanges.size) return;
    var overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 opacity-0 transition-opacity duration-200';
    var card = document.createElement('div');
    card.className = 'app-card w-full max-w-3xl overflow-hidden shadow-2xl border border-base-300 transform scale-95 transition-transform duration-200 max-h-[85vh] flex flex-col';

    var rowsHtml = '';
    pendingChanges.forEach((ch, key) => {
      var oldDisplay = ch.origNull ? '<span class="chip chip-null text-[10px]">NULL</span>' : escapeHtml(ch.origValue);
      var newDisplay = ch.setNull ? '<span class="chip chip-null text-[10px]">NULL</span>' : escapeHtml(ch.rawValue);
      rowsHtml += '<tr class="hover:bg-base-200/50">' +
        '<td class="font-mono text-xs font-semibold">' + escapeHtml(ch.pk) + '</td>' +
        '<td class="font-mono text-xs text-primary font-medium">' + escapeHtml(ch.col) + '</td>' +
        '<td class="font-mono text-xs text-error line-through opacity-80 max-w-xs truncate">' + oldDisplay + '</td>' +
        '<td class="font-mono text-xs text-success font-medium max-w-xs truncate">' + newDisplay + '</td>' +
        '<td class="text-right">' +
        '<button type="button" class="btn btn-ghost btn-xs text-warning js-modal-revert-item" data-key="' + escapeHtml(key) + '">Revert</button>' +
        '</td>' +
        '</tr>';
    });

    card.innerHTML =
      '<div class="flex items-center justify-between border-b border-base-200 px-6 py-4">' +
      '  <div class="flex items-center gap-2">' +
      '    <h3 class="text-base font-bold text-base-content">Staged Changes Diff</h3>' +
      '    <span class="chip bg-warning/15 text-warning font-mono">' + pendingChanges.size + ' edit(s)</span>' +
      '  </div>' +
      '  <button type="button" class="btn btn-ghost btn-xs btn-circle js-diff-close text-base-content/40 hover:text-base-content">&times;</button>' +
      '</div>' +
      '<div class="flex-1 overflow-y-auto p-4">' +
      '  <table class="table table-sm">' +
      '    <thead><tr class="text-xs uppercase text-base-content/50"><th>Row PK</th><th>Column</th><th>Original Value</th><th>Staged Value</th><th class="text-right">Action</th></tr></thead>' +
      '    <tbody id="diff-rows-body">' + rowsHtml + '</tbody>' +
      '  </table>' +
      '</div>' +
      '<div class="flex items-center justify-between border-t border-base-200 bg-base-200/30 px-6 py-4">' +
      '  <button type="button" id="diff-modal-discard" class="btn btn-ghost btn-sm text-error">Discard All</button>' +
      '  <div class="flex gap-2">' +
      '    <button type="button" class="btn btn-ghost btn-sm js-diff-close">Cancel</button>' +
      '    <button type="button" id="diff-modal-apply" class="btn btn-primary btn-sm gap-1">' +
      '      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>' +
      '      Apply ' + pendingChanges.size + ' Change(s)' +
      '    </button>' +
      '  </div>' +
      '</div>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
      overlay.classList.remove('opacity-0');
      overlay.classList.add('opacity-100');
      card.classList.remove('scale-95');
      card.classList.add('scale-100');
    });

    function closeDiff() {
      overlay.classList.remove('opacity-100');
      overlay.classList.add('opacity-0');
      card.classList.remove('scale-100');
      card.classList.add('scale-95');
      setTimeout(() => overlay.remove(), 180);
    }

    card.querySelectorAll('.js-diff-close').forEach((b) => b.addEventListener('click', closeDiff));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDiff(); });

    card.querySelectorAll('.js-modal-revert-item').forEach((b) => {
      b.addEventListener('click', () => {
        const key = b.dataset.key;
        const ch = pendingChanges.get(key);
        if (ch) {
          revertCell(ch.td);
          b.closest('tr').remove();
          if (!pendingChanges.size) closeDiff();
        }
      });
    });

    card.querySelector('#diff-modal-apply').addEventListener('click', () => {
      closeDiff();
      applyPending();
    });

    card.querySelector('#diff-modal-discard').addEventListener('click', async () => {
      closeDiff();
      await discardPending();
    });
  }

  function buildChangesBar() {
    const bar = document.createElement('div');
    bar.id = 'changes-bar';
    bar.className =
      'fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-base-300 bg-base-100/95 backdrop-blur-md px-4 py-2.5 shadow-2xl transition-all duration-200 hidden';
    bar.innerHTML =
      '<div class="flex items-center gap-2">' +
      '<span class="relative flex h-2.5 w-2.5"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-75"></span><span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-warning"></span></span>' +
      '<span class="text-sm font-medium text-base-content"><b id="changes-count" class="tabular-nums text-warning font-bold">0</b> pending edit(s)</span>' +
      '</div>' +
      '<div class="h-4 w-px bg-base-300"></div>' +
      '<div class="flex items-center gap-1.5">' +
      '<button type="button" id="changes-review" class="btn btn-ghost btn-sm gap-1.5 text-xs font-medium">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>' +
      'Review Diff</button>' +
      '<button type="button" id="changes-apply" class="btn btn-primary btn-sm gap-1 text-xs font-semibold">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>' +
      'Apply</button>' +
      '<button type="button" id="changes-discard" class="btn btn-ghost btn-sm text-xs text-base-content/60 hover:text-error">Discard</button>' +
      '</div>';
    document.body.appendChild(bar);
    return bar;
  }

  let changesBar = null;
  let changesCount = null;
  let applyBtn = null;

  function beginEdit(td) {
    if (readonly) return;
    if (td.classList.contains('js-editing')) return;
    const tr = td.closest('tr');
    if (!tr || !tr.dataset.pk || !tr.dataset.table) return;
    const c = colInfo(td.dataset.col);
    if (!c) return;

    setFocusedCell(td);

    const open = document.querySelector('.js-editing');
    if (open && open._finish) open._finish(true);

    td._origNull = td.dataset.null === 'true';
    td._origValue = currentCellValue(td);

    const el = createEditor(td);
    if (!el) return;
    td.classList.add('js-editing');
    td.innerHTML = '';
    td.appendChild(el);

    let committed = false;
    const finish = (commit, navigateNext) => {
      if (committed) return;
      committed = true;
      if (commit) stageCell(tr, td, el);
      else restoreCell(td);
      if (navigateNext === 'down') navigateCell('down');
      else if (navigateNext === 'right') navigateCell('right');
      else if (navigateNext === 'left') navigateCell('left');
    };
    td._finish = finish;

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true, 'down');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        finish(true, e.shiftKey ? 'left' : 'right');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });

    if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => finish(true));
    } else if (el.type === 'checkbox') {
      el.addEventListener('change', () => finish(true));
    } else {
      el.addEventListener('blur', () => finish(true));
    }
    el.focus();
    if (typeof el.select === 'function') el.select();
  }

  function getEditableCells() {
    return Array.prototype.slice.call(document.querySelectorAll('#main-table tbody tr td.cell-editable'));
  }

  function navigateCell(direction) {
    if (!focusedCell) {
      const cells = getEditableCells();
      if (cells.length) setFocusedCell(cells[0]);
      return;
    }

    const tr = focusedCell.closest('tr');
    if (!tr) return;
    const rowCells = Array.prototype.slice.call(tr.querySelectorAll('td.cell-editable'));
    const colIdx = rowCells.indexOf(focusedCell);

    if (direction === 'right') {
      if (colIdx < rowCells.length - 1) {
        setFocusedCell(rowCells[colIdx + 1]);
      } else {
        const nextTr = tr.nextElementSibling;
        if (nextTr) {
          const nextCells = Array.prototype.slice.call(nextTr.querySelectorAll('td.cell-editable'));
          if (nextCells.length) setFocusedCell(nextCells[0]);
        }
      }
    } else if (direction === 'left') {
      if (colIdx > 0) {
        setFocusedCell(rowCells[colIdx - 1]);
      } else {
        const prevTr = tr.previousElementSibling;
        if (prevTr) {
          const prevCells = Array.prototype.slice.call(prevTr.querySelectorAll('td.cell-editable'));
          if (prevCells.length) setFocusedCell(prevCells[prevCells.length - 1]);
        }
      }
    } else if (direction === 'down') {
      const nextTr = tr.nextElementSibling;
      if (nextTr) {
        const nextCells = Array.prototype.slice.call(nextTr.querySelectorAll('td.cell-editable'));
        if (nextCells[colIdx]) setFocusedCell(nextCells[colIdx]);
      }
    } else if (direction === 'up') {
      const prevTr = tr.previousElementSibling;
      if (prevTr) {
        const prevCells = Array.prototype.slice.call(prevTr.querySelectorAll('td.cell-editable'));
        if (prevCells[colIdx]) setFocusedCell(prevCells[colIdx]);
      }
    }
  }

  function initInlineEditing() {
    changesBar = buildChangesBar();
    changesCount = document.getElementById('changes-count');
    applyBtn = document.getElementById('changes-apply');
    const discardBtn = document.getElementById('changes-discard');
    const reviewBtn = document.getElementById('changes-review');

    if (applyBtn) applyBtn.addEventListener('click', applyPending);
    if (discardBtn) discardBtn.addEventListener('click', discardPending);
    if (reviewBtn) reviewBtn.addEventListener('click', openReviewChangesModal);

    // Global click listener for table cells and single-cell revert
    document.addEventListener('click', (e) => {
      const revertBtn = e.target.closest('.js-revert-cell');
      if (revertBtn) {
        e.stopPropagation();
        e.preventDefault();
        const td = revertBtn.closest('td');
        if (td) revertCell(td);
        return;
      }

      const td = e.target.closest('td.cell-editable');
      if (td && !td.classList.contains('js-editing')) {
        setFocusedCell(td);
      }
    });

    if (!readonly) {
      document.querySelectorAll('.js-inline-cell').forEach((td) => {
        td.addEventListener('dblclick', () => beginEdit(td));
      });
    }

    // Grid Keyboard Navigation
    document.addEventListener('keydown', (e) => {
      const isEditing = document.querySelector('.js-editing');
      if (isEditing) return;

      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;

      if (!focusedCell) return;

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateCell('right');
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateCell('left');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateCell('down');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateCell('up');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        navigateCell(e.shiftKey ? 'left' : 'right');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!readonly) beginEdit(focusedCell);
      } else if (e.key === 'Escape') {
        clearFocusedCell();
      } else if (e.key === ' ' && !readonly) {
        const col = focusedCell.dataset.col;
        const c = colInfo(col);
        if (c && (c.type || '').toUpperCase() === 'BOOLEAN') {
          e.preventDefault();
          const tr = focusedCell.closest('tr');
          const currentVal = currentCellValue(focusedCell);
          const nextVal = (currentVal === 1 || currentVal === '1' || currentVal === true || currentVal === 'true') ? '0' : '1';
          const fakeEl = { value: nextVal, type: 'checkbox', checked: nextVal === '1' };
          stageCell(tr, focusedCell, fakeEl);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        const val = currentCellValue(focusedCell);
        if (val !== null && val !== undefined) {
          navigator.clipboard.writeText(String(val)).then(() => {
            UI.showToast('Cell value copied.', 'info');
          });
        }
      }
    });
  }

  // ---- Bulk row operations ------------------------------------------------

  function selectedRows() {
    return Array.prototype.slice
      .call(document.querySelectorAll('.row-checkbox:checked'))
      .map((cb) => cb.value)
      .filter(Boolean);
  }

  function initBulk() {
    const bulkBar = document.getElementById('bulk-bar');
    if (!bulkBar) return;
    const selectAll = document.getElementById('select-all-rows');
    const countEl = document.getElementById('bulk-count');
    const deleteBtn = document.getElementById('bulk-delete');
    const exportCsv = document.getElementById('bulk-export-csv');
    const exportJson = document.getElementById('bulk-export-json');
    const clearBtn = document.getElementById('bulk-clear');
    const checkboxes = Array.prototype.slice.call(document.querySelectorAll('.row-checkbox'));

    function update() {
      const ids = selectedRows();
      const n = ids.length;
      if (countEl) countEl.textContent = String(n);
      bulkBar.classList.toggle('hidden', n === 0);
      if (selectAll) selectAll.checked = n > 0 && n === checkboxes.length;
      if (deleteBtn) deleteBtn.disabled = readonly || n === 0;
    }

    checkboxes.forEach((cb) => cb.addEventListener('change', update));
    if (selectAll) {
      selectAll.addEventListener('change', () => {
        checkboxes.forEach((cb) => { cb.checked = selectAll.checked; });
        update();
      });
    }
    if (clearBtn) clearBtn.addEventListener('click', () => {
      checkboxes.forEach((cb) => { cb.checked = false; });
      update();
    });
    if (exportCsv) exportCsv.addEventListener('click', () => bulkExport('csv'));
    if (exportJson) exportJson.addEventListener('click', () => bulkExport('json'));
    if (deleteBtn) deleteBtn.addEventListener('click', bulkDelete);
  }

  async function bulkExport(format) {
    const ids = selectedRows();
    if (!ids.length) return;
    try {
      const data = await Api.post('/api/tables/' + t + '/rows/bulk-export', { ids, format });
      const blob = new Blob([data.content], {
        type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8',
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      UI.showToast('Exported ' + data.rowCount + ' row(s).', 'success');
    } catch (e) {
      UI.showError(e.message);
    }
  }

  async function bulkDelete() {
    const ids = selectedRows();
    if (!ids.length || readonly) return;
    let impact;
    try {
      impact = await Api.post('/api/tables/' + t + '/rows/bulk-impact', { ids });
    } catch (e) {
      UI.showError(e.message);
      return;
    }
    const refs = (impact && impact.references) || [];
    const details = refs.length
      ? '<p class="mb-2 font-medium text-warning">⚠ Other tables reference these records:</p>' +
        '<ul class="mb-2 list-disc space-y-1 pl-5 text-xs">' +
        refs.map((r) =>
          '<li><code class="font-mono font-bold">' + escapeHtml(r.table) + '.' + escapeHtml(r.from) + '</code> — <b class="tabular-nums">' + r.count + '</b> row(s) point at them</li>'
        ).join('') +
        '</ul>' +
        '<p class="text-[11px] text-base-content/55">Depending on foreign key rules, those rows may cascade-delete or block this action.</p>'
      : '<p class="text-xs text-base-content/60">No other tables reference these rows — safe to delete.</p>';

    const confirmed = await UI.confirm({
      title: 'Delete Selected Rows',
      message: 'Delete ' + ids.length + ' selected row(s) from table "' + cfg.table + '"? This action cannot be undone.',
      item: cfg.table,
      itemType: 'Table',
      detailsHtml: details,
      confirmText: 'Delete ' + ids.length + ' row(s)',
      danger: true,
    });
    if (!confirmed) return;

    try {
      const data = await Api.post('/api/tables/' + t + '/rows/bulk-delete', { ids, confirmImpact: true });
      UI.showToast(data.message || 'Rows deleted.', 'success');
      window.location.reload();
    } catch (e) {
      UI.showError(e.message);
    }
  }

  // ---- CSV import ---------------------------------------------------------

  function initImport() {
    const importBtn = document.getElementById('import-csv');
    const importPanel = document.getElementById('import-panel');
    const importClose = document.getElementById('import-csv-close');
    const importText = document.getElementById('import-csv-text');
    const importFile = document.getElementById('import-csv-file');
    const importSubmit = document.getElementById('import-csv-submit');

    if (importBtn && importPanel) {
      importBtn.addEventListener('click', () => {
        importPanel.classList.toggle('hidden');
        if (!importPanel.classList.contains('hidden')) importText.focus();
      });
    }
    if (importClose) {
      importClose.addEventListener('click', () => importPanel.classList.add('hidden'));
    }
    if (importFile) {
      importFile.addEventListener('change', () => {
        const file = importFile.files && importFile.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => { importText.value = String(reader.result || ''); };
        reader.readAsText(file);
      });
    }
    if (importSubmit && importText) {
      importSubmit.addEventListener('click', async () => {
        const csv = importText.value.trim();
        if (!csv) return UI.showError('Paste or choose a CSV file first.');
        const m = window.location.pathname.match(/\/tables\/([^/]+)(?:\/|$)/);
        const table = m ? decodeURIComponent(m[1]) : '';
        if (!table) return UI.showError('Could not determine the table.');
        importSubmit.disabled = true;
        try {
          const data = await Api.post('/api/tables/' + encodeURIComponent(table) + '/rows/import', { csv });
          UI.showToast(data.message || 'Import complete.', 'success');
          window.location.reload();
        } catch (e) {
          UI.showError(e.message);
        } finally {
          importSubmit.disabled = false;
        }
      });
    }
  }

  // ---- Related rows (Neon-style per-row expander) -------------------------

  function rotateChevron(btn, open) {
    const chev = btn.querySelector('.js-ref-chevron');
    if (chev) chev.classList.toggle('rotate-180', open);
  }

  let refOpenBtn = null;

  function closeRefPop() {
    const pop = document.querySelector('.js-ref-pop');
    if (pop) {
      if (pop._cleanup) pop._cleanup();
      pop.remove();
    }
    if (refOpenBtn) {
      rotateChevron(refOpenBtn, false);
      refOpenBtn.setAttribute('aria-expanded', 'false');
      refOpenBtn.classList.remove('opacity-50');
      refOpenBtn = null;
    }
  }

  function renderMiniTable(ref, basePath) {
    const href = basePath + '/tables/' + encodeURIComponent(ref.table);
    const count = ref.count ?? ref.total ?? (ref.rows ? ref.rows.length : 0);
    const columns = ref.columns || (ref.rows && ref.rows.length > 0 ? Object.keys(ref.rows[0]).filter((k) => k !== '_rowid_') : []);
    let html =
      '<div class="flex items-center justify-between gap-2 border-b border-base-200 px-3 py-2">' +
      '<span class="min-w-0 truncate">' +
      '<a class="link link-primary font-mono text-xs font-semibold" href="' + href + '">' + escapeHtml(ref.table) + '</a>' +
      '<span class="ml-1.5 text-xs text-base-content/45">via <code class="font-mono">' + escapeHtml(ref.from) + '</code>' + (ref.value !== undefined ? ' = <code class="font-mono">' + escapeHtml(String(ref.value)) + '</code>' : '') + '</span>' +
      '</span>' +
      '<span class="chip ' + (count ? 'chip-pk' : 'chip-type') + '">' + escapeHtml(count + ' row' + (count === 1 ? '' : 's')) + '</span>' +
      '</div>';

    if (!ref.rows || !ref.rows.length || !columns.length) {
      return html + '<div class="px-3 py-3 text-xs text-base-content/45">No matching rows.</div>';
    }

    const thead = '<tr>' + columns.map(function (c) {
      return '<th class="whitespace-nowrap px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-base-content/50"><span class="font-mono normal-case">' + escapeHtml(c) + '</span></th>';
    }).join('') + '</tr>';
    const tbody = ref.rows.map(function (r) {
      return '<tr class="border-t border-base-200/60 hover:bg-primary/[0.04]">' + columns.map(function (c) {
        const v = r[c];
        if (v === null || v === undefined) return '<td class="px-2.5 py-1.5 align-middle"><span class="text-[11px] text-base-content/40">NULL</span></td>';
        const s = String(v);
        const short = s.length > 120 ? s.slice(0, 120) + '…' : s;
        return '<td class="max-w-[180px] truncate px-2.5 py-1.5 align-middle font-mono text-[11px] text-base-content/80" title="' + escapeHtml(s) + '">' + escapeHtml(short) + '</td>';
      }).join('') + '</tr>';
    }).join('');

    return html +
      '<div class="max-h-64 overflow-auto">' +
      '<table class="w-full"><thead><tr class="bg-base-200/40">' + thead + '</tr></thead>' +
      '<tbody>' + tbody + '</tbody></table>' +
      '</div>' +
      '<div class="flex justify-end border-t border-base-200 px-3 py-1.5">' +
      '<a class="btn btn-ghost btn-xs text-base-content/60 hover:text-primary" href="' + href + '">Open table</a>' +
      '</div>';
  }

  function showRefPop(btn, refs) {
    closeRefPop();
    const pop = document.createElement('div');
    pop.className = 'js-ref-pop app-card js-ref-anim z-50 min-w-[280px] max-w-[460px] overflow-hidden shadow-lift';
    pop.innerHTML = refs.length
      ? refs.map((ref) => renderMiniTable(ref, base)).join('<div class="h-px bg-base-200"></div>')
      : '<div class="px-4 py-3 text-sm text-base-content/45">No related rows for this record.</div>';

    pop.style.visibility = 'hidden';
    document.body.appendChild(pop);
    const pad = 8;
    const popW = Math.min(460, Math.max(280, pop.offsetWidth));
    const popH = pop.offsetHeight;

    const rect = btn.getBoundingClientRect();
    let left = rect.left;
    if (left + popW > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - popW - pad);
    let top = rect.bottom + 6;
    if (top + popH > window.innerHeight - pad) top = Math.max(pad, rect.top - popH - 6);

    pop.style.position = 'fixed';
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.style.visibility = 'visible';
    refOpenBtn = btn;

    // Close when the page behind the popover scrolls or the window resizes,
    // but NOT when the nested table's own scroll container is scrolled — the
    // capture-phase listener fires for every scroll target, including the
    // mini-table inside the popover, which would otherwise close it instantly.
    const onViewChange = (e) => {
      if (e && e.target && pop.contains(e.target)) return;
      closeRefPop();
    };
    window.addEventListener('scroll', onViewChange, true);
    window.addEventListener('resize', onViewChange);
    const onClickOutside = (e) => {
      if (!pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeRefPop();
    };
    document.addEventListener('click', onClickOutside, true);
    const onKey = (e) => { if (e.key === 'Escape') closeRefPop(); };
    document.addEventListener('keydown', onKey);

    pop._cleanup = () => {
      window.removeEventListener('scroll', onViewChange, true);
      window.removeEventListener('resize', onViewChange);
      document.removeEventListener('click', onClickOutside, true);
      document.removeEventListener('keydown', onKey);
    };
  }

  function initRefToggles() {
    document.querySelectorAll('.js-ref-toggle').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = btn.getAttribute('aria-expanded') === 'true';
        if (open) {
          closeRefPop();
          return;
        }
        const table = btn.dataset.table;
        const pk = btn.dataset.pk;
        if (!table || !pk) return;
        btn.classList.add('opacity-50');
        Api.get('/api/tables/' + encodeURIComponent(table) + '/rows/' + encodeURIComponent(pk) + '/references')
          .then((data) => {
            btn.classList.remove('opacity-50');
            const refTable = btn.dataset.refTable;
            const refs = ((data && data.references) || []).filter((r) => !refTable || r.table === refTable);
            btn.setAttribute('aria-expanded', 'true');
            rotateChevron(btn, true);
            showRefPop(btn, refs);
          })
          .catch((e) => {
            btn.classList.remove('opacity-50');
            UI.showError(e.message);
          });
      });
    });
  }

  // ---- Cell Inspector Trigger --------------------------------------------

  function initCellInspector() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.js-inspect-btn');
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      const td = btn.closest('td');
      const tr = btn.closest('tr');
      if (!td || !tr) return;

      const col = td.dataset.col;
      const isNull = td.dataset.null === 'true';
      const val = td.dataset.value;
      const pk = tr.dataset.pk;
      const table = tr.dataset.table || cfg.table;
      const isBlob = td.dataset.blob === 'true';
      const isJson = td.dataset.json === 'true';
      const colType = td.dataset.type || (colInfo(col)?.type ?? '');

      if (window.Inspector && window.Inspector.open) {
        window.Inspector.open({
          table,
          pk,
          col,
          colType,
          value: val,
          isNull,
          isBlob,
          isJson,
          readonly,
          onSave: (newVal) => {
            if (!readonly) {
              const fakeEl = { value: newVal, type: 'text' };
              stageCell(tr, td, fakeEl);
            }
          },
        });
      }
    });
  }



  // ---- Row Quick Actions --------------------------------------------------

  function initRowActions() {
    // Copy Row as JSON
    document.querySelectorAll('.js-row-copy-json').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tr = btn.closest('tr');
        if (!tr) return;
        const rowData = {};
        tr.querySelectorAll('td.cell-editable').forEach((td) => {
          const col = td.dataset.col;
          if (col) {
            rowData[col] = td.dataset.null === 'true' ? null : td.dataset.value;
          }
        });
        navigator.clipboard.writeText(JSON.stringify(rowData, null, 2)).then(() => {
          UI.showToast('Row copied as JSON.', 'success');
        });
      });
    });

    // Copy Row as SQL INSERT
    document.querySelectorAll('.js-row-copy-sql').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tr = btn.closest('tr');
        if (!tr) return;
        const cols = [];
        const vals = [];
        tr.querySelectorAll('td.cell-editable').forEach((td) => {
          const col = td.dataset.col;
          if (col) {
            cols.push('"' + col.replace(/"/g, '""') + '"');
            if (td.dataset.null === 'true') {
              vals.push('NULL');
            } else {
              const v = td.dataset.value;
              vals.push("'" + String(v).replace(/'/g, "''") + "'");
            }
          }
        });
        const sql = 'INSERT INTO "' + cfg.table.replace(/"/g, '""') + '" (' + cols.join(', ') + ') VALUES (' + vals.join(', ') + ');';
        navigator.clipboard.writeText(sql).then(() => {
          UI.showToast('SQL INSERT copied to clipboard.', 'success');
        });
      });
    });

    // Duplicate Row
    document.querySelectorAll('.js-row-duplicate').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pk = btn.dataset.pk;
        if (!pk) return;
        window.location.href = base + '/tables/' + t + '/rows/new?duplicate=' + encodeURIComponent(pk);
      });
    });

    // Auto-position dropdown (dropdown-top if near bottom)
    document.querySelectorAll('.dropdown').forEach((dd) => {
      const btn = dd.querySelector('label[role="button"]') || dd.querySelector('button');
      if (!btn) return;
      btn.addEventListener('click', () => {
        const rect = btn.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        dd.classList.toggle('dropdown-top', spaceBelow < 220);
      });
    });
  }

  // ---- Init ---------------------------------------------------------------

  async function init() {
    try {
      info = await Api.get('/api/tables/' + t + '/info');
    } catch (e) {
      info = null;
    }
    try {
      fkOptions = await Api.get('/api/tables/' + t + '/fk-options');
    } catch (e) {
      fkOptions = {};
    }
    initFilters();
    initRowActions();
    initInlineEditing();
    initCellInspector();
    initBulk();
    initRowDelete();
    initPageSize();
    initImport();
    initRefToggles();
  }

  init();
})();
