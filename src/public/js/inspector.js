/* Rich Universal Data Inspector & Quick Peek Popover for AdminDB.
 *
 * Professional IDE-grade data inspector:
 *  - JSON Tree with syntax highlighting, search/filter, node expand/collapse, breadcrumb path, 1-click copy path.
 *  - JSON & Code Editor with live diagnostics, line numbers, beautify, minify, and validation.
 *  - BLOB & Media Previews:
 *     * Image: zoom, rotate, pan, transparent checkerboard background, dimensions.
 *     * Audio: HTML5 audio player.
 *     * Video: HTML5 video player.
 *     * PDF: embedded iframe previewer + download.
 *     * Hex Dump: 3-column synchronized byte-to-ASCII highlight & search.
 *     * File upload/replace & download.
 *  - Text & Code viewer with auto-detected syntax modes, word-wrap, char/word/line counters.
 *  - Center Modal, Docked Side Drawer, and Fullscreen modes.
 *  - Inline Quick Peek popovers.
 */
(function () {
  'use strict';

  const escapeHtml = window.Utils ? window.Utils.escapeHtml : function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  };

  const formatBytes = window.Utils ? window.Utils.formatBytes : function (b) {
    if (!b || b === 0) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const isJson = window.Utils ? window.Utils.isJson : function (s) {
    if (typeof s !== 'string') return false;
    var t = s.trim();
    if (!t || (!t.startsWith('{') && !t.startsWith('['))) return false;
    try { JSON.parse(t); return true; } catch (e) { return false; }
  };

  function isHexBlob(str) {
    if (window.Utils && window.Utils.isHexBlob) return window.Utils.isHexBlob(str);
    return typeof str === 'string' && (/^0x[0-9a-f]{4,}$/i.test(str.trim()) || /^\\x[0-9a-f]{4,}$/i.test(str.trim()));
  }

  // ---- SVG Icons -----------------------------------------------------------
  const SVG = {
    json: '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>',
    blob: '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 1.1.9 2 2 2h12a2 2 0 002-2V7M4 7c0-1.1.9-2 2-2h12a2 2 0 012 2M4 7c0 1.1.9 2 2 2h12a2 2 0 002-2"/></svg>',
    text: '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h7"/></svg>',
    tree: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h10M4 18h14"/></svg>',
    code: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>',
    search: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>',
    copy: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>',
    download: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>',
    upload: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>',
    chevronDown: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>',
    chevronRight: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>',
    close: '<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>',
    drawer: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path stroke-linecap="round" d="M15 3v18"/></svg>',
    modal: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
    fullscreen: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 0h-4m4 0l-5-5"/></svg>',
    check: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>',
    save: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"/></svg>',
    format: '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h10M4 18h14"/></svg>',
  };

  // ---- JSON Tree Renderer --------------------------------------------------

  function buildJsonTree(val, keyName, pathPrefix, searchQuery, onHoverPath) {
    var item = document.createElement('div');
    item.className = 'json-tree-row flex items-start gap-1 font-mono text-[13px] leading-relaxed py-0.5 px-2 rounded-lg transition-colors hover:bg-base-200/50 group/row select-text';

    var currentPath = pathPrefix !== undefined
      ? (keyName !== undefined ? (typeof keyName === 'number' || /^\d+$/.test(keyName) ? pathPrefix + '[' + keyName + ']' : (pathPrefix ? pathPrefix + '.' + keyName : keyName)) : pathPrefix)
      : (keyName !== undefined ? keyName : '$');

    item.dataset.path = currentPath;

    item.addEventListener('mouseenter', function (e) {
      e.stopPropagation();
      if (onHoverPath) onHoverPath(currentPath);
    });

    var keyHtml = keyName !== undefined
      ? '<span class="json-key text-sky-500 dark:text-sky-400 font-semibold select-text">' + highlightSearch(escapeHtml(String(keyName)), searchQuery) + '</span><span class="text-base-content/30 mx-1 select-none">:</span>'
      : '';

    var rowActions =
      '<div class="opacity-0 group-hover/row:opacity-100 transition-opacity flex items-center gap-1 ml-auto shrink-0 select-none pl-3">' +
      '  <button type="button" class="btn btn-ghost btn-xs h-5 min-h-0 px-1.5 text-[10px] font-mono text-base-content/50 hover:text-primary json-copy-path" data-path="' + escapeHtml(currentPath) + '" title="Copy JSON path">path</button>' +
      '</div>';

    if (val === null) {
      item.innerHTML = '<div class="flex items-center min-w-0">' + keyHtml + '<span class="chip chip-null text-[11px] font-semibold">null</span></div>' + rowActions;
      return item;
    }

    if (typeof val === 'boolean') {
      item.innerHTML = '<div class="flex items-center min-w-0">' + keyHtml + '<span class="text-purple-600 dark:text-purple-400 font-bold select-text">' + val + '</span></div>' + rowActions;
      return item;
    }

    if (typeof val === 'number') {
      item.innerHTML = '<div class="flex items-center min-w-0">' + keyHtml + '<span class="text-amber-600 dark:text-amber-400 font-medium select-text">' + val + '</span></div>' + rowActions;
      return item;
    }

    if (typeof val === 'string') {
      var highlightedStr = highlightSearch(escapeHtml(val), searchQuery);
      item.innerHTML = '<div class="flex items-start min-w-0 break-all">' + keyHtml + '<span class="text-emerald-600 dark:text-emerald-400 select-text">"' + highlightedStr + '"</span></div>' + rowActions;
      return item;
    }

    // Compound Objects & Arrays
    var isArr = Array.isArray(val);
    var keys = isArr ? val : Object.keys(val);
    var count = isArr ? val.length : keys.length;

    var container = document.createElement('div');
    container.className = 'json-tree-branch font-mono text-[13px] my-0.5';

    var header = document.createElement('div');
    header.className = 'json-tree-header flex items-center justify-between gap-1 py-0.5 px-2 rounded-lg transition-colors hover:bg-base-200/50 cursor-pointer select-none group/header';
    header.innerHTML =
      '<div class="flex items-center gap-1.5 min-w-0">' +
      '  <span class="json-toggle text-base-content/40 group-hover/header:text-base-content transition-transform text-[10px] w-3.5 text-center shrink-0">▼</span>' +
      '  ' + keyHtml +
      '  <span class="text-base-content/70 font-bold">' + (isArr ? '[' : '{') + '</span>' +
      '  <span class="text-[11px] text-base-content/40 font-sans tabular-nums ml-0.5">' + count + ' ' + (count === 1 ? (isArr ? 'item' : 'key') : (isArr ? 'items' : 'keys')) + '</span>' +
      '  <span class="text-base-content/70 font-bold json-collapsed-trailer hidden">' + (isArr ? ' ... ]' : ' ... }') + '</span>' +
      '</div>' +
      '<div class="opacity-0 group-hover/header:opacity-100 transition-opacity flex items-center gap-1 shrink-0">' +
      '  <button type="button" class="btn btn-ghost btn-xs h-5 min-h-0 px-1.5 text-[10px] font-mono text-base-content/50 hover:text-primary json-copy-path" data-path="' + escapeHtml(currentPath) + '" title="Copy JSON path">path</button>' +
      '</div>';

    header.addEventListener('mouseenter', function (e) {
      e.stopPropagation();
      if (onHoverPath) onHoverPath(currentPath);
    });

    var body = document.createElement('div');
    body.className = 'json-tree-body pl-4 ml-2 border-l border-base-300/80 dark:border-base-content/10 space-y-0.5';

    if (isArr) {
      val.forEach(function (child, idx) {
        body.appendChild(buildJsonTree(child, idx, currentPath, searchQuery, onHoverPath));
      });
    } else {
      keys.forEach(function (k) {
        body.appendChild(buildJsonTree(val[k], k, currentPath, searchQuery, onHoverPath));
      });
    }

    var closing = document.createElement('div');
    closing.className = 'json-tree-closing pl-2 text-base-content/70 font-bold select-none text-[13px]';
    closing.textContent = isArr ? ']' : '}';
    body.appendChild(closing);

    header.addEventListener('click', function (e) {
      if (e.target.closest('.json-copy-path')) return;
      var isHidden = body.classList.contains('hidden');
      body.classList.toggle('hidden', !isHidden);
      header.querySelector('.json-toggle').textContent = isHidden ? '▼' : '▶';
      var trailer = header.querySelector('.json-collapsed-trailer');
      if (trailer) trailer.classList.toggle('hidden', isHidden);
    });

    container.appendChild(header);
    container.appendChild(body);
    return container;
  }

  function highlightSearch(text, query) {
    if (!query || typeof query !== 'string' || !query.trim()) return text;
    var q = query.trim();
    var regex = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return text.replace(regex, '<mark class="bg-warning/30 text-warning-content rounded px-0.5 font-semibold">$1</mark>');
  }

  // ---- Client-side Hex Dump Generator --------------------------------------

  function generateClientHexDump(bytes, maxBytes) {
    maxBytes = maxBytes || 8192;
    var len = Math.min(bytes.length, maxBytes);
    var lines = [];
    for (var i = 0; i < len; i += 16) {
      var offset = ('00000000' + i.toString(16)).slice(-8);
      var hexArr = [];
      var asciiArr = [];
      for (var j = 0; j < 16; j++) {
        if (i + j < len) {
          var b = bytes[i + j];
          hexArr.push(('00' + b.toString(16)).slice(-2));
          asciiArr.push(b >= 32 && b <= 126 ? String.fromCharCode(b) : '.');
        } else {
          hexArr.push('  ');
          asciiArr.push(' ');
        }
      }
      var hexStr = hexArr.slice(0, 8).join(' ') + '  ' + hexArr.slice(8).join(' ');
      lines.push({ offset: offset, hex: hexStr, ascii: asciiArr.join('') });
    }
    return { lines: lines, totalBytes: bytes.length, truncated: bytes.length > maxBytes };
  }

  function hexToUint8Array(hex) {
    hex = hex.replace(/^0x/i, '').replace(/^\\x/i, '').replace(/\s+/g, '');
    var arr = new Uint8Array(Math.floor(hex.length / 2));
    for (var i = 0; i < hex.length - 1; i += 2) {
      arr[i / 2] = parseInt(hex.substring(i, i + 2), 16) || 0;
    }
    return arr;
  }

  // ---- Universal Inspector Modal & Drawer -----------------------------------

  function openInspector(opts) {
    opts = opts || {};
    var table = opts.table || '';
    var pk = opts.pk || '';
    var col = opts.col || opts.column || 'Value';
    var colType = (opts.colType || opts.type || '').toUpperCase();
    var val = opts.value;
    var isNull = opts.isNull || val === null || val === undefined;
    var readonly = !!opts.readonly;
    var onSave = opts.onSave;

    var valStr = isNull ? '' : String(val);
    var isBlob = opts.isBlob || colType.includes('BLOB') || isHexBlob(valStr) || opts.isImage || opts.isAudio || opts.isVideo || opts.isPdf;
    var isJsonVal = opts.isJson || isJson(valStr) || colType.includes('JSON');

    var initialTab = isJsonVal ? 'json' : (isBlob ? 'blob' : 'text');
    var isDrawer = opts.mode === 'drawer' || window.localStorage.getItem('admindb_inspector_mode') === 'drawer';
    var isFullscreen = false;

    // Overlay backdrop
    var overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[120] transition-opacity duration-200 opacity-0 ' +
      (isDrawer ? 'bg-black/40 backdrop-blur-xs flex justify-end pointer-events-auto' : 'bg-black/65 backdrop-blur-xs p-3 sm:p-5 flex items-center justify-center');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    // Main Card
    var card = document.createElement('div');
    card.className = 'app-card flex flex-col overflow-hidden shadow-2xl border border-base-300 transition-all duration-200 bg-base-100 ' +
      (isDrawer
        ? 'w-full max-w-xl h-full rounded-none sm:rounded-l-2xl border-r-0 transform translate-x-full'
        : 'w-full max-w-4xl max-h-[90vh] rounded-2xl transform scale-95');

    // 1. Sleek Header
    var header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-3 border-b border-base-200/80 px-5 py-3.5 bg-base-200/40 select-none';
    header.innerHTML =
      '<div class="flex items-center gap-3 min-w-0">' +
      '  <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary border border-primary/20" id="inspector-header-icon">' +
      (isBlob ? SVG.blob : (isJsonVal ? SVG.json : SVG.text)) +
      '  </div>' +
      '  <div class="min-w-0">' +
      '    <div class="flex items-center gap-2 flex-wrap">' +
      '      <span class="font-mono font-bold text-base text-base-content tracking-tight">' + escapeHtml(col) + '</span>' +
      '      <span class="chip chip-type text-[10px]">' + escapeHtml(colType || (isBlob ? 'BLOB' : (isJsonVal ? 'JSON' : 'TEXT'))) + '</span>' +
      (isNull ? '<span class="chip chip-null text-[10px]">NULL</span>' : '') +
      '    </div>' +
      '    <div class="flex items-center gap-1.5 text-xs text-base-content/50 truncate font-mono mt-0.5">' +
      (table ? '<span>' + escapeHtml(table) + '</span>' : '') +
      (pk ? '<span class="text-base-content/30">/</span><span class="text-base-content/70 font-semibold">PK ' + escapeHtml(pk) + '</span>' : '') +
      '    </div>' +
      '  </div>' +
      '</div>' +
      '<div class="flex items-center gap-1 shrink-0">' +
      '  <button type="button" id="btn-toggle-drawer" class="btn btn-ghost btn-xs btn-square text-base-content/50 hover:text-base-content" title="' + (isDrawer ? 'Switch to Center Modal' : 'Dock as Side Drawer') + '">' +
      (isDrawer ? SVG.modal : SVG.drawer) +
      '  </button>' +
      '  <button type="button" id="btn-toggle-fullscreen" class="btn btn-ghost btn-xs btn-square text-base-content/50 hover:text-base-content" title="Toggle Fullscreen">' + SVG.fullscreen + '</button>' +
      '  <div class="h-4 w-px bg-base-300 mx-1"></div>' +
      '  <button type="button" class="btn btn-ghost btn-xs btn-circle js-inspector-close text-base-content/40 hover:text-base-content" aria-label="Close">' + SVG.close + '</button>' +
      '</div>';
    card.appendChild(header);

    // 2. Tab Navigation & Action Bar
    var navBar = document.createElement('div');
    navBar.className = 'flex flex-wrap items-center justify-between gap-2 border-b border-base-200 bg-base-200/20 px-4 py-2 select-none';
    navBar.innerHTML =
      '<div class="flex items-center gap-1.5" id="inspector-tabs">' +
      '  <button type="button" data-tab="json" class="btn btn-xs ' + (initialTab === 'json' ? 'btn-primary' : 'btn-ghost') + ' gap-1.5 font-medium">' + SVG.json + 'JSON Tree</button>' +
      (isBlob || isHexBlob(valStr) ? '  <button type="button" data-tab="blob" class="btn btn-xs ' + (initialTab === 'blob' ? 'btn-primary' : 'btn-ghost') + ' gap-1.5 font-medium">' + SVG.blob + 'Media & Hex</button>' : '') +
      '  <button type="button" data-tab="text" class="btn btn-xs ' + (initialTab === 'text' ? 'btn-primary' : 'btn-ghost') + ' gap-1.5 font-medium">' + SVG.text + 'Raw Code</button>' +
      '</div>' +
      '<div class="flex items-center gap-2" id="inspector-top-actions"></div>';
    card.appendChild(navBar);

    // 3. Content Body
    var body = document.createElement('div');
    body.className = 'flex-1 overflow-y-auto p-4 space-y-3 min-h-[360px] bg-base-100';
    card.appendChild(body);

    // 4. Status Bar & Footer
    var footer = document.createElement('div');
    footer.className = 'flex flex-wrap items-center justify-between gap-3 border-t border-base-200 bg-base-200/30 px-4 py-2.5 select-none';
    footer.innerHTML =
      '<div class="flex items-center gap-3 text-xs font-mono text-base-content/50 min-w-0" id="inspector-status-bar">' +
      '  <span id="tab-meta" class="truncate"></span>' +
      '  <span id="breadcrumb-path" class="text-primary/70 font-semibold truncate hidden"></span>' +
      '</div>' +
      '<div class="flex items-center gap-2 shrink-0">' +
      '  <div id="inspector-left-actions" class="flex items-center gap-1.5"></div>' +
      '  <button type="button" class="btn btn-ghost btn-sm text-xs js-inspector-close">Close</button>' +
      (!readonly ? '  <button type="button" id="inspector-save-btn" class="btn btn-primary btn-sm gap-1.5 text-xs font-semibold">' + SVG.save + 'Save Changes</button>' : '') +
      '</div>';
    card.appendChild(footer);

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    requestAnimationFrame(function () {
      overlay.classList.remove('opacity-0');
      overlay.classList.add('opacity-100');
      if (isDrawer) {
        card.classList.remove('translate-x-full');
      } else {
        card.classList.remove('scale-95');
        card.classList.add('scale-100');
      }
    });

    var tabMeta = card.querySelector('#tab-meta');
    var breadcrumbPath = card.querySelector('#breadcrumb-path');
    var topActions = card.querySelector('#inspector-top-actions');
    var leftActions = card.querySelector('#inspector-left-actions');
    var saveBtn = card.querySelector('#inspector-save-btn');
    var headerIcon = card.querySelector('#inspector-header-icon');

    var currentVal = valStr;
    var currentTab = initialTab;

    function applyViewMode() {
      if (isFullscreen) {
        card.className = 'app-card flex flex-col w-screen h-screen rounded-none overflow-hidden shadow-2xl border-0 bg-base-100 fixed inset-0 z-[130]';
      } else if (isDrawer) {
        card.className = 'app-card flex flex-col w-full max-w-xl h-full rounded-none sm:rounded-l-2xl border-r-0 overflow-hidden shadow-2xl border border-base-300 bg-base-100';
        overlay.className = 'fixed inset-0 z-[120] bg-black/40 backdrop-blur-xs flex justify-end pointer-events-auto transition-opacity duration-200 opacity-100';
      } else {
        card.className = 'app-card flex flex-col w-full max-w-4xl max-h-[90vh] rounded-2xl overflow-hidden shadow-2xl border border-base-300 bg-base-100';
        overlay.className = 'fixed inset-0 z-[120] bg-black/65 backdrop-blur-xs p-3 sm:p-5 flex items-center justify-center transition-opacity duration-200 opacity-100';
      }
      var toggleDrawerBtn = card.querySelector('#btn-toggle-drawer');
      if (toggleDrawerBtn) toggleDrawerBtn.innerHTML = isDrawer ? SVG.modal : SVG.drawer;
    }

    card.querySelector('#btn-toggle-drawer').addEventListener('click', function () {
      isDrawer = !isDrawer;
      isFullscreen = false;
      window.localStorage.setItem('admindb_inspector_mode', isDrawer ? 'drawer' : 'modal');
      applyViewMode();
    });

    card.querySelector('#btn-toggle-fullscreen').addEventListener('click', function () {
      isFullscreen = !isFullscreen;
      applyViewMode();
    });

    // Delegate copy path
    card.addEventListener('click', function (e) {
      var btn = e.target.closest('.json-copy-path');
      if (!btn) return;
      var path = btn.dataset.path;
      if (path) {
        navigator.clipboard.writeText(path).then(function () {
          if (window.UI && window.UI.showToast) window.UI.showToast('Copied path: ' + path, 'info');
        });
      }
    });

    // ---- Render JSON Tab ----------------------------------------------------

    function renderJsonTab() {
      body.innerHTML = '';
      topActions.innerHTML = '';
      leftActions.innerHTML = '';
      tabMeta.textContent = '';
      breadcrumbPath.textContent = '';
      breadcrumbPath.classList.add('hidden');
      if (headerIcon) headerIcon.innerHTML = SVG.json;

      var parsedObj = null;
      var isParsed = false;
      try {
        parsedObj = JSON.parse(currentVal);
        isParsed = true;
      } catch (e) {
        isParsed = false;
      }

      if (!isParsed) {
        body.innerHTML =
          '<div class="alert alert-warning text-xs p-3 rounded-xl">' +
          '  <span>Content is not valid JSON. You can edit it in Raw Code tab.</span>' +
          '</div>' +
          '<textarea id="json-raw-input" class="field-input font-mono text-[13px] h-80 w-full resize-none p-3 leading-relaxed" spellcheck="false">' + escapeHtml(currentVal) + '</textarea>';
        var ta = body.querySelector('#json-raw-input');
        ta.addEventListener('input', function () {
          currentVal = ta.value;
          try {
            JSON.parse(currentVal);
            if (saveBtn) saveBtn.disabled = false;
          } catch (e) {
            if (saveBtn) saveBtn.disabled = true;
          }
        });
        return;
      }

      var byteSize = new Blob([currentVal]).size;
      tabMeta.textContent = formatBytes(byteSize);

      // Top action controls
      topActions.innerHTML =
        '<div class="flex items-center gap-1.5">' +
        '  <div class="relative flex items-center">' +
        '    <input type="text" id="json-tree-search" placeholder="Filter keys/values…" class="field-input !py-1 !pl-7 !pr-2 !text-xs !w-40 font-mono" />' +
        '    <span class="absolute left-2 text-base-content/40 pointer-events-none">' + SVG.search + '</span>' +
        '  </div>' +
        '  <div class="join border border-base-300 rounded-lg overflow-hidden bg-base-200/50">' +
        '    <button type="button" id="btn-view-tree" class="btn btn-xs btn-primary join-item px-2.5 font-medium">Tree</button>' +
        '    <button type="button" id="btn-view-code" class="btn btn-xs btn-ghost join-item px-2.5 font-medium">Editor</button>' +
        '  </div>' +
        '  <div class="dropdown dropdown-end">' +
        '    <button type="button" tabindex="0" class="btn btn-ghost btn-xs btn-square text-base-content/60" title="More Tools">•••</button>' +
        '    <ul tabindex="0" class="dropdown-content menu p-1.5 shadow-xl bg-base-100 border border-base-300 rounded-xl w-44 z-50 text-xs mt-1 space-y-0.5">' +
        '      <li><button type="button" id="btn-expand-all" class="flex items-center gap-2">Expand All</button></li>' +
        '      <li><button type="button" id="btn-collapse-all" class="flex items-center gap-2">Collapse All</button></li>' +
        '      <li class="border-t border-base-200 my-1"></li>' +
        '      <li><button type="button" id="btn-prettify-json" class="flex items-center gap-2">Prettify (2 spaces)</button></li>' +
        '      <li><button type="button" id="btn-minify-json" class="flex items-center gap-2">Minify</button></li>' +
        '      <li><button type="button" id="btn-copy-json" class="flex items-center gap-2">Copy JSON</button></li>' +
        '    </ul>' +
        '  </div>' +
        '</div>';

      // Tree View Container
      var treeWrap = document.createElement('div');
      treeWrap.className = 'rounded-xl border border-base-300 bg-base-200/30 p-3 max-h-[440px] overflow-y-auto';
      var treeRoot = buildJsonTree(parsedObj, undefined, '', '', function (p) {
        breadcrumbPath.textContent = p;
        breadcrumbPath.classList.remove('hidden');
      });
      treeWrap.appendChild(treeRoot);
      body.appendChild(treeWrap);

      // Code Editor Container
      var editorWrap = document.createElement('div');
      editorWrap.className = 'hidden space-y-2';
      editorWrap.innerHTML =
        '<textarea id="json-editor-ta" class="field-input font-mono text-[13px] h-96 w-full resize-none p-3.5 leading-relaxed bg-base-200/20" spellcheck="false">' +
        escapeHtml(JSON.stringify(parsedObj, null, 2)) +
        '</textarea>' +
        '<div class="flex items-center justify-between text-xs">' +
        '  <div id="json-validation-msg" class="font-medium text-success flex items-center gap-1.5">' + SVG.check + ' Valid JSON</div>' +
        '  <div class="text-base-content/40 font-mono" id="json-char-stats"></div>' +
        '</div>';
      body.appendChild(editorWrap);

      // Wire Sub-views
      var treeBtn = topActions.querySelector('#btn-view-tree');
      var codeBtn = topActions.querySelector('#btn-view-code');
      var searchInput = topActions.querySelector('#json-tree-search');
      var editorTa = editorWrap.querySelector('#json-editor-ta');
      var validMsg = editorWrap.querySelector('#json-validation-msg');
      var charStats = editorWrap.querySelector('#json-char-stats');

      function updateStats() {
        if (charStats) {
          charStats.textContent = editorTa.value.length + ' chars · ' + editorTa.value.split('\n').length + ' lines';
        }
      }
      updateStats();

      function setSubView(view) {
        if (view === 'tree') {
          treeBtn.className = 'btn btn-xs btn-primary join-item px-2.5 font-medium';
          codeBtn.className = 'btn btn-xs btn-ghost join-item px-2.5 font-medium';
          treeWrap.classList.remove('hidden');
          editorWrap.classList.add('hidden');
        } else {
          codeBtn.className = 'btn btn-xs btn-primary join-item px-2.5 font-medium';
          treeBtn.className = 'btn btn-xs btn-ghost join-item px-2.5 font-medium';
          treeWrap.classList.add('hidden');
          editorWrap.classList.remove('hidden');
        }
      }

      treeBtn.addEventListener('click', function () { setSubView('tree'); });
      codeBtn.addEventListener('click', function () { setSubView('code'); });

      // Realtime search
      var searchTimer = null;
      searchInput.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          var q = searchInput.value.trim();
          treeWrap.innerHTML = '';
          var newRoot = buildJsonTree(parsedObj, undefined, '', q, function (p) {
            breadcrumbPath.textContent = p;
            breadcrumbPath.classList.remove('hidden');
          });
          treeWrap.appendChild(newRoot);
        }, 120);
      });

      // Actions in dropdown
      topActions.querySelector('#btn-expand-all').addEventListener('click', function () {
        treeWrap.querySelectorAll('.json-tree-body').forEach(function (el) { el.classList.remove('hidden'); });
        treeWrap.querySelectorAll('.json-toggle').forEach(function (btn) { btn.textContent = '▼'; });
        treeWrap.querySelectorAll('.json-collapsed-trailer').forEach(function (el) { el.classList.add('hidden'); });
      });

      topActions.querySelector('#btn-collapse-all').addEventListener('click', function () {
        treeWrap.querySelectorAll('.json-tree-body').forEach(function (el) { el.classList.add('hidden'); });
        treeWrap.querySelectorAll('.json-toggle').forEach(function (btn) { btn.textContent = '▶'; });
        treeWrap.querySelectorAll('.json-collapsed-trailer').forEach(function (el) { el.classList.remove('hidden'); });
      });

      topActions.querySelector('#btn-prettify-json').addEventListener('click', function () {
        var raw = editorTa.value || currentVal;
        try {
          var p = JSON.parse(raw);
          parsedObj = p;
          currentVal = JSON.stringify(p, null, 2);
          editorTa.value = currentVal;
          treeWrap.innerHTML = '';
          treeWrap.appendChild(buildJsonTree(p, undefined, '', '', function (path) {
            breadcrumbPath.textContent = path;
            breadcrumbPath.classList.remove('hidden');
          }));
          validMsg.className = 'font-medium text-success flex items-center gap-1.5';
          validMsg.innerHTML = SVG.check + ' Beautified valid JSON';
          updateStats();
          if (saveBtn) saveBtn.disabled = false;
          if (window.UI && window.UI.showToast) window.UI.showToast('JSON beautified.', 'success');
        } catch (e) {
          validMsg.className = 'font-medium text-error flex items-center gap-1.5';
          validMsg.textContent = 'Syntax Error: ' + e.message;
        }
      });

      topActions.querySelector('#btn-minify-json').addEventListener('click', function () {
        var raw = editorTa.value || currentVal;
        try {
          var p = JSON.parse(raw);
          parsedObj = p;
          currentVal = JSON.stringify(p);
          editorTa.value = currentVal;
          treeWrap.innerHTML = '';
          treeWrap.appendChild(buildJsonTree(p, undefined, '', '', function (path) {
            breadcrumbPath.textContent = path;
            breadcrumbPath.classList.remove('hidden');
          }));
          validMsg.className = 'font-medium text-success flex items-center gap-1.5';
          validMsg.innerHTML = SVG.check + ' Minified valid JSON';
          updateStats();
          if (saveBtn) saveBtn.disabled = false;
          if (window.UI && window.UI.showToast) window.UI.showToast('JSON minified.', 'success');
        } catch (e) {
          validMsg.className = 'font-medium text-error flex items-center gap-1.5';
          validMsg.textContent = 'Syntax Error: ' + e.message;
        }
      });

      topActions.querySelector('#btn-copy-json').addEventListener('click', function () {
        var raw = editorTa.value || currentVal;
        navigator.clipboard.writeText(raw).then(function () {
          if (window.UI && window.UI.showToast) window.UI.showToast('JSON copied to clipboard.', 'success');
        });
      });

      editorTa.addEventListener('input', function () {
        currentVal = editorTa.value;
        updateStats();
        try {
          parsedObj = JSON.parse(currentVal);
          validMsg.className = 'font-medium text-success flex items-center gap-1.5';
          validMsg.innerHTML = SVG.check + ' Valid JSON';
          treeWrap.innerHTML = '';
          treeWrap.appendChild(buildJsonTree(parsedObj, undefined, '', '', function (path) {
            breadcrumbPath.textContent = path;
            breadcrumbPath.classList.remove('hidden');
          }));
          if (saveBtn) saveBtn.disabled = false;
        } catch (e) {
          validMsg.className = 'font-medium text-error flex items-center gap-1.5';
          validMsg.textContent = 'Syntax Error: ' + e.message;
          if (saveBtn) saveBtn.disabled = true;
        }
      });
    }

    // ---- Render BLOB / Media Tab -------------------------------------------

    function renderBlobTab() {
      body.innerHTML = '<div class="py-16 text-center text-sm text-base-content/40 font-mono flex flex-col items-center justify-center gap-2"><span class="loading loading-spinner loading-md text-primary"></span><span>Loading binary content & metadata…</span></div>';
      topActions.innerHTML = '';
      leftActions.innerHTML = '';
      tabMeta.textContent = '';
      breadcrumbPath.textContent = '';
      breadcrumbPath.classList.add('hidden');
      if (headerIcon) headerIcon.innerHTML = SVG.blob;

      var dbId = encodeURIComponent(opts.dbId || (window.APP && window.APP.dbId) || '');
      var blobEndpoint = (window.APP && window.APP.basePath || '') + (dbId ? '/api/tables/' + dbId + '/' : '/api/tables/') + encodeURIComponent(table) + '/row/' + encodeURIComponent(pk) + '/blob/' + encodeURIComponent(col);

      var fetchPromise = table && pk && window.Api
        ? Api.get(blobEndpoint + '/meta')
        : Promise.resolve({
            data: {
              mime: 'application/octet-stream',
              ext: 'bin',
              size: Math.floor(valStr.length / 2),
              sizeFormatted: formatBytes(Math.floor(valStr.length / 2)),
              hexDump: generateClientHexDump(hexToUint8Array(valStr)),
            }
          });

      fetchPromise
        .then(function (res) {
          var meta = res.data || {};
          tabMeta.textContent = (meta.mime || 'BLOB') + ' · ' + (meta.sizeFormatted || '0 B');
          body.innerHTML = '';

          var container = document.createElement('div');
          container.className = 'space-y-4';

          // Image preview
          if (meta.isImage) {
            var imgWrap = document.createElement('div');
            imgWrap.className = 'flex flex-col items-center justify-center p-4 rounded-2xl border border-base-300 bg-base-200/40 relative overflow-hidden';
            imgWrap.innerHTML =
              '<div class="flex items-center justify-between w-full mb-3 pb-2 border-b border-base-200/60 px-2">' +
              '  <span class="text-xs font-mono font-semibold text-base-content/70">Image Preview (' + escapeHtml(meta.ext.toUpperCase()) + ')</span>' +
              '  <div class="flex items-center gap-1">' +
              '    <button type="button" id="btn-img-zoom-in" class="btn btn-ghost btn-xs font-mono" title="Zoom In">+</button>' +
              '    <button type="button" id="btn-img-zoom-out" class="btn btn-ghost btn-xs font-mono" title="Zoom Out">-</button>' +
              '    <button type="button" id="btn-img-rotate" class="btn btn-ghost btn-xs" title="Rotate 90°">Rotate</button>' +
              '    <button type="button" id="btn-img-reset" class="btn btn-ghost btn-xs" title="Reset View">Reset</button>' +
              '  </div>' +
              '</div>' +
              '<div class="relative flex items-center justify-center max-w-full max-h-[340px] overflow-auto rounded-xl p-3 bg-[radial-gradient(#8881_1px,transparent_1px)] [background-size:16px_16px] border border-base-300/60">' +
              '  <img src="' + blobEndpoint + '" alt="' + escapeHtml(col) + '" class="max-h-[300px] max-w-full object-contain rounded-lg shadow-sm transition-transform duration-150" id="blob-preview-img" />' +
              '</div>';
            container.appendChild(imgWrap);

            var zoomLevel = 1;
            var rotation = 0;
            var imgEl = imgWrap.querySelector('#blob-preview-img');
            function updateImgTransform() {
              imgEl.style.transform = 'scale(' + zoomLevel + ') rotate(' + rotation + 'deg)';
            }
            imgWrap.querySelector('#btn-img-zoom-in').addEventListener('click', function () { zoomLevel = Math.min(zoomLevel + 0.25, 4); updateImgTransform(); });
            imgWrap.querySelector('#btn-img-zoom-out').addEventListener('click', function () { zoomLevel = Math.max(zoomLevel - 0.25, 0.25); updateImgTransform(); });
            imgWrap.querySelector('#btn-img-rotate').addEventListener('click', function () { rotation = (rotation + 90) % 360; updateImgTransform(); });
            imgWrap.querySelector('#btn-img-reset').addEventListener('click', function () { zoomLevel = 1; rotation = 0; updateImgTransform(); });
          }

          // Audio
          else if (meta.isAudio) {
            var audioWrap = document.createElement('div');
            audioWrap.className = 'flex flex-col items-center justify-center p-6 rounded-2xl border border-base-300 bg-base-200/40 space-y-3';
            audioWrap.innerHTML =
              '<h4 class="text-sm font-semibold text-base-content">Audio Stream · ' + escapeHtml(meta.ext.toUpperCase()) + '</h4>' +
              '<audio controls class="w-full max-w-md shadow-xs rounded-xl" preload="metadata">' +
              '  <source src="' + blobEndpoint + '" type="' + escapeHtml(meta.mime) + '">' +
              '</audio>';
            container.appendChild(audioWrap);
          }

          // Video
          else if (meta.isVideo) {
            var videoWrap = document.createElement('div');
            videoWrap.className = 'flex flex-col items-center justify-center p-4 rounded-2xl border border-base-300 bg-base-200/40 space-y-3';
            videoWrap.innerHTML =
              '<video controls class="max-h-[300px] max-w-full rounded-xl shadow-md bg-black" preload="metadata">' +
              '  <source src="' + blobEndpoint + '" type="' + escapeHtml(meta.mime) + '">' +
              '</video>';
            container.appendChild(videoWrap);
          }

          // PDF
          else if (meta.isPdf) {
            var pdfWrap = document.createElement('div');
            pdfWrap.className = 'space-y-3 rounded-2xl border border-base-300 bg-base-200/40 p-4';
            pdfWrap.innerHTML = '<iframe src="' + blobEndpoint + '#toolbar=0" class="w-full h-80 rounded-xl border border-base-300 bg-white" title="PDF"></iframe>';
            container.appendChild(pdfWrap);
          }

          // 3-Column Hex Dump
          var hexWrap = document.createElement('div');
          hexWrap.className = 'space-y-2';

          var hexHeader = document.createElement('div');
          hexHeader.className = 'flex flex-wrap items-center justify-between gap-2';
          hexHeader.innerHTML =
            '<div class="flex items-center gap-2">' +
            '  <span class="text-xs font-semibold uppercase tracking-wider text-base-content/60 font-mono">Hex Dump</span>' +
            '  <input type="text" id="hex-search-input" placeholder="Search hex/ASCII…" class="field-input !py-0.5 !px-2 !text-xs !w-36 font-mono" />' +
            '</div>' +
            '<div class="flex items-center gap-1.5">' +
            '  <button type="button" id="btn-copy-hex-raw" class="btn btn-ghost btn-xs font-mono">Copy Hex</button>' +
            '  <button type="button" id="btn-copy-ascii" class="btn btn-ghost btn-xs font-mono">Copy ASCII</button>' +
            '</div>';
          hexWrap.appendChild(hexHeader);

          var hexPre = document.createElement('div');
          hexPre.className = 'overflow-x-auto rounded-xl border border-base-300 bg-neutral p-3.5 font-mono text-xs leading-relaxed text-neutral-content max-h-[320px] select-text shadow-inner';

          var hexDump = meta.hexDump;
          if (hexDump && hexDump.lines && hexDump.lines.length) {
            var linesHtml = hexDump.lines.map(function (line, lineIdx) {
              return '<div class="hex-line grid grid-cols-[80px_1fr_160px] gap-3 hover:bg-white/[0.08] px-1 rounded transition-colors" data-line-idx="' + lineIdx + '">' +
                '<span class="text-primary/70 select-none font-bold">' + line.offset + '</span>' +
                '<span class="text-accent/90 hex-bytes">' + escapeHtml(line.hex) + '</span>' +
                '<span class="text-neutral-content/75 border-l border-white/15 pl-2.5 ascii-text truncate">' + escapeHtml(line.ascii) + '</span>' +
                '</div>';
            }).join('');
            hexPre.innerHTML = linesHtml;
          } else {
            hexPre.innerHTML = '<div class="text-center text-neutral-content/40 py-6">No binary content available</div>';
          }
          hexWrap.appendChild(hexPre);
          container.appendChild(hexWrap);

          body.appendChild(container);

          // Hex search
          var hexSearchInput = hexHeader.querySelector('#hex-search-input');
          hexSearchInput.addEventListener('input', function () {
            var term = hexSearchInput.value.trim().toLowerCase();
            hexPre.querySelectorAll('.hex-line').forEach(function (row) {
              if (!term) {
                row.classList.remove('bg-warning/20', 'hidden');
              } else {
                var text = row.textContent.toLowerCase();
                if (text.includes(term)) {
                  row.classList.remove('hidden');
                  row.classList.add('bg-warning/20');
                } else {
                  row.classList.remove('bg-warning/20');
                  row.classList.add('hidden');
                }
              }
            });
          });

          // Download & Upload in footer actions
          if (table && pk) {
            leftActions.innerHTML =
              '<a href="' + blobEndpoint + '?download=1" class="btn btn-outline btn-xs gap-1 font-medium">' +
              SVG.download + ' Download' +
              '</a>' +
              (!readonly ?
                '<label class="btn btn-outline btn-xs gap-1 cursor-pointer font-medium hover:border-primary">' +
                SVG.upload + ' Replace' +
                '  <input type="file" id="blob-file-upload-input" class="hidden" />' +
                '</label>' : '');

            var uploadInput = leftActions.querySelector('#blob-file-upload-input');
            if (uploadInput) {
              uploadInput.addEventListener('change', function (e) {
                var file = e.target.files && e.target.files[0];
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function () {
                  Api.put(blobEndpoint, { data: reader.result, format: 'base64' })
                    .then(function () {
                      if (window.UI && window.UI.showToast) window.UI.showToast('BLOB updated successfully.', 'success');
                      renderBlobTab();
                      if (onSave) onSave('0x...');
                    })
                    .catch(function (err) {
                      if (window.UI && window.UI.showError) window.UI.showError(err.message);
                    });
                };
                reader.readAsDataURL(file);
              });
            }
          }
        })
        .catch(function (err) {
          body.innerHTML = '<div class="alert alert-error text-xs p-3">Failed to load binary metadata: ' + escapeHtml(err.message) + '</div>';
        });
    }

    // ---- Render Text & Code Tab ---------------------------------------------

    function renderTextTab() {
      body.innerHTML = '';
      topActions.innerHTML = '';
      leftActions.innerHTML = '';
      breadcrumbPath.textContent = '';
      breadcrumbPath.classList.add('hidden');
      if (headerIcon) headerIcon.innerHTML = SVG.text;

      var isWrap = true;

      function updateStats() {
        var lines = currentVal.split('\n').length;
        var words = currentVal.trim() ? currentVal.trim().split(/\s+/).length : 0;
        var chars = currentVal.length;
        tabMeta.textContent = chars + ' chars · ' + words + ' words · ' + lines + ' lines (' + formatBytes(new Blob([currentVal]).size) + ')';
      }
      updateStats();

      topActions.innerHTML =
        '<div class="flex items-center gap-2">' +
        '  <label class="flex items-center gap-1.5 text-xs text-base-content/60 cursor-pointer">' +
        '    <input type="checkbox" id="text-word-wrap-toggle" class="checkbox checkbox-xs checkbox-primary" checked />' +
        '    <span>Word Wrap</span>' +
        '  </label>' +
        '  <button type="button" id="btn-copy-raw-text" class="btn btn-ghost btn-xs gap-1 font-mono">' + SVG.copy + 'Copy</button>' +
        '</div>';

      var textarea = document.createElement('textarea');
      textarea.className = 'field-input font-mono text-[13px] h-96 w-full resize-none p-3.5 leading-relaxed ' + (isWrap ? 'whitespace-pre-wrap' : 'whitespace-pre overflow-x-auto');
      textarea.spellcheck = false;
      textarea.value = currentVal;
      if (readonly) textarea.readOnly = true;

      textarea.addEventListener('input', function () {
        currentVal = textarea.value;
        updateStats();
        if (saveBtn) saveBtn.disabled = false;
      });

      body.appendChild(textarea);

      topActions.querySelector('#text-word-wrap-toggle').addEventListener('change', function (e) {
        isWrap = e.target.checked;
        textarea.className = 'field-input font-mono text-[13px] h-96 w-full resize-none p-3.5 leading-relaxed ' + (isWrap ? 'whitespace-pre-wrap' : 'whitespace-pre overflow-x-auto');
      });

      topActions.querySelector('#btn-copy-raw-text').addEventListener('click', function () {
        navigator.clipboard.writeText(currentVal).then(function () {
          if (window.UI && window.UI.showToast) window.UI.showToast('Text copied to clipboard.', 'success');
        });
      });
    }

    // Tab Switching
    function switchTab(tab) {
      currentTab = tab;
      navBar.querySelectorAll('#inspector-tabs button').forEach(function (btn) {
        var active = btn.dataset.tab === tab;
        btn.className = 'btn btn-xs ' + (active ? 'btn-primary' : 'btn-ghost') + ' gap-1.5 font-medium';
      });
      if (tab === 'json') renderJsonTab();
      else if (tab === 'blob') renderBlobTab();
      else renderTextTab();
    }

    navBar.querySelectorAll('#inspector-tabs button').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
    });

    switchTab(initialTab);

    // Close
    function close() {
      overlay.classList.remove('opacity-100');
      overlay.classList.add('opacity-0');
      if (isDrawer) {
        card.classList.add('translate-x-full');
      } else {
        card.classList.remove('scale-100');
        card.classList.add('scale-95');
      }
      setTimeout(function () {
        overlay.remove();
        document.removeEventListener('keydown', keydownHandler);
      }, 180);
    }

    card.querySelectorAll('.js-inspector-close').forEach(function (btn) {
      btn.addEventListener('click', close);
    });

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    function keydownHandler(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (saveBtn && !saveBtn.disabled && onSave) {
          onSave(currentVal);
          close();
        }
      }
    }
    document.addEventListener('keydown', keydownHandler);

    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        if (onSave) onSave(currentVal);
        close();
      });
    }
  }

  // ---- Inline Quick Peek Popover -------------------------------------------

  var activePeekPopover = null;
  var peekHoverTimer = null;

  function closePeekPopover() {
    clearTimeout(peekHoverTimer);
    if (activePeekPopover) {
      activePeekPopover.remove();
      activePeekPopover = null;
    }
  }

  function showPeekPopover(targetEl, opts) {
    closePeekPopover();
    opts = opts || {};
    var val = opts.value;
    var col = opts.col || opts.column || 'Value';
    var isBlob = !!opts.isBlob;
    var isImage = !!opts.isImage;
    var isAudio = !!opts.isAudio;
    var blobUrl = opts.blobUrl || '';
    var isJsonVal = !!opts.isJson || isJson(String(val));
    var valStr = val == null ? '' : String(val);

    var popover = document.createElement('div');
    popover.className = 'fixed z-[110] w-80 max-w-sm rounded-2xl border border-base-300 bg-base-100/95 backdrop-blur-md shadow-2xl p-3.5 space-y-2.5 transform transition-all duration-150 animate-in fade-in zoom-in-95';

    var popHeader = document.createElement('div');
    popHeader.className = 'flex items-center justify-between gap-2 border-b border-base-200/80 pb-2 select-none';
    popHeader.innerHTML =
      '<div class="flex items-center gap-1.5 min-w-0">' +
      '  <span class="text-xs font-bold font-mono text-primary truncate">' + escapeHtml(col) + '</span>' +
      (isBlob ? '<span class="chip chip-type text-[9px]">BLOB</span>' : (isJsonVal ? '<span class="chip chip-type text-[9px]">JSON</span>' : '')) +
      '</div>' +
      '<div class="flex items-center gap-1">' +
      '  <button type="button" class="btn btn-ghost btn-xs btn-circle js-peek-copy text-base-content/50 hover:text-base-content" title="Copy value">' + SVG.copy + '</button>' +
      '  <button type="button" class="btn btn-ghost btn-xs btn-circle js-peek-open text-base-content/50 hover:text-base-content" title="Open in Inspector">↗</button>' +
      '  <button type="button" class="btn btn-ghost btn-xs btn-circle js-peek-close text-base-content/40 hover:text-base-content">' + SVG.close + '</button>' +
      '</div>';
    popover.appendChild(popHeader);

    var popBody = document.createElement('div');
    popBody.className = 'text-xs max-h-48 overflow-y-auto font-mono select-text';

    if (isImage && blobUrl) {
      popBody.innerHTML = '<div class="flex items-center justify-center bg-base-200/40 rounded-xl p-2"><img src="' + blobUrl + '" class="max-h-36 max-w-full rounded object-contain shadow-xs" alt="" /></div>';
    } else if (isAudio && blobUrl) {
      popBody.innerHTML = '<div class="flex flex-col items-center justify-center p-2 bg-base-200/40 rounded-xl"><audio controls class="w-full max-w-xs" src="' + blobUrl + '"></audio></div>';
    } else if (isJsonVal) {
      try {
        var parsed = JSON.parse(valStr);
        popBody.innerHTML = '<pre class="text-[11px] leading-relaxed text-base-content/85 whitespace-pre-wrap break-all bg-base-200/40 p-2.5 rounded-xl border border-base-300/40">' + escapeHtml(JSON.stringify(parsed, null, 2)) + '</pre>';
      } catch (e) {
        popBody.innerHTML = '<pre class="text-[11px] leading-relaxed text-base-content/80 whitespace-pre-wrap break-all">' + escapeHtml(valStr) + '</pre>';
      }
    } else {
      popBody.innerHTML = '<pre class="text-[11px] leading-relaxed text-base-content/80 whitespace-pre-wrap break-all bg-base-200/30 p-2.5 rounded-xl border border-base-300/40">' + escapeHtml(valStr) + '</pre>';
    }
    popover.appendChild(popBody);

    document.body.appendChild(popover);
    activePeekPopover = popover;

    var rect = targetEl.getBoundingClientRect();
    var top = rect.bottom + 6;
    var left = rect.left;
    if (left + 320 > window.innerWidth) left = window.innerWidth - 330;
    if (left < 10) left = 10;
    if (top + 200 > window.innerHeight) top = rect.top - 210;
    if (top < 10) top = 10;

    popover.style.top = top + 'px';
    popover.style.left = left + 'px';

    popover.querySelector('.js-peek-copy').addEventListener('click', function (e) {
      e.stopPropagation();
      navigator.clipboard.writeText(valStr).then(function () {
        if (window.UI && window.UI.showToast) window.UI.showToast('Copied to clipboard.', 'info');
      });
    });

    popover.querySelector('.js-peek-open').addEventListener('click', function (e) {
      e.stopPropagation();
      closePeekPopover();
      openInspector(opts);
    });

    popover.querySelector('.js-peek-close').addEventListener('click', function (e) {
      e.stopPropagation();
      closePeekPopover();
    });

    popover.addEventListener('mouseleave', function () {
      closePeekPopover();
    });
  }

  document.addEventListener('click', function (e) {
    if (activePeekPopover && !activePeekPopover.contains(e.target)) {
      closePeekPopover();
    }
  });

  window.Inspector = {
    open: openInspector,
    peek: showPeekPopover,
    closePeek: closePeekPopover,
  };
})();
