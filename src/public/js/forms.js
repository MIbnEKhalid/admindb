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
  const t = encodeURIComponent(cfg.table);

  let info = null;
  let record = null;
  let fkOptions = {};

  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
  }

  function toLocalInput(v) {
    const m = String(v).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
    if (m) return m[1] + 'T' + m[2] + ':' + m[3];
    return v;
  }

  function toLocalNow() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * Convert a column's raw default expression (dflt_value) into a form-friendly
   * value. Handles literals we can read safely; anything complex returns null
   * (the DB applies the real default when the field is left empty).
   */
  function defaultToValue(col, dflt) {
    if (dflt === null || dflt === undefined) return null;
    const s = String(dflt).trim();
    if (s === '' || /^null$/i.test(s)) return null;

    const type = (col.type || '').toUpperCase();

    // Single-quoted string literal, e.g. 'N/A', 'user'
    const str = s.match(/^'(.*)'$/s);
    if (str) return str[1].replace(/''/g, "'");

    // Numeric literal, e.g. 0, 42, 3.14
    if (/^[-+]?\d+(\.\d+)?$/.test(s)) return Number(s);

    // Boolean literal
    if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);

    // BOOLEAN columns stored as 0/1
    if (type === 'BOOLEAN') {
      if (s === '1' || /^true$/i.test(s)) return 1;
      if (s === '0' || /^false$/i.test(s)) return 0;
    }

    // current-timestamp style defaults → "now" for date/datetime columns
    if ((type === 'DATE' || type === 'DATETIME') && /current_timestamp|now\s*\(|datetime\s*\(|date\s*\(/i.test(s)) {
      return toLocalNow();
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
    const isBool = type === 'BOOLEAN';
    const isNum = type.startsWith('INTEGER') || type === 'REAL';
    const isBlob = type === 'BLOB';
    const isDate = type === 'DATE' || type === 'DATETIME';
    const iv = initialValue(col);

    let control;
    if (isBool) {
      const boolWrap = document.createElement('label');
      boolWrap.className = 'flex cursor-pointer items-center gap-2';
      control = document.createElement('input');
      control.type = 'checkbox';
      control.className = 'field-check';
      control.dataset.column = col.name;
      if (isTruthy(iv)) control.checked = true;
      const span = document.createElement('span');
      span.className = 'text-sm text-base-content/60';
      span.textContent = 'Enabled';
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
    } else if (isDate) {
      control = document.createElement('input');
      control.type = 'datetime-local';
      control.className = 'field-input';
      control.dataset.column = col.name;
      if (iv != null) control.value = toLocalInput(String(iv));
    } else if (isNum) {
      control = document.createElement('input');
      control.type = 'number';
      control.step = type === 'REAL' ? 'any' : '1';
      control.className = 'field-input';
      control.dataset.column = col.name;
      if (iv != null) control.value = String(iv);
    } else if (isBlob) {
      const blobContainer = document.createElement('div');
      blobContainer.className = 'space-y-2';

      control = document.createElement('input');
      control.type = 'text';
      control.className = 'field-input font-mono text-xs';
      control.placeholder = '0x… hex or plain text';
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
          let hex = '0x';
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
      const isJsonField = type.includes('JSON') || col.name.toLowerCase().includes('json') || (iv && typeof iv === 'string' && (iv.startsWith('{') || iv.startsWith('[')));

      if (isJsonField) {
        const jsonContainer = document.createElement('div');
        jsonContainer.className = 'space-y-1.5';

        control = document.createElement('textarea');
        control.rows = 3;
        control.className = 'field-input font-mono text-[13px]';
        control.placeholder = '{\n  "key": "value"\n}';
        control.dataset.column = col.name;
        if (iv != null) control.value = typeof iv === 'object' ? JSON.stringify(iv, null, 2) : String(iv);

        const btnRow = document.createElement('div');
        btnRow.className = 'flex justify-end';

        const inspectBtn = document.createElement('button');
        inspectBtn.type = 'button';
        inspectBtn.className = 'btn btn-ghost btn-xs gap-1 text-primary';
        inspectBtn.innerHTML = '🧩 Inspect & Format JSON';
        inspectBtn.addEventListener('click', () => {
          if (window.Inspector && window.Inspector.open) {
            window.Inspector.open({
              table: cfg.table,
              pk: cfg.pk || '',
              col: col.name,
              colType: col.type,
              value: control.value,
              isNull: !control.value,
              isJson: true,
              readonly: false,
              onSave: (newVal) => {
                control.value = newVal;
              },
            });
          }
        });

        btnRow.appendChild(inspectBtn);
        jsonContainer.appendChild(control);
        jsonContainer.appendChild(btnRow);
        if (isPk && cfg.mode === 'edit') control.disabled = true;
        wrapper.appendChild(jsonContainer);
        return wrapper;
      }

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
      path = '/api/tables/' + t + '/row/' + encodeURIComponent(cfg.pk) + (runMode ? '' : '/generate');
    } else {
      path = '/api/tables/' + t + '/rows' + (runMode ? '' : '/generate');
    }
    const method = edit ? 'PUT' : 'POST';
    try {
      const data = await Api.request(method, path, { values });
      if (runMode) {
        UI.showToast(data.message || 'Saved.', 'success');
        setTimeout(() => {
          window.location.href = Api.basePath + '/tables/' + encodeURIComponent(cfg.table);
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
      info = await Api.get('/api/tables/' + t + '/info');
      if (cfg.mode === 'edit') {
        record = await Api.get('/api/tables/' + t + '/row/' + encodeURIComponent(cfg.pk));
      }
      try {
        fkOptions = await Api.get('/api/tables/' + t + '/fk-options');
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
