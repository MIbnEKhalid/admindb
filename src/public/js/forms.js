/* Dynamic insert/edit row form.
 * The form is built entirely from column metadata returned by the API, so the
 * same page handles every table. Supports run mode and "get query" preview. */
(function () {
  'use strict';
  const cfgEl = document.getElementById('form-config');
  if (!cfgEl) return;

  const cfg = JSON.parse(cfgEl.textContent);
  const form = document.getElementById('row-fields');
  const errorBox = document.getElementById('form-error');
  const sqlBox = document.getElementById('generated-sql');
  const sqlCode = document.getElementById('generated-sql-code');
  const submitBtn = document.getElementById('row-submit');
  const generateBtn = document.getElementById('row-generate');
  const copyBtn = document.getElementById('copy-sql');
  const dbId = encodeURIComponent((window.APP && window.APP.dbId) || (cfg && cfg.dbId) || '');
  const t = encodeURIComponent(cfg.table);

  let info = null;
  let record = null;
  let fkOptions = {};

  const escapeHtml = window.Utils ? window.Utils.escapeHtml : function(s) { return String(s == null ? '' : s); };

  const toLocalInput = window.Utils && window.Utils.toLocalInput ? window.Utils.toLocalInput : function(v) { return v == null ? '' : String(v); };
  const toLocalNow = window.Utils && window.Utils.toLocalNow ? window.Utils.toLocalNow : function() { return new Date().toISOString(); };

  function generateUuidV4() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Convert a column's raw default expression (dflt_value) into a form-friendly
   * value. Handles literals we can read safely; anything complex returns null.
   */
  function defaultToValue(col, dflt) {
    if (dflt === null || dflt === undefined) return null;
    let s = String(dflt).trim();
    if (s === '' || /^null$/i.test(s)) return null;

    // Strip PostgreSQL type casts, e.g. 'active'::character varying, 0::bigint, true
    s = s.replace(/::[a-zA-Z0-9_\s"\[\]]+$/i, '').trim();

    const type = (col.type || '').toUpperCase();

    // Single-quoted string literal, e.g. 'N/A', 'user'
    const str = s.match(/^'(.*)'$/s);
    if (str) return str[1].replace(/''/g, "'");

    // Numeric literal, e.g. 0, 42, 3.14
    if (/^[-+]?\d+(\.\d+)?$/.test(s)) return Number(s);

    // Boolean literal
    if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);

    // UUID generators
    if (type === 'UUID' && /gen_random_uuid|uuid_generate/i.test(s)) {
      return generateUuidV4();
    }

    // BOOLEAN columns stored as 0/1 or true/false
    if (type === 'BOOLEAN' || type === 'BOOL') {
      if (s === '1' || /^true$/i.test(s)) return 1;
      if (s === '0' || /^false$/i.test(s)) return 0;
    }

    // current-timestamp / now() style defaults
    if ((type === 'DATE' || type === 'DATETIME' || type.includes('TIMESTAMP')) && /current_timestamp|now\s*\(|datetime\s*\(|date\s*\(|clock_timestamp|statement_timestamp|transaction_timestamp/i.test(s)) {
      return toLocalNow(type === 'DATE', false);
    }
    if ((type === 'TIME' || type === 'TIMETZ') && /current_time|now\s*\(|time\s*\(/i.test(s)) {
      return toLocalNow(false, true);
    }

    return null;
  }

  /** Value to pre-fill a control with: edit → the record's value; insert → the column default. */
  function initialValue(col) {
    if (cfg.mode === 'edit' && record) return record[col.name];
    if (cfg.mode === 'insert') return defaultToValue(col, col.dflt_value);
    return null;
  }

  function isTruthy(v) {
    return v === 1 || v === true || v === '1' || v === 'true';
  }

  // ---- Widgets --------------------------------------------------------------

  function createCalendarWidget(colName, colType, iv, isPk) {
    const type = (colType || '').toUpperCase();
    const isDateOnly = type === 'DATE';
    const isTimeOnly = type === 'TIME' || type === 'TIMETZ' || type.startsWith('TIME ') || type.startsWith('TIME(');
    const isTimestamp = type === 'DATETIME' || type.includes('TIMESTAMP');

    const container = document.createElement('div');
    container.className = 'space-y-1';

    const inputRow = document.createElement('div');
    inputRow.className = 'flex items-center gap-1.5';

    const input = document.createElement('input');
    input.type = isDateOnly ? 'date' : (isTimeOnly ? 'time' : 'datetime-local');
    if (isTimeOnly || isTimestamp) input.step = '1';
    input.className = 'field-input flex-1 font-mono text-[13px]';
    input.dataset.column = colName;
    if (iv != null) input.value = toLocalInput(iv, type);

    const formatLabel = document.createElement('div');
    formatLabel.className = 'text-[11px] text-base-content/50 font-mono transition-all';
    function updateLabel() {
      if (!input.value) {
        formatLabel.textContent = '(empty / NULL)';
        return;
      }
      try {
        if (isDateOnly) {
          const parts = input.value.split('-');
          const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
          formatLabel.textContent = '📅 ' + dt.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
        } else if (isTimeOnly) {
          formatLabel.textContent = '⏰ ' + input.value;
        } else {
          const dt = new Date(input.value);
          if (!isNaN(dt.getTime())) {
            formatLabel.textContent = '📅 ' + dt.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
          } else {
            formatLabel.textContent = input.value;
          }
        }
      } catch (e) {
        formatLabel.textContent = input.value;
      }
    }
    input.addEventListener('input', updateLabel);
    input.addEventListener('change', updateLabel);
    updateLabel();

    const dd = document.createElement('div');
    dd.className = 'dropdown dropdown-end';

    const ddBtn = document.createElement('button');
    ddBtn.type = 'button';
    ddBtn.tabIndex = 0;
    ddBtn.className = 'btn btn-ghost btn-sm btn-square text-primary hover:bg-primary/10 transition';
    ddBtn.title = 'Open calendar selector & presets';
    ddBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>';

    const ddMenu = document.createElement('ul');
    ddMenu.tabIndex = 0;
    ddMenu.className = 'dropdown-content z-50 menu p-2 shadow-2xl bg-base-100 rounded-xl w-56 border border-base-300 text-xs space-y-0.5';

    function addPreset(label, icon, onClick) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'flex items-center gap-2 py-1.5 font-medium';
      btn.innerHTML = '<span>' + icon + '</span><span>' + label + '</span>';
      btn.addEventListener('click', () => {
        onClick();
        updateLabel();
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
      });
      li.appendChild(btn);
      ddMenu.appendChild(li);
    }

    addPreset('Open Picker', '📅', () => {
      if (typeof input.showPicker === 'function') {
        try { input.showPicker(); } catch (e) { input.focus(); }
      } else {
        input.focus();
      }
    });

    if (isTimeOnly) {
      addPreset('Now', '⚡', () => { input.value = toLocalNow(false, true); });
      addPreset('Start of Hour', '⏱️', () => {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        input.value = p(d.getHours()) + ':00:00';
      });
    } else if (isDateOnly) {
      addPreset('Today', '⚡', () => { input.value = toLocalNow(true, false); });
      addPreset('Yesterday', '⏪', () => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        const p = (n) => String(n).padStart(2, '0');
        input.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      });
      addPreset('Tomorrow', '⏩', () => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        const p = (n) => String(n).padStart(2, '0');
        input.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      });
      addPreset('+7 Days (1 Week)', '🗓️', () => {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        const p = (n) => String(n).padStart(2, '0');
        input.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      });
      addPreset('+30 Days (1 Month)', '📆', () => {
        const d = new Date();
        d.setDate(d.getDate() + 30);
        const p = (n) => String(n).padStart(2, '0');
        input.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      });
    } else {
      addPreset('Now', '⚡', () => { input.value = toLocalNow(false, false); });
      addPreset('Today (Start of Day)', '🌅', () => {
        input.value = toLocalNow(true, false) + 'T00:00:00';
      });
      addPreset('Today (End of Day)', '🌃', () => {
        input.value = toLocalNow(true, false) + 'T23:59:59';
      });
      addPreset('Yesterday', '⏪', () => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        const p = (n) => String(n).padStart(2, '0');
        input.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      });
      addPreset('Tomorrow', '⏩', () => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        const p = (n) => String(n).padStart(2, '0');
        input.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      });
      addPreset('+7 Days (1 Week)', '🗓️', () => {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        const p = (n) => String(n).padStart(2, '0');
        input.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      });
    }

    const divider = document.createElement('li');
    divider.className = 'border-t border-base-200 my-1';
    ddMenu.appendChild(divider);

    addPreset('Clear / Set NULL', '🧹', () => { input.value = ''; });

    dd.appendChild(ddBtn);
    dd.appendChild(ddMenu);

    inputRow.appendChild(input);
    inputRow.appendChild(dd);
    container.appendChild(inputRow);
    container.appendChild(formatLabel);

    if (isPk && cfg.mode === 'edit') input.disabled = true;
    return container;
  }

  function createArrayWidget(colName, colType, iv, isPk) {
    const container = document.createElement('div');
    container.className = 'space-y-2';

    const hiddenInput = document.createElement('input');
    hiddenInput.type = 'hidden';
    hiddenInput.dataset.column = colName;

    let items = [];
    if (Array.isArray(iv)) {
      items = iv.map(String);
    } else if (typeof iv === 'string' && iv.trim().startsWith('{') && iv.trim().endsWith('}')) {
      const inner = iv.trim().slice(1, -1);
      items = inner ? inner.split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1')) : [];
    } else if (typeof iv === 'string' && iv.trim().startsWith('[') && iv.trim().endsWith(']')) {
      try {
        const parsed = JSON.parse(iv);
        if (Array.isArray(parsed)) items = parsed.map(String);
      } catch (e) {
        items = [];
      }
    } else if (iv != null && String(iv).trim() !== '') {
      items = [String(iv)];
    }

    function sync() {
      hiddenInput.value = items.length ? '{' + items.map((x) => (x.includes(',') || x.includes('"') ? '"' + x.replace(/"/g, '\\"') + '"' : x)).join(',') + '}' : '';
      renderChips();
    }

    const chipsContainer = document.createElement('div');
    chipsContainer.className = 'flex flex-wrap gap-1.5 min-h-[32px] p-1.5 rounded-lg border border-base-300 bg-base-100';

    function renderChips() {
      chipsContainer.innerHTML = '';
      if (!items.length) {
        chipsContainer.innerHTML = '<span class="text-xs text-base-content/40 italic self-center px-1.5">No array items (empty / NULL)</span>';
        return;
      }
      items.forEach((item, idx) => {
        const chip = document.createElement('span');
        chip.className = 'inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-xs font-mono font-medium text-primary';
        chip.innerHTML = '<span>' + escapeHtml(item) + '</span><button type="button" class="text-primary hover:text-error ml-1 font-bold">&times;</button>';
        chip.querySelector('button').addEventListener('click', () => {
          items.splice(idx, 1);
          sync();
        });
        chipsContainer.appendChild(chip);
      });
    }

    const addRow = document.createElement('div');
    addRow.className = 'flex gap-1.5';
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'field-input flex-1 font-mono text-xs';
    textInput.placeholder = 'Type item and press Enter or click Add…';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-ghost btn-xs text-primary font-medium';
    addBtn.textContent = '+ Add Item';

    function addItem() {
      const val = textInput.value.trim();
      if (val) {
        if (val.includes(',')) {
          val.split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => items.push(x));
        } else {
          items.push(val);
        }
        textInput.value = '';
        sync();
      }
    }

    addBtn.addEventListener('click', addItem);
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addItem();
      }
    });

    addRow.appendChild(textInput);
    addRow.appendChild(addBtn);

    container.appendChild(hiddenInput);
    container.appendChild(chipsContainer);
    container.appendChild(addRow);
    sync();

    if (isPk && cfg.mode === 'edit') textInput.disabled = true;
    return container;
  }

  function createUuidWidget(colName, iv, isPk) {
    const uuidWrap = document.createElement('div');
    uuidWrap.className = 'space-y-1';

    const inputRow = document.createElement('div');
    inputRow.className = 'flex items-center gap-1.5';

    const control = document.createElement('input');
    control.type = 'text';
    control.className = 'field-input font-mono text-xs flex-1';
    control.placeholder = '00000000-0000-0000-0000-000000000000';
    control.dataset.column = colName;
    if (iv != null) control.value = String(iv);

    const validBadge = document.createElement('span');
    validBadge.className = 'text-[10px] font-mono transition-all text-base-content/40';

    function checkUuid() {
      const v = control.value.trim();
      if (!v) {
        validBadge.textContent = '';
        return;
      }
      const isOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
      if (isOk) {
        validBadge.className = 'text-[10px] font-mono text-success font-semibold';
        validBadge.textContent = '✓ Valid UUID v4';
      } else {
        validBadge.className = 'text-[10px] font-mono text-warning';
        validBadge.textContent = '⚠ Custom format';
      }
    }
    control.addEventListener('input', checkUuid);
    checkUuid();

    const genBtn = document.createElement('button');
    genBtn.type = 'button';
    genBtn.className = 'btn btn-ghost btn-xs gap-1 text-primary text-xs shrink-0';
    genBtn.innerHTML = '✨ Gen UUID';
    genBtn.addEventListener('click', () => {
      control.value = generateUuidV4();
      checkUuid();
    });

    inputRow.appendChild(control);
    inputRow.appendChild(genBtn);
    uuidWrap.appendChild(inputRow);
    uuidWrap.appendChild(validBadge);

    if (isPk && cfg.mode === 'edit') control.disabled = true;
    return uuidWrap;
  }

  function createJsonWidget(colName, colType, iv, isPk) {
    const jsonContainer = document.createElement('div');
    jsonContainer.className = 'space-y-1.5';

    const control = document.createElement('textarea');
    control.rows = 4;
    control.className = 'field-input font-mono text-[13px] w-full';
    control.placeholder = '{\n  "key": "value"\n}';
    control.dataset.column = colName;
    if (iv != null) control.value = typeof iv === 'object' ? JSON.stringify(iv, null, 2) : String(iv);

    const btnRow = document.createElement('div');
    btnRow.className = 'flex items-center justify-between text-xs';

    const statusBadge = document.createElement('span');
    statusBadge.className = 'font-mono text-[11px] text-base-content/40';

    function validateJson() {
      const v = control.value.trim();
      if (!v) {
        statusBadge.textContent = '(empty / NULL)';
        statusBadge.className = 'font-mono text-[11px] text-base-content/40';
        return;
      }
      try {
        JSON.parse(v);
        statusBadge.textContent = '✓ Valid JSON';
        statusBadge.className = 'font-mono text-[11px] text-success font-semibold';
      } catch (e) {
        statusBadge.textContent = '✗ Invalid JSON syntax';
        statusBadge.className = 'font-mono text-[11px] text-error font-medium';
      }
    }
    control.addEventListener('input', validateJson);
    validateJson();

    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-1';

    const formatBtn = document.createElement('button');
    formatBtn.type = 'button';
    formatBtn.className = 'btn btn-ghost btn-xs text-xs';
    formatBtn.textContent = 'Beautify';
    formatBtn.addEventListener('click', () => {
      try {
        const parsed = JSON.parse(control.value);
        control.value = JSON.stringify(parsed, null, 2);
        validateJson();
      } catch (e) { UI.showError('Invalid JSON: ' + e.message); }
    });

    const minifyBtn = document.createElement('button');
    minifyBtn.type = 'button';
    minifyBtn.className = 'btn btn-ghost btn-xs text-xs';
    minifyBtn.textContent = 'Minify';
    minifyBtn.addEventListener('click', () => {
      try {
        const parsed = JSON.parse(control.value);
        control.value = JSON.stringify(parsed);
        validateJson();
      } catch (e) { UI.showError('Invalid JSON: ' + e.message); }
    });

    const inspectBtn = document.createElement('button');
    inspectBtn.type = 'button';
    inspectBtn.className = 'btn btn-ghost btn-xs gap-1 text-primary text-xs font-semibold';
    inspectBtn.innerHTML = '🧩 Inspector';
    inspectBtn.addEventListener('click', () => {
      if (window.Inspector && window.Inspector.open) {
        window.Inspector.open({
          table: cfg.table,
          pk: cfg.pk || '',
          col: colName,
          colType: colType,
          value: control.value,
          isNull: !control.value,
          isJson: true,
          readonly: false,
          onSave: (newVal) => {
            control.value = newVal;
            validateJson();
          },
        });
      }
    });

    actions.appendChild(formatBtn);
    actions.appendChild(minifyBtn);
    actions.appendChild(inspectBtn);

    btnRow.appendChild(statusBadge);
    btnRow.appendChild(actions);

    jsonContainer.appendChild(control);
    jsonContainer.appendChild(btnRow);
    if (isPk && cfg.mode === 'edit') control.disabled = true;
    return jsonContainer;
  }

  function renderField(col) {
    const isPk = info.primaryKey.indexOf(col.name) !== -1;
    const wrapper = document.createElement('div');
    wrapper.className = 'space-y-1.5';

    const label = document.createElement('label');
    label.className = 'field-label';
    label.innerHTML =
      '<span>' + escapeHtml(col.name) + '</span>' +
      (col.notnull ? '<span class="text-error">*</span>' : '') +
      (isPk ? '<span class="chip chip-pk">PK</span>' : '') +
      (col.type ? '<span class="chip chip-type">' + escapeHtml(col.type) + '</span>' : '') +
      (cfg.mode === 'insert' && col.dflt_value ? '<span class="chip chip-type">default</span>' : '');
    wrapper.appendChild(label);

    const fk = info.foreignKeys.find((f) => f.from === col.name);
    const type = (col.type || '').toUpperCase();
    const isBool = type === 'BOOLEAN' || type === 'BOOL';
    const isNum = type.startsWith('INT') || type === 'REAL' || type === 'NUMERIC' || type.startsWith('DECIMAL') || type === 'FLOAT' || type === 'DOUBLE' || type.startsWith('BIGINT') || type.startsWith('SMALLINT') || type.startsWith('SERIAL') || type === 'MONEY';
    const isBlob = type === 'BLOB' || type === 'BYTEA' || type === 'BINARY';
    const isDate = type === 'DATE';
    const isTime = type === 'TIME' || type === 'TIMETZ' || type.startsWith('TIME ') || type.startsWith('TIME(');
    const isTimestamp = type === 'DATETIME' || type.includes('TIMESTAMP');
    const isUuid = type === 'UUID';
    const isJson = type.includes('JSON') || col.name.toLowerCase().includes('json');
    const isArray = type.endsWith('[]') || type.startsWith('_') || type.includes('ARRAY');
    const isInet = type === 'INET' || type === 'CIDR' || type === 'MACADDR' || type === 'MACADDR8';
    const isInterval = type === 'INTERVAL';
    const isGeometry = type === 'POINT' || type === 'GEOMETRY' || type === 'BOX' || type === 'CIRCLE' || type === 'POLYGON';
    const isBit = type === 'BIT' || type === 'VARBIT' || type.startsWith('BIT(') || type.startsWith('VARBIT(');
    const iv = initialValue(col);

    let control;
    if (isBool) {
      const boolWrap = document.createElement('label');
      boolWrap.className = 'flex cursor-pointer items-center gap-2 pt-1';
      control = document.createElement('input');
      control.type = 'checkbox';
      control.className = 'field-check';
      control.dataset.column = col.name;
      if (isTruthy(iv)) control.checked = true;
      const span = document.createElement('span');
      span.className = 'text-sm text-base-content/70';
      span.textContent = 'True / Enabled';
      boolWrap.appendChild(control);
      boolWrap.appendChild(span);
      wrapper.appendChild(boolWrap);
      return wrapper;
    } else if (fk) {
      control = document.createElement('select');
      control.className = 'field-select';
      control.dataset.column = col.name;
      const opts = fkOptions[col.name] || [];
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '(not set)';
      control.appendChild(empty);
      opts.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = String(o.value);
        opt.textContent = o.label === '' ? String(o.value) : o.label;
        if (iv != null && String(iv) === String(o.value)) opt.selected = true;
        control.appendChild(opt);
      });
    } else if (isDate || isTime || isTimestamp) {
      const calWidget = createCalendarWidget(col.name, col.type, iv, isPk);
      wrapper.appendChild(calWidget);
      return wrapper;
    } else if (isArray) {
      const arrWidget = createArrayWidget(col.name, col.type, iv, isPk);
      wrapper.appendChild(arrWidget);
      return wrapper;
    } else if (isUuid) {
      const uuidWidget = createUuidWidget(col.name, iv, isPk);
      wrapper.appendChild(uuidWidget);
      return wrapper;
    } else if (isJson || (iv && typeof iv === 'object')) {
      const jsonWidget = createJsonWidget(col.name, col.type, iv, isPk);
      wrapper.appendChild(jsonWidget);
      return wrapper;
    } else if (isInterval) {
      const intWrap = document.createElement('div');
      intWrap.className = 'space-y-1.5';
      control = document.createElement('input');
      control.type = 'text';
      control.className = 'field-input font-mono text-xs';
      control.placeholder = "e.g. '1 day', '02:30:00', '1 month 2 days'";
      control.dataset.column = col.name;
      if (iv != null) control.value = String(iv);
      const presets = document.createElement('div');
      presets.className = 'flex flex-wrap gap-1';
      ['1 day', '1 week', '1 month', '1 year', '1 hour', '30 mins'].forEach((preset) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost btn-xs text-[11px] font-mono';
        btn.textContent = preset;
        btn.addEventListener('click', () => { control.value = preset; });
        presets.appendChild(btn);
      });
      intWrap.appendChild(control);
      intWrap.appendChild(presets);
      if (isPk && cfg.mode === 'edit') control.disabled = true;
      wrapper.appendChild(intWrap);
      return wrapper;
    } else if (isGeometry) {
      control = document.createElement('input');
      control.type = 'text';
      control.className = 'field-input font-mono text-xs';
      control.placeholder = "(x, y) e.g. '(12.345, 67.890)'";
      control.dataset.column = col.name;
      if (iv != null) control.value = String(iv);
    } else if (isBit) {
      control = document.createElement('input');
      control.type = 'text';
      control.className = 'field-input font-mono text-xs';
      control.placeholder = "Binary e.g. '101010'";
      control.dataset.column = col.name;
      if (iv != null) control.value = String(iv);
    } else if (isInet) {
      control = document.createElement('input');
      control.type = 'text';
      control.className = 'field-input font-mono text-xs';
      control.placeholder = type === 'MACADDR' ? '08:00:2b:01:02:03' : '192.168.1.1 or 2001:db8::1';
      control.dataset.column = col.name;
      if (iv != null) control.value = String(iv);
    } else if (isNum) {
      control = document.createElement('input');
      control.type = 'number';
      const isInteger = type.startsWith('INTEGER') || type === 'INT' || type.startsWith('BIGINT') || type.startsWith('SMALLINT') || type.startsWith('SERIAL');
      control.step = isInteger ? '1' : 'any';
      control.className = 'field-input font-mono';
      control.dataset.column = col.name;
      if (type.startsWith('SERIAL') && cfg.mode === 'insert' && (iv == null || iv === '')) {
        control.placeholder = '(auto-increment serial)';
      }
      if (iv != null) control.value = String(iv);
    } else if (isBlob) {
      const blobContainer = document.createElement('div');
      blobContainer.className = 'space-y-2';

      control = document.createElement('input');
      control.type = 'text';
      control.className = 'field-input font-mono text-xs';
      control.placeholder = type === 'BYTEA' ? '\\x… or 0x… hex' : '0x… hex or plain text';
      control.dataset.column = col.name;
      if (iv != null) control.value = String(iv);

      const fileRow = document.createElement('div');
      fileRow.className = 'flex flex-wrap items-center gap-2';

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.className = 'file-input file-input-bordered file-input-xs w-full max-w-xs';

      const previewThumb = document.createElement('img');
      previewThumb.className = 'h-7 max-w-12 rounded object-cover border border-base-300 bg-base-200 hidden';

      fileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const arrBuffer = reader.result;
          const bytes = new Uint8Array(arrBuffer);
          let hex = type === 'BYTEA' ? '\\x' : '0x';
          for (let i = 0; i < bytes.length; i++) {
            hex += ('00' + bytes[i].toString(16)).slice(-2);
          }
          control.value = hex;

          if (file.type.startsWith('image/')) {
            const dataUrlReader = new FileReader();
            dataUrlReader.onload = () => {
              previewThumb.src = dataUrlReader.result;
              previewThumb.classList.remove('hidden');
            };
            dataUrlReader.readAsDataURL(file);
          } else {
            previewThumb.classList.add('hidden');
          }
        };
        reader.readAsArrayBuffer(file);
      });

      fileRow.appendChild(fileInput);
      fileRow.appendChild(previewThumb);
      blobContainer.appendChild(control);
      blobContainer.appendChild(fileRow);
      if (isPk && cfg.mode === 'edit') control.disabled = true;
      wrapper.appendChild(blobContainer);
      return wrapper;
    } else {
      control = document.createElement('input');
      control.type = 'text';
      control.className = 'field-input';
      control.dataset.column = col.name;
      if (iv != null) control.value = String(iv);
    }
    if (isPk && cfg.mode === 'edit') control.disabled = true;
    wrapper.appendChild(control);
    return wrapper;
  }

  function render() {
    form.innerHTML = '';
    info.columns.forEach((col) => form.appendChild(renderField(col)));
  }

  function collect() {
    const values = {};
    form.querySelectorAll('[data-column]').forEach((el) => {
      const col = el.dataset.column;
      if (el.type === 'checkbox') values[col] = el.checked ? 'true' : '';
      else values[col] = el.value;
    });
    return values;
  }

  function showSql(sql) {
    sqlCode.textContent = sql;
    sqlBox.classList.remove('hidden');
    sqlBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function submit(runMode) {
    errorBox.classList.add('hidden');
    const values = collect();
    const edit = cfg.mode === 'edit';
    let path;
    if (edit) {
      path = '/api/tables/' + dbId + '/' + t + '/row/' + encodeURIComponent(cfg.pk) + (runMode ? '' : '/generate');
    } else {
      path = '/api/tables/' + dbId + '/' + t + '/rows' + (runMode ? '' : '/generate');
    }
    const method = edit ? 'PUT' : 'POST';
    try {
      const data = await Api.request(method, path, { values });
      if (runMode) {
        UI.showToast(data.message || 'Saved.', 'success');
        setTimeout(() => {
          window.location.href = Api.basePath + '/tables/' + dbId + '/' + encodeURIComponent(cfg.table);
        }, 500);
      } else {
        showSql(data.sql);
      }
    } catch (e) {
      errorBox.classList.remove('hidden');
      errorBox.innerHTML = '<div class="flex items-start gap-2.5 rounded-xl border border-error/40 bg-error/10 px-4 py-3 text-sm font-medium text-error"><span>' + escapeHtml(e.message) + '</span></div>';
    }
  }

  async function init() {
    try {
      info = await Api.get('/api/tables/' + dbId + '/' + t + '/info');
      if (cfg.mode === 'edit') {
        record = await Api.get('/api/tables/' + dbId + '/' + t + '/row/' + encodeURIComponent(cfg.pk));
      }
      try {
        fkOptions = await Api.get('/api/tables/' + dbId + '/' + t + '/fk-options');
      } catch (e) {
        fkOptions = {};
      }
      render();
    } catch (e) {
      errorBox.classList.remove('hidden');
      errorBox.innerHTML = '<div class="flex items-start gap-2.5 rounded-xl border border-error/40 bg-error/10 px-4 py-3 text-sm font-medium text-error"><span>' + escapeHtml(e.message) + '</span></div>';
    }
  }

  if (submitBtn) submitBtn.addEventListener('click', () => submit(true));
  if (generateBtn) generateBtn.addEventListener('click', () => submit(false));
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(sqlCode.textContent)
        .then(() => UI.showToast('Copied to clipboard.', 'success'))
        .catch(() => UI.showError('Could not copy.'));
    });
  }

  init();
})();
