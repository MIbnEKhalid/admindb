/* Visual table designer: add column definitions one at a time, validate them,
 * and preview the generated CREATE TABLE live. Create executes; Copy copies. */
(function () {
  'use strict';
  const isPostgres = window.Utils ? window.Utils.isPostgres() : (window.APP && window.APP.dialect === 'postgres');
  const DESIGNER_TYPES = window.Utils ? window.Utils.getDesignerTypes() : ['TEXT', 'INTEGER', 'REAL', 'BLOB', 'BOOLEAN'];
  const NAME_RE = window.Utils ? window.Utils.NAME_REGEX : /^[A-Za-z_][A-Za-z0-9_$]*$/;

  const columnsEl = document.getElementById('columns');
  const errorBox = document.getElementById('designer-error');
  const tableNameEl = document.getElementById('table-name');
  const addBtn = document.getElementById('add-column');
  const createBtn = document.getElementById('create-table');
  const copyBtn = document.getElementById('copy-sql');
  const previewBox = document.getElementById('sql-preview');
  const previewCode = document.getElementById('preview-code');
  const previewPlaceholder = document.getElementById('preview-placeholder');
  const previewStatus = document.getElementById('preview-status');

  const columnCache = {};
  let fkTables = [];
  let previewTimer = null;

  const escapeHtml = window.Utils ? window.Utils.escapeHtml : function(s) { return String(s == null ? '' : s); };

  async function loadColumns(table) {
    if (columnCache[table]) return columnCache[table];
    const info = await Api.get('/api/tables/' + encodeURIComponent(table) + '/info');
    columnCache[table] = info.columns.map((c) => c.name);
    return columnCache[table];
  }

  function addColumnRow() {
    const row = document.createElement('div');
    row.className = 'grid grid-cols-2 items-end gap-2.5 rounded-xl border border-base-300 bg-base-100 p-3 shadow-soft sm:grid-cols-12';
    row.innerHTML = [
      '<div class="col-span-2 sm:col-span-2"><label class="field-label">Name</label>',
      '<input class="field-input col-name" placeholder="column_name" autocomplete="off" spellcheck="false"></div>',
      '<div class="col-span-1 sm:col-span-2"><label class="field-label">Type</label>',
      '<select class="field-select col-type">' + DESIGNER_TYPES.map((t) => '<option>' + t + '</option>').join('') + '</select></div>',
      '<div class="col-span-1 sm:col-span-2"><label class="field-label">FK table</label>',
      '<select class="field-select col-fk-table"><option value="">— none —</option>' +
      fkTables.map((t) => '<option>' + escapeHtml(t) + '</option>').join('') + '</select></div>',
      '<div class="col-span-1 sm:col-span-2"><label class="field-label">FK column</label>',
      '<select class="field-select col-fk-col"><option value="">—</option></select></div>',
      '<div class="col-span-1 sm:col-span-2"><label class="field-label">Default</label>',
      '<input class="field-input col-default" placeholder="0, CURRENT_TIMESTAMP" autocomplete="off" spellcheck="false"></div>',
      '<div class="col-span-2 flex items-end justify-between gap-1 pb-0.5 sm:col-span-2">',
      '<label class="flex cursor-pointer flex-col items-center gap-1" title="Primary key"><input type="checkbox" class="checkbox checkbox-primary checkbox-xs col-pk"><span class="text-[10px] font-semibold uppercase text-base-content/50">PK</span></label>',
      '<label class="flex cursor-pointer flex-col items-center gap-1" title="Not null"><input type="checkbox" class="checkbox checkbox-xs col-notnull"><span class="text-[10px] font-semibold uppercase text-base-content/50">NN</span></label>',
      '<label class="flex cursor-pointer flex-col items-center gap-1" title="Unique"><input type="checkbox" class="checkbox checkbox-xs col-unique"><span class="text-[10px] font-semibold uppercase text-base-content/50">UQ</span></label>',
      '<button type="button" class="btn btn-ghost btn-xs text-error remove-col" title="Remove column">&times;</button>',
      '</div>',
    ].join('');
    columnsEl.appendChild(row);

    const fkTableSel = row.querySelector('.col-fk-table');
    const fkColSel = row.querySelector('.col-fk-col');
    fkTableSel.addEventListener('change', () => {
      fkColSel.innerHTML = '<option value="">—</option>';
      const target = fkTableSel.value;
      if (!target) return;
      loadColumns(target)
        .then((cols) => {
          fkColSel.innerHTML = '<option value="">—</option>' + cols.map((c) => '<option>' + escapeHtml(c) + '</option>').join('');
        })
        .catch(() => {});
    });
    row.querySelector('.remove-col').addEventListener('click', async () => {
      const colName = row.querySelector('.col-name').value.trim();
      if (colName) {
        const confirmed = await UI.confirm({
          title: 'Remove Column',
          message: 'Remove column "' + colName + '" from the table definition?',
          confirmText: 'Remove',
          danger: true,
        });
        if (!confirmed) return;
      }
      row.remove();
      schedulePreview();
    });

    row.querySelectorAll('input, select').forEach((el) => {
      el.addEventListener('input', schedulePreview);
      el.addEventListener('change', schedulePreview);
    });
  }

  function collectColumns() {
    const cols = [];
    document.querySelectorAll('#columns > div').forEach((row) => {
      const name = row.querySelector('.col-name').value.trim();
      if (!name) return;
      const fkTable = row.querySelector('.col-fk-table').value;
      const fkCol = row.querySelector('.col-fk-col').value;
      cols.push({
        name,
        type: row.querySelector('.col-type').value,
        primaryKey: row.querySelector('.col-pk').checked,
        notNull: row.querySelector('.col-notnull').checked,
        unique: row.querySelector('.col-unique').checked,
        defaultValue: row.querySelector('.col-default').value.trim() || null,
        foreignKey: fkTable && fkCol ? { table: fkTable, column: fkCol } : null,
      });
    });
    return cols;
  }

  function validate() {
    const name = tableNameEl.value.trim();
    const cols = collectColumns();
    if (!name) return 'Table name is required.';
    if (!NAME_RE.test(name)) return 'Invalid table name: "' + name + '". Use letters, digits and underscores.';
    if (!cols.length) return 'Add at least one column.';
    let pkCount = 0;
    const seen = {};
    for (const c of cols) {
      if (!NAME_RE.test(c.name)) return 'Invalid column name: "' + c.name + '".';
      if (seen[c.name]) return 'Duplicate column name: "' + c.name + '".';
      seen[c.name] = true;
      if (c.primaryKey) pkCount += 1;
      if (c.foreignKey && (!c.foreignKey.table || !c.foreignKey.column)) {
        return 'Column "' + c.name + '" has an incomplete foreign key (choose both table and column).';
      }
    }
    if (pkCount > 1) return 'At most one column can be a primary key.';
    return null;
  }

  function showError(msg) {
    errorBox.classList.remove('hidden');
    errorBox.innerHTML = '<div class="alert alert-error shadow-lg"><span>' + escapeHtml(msg) + '</span></div>';
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 250);
  }

  async function runPreview() {
    const err = validate();
    if (err) {
      errorBox.classList.add('hidden');
      previewBox.classList.add('hidden');
      previewPlaceholder.classList.remove('hidden');
      if (previewStatus) previewStatus.textContent = 'fix validation errors…';
      return;
    }
    errorBox.classList.add('hidden');
    try {
      const data = await Api.post('/api/tables/generate', {
        name: tableNameEl.value.trim(),
        columns: collectColumns(),
      });
      previewCode.textContent = data.sql;
      previewBox.classList.remove('hidden');
      previewPlaceholder.classList.add('hidden');
      if (previewStatus) {
        previewStatus.textContent = 'live preview · not executed';
        previewStatus.className = 'text-[11px] font-medium text-accent';
      }
    } catch (e) {
      previewBox.classList.add('hidden');
      previewPlaceholder.classList.remove('hidden');
      showError(e.message);
    }
  }

  async function submit() {
    errorBox.classList.add('hidden');
    const err = validate();
    if (err) {
      showError(err);
      return;
    }
    const body = { name: tableNameEl.value.trim(), columns: collectColumns() };
    try {
      const data = await Api.post('/api/tables', body);
      UI.showToast(data.message || 'Table created.', 'success');
      setTimeout(() => {
        window.location.href = Api.basePath + '/tables/' + encodeURIComponent(body.name);
      }, 500);
    } catch (e) {
      showError(e.message);
    }
  }

  async function init() {
    try {
      const tables = await Api.get('/api/tables');
      fkTables = tables.map((t) => t.name).filter((n) => n.charAt(0) !== '_');
    } catch (e) {
      fkTables = [];
    }
    addColumnRow();
    addColumnRow();
    tableNameEl.addEventListener('input', schedulePreview);
  }

  if (addBtn) addBtn.addEventListener('click', addColumnRow);
  if (createBtn) createBtn.addEventListener('click', submit);
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const text = previewCode.textContent || '';
      if (!text) {
        UI.showError('Nothing to copy yet.');
        return;
      }
      navigator.clipboard.writeText(text)
        .then(() => UI.showToast('SQL copied to clipboard.', 'success'))
        .catch(() => UI.showError('Could not copy.'));
    });
  }

  init();
})();
