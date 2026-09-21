/* AdminDB Unified Schema-Aware Seed Data Generator Controller
 * Supports Single Table, ER Relational Chain, and Full Database generation.
 */
(function () {
  'use strict';

  const cfgEl = document.getElementById('seed-config');
  if (!cfgEl) return;

  const cfg = JSON.parse(cfgEl.textContent);
  const rootTableName = cfg.table;
  const rootColumns = cfg.columns || [];
  const urlParams = new URLSearchParams(window.location.search);
  const initialMode = cfg.mode || urlParams.get('mode') || 'single';

  // ---- Application State ----
  let currentStep = 2; // In workspace view, active config studio is primary
  let mode = initialMode === 'chain' ? 'chain' : 'single';
  let prngSeed = null;
  const stateByTable = {}; // tableName -> { colName -> plan }
  const tableModes = {}; // tableName -> 'generate' | 'use_existing' | 'generate_if_empty' | 'skip'
  const tableCounts = {}; // tableName -> number
  let chainConfigData = null; // ER chain / schema data
  let lastPreviewResult = null;
  let activePreviewTable = rootTableName;
  let previewDebounceTimer = null;

  // Initialize root table column state
  stateByTable[rootTableName] = {};
  tableModes[rootTableName] = 'generate';
  tableCounts[rootTableName] = 10;
  rootColumns.forEach((col) => {
    stateByTable[rootTableName][col.name] = Object.assign({}, col.defaultPlan || { strategy: 'skip' });
  });

  // ---- DOM Elements ----
  const progressBar = document.getElementById('wizard-progress-bar');
  const stepNav1 = document.getElementById('step-nav-1');
  const stepNav2 = document.getElementById('step-nav-2');
  const stepNav3 = document.getElementById('step-nav-3');
  const content1 = document.getElementById('step-content-1');
  const content2 = document.getElementById('step-content-2');
  const content3 = document.getElementById('step-content-3');

  const btnSelectSingle = document.getElementById('btn-select-single');
  const btnSelectChain = document.getElementById('btn-select-chain');
  const btnNext1 = document.getElementById('btn-next-1');
  const btnNext2 = document.getElementById('btn-next-2');
  const btnPrev2 = document.getElementById('btn-prev-2');
  const btnPrev3 = document.getElementById('btn-prev-3');

  const configSingle = document.getElementById('config-single');
  const configChain = document.getElementById('config-chain');
  const singleColumnsBox = document.getElementById('seed-columns');
  const singleCountInput = document.getElementById('seed-count');
  const decBtn = document.getElementById('seed-count-dec');
  const incBtn = document.getElementById('seed-count-inc');
  const colSearchInput = document.getElementById('seed-col-search');
  const colCountBadge = document.getElementById('col-count-badge');

  const planSeedInput = document.getElementById('plan-seed-input');
  const btnRandomSeed = document.getElementById('btn-random-seed');
  const planTransactionOpt = document.getElementById('plan-transaction-opt');
  const planRollbackOpt = document.getElementById('plan-rollback-opt');

  const chainScopeSelect = document.getElementById('chain-scope');
  const chainPipelineContainer = document.getElementById('chain-pipeline-container');
  const chainSummaryBadge = document.getElementById('chain-summary-badge');

  const validationStatusDot = document.getElementById('validation-status-dot');
  const validationStatusText = document.getElementById('validation-status-text');
  const validationIssuesList = document.getElementById('validation-issues-list');
  const validationSummaryChip = document.getElementById('validation-summary-chip');

  const previewTabGrid = document.getElementById('preview-tab-grid');
  const previewTabSql = document.getElementById('preview-tab-sql');
  const previewViewGrid = document.getElementById('preview-view-grid');
  const previewViewSql = document.getElementById('preview-view-sql');
  const previewThead = document.getElementById('seed-preview-thead');
  const previewTbody = document.getElementById('seed-preview-tbody');
  const previewSqlCode = document.getElementById('preview-sql-code');
  const btnCopySql = document.getElementById('btn-copy-sql');
  const chainTableTabs = document.getElementById('seed-chain-table-tabs');
  const refreshPreviewBtn = document.getElementById('seed-refresh-preview');

  const truncateCheckbox = document.getElementById('seed-truncate');
  const truncateBanner = document.getElementById('seed-truncate-banner');
  const truncateDialog = document.getElementById('seed-truncate-dialog');
  const truncateConfirm = document.getElementById('seed-truncate-confirm');
  const truncateCancel = document.getElementById('seed-truncate-cancel');
  const insertBtn = document.getElementById('seed-insert');
  const feedbackBox = document.getElementById('seed-feedback');

  const btnProfilesModal = document.getElementById('btn-profiles-modal');
  const profilesDialog = document.getElementById('seed-profiles-dialog');
  const btnCloseProfiles = document.getElementById('btn-close-profiles');
  const profileNameInput = document.getElementById('profile-name-input');
  const btnSaveProfile = document.getElementById('btn-save-profile');
  const profilesListContainer = document.getElementById('profiles-list-container');
  const btnExportPlanJson = document.getElementById('btn-export-plan-json');
  const inputImportPlanJson = document.getElementById('input-import-plan-json');

  // ---- Utilities ----
  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
  }

  function samplePick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function sampleInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function computeSampleValue(col, plan, allCols = []) {
    const st = plan.strategy;
    if (st === 'skip') return '(auto / default)';
    if (st === 'null') return 'NULL';
    if (st === 'template') {
      let t = plan.template || '{{first_name}}';
      allCols.forEach((c) => {
        const dummyVal = c.name.toLowerCase().includes('first') ? 'Alex' : (c.name.toLowerCase().includes('last') ? 'Morgan' : (c.name.toLowerCase().includes('name') ? 'Alex Morgan' : `[${c.name}]`));
        const valToUse = t.includes('@') && !dummyVal.startsWith('[') ? dummyVal.toLowerCase().replace(/\s+/g, '.') : dummyVal;
        t = t.replace(new RegExp(`\\{\\{\\s*${c.name}\\s*\\}\\}`, 'gi'), valToUse);
      });
      t = t.replace(/\{\{\s*year\s*\}\}/gi, String(new Date().getFullYear()));
      t = t.replace(/\{\{\s*sequence(?::\d+(?::\d+)?)?\s*\}\}/gi, '1');
      t = t.replace(/\{\{\s*random(?::\d+,\d+)?\s*\}\}/gi, '42');
      t = t.replace(/\{\{\s*uuid\s*\}\}/gi, '550e8400-e29b-41d4-a716-446655440000');
      return t;
    }
    if (st === 'fixed') return plan.value || '';
    if (st === 'list') return plan.values && plan.values.length ? samplePick(plan.values) : '(empty list)';
    if (st === 'pattern') return (plan.pattern || 'INV-####').replace(/#/g, () => sampleInt(0, 9));
    if (st === 'first') return 'Alex';
    if (st === 'last') return 'Morgan';
    if (st === 'fullname') return 'Alex Morgan';
    if (st === 'email') return 'alex.morgan@example.com';
    if (st === 'status') return 'active';
    if (st === 'company') return 'Acme Corp';
    if (st === 'city') return 'San Francisco';
    if (st === 'country') return 'United States';
    if (st === 'int') return String(sampleInt(plan.min ?? 1, plan.max ?? 1000));
    if (st === 'decimal') return (Math.random() * ((plan.max ?? 1000) - (plan.min ?? 1)) + (plan.min ?? 1)).toFixed(plan.precision ?? 2);
    if (st === 'bool') return samplePick(['true', 'false']);
    if (st === 'sequence') return String(plan.start || 1);
    if (st === 'uuid') return '550e8400-e29b-41d4-a716-446655440000';
    if (st === 'product') return 'Wireless Noise-Canceling Earbuds';
    if (st === 'productCategory') return 'Electronics';
    if (st === 'department') return 'Engineering';
    if (st === 'paymentMethod') return 'Credit Card';
    if (st === 'transactionType') return 'purchase';
    if (st === 'techSkill') return 'TypeScript';
    if (st === 'orderStatus') return 'delivered';
    if (st === 'fk') return `[FK -> ${col.fk ? col.fk.table : 'parent'}]`;
    if (st === 'sampleExisting') return '[Sampled DB Value]';
    return '(sample)';
  }

  // Debounced preview generator
  function triggerPreviewUpdate(delay = 400) {
    if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(() => {
      runPlanValidation();
      generateDataPreview();
    }, delay);
  }

  // ---- Generation Plan Builder ----
  function buildCurrentGenerationPlan() {
    const isSingle = mode === 'single';
    const plan = {
      name: isSingle ? `Single Table ${rootTableName}` : `ER Relational Seed ${rootTableName}`,
      rootTable: rootTableName,
      scope: isSingle ? 'single' : (chainScopeSelect?.value || 'chain'),
      tables: {},
      options: {
        seed: prngSeed != null && Number.isFinite(prngSeed) ? prngSeed : null,
        transaction: planTransactionOpt?.checked ?? true,
        rollbackOnError: planRollbackOpt?.checked ?? true,
        truncateAll: truncateCheckbox?.checked ?? false,
      },
    };

    if (isSingle) {
      plan.tables[rootTableName] = {
        mode: 'generate',
        rows: Math.max(1, parseInt(singleCountInput?.value, 10) || 10),
        columns: stateByTable[rootTableName] || {},
        truncate: truncateCheckbox?.checked ?? false,
      };
    } else if (chainConfigData && chainConfigData.tables) {
      chainConfigData.tables.forEach((node) => {
        const tMode = tableModes[node.name] || 'generate';
        plan.tables[node.name] = {
          mode: tMode,
          rows: Math.max(1, tableCounts[node.name] || node.suggestedCount || 10),
          columns: stateByTable[node.name] || {},
          truncate: truncateCheckbox?.checked ?? false,
        };
      });
      plan.relationships = chainConfigData.relationships;
    }

    return plan;
  }

  // ---- Pre-flight Validation ----
  async function runPlanValidation() {
    if (mode === 'chain' && !chainConfigData) {
      await loadChainPipeline();
    }
    const plan = buildCurrentGenerationPlan();
    try {
      const report = await Api.post('/api/seed/validate', { plan });
      renderValidationReport(report);
    } catch {
      /* ignore */
    }
  }

  function renderValidationReport(report) {
    if (!report) return;
    const errors = (report.issues || []).filter((i) => i.type === 'error');
    const warnings = (report.issues || []).filter((i) => i.type === 'warning');

    if (validationStatusDot && validationStatusText && validationSummaryChip) {
      if (errors.length === 0) {
        validationStatusDot.className = 'w-2 h-2 rounded-full bg-success';
        validationStatusText.textContent = warnings.length ? `${warnings.length} Warning(s)` : 'Plan Ready';
        validationSummaryChip.className = 'badge badge-sm badge-success font-mono text-[10px] font-bold';
        validationSummaryChip.textContent = warnings.length ? 'Warnings' : 'All Checks Passed';
      } else {
        validationStatusDot.className = 'w-2 h-2 rounded-full bg-error animate-pulse';
        validationStatusText.textContent = `${errors.length} Issue(s)`;
        validationSummaryChip.className = 'badge badge-sm badge-error font-mono text-[10px] font-bold';
        validationSummaryChip.textContent = 'Action Required';
      }
    }

    if (validationIssuesList) {
      validationIssuesList.innerHTML = '';
      if (errors.length === 0 && warnings.length === 0) {
        validationIssuesList.innerHTML = `
          <div class="flex items-center gap-2 text-success font-medium text-[11px]">
            <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
            <span>Primary key & constraint strategies valid</span>
          </div>
        `;
      } else {
        errors.forEach((err) => {
          validationIssuesList.innerHTML += `
            <div class="flex items-start gap-1.5 text-error font-medium text-[11px]">
              <svg class="h-3.5 w-3.5 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
              <span><strong>${escapeHtml(err.table || '')}:</strong> ${escapeHtml(err.message)}</span>
            </div>
          `;
        });
        warnings.forEach((warn) => {
          validationIssuesList.innerHTML += `
            <div class="flex items-start gap-1.5 text-warning font-medium text-[11px]">
              <svg class="h-3.5 w-3.5 shrink-0 mt-0.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>
              <span><strong>${escapeHtml(warn.table || '')}:</strong> ${escapeHtml(warn.message)}</span>
            </div>
          `;
        });
      }
    }
  }

  // ---- Workspace Navigation & Mode Switching ----
  function goToStep(step) {
    currentStep = step;
  }

  function selectMode(targetMode, updateUrl = false) {
    mode = targetMode === 'chain' ? 'chain' : 'single';
    if (btnSelectSingle) btnSelectSingle.classList.toggle('active', mode === 'single');
    if (btnSelectChain) btnSelectChain.classList.toggle('active', mode === 'chain');
    if (configSingle) configSingle.classList.toggle('hidden', mode !== 'single');
    if (configChain) configChain.classList.toggle('hidden', mode !== 'chain');

    if (mode === 'single') {
      if (singleColumnsBox && singleColumnsBox.children.length === 0) {
        renderSingleTableColumns(rootTableName, rootColumns, singleColumnsBox);
      }
    } else if (mode === 'chain') {
      if (!chainConfigData) {
        loadChainPipeline();
      }
    }

    if (updateUrl && window.history && window.history.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.set('mode', mode);
      window.history.replaceState({}, '', url.toString());
    }

    triggerPreviewUpdate(100);
  }

  // ---- Single Table Column Plan Renderer ----
  function renderSingleTableColumns(tableName, cols, container) {
    container.innerHTML = '';
    if (!stateByTable[tableName]) stateByTable[tableName] = {};

    cols.forEach((col) => {
      if (!stateByTable[tableName][col.name]) {
        stateByTable[tableName][col.name] = Object.assign({}, col.defaultPlan || { strategy: 'skip' });
      }
      const plan = stateByTable[tableName][col.name];

      const row = document.createElement('div');
      row.className = 'seed-col-row';
      row.dataset.colName = col.name.toLowerCase();
      row.dataset.strategyType = plan.strategy === 'template' ? 'template' : (plan.strategy === 'skip' ? 'skip' : (plan.strategy === 'null' ? 'null' : (plan.strategy === 'fixed' ? 'fixed' : 'generate')));

      // Badges
      let badges = '';
      if (col.pk) badges += '<span class="badge badge-xs badge-warning font-mono font-bold text-[9px] px-1">PK</span>';
      if (col.notnull) badges += '<span class="badge badge-xs badge-error font-mono font-bold text-[9px] px-1">REQ</span>';
      if (col.unique) badges += '<span class="badge badge-xs badge-secondary font-mono font-bold text-[9px] px-1">UQ</span>';
      if (col.fk) badges += `<span class="badge badge-xs badge-outline font-mono text-[9px] text-base-content/60">↳ ${escapeHtml(col.fk.table)}.${escapeHtml(col.fk.column)}</span>`;

      row.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2.5">
          <div class="flex items-center gap-2 min-w-0">
            <span class="font-mono font-bold text-xs text-base-content truncate">${escapeHtml(col.name)}</span>
            <span class="font-mono text-[10px] text-base-content/40 uppercase">${escapeHtml(col.type)}</span>
            ${badges}
          </div>

          <div class="flex items-center gap-2 flex-wrap">
            <select class="col-strategy-select field-select !py-0.5 text-xs font-mono font-semibold w-40">
              ${(col.strategies || []).map((s) => `<option value="${s.id}" ${s.id === plan.strategy ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
            </select>
            <span class="sample-pill col-sample-badge" title="Click to copy sample value"></span>
          </div>
        </div>

        <div class="col-options-box hidden mt-2.5 pt-2 border-t border-base-200/60"></div>
      `;

      const select = row.querySelector('.col-strategy-select');
      const optionsBox = row.querySelector('.col-options-box');
      const sampleBadge = row.querySelector('.col-sample-badge');

      const updateSample = () => {
        const sampleVal = computeSampleValue(col, stateByTable[tableName][col.name], cols);
        sampleBadge.textContent = sampleVal;
        row.dataset.strategyType = plan.strategy === 'template' ? 'template' : (plan.strategy === 'skip' ? 'skip' : (plan.strategy === 'null' ? 'null' : (plan.strategy === 'fixed' ? 'fixed' : 'generate')));
        triggerPreviewUpdate(400);
      };

      sampleBadge.addEventListener('click', () => {
        navigator.clipboard.writeText(sampleBadge.textContent || '');
        if (window.UI && UI.showToast) UI.showToast(`Copied "${sampleBadge.textContent}" to clipboard`, 'info');
      });

      select.addEventListener('change', () => {
        stateByTable[tableName][col.name].strategy = select.value;
        buildColumnOptionsUI(optionsBox, col, stateByTable[tableName][col.name], cols, updateSample);
        updateSample();
      });

      buildColumnOptionsUI(optionsBox, col, plan, cols, updateSample);
      updateSample();
      container.appendChild(row);
    });

    if (colCountBadge) colCountBadge.textContent = `${cols.length} cols`;
  }

  function buildColumnOptionsUI(container, col, plan, allCols, updateSampleCb) {
    container.innerHTML = '';
    const st = plan.strategy;

    const needsOptions = ['fixed', 'list', 'template', 'int', 'decimal', 'date', 'datetime', 'pattern', 'sequence'].includes(st);
    container.classList.toggle('hidden', !needsOptions);
    if (!needsOptions) return;

    const addField = (label, key, type = 'text', placeholder = '') => {
      const wrap = document.createElement('div');
      wrap.innerHTML = `<label class="block text-[9px] uppercase font-bold text-base-content/50 mb-0.5">${escapeHtml(label)}</label>`;
      const inp = document.createElement(type === 'textarea' ? 'textarea' : 'input');
      if (type !== 'textarea') inp.type = type;
      inp.placeholder = placeholder;
      inp.className = type === 'textarea' ? 'field-input w-full text-xs font-mono !py-1 h-14 leading-relaxed' : 'field-input w-full text-xs font-mono !py-0.5';
      
      const val = plan[key];
      if (type === 'textarea' && Array.isArray(val)) inp.value = val.join('\n');
      else if (val !== undefined) inp.value = val;

      inp.addEventListener('input', () => {
        if (type === 'textarea') plan[key] = inp.value.split('\n').map((s) => s.trim()).filter(Boolean);
        else if (type === 'number') plan[key] = inp.value === '' ? undefined : Number(inp.value);
        else plan[key] = inp.value;
        updateSampleCb();
      });
      wrap.appendChild(inp);
      container.appendChild(wrap);
      return inp;
    };

    if (st === 'fixed') addField('Constant Value', 'value', 'text', 'Default string');
    if (st === 'list') addField('Choices (One per line)', 'values', 'textarea', 'admin\nmember\nguest');
    if (st === 'template') {
      const inp = addField('Template Expression', 'template', 'text', '{{first_name}}.{{last_name}}@example.com');
      
      // Token chips helper
      const chipsWrap = document.createElement('div');
      chipsWrap.className = 'space-y-1 pt-1';
      chipsWrap.innerHTML = '<span class="text-[9px] uppercase font-bold text-base-content/40 tracking-wider">Quick Tokens:</span>';
      
      const chips = document.createElement('div');
      chips.className = 'flex flex-wrap gap-1';

      // Insert column tokens
      allCols.slice(0, 6).forEach((c) => {
        if (c.name !== col.name) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'token-chip';
          btn.textContent = `+ {{${c.name}}}`;
          btn.onclick = () => {
            plan.template = (plan.template || '') + `{{${c.name}}}`;
            if (inp) inp.value = plan.template;
            updateSampleCb();
          };
          chips.appendChild(btn);
        }
      });

      // Built-in function tokens
      const builtins = [
        { label: '+ {{year}}', val: '{{year}}' },
        { label: '+ {{sequence}}', val: '{{sequence:1:1}}' },
        { label: '+ {{random}}', val: '{{random:1,100}}' },
      ];
      builtins.forEach((b) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'token-chip';
        btn.textContent = b.label;
        btn.onclick = () => {
          plan.template = (plan.template || '') + b.val;
          if (inp) inp.value = plan.template;
          updateSampleCb();
        };
        chips.appendChild(btn);
      });

      chipsWrap.appendChild(chips);
      container.appendChild(chipsWrap);
    }
    if (st === 'int' || st === 'decimal') {
      const grid = document.createElement('div');
      grid.className = 'grid grid-cols-2 sm:grid-cols-3 gap-2';
      container.appendChild(grid);
      const tmp = container;
      container = grid;
      addField('Min Value', 'min', 'number', '1');
      addField('Max Value', 'max', 'number', '1000');
      if (st === 'decimal') addField('Decimals', 'precision', 'number', '2');
      container = tmp;
    }
    if (st === 'date' || st === 'datetime') {
      const grid = document.createElement('div');
      grid.className = 'grid grid-cols-2 gap-2';
      container.appendChild(grid);
      const tmp = container;
      container = grid;
      addField('From Date', 'from', 'text', '2020-01-01');
      addField('To Date', 'to', 'text', '2026-12-31');
      container = tmp;
    }
    if (st === 'pattern') addField('Pattern Expression', 'pattern', 'text', 'INV-2026-####');
    if (st === 'sequence') {
      const grid = document.createElement('div');
      grid.className = 'grid grid-cols-2 gap-2';
      container.appendChild(grid);
      const tmp = container;
      container = grid;
      addField('Start Sequence', 'start', 'number', '1');
      addField('Step', 'step', 'number', '1');
      container = tmp;
    }
  }

  // Column search filter
  if (colSearchInput) {
    colSearchInput.addEventListener('input', () => {
      const q = colSearchInput.value.toLowerCase().trim();
      const rows = singleColumnsBox.querySelectorAll('.seed-col-row');
      let visible = 0;
      rows.forEach((r) => {
        const matches = !q || r.dataset.colName.includes(q);
        r.classList.toggle('hidden', !matches);
        if (matches) visible++;
      });
      if (colCountBadge) colCountBadge.textContent = `${visible} of ${rootColumns.length} cols`;
    });
  }

  // ---- ER Relational Chain Pipeline ----
  async function loadChainPipeline() {
    const scope = chainScopeSelect?.value || 'chain';
    chainPipelineContainer.innerHTML = '<div class="py-8 text-center text-xs text-base-content/50"><span class="loading loading-spinner loading-sm text-primary mb-2"></span><br><strong class="font-bold text-base-content">Analyzing foreign keys & dependency DAG…</strong></div>';

    try {
      chainConfigData = await Api.get(`/api/tables/${encodeURIComponent(rootTableName)}/seed/chain?scope=${scope}`);
      if (chainSummaryBadge) chainSummaryBadge.textContent = `${chainConfigData.tables.length} Tables`;
      chainPipelineContainer.innerHTML = '';

      chainConfigData.tables.forEach((node, idx) => {
        if (!tableCounts[node.name]) tableCounts[node.name] = node.suggestedCount || 10;
        if (!tableModes[node.name]) tableModes[node.name] = 'generate';
        if (!stateByTable[node.name]) {
          stateByTable[node.name] = {};
          (node.columns || []).forEach((c) => {
            stateByTable[node.name][c.name] = Object.assign({}, c.defaultPlan || { strategy: 'skip' });
          });
        }

        const isTarget = node.name === rootTableName;
        const item = document.createElement('div');
        item.className = 'pipeline-node';
        item.dataset.nodeMode = tableModes[node.name];
        item.innerHTML = `
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <span class="w-6 h-6 rounded ${isTarget ? 'bg-primary text-primary-content font-bold' : 'bg-base-200 text-base-content/70'} text-[11px] flex items-center justify-center font-mono">${idx + 1}</span>
              <div>
                <div class="font-mono font-bold text-xs flex items-center gap-2">
                  <span class="text-base-content">${escapeHtml(node.name)}</span>
                  ${isTarget ? '<span class="badge badge-xs badge-primary font-mono text-[9px] px-1.5">Root</span>' : ''}
                  ${node.isJunction ? '<span class="badge badge-xs badge-accent font-mono text-[9px] px-1.5">Junction (M:N)</span>' : ''}
                  ${node.hasSelfRef ? '<span class="badge badge-xs badge-info font-mono text-[9px] px-1.5">Self-Ref</span>' : ''}
                </div>
                <div class="text-[10px] text-base-content/50 mt-0.5 flex gap-2 font-mono">
                  <span>← ${node.parents.length} parents</span>
                  <span>→ ${node.children.length} children</span>
                  <span>(${node.rowCount} rows)</span>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <select class="chain-table-mode field-select !py-0.5 text-xs font-semibold w-36" data-table="${escapeHtml(node.name)}">
                <option value="generate" ${tableModes[node.name] === 'generate' ? 'selected' : ''}>🌱 Generate Data</option>
                <option value="use_existing" ${tableModes[node.name] === 'use_existing' ? 'selected' : ''}>📦 Use Existing</option>
                <option value="generate_if_empty" ${tableModes[node.name] === 'generate_if_empty' ? 'selected' : ''}>⚡ If Empty</option>
                <option value="skip" ${tableModes[node.name] === 'skip' ? 'selected' : ''}>⛔ Skip</option>
              </select>

              <input type="number" min="1" max="5000" value="${tableCounts[node.name]}"
                class="chain-table-rows field-input !py-0.5 w-16 text-right font-mono font-bold text-xs" data-table="${escapeHtml(node.name)}" />

              <button type="button" class="btn btn-xs btn-ghost border border-base-300 btn-toggle-cols" data-table="${escapeHtml(node.name)}">
                Cols ▼
              </button>
            </div>
          </div>

          <div class="chain-col-drawer hidden pt-3 mt-2.5 border-t border-base-200">
            <div class="chain-cols-container space-y-2"></div>
          </div>
        `;

        const modeSelect = item.querySelector('.chain-table-mode');
        const rowsInput = item.querySelector('.chain-table-rows');
        const toggleBtn = item.querySelector('.btn-toggle-cols');
        const drawer = item.querySelector('.chain-col-drawer');
        const colsBox = item.querySelector('.chain-cols-container');

        modeSelect.addEventListener('change', () => {
          tableModes[node.name] = modeSelect.value;
          item.dataset.nodeMode = modeSelect.value;
          rowsInput.disabled = modeSelect.value === 'use_existing' || modeSelect.value === 'skip';
          triggerPreviewUpdate(300);
        });

        rowsInput.addEventListener('input', () => {
          tableCounts[node.name] = Math.max(1, parseInt(rowsInput.value, 10) || 10);
          triggerPreviewUpdate(400);
        });

        toggleBtn.addEventListener('click', () => {
          const isHidden = drawer.classList.toggle('hidden');
          toggleBtn.textContent = isHidden ? 'Cols ▼' : 'Hide ▲';
          if (!isHidden && colsBox.children.length === 0) {
            renderSingleTableColumns(node.name, node.columns, colsBox);
          }
        });

        chainPipelineContainer.appendChild(item);
      });

      triggerPreviewUpdate(100);
    } catch (err) {
      chainPipelineContainer.innerHTML = `<div class="alert alert-error text-xs font-semibold">${escapeHtml(err.message)}</div>`;
    }
  }

  // ---- Preview Generation ----
  async function generateDataPreview() {
    if (!previewTbody) return;
    if (mode === 'chain' && !chainConfigData) {
      await loadChainPipeline();
    }
    previewTbody.innerHTML = '<tr><td colspan="100" class="text-center py-12 text-base-content/40"><span class="loading loading-spinner loading-sm text-primary mb-2"></span><br><span class="font-bold text-xs">Generating data preview…</span></td></tr>';
    if (feedbackBox) feedbackBox.classList.add('hidden');
    if (chainTableTabs) chainTableTabs.classList.add('hidden');
    if (insertBtn) insertBtn.disabled = true;

    const plan = buildCurrentGenerationPlan();

    try {
      lastPreviewResult = await Api.post('/api/seed/preview', { plan });
      if (insertBtn) insertBtn.disabled = false;

      // Render Validation Report if present
      if (lastPreviewResult.validation) {
        renderValidationReport(lastPreviewResult.validation);
      }

      // Populate SQL Script
      if (previewSqlCode) {
        previewSqlCode.textContent = lastPreviewResult.sql || '-- No SQL statements generated.';
      }

      // Multi-table tabs setup
      const isSingleMode = mode === 'single';
      const tableKeys = isSingleMode ? [rootTableName] : (lastPreviewResult.executionOrder || Object.keys(lastPreviewResult.tableResults || {}));
      if (isSingleMode || !tableKeys.includes(activePreviewTable)) {
        activePreviewTable = rootTableName;
      }

      if (!isSingleMode && tableKeys.length > 1 && chainTableTabs) {
        chainTableTabs.classList.remove('hidden');
        chainTableTabs.innerHTML = '';
        tableKeys.forEach((tableName) => {
          const res = lastPreviewResult.tableResults[tableName];
          const btn = document.createElement('button');
          btn.dataset.table = tableName;
          btn.className = `tab tab-bordered h-8 text-xs font-mono whitespace-nowrap shrink-0 ${tableName === activePreviewTable ? 'tab-active text-primary font-bold border-b-2 border-b-primary' : 'text-base-content/60'}`;
          btn.innerHTML = `${escapeHtml(tableName)} <span class="badge badge-xs ml-1.5 ${tableName === activePreviewTable ? 'badge-primary' : 'badge-ghost'}">${res?.rows?.length || 0}</span>`;
          btn.onclick = (e) => {
            e.preventDefault();
            activePreviewTable = tableName;
            Array.from(chainTableTabs.children).forEach((b) => {
              b.classList.remove('tab-active', 'text-primary', 'border-b-2', 'border-b-primary', 'font-bold');
              b.classList.add('text-base-content/60');
              b.querySelector('.badge')?.classList.replace('badge-primary', 'badge-ghost');
            });
            btn.classList.add('tab-active', 'text-primary', 'border-b-2', 'border-b-primary', 'font-bold');
            btn.classList.remove('text-base-content/60');
            btn.querySelector('.badge')?.classList.replace('badge-ghost', 'badge-primary');
            const activeRes = lastPreviewResult.tableResults[activePreviewTable];
            renderPreviewGrid(activePreviewTable, activeRes?.previewRows || []);
          };
          chainTableTabs.appendChild(btn);
        });
      } else if (chainTableTabs) {
        chainTableTabs.classList.add('hidden');
      }

      const activeRes = lastPreviewResult.tableResults[activePreviewTable] || { previewRows: [] };
      renderPreviewGrid(activePreviewTable, activeRes?.previewRows || []);
      showFeedbackWarnings(lastPreviewResult.warnings || []);
    } catch (err) {
      if (previewTbody) {
        previewTbody.innerHTML = `<tr><td colspan="100" class="text-center py-10 text-error text-xs font-bold">${escapeHtml(err.message)}</td></tr>`;
      }
    }
  }

  function renderPreviewGrid(tableName, rows) {
    if (!previewThead || !previewTbody) return;
    previewThead.innerHTML = '';
    previewTbody.innerHTML = '';

    if (!rows || rows.length === 0) {
      previewTbody.innerHTML = '<tr><td colspan="100" class="text-center py-10 text-base-content/40 text-xs font-semibold">No rows generated for this table.</td></tr>';
      return;
    }

    const colKeySet = new Set();
    rows.forEach((r) => {
      if (r && typeof r === 'object') {
        Object.keys(r).forEach((k) => colKeySet.add(k));
      }
    });
    const colKeys = Array.from(colKeySet);
    if (colKeys.length === 0) {
      previewTbody.innerHTML = '<tr><td colspan="100" class="text-center py-10 text-base-content/40 text-xs font-semibold">No columns in generated rows.</td></tr>';
      return;
    }

    const trHead = document.createElement('tr');
    trHead.innerHTML = '<th class="w-10 text-center font-mono">#</th>' + colKeys.map((k) => `<th class="font-mono">${escapeHtml(k)}</th>`).join('');
    previewThead.appendChild(trHead);

    rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      let html = `<td class="text-center text-base-content/40 font-mono text-[10px]">${i + 1}</td>`;
      colKeys.forEach((k) => {
        const val = row[k];
        if (val === null || val === undefined) {
          html += `<td><span class="badge badge-xs badge-ghost opacity-60 font-mono font-bold text-[9px] text-base-content/50">NULL</span></td>`;
        } else if (val === '(default)' || val === '(auto)') {
          html += `<td><span class="badge badge-xs badge-outline opacity-60 font-mono text-[9px]">${escapeHtml(val)}</span></td>`;
        } else if (typeof val === 'boolean') {
          html += `<td><span class="badge badge-xs ${val ? 'badge-success' : 'badge-ghost'} font-mono font-bold text-[9px]">${val ? 'TRUE' : 'FALSE'}</span></td>`;
        } else {
          html += `<td class="truncate max-w-[200px] font-mono text-[11px] text-base-content/90" title="${escapeHtml(String(val))}">${escapeHtml(String(val))}</td>`;
        }
      });
      tr.innerHTML = html;
      previewTbody.appendChild(tr);
    });
  }

  function showFeedbackWarnings(warnings) {
    if (!feedbackBox) return;
    if (!warnings || warnings.length === 0) {
      feedbackBox.classList.add('hidden');
      return;
    }
    feedbackBox.innerHTML = `
      <div class="alert alert-warning text-xs font-semibold rounded-lg shadow-sm">
        <svg class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
        <div class="space-y-1">${warnings.map((w) => `<p>${escapeHtml(w)}</p>`).join('')}</div>
      </div>
    `;
    feedbackBox.classList.remove('hidden');
  }

  // ---- Seed Profiles Management (Client-Side LocalStorage) ----
  const LOCAL_STORAGE_PROFILES_KEY = 'admindb_seed_profiles';

  function getLocalProfiles() {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_PROFILES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveLocalProfile(name, plan, description) {
    const profiles = getLocalProfiles();
    const newProfile = {
      id: `profile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      description,
      createdAt: new Date().toISOString(),
      plan,
    };
    profiles.unshift(newProfile);
    try {
      localStorage.setItem(LOCAL_STORAGE_PROFILES_KEY, JSON.stringify(profiles));
    } catch {}
    return newProfile;
  }

  function deleteLocalProfile(id) {
    const profiles = getLocalProfiles().filter((p) => p.id !== id);
    try {
      localStorage.setItem(LOCAL_STORAGE_PROFILES_KEY, JSON.stringify(profiles));
    } catch {}
  }

  function loadProfilesList() {
    try {
      const profiles = getLocalProfiles();
      profilesListContainer.innerHTML = '';
      if (!profiles || profiles.length === 0) {
        profilesListContainer.innerHTML = '<div class="py-4 text-center text-xs text-base-content/40">No custom profiles saved yet.</div>';
        return;
      }

      profiles.forEach((p) => {
        const item = document.createElement('div');
        item.className = 'p-2.5 rounded-lg bg-base-200/50 border border-base-300 flex items-center justify-between gap-2 text-xs hover:border-primary/40 transition-colors';
        item.innerHTML = `
          <div class="min-w-0">
            <div class="font-bold text-base-content truncate">${escapeHtml(p.name)}</div>
            <div class="text-[10px] text-base-content/50">${escapeHtml(p.description || `Root: ${p.plan?.rootTable || 'N/A'}`)}</div>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" class="btn btn-xs btn-primary btn-load-profile font-bold" data-id="${escapeHtml(p.id)}">Apply</button>
            <button type="button" class="btn btn-xs btn-ghost text-error btn-del-profile" data-id="${escapeHtml(p.id)}">✕</button>
          </div>
        `;

        item.querySelector('.btn-load-profile').onclick = () => applyProfile(p);
        item.querySelector('.btn-del-profile').onclick = () => {
          deleteLocalProfile(p.id);
          loadProfilesList();
        };

        profilesListContainer.appendChild(item);
      });
    } catch {
      profilesListContainer.innerHTML = '<div class="py-4 text-center text-xs text-error font-semibold">Failed to load profiles.</div>';
    }
  }

  function applyProfile(p) {
    if (!p || !p.plan) return;
    const plan = p.plan;
    if (plan.options?.seed != null) {
      prngSeed = plan.options.seed;
      if (planSeedInput) planSeedInput.value = prngSeed;
    }
    if (plan.tables) {
      Object.entries(plan.tables).forEach(([tableName, spec]) => {
        tableModes[tableName] = spec.mode || 'generate';
        tableCounts[tableName] = spec.rows || 10;
        if (spec.columns) {
          stateByTable[tableName] = Object.assign({}, spec.columns);
        }
      });
      if (plan.tables[rootTableName] && singleCountInput) {
        singleCountInput.value = plan.tables[rootTableName].rows || 10;
      }
    }
    if (profilesDialog) profilesDialog.close();
    if (window.UI && UI.showToast) UI.showToast(`Applied profile "${p.name}".`, 'success');
    if (singleColumnsBox) renderSingleTableColumns(rootTableName, rootColumns, singleColumnsBox);
    triggerPreviewUpdate(100);
  }

  // ---- Execution ----
  async function executeSeedPlan() {
    if (mode === 'chain' && !chainConfigData) {
      await loadChainPipeline();
    }
    const plan = buildCurrentGenerationPlan();
    if (insertBtn) {
      insertBtn.disabled = true;
      insertBtn.classList.add('loading');
    }

    try {
      const res = await Api.post('/api/seed/execute', { plan, truncate: truncateCheckbox?.checked ?? false });
      if (window.UI && UI.showToast) {
        UI.showToast(res.message || `Seeded ${res.totalInserted} rows successfully.`, 'success');
      }
      showFeedbackWarnings(res.warnings || []);
    } catch (err) {
      if (window.UI && UI.showError) UI.showError(err.message);
    } finally {
      if (insertBtn) {
        insertBtn.disabled = false;
        insertBtn.classList.remove('loading');
      }
      if (truncateDialog) truncateDialog.close();
    }
  }

  // ---- Event Handlers ----
  if (btnSelectSingle) btnSelectSingle.addEventListener('click', () => selectMode('single'));
  if (btnSelectChain) btnSelectChain.addEventListener('click', () => selectMode('chain'));

  if (btnNext1) btnNext1.addEventListener('click', () => goToStep(2));
  if (btnPrev2) btnPrev2.addEventListener('click', () => goToStep(1));
  if (btnNext2) btnNext2.addEventListener('click', () => goToStep(3));
  if (btnPrev3) btnPrev3.addEventListener('click', () => goToStep(2));

  if (decBtn && incBtn && singleCountInput) {
    decBtn.addEventListener('click', () => {
      singleCountInput.value = Math.max(1, (parseInt(singleCountInput.value, 10) || 10) - 1);
      triggerPreviewUpdate(300);
    });
    incBtn.addEventListener('click', () => {
      singleCountInput.value = Math.min(5000, (parseInt(singleCountInput.value, 10) || 10) + 1);
      triggerPreviewUpdate(300);
    });
    singleCountInput.addEventListener('input', () => triggerPreviewUpdate(400));
  }

  document.querySelectorAll('.preset-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.preset-pill').forEach((p) => p.classList.remove('btn-primary'));
      pill.classList.add('btn-primary');
      if (singleCountInput && pill.dataset.count) {
        singleCountInput.value = pill.dataset.count;
        triggerPreviewUpdate(200);
      }
    });
  });

  if (planSeedInput) {
    planSeedInput.addEventListener('input', () => {
      prngSeed = planSeedInput.value === '' ? null : Number(planSeedInput.value);
      triggerPreviewUpdate(400);
    });
  }

  if (btnRandomSeed) {
    btnRandomSeed.addEventListener('click', () => {
      prngSeed = Math.floor(Math.random() * 1000000);
      planSeedInput.value = prngSeed;
      if (window.UI && UI.showToast) UI.showToast(`Set Random Seed: ${prngSeed}`, 'info');
      triggerPreviewUpdate(100);
    });
  }

  if (chainScopeSelect) {
    chainScopeSelect.addEventListener('change', () => loadChainPipeline());
  }

  document.querySelectorAll('.chain-scale-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chain-scale-btn').forEach((b) => b.classList.remove('btn-neutral'));
      btn.classList.add('btn-neutral');
      const scale = Number(btn.dataset.scale);
      if (chainConfigData && chainConfigData.tables) {
        chainConfigData.tables.forEach((node) => {
          tableCounts[node.name] = Math.max(1, Math.round((node.suggestedCount || 10) * scale));
          const inp = chainPipelineContainer?.querySelector(`.chain-table-rows[data-table="${CSS.escape(node.name)}"]`);
          if (inp) inp.value = tableCounts[node.name];
        });
      }
      triggerPreviewUpdate(200);
    });
  });

  if (previewTabGrid && previewTabSql) {
    previewTabGrid.addEventListener('click', () => {
      previewTabGrid.classList.add('btn-active');
      previewTabSql.classList.remove('btn-active');
      previewViewGrid.classList.remove('hidden');
      previewViewSql.classList.add('hidden');
    });
    previewTabSql.addEventListener('click', () => {
      previewTabSql.classList.add('btn-active');
      previewTabGrid.classList.remove('btn-active');
      previewViewSql.classList.remove('hidden');
      previewViewGrid.classList.add('hidden');
    });
  }

  if (btnCopySql) {
    btnCopySql.addEventListener('click', () => {
      if (previewSqlCode) {
        navigator.clipboard.writeText(previewSqlCode.textContent || '');
        if (window.UI && UI.showToast) UI.showToast('SQL script copied to clipboard.', 'success');
      }
    });
  }

  if (refreshPreviewBtn) {
    refreshPreviewBtn.addEventListener('click', () => generateDataPreview());
  }

  if (truncateCheckbox && truncateBanner) {
    truncateCheckbox.addEventListener('change', () => {
      truncateBanner.classList.toggle('hidden', !truncateCheckbox.checked);
    });
  }

  if (insertBtn) {
    insertBtn.addEventListener('click', () => {
      if (truncateCheckbox?.checked) truncateDialog.showModal();
      else executeSeedPlan();
    });
  }

  if (truncateConfirm) truncateConfirm.addEventListener('click', () => executeSeedPlan());
  if (truncateCancel) truncateCancel.addEventListener('click', () => truncateDialog.close());

  // Profiles Dialog & Presets
  if (btnProfilesModal && profilesDialog) {
    btnProfilesModal.addEventListener('click', () => {
      profilesDialog.showModal();
      loadProfilesList();
    });
    if (btnCloseProfiles) btnCloseProfiles.addEventListener('click', () => profilesDialog.close());
  }

  document.querySelectorAll('.btn-preset-profile').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      const count = preset === 'smoke' ? 10 : (preset === 'realistic' ? 100 : 1000);
      if (singleCountInput) singleCountInput.value = count;
      Object.keys(tableCounts).forEach((k) => (tableCounts[k] = count));
      if (profilesDialog) profilesDialog.close();
      if (window.UI && UI.showToast) UI.showToast(`Applied ${count} rows preset blueprint.`, 'info');
      triggerPreviewUpdate(100);
    });
  });

  if (btnSaveProfile) {
    btnSaveProfile.addEventListener('click', () => {
      const name = profileNameInput.value.trim();
      if (!name) return;
      const plan = buildCurrentGenerationPlan();
      saveLocalProfile(name, plan);
      profileNameInput.value = '';
      if (window.UI && UI.showToast) UI.showToast(`Saved profile "${name}".`, 'success');
      loadProfilesList();
    });
  }

  // Export Plan JSON
  if (btnExportPlanJson) {
    btnExportPlanJson.addEventListener('click', () => {
      const plan = buildCurrentGenerationPlan();
      const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `seed-plan-${rootTableName}-${Date.now()}.json`;
      a.click();
    });
  }

  // Import Plan JSON
  if (inputImportPlanJson) {
    inputImportPlanJson.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const plan = JSON.parse(evt.target?.result);
          applyProfile({ name: file.name, plan });
        } catch {
          if (window.UI && UI.showError) UI.showError('Invalid JSON seed plan file.');
        }
      };
      reader.readAsText(file);
    });
  }

  if (colSearchInput) {
    colSearchInput.addEventListener('input', () => {
      const q = colSearchInput.value.trim().toLowerCase();
      const rows = singleColumnsBox?.querySelectorAll('.seed-col-row') || [];
      let visible = 0;
      rows.forEach((r) => {
        const match = !q || (r.dataset.colName || '').includes(q);
        r.classList.toggle('hidden', !match);
        if (match) visible++;
      });
      if (colCountBadge) colCountBadge.textContent = `${visible} cols`;
    });
  }

  // Pre-render root table columns specification box
  if (singleColumnsBox && singleColumnsBox.children.length === 0) {
    renderSingleTableColumns(rootTableName, rootColumns, singleColumnsBox);
  }

  if (btnSelectSingle) {
    btnSelectSingle.addEventListener('click', () => selectMode('single', true));
  }
  if (btnSelectChain) {
    btnSelectChain.addEventListener('click', () => selectMode('chain', true));
  }

  // Initialize mode based on configuration / URL query param (?mode=chain)
  selectMode(initialMode, false);
})();
