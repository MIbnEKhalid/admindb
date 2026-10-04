/* Global Search / Command Palette Controller (Spotlight) */
(function () {
  'use strict';

  var currentDb = (window.APP && window.APP.dbId) || null;
  var basePath = (window.APP && window.APP.basePath) || '';

  // Cache of metadata index for instant 0ms responses
  var localIndex = null;
  var isIndexLoading = false;
  var activeCategory = 'all';
  var selectedIndex = 0;
  var searchTimeout = null;
  var currentResults = [];
  var isPaletteOpen = false;

  var CATEGORIES = [
    { id: 'all', label: 'All' },
    { id: 'table', label: 'Tables' },
    { id: 'column', label: 'Columns' },
    { id: 'index', label: 'Indexes' },
    { id: 'relation', label: 'Relations' },
    { id: 'command', label: 'Commands' },
    { id: 'row', label: 'Row Data' },
  ];

  var ICONS = {
    search:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>',
    table:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>',
    columns:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 4.5v15m6-15v15m-10.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125z" /></svg>',
    key:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>',
    diagram:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="6" height="5" rx="1"/><rect x="16" y="3" width="6" height="5" rx="1"/><rect x="9" y="16" width="6" height="5" rx="1"/><path stroke-linecap="round" stroke-linejoin="round" d="M5 8v4h14V8M12 12v4"/></svg>',
    query:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>',
    seed:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>',
    diff:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7h8M8 12h8m-8 5h4M4 4v16a2 2 0 002 2h12a2 2 0 002-2V4a2 2 0 00-2-2H6a2 2 0 00-2 2zM12 3v4m-3-2h6"/></svg>',
    settings:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>',
    export:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>',
    plus:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" /></svg>',
    home:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>',
    inspect:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>',
    sparkles:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>',
    spinner:
      '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 animate-spin text-primary" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>',
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function highlightMatch(text, query) {
    if (!text || !query) return escapeHtml(text);
    var escapedText = escapeHtml(text);
    var escapedQ = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      var regex = new RegExp('(' + escapedQ + ')', 'gi');
      return escapedText.replace(regex, '<span class="text-primary font-bold underline underline-offset-2">$1</span>');
    } catch (e) {
      return escapedText;
    }
  }

  function getCategoryBadge(category, badgeText, badgeType) {
    var label = badgeText || category;
    var typeClass = 'bg-base-200 text-base-content/60';
    if (badgeType === 'primary' || category === 'table') typeClass = 'bg-primary/10 text-primary border border-primary/20';
    else if (badgeType === 'accent' || category === 'column') typeClass = 'bg-secondary/10 text-secondary border border-secondary/20';
    else if (badgeType === 'info' || category === 'relation') typeClass = 'bg-info/10 text-info border border-info/20';
    else if (badgeType === 'warning' || category === 'index') typeClass = 'bg-warning/10 text-warning border border-warning/20';
    else if (badgeType === 'secondary' || category === 'command') typeClass = 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20';

    return '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ' + typeClass + '">' + escapeHtml(label) + '</span>';
  }

  // ---- Modal DOM Creation --------------------------------------------------

  var modalOverlay = null;
  var searchInput = null;
  var resultsContainer = null;
  var statusEl = null;
  var tabsContainer = null;
  var loadingSpinner = null;

  function createSearchModal() {
    if (modalOverlay) return;

    modalOverlay = document.createElement('div');
    modalOverlay.id = 'global-search-modal';
    modalOverlay.className =
      'fixed inset-0 z-[200] flex items-start justify-center bg-black/60 backdrop-blur-xs p-4 sm:p-6 md:p-12 opacity-0 pointer-events-none transition-opacity duration-150';
    modalOverlay.setAttribute('role', 'dialog');
    modalOverlay.setAttribute('aria-modal', 'true');

    var card = document.createElement('div');
    card.className =
      'app-card w-full max-w-2xl overflow-hidden shadow-2xl border border-base-300 bg-base-100 flex flex-col max-h-[85vh] transform scale-95 transition-transform duration-150 rounded-2xl';

    // 1. Search Header Input
    var header = document.createElement('div');
    header.className = 'relative flex items-center border-b border-base-200 px-4 py-3 bg-base-100/90';

    header.innerHTML =
      '<span class="pointer-events-none text-base-content/40 mr-3 shrink-0">' +
      ICONS.search +
      '</span>' +
      '<input id="global-search-input" type="search" placeholder="Search tables, columns, indexes, commands, data… (Ctrl+K)" autocomplete="off" spellcheck="false" class="w-full bg-transparent text-base sm:text-lg text-base-content placeholder:text-base-content/40 outline-none font-medium" />' +
      '<div class="flex items-center gap-2 ml-2 shrink-0">' +
      '  <span id="global-search-spinner" class="hidden shrink-0">' + ICONS.spinner + '</span>' +
      '  <kbd class="hidden sm:inline-flex items-center rounded border border-base-300 bg-base-200/60 px-1.5 py-0.5 text-[10px] font-mono text-base-content/50">ESC</kbd>' +
      '</div>';

    // 2. Filter Pills Tabs
    var tabsBar = document.createElement('div');
    tabsBar.id = 'global-search-tabs';
    tabsBar.className = 'flex items-center gap-1.5 overflow-x-auto border-b border-base-200 px-4 py-2 bg-base-200/30 text-xs no-scrollbar';

    CATEGORIES.forEach(function (cat) {
      var tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className =
        'search-tab-btn rounded-lg px-2.5 py-1 font-medium transition-colors ' +
        (cat.id === 'all' ? 'bg-primary text-primary-content font-semibold shadow-xs' : 'text-base-content/60 hover:text-base-content hover:bg-base-200');
      tabBtn.setAttribute('data-category', cat.id);
      tabBtn.textContent = cat.label;
      tabBtn.addEventListener('click', function () {
        setCategory(cat.id);
      });
      tabsBar.appendChild(tabBtn);
    });

    // 3. Results Container
    resultsContainer = document.createElement('div');
    resultsContainer.id = 'global-search-results';
    resultsContainer.className = 'flex-1 overflow-y-auto p-2 sm:p-3 space-y-1 divide-y divide-base-200/50 min-h-[160px] max-h-[480px]';

    // 4. Footer shortcuts bar
    var footer = document.createElement('div');
    footer.className =
      'flex flex-wrap items-center justify-between gap-3 border-t border-base-200 bg-base-200/40 px-4 py-2.5 text-[11px] text-base-content/50';

    footer.innerHTML =
      '<div class="flex items-center gap-3">' +
      '  <span class="flex items-center gap-1"><kbd class="rounded border border-base-300 bg-base-100 px-1 py-0.5 font-mono text-[10px] font-bold">↑</kbd><kbd class="rounded border border-base-300 bg-base-100 px-1 py-0.5 font-mono text-[10px] font-bold">↓</kbd> navigate</span>' +
      '  <span class="flex items-center gap-1"><kbd class="rounded border border-base-300 bg-base-100 px-1.5 py-0.5 font-mono text-[10px] font-bold">↵</kbd> select</span>' +
      '  <span class="flex items-center gap-1"><kbd class="rounded border border-base-300 bg-base-100 px-1 py-0.5 font-mono text-[10px] font-bold">Tab</kbd> category</span>' +
      '</div>' +
      '<div id="global-search-count" class="font-medium text-base-content/60">0 results</div>';

    card.appendChild(header);
    card.appendChild(tabsBar);
    card.appendChild(resultsContainer);
    card.appendChild(footer);
    modalOverlay.appendChild(card);
    document.body.appendChild(modalOverlay);

    searchInput = header.querySelector('#global-search-input');
    loadingSpinner = header.querySelector('#global-search-spinner');
    statusEl = footer.querySelector('#global-search-count');
    tabsContainer = tabsBar;

    // Events inside modal
    searchInput.addEventListener('input', function () {
      triggerSearch(searchInput.value);
    });

    searchInput.addEventListener('keydown', onSearchKeyDown);

    modalOverlay.addEventListener('click', function (e) {
      if (e.target === modalOverlay) closeSearch();
    });
  }

  function setCategory(category) {
    activeCategory = category;
    if (tabsContainer) {
      var buttons = tabsContainer.querySelectorAll('.search-tab-btn');
      buttons.forEach(function (btn) {
        var isCurrent = btn.getAttribute('data-category') === category;
        btn.className =
          'search-tab-btn rounded-lg px-2.5 py-1 font-medium transition-colors ' +
          (isCurrent ? 'bg-primary text-primary-content font-semibold shadow-xs' : 'text-base-content/60 hover:text-base-content hover:bg-base-200');
      });
    }
    triggerSearch(searchInput ? searchInput.value : '');
  }

  // ---- Open / Close Search Palette -----------------------------------------

  function openSearch(initialQuery) {
    createSearchModal();
    if (!currentDb) {
      // In multi-db directory mode, use available db context or navigate
      currentDb = (window.APP && window.APP.dbId) || '';
    }

    modalOverlay.classList.remove('pointer-events-none', 'opacity-0');
    modalOverlay.classList.add('opacity-100');
    var card = modalOverlay.querySelector('.app-card');
    if (card) {
      card.classList.remove('scale-95');
      card.classList.add('scale-100');
    }

    isPaletteOpen = true;
    if (initialQuery !== undefined && searchInput) {
      searchInput.value = initialQuery;
    }

    setTimeout(function () {
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    }, 40);

    loadMetadataIndex();
    triggerSearch(searchInput ? searchInput.value : '');
  }

  function closeSearch() {
    if (!modalOverlay || !isPaletteOpen) return;
    isPaletteOpen = false;
    modalOverlay.classList.remove('opacity-100');
    modalOverlay.classList.add('opacity-0');
    var card = modalOverlay.querySelector('.app-card');
    if (card) {
      card.classList.remove('scale-100');
      card.classList.add('scale-95');
    }
    setTimeout(function () {
      if (modalOverlay) modalOverlay.classList.add('pointer-events-none');
    }, 150);
  }

  // ---- Metadata Index Fetching ---------------------------------------------

  async function loadMetadataIndex() {
    if (localIndex || isIndexLoading || !currentDb) return;
    isIndexLoading = true;
    try {
      if (window.Api) {
        var data = await window.Api.get('/api/search/' + encodeURIComponent(currentDb) + '/metadata');
        if (data) localIndex = data;
      }
    } catch (e) {
      // Silently fallback to live search API
    } finally {
      isIndexLoading = false;
    }
  }

  // ---- Search Trigger & Execution -----------------------------------------

  function triggerSearch(query) {
    if (searchTimeout) clearTimeout(searchTimeout);

    // 1. Instant local filter (0ms)
    var fastResults = executeLocalSearch(query);
    renderResults(fastResults, query);

    // 2. Debounced deep server search (180ms)
    if (currentDb) {
      if (loadingSpinner) loadingSpinner.classList.remove('hidden');
      searchTimeout = setTimeout(async function () {
        try {
          var params = '?q=' + encodeURIComponent(query || '');
          if (activeCategory !== 'all') params += '&type=' + encodeURIComponent(activeCategory);
          var res = await window.Api.get('/api/search/' + encodeURIComponent(currentDb) + params);
          if (res && res.results) {
            renderResults(res.results, query);
          }
        } catch (e) {
          // keep local results
        } finally {
          if (loadingSpinner) loadingSpinner.classList.add('hidden');
        }
      }, 180);
    }
  }

  function executeLocalSearch(query) {
    var q = String(query || '').trim().toLowerCase();
    if (!localIndex) return [];

    var list = [];
    var encDb = encodeURIComponent(currentDb || '');

    var matchScore = function (target) {
      if (!target) return 0;
      var t = target.toLowerCase();
      if (!q) return 50;
      if (t === q) return 100;
      if (t.startsWith(q)) return 85;
      if (t.includes(q)) return 50;
      return 0;
    };

    // Filter Tables
    if (activeCategory === 'all' || activeCategory === 'table') {
      (localIndex.tables || []).forEach(function (tbl) {
        var s = matchScore(tbl.name);
        if (s > 0) {
          var encTbl = encodeURIComponent(tbl.name);
          list.push({
            id: 'tbl-' + tbl.name,
            category: 'table',
            title: tbl.name,
            subtitle: 'Table · ' + tbl.columnsCount + ' columns' + (tbl.primaryKey.length ? ' · PK (' + tbl.primaryKey.join(', ') + ')' : ''),
            icon: 'table',
            url: basePath + '/tables/' + encDb + '/' + encTbl,
            score: s + 15,
            badge: 'Table',
            badgeType: 'primary',
            actions: [
              { label: 'Browse', url: basePath + '/tables/' + encDb + '/' + encTbl, primary: true },
              { label: 'Schema', url: basePath + '/schema/' + encDb + '/' + encTbl },
              { label: 'Query', url: basePath + '/query/' + encDb + '?sql=' + encodeURIComponent('SELECT * FROM ' + tbl.name + ' LIMIT 100;') },
            ],
          });
        }
      });
    }

    // Filter Columns
    if (activeCategory === 'all' || activeCategory === 'column') {
      (localIndex.columns || []).forEach(function (col) {
        var sName = matchScore(col.name);
        var sFull = matchScore(col.table + '.' + col.name);
        var s = Math.max(sName, sFull);
        if (s > 0) {
          var encTbl = encodeURIComponent(col.table);
          list.push({
            id: 'col-' + col.table + '-' + col.name,
            category: 'column',
            title: col.name,
            subtitle: col.table + ' · ' + col.type + (col.isPk ? ' · Primary Key' : '') + (col.isFk ? ' · FK → ' + col.fkTarget : ''),
            icon: 'columns',
            url: basePath + '/tables/' + encDb + '/' + encTbl,
            score: s + 10,
            badge: col.isPk ? 'PK' : col.isFk ? 'FK' : col.type,
            badgeType: col.isPk ? 'accent' : col.isFk ? 'info' : 'neutral',
            actions: [
              { label: 'Browse Table', url: basePath + '/tables/' + encDb + '/' + encTbl, primary: true },
              { label: 'View Schema', url: basePath + '/schema/' + encDb + '/' + encTbl },
            ],
          });
        }
      });
    }

    // Filter Indexes
    if (activeCategory === 'all' || activeCategory === 'index') {
      (localIndex.indexes || []).forEach(function (idx) {
        var sName = matchScore(idx.name);
        var sCols = (idx.columns || []).some(function (c) { return matchScore(c) > 60; }) ? 60 : 0;
        var s = Math.max(sName, sCols);
        if (s > 0) {
          var encTbl = encodeURIComponent(idx.table);
          list.push({
            id: 'idx-' + idx.table + '-' + idx.name,
            category: 'index',
            title: idx.name,
            subtitle: idx.table + ' (' + (idx.columns || []).join(', ') + ') · ' + (idx.unique ? 'UNIQUE ' : '') + 'Index',
            icon: 'key',
            url: basePath + '/schema/' + encDb + '/' + encTbl,
            score: s,
            badge: idx.unique ? 'Unique Index' : 'Index',
            badgeType: idx.unique ? 'warning' : 'neutral',
            actions: [
              { label: 'View in Schema', url: basePath + '/schema/' + encDb + '/' + encTbl, primary: true },
            ],
          });
        }
      });
    }

    // Filter Foreign Keys
    if (activeCategory === 'all' || activeCategory === 'relation') {
      (localIndex.foreignKeys || []).forEach(function (fk) {
        var sFrom = matchScore(fk.fromTable + '.' + fk.fromColumn);
        var sTo = matchScore(fk.toTable + '.' + (fk.toColumn || 'id'));
        var s = Math.max(sFrom, sTo);
        if (s > 0) {
          list.push({
            id: 'fk-' + fk.fromTable + '-' + fk.fromColumn,
            category: 'relation',
            title: fk.fromTable + '.' + fk.fromColumn + ' → ' + fk.toTable + '.' + (fk.toColumn || 'id'),
            subtitle: 'Foreign Key · ON UPDATE ' + fk.onUpdate + ', ON DELETE ' + fk.onDelete,
            icon: 'diagram',
            url: basePath + '/erd/' + encDb,
            score: s,
            badge: 'Relation',
            badgeType: 'info',
            actions: [
              { label: 'View ERD', url: basePath + '/erd/' + encDb, primary: true },
            ],
          });
        }
      });
    }

    // Filter Commands
    if (activeCategory === 'all' || activeCategory === 'command') {
      (localIndex.commands || []).forEach(function (cmd) {
        var sTitle = matchScore(cmd.title);
        var sKw = (cmd.keywords || []).some(function (k) { return matchScore(k) > 60; }) ? 70 : 0;
        var s = Math.max(sTitle, sKw);
        if (s > 0) {
          list.push({
            id: cmd.id,
            category: 'command',
            title: cmd.title,
            subtitle: cmd.description,
            icon: cmd.icon,
            url: cmd.url,
            score: s + 5,
            badge: 'Command',
            badgeType: 'secondary',
            actions: [
              { label: 'Execute', url: cmd.url, primary: true },
            ],
          });
        }
      });
    }

    list.sort(function (a, b) { return b.score - a.score; });
    return list.slice(0, 50);
  }

  // ---- Rendering Results ---------------------------------------------------

  function renderResults(items, query) {
    currentResults = items || [];
    selectedIndex = 0;

    if (!resultsContainer) return;
    resultsContainer.innerHTML = '';

    if (statusEl) {
      statusEl.textContent = currentResults.length + (currentResults.length === 1 ? ' result' : ' results');
    }

    if (currentResults.length === 0) {
      var emptyEl = document.createElement('div');
      emptyEl.className = 'empty-state py-10 px-4 text-center';
      emptyEl.innerHTML =
        '<div class="empty-icon mx-auto mb-2 text-base-content/30">' +
        ICONS.search +
        '</div>' +
        '<p class="text-sm font-semibold text-base-content/70">No matching items found</p>' +
        '<p class="text-xs text-base-content/40 mt-1">Try searching for a different table, column name, or command.</p>';
      resultsContainer.appendChild(emptyEl);
      return;
    }

    currentResults.forEach(function (item, idx) {
      var row = document.createElement('div');
      row.className =
        'search-result-item group flex items-center justify-between gap-3 p-2.5 rounded-xl cursor-pointer transition-all duration-100 ' +
        (idx === 0 ? 'bg-primary/10 border border-primary/20 shadow-xs' : 'hover:bg-base-200/70 border border-transparent');
      row.setAttribute('data-index', idx);
      row.setAttribute('data-url', item.url);

      var iconSvg = ICONS[item.icon] || ICONS[item.category] || ICONS.search;
      var titleHtml = highlightMatch(item.title, query);
      var badgeHtml = getCategoryBadge(item.category, item.badge, item.badgeType);

      var actionsHtml = '';
      if (item.actions && item.actions.length > 0) {
        actionsHtml = '<div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">';
        item.actions.forEach(function (act) {
          actionsHtml +=
            '<a href="' + escapeHtml(act.url) + '" class="btn btn-xs ' + (act.primary ? 'btn-primary' : 'btn-ghost') + ' rounded-md px-2 py-0.5 text-[11px] font-medium" onclick="event.stopPropagation();">' +
            escapeHtml(act.label) +
            '</a>';
        });
        actionsHtml += '</div>';
      }

      row.innerHTML =
        '<div class="flex items-center gap-3 min-w-0 flex-1">' +
        '  <div class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-base-200 text-base-content/70 group-hover:text-primary transition-colors">' +
        iconSvg +
        '  </div>' +
        '  <div class="min-w-0 flex-1">' +
        '    <div class="flex items-center gap-2">' +
        '      <span class="font-medium text-sm text-base-content truncate">' + titleHtml + '</span>' +
        badgeHtml +
        '    </div>' +
        '    <div class="text-xs text-base-content/50 truncate mt-0.5">' + escapeHtml(item.subtitle) + '</div>' +
        '  </div>' +
        '</div>' +
        '<div class="flex items-center gap-2 shrink-0">' +
        actionsHtml +
        '  <span class="js-enter-badge ' + (idx === 0 ? 'inline-flex' : 'hidden') + ' items-center rounded border border-base-300 bg-base-100 px-1.5 py-0.5 text-[10px] font-mono text-base-content/60 font-bold shadow-xs">↵</span>' +
        '</div>';

      row.addEventListener('click', function () {
        navigateTo(item.url);
      });

      row.addEventListener('mouseenter', function () {
        setSelectedIndex(idx);
      });

      resultsContainer.appendChild(row);
    });
  }

  function setSelectedIndex(newIdx) {
    if (!resultsContainer || currentResults.length === 0) return;
    if (newIdx < 0) newIdx = 0;
    if (newIdx >= currentResults.length) newIdx = currentResults.length - 1;

    selectedIndex = newIdx;
    var rows = resultsContainer.querySelectorAll('.search-result-item');
    rows.forEach(function (r, i) {
      var isSelected = i === selectedIndex;
      r.className =
        'search-result-item group flex items-center justify-between gap-3 p-2.5 rounded-xl cursor-pointer transition-all duration-100 ' +
        (isSelected ? 'bg-primary/10 border border-primary/20 shadow-xs' : 'hover:bg-base-200/70 border border-transparent');

      var enterBadge = r.querySelector('.js-enter-badge');
      if (enterBadge) {
        if (isSelected) enterBadge.classList.remove('hidden');
        else enterBadge.classList.add('hidden');
      }
    });

    // Ensure selected item is scrolled into view
    var activeRow = rows[selectedIndex];
    if (activeRow) {
      activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function navigateTo(url) {
    if (!url) return;
    closeSearch();
    window.location.href = url;
  }

  // ---- Keyboard Navigation -------------------------------------------------

  function onSearchKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(selectedIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(selectedIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (currentResults[selectedIndex]) {
        navigateTo(currentResults[selectedIndex].url);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // Cycle through categories
      var currentIdx = CATEGORIES.findIndex(function (c) { return c.id === activeCategory; });
      var nextIdx = e.shiftKey ? (currentIdx - 1 + CATEGORIES.length) % CATEGORIES.length : (currentIdx + 1) % CATEGORIES.length;
      setCategory(CATEGORIES[nextIdx].id);
    }
  }

  // Global hotkeys listener (Ctrl+K, Cmd+K, /)
  document.addEventListener('keydown', function (e) {
    var isCtrlK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';
    var isSlash = e.key === '/' && !isEditingElement(document.activeElement);

    if (isCtrlK || isSlash) {
      e.preventDefault();
      if (isPaletteOpen) {
        closeSearch();
      } else {
        openSearch();
      }
    }
  });

  function isEditingElement(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  // ---- DOM Ready Wireup ----------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    var triggerBtn = document.getElementById('global-search-trigger');
    if (triggerBtn) {
      triggerBtn.addEventListener('click', function () {
        openSearch();
      });
    }

    var sidebarSearchInput = document.getElementById('table-search');
    if (sidebarSearchInput) {
      sidebarSearchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          openSearch(sidebarSearchInput.value);
        }
      });
    }
  });

  window.GlobalSearch = {
    open: openSearch,
    close: closeSearch,
    setCategory: setCategory,
  };
})();
