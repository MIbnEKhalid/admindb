/* "Seed data" page.
 *
 * Lets you generate N realistic rows for a table. Each column gets a strategy
 * (auto-detected from its name/type/foreign key, but overridable): skip,
 * set NULL, fixed value, random from list, or any of the built-in fake-data
 * generators (first/last name, email, phone, UUID, random int/date/…), plus
 * "random from referenced table" for foreign-key columns.
 *
 * "Preview SQL" generates the rows and shows the INSERT statements without
 * executing them; "Insert rows" writes them inside a single transaction.
 */
(function () {
  'use strict';

  const cfgEl = document.getElementById('seed-config');
  if (!cfgEl) return;

  const cfg = JSON.parse(cfgEl.textContent);
  const t = encodeURIComponent(cfg.table);
  const columns = cfg.columns || [];

  const countInput = document.getElementById('seed-count');
  const columnsBox = document.getElementById('seed-columns');
  const feedback = document.getElementById('seed-feedback');
  const sqlBox = document.getElementById('seed-sql');
  const sqlCode = document.getElementById('seed-sql-code');
  const copyBtn = document.getElementById('seed-copy');
  const insertBtn = document.getElementById('seed-insert');
  const previewBtn = document.getElementById('seed-preview');
  const resetBtn = document.getElementById('seed-reset');
  const applyAllBtn = document.getElementById('seed-apply-all');

  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
  }

  // Per-column live state: { strategy, ...optionValues }.
  const state = {};

  // ---- Option field definitions per strategy -----------------------------

  function field(key, label, type, attrs) {
    return Object.assign({ key, label, type }, attrs || {});
  }
  const FIELD_DEFS = {
    fixed: [field('value', 'Value', 'text')],
    list: [field('values', 'One value per line', 'textarea')],
    int: [field('min', 'Min', 'number'), field('max', 'Max', 'number')],
    decimal: [field('min', 'Min', 'number'), field('max', 'Max', 'number'), field('precision', 'Decimals', 'number', { step: 1 })],
    date: [field('from', 'From', 'date'), field('to', 'To', 'date')],
    datetime: [field('from', 'From', 'datetime-local'), field('to', 'To', 'datetime-local')],
    time: [],
    words: [field('minLen', 'Min words', 'number'), field('maxLen', 'Max words', 'number')],
    sentence: [field('minLen', 'Min', 'number'), field('maxLen', 'Max', 'number')],
    bytes: [field('minLen', 'Min bytes', 'number'), field('maxLen', 'Max bytes', 'number')],
    json: [field('jsonKeys', 'JSON keys (comma-separated)', 'text')],
    hash: [field('minLen', 'Min length', 'number'), field('maxLen', 'Max length', 'number')],
    token: [field('minLen', 'Min length', 'number'), field('maxLen', 'Max length', 'number')],
  };

  function strategyNote(col, strategy) {
    if (strategy === 'fk' && col.fk) return 'Values are sampled from ' + escapeHtml(col.fk.table) + (col.fk.to ? '.' + escapeHtml(col.fk.to) : '') + '.';
    if (strategy === 'skip') return 'Column is omitted — the DB default (or NULL) applies.';
    if (strategy === 'null') return 'Column is explicitly set to NULL.';
    if (strategy === 'json') return 'Generates a valid JSON object — needed when the column has a JSON index or JSON default.';
    if (strategy === 'hash') return 'Generates a random hexadecimal hash.';
    if (strategy === 'token') return 'Generates a random short token / code.';
    return '';
  }

  // ---- Card building ------------------------------------------------------

  function buildOptionInputs(container, col, plan) {
    container.innerHTML = '';
    const fields = FIELD_DEFS[plan.strategy] || [];
    if (!fields.length) return;
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-2 gap-2';
    fields.forEach((f) => {
      const wrap = document.createElement('label');
      wrap.className = 'block';
      const label = document.createElement('span');
      label.className = 'field-label !mb-1 !text-[11px]';
      label.textContent = f.label;
      wrap.appendChild(label);
      let el;
      if (f.type === 'textarea') {
        el = document.createElement('textarea');
        el.rows = 4;
        el.className = 'field-input col-span-2 w-full font-mono !text-[12px]';
        el.placeholder = 'one value per line';
        el.spellcheck = false;
        if (Array.isArray(plan.values)) el.value = plan.values.join('\n');
      } else {
        el = document.createElement('input');
        el.type = f.type;
        el.className = 'field-input !py-1.5 !text-[13px]';
        if (f.step != null) el.step = String(f.step);
        const v = plan[f.key];
        if (f.key === 'jsonKeys' && Array.isArray(v)) {
          el.value = v.join(', ');
        } else if (v !== undefined && v !== null) {
          el.value = String(v);
        }
      }
      el.dataset.optionKey = f.key;
      el.addEventListener('input', () => {
        const key = el.dataset.optionKey;
        if (f.type === 'textarea') {
          state[col.name][key] = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
        } else if (key === 'jsonKeys') {
          state[col.name][key] = el.value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
        } else if (key === 'value' || key === 'from' || key === 'to') {
          state[col.name][key] = el.value;
        } else {
          const n = Number(el.value);
          state[col.name][key] = el.value === '' || !Number.isFinite(n) ? undefined : n;
        }
      });
      wrap.appendChild(el);
      grid.appendChild(wrap);
    });
    container.appendChild(grid);
  }

  function buildCard(col) {
    const card = document.createElement('div');
    card.className = 'app-card p-4';
    card.dataset.column = col.name;

    const head = document.createElement('div');
    head.className = 'flex flex-wrap items-start justify-between gap-2';

    const title = document.createElement('div');
    title.className = 'min-w-0';
    const name = document.createElement('p');
    name.className = 'flex flex-wrap items-center gap-1.5 font-mono text-sm font-semibold';
    name.textContent = col.name;
    if (col.pk) {
      const chip = document.createElement('span');
      chip.className = 'chip chip-pk';
      chip.textContent = 'PK';
      name.appendChild(chip);
    }
    if (col.notnull) {
      const chip = document.createElement('span');
      chip.className = 'chip chip-type';
      chip.textContent = 'NOT NULL';
      name.appendChild(chip);
    }
    if (col.hasDefault) {
      const chip = document.createElement('span');
      chip.className = 'chip chip-type';
      chip.textContent = 'default';
      name.appendChild(chip);
    }
    const type = document.createElement('p');
    type.className = 'mt-0.5 text-xs text-base-content/45';
    type.textContent = col.type || 'untyped';
    title.appendChild(name);
    title.appendChild(type);
    head.appendChild(title);

    const select = document.createElement('select');
    select.className = 'field-select seed-strategy !w-auto !py-1 !text-[13px]';
    select.dataset.column = col.name;
    (col.strategies || []).forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label;
      select.appendChild(opt);
    });
    head.appendChild(select);
    card.appendChild(head);

    const options = document.createElement('div');
    options.className = 'seed-options mt-2.5';
    card.appendChild(options);

    const note = document.createElement('p');
    note.className = 'seed-note mt-2 hidden text-[11px] leading-relaxed text-base-content/45';
    card.appendChild(note);

    const warn = document.createElement('p');
    warn.className = 'seed-warn mt-2 hidden text-[11px] font-medium text-warning';
    card.appendChild(warn);

    // Wire up strategy changes.
    select.addEventListener('change', () => {
      const st = select.value;
      state[col.name] = Object.assign({}, state[col.name] || {}, { strategy: st });
      buildOptionInputs(options, col, state[col.name]);
      note.textContent = strategyNote(col, st);
      note.classList.toggle('hidden', !note.textContent);
      updateWarn(col, warn);
    });

    columnsBox.appendChild(card);
    return { select, options, note, warn };
  }

  function updateWarn(col, warnEl) {
    const st = state[col.name] ? state[col.name].strategy : null;
    const risky = (st === 'skip' || st === 'null') && !col.pk && col.notnull && !col.hasDefault;
    warnEl.textContent = risky
      ? 'This column is NOT NULL with no default — "' + st + '" rows may fail to insert.'
      : '';
    warnEl.classList.toggle('hidden', !warnEl.textContent);
  }

  function resetCard(col) {
    const plan = Object.assign({}, col.defaultPlan || { strategy: 'skip' });
    state[col.name] = plan;
    const select = columnsBox.querySelector('.seed-strategy[data-column="' + CSS.escape(col.name) + '"]');
    if (select) {
      select.value = plan.strategy;
      const options = select.closest('.app-card').querySelector('.seed-options');
      const note = select.closest('.app-card').querySelector('.seed-note');
      const warn = select.closest('.app-card').querySelector('.seed-warn');
      buildOptionInputs(options, col, plan);
      note.textContent = strategyNote(col, plan.strategy);
      note.classList.toggle('hidden', !note.textContent);
      updateWarn(col, warn);
    }
  }

  // ---- Apply strategy to all ---------------------------------------------

  function unionStrategies() {
    const map = new Map();
    columns.forEach((col) => (col.strategies || []).forEach((s) => map.set(s.id, s.label)));
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }

  function buildApplyAllDialog() {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.id = 'seed-apply-all-dialog';
    const inner = document.createElement('div');
    inner.className = 'modal-box app-card';
    inner.innerHTML =
      '<h3 class="text-lg font-bold">Apply strategy to all columns</h3>' +
      '<p class="mt-1 text-sm text-base-content/55">Columns that do not support the chosen strategy are left unchanged. Existing option values are preserved where possible.</p>' +
      '<label class="field-label mt-4">Strategy</label>' +
      '<select id="seed-apply-all-select" class="field-select w-full"></select>' +
      '<div class="mt-6 flex justify-end gap-2">' +
      '<button id="seed-apply-all-cancel" type="button" class="btn btn-ghost">Cancel</button>' +
      '<button id="seed-apply-all-go" type="button" class="btn btn-primary">Apply</button>' +
      '</div>';
    dialog.appendChild(inner);
    document.body.appendChild(dialog);

    const select = inner.querySelector('#seed-apply-all-select');
    unionStrategies().forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label;
      select.appendChild(opt);
    });

    const close = () => dialog.close();
    inner.querySelector('#seed-apply-all-cancel').addEventListener('click', close);
    inner.querySelector('#seed-apply-all-go').addEventListener('click', () => {
      const target = select.value;
      columns.forEach((col) => {
        const supported = (col.strategies || []).some((s) => s.id === target);
        if (!supported) return;
        state[col.name] = Object.assign({}, state[col.name] || {}, { strategy: target });
        const sel = columnsBox.querySelector('.seed-strategy[data-column="' + CSS.escape(col.name) + '"]');
        if (sel) {
          sel.value = target;
          const options = sel.closest('.app-card').querySelector('.seed-options');
          const note = sel.closest('.app-card').querySelector('.seed-note');
          const warn = sel.closest('.app-card').querySelector('.seed-warn');
          buildOptionInputs(options, col, state[col.name]);
          note.textContent = strategyNote(col, target);
          note.classList.toggle('hidden', !note.textContent);
          updateWarn(col, warn);
        }
      });
      close();
    });
    return dialog;
  }

  // ---- Feedback -----------------------------------------------------------

  function showFeedback(warnings) {
    feedback.classList.remove('hidden');
    if (!warnings || !warnings.length) {
      feedback.innerHTML = '';
      feedback.classList.add('hidden');
      return;
    }
    feedback.innerHTML =
      '<div class="alert alert-warning shadow-soft">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>' +
      '<div class="text-sm">' + warnings.map((w) => '<p>' + escapeHtml(w) + '</p>').join('') + '</div>' +
      '</div>';
  }

  function showSql(sql) {
    sqlCode.textContent = sql;
    sqlBox.classList.remove('hidden');
    sqlBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---- Collect plan + submit ---------------------------------------------

  function collectPlan() {
    const plan = {};
    columns.forEach((col) => {
      const st = state[col.name];
      if (!st || !st.strategy) return;
      const out = { strategy: st.strategy };
      Object.keys(st).forEach((k) => {
        if (k === 'strategy' || st[k] === undefined) return;
        out[k] = st[k];
      });
      plan[col.name] = out;
    });
    return plan;
  }

  function currentCount() {
    const n = Number.parseInt(String(countInput ? countInput.value : '10'), 10);
    return Math.max(1, Math.min(cfg.maxRows || 5000, Number.isFinite(n) ? n : 10));
  }

  async function submit(insert) {
    const count = currentCount();
    const plan = collectPlan();
    const path = insert ? '/api/tables/' + t + '/seed' : '/api/tables/' + t + '/seed/generate';
    try {
      const data = await Api.post(path, { count, plan });
      if (insert) {
        UI.showToast(data.message, 'success');
        showFeedback(data.warnings || []);
      } else {
        showSql(data.sql);
        showFeedback(data.warnings || []);
      }
    } catch (e) {
      UI.showError(e.message);
    }
  }

  // ---- Init ---------------------------------------------------------------

  function init() {
    columns.forEach((col) => {
      buildCard(col);
      resetCard(col);
    });
    if (insertBtn) insertBtn.addEventListener('click', () => submit(true));
    if (previewBtn) previewBtn.addEventListener('click', () => submit(false));
    if (resetBtn) resetBtn.addEventListener('click', () => columns.forEach(resetCard));
    if (applyAllBtn) applyAllBtn.addEventListener('click', () => {
      const dialog = document.getElementById('seed-apply-all-dialog') || buildApplyAllDialog();
      dialog.showModal();
    });
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(sqlCode.textContent)
          .then(() => UI.showToast('Copied to clipboard.', 'success'))
          .catch(() => UI.showError('Could not copy.'));
      });
    }
    document.querySelectorAll('.seed-quick').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (countInput) countInput.value = btn.dataset.n;
      });
    });
  }

  init();
})();
