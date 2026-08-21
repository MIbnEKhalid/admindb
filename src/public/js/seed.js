/* "Seed data" page — enhanced interactive data generator.
 *
 * Lets you generate realistic fake rows for a table with 20+ strategies,
 * live preview samples, sparse data simulation, sequential numbering,
 * pattern templates, dual Table/SQL previews, CSV/JSON export, and presets.
 */
(function () {
  'use strict';

  const cfgEl = document.getElementById('seed-config');
  if (!cfgEl) return;

  const cfg = JSON.parse(cfgEl.textContent);
  const t = encodeURIComponent(cfg.table);
  const columns = cfg.columns || [];

  // DOM Elements
  const countInput = document.getElementById('seed-count');
  const searchInput = document.getElementById('seed-search');
  const truncateCheckbox = document.getElementById('seed-truncate');
  const columnsBox = document.getElementById('seed-columns');
  const emptySearchBox = document.getElementById('seed-empty-search');
  const colCountBadge = document.getElementById('seed-col-count-badge');
  const feedback = document.getElementById('seed-feedback');
  const previewCard = document.getElementById('seed-preview-card');
  const previewSummaryBadge = document.getElementById('preview-summary-badge');
  const previewThead = document.getElementById('seed-preview-thead');
  const previewTbody = document.getElementById('seed-preview-tbody');
  const tableViewContainer = document.getElementById('seed-table-view-container');
  const sqlViewContainer = document.getElementById('seed-sql-view-container');
  const sqlCode = document.getElementById('seed-sql-code');
  const tabTableView = document.getElementById('tab-table-view');
  const tabSqlView = document.getElementById('tab-sql-view');

  // Action buttons
  const insertBtn = document.getElementById('seed-insert');
  const previewBtn = document.getElementById('seed-preview');
  const resetBtn = document.getElementById('seed-reset');
  const refreshSamplesBtn = document.getElementById('seed-refresh-samples');
  const applyAllBtn = document.getElementById('seed-apply-all');
  const copySqlBtn = document.getElementById('seed-copy-sql');
  const downloadSqlBtn = document.getElementById('seed-download-sql');
  const exportCsvBtn = document.getElementById('seed-export-csv');
  const exportJsonBtn = document.getElementById('seed-export-json');
  const exportConfigBtn = document.getElementById('seed-export-config');
  const importConfigBtn = document.getElementById('seed-import-config');

  // Modals
  const configDialog = document.getElementById('seed-config-dialog');
  const configDialogTitle = document.getElementById('seed-config-dialog-title');
  const configTextarea = document.getElementById('seed-config-textarea');
  const configDialogCancel = document.getElementById('seed-config-dialog-cancel');
  const configDialogApply = document.getElementById('seed-config-dialog-apply');

  const truncateDialog = document.getElementById('seed-truncate-dialog');
  const truncateCancel = document.getElementById('seed-truncate-cancel');
  const truncateConfirm = document.getElementById('seed-truncate-confirm');

  // State
  const state = {};
  let lastGeneratedResult = null;

  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
  }

  // ---- Client-side Sample Generator (Fast Live Previews) --------------------

  const SAMPLE_FIRST = ["Sombat", "Minh", "Hiroshi", "William", "Ravi", "Zara", "Elena", "Liam", "Mei", "Noah"];
  const SAMPLE_LAST = ["Chen", "Smith", "Thompson", "Shah", "Yamamoto", "Patel", "Garcia", "Kim", "Nguyen", "Davis"];
  const SAMPLE_DOMAINS = ["example.com", "acme.io", "tech.asia", "gmail.com", "startup.io"];
  const SAMPLE_CITIES = ["New York", "Tokyo", "London", "Singapore", "Paris", "Berlin", "Sydney", "Toronto"];
  const SAMPLE_COUNTRIES = ["United States", "Japan", "United Kingdom", "Singapore", "Germany", "France", "Canada", "Australia"];
  const SAMPLE_COMPANIES = ["Apex Solutions", "Vortex Digital", "Nexus Systems", "Horizon Labs", "Quantum Dynamics", "Zenith Global"];
  const SAMPLE_JOBS = ["Software Engineer", "Product Manager", "UX Designer", "DevOps Specialist", "Data Scientist", "Marketing Director"];
  const SAMPLE_STATUSES = ["active", "pending", "completed", "archived", "draft", "verified"];
  const SAMPLE_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD"];
  const SAMPLE_STATES = ["California", "New York", "Texas", "Washington", "Florida", "Illinois"];
  const SAMPLE_WORDS = ["alpha", "beta", "stream", "cloud", "service", "cluster", "record", "node", "signal"];

  function samplePick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function sampleInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function samplePattern(pattern) {
    if (!pattern) return 'INV-2026-' + sampleInt(1000, 9999);
    const now = new Date();
    let s = pattern
      .replace(/\{YYYY\}/g, String(now.getFullYear()))
      .replace(/\{YY\}/g, String(now.getFullYear()).slice(-2))
      .replace(/\{MM\}/g, String(sampleInt(1, 12)).padStart(2, '0'))
      .replace(/\{DD\}/g, String(sampleInt(1, 28)).padStart(2, '0'));
    let res = '';
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '#') res += String(sampleInt(0, 9));
      else if (ch === 'A' || ch === '?') res += upper[sampleInt(0, upper.length - 1)];
      else if (ch === 'a') res += lower[sampleInt(0, lower.length - 1)];
      else res += ch;
    }
    return res;
  }

  function computeSampleValue(col, plan) {
    const st = plan.strategy;
    if (st === 'skip') return '(omitted / default)';
    if (st === 'null') return 'NULL';
    if (plan.nullPct && sampleInt(1, 100) <= plan.nullPct && !col.pk && !col.notnull) {
      return 'NULL (simulated)';
    }

    let val = '';
    switch (st) {
      case 'fixed':
        val = plan.value || '';
        break;
      case 'list': {
        const vals = (plan.values || []).filter((v) => String(v).trim() !== '');
        val = vals.length ? samplePick(vals) : '(empty list)';
        break;
      }
      case 'pattern':
        val = samplePattern(plan.pattern);
        break;
      case 'first':
        val = samplePick(SAMPLE_FIRST);
        break;
      case 'last':
        val = samplePick(SAMPLE_LAST);
        break;
      case 'fullname':
        val = samplePick(SAMPLE_FIRST) + ' ' + samplePick(SAMPLE_LAST);
        break;
      case 'username':
        val = samplePick(SAMPLE_FIRST).toLowerCase() + sampleInt(10, 999);
        break;
      case 'job':
        val = samplePick(SAMPLE_JOBS);
        break;
      case 'company':
        val = samplePick(SAMPLE_COMPANIES);
        break;
      case 'currency':
        val = samplePick(SAMPLE_CURRENCIES);
        break;
      case 'status':
        val = samplePick(SAMPLE_STATUSES);
        break;
      case 'creditCard':
        val = '4532-****-****-' + sampleInt(1000, 9999);
        break;
      case 'avatar':
        val = 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + samplePick(SAMPLE_FIRST).toLowerCase();
        break;
      case 'color':
        val = plan.format === 'name' ? 'Emerald' : '#3b82f6';
        break;
      case 'email':
        val = samplePick(SAMPLE_FIRST).toLowerCase() + '.' + samplePick(SAMPLE_LAST).toLowerCase() + '@' + samplePick(SAMPLE_DOMAINS);
        break;
      case 'phone':
        val = '+1 (' + sampleInt(200, 999) + ') ' + sampleInt(200, 999) + '-' + sampleInt(1000, 9999);
        break;
      case 'city':
        val = samplePick(SAMPLE_CITIES);
        break;
      case 'state':
        val = samplePick(SAMPLE_STATES);
        break;
      case 'country':
        val = samplePick(SAMPLE_COUNTRIES);
        break;
      case 'countryCode':
        val = samplePick(['US', 'GB', 'CA', 'DE', 'JP', 'FR', 'AU', 'SG']);
        break;
      case 'postal':
        val = String(sampleInt(10000, 99999));
        break;
      case 'address':
        val = sampleInt(100, 9999) + ' ' + samplePick(SAMPLE_WORDS) + ' Ave, ' + samplePick(SAMPLE_CITIES);
        break;
      case 'url':
        val = 'https://www.' + samplePick(SAMPLE_DOMAINS) + '/' + samplePick(SAMPLE_WORDS);
        break;
      case 'domain':
        val = samplePick(SAMPLE_DOMAINS);
        break;
      case 'ip':
        val = sampleInt(1, 223) + '.' + sampleInt(0, 255) + '.' + sampleInt(0, 255) + '.' + sampleInt(1, 254);
        break;
      case 'mac':
        val = '00:1A:2B:' + sampleInt(10, 99) + ':' + sampleInt(10, 99) + ':' + sampleInt(10, 99);
        break;
      case 'uuid':
        val = '550e8400-e29b-41d4-a716-' + sampleInt(100000000000, 999999999999);
        break;
      case 'slug':
        val = samplePick(SAMPLE_WORDS) + '-' + samplePick(SAMPLE_WORDS) + '-' + sampleInt(100, 999);
        break;
      case 'words':
        val = samplePick(SAMPLE_WORDS) + ' ' + samplePick(SAMPLE_WORDS);
        break;
      case 'sentence':
        val = 'Lorem ipsum dolor sit ' + samplePick(SAMPLE_WORDS) + ' amet.';
        break;
      case 'paragraph':
        val = 'Lorem ipsum dolor sit amet. Consectetur adipiscing elit ' + samplePick(SAMPLE_WORDS) + ' dynamicus.';
        break;
      case 'latitude':
        val = (Math.random() * 180 - 90).toFixed(6);
        break;
      case 'longitude':
        val = (Math.random() * 360 - 180).toFixed(6);
        break;
      case 'sequence':
        val = String((plan.start || 1));
        break;
      case 'int':
        val = String(sampleInt(plan.min ?? 1, plan.max ?? 1000));
        break;
      case 'decimal': {
        const min = plan.min ?? 1;
        const max = plan.max ?? 1000;
        const prec = plan.precision ?? 2;
        val = (Math.random() * (max - min) + min).toFixed(prec);
        break;
      }
      case 'date':
        val = '2026-03-' + String(sampleInt(1, 28)).padStart(2, '0');
        break;
      case 'datetime':
        val = '2026-03-' + String(sampleInt(1, 28)).padStart(2, '0') + 'T14:30:00.000Z';
        break;
      case 'time':
        val = '14:' + String(sampleInt(10, 59)) + ':00';
        break;
      case 'timestampUnix':
        val = plan.format === 'ms' ? String(Date.now()) : String(Math.floor(Date.now() / 1000));
        break;
      case 'bool':
        val = samplePick(['1', '0']);
        break;
      case 'bytes':
        val = '0x' + sampleInt(100000, 999999).toString(16);
        break;
      case 'json':
        val = '{"scope":"read-only","enabled":true}';
        break;
      case 'hash':
        val = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'.slice(0, plan.maxLen || 32);
        break;
      case 'token':
        val = 'tk_' + sampleInt(100000, 999999);
        break;
      case 'fk':
        val = col.fk ? '[Sample from ' + col.fk.table + ']' : 'NULL';
        break;
      default:
        val = '(auto)';
    }

    if (plan.prefix || plan.suffix) {
      val = (plan.prefix || '') + val + (plan.suffix || '');
    }
    return val;
  }

  // ---- Field Definitions per Strategy -------------------------------------

  function field(key, label, type, attrs) {
    return Object.assign({ key, label, type }, attrs || {});
  }

  const FIELD_DEFS = {
    fixed: [field('value', 'Value', 'text')],
    list: [field('values', 'One value per line', 'textarea')],
    pattern: [field('pattern', 'Pattern (tokens: #=digit, ?=letter, {YYYY})', 'text', { placeholder: 'INV-{YYYY}-####' })],
    int: [field('min', 'Min', 'number'), field('max', 'Max', 'number')],
    decimal: [field('min', 'Min', 'number'), field('max', 'Max', 'number'), field('precision', 'Decimals', 'number', { step: 1, min: 0, max: 10 })],
    sequence: [field('start', 'Start from', 'number', { placeholder: '1' }), field('step', 'Step increment', 'number', { placeholder: '1' })],
    date: [field('from', 'From', 'date'), field('to', 'To', 'date')],
    datetime: [field('from', 'From', 'datetime-local'), field('to', 'To', 'datetime-local')],
    time: [],
    timestampUnix: [field('format', 'Format (sec / ms)', 'select', { options: [{ value: 'sec', label: 'Seconds (10-digit)' }, { value: 'ms', label: 'Milliseconds (13-digit)' }] })],
    color: [field('format', 'Color format', 'select', { options: [{ value: 'hex', label: 'Hex (#3b82f6)' }, { value: 'name', label: 'Color Name (Emerald)' }] })],
    latitude: [field('min', 'Min Lat', 'number', { step: 0.0001, placeholder: '-90' }), field('max', 'Max Lat', 'number', { step: 0.0001, placeholder: '90' })],
    longitude: [field('min', 'Min Lng', 'number', { step: 0.0001, placeholder: '-180' }), field('max', 'Max Lng', 'number', { step: 0.0001, placeholder: '180' })],
    words: [field('minLen', 'Min words', 'number'), field('maxLen', 'Max words', 'number')],
    sentence: [field('minLen', 'Min sentences', 'number'), field('maxLen', 'Max sentences', 'number')],
    paragraph: [],
    bytes: [field('minLen', 'Min bytes', 'number'), field('maxLen', 'Max bytes', 'number')],
    json: [field('jsonKeys', 'JSON keys (comma-separated)', 'text')],
    hash: [field('minLen', 'Min length', 'number'), field('maxLen', 'Max length', 'number')],
    token: [field('minLen', 'Min length', 'number'), field('maxLen', 'Max length', 'number')],
  };

  const CATEGORY_TITLES = {
    identity: '👤 Identity & People',
    contact_web: '🌐 Contact & Web',
    commerce: '🏢 Commerce & Business',
    location: '📍 Location',
    numeric: '🔢 Numbers & Math',
    datetime: '📅 Date & Time',
    system_crypto: '🔒 System & Crypto',
    custom_control: '⚙️ Custom & Control',
    relational: '🔗 Relational (Foreign Key)',
  };

  function strategyNote(col, strategy) {
    if (strategy === 'fk' && col.fk) return 'Sampled from foreign table ' + escapeHtml(col.fk.table) + (col.fk.to ? '.' + escapeHtml(col.fk.to) : '') + '.';
    if (strategy === 'skip') return 'Omitted from INSERT — DB default or NULL applies.';
    if (strategy === 'null') return 'Explicitly set to NULL for all rows.';
    if (strategy === 'pattern') return 'Replaces # with digits, ? with letters, and {YYYY} with year.';
    if (strategy === 'sequence') return 'Generates sequentially incrementing integers across rows.';
    if (strategy === 'json') return 'Generates valid JSON objects compliant with indexes and defaults.';
    if (strategy === 'hash') return 'Generates random cryptographic hex hashes.';
    if (strategy === 'token') return 'Generates short alphanumeric identifier tokens.';
    return '';
  }

  // ---- Card Building ------------------------------------------------------

  function updateCardSample(col, card) {
    const sampleEl = card.querySelector('.seed-sample-value');
    if (sampleEl) {
      const sample = computeSampleValue(col, state[col.name] || {});
      sampleEl.textContent = sample;
    }
  }

  function buildOptionInputs(container, col, plan, card) {
    container.innerHTML = '';
    const fields = FIELD_DEFS[plan.strategy] || [];

    const hasOptions = fields.length > 0;
    const isNullable = !col.pk && !col.notnull;
    const isTextish = !['int', 'decimal', 'bool', 'bytes', 'skip', 'null'].includes(plan.strategy);

    if (!hasOptions && !isNullable) return;

    const wrap = document.createElement('div');
    wrap.className = 'space-y-2 pt-2 border-t border-base-200/60';

    if (fields.length) {
      const grid = document.createElement('div');
      grid.className = 'grid grid-cols-2 gap-2';
      fields.forEach((f) => {
        const fieldWrap = document.createElement('label');
        fieldWrap.className = 'block' + (f.type === 'textarea' || f.key === 'pattern' || f.key === 'jsonKeys' ? ' col-span-2' : '');
        const label = document.createElement('span');
        label.className = 'field-label !mb-1 !text-[11px] font-medium text-base-content/70';
        label.textContent = f.label;
        fieldWrap.appendChild(label);

        let el;
        if (f.type === 'textarea') {
          el = document.createElement('textarea');
          el.rows = 3;
          el.className = 'field-input w-full font-mono !text-[11px] leading-tight';
          el.placeholder = 'one value per line';
          el.spellcheck = false;
          if (Array.isArray(plan.values)) el.value = plan.values.join('\n');
        } else if (f.type === 'select') {
          el = document.createElement('select');
          el.className = 'field-select !py-1 !text-[12px]';
          (f.options || []).forEach((opt) => {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            if (plan[f.key] === opt.value) o.selected = true;
            el.appendChild(o);
          });
        } else {
          el = document.createElement('input');
          el.type = f.type;
          el.className = 'field-input !py-1 !text-[12px]';
          if (f.step != null) el.step = String(f.step);
          if (f.min != null) el.min = String(f.min);
          if (f.max != null) el.max = String(f.max);
          if (f.placeholder) el.placeholder = f.placeholder;
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
          } else if (key === 'value' || key === 'from' || key === 'to' || key === 'pattern' || key === 'format') {
            state[col.name][key] = el.value;
          } else {
            const n = Number(el.value);
            state[col.name][key] = el.value === '' || !Number.isFinite(n) ? undefined : n;
          }
          updateCardSample(col, card);
        });

        fieldWrap.appendChild(el);
        grid.appendChild(fieldWrap);
      });
      wrap.appendChild(grid);
    }

    // Null percentage simulation for nullable columns
    if (isNullable && plan.strategy !== 'skip' && plan.strategy !== 'null') {
      const nullRow = document.createElement('div');
      nullRow.className = 'flex items-center justify-between gap-2 pt-1.5 text-[11px]';
      nullRow.innerHTML =
        '<span class="text-base-content/60">Simulate Nulls:</span>' +
        '<div class="flex items-center gap-1.5">' +
        '<input type="range" min="0" max="100" step="5" value="' + (plan.nullPct || 0) + '" class="range range-xs range-primary w-24" />' +
        '<span class="font-mono text-[11px] w-8 text-right text-base-content/75">' + (plan.nullPct || 0) + '%</span>' +
        '</div>';
      const rangeInput = nullRow.querySelector('input[type="range"]');
      const valSpan = nullRow.querySelector('span:last-child');
      rangeInput.addEventListener('input', () => {
        const val = Number(rangeInput.value);
        valSpan.textContent = val + '%';
        state[col.name].nullPct = val > 0 ? val : undefined;
        updateCardSample(col, card);
      });
      wrap.appendChild(nullRow);
    }

    container.appendChild(wrap);
  }

  function buildCard(col) {
    const card = document.createElement('div');
    card.className = 'app-card p-4 flex flex-col justify-between transition-shadow hover:shadow-md';
    card.dataset.column = col.name;
    card.dataset.type = (col.type || '').toLowerCase();

    // Top Header
    const top = document.createElement('div');
    top.className = 'space-y-3';

    const head = document.createElement('div');
    head.className = 'flex items-start justify-between gap-2';

    const titleBox = document.createElement('div');
    titleBox.className = 'min-w-0';
    const nameRow = document.createElement('div');
    nameRow.className = 'flex flex-wrap items-center gap-1.5';
    const name = document.createElement('span');
    name.className = 'font-mono text-sm font-bold tracking-tight text-base-content';
    name.textContent = col.name;
    nameRow.appendChild(name);

    if (col.pk) {
      const chip = document.createElement('span');
      chip.className = 'badge badge-xs badge-warning font-mono font-bold';
      chip.textContent = 'PK';
      nameRow.appendChild(chip);
    }
    if (col.notnull) {
      const chip = document.createElement('span');
      chip.className = 'badge badge-xs badge-info font-mono';
      chip.textContent = 'NOT NULL';
      nameRow.appendChild(chip);
    } else {
      const chip = document.createElement('span');
      chip.className = 'badge badge-xs badge-ghost text-base-content/40 font-mono';
      chip.textContent = 'NULLABLE';
      nameRow.appendChild(chip);
    }
    if (col.unique) {
      const chip = document.createElement('span');
      chip.className = 'badge badge-xs badge-secondary font-mono';
      chip.textContent = 'UNIQUE';
      nameRow.appendChild(chip);
    }
    if (col.hasDefault) {
      const chip = document.createElement('span');
      chip.className = 'badge badge-xs badge-ghost font-mono';
      chip.textContent = 'DEFAULT';
      nameRow.appendChild(chip);
    }
    if (col.fk) {
      const chip = document.createElement('span');
      chip.className = 'badge badge-xs badge-accent font-mono';
      chip.textContent = 'FK → ' + col.fk.table;
      nameRow.appendChild(chip);
    }

    const typeDesc = document.createElement('p');
    typeDesc.className = 'mt-0.5 text-[11px] font-mono text-base-content/45';
    typeDesc.textContent = col.type || 'untyped';

    titleBox.appendChild(nameRow);
    titleBox.appendChild(typeDesc);
    head.appendChild(titleBox);
    top.appendChild(head);

    // Strategy Dropdown with Categorized <optgroup>s
    const select = document.createElement('select');
    select.className = 'field-select seed-strategy w-full !py-1.5 !text-xs font-medium';
    select.dataset.column = col.name;

    const grouped = {};
    (col.strategies || []).forEach((s) => {
      const cat = s.category || 'custom_control';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(s);
    });

    Object.keys(grouped).forEach((cat) => {
      const grp = document.createElement('optgroup');
      grp.label = CATEGORY_TITLES[cat] || cat;
      grouped[cat].forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.label;
        grp.appendChild(opt);
      });
      select.appendChild(grp);
    });

    top.appendChild(select);

    // Live Sample Chip
    const sampleBox = document.createElement('div');
    sampleBox.className = 'flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-base-200/50 text-[11px]';
    sampleBox.innerHTML =
      '<div class="flex items-center gap-1.5 min-w-0 overflow-hidden text-ellipsis">' +
      '<span class="text-base-content/50 shrink-0 font-medium">Sample:</span>' +
      '<span class="seed-sample-value font-mono text-primary font-medium truncate">...</span>' +
      '</div>' +
      '<button type="button" class="seed-sample-refresh btn btn-ghost btn-xs btn-square h-5 w-5 shrink-0" title="Reroll sample">' +
      '🎲' +
      '</button>';

    const sampleRefreshBtn = sampleBox.querySelector('.seed-sample-refresh');
    sampleRefreshBtn.addEventListener('click', () => updateCardSample(col, card));
    top.appendChild(sampleBox);

    // Strategy-specific options area
    const options = document.createElement('div');
    options.className = 'seed-options';
    top.appendChild(options);

    card.appendChild(top);

    // Bottom notes & warnings
    const bottom = document.createElement('div');
    bottom.className = 'mt-3 pt-2';

    const note = document.createElement('p');
    note.className = 'seed-note hidden text-[11px] leading-relaxed text-base-content/45';
    bottom.appendChild(note);

    const warn = document.createElement('p');
    warn.className = 'seed-warn hidden text-[11px] font-medium text-warning flex items-center gap-1';
    bottom.appendChild(warn);

    card.appendChild(bottom);

    // Event listener for strategy selection change
    select.addEventListener('change', () => {
      const st = select.value;
      state[col.name] = Object.assign({}, state[col.name] || {}, { strategy: st });
      buildOptionInputs(options, col, state[col.name], card);
      note.textContent = strategyNote(col, st);
      note.classList.toggle('hidden', !note.textContent);
      updateWarn(col, warn);
      updateCardSample(col, card);
    });

    columnsBox.appendChild(card);
    return { select, options, note, warn };
  }

  function updateWarn(col, warnEl) {
    const st = state[col.name] ? state[col.name].strategy : null;
    const risky = (st === 'skip' || st === 'null') && !col.pk && col.notnull && !col.hasDefault;
    warnEl.textContent = risky
      ? '⚠️ Column is NOT NULL with no default — "' + st + '" rows may fail.'
      : '';
    warnEl.classList.toggle('hidden', !warnEl.textContent);
  }

  function resetCard(col) {
    const plan = Object.assign({}, col.defaultPlan || { strategy: 'skip' });
    state[col.name] = plan;
    const card = columnsBox.querySelector('.app-card[data-column="' + CSS.escape(col.name) + '"]');
    if (card) {
      const select = card.querySelector('.seed-strategy');
      const options = card.querySelector('.seed-options');
      const note = card.querySelector('.seed-note');
      const warn = card.querySelector('.seed-warn');
      if (select) select.value = plan.strategy;
      buildOptionInputs(options, col, plan, card);
      note.textContent = strategyNote(col, plan.strategy);
      note.classList.toggle('hidden', !note.textContent);
      updateWarn(col, warn);
      updateCardSample(col, card);
    }
  }

  // ---- Filtering / Searching ----------------------------------------------

  function filterColumns() {
    const q = (searchInput ? searchInput.value : '').toLowerCase().trim();
    let visible = 0;
    columns.forEach((col) => {
      const card = columnsBox.querySelector('.app-card[data-column="' + CSS.escape(col.name) + '"]');
      if (!card) return;
      const match = !q || col.name.toLowerCase().includes(q) || (col.type || '').toLowerCase().includes(q);
      card.classList.toggle('hidden', !match);
      if (match) visible += 1;
    });

    if (emptySearchBox) emptySearchBox.classList.toggle('hidden', visible > 0);
    if (colCountBadge) colCountBadge.textContent = visible === columns.length ? `${columns.length} columns` : `${visible} of ${columns.length} columns`;
  }

  // ---- Presets ------------------------------------------------------------

  function applyPreset(type) {
    columns.forEach((col) => {
      if (type === 'realistic') {
        resetCard(col);
      } else if (type === 'minimal') {
        if (!col.pk && !col.notnull && !col.hasDefault) {
          state[col.name] = { strategy: 'null' };
        } else {
          state[col.name] = Object.assign({}, col.defaultPlan || { strategy: 'skip' });
        }
      } else if (type === 'sparse') {
        state[col.name] = Object.assign({}, col.defaultPlan || { strategy: 'skip' });
        if (!col.pk && !col.notnull) {
          state[col.name].nullPct = 30;
        }
      } else if (type === 'numbered') {
        const t = (col.type || '').toUpperCase();
        if (t.startsWith('INTEGER')) {
          state[col.name] = { strategy: 'sequence', start: 1, step: 1 };
        } else if (t === 'TEXT' || t === '') {
          state[col.name] = { strategy: 'pattern', pattern: 'REC-####' };
        } else {
          state[col.name] = Object.assign({}, col.defaultPlan || { strategy: 'skip' });
        }
      }

      // Sync DOM
      const card = columnsBox.querySelector('.app-card[data-column="' + CSS.escape(col.name) + '"]');
      if (card) {
        const select = card.querySelector('.seed-strategy');
        const options = card.querySelector('.seed-options');
        const note = card.querySelector('.seed-note');
        const warn = card.querySelector('.seed-warn');
        if (select) select.value = state[col.name].strategy;
        buildOptionInputs(options, col, state[col.name], card);
        note.textContent = strategyNote(col, state[col.name].strategy);
        note.classList.toggle('hidden', !note.textContent);
        updateWarn(col, warn);
        updateCardSample(col, card);
      }
    });

    if (window.UI && UI.showToast) UI.showToast('Applied preset: ' + type, 'info');
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
    inner.className = 'modal-box app-card max-w-md';
    inner.innerHTML =
      '<h3 class="text-base font-bold">Apply strategy to all columns</h3>' +
      '<p class="mt-1 text-xs text-base-content/60">Columns that do not support the chosen strategy are left untouched.</p>' +
      '<label class="field-label mt-4 text-xs font-medium">Strategy</label>' +
      '<select id="seed-apply-all-select" class="field-select w-full text-xs"></select>' +
      '<div class="mt-5 flex justify-end gap-2">' +
      '<button id="seed-apply-all-cancel" type="button" class="btn btn-ghost btn-sm">Cancel</button>' +
      '<button id="seed-apply-all-go" type="button" class="btn btn-primary btn-sm">Apply to All</button>' +
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
        const card = columnsBox.querySelector('.app-card[data-column="' + CSS.escape(col.name) + '"]');
        if (card) {
          const sel = card.querySelector('.seed-strategy');
          const options = card.querySelector('.seed-options');
          const note = card.querySelector('.seed-note');
          const warn = card.querySelector('.seed-warn');
          if (sel) sel.value = target;
          buildOptionInputs(options, col, state[col.name], card);
          note.textContent = strategyNote(col, target);
          note.classList.toggle('hidden', !note.textContent);
          updateWarn(col, warn);
          updateCardSample(col, card);
        }
      });
      close();
      if (window.UI && UI.showToast) UI.showToast('Strategy applied across columns.', 'success');
    });
    return dialog;
  }

  // ---- Dual-Mode Preview Rendering ---------------------------------------

  function showFeedback(warnings) {
    if (!feedback) return;
    if (!warnings || !warnings.length) {
      feedback.innerHTML = '';
      feedback.classList.add('hidden');
      return;
    }
    feedback.innerHTML =
      '<div class="alert alert-warning shadow-soft">' +
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>' +
      '<div class="text-xs space-y-1">' + warnings.map((w) => '<p>' + escapeHtml(w) + '</p>').join('') + '</div>' +
      '</div>';
    feedback.classList.remove('hidden');
  }

  function renderPreview(data) {
    lastGeneratedResult = data;
    if (!previewCard) return;

    previewCard.classList.remove('hidden');
    if (previewSummaryBadge) {
      previewSummaryBadge.textContent = `${data.count} row(s) generated`;
    }

    // 1. SQL View
    if (sqlCode) sqlCode.textContent = data.sql || '';

    // 2. Table View
    if (previewThead && previewTbody) {
      previewThead.innerHTML = '';
      previewTbody.innerHTML = '';

      const trHead = document.createElement('tr');
      const thIdx = document.createElement('th');
      thIdx.className = 'w-12 text-center text-base-content/40';
      thIdx.textContent = '#';
      trHead.appendChild(thIdx);

      columns.forEach((col) => {
        const th = document.createElement('th');
        th.className = 'whitespace-nowrap font-mono';
        th.innerHTML = escapeHtml(col.name) + ' <span class="text-[10px] text-base-content/40 font-normal">(' + escapeHtml(col.type || 'text') + ')</span>';
        trHead.appendChild(th);
      });
      previewThead.appendChild(trHead);

      const rows = data.previewRows || [];
      rows.forEach((row, i) => {
        const tr = document.createElement('tr');
        const tdIdx = document.createElement('td');
        tdIdx.className = 'text-center font-mono text-[10px] text-base-content/40';
        tdIdx.textContent = String(i + 1);
        tr.appendChild(tdIdx);

        columns.forEach((col) => {
          const td = document.createElement('td');
          td.className = 'font-mono whitespace-nowrap max-w-xs truncate';
          const val = row[col.name];
          if (val === null) {
            td.innerHTML = '<span class="badge badge-xs badge-ghost text-base-content/40">NULL</span>';
          } else if (val === '(default)') {
            td.innerHTML = '<span class="badge badge-xs badge-outline text-base-content/40">DEFAULT</span>';
          } else if (typeof val === 'boolean') {
            td.innerHTML = val ? '<span class="badge badge-xs badge-success">TRUE</span>' : '<span class="badge badge-xs badge-ghost">FALSE</span>';
          } else {
            td.textContent = String(val);
          }
          tr.appendChild(td);
        });
        previewTbody.appendChild(tr);
      });
    }

    previewCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function setPreviewTab(tab) {
    if (tab === 'table') {
      tabTableView.classList.add('tab-active');
      tabSqlView.classList.remove('tab-active');
      tableViewContainer.classList.remove('hidden');
      sqlViewContainer.classList.add('hidden');
    } else {
      tabSqlView.classList.add('tab-active');
      tabTableView.classList.remove('tab-active');
      sqlViewContainer.classList.remove('hidden');
      tableViewContainer.classList.add('hidden');
    }
  }

  // ---- Export Handlers ----------------------------------------------------

  function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    if (!lastGeneratedResult || !lastGeneratedResult.previewRows) {
      if (window.UI && UI.showError) UI.showError('Generate preview data first.');
      return;
    }
    const rows = lastGeneratedResult.previewRows;
    const colNames = columns.map((c) => c.name);
    let csv = colNames.map((c) => `"${c.replace(/"/g, '""')}"`).join(',') + '\n';
    rows.forEach((r) => {
      csv += colNames.map((c) => {
        const v = r[c];
        if (v == null) return '';
        return `"${String(v).replace(/"/g, '""')}"`;
      }).join(',') + '\n';
    });
    downloadFile(csv, `${cfg.table}_seed_data.csv`, 'text/csv;charset=utf-8;');
  }

  function exportJson() {
    if (!lastGeneratedResult || !lastGeneratedResult.previewRows) {
      if (window.UI && UI.showError) UI.showError('Generate preview data first.');
      return;
    }
    const jsonStr = JSON.stringify(lastGeneratedResult.previewRows, null, 2);
    downloadFile(jsonStr, `${cfg.table}_seed_data.json`, 'application/json;charset=utf-8;');
  }

  function downloadSql() {
    if (!lastGeneratedResult || !lastGeneratedResult.sql) {
      if (window.UI && UI.showError) UI.showError('Generate preview data first.');
      return;
    }
    downloadFile(lastGeneratedResult.sql, `${cfg.table}_seed.sql`, 'text/sql;charset=utf-8;');
  }

  // ---- Collect Plan + Submit ----------------------------------------------

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

  async function executeSeed(truncate = false) {
    const count = currentCount();
    const plan = collectPlan();
    const path = '/api/tables/' + t + '/seed';
    try {
      if (insertBtn) {
        insertBtn.disabled = true;
        insertBtn.classList.add('loading');
      }
      const data = await Api.post(path, { count, plan, truncate });
      if (window.UI && UI.showToast) {
        UI.showToast(data.message || `Inserted ${data.inserted} row(s) successfully.`, 'success');
      }
      showFeedback(data.warnings || []);
    } catch (e) {
      if (window.UI && UI.showError) UI.showError(e.message);
    } finally {
      if (insertBtn) {
        insertBtn.disabled = false;
        insertBtn.classList.remove('loading');
      }
    }
  }

  async function submitPreview() {
    const count = currentCount();
    const plan = collectPlan();
    const path = '/api/tables/' + t + '/seed/generate';
    try {
      if (previewBtn) previewBtn.disabled = true;
      const data = await Api.post(path, { count, plan });
      renderPreview(data);
      showFeedback(data.warnings || []);
    } catch (e) {
      if (window.UI && UI.showError) UI.showError(e.message);
    } finally {
      if (previewBtn) previewBtn.disabled = false;
    }
  }

  // ---- Init ---------------------------------------------------------------

  function init() {
    columns.forEach((col) => {
      buildCard(col);
      resetCard(col);
    });

    filterColumns();

    // Event Listeners
    if (searchInput) searchInput.addEventListener('input', filterColumns);
    if (previewBtn) previewBtn.addEventListener('click', submitPreview);

    if (insertBtn) {
      insertBtn.addEventListener('click', () => {
        if (truncateCheckbox && truncateCheckbox.checked) {
          if (truncateDialog) truncateDialog.showModal();
        } else {
          executeSeed(false);
        }
      });
    }

    if (truncateConfirm) {
      truncateConfirm.addEventListener('click', () => {
        if (truncateDialog) truncateDialog.close();
        executeSeed(true);
      });
    }

    if (truncateCancel) {
      truncateCancel.addEventListener('click', () => {
        if (truncateDialog) truncateDialog.close();
      });
    }

    if (resetBtn) resetBtn.addEventListener('click', () => columns.forEach(resetCard));
    if (refreshSamplesBtn) refreshSamplesBtn.addEventListener('click', () => {
      columns.forEach((col) => {
        const card = columnsBox.querySelector('.app-card[data-column="' + CSS.escape(col.name) + '"]');
        if (card) updateCardSample(col, card);
      });
    });

    if (applyAllBtn) {
      applyAllBtn.addEventListener('click', () => {
        const dialog = document.getElementById('seed-apply-all-dialog') || buildApplyAllDialog();
        dialog.showModal();
      });
    }

    // Presets
    const pReal = document.getElementById('preset-realistic');
    const pMin = document.getElementById('preset-minimal');
    const pSparse = document.getElementById('preset-sparse');
    const pNum = document.getElementById('preset-numbered');
    if (pReal) pReal.addEventListener('click', () => applyPreset('realistic'));
    if (pMin) pMin.addEventListener('click', () => applyPreset('minimal'));
    if (pSparse) pSparse.addEventListener('click', () => applyPreset('sparse'));
    if (pNum) pNum.addEventListener('click', () => applyPreset('numbered'));

    // Config export / import
    if (exportConfigBtn) {
      exportConfigBtn.addEventListener('click', () => {
        if (!configDialog || !configTextarea) return;
        configDialogTitle.textContent = 'Export Seed Plan';
        configTextarea.value = JSON.stringify(collectPlan(), null, 2);
        configDialogApply.classList.add('hidden');
        configDialog.showModal();
      });
    }

    if (importConfigBtn) {
      importConfigBtn.addEventListener('click', () => {
        if (!configDialog || !configTextarea) return;
        configDialogTitle.textContent = 'Import Seed Plan';
        configTextarea.value = '';
        configTextarea.placeholder = 'Paste plan JSON here...';
        configDialogApply.classList.remove('hidden');
        configDialog.showModal();
      });
    }

    if (configDialogCancel) {
      configDialogCancel.addEventListener('click', () => {
        if (configDialog) configDialog.close();
      });
    }

    if (configDialogApply) {
      configDialogApply.addEventListener('click', () => {
        try {
          const imported = JSON.parse(configTextarea.value);
          if (typeof imported !== 'object' || !imported) throw new Error('Invalid JSON format');
          columns.forEach((col) => {
            if (imported[col.name]) {
              state[col.name] = imported[col.name];
              const card = columnsBox.querySelector('.app-card[data-column="' + CSS.escape(col.name) + '"]');
              if (card) {
                const select = card.querySelector('.seed-strategy');
                const options = card.querySelector('.seed-options');
                const note = card.querySelector('.seed-note');
                const warn = card.querySelector('.seed-warn');
                if (select) select.value = state[col.name].strategy;
                buildOptionInputs(options, col, state[col.name], card);
                note.textContent = strategyNote(col, state[col.name].strategy);
                note.classList.toggle('hidden', !note.textContent);
                updateWarn(col, warn);
                updateCardSample(col, card);
              }
            }
          });
          if (configDialog) configDialog.close();
          if (window.UI && UI.showToast) UI.showToast('Seed plan configuration applied!', 'success');
        } catch (err) {
          if (window.UI && UI.showError) UI.showError('Failed to parse JSON: ' + err.message);
        }
      });
    }

    // Dual-mode tabs
    if (tabTableView) tabTableView.addEventListener('click', () => setPreviewTab('table'));
    if (tabSqlView) tabSqlView.addEventListener('click', () => setPreviewTab('sql'));

    // Export buttons
    if (copySqlBtn) {
      copySqlBtn.addEventListener('click', () => {
        if (!sqlCode || !sqlCode.textContent) return;
        navigator.clipboard.writeText(sqlCode.textContent)
          .then(() => UI.showToast('Copied SQL to clipboard.', 'success'))
          .catch(() => UI.showError('Could not copy SQL.'));
      });
    }

    if (downloadSqlBtn) downloadSqlBtn.addEventListener('click', downloadSql);
    if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportCsv);
    if (exportJsonBtn) exportJsonBtn.addEventListener('click', exportJson);

    // Quick counts
    document.querySelectorAll('.seed-quick').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (countInput) countInput.value = btn.dataset.n;
      });
    });
  }

  init();
})();
