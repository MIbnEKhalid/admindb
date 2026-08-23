/* "Seed data" page — enhanced interactive data generator (Wizard Flow).
 *
 * Implements a step-by-step wizard for Single Table and ER Relational Chain generation.
 */
(function () {
  'use strict';

  const cfgEl = document.getElementById('seed-config');
  if (!cfgEl) return;

  const cfg = JSON.parse(cfgEl.textContent);
  const t = encodeURIComponent(cfg.table);
  const columns = cfg.columns || [];

  // ---- State ----
  let currentStep = 1;
  let mode = null; // 'single' | 'chain'
  const stateByTable = {}; // tableName -> { colName -> plan }
  const chainCounts = {}; // tableName -> count
  let chainData = null; // topological ER chain data
  let lastPreviewResult = null;
  let activePreviewChainTable = null;

  // Initialize active table state
  stateByTable[cfg.table] = {};
  columns.forEach(col => {
    stateByTable[cfg.table][col.name] = Object.assign({}, col.defaultPlan || { strategy: 'skip' });
  });

  // ---- DOM Elements - Wizard Navigation ----
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

  // DOM Elements - Configuration
  const configSingle = document.getElementById('config-single');
  const configChain = document.getElementById('config-chain');
  const columnsBox = document.getElementById('seed-columns');
  const singleCountInput = document.getElementById('seed-count');
  
  const chainScopeSelect = document.getElementById('chain-scope');
  const chainPipelineContainer = document.getElementById('chain-pipeline-container');
  const chainSummaryBadge = document.getElementById('chain-summary-badge');

  // DOM Elements - Preview & Execution
  const previewThead = document.getElementById('seed-preview-thead');
  const previewTbody = document.getElementById('seed-preview-tbody');
  const chainTableTabs = document.getElementById('seed-chain-table-tabs');
  const refreshPreviewBtn = document.getElementById('seed-refresh-preview');
  const insertBtn = document.getElementById('seed-insert');
  const truncateCheckbox = document.getElementById('seed-truncate');
  const truncateDialog = document.getElementById('seed-truncate-dialog');
  const truncateConfirm = document.getElementById('seed-truncate-confirm');
  const truncateCancel = document.getElementById('seed-truncate-cancel');
  const feedbackBox = document.getElementById('seed-feedback');

  // ---- Utils ----
  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
  }

  function showFeedback(warnings) {
    if (!feedbackBox) return;
    if (!warnings || warnings.length === 0) {
      feedbackBox.classList.add('hidden');
      return;
    }
    feedbackBox.innerHTML = `
      <div class="alert alert-warning text-xs">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
        <div class="space-y-1">${warnings.map(w => `<p>${escapeHtml(w)}</p>`).join('')}</div>
      </div>
    `;
    feedbackBox.classList.remove('hidden');
  }

  // ---- Mock Generators ----
  const SAMPLE_FIRST = ["Sombat", "Minh", "Hiroshi", "William", "Ravi", "Zara", "Elena", "Liam", "Mei", "Noah"];
  const SAMPLE_LAST = ["Chen", "Smith", "Thompson", "Shah", "Yamamoto", "Patel", "Garcia", "Kim", "Nguyen", "Davis"];
  const SAMPLE_DOMAINS = ["example.com", "acme.io", "tech.asia", "gmail.com", "startup.io"];
  const SAMPLE_WORDS = ["alpha", "beta", "stream", "cloud", "service", "cluster", "record", "node", "signal"];
  const SAMPLE_STATUSES = ["active", "pending", "completed", "archived", "draft"];

  function samplePick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function sampleInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  function computeSampleValue(col, plan) {
    const st = plan.strategy;
    if (st === 'skip') return '(auto/default)';
    if (st === 'null') return 'NULL';
    if (plan.nullPct && sampleInt(1, 100) <= plan.nullPct && !col.pk && !col.notnull) {
      return 'NULL (simulated)';
    }

    let val = '';
    switch (st) {
      case 'fixed': val = plan.value || ''; break;
      case 'list': val = plan.values && plan.values.length ? samplePick(plan.values) : '(empty)'; break;
      case 'pattern': val = 'PAT-' + sampleInt(1000, 9999); break;
      case 'first': val = samplePick(SAMPLE_FIRST); break;
      case 'last': val = samplePick(SAMPLE_LAST); break;
      case 'fullname': val = samplePick(SAMPLE_FIRST) + ' ' + samplePick(SAMPLE_LAST); break;
      case 'email': val = samplePick(SAMPLE_FIRST).toLowerCase() + '@' + samplePick(SAMPLE_DOMAINS); break;
      case 'status': val = samplePick(SAMPLE_STATUSES); break;
      case 'int': val = String(sampleInt(plan.min ?? 1, plan.max ?? 1000)); break;
      case 'decimal': val = (Math.random() * ((plan.max ?? 1000) - (plan.min ?? 1)) + (plan.min ?? 1)).toFixed(plan.precision ?? 2); break;
      case 'bool': val = samplePick(['1', '0']); break;
      case 'sequence': val = String(plan.start || 1); break;
      case 'uuid': val = '550e8400-e29b-41d4-a716-' + sampleInt(100000000000, 999999999999); break;
      case 'fk': val = '[FK -> ' + (col.fk ? col.fk.table : '?') + ']'; break;
      default: val = '(sample)';
    }
    return val;
  }

  // ---- Wizard Logic ----
  function goToStep(step) {
    currentStep = step;
    
    // Update nav indicators
    stepNav1.classList.toggle('step-primary', step >= 1);
    stepNav2.classList.toggle('step-primary', step >= 2);
    stepNav3.classList.toggle('step-primary', step >= 3);

    // Update content visibility
    content1.classList.toggle('hidden', step !== 1);
    content2.classList.toggle('hidden', step !== 2);
    content3.classList.toggle('hidden', step !== 3);

    if (step === 2) {
      configSingle.classList.toggle('hidden', mode !== 'single');
      configChain.classList.toggle('hidden', mode !== 'chain');
      if (mode === 'single' && columnsBox.children.length === 0) {
        renderSingleColumns();
      } else if (mode === 'chain' && !chainData) {
        loadChainData();
      }
    }

    if (step === 3) {
      generatePreview();
    }
  }

  function selectMode(selectedMode) {
    mode = selectedMode;
    btnSelectSingle.classList.toggle('border-primary', mode === 'single');
    btnSelectSingle.classList.toggle('bg-primary/5', mode === 'single');
    btnSelectChain.classList.toggle('border-secondary', mode === 'chain');
    btnSelectChain.classList.toggle('bg-secondary/5', mode === 'chain');
    btnNext1.disabled = false;
  }

  // ---- Single Table Configuration ----
  function renderSingleColumns() {
    columnsBox.innerHTML = '';
    columns.forEach(col => {
      const plan = stateByTable[cfg.table][col.name];

      const card = document.createElement('div');
      card.className = 'seed-col-card';
      card.dataset.strategyType = plan.strategy === 'skip' ? 'skip' : plan.strategy === 'null' ? 'null' : plan.strategy === 'fixed' || plan.strategy === 'list' || plan.strategy === 'pattern' ? 'fixed' : 'generate';

      // Header
      let badges = '';
      if (col.pk) badges += '<span class="badge badge-xs badge-warning">PK</span>';
      if (col.notnull) badges += '<span class="badge badge-xs badge-info">REQ</span>';
      
      card.innerHTML = `
        <div class="flex items-start justify-between">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-bold font-mono text-sm truncate">${escapeHtml(col.name)}</span>
              ${badges}
            </div>
            <div class="text-[10px] text-base-content/50 uppercase font-mono mt-0.5">${escapeHtml(col.type)}</div>
          </div>
        </div>
        <div>
          <select class="seed-strategy field-select !py-1 text-xs w-full">
            ${(col.strategies || []).map(s => `<option value="${s.id}" ${s.id === plan.strategy ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
          </select>
        </div>
        <div class="seed-options space-y-2"></div>
        <div class="pt-2 border-t border-base-200 flex justify-between items-center text-[11px]">
          <span class="text-base-content/50 uppercase font-bold tracking-wider">Sample</span>
          <code class="seed-sample-value font-mono text-xs text-primary bg-primary/8 rounded px-1.5 py-0.5 truncate max-w-[150px] inline-block"></code>
        </div>
      `;

      const select = card.querySelector('.seed-strategy');
      const optionsBox = card.querySelector('.seed-options');
      const sampleEl = card.querySelector('.seed-sample-value');

      const updateSample = () => {
        sampleEl.textContent = computeSampleValue(col, stateByTable[cfg.table][col.name]);
      };

      select.addEventListener('change', () => {
        const st = select.value;
        stateByTable[cfg.table][col.name].strategy = st;
        // Update accent bar color
        card.dataset.strategyType = st === 'skip' ? 'skip' : st === 'null' ? 'null' : st === 'fixed' || st === 'list' || st === 'pattern' ? 'fixed' : 'generate';
        buildOptions(optionsBox, col, stateByTable[cfg.table][col.name], updateSample);
        updateSample();
      });

      buildOptions(optionsBox, col, plan, updateSample);
      updateSample();
      columnsBox.appendChild(card);
    });
  }

  function buildOptions(container, col, plan, updateSampleCb) {
    container.innerHTML = '';
    const st = plan.strategy;

    const addInput = (label, key, type = 'text', attrs = {}) => {
      const wrap = document.createElement('label');
      wrap.className = 'block';
      wrap.innerHTML = `<span class="block text-[10px] uppercase font-bold text-base-content/50 mb-1">${escapeHtml(label)}</span>`;
      const inp = document.createElement(type === 'textarea' ? 'textarea' : 'input');
      if (type !== 'textarea') inp.type = type;
      inp.className = type === 'textarea' ? 'field-input w-full text-xs font-mono !py-1 h-16' : 'field-input w-full text-xs font-mono !py-1';
      if (attrs.min) inp.min = attrs.min;
      if (attrs.max) inp.max = attrs.max;
      
      const val = plan[key];
      if (type === 'textarea' && Array.isArray(val)) inp.value = val.join('\\n');
      else if (val !== undefined) inp.value = val;

      inp.addEventListener('input', () => {
        if (type === 'textarea') plan[key] = inp.value.split('\\n').map(s => s.trim()).filter(Boolean);
        else if (type === 'number') plan[key] = Number(inp.value);
        else plan[key] = inp.value;
        updateSampleCb();
      });
      wrap.appendChild(inp);
      container.appendChild(wrap);
    };

    if (st === 'fixed') addInput('Value', 'value');
    if (st === 'list') addInput('Choices (one per line)', 'values', 'textarea');
    if (st === 'int' || st === 'decimal') {
      const grid = document.createElement('div'); grid.className = 'grid grid-cols-2 gap-2';
      container.appendChild(grid);
      const wrapGrid = (el) => { grid.appendChild(el); return el; };
      const tmp = container; container = grid;
      addInput('Min', 'min', 'number');
      addInput('Max', 'max', 'number');
      container = tmp;
    }
  }

  // ---- ER Chain Configuration ----
  async function loadChainData() {
    const scope = chainScopeSelect.value;
    chainPipelineContainer.innerHTML = '<div class="py-8 text-center text-sm text-base-content/50">Analyzing foreign keys...</div>';
    try {
      chainData = await Api.get(`/api/tables/${t}/seed/chain?scope=${scope}`);
      chainSummaryBadge.textContent = `${chainData.tables.length} Tables`;
      
      // Initialize counts & states
      chainPipelineContainer.innerHTML = '<div class="relative pl-6 ml-2 space-y-6 border-l-2 border-base-200/50"></div>';
      const listContainer = chainPipelineContainer.firstChild;

      chainData.tables.forEach((node, idx) => {
        if (!chainCounts[node.name]) chainCounts[node.name] = node.suggestedCount || 10;
        if (!stateByTable[node.name]) {
          stateByTable[node.name] = {};
          (node.columns || []).forEach(col => {
            stateByTable[node.name][col.name] = Object.assign({}, col.defaultPlan || { strategy: 'skip' });
          });
        }

        const card = document.createElement('div');
        const isActive = node.name === cfg.table;
        card.className = 'relative group';
        card.innerHTML = `
          <!-- Timeline Node Dot -->
          <div class="absolute -left-[35px] top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-4 border-base-100 ${isActive ? 'bg-secondary ring-2 ring-secondary/30 shadow-[0_0_8px_rgba(var(--secondary),0.5)]' : 'bg-primary ring-2 ring-base-200'} z-10 transition-all duration-300 group-hover:scale-125"></div>
          
          <div class="app-card p-4 flex items-center justify-between shadow-sm hover:shadow-md transition-shadow ${isActive ? 'bg-secondary/5 border-secondary/20' : 'bg-base-100 hover:bg-base-200/30'} border">
            <div class="flex items-center gap-3">
              <span class="w-7 h-7 rounded-lg ${isActive ? 'bg-secondary/20 text-secondary' : 'bg-base-200 text-base-content/60'} text-xs flex items-center justify-center font-bold font-mono">${idx + 1}</span>
              <div>
                <div class="font-bold text-[15px] font-mono flex items-center gap-2">
                  ${escapeHtml(node.name)}
                  ${isActive ? '<span class="badge badge-xs badge-secondary font-bold uppercase tracking-wider text-[9px] px-1.5 h-4">Target</span>' : ''}
                </div>
                <div class="text-[10px] text-base-content/50 uppercase mt-1 flex gap-3 font-semibold tracking-wide">
                  <span title="Tables this table depends on"><span class="text-base-content/30 mr-0.5">←</span> ${node.parents.length} Parents</span>
                  <span title="Tables that depend on this table"><span class="text-base-content/30 mr-0.5">→</span> ${node.children.length} Children</span>
                </div>
              </div>
            </div>
            <div>
              <label class="text-[9px] uppercase tracking-widest font-bold text-base-content/40 block mb-1">Rows to generate</label>
              <input type="number" min="1" max="5000" value="${chainCounts[node.name]}" class="chain-row-input field-input !py-1 w-24 text-right font-mono font-bold text-sm bg-base-100/80 shadow-inner" data-table="${escapeHtml(node.name)}" />
            </div>
          </div>
        `;

        card.querySelector('.chain-row-input').addEventListener('input', (e) => {
          chainCounts[node.name] = Number(e.target.value) || 10;
        });

        listContainer.appendChild(card);
      });
    } catch (err) {
      chainPipelineContainer.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  // ---- Preview Generation ----
  async function generatePreview() {
    previewTbody.innerHTML = '<tr><td colspan="100" class="text-center py-10 opacity-50">Generating preview...</td></tr>';
    feedbackBox.classList.add('hidden');
    chainTableTabs.classList.add('hidden');
    insertBtn.disabled = true;
    
    try {
      if (mode === 'single') {
        const count = Number(singleCountInput.value) || 10;
        const plan = stateByTable[cfg.table] || {};
        lastPreviewResult = await Api.post(`/api/tables/${t}/seed/generate`, { count, plan });
        renderPreviewTable(cfg.table, lastPreviewResult.previewRows || []);
      } else {
        const scope = chainScopeSelect.value;
        lastPreviewResult = await Api.post(`/api/tables/${t}/seed/chain/generate`, {
          scope,
          counts: chainCounts,
          plans: stateByTable
        });
        
        // Setup ER Chain tabs
        const tables = lastPreviewResult.executionOrder || Object.keys(lastPreviewResult.tableResults || {});
        if (!activePreviewChainTable || !tables.includes(activePreviewChainTable)) {
          activePreviewChainTable = tables[0];
        }

        chainTableTabs.classList.remove('hidden');
        chainTableTabs.innerHTML = '';
        tables.forEach(tableName => {
          const res = lastPreviewResult.tableResults[tableName];
          const btn = document.createElement('button');
          btn.dataset.table = tableName;
          btn.className = `tab tab-bordered h-10 text-xs font-bold font-mono whitespace-nowrap shrink-0 ${tableName === activePreviewChainTable ? 'tab-active text-primary' : ''}`;
          btn.innerHTML = `${escapeHtml(tableName)} <span class="badge badge-xs ml-2 ${tableName === activePreviewChainTable ? 'badge-primary' : 'badge-ghost'}">${res?.rows?.length || 0}</span>`;
          chainTableTabs.appendChild(btn);
        });

        // Override click logic for tabs
        Array.from(chainTableTabs.children).forEach(btn => {
          btn.onclick = (e) => {
            e.preventDefault();
            activePreviewChainTable = btn.dataset.table;
            
            Array.from(chainTableTabs.children).forEach(b => {
              b.classList.remove('tab-active', 'text-primary');
              b.querySelector('.badge').classList.replace('badge-primary', 'badge-ghost');
            });
            btn.classList.add('tab-active', 'text-primary');
            btn.querySelector('.badge').classList.replace('badge-ghost', 'badge-primary');
            
            const activeRes = lastPreviewResult.tableResults[activePreviewChainTable];
            renderPreviewTable(activePreviewChainTable, activeRes?.previewRows || []);
          };
        });

        const activeRes = lastPreviewResult.tableResults[activePreviewChainTable];
        renderPreviewTable(activePreviewChainTable, activeRes?.previewRows || []);
      }
      insertBtn.disabled = false;
      showFeedback(lastPreviewResult.warnings || []);
    } catch (err) {
      previewTbody.innerHTML = `<tr><td colspan="100" class="text-center py-10 text-error font-bold">${escapeHtml(err.message)}</td></tr>`;
      if (window.UI && UI.showError) UI.showError(err.message);
    }
  }

  function renderPreviewTable(tableName, rows) {
    previewThead.innerHTML = '';
    previewTbody.innerHTML = '';

    if (!rows || rows.length === 0) {
      previewTbody.innerHTML = '<tr><td colspan="100" class="text-center py-10 text-base-content/40">No rows generated.</td></tr>';
      return;
    }

    const colKeys = Object.keys(rows[0]);
    const trHead = document.createElement('tr');
    trHead.innerHTML = '<th class="w-10 text-center">#</th>' + colKeys.map(k => `<th>${escapeHtml(k)}</th>`).join('');
    previewThead.appendChild(trHead);

    rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      let html = `<td class="text-center text-base-content/40">${i + 1}</td>`;
      colKeys.forEach(k => {
        const val = row[k];
        if (val === null) html += `<td><span class="badge badge-xs badge-ghost opacity-50">NULL</span></td>`;
        else if (val === '(default)' || val === '(auto)') html += `<td><span class="badge badge-xs badge-outline opacity-50">${escapeHtml(val)}</span></td>`;
        else if (typeof val === 'boolean') html += `<td><span class="badge badge-xs ${val ? 'badge-success' : 'badge-ghost'}">${val ? 'TRUE' : 'FALSE'}</span></td>`;
        else html += `<td class="truncate max-w-[200px]">${escapeHtml(String(val))}</td>`;
      });
      tr.innerHTML = html;
      previewTbody.appendChild(tr);
    });
  }

  // ---- Execution ----
  async function executeSeed() {
    const isTruncate = truncateCheckbox.checked;
    insertBtn.disabled = true;
    insertBtn.classList.add('loading');
    
    try {
      if (mode === 'single') {
        const count = Number(singleCountInput.value) || 10;
        const plan = stateByTable[cfg.table] || {};
        const res = await Api.post(`/api/tables/${t}/seed`, { count, plan, truncate: isTruncate });
        if (window.UI && UI.showToast) UI.showToast(res.message || `Inserted ${res.inserted} rows.`, 'success');
        showFeedback(res.warnings || []);
      } else {
        const scope = chainScopeSelect.value;
        const res = await Api.post(`/api/tables/${t}/seed/chain`, { scope, counts: chainCounts, plans: stateByTable, truncate: isTruncate });
        if (window.UI && UI.showToast) UI.showToast(res.message || `Seeded ${res.totalInserted} rows across tables.`, 'success');
        showFeedback(res.warnings || []);
      }
    } catch (err) {
      if (window.UI && UI.showError) UI.showError(err.message);
    } finally {
      insertBtn.disabled = false;
      insertBtn.classList.remove('loading');
      if (truncateDialog) truncateDialog.close();
    }
  }

  // ---- Event Listeners ----
  btnSelectSingle.addEventListener('click', () => selectMode('single'));
  btnSelectChain.addEventListener('click', () => selectMode('chain'));
  
  btnNext1.addEventListener('click', () => goToStep(2));
  btnPrev2.addEventListener('click', () => goToStep(1));
  btnNext2.addEventListener('click', () => goToStep(3));
  btnPrev3.addEventListener('click', () => goToStep(2));

  refreshPreviewBtn.addEventListener('click', () => generatePreview());

  insertBtn.addEventListener('click', () => {
    if (truncateCheckbox.checked) {
      truncateDialog.showModal();
    } else {
      executeSeed();
    }
  });

  truncateConfirm.addEventListener('click', () => executeSeed());
  truncateCancel.addEventListener('click', () => truncateDialog.close());

  if (chainScopeSelect) {
    chainScopeSelect.addEventListener('change', () => loadChainData());
  }

  document.querySelectorAll('.chain-scale-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chain-scale-btn').forEach(b => b.classList.remove('btn-neutral'));
      btn.classList.add('btn-neutral');
      const scale = Number(btn.dataset.scale);
      if (chainData) {
        chainData.tables.forEach(node => {
          chainCounts[node.name] = Math.max(1, Math.round((node.suggestedCount || 10) * scale));
          const inp = chainPipelineContainer.querySelector(`.chain-row-input[data-table="${CSS.escape(node.name)}"]`);
          if (inp) inp.value = chainCounts[node.name];
        });
      }
    });
  });

  // Init Wizard State
  goToStep(1);

})();
