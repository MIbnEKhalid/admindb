/* Table schema editor: rename table, add/rename/drop columns, drop table. */
(function () {
  'use strict';
  const cfgEl = document.getElementById('schema-config');
  if (!cfgEl) return;
  const cfg = JSON.parse(cfgEl.textContent);
  const DESIGNER_TYPES = ['TEXT', 'INTEGER', 'REAL', 'BLOB', 'BOOLEAN', 'VARCHAR(255)', 'BIGINT', 'DECIMAL(10,2)', 'DATE', 'DATETIME', 'JSON'];
  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
  const t = encodeURIComponent(cfg.table);

  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
  }

  function showError(el, msg) {
    el.classList.remove('hidden');
    el.innerHTML = '<div class="flex items-start gap-2.5 rounded-xl border border-error/40 bg-error/10 px-4 py-3 text-sm font-medium text-error"><span>' + escapeHtml(msg) + '</span></div>';
  }

  // ---- Rename table ------------------------------------------------------

  const renameInput = document.getElementById('table-rename-input');
  const renameBtn = document.getElementById('rename-table');

  async function renameTable() {
    const name = (renameInput.value || '').trim();
    if (!name) return UI.showError('Table name is required.');
    if (name === cfg.table) return UI.showToast('Name unchanged.', 'info');
    try {
      const data = await Api.post('/api/tables/' + t + '/rename', { name });
      UI.showToast(data.message || 'Table renamed.', 'success');
      setTimeout(() => {
        window.location.href = Api.basePath + '/tables/' + encodeURIComponent(name) + '/schema';
      }, 400);
    } catch (e) {
      UI.showError(e.message);
    }
  }
  if (renameBtn) renameBtn.addEventListener('click', renameTable);
  if (renameInput) renameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') renameTable(); });

  // ---- Add column ---------------------------------------------------------

  const addBtn = document.getElementById('add-column');
  const panel = document.getElementById('add-column-panel');
  const formEl = document.getElementById('add-column-form');
  const errEl = document.getElementById('add-column-error');
  const submitBtn = document.getElementById('add-column-submit');
  const cancelBtn = document.getElementById('add-column-cancel');
  let fkTables = [];

  async function loadFkTables() {
    try {
      const tables = await Api.get('/api/tables');
      fkTables = tables.map((x) => x.name).filter((n) => n.charAt(0) !== '_');
    } catch (e) {
      fkTables = [];
    }
  }

  function renderTypeOptions(selectedType) {
    const upper = (selectedType || 'TEXT').toUpperCase();
    const all = [...DESIGNER_TYPES];
    if (selectedType && !all.map((x) => x.toUpperCase()).includes(upper)) {
      all.unshift(selectedType);
    }
    return all.map((x) => '<option value="' + escapeHtml(x) + '"' + (x.toUpperCase() === upper ? ' selected' : '') + '>' + escapeHtml(x) + '</option>').join('');
  }

  function buildAddForm() {
    formEl.innerHTML = '';
    formEl.innerHTML = [
      '<div class="col-span-2 sm:col-span-3"><label class="field-label">Name</label><input class="field-input ac-name" placeholder="column_name" autocomplete="off" spellcheck="false"></div>',
      '<div class="col-span-1 sm:col-span-2"><label class="field-label">Type</label><select class="field-select ac-type">' + renderTypeOptions('TEXT') + '</select></div>',
      '<div class="col-span-1 sm:col-span-2"><label class="field-label">FK table</label><select class="field-select ac-fk-table"><option value="">— none —</option>' + fkTables.map((x) => '<option>' + escapeHtml(x) + '</option>').join('') + '</select></div>',
      '<div class="col-span-1 sm:col-span-2"><label class="field-label">FK column</label><select class="field-select ac-fk-col"><option value="">—</option></select></div>',
      '<div class="col-span-1 sm:col-span-2"><label class="field-label">Default</label><input class="field-input ac-default" placeholder="0, CURRENT_TIMESTAMP" autocomplete="off" spellcheck="false"></div>',
      '<div class="col-span-2 flex items-end gap-1.5 pb-0.5 sm:col-span-1">',
      '<label class="flex cursor-pointer flex-col items-center gap-1" title="Primary key"><input type="checkbox" class="checkbox checkbox-xs ac-pk"><span class="text-[10px] font-semibold uppercase text-base-content/50">PK</span></label>',
      '<label class="flex cursor-pointer flex-col items-center gap-1" title="Not null"><input type="checkbox" class="checkbox checkbox-xs ac-notnull"><span class="text-[10px] font-semibold uppercase text-base-content/50">NN</span></label>',
      '<label class="flex cursor-pointer flex-col items-center gap-1" title="Unique"><input type="checkbox" class="checkbox checkbox-xs ac-unique"><span class="text-[10px] font-semibold uppercase text-base-content/50">UQ</span></label>',
      '</div>',
    ].join('');

    const fkTableSel = formEl.querySelector('.ac-fk-table');
    const fkColSel = formEl.querySelector('.ac-fk-col');
    fkTableSel.addEventListener('change', async () => {
      fkColSel.innerHTML = '<option value="">—</option>';
      const target = fkTableSel.value;
      if (!target) return;
      try {
        const info = await Api.get('/api/tables/' + encodeURIComponent(target) + '/info');
        fkColSel.innerHTML = '<option value="">—</option>' + info.columns.map((c) => '<option>' + escapeHtml(c.name) + '</option>').join('');
      } catch (e) { /* ignore */ }
    });
  }

  async function addColumn() {
    errEl.classList.add('hidden');
    const name = (formEl.querySelector('.ac-name').value || '').trim();
    if (!name) return showError(errEl, 'Column name is required.');
    if (!NAME_RE.test(name)) return showError(errEl, 'Invalid column name: "' + name + '". Use letters, digits and underscores.');
    const fkTable = formEl.querySelector('.ac-fk-table').value;
    const fkCol = formEl.querySelector('.ac-fk-col').value;
    const column = {
      name,
      type: formEl.querySelector('.ac-type').value,
      primaryKey: formEl.querySelector('.ac-pk').checked,
      notNull: formEl.querySelector('.ac-notnull').checked,
      unique: formEl.querySelector('.ac-unique').checked,
      defaultValue: formEl.querySelector('.ac-default').value.trim() || null,
      foreignKey: fkTable && fkCol ? { table: fkTable, column: fkCol } : null,
    };
    try {
      const data = await Api.post('/api/tables/' + t + '/columns', { column });
      UI.showToast(data.message || 'Column added.', 'success');
      window.location.reload();
    } catch (e) {
      showError(errEl, e.message);
    }
  }

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      if (editPanel) editPanel.classList.add('hidden');
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) {
        errEl.classList.add('hidden');
        buildAddForm();
      }
    });
  }
  if (cancelBtn) cancelBtn.addEventListener('click', () => { panel.classList.add('hidden'); formEl.innerHTML = ''; });
  if (submitBtn) submitBtn.addEventListener('click', addColumn);

  // ---- Edit column (type & constraints) ------------------------------------

  const editPanel = document.getElementById('edit-column-panel');
  const editFormEl = document.getElementById('edit-column-form');
  const editErrEl = document.getElementById('edit-column-error');
  const editSubmitBtn = document.getElementById('edit-column-submit');
  const editCancelBtn = document.getElementById('edit-column-cancel');
  const editTargetSpan = document.getElementById('edit-column-target');
  let currentEditingCol = null;

  async function openEditColumn(colData) {
    if (!editPanel || !editFormEl) return;
    if (panel) panel.classList.add('hidden');
    currentEditingCol = colData.name;
    if (editTargetSpan) editTargetSpan.textContent = '"' + colData.name + '"';
    editErrEl.classList.add('hidden');

    editFormEl.innerHTML = [
      '<div class="col-span-2 sm:col-span-3"><label class="field-label">Name</label><input class="field-input ec-name" value="' + escapeHtml(colData.name) + '" autocomplete="off" spellcheck="false"></div>',
      '<div class="col-span-1 sm:col-span-2"><label class="field-label">Type</label><select class="field-select ec-type">' + renderTypeOptions(colData.type) + '</select></div>',
      '<div class="col-span-1 sm:col-span-2"><label class="field-label">FK table</label><select class="field-select ec-fk-table"><option value="">— none —</option>' + fkTables.map((x) => '<option value="' + escapeHtml(x) + '"' + (colData.fkTable === x ? ' selected' : '') + '>' + escapeHtml(x) + '</option>').join('') + '</select></div>',
      '<div class="col-span-1 sm:col-span-2"><label class="field-label">FK column</label><select class="field-select ec-fk-col"><option value="">—</option></select></div>',
      '<div class="col-span-1 sm:col-span-2"><label class="field-label">Default</label><input class="field-input ec-default" value="' + escapeHtml(colData.defaultValue || '') + '" placeholder="0, CURRENT_TIMESTAMP" autocomplete="off" spellcheck="false"></div>',
      '<div class="col-span-2 flex items-end gap-1.5 pb-0.5 sm:col-span-1">',
      '<label class="flex cursor-pointer flex-col items-center gap-1" title="Primary key"><input type="checkbox" class="checkbox checkbox-xs ec-pk"' + (colData.primaryKey ? ' checked' : '') + '><span class="text-[10px] font-semibold uppercase text-base-content/50">PK</span></label>',
      '<label class="flex cursor-pointer flex-col items-center gap-1" title="Not null"><input type="checkbox" class="checkbox checkbox-xs ec-notnull"' + (colData.notNull ? ' checked' : '') + '><span class="text-[10px] font-semibold uppercase text-base-content/50">NN</span></label>',
      '<label class="flex cursor-pointer flex-col items-center gap-1" title="Unique"><input type="checkbox" class="checkbox checkbox-xs ec-unique"' + (colData.unique ? ' checked' : '') + '><span class="text-[10px] font-semibold uppercase text-base-content/50">UQ</span></label>',
      '</div>',
    ].join('');

    const fkTableSel = editFormEl.querySelector('.ec-fk-table');
    const fkColSel = editFormEl.querySelector('.ec-fk-col');

    async function updateFkCols(table, selectedCol) {
      fkColSel.innerHTML = '<option value="">—</option>';
      if (!table) return;
      try {
        const targetInfo = await Api.get('/api/tables/' + encodeURIComponent(table) + '/info');
        fkColSel.innerHTML = '<option value="">—</option>' + targetInfo.columns.map((c) => '<option value="' + escapeHtml(c.name) + '"' + (c.name === selectedCol ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>').join('');
      } catch (e) { /* ignore */ }
    }

    if (colData.fkTable) {
      await updateFkCols(colData.fkTable, colData.fkTo);
    }

    fkTableSel.addEventListener('change', () => updateFkCols(fkTableSel.value, ''));

    editPanel.classList.remove('hidden');
    editPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function saveEditedColumn() {
    if (!currentEditingCol) return;
    editErrEl.classList.add('hidden');
    const name = (editFormEl.querySelector('.ec-name').value || '').trim();
    if (!name) return showError(editErrEl, 'Column name is required.');
    if (!NAME_RE.test(name)) return showError(editErrEl, 'Invalid column name: "' + name + '". Use letters, digits and underscores.');
    const fkTable = editFormEl.querySelector('.ec-fk-table').value;
    const fkCol = editFormEl.querySelector('.ec-fk-col').value;
    const column = {
      name,
      type: editFormEl.querySelector('.ec-type').value,
      primaryKey: editFormEl.querySelector('.ec-pk').checked,
      notNull: editFormEl.querySelector('.ec-notnull').checked,
      unique: editFormEl.querySelector('.ec-unique').checked,
      defaultValue: editFormEl.querySelector('.ec-default').value.trim() || null,
      foreignKey: fkTable && fkCol ? { table: fkTable, column: fkCol } : null,
    };

    if (editSubmitBtn) editSubmitBtn.disabled = true;
    try {
      const data = await Api.put('/api/tables/' + t + '/columns/' + encodeURIComponent(currentEditingCol), { column });
      UI.showToast(data.message || 'Column updated.', 'success');
      window.location.reload();
    } catch (e) {
      showError(editErrEl, e.message);
    } finally {
      if (editSubmitBtn) editSubmitBtn.disabled = false;
    }
  }

  if (editCancelBtn) editCancelBtn.addEventListener('click', () => { editPanel.classList.add('hidden'); editFormEl.innerHTML = ''; currentEditingCol = null; });
  if (editSubmitBtn) editSubmitBtn.addEventListener('click', saveEditedColumn);

  document.querySelectorAll('.col-edit').forEach((btn) => {
    btn.addEventListener('click', () => {
      openEditColumn({
        name: btn.dataset.column || '',
        type: btn.dataset.type || 'TEXT',
        primaryKey: btn.dataset.pk === 'true',
        notNull: btn.dataset.notnull === 'true',
        unique: btn.dataset.unique === 'true',
        defaultValue: btn.dataset.default || '',
        fkTable: btn.dataset.fkTable || '',
        fkTo: btn.dataset.fkTo || '',
      });
    });
  });

  // ---- Column rename (inline) ---------------------------------------------

  function inlineRename(cell, oldName) {
    const display = cell.querySelector('.name-display');
    if (!display) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = oldName;
    input.className = 'field-input !py-1 !text-[13px]';
    input.spellcheck = false;
    let done = false;
    const restore = () => { if (display.parentNode) cell.replaceChild(display, input); };
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (!save) return restore();
      const newName = input.value.trim();
      if (!newName || newName === oldName) return restore();
      try {
        await Api.put('/api/tables/' + t + '/columns/' + encodeURIComponent(oldName), { name: newName });
        UI.showToast('Column renamed.', 'success');
        window.location.reload();
      } catch (e) {
        UI.showError(e.message);
        done = false;
        restore();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(false));
    cell.replaceChild(input, display);
    input.focus();
    input.select();
  }

  document.querySelectorAll('.col-rename').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      if (!tr) return;
      const cell = tr.querySelector('.col-name-cell');
      if (cell) inlineRename(cell, cell.dataset.column);
    });
  });

  // ---- Drop column ---------------------------------------------------------

  document.querySelectorAll('.col-drop').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      if (!tr) return;
      const cell = tr.querySelector('.col-name-cell');
      const name = cell ? cell.dataset.column : '';
      if (!name) return;
      const confirmed = await UI.confirm({
        title: 'Drop Column',
        message: 'Dropping column "' + name + '" will permanently delete all data stored in this column for all rows in table "' + cfg.table + '". This action cannot be undone.',
        item: name,
        itemType: 'Column',
        confirmText: 'Drop column',
        danger: true,
      });
      if (!confirmed) return;
      Api.del('/api/tables/' + t + '/columns/' + encodeURIComponent(name))
        .then((data) => {
          UI.showToast(data.message || 'Column dropped.', 'success');
          window.location.reload();
        })
        .catch((e) => UI.showError(e.message));
    });
  });

  // ---- Drop table -----------------------------------------------------------

  const dropBtn = document.getElementById('drop-table');
  if (dropBtn) {
    dropBtn.addEventListener('click', async () => {
      const confirmed = await UI.confirm({
        title: 'Drop Table',
        message: 'Dropping table "' + cfg.table + '" permanently erases the table schema, all indexes, and all stored records. This action cannot be undone.',
        item: cfg.table,
        itemType: 'Table',
        requireInputMatch: cfg.table,
        confirmText: 'Drop table',
        danger: true,
      });
      if (!confirmed) return;
      Api.del('/api/tables/' + t)
        .then(() => {
          UI.showToast('Table dropped.', 'success');
          setTimeout(() => { window.location.href = Api.basePath + '/'; }, 400);
        })
        .catch((e) => UI.showError(e.message));
    });
  }

  // ---- Index management ------------------------------------------------------

  const addIndexBtn = document.getElementById('add-index');
  const addIndexPanel = document.getElementById('add-index-panel');
  const indexNameInput = document.getElementById('index-name');
  const indexUniqueInput = document.getElementById('index-unique');
  const indexErrEl = document.getElementById('add-index-error');
  const addIndexSubmit = document.getElementById('add-index-submit');
  const addIndexCancel = document.getElementById('add-index-cancel');
  const indexPreview = document.getElementById('index-preview');
  const indexPreviewCode = document.getElementById('index-preview-code');
  const indexColBtns = Array.prototype.slice.call(document.querySelectorAll('.index-col-btn'));

  // Columns selected for the new index, in click order (index order matters!).
  let indexColumns = [];

  function renderIndexPreview() {
    if (!indexPreview || !indexPreviewCode) return;
    const cols = indexColumns.slice();
    const name = (indexNameInput.value || '').trim();
    const unique = indexUniqueInput && indexUniqueInput.checked ? 'UNIQUE ' : '';
    if (!cols.length) {
      indexPreview.classList.add('hidden');
      indexPreviewCode.textContent = '';
      return;
    }
    const finalName = name || 'idx_' + cfg.table + '_' + cols.join('_');
    indexPreviewCode.textContent =
      'CREATE ' + unique + 'INDEX "' + finalName + '" ON "' + cfg.table + '" (' +
      cols.map((c) => '"' + c + '"').join(', ') + ');';
    indexPreview.classList.remove('hidden');
  }

  function toggleIndexColumn(btn) {
    const col = btn.dataset.column;
    const i = indexColumns.indexOf(col);
    const num = btn.querySelector('.index-col-num');
    if (i !== -1) {
      indexColumns.splice(i, 1);
      btn.classList.remove('border-primary', 'bg-primary/10');
      if (num) num.classList.add('hidden');
    } else {
      indexColumns.push(col);
      btn.classList.add('border-primary', 'bg-primary/10');
      if (num) num.classList.remove('hidden');
    }
    indexColumns.forEach((c, idx) => {
      const b = indexColBtns.find((x) => x.dataset.column === c);
      const n = b && b.querySelector('.index-col-num');
      if (n) n.textContent = String(idx + 1);
    });
    renderIndexPreview();
  }

  indexColBtns.forEach((btn) => btn.addEventListener('click', () => toggleIndexColumn(btn)));
  if (indexNameInput) indexNameInput.addEventListener('input', renderIndexPreview);
  if (indexUniqueInput) indexUniqueInput.addEventListener('change', renderIndexPreview);

  if (addIndexBtn && addIndexPanel) {
    addIndexBtn.addEventListener('click', () => {
      addIndexPanel.classList.toggle('hidden');
      if (!addIndexPanel.classList.contains('hidden')) {
        indexErrEl.classList.add('hidden');
        indexNameInput.focus();
        renderIndexPreview();
      }
    });
  }
  if (addIndexCancel) {
    addIndexCancel.addEventListener('click', () => {
      addIndexPanel.classList.add('hidden');
      indexErrEl.classList.add('hidden');
    });
  }
  if (addIndexSubmit) {
    addIndexSubmit.addEventListener('click', async () => {
      indexErrEl.classList.add('hidden');
      const columns = indexColumns.slice();
      if (!columns.length) return showError(indexErrEl, 'Select at least one column for the index.');
      const body = { columns, unique: !!(indexUniqueInput && indexUniqueInput.checked) };
      const name = (indexNameInput.value || '').trim();
      if (name) body.name = name;
      addIndexSubmit.disabled = true;
      try {
        const data = await Api.post('/api/tables/' + t + '/indexes', body);
        UI.showToast(data.message || 'Index created.', 'success');
        window.location.reload();
      } catch (e) {
        showError(indexErrEl, e.message);
      } finally {
        addIndexSubmit.disabled = false;
      }
    });
  }

  document.querySelectorAll('.index-drop').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.index;
      if (!name) return;
      const confirmed = await UI.confirm({
        title: 'Drop Index',
        message: 'Are you sure you want to permanently drop index "' + name + '" on table "' + cfg.table + '"?',
        item: name,
        itemType: 'Index',
        confirmText: 'Drop index',
        danger: true,
      });
      if (!confirmed) return;
      Api.del('/api/tables/' + t + '/indexes/' + encodeURIComponent(name))
        .then((data) => {
          UI.showToast(data.message || 'Index dropped.', 'success');
          window.location.reload();
        })
        .catch((e) => UI.showError(e.message));
    });
  });

  loadFkTables();
})();
