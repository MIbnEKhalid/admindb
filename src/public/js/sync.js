/* Diff & Replication Studio Client Controller */
(function () {
  'use strict';

  // Selectors & Controls
  const selectSource = document.getElementById('select-source-db');
  const selectTarget = document.getElementById('select-target-db');
  const btnSwap = document.getElementById('btn-swap-dbs');
  const btnCompare = document.getElementById('btn-compare-now');
  const btnGenerateSql = document.getElementById('btn-generate-sql');
  const btnDryRun = document.getElementById('btn-dry-run');
  const btnExecute = document.getElementById('btn-execute-sync');

  // Badges & Labels
  const srcBadgeEngine = document.getElementById('src-badge-engine');
  const tgtBadgeEngine = document.getElementById('tgt-badge-engine');
  const srcPathLabel = document.getElementById('src-path-label');
  const tgtPathLabel = document.getElementById('tgt-path-label');

  // Options Panel
  const optionsHeader = document.getElementById('toggle-options-header');
  const optionsPanel = document.getElementById('options-panel');
  const optionsChevron = document.getElementById('options-chevron');
  const badgeActiveMode = document.getElementById('badge-active-mode');
  const tableCheckboxesContainer = document.getElementById('table-checkboxes-container');
  const btnSelectAllTables = document.getElementById('btn-select-all-tables');
  const btnDeselectAllTables = document.getElementById('btn-deselect-all-tables');

  // Diff Workspace & Tabs
  const diffTabs = document.getElementById('diff-tabs');
  const tabContentUnified = document.getElementById('tab-content-unified');
  const tabContentVisual = document.getElementById('tab-content-visual');
  const tabContentData = document.getElementById('tab-content-data');
  const unifiedDiffView = document.getElementById('unified-diff-view');
  const visualDiffCards = document.getElementById('visual-diff-cards');
  const diffStatsChips = document.getElementById('diff-stats-chips');
  const btnCopyUnifiedDiff = document.getElementById('btn-copy-unified-diff');

  // Table Filters in Visual Tab
  const inputFilterVisualTables = document.getElementById('input-filter-visual-tables');
  const filterStatusButtons = document.querySelectorAll('.js-filter-status');

  // Data Diff Controls
  const selectDataDiffTable = document.getElementById('select-data-diff-table');
  const selectDataDiffLimit = document.getElementById('select-data-diff-limit');
  const btnFetchDataDiff = document.getElementById('btn-fetch-data-diff');
  const dataDiffStats = document.getElementById('data-diff-stats');
  const dataDiffResults = document.getElementById('data-diff-results');

  // SQL Patch Modal
  const modalSqlPatch = document.getElementById('modal-sql-patch');
  const patchSqlCode = document.getElementById('patch-sql-code');
  const tabUpSql = document.getElementById('tab-up-sql');
  const tabDownSql = document.getElementById('tab-down-sql');
  const btnCopyPatchSql = document.getElementById('btn-copy-patch-sql');

  // Destructive Confirmation Modal
  const modalSyncExecute = document.getElementById('modal-sync-execute');
  const execPromptContent = document.getElementById('exec-prompt-content');
  const execDestructiveBanner = document.getElementById('exec-destructive-banner');
  const lblDestructiveActionDesc = document.getElementById('lbl-destructive-action-desc');
  const lblConfirmTgtHighlight = document.getElementById('lbl-confirm-tgt-highlight');
  const lblAffectedTablesList = document.getElementById('lbl-affected-tables-list');
  const lblConfirmSrc = document.getElementById('lbl-confirm-src');
  const lblConfirmTgt = document.getElementById('lbl-confirm-tgt');
  const lblConfirmMode = document.getElementById('lbl-confirm-mode');
  const lblConfirmMask = document.getElementById('lbl-confirm-mask');
  const lblConfirmTables = document.getElementById('lbl-confirm-tables');
  const execSafetyLocks = document.getElementById('exec-safety-locks');
  const chkConfirmDestruction = document.getElementById('chk-confirm-destruction');
  const boxConfirmPhrase = document.getElementById('box-confirm-phrase');
  const lblRequiredConfirmWord = document.getElementById('lbl-required-confirm-word');
  const inputConfirmPhrase = document.getElementById('input-confirm-phrase');
  const execProgressContainer = document.getElementById('exec-progress-container');
  const execProgressBar = document.getElementById('exec-progress-bar');
  const execProgressPercent = document.getElementById('exec-progress-percent');
  const execCurrentTable = document.getElementById('exec-current-table');
  const execLogContainer = document.getElementById('exec-log-container');
  const btnExecStart = document.getElementById('btn-exec-start');
  const btnExecCancel = document.getElementById('btn-exec-cancel');
  const btnExecCloseX = document.getElementById('btn-exec-close-x');

  const escapeHtml = window.Utils ? window.Utils.escapeHtml : (s) => String(s == null ? '' : s);

  let currentDiffData = null;
  let currentPatchSql = null;
  let activePatchTab = 'up';
  let activeStatusFilter = 'all';

  // ---- Engine Badges & Path Updates ----------------------------------------

  function updateDbBadges() {
    const srcOpt = selectSource.selectedOptions[0];
    const tgtOpt = selectTarget.selectedOptions[0];

    if (srcOpt && srcOpt.value) {
      const dialect = srcOpt.getAttribute('data-dialect') || 'sqlite';
      const isRo = srcOpt.getAttribute('data-readonly') === 'true';
      srcBadgeEngine.textContent = (dialect === 'postgres' ? 'PostgreSQL' : 'SQLite') + (isRo ? ' (RO)' : '');
      srcBadgeEngine.className = `badge badge-sm font-mono ${dialect === 'postgres' ? 'badge-info' : 'badge-success'}`;
      srcPathLabel.innerHTML = `<span>ID: <code class="font-bold text-base-content/70">${escapeHtml(srcOpt.value)}</code></span>`;
    }

    if (tgtOpt && tgtOpt.value) {
      const dialect = tgtOpt.getAttribute('data-dialect') || 'postgres';
      const isRo = tgtOpt.getAttribute('data-readonly') === 'true';
      tgtBadgeEngine.textContent = (dialect === 'postgres' ? 'PostgreSQL' : 'SQLite') + (isRo ? ' (RO)' : '');
      tgtBadgeEngine.className = `badge badge-sm font-mono ${dialect === 'postgres' ? 'badge-info' : 'badge-info'}`;
      tgtPathLabel.innerHTML = `<span>ID: <code class="font-bold text-base-content/70">${escapeHtml(tgtOpt.value)}</code></span>`;
    }

    loadSourceTables();
  }

  selectSource.addEventListener('change', updateDbBadges);
  selectTarget.addEventListener('change', updateDbBadges);

  // ---- Swap Button (⇄) -----------------------------------------------------

  btnSwap.addEventListener('click', () => {
    const srcVal = selectSource.value;
    const tgtVal = selectTarget.value;
    selectSource.value = tgtVal;
    selectTarget.value = srcVal;
    updateDbBadges();
    if (selectSource.value && selectTarget.value) {
      compareDiff();
    }
  });

  // ---- Collapsible Options Panel -------------------------------------------

  optionsHeader.addEventListener('click', () => {
    const isHidden = optionsPanel.classList.toggle('hidden');
    if (optionsChevron) {
      optionsChevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(180deg)';
    }
  });

  document.querySelectorAll('input[name="sync-mode"]').forEach((r) => {
    r.addEventListener('change', (e) => {
      const val = e.target.value;
      if (badgeActiveMode) {
        if (val === 'full') badgeActiveMode.textContent = 'Full Clone';
        else if (val === 'schema_only') badgeActiveMode.textContent = 'Schema Only';
        else if (val === 'data_only_replace') badgeActiveMode.textContent = 'Data Only';
      }
    });
  });

  // ---- Load Tables Checklist from Source -----------------------------------

  async function loadSourceTables() {
    const srcId = selectSource.value;
    if (!srcId) return;

    try {
      const res = await Api.get('/api/tables/' + encodeURIComponent(srcId));
      const tables = res || [];

      selectDataDiffTable.innerHTML = '<option value="" disabled selected>Select table…</option>';
      tableCheckboxesContainer.innerHTML = '';

      if (tables.length === 0) {
        tableCheckboxesContainer.innerHTML = '<span class="text-base-content/40 italic p-1 block">No tables found in this database.</span>';
        return;
      }

      tables.forEach((t) => {
        const name = typeof t === 'object' && t !== null && 'name' in t ? t.name : String(t);
        const label = document.createElement('label');
        label.className = 'flex items-center gap-2 p-1.5 hover:bg-base-200/60 rounded-lg cursor-pointer transition';
        label.innerHTML = `
          <input type="checkbox" class="checkbox checkbox-xs checkbox-primary js-table-check" value="${escapeHtml(name)}" checked />
          <span class="truncate font-mono">${escapeHtml(name)}</span>
        `;
        tableCheckboxesContainer.appendChild(label);

        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        selectDataDiffTable.appendChild(opt);
      });
    } catch {
      // Fallback
    }
  }

  btnSelectAllTables.addEventListener('click', () => {
    tableCheckboxesContainer.querySelectorAll('.js-table-check').forEach((cb) => (cb.checked = true));
  });

  btnDeselectAllTables.addEventListener('click', () => {
    tableCheckboxesContainer.querySelectorAll('.js-table-check').forEach((cb) => (cb.checked = false));
  });

  function getSelectedTables() {
    return Array.from(tableCheckboxesContainer.querySelectorAll('.js-table-check:checked')).map((c) => c.value);
  }

  // ---- Compare Schema Diff -------------------------------------------------

  async function compareDiff() {
    const src = selectSource.value;
    const tgt = selectTarget.value;

    if (!src || !tgt) {
      return UI.showError('Please select both a Source and a Target database.');
    }
    if (src === tgt) {
      return UI.showError('Source and Target database must be different.');
    }

    btnCompare.disabled = true;
    btnCompare.innerHTML = '<span class="loading loading-spinner loading-xs"></span> Computing Diff…';

    try {
      const diff = await Api.post('/api/sync/diff/schema', { sourceDbId: src, targetDbId: tgt });
      currentDiffData = diff;
      renderDiffView(diff);

      // Populate Data Diff table selector with tables from diff
      if (diff.tables && diff.tables.length > 0) {
        selectDataDiffTable.innerHTML = '';
        diff.tables.forEach((t) => {
          const opt = document.createElement('option');
          opt.value = t.name;
          opt.textContent = `${t.name} (${t.action})`;
          selectDataDiffTable.appendChild(opt);
        });
        if (selectDataDiffTable.options.length > 0) {
          selectDataDiffTable.selectedIndex = 0;
        }
      }

      btnGenerateSql.disabled = false;
      btnDryRun.disabled = false;
      btnExecute.disabled = false;
      UI.showToast('Schema diff computed successfully.', 'success');
    } catch (e) {
      UI.showError(e.message);
    } finally {
      btnCompare.disabled = false;
      btnCompare.innerHTML = 'Compare Diff Now';
    }
  }

  btnCompare.addEventListener('click', compareDiff);

  // ---- Render Diff View (Unified & Visual) ---------------------------------

  function renderDiffView(diff) {
    // 1. Stats Chips
    diffStatsChips.innerHTML = `
      <span class="badge badge-sm badge-success gap-1 font-mono font-bold shadow-sm">+${diff.stats.addedTables} Added</span>
      <span class="badge badge-sm badge-error gap-1 font-mono font-bold shadow-sm">-${diff.stats.removedTables} Removed</span>
      <span class="badge badge-sm badge-warning gap-1 font-mono font-bold shadow-sm">~${diff.stats.modifiedTables} Modified</span>
      <span class="badge badge-sm badge-ghost gap-1 font-mono">${diff.stats.identicalTables} Identical</span>
    `;

    // 2. Git Unified Diff Syntax Highlighting with Line Numbers
    const lines = diff.unifiedDiff.split('\n');
    const coloredHtml = lines
      .map((line, idx) => {
        const escaped = escapeHtml(line);
        const lineNum = `<span class="inline-block w-8 text-right pr-3 select-none opacity-30 font-mono text-[10px]">${idx + 1}</span>`;

        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
          return `<div class="font-bold text-neutral-content/90 bg-white/[0.04] py-0.5">${lineNum}${escaped}</div>`;
        }
        if (line.startsWith('@@')) {
          return `<div class="font-bold text-cyan-400 bg-cyan-400/10 py-1 my-1 rounded border-l-2 border-cyan-400">${lineNum}${escaped}</div>`;
        }
        if (line.startsWith('+')) {
          return `<div class="text-emerald-400 bg-emerald-500/10 py-0.5 border-l-2 border-emerald-500">${lineNum}${escaped}</div>`;
        }
        if (line.startsWith('-')) {
          return `<div class="text-rose-400 bg-rose-500/10 py-0.5 border-l-2 border-rose-500">${lineNum}${escaped}</div>`;
        }
        if (line.startsWith('~')) {
          return `<div class="text-amber-400 bg-amber-500/10 py-0.5 border-l-2 border-amber-500">${lineNum}${escaped}</div>`;
        }
        return `<div class="text-neutral-content/60 py-0.5">${lineNum}${escaped}</div>`;
      })
      .join('');

    unifiedDiffView.innerHTML = coloredHtml;

    // 3. Render Visual Breakdown Cards
    renderVisualCards();
  }

  function renderVisualCards() {
    if (!currentDiffData || !currentDiffData.tables || currentDiffData.tables.length === 0) {
      visualDiffCards.innerHTML = '<div class="text-base-content/40 italic text-center py-16">No tables found.</div>';
      return;
    }

    const searchQuery = (inputFilterVisualTables?.value || '').trim().toLowerCase();

    const filtered = currentDiffData.tables.filter((t) => {
      if (searchQuery && !t.name.toLowerCase().includes(searchQuery)) return false;
      if (activeStatusFilter === 'modified' && t.action !== 'modified') return false;
      if (activeStatusFilter === 'added' && t.action !== 'added') return false;
      if (activeStatusFilter === 'removed' && t.action !== 'removed') return false;
      return true;
    });

    if (filtered.length === 0) {
      visualDiffCards.innerHTML = '<div class="text-base-content/40 italic text-center py-10">No tables match the current filter.</div>';
      return;
    }

    visualDiffCards.innerHTML = filtered
      .map((t) => {
        let actionBadge = '';
        let cardBorder = 'border-base-300';
        if (t.action === 'added') {
          actionBadge = '<span class="badge badge-sm badge-success font-bold font-mono">+ ADDED</span>';
          cardBorder = 'border-success/40 bg-success/[0.03] shadow-sm';
        } else if (t.action === 'removed') {
          actionBadge = '<span class="badge badge-sm badge-error font-bold font-mono">- REMOVED</span>';
          cardBorder = 'border-error/40 bg-error/[0.03] shadow-sm';
        } else if (t.action === 'modified') {
          actionBadge = '<span class="badge badge-sm badge-warning font-bold font-mono">~ MODIFIED</span>';
          cardBorder = 'border-warning/40 bg-warning/[0.03] shadow-sm';
        } else {
          actionBadge = '<span class="badge badge-sm badge-ghost font-mono">IDENTICAL</span>';
        }

        const changesList = [];
        for (const c of t.columnDiffs) {
          if (c.action === 'added') {
            changesList.push(`<li class="text-emerald-500 font-semibold">+ Column: <strong>${escapeHtml(c.name)}</strong> (${c.sourceCol ? c.sourceCol.type : ''})</li>`);
          } else if (c.action === 'removed') {
            changesList.push(`<li class="text-rose-500 font-semibold">- Column: <strong>${escapeHtml(c.name)}</strong> (${c.targetCol ? c.targetCol.type : ''})</li>`);
          } else if (c.action === 'modified') {
            changesList.push(`<li class="text-amber-500 font-semibold">~ Column <strong>${escapeHtml(c.name)}</strong>: ${escapeHtml(c.changes.join('; '))}</li>`);
          }
        }

        for (const idx of t.indexesAdded) changesList.push(`<li class="text-emerald-500 font-semibold">+ Index: ${escapeHtml(idx)}</li>`);
        for (const idx of t.indexesRemoved) changesList.push(`<li class="text-rose-500 font-semibold">- Index: ${escapeHtml(idx)}</li>`);
        for (const fk of t.fksAdded) changesList.push(`<li class="text-emerald-500 font-semibold">+ Foreign Key: ${escapeHtml(fk)}</li>`);
        for (const fk of t.fksRemoved) changesList.push(`<li class="text-rose-500 font-semibold">- Foreign Key: ${escapeHtml(fk)}</li>`);

        const changesHtml = changesList.length > 0
          ? `<ul class="list-disc list-inside space-y-1.5 text-xs font-mono mt-3 p-3 rounded-lg bg-base-100 border border-base-200">${changesList.join('')}</ul>`
          : '<div class="text-xs text-base-content/40 mt-1">Schema structure is identical.</div>';

        return `
          <div class="rounded-xl border ${cardBorder} p-4 space-y-2 transition hover:shadow-md">
            <div class="flex items-center justify-between">
              <span class="font-mono text-sm font-bold flex items-center gap-2">
                ${escapeHtml(t.name)}
              </span>
              <div class="flex items-center gap-2">
                ${actionBadge}
                <button type="button" class="btn btn-ghost btn-xs text-primary gap-1 js-inspect-data-btn hover:bg-primary/10" data-table="${escapeHtml(t.name)}">
                  Inspect Data ➔
                </button>
              </div>
            </div>
            ${changesHtml}
          </div>
        `;
      })
      .join('');

    // Attach listeners to "Inspect Data ➔" buttons
    visualDiffCards.querySelectorAll('.js-inspect-data-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const table = btn.getAttribute('data-table');
        if (table) {
          selectDataDiffTable.value = table;
          diffTabs.querySelector('[data-tab="data"]').click();
          btnFetchDataDiff.click();
        }
      });
    });
  }

  // Visual filter listeners
  if (inputFilterVisualTables) {
    inputFilterVisualTables.addEventListener('input', renderVisualCards);
  }
  filterStatusButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      filterStatusButtons.forEach((b) => b.classList.remove('btn-active'));
      btn.classList.add('btn-active');
      activeStatusFilter = btn.getAttribute('data-filter') || 'all';
      renderVisualCards();
    });
  });

  // Copy Unified Diff Text
  if (btnCopyUnifiedDiff) {
    btnCopyUnifiedDiff.addEventListener('click', () => {
      if (!currentDiffData || !currentDiffData.unifiedDiff) return;
      navigator.clipboard.writeText(currentDiffData.unifiedDiff).then(() => {
        UI.showToast('Unified diff copied to clipboard.', 'success');
      });
    });
  }

  // ---- Tabs Navigation -----------------------------------------------------

  diffTabs.querySelectorAll('.tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      diffTabs.querySelectorAll('.tab').forEach((b) => b.classList.remove('tab-active'));
      tabBtn.classList.add('tab-active');

      const target = tabBtn.getAttribute('data-tab');
      tabContentUnified.classList.toggle('hidden', target !== 'unified');
      tabContentVisual.classList.toggle('hidden', target !== 'visual');
      tabContentData.classList.toggle('hidden', target !== 'data');
    });
  });

  // ---- Compare Row Data Diff -----------------------------------------------

  btnFetchDataDiff.addEventListener('click', async () => {
    const table = selectDataDiffTable.value;
    const src = selectSource.value;
    const tgt = selectTarget.value;
    const limit = parseInt(selectDataDiffLimit?.value || '150', 10);

    if (!src || !tgt || !table) {
      return UI.showError('Select source, target, and a table to inspect.');
    }

    btnFetchDataDiff.disabled = true;
    btnFetchDataDiff.innerHTML = '<span class="loading loading-spinner loading-xs"></span> Fetching…';

    try {
      const result = await Api.post('/api/sync/diff/data', { sourceDbId: src, targetDbId: tgt, table, limit });
      dataDiffStats.innerHTML = `
        <span class="badge badge-sm badge-outline font-mono">Source: ${result.sourceRowCount}</span>
        <span class="badge badge-sm badge-outline font-mono">Target: ${result.targetRowCount}</span>
        <span class="badge badge-sm badge-success font-mono font-bold">+${result.addedCount} Added</span>
        <span class="badge badge-sm badge-error font-mono font-bold">-${result.removedCount} Removed</span>
        <span class="badge badge-sm badge-warning font-mono font-bold">~${result.modifiedCount} Modified</span>
      `;

      if (result.rows.length === 0) {
        dataDiffResults.innerHTML = `
          <div class="text-success font-bold text-center py-16 flex flex-col items-center gap-2">
            <span class="text-base">✓ Data records in table "${escapeHtml(table)}" are completely identical.</span>
            <span class="text-xs font-normal text-base-content/60 font-mono">${result.sourceRowCount} matching records compared (sample limit: ${limit}).</span>
          </div>
        `;
        return;
      }

      // Render Visual Row Cards with Structured Changes Table
      const renderedCards = result.rows.map((rowItem) => {
        let badge = '';
        let cardBg = 'bg-base-200/40 border-base-300';

        if (rowItem.action === 'added') {
          badge = '<span class="badge badge-xs badge-success font-bold">+ ADDED IN SOURCE</span>';
          cardBg = 'bg-success/[0.04] border-success/30';
          return `
            <div class="rounded-xl border ${cardBg} p-3.5 space-y-2 font-mono text-xs">
              <div class="flex items-center justify-between">
                <span class="font-bold text-emerald-600 dark:text-emerald-400">PK: ${escapeHtml(rowItem.key)}</span>
                ${badge}
              </div>
              <div class="text-base-content/80 text-[11px] overflow-x-auto bg-base-100 p-2.5 rounded-lg border border-base-200">
                <pre class="m-0">${escapeHtml(JSON.stringify(rowItem.sourceRow, null, 2))}</pre>
              </div>
            </div>
          `;
        }

        if (rowItem.action === 'removed') {
          badge = '<span class="badge badge-xs badge-error font-bold">- REMOVED FROM SOURCE</span>';
          cardBg = 'bg-error/[0.04] border-error/30';
          return `
            <div class="rounded-xl border ${cardBg} p-3.5 space-y-2 font-mono text-xs">
              <div class="flex items-center justify-between">
                <span class="font-bold text-rose-600 dark:text-rose-400">PK: ${escapeHtml(rowItem.key)}</span>
                ${badge}
              </div>
              <div class="text-base-content/80 text-[11px] overflow-x-auto bg-base-100 p-2.5 rounded-lg border border-base-200">
                <pre class="m-0">${escapeHtml(JSON.stringify(rowItem.targetRow, null, 2))}</pre>
              </div>
            </div>
          `;
        }

        // Modified: show clean field changes table
        badge = '<span class="badge badge-xs badge-warning font-bold">~ MODIFIED</span>';
        cardBg = 'bg-warning/[0.04] border-warning/30';
        const changesRows = (rowItem.changes || [])
          .map((c) => `
            <tr class="hover:bg-base-200/50">
              <td class="font-bold text-base-content">${escapeHtml(c.column)}</td>
              <td class="text-rose-500 bg-rose-500/10 rounded px-2 py-1 font-mono">${escapeHtml(JSON.stringify(c.targetValue))}</td>
              <td class="text-emerald-500 bg-emerald-500/10 rounded px-2 py-1 font-mono">${escapeHtml(JSON.stringify(c.sourceValue))}</td>
            </tr>
          `)
          .join('');

        return `
          <div class="rounded-xl border ${cardBg} p-3.5 space-y-2 font-mono text-xs">
            <div class="flex items-center justify-between">
              <span class="font-bold text-amber-600 dark:text-amber-400">PK: ${escapeHtml(rowItem.key)}</span>
              ${badge}
            </div>
            <div class="overflow-x-auto rounded-lg border border-base-200 bg-base-100">
              <table class="table table-xs w-full">
                <thead>
                  <tr class="bg-base-200/60 text-base-content/60">
                    <th>Field</th>
                    <th>Target (Current Value)</th>
                    <th>Source (Incoming Value)</th>
                  </tr>
                </thead>
                <tbody>
                  ${changesRows}
                </tbody>
              </table>
            </div>
          </div>
        `;
      }).join('');

      dataDiffResults.innerHTML = `
        <div class="space-y-3">
          ${renderedCards}
        </div>
      `;
    } catch (e) {
      UI.showError(e.message);
    } finally {
      btnFetchDataDiff.disabled = false;
      btnFetchDataDiff.innerHTML = 'Compare Rows';
    }
  });

  // ---- Generate Migration SQL ----------------------------------------------

  btnGenerateSql.addEventListener('click', async () => {
    const src = selectSource.value;
    const tgt = selectTarget.value;
    try {
      const patch = await Api.post('/api/sync/patch', { sourceDbId: src, targetDbId: tgt });
      currentPatchSql = patch;
      activePatchTab = 'up';
      updatePatchModal();
      modalSqlPatch.showModal();
    } catch (e) {
      UI.showError(e.message);
    }
  });

  function updatePatchModal() {
    if (!currentPatchSql) return;
    tabUpSql.classList.toggle('tab-active', activePatchTab === 'up');
    tabDownSql.classList.toggle('tab-active', activePatchTab === 'down');
    patchSqlCode.textContent = activePatchTab === 'up' ? currentPatchSql.upSql : currentPatchSql.downSql;
  }

  tabUpSql.addEventListener('click', () => {
    activePatchTab = 'up';
    updatePatchModal();
  });

  tabDownSql.addEventListener('click', () => {
    activePatchTab = 'down';
    updatePatchModal();
  });

  btnCopyPatchSql.addEventListener('click', () => {
    const sql = patchSqlCode.textContent || '';
    if (!sql) return;
    navigator.clipboard.writeText(sql).then(() => {
      UI.showToast('Migration SQL copied to clipboard.', 'success');
    });
  });

  // ---- Dry Run -------------------------------------------------------------

  btnDryRun.addEventListener('click', async () => {
    const src = selectSource.value;
    const tgt = selectTarget.value;
    const mode = document.querySelector('input[name="sync-mode"]:checked')?.value || 'full';
    const maskData = document.getElementById('chk-mask-data')?.checked;
    const tables = getSelectedTables();

    btnDryRun.disabled = true;
    btnDryRun.innerHTML = '<span class="loading loading-spinner loading-xs"></span> Simulating…';

    try {
      const res = await Api.post('/api/sync/dry-run', {
        sourceDbId: src,
        targetDbId: tgt,
        mode,
        tables,
        maskData,
      });

      UI.showToast(res.summary, 'info');
    } catch (e) {
      UI.showError(e.message);
    } finally {
      btnDryRun.disabled = false;
      btnDryRun.innerHTML = 'Dry Run';
    }
  });

  // ---- Destructive Action Guardrails & Execution ---------------------------

  let requiredConfirmationPhrase = 'OVERWRITE';

  function validateDestructionUnlock() {
    const isChecked = chkConfirmDestruction.checked;
    const typed = (inputConfirmPhrase.value || '').trim();
    const isPhraseValid = typed.toUpperCase() === requiredConfirmationPhrase.toUpperCase();

    btnExecStart.disabled = !(isChecked && isPhraseValid);
  }

  chkConfirmDestruction.addEventListener('change', validateDestructionUnlock);
  inputConfirmPhrase.addEventListener('input', validateDestructionUnlock);

  btnExecute.addEventListener('click', () => {
    const src = selectSource.value;
    const tgt = selectTarget.value;
    const mode = document.querySelector('input[name="sync-mode"]:checked')?.value || 'full';
    const maskData = document.getElementById('chk-mask-data')?.checked;
    const tables = getSelectedTables();

    lblConfirmSrc.textContent = src;
    lblConfirmTgt.textContent = tgt;
    lblConfirmTgtHighlight.textContent = tgt;
    lblConfirmMode.textContent = mode === 'full' ? 'Full Clone (Drop & Recreate)' : mode === 'schema_only' ? 'Schema Only' : 'Data Only (Truncate & Replace)';
    lblConfirmMask.textContent = maskData ? 'Enabled (Synthetic PII)' : 'Disabled';
    lblConfirmTables.textContent = tables.length > 0 ? `${tables.length} tables selected` : 'All discovered tables';

    lblAffectedTablesList.textContent = tables.length > 0 ? tables.join(', ') : 'All tables in database';

    // Determine Destructiveness
    const isDestructive = mode === 'full' || mode === 'data_only_replace';
    const isTargetProd = tgt.toLowerCase().includes('prod') || tgt.toLowerCase().includes('production');

    // Customize confirmation phrase
    if (isTargetProd) {
      requiredConfirmationPhrase = tgt;
      lblDestructiveActionDesc.textContent = 'PERMANENTLY OVERWRITE PRODUCTION DATABASE';
    } else if (mode === 'full') {
      requiredConfirmationPhrase = 'OVERWRITE';
      lblDestructiveActionDesc.textContent = 'permanently drop and recreate tables';
    } else if (mode === 'data_only_replace') {
      requiredConfirmationPhrase = 'TRUNCATE';
      lblDestructiveActionDesc.textContent = 'permanently truncate/delete all existing rows';
    } else {
      requiredConfirmationPhrase = 'SYNC';
      lblDestructiveActionDesc.textContent = 'apply schema structures to';
    }

    lblRequiredConfirmWord.textContent = requiredConfirmationPhrase;

    // Toggle danger banner visibility
    execDestructiveBanner.classList.toggle('hidden', !isDestructive);

    // Reset safety inputs
    chkConfirmDestruction.checked = false;
    inputConfirmPhrase.value = '';
    btnExecStart.disabled = true;

    // Reset prompt views
    execPromptContent.classList.remove('hidden');
    execProgressContainer.classList.add('hidden');
    btnExecStart.classList.remove('hidden');
    btnExecCancel.classList.remove('hidden');

    modalSyncExecute.showModal();
  });

  btnExecStart.addEventListener('click', async () => {
    const src = selectSource.value;
    const tgt = selectTarget.value;
    const mode = document.querySelector('input[name="sync-mode"]:checked')?.value || 'full';
    const maskData = document.getElementById('chk-mask-data')?.checked;
    const tables = getSelectedTables();
    const confirmPhrase = (inputConfirmPhrase.value || '').trim();

    // Safety checks
    if (!chkConfirmDestruction.checked || confirmPhrase.toUpperCase() !== requiredConfirmationPhrase.toUpperCase()) {
      return UI.showError(`Type "${requiredConfirmationPhrase}" and check the confirmation box to proceed.`);
    }

    // Switch to progress view
    execPromptContent.classList.add('hidden');
    execProgressContainer.classList.remove('hidden');
    btnExecStart.classList.add('hidden');
    btnExecCancel.classList.add('hidden');
    btnExecCloseX.disabled = true;

    execProgressBar.value = 10;
    execProgressPercent.textContent = '10%';
    execLogContainer.innerHTML = `<div>[${new Date().toLocaleTimeString()}] Initializing replication: ${escapeHtml(src)} ➔ ${escapeHtml(tgt)}...</div>`;
    execLogContainer.innerHTML += `<div>[${new Date().toLocaleTimeString()}] Mode: ${mode}, Masking: ${maskData ? 'Yes' : 'No'}</div>`;

    try {
      execProgressBar.value = 35;
      execProgressPercent.textContent = '35%';

      const res = await Api.post('/api/sync/execute', {
        sourceDbId: src,
        targetDbId: tgt,
        mode,
        tables,
        maskData,
        confirmTargetName: confirmPhrase,
      });

      execProgressBar.value = 100;
      execProgressPercent.textContent = '100%';
      execCurrentTable.innerHTML = `<span class="text-success font-bold">✓ Replication Succeeded!</span>`;
      execLogContainer.innerHTML += `<div class="text-success font-bold mt-1.5">[${new Date().toLocaleTimeString()}] ${escapeHtml(res.summary)}</div>`;
      execLogContainer.innerHTML += `<div class="text-base-content/60 mt-1">[${new Date().toLocaleTimeString()}] Completed in ${res.executionTimeMs}ms. (${res.totalRowsTransferred} rows transferred).</div>`;

      UI.showToast(res.summary, 'success');
      setTimeout(() => {
        btnExecCloseX.disabled = false;
        compareDiff(); // automatically re-run diff to show updated sync state
      }, 1200);
    } catch (e) {
      execCurrentTable.innerHTML = `<span class="text-error font-bold">✗ Replication Failed</span>`;
      execLogContainer.innerHTML += `<div class="text-error font-bold mt-1.5">[${new Date().toLocaleTimeString()}] Error: ${escapeHtml(e.message)}</div>`;
      btnExecCloseX.disabled = false;
      UI.showError(e.message);
    }
  });

  // Initial update
  updateDbBadges();
})();
