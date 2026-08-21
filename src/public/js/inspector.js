/* Rich Universal Data Inspector Modal for AdminDB.
 * Provides specialized JSON Tree/Editor, BLOB Media Preview, 3-Column Hex Dump,
 * and Code/Text inspectors with real-time editing, formatting, and file upload/download.
 */
(function () {
  'use strict';

  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function isJson(str) {
    if (typeof str !== 'string') return false;
    var t = str.trim();
    if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return false;
    try {
      JSON.parse(t);
      return true;
    } catch (e) {
      return false;
    }
  }

  function isHexBlob(str) {
    return typeof str === 'string' && /^0x[0-9a-f]{4,}$/i.test(str.trim());
  }

  // ---- JSON Tree Renderer --------------------------------------------------

  function buildJsonTree(val, keyName, isRoot) {
    var item = document.createElement('div');
    item.className = 'json-tree-node font-mono text-[13px] leading-relaxed my-0.5';

    var keyLabel = keyName !== undefined
      ? '<span class="json-key text-primary font-semibold select-text">' + escapeHtml(keyName) + '</span><span class="text-base-content/40 mr-1.5">:</span>'
      : '';

    if (val === null) {
      item.innerHTML = keyLabel + '<span class="chip chip-null text-xs font-bold">null</span>';
      return item;
    }

    if (typeof val === 'boolean') {
      item.innerHTML = keyLabel + '<span class="text-secondary font-bold select-text">' + val + '</span>';
      return item;
    }

    if (typeof val === 'number') {
      item.innerHTML = keyLabel + '<span class="text-accent font-mono font-medium select-text">' + val + '</span>';
      return item;
    }

    if (typeof val === 'string') {
      item.innerHTML = keyLabel + '<span class="text-success select-text break-all">"' + escapeHtml(val) + '"</span>';
      return item;
    }

    if (Array.isArray(val)) {
      var isExpanded = isRoot || val.length <= 10;
      var arrHeader = document.createElement('div');
      arrHeader.className = 'flex items-center gap-1 cursor-pointer hover:bg-base-200/50 rounded px-1 -mx-1';
      arrHeader.innerHTML =
        '<button type="button" class="json-toggle text-base-content/40 hover:text-base-content text-[11px] w-4 text-center">' + (isExpanded ? '▼' : '▶') + '</button>' +
        keyLabel +
        '<span class="text-base-content/60 font-semibold">[</span>' +
        '<span class="text-xs text-base-content/40 tabular-nums">' + val.length + ' item' + (val.length === 1 ? '' : 's') + '</span>' +
        '<span class="text-base-content/60 font-semibold">' + (isExpanded ? '' : ' ... ]') + '</span>';

      var arrBody = document.createElement('div');
      arrBody.className = 'pl-5 border-l border-base-300/60 ml-2 space-y-0.5 ' + (isExpanded ? '' : 'hidden');

      val.forEach(function (child, idx) {
        arrBody.appendChild(buildJsonTree(child, String(idx), false));
      });

      if (isExpanded) {
        var closing = document.createElement('div');
        closing.className = 'text-base-content/60 font-semibold pl-1';
        closing.textContent = ']';
        arrBody.appendChild(closing);
      }

      arrHeader.addEventListener('click', function () {
        var open = !arrBody.classList.contains('hidden');
        arrBody.classList.toggle('hidden', open);
        arrHeader.querySelector('.json-toggle').textContent = open ? '▶' : '▼';
      });

      item.appendChild(arrHeader);
      item.appendChild(arrBody);
      return item;
    }

    if (typeof val === 'object') {
      var keys = Object.keys(val);
      var isObjExpanded = isRoot || keys.length <= 10;
      var objHeader = document.createElement('div');
      objHeader.className = 'flex items-center gap-1 cursor-pointer hover:bg-base-200/50 rounded px-1 -mx-1';
      objHeader.innerHTML =
        '<button type="button" class="json-toggle text-base-content/40 hover:text-base-content text-[11px] w-4 text-center">' + (isObjExpanded ? '▼' : '▶') + '</button>' +
        keyLabel +
        '<span class="text-base-content/60 font-semibold">{</span>' +
        '<span class="text-xs text-base-content/40 tabular-nums">' + keys.length + ' key' + (keys.length === 1 ? '' : 's') + '</span>' +
        '<span class="text-base-content/60 font-semibold">' + (isObjExpanded ? '' : ' ... }') + '</span>';

      var objBody = document.createElement('div');
      objBody.className = 'pl-5 border-l border-base-300/60 ml-2 space-y-0.5 ' + (isObjExpanded ? '' : 'hidden');

      keys.forEach(function (k) {
        objBody.appendChild(buildJsonTree(val[k], k, false));
      });

      if (isObjExpanded) {
        var objClosing = document.createElement('div');
        objClosing.className = 'text-base-content/60 font-semibold pl-1';
        objClosing.textContent = '}';
        objBody.appendChild(objClosing);
      }

      objHeader.addEventListener('click', function () {
        var open = !objBody.classList.contains('hidden');
        objBody.classList.toggle('hidden', open);
        objHeader.querySelector('.json-toggle').textContent = open ? '▶' : '▼';
      });

      item.appendChild(objHeader);
      item.appendChild(objBody);
      return item;
    }

    item.innerHTML = keyLabel + '<span class="text-base-content select-text">' + escapeHtml(String(val)) + '</span>';
    return item;
  }

  // ---- Client-side Hex Dump Generator (Fallback) ---------------------------

  function generateClientHexDump(bytes, maxBytes) {
    maxBytes = maxBytes || 4096;
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
    hex = hex.replace(/^0x/i, '').replace(/\s+/g, '');
    var arr = new Uint8Array(hex.length / 2);
    for (var i = 0; i < hex.length; i += 2) {
      arr[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return arr;
  }

  // ---- Inspector Modal -----------------------------------------------------

  function openInspector(opts) {
    var table = opts.table || '';
    var pk = opts.pk || '';
    var col = opts.col || '';
    var colType = (opts.colType || '').toUpperCase();
    var val = opts.value;
    var isNull = opts.isNull || val === null || val === undefined;
    var readonly = !!opts.readonly;
    var onSave = opts.onSave; // callback(newValue)

    var valStr = isNull ? '' : String(val);
    var isBlob = opts.isBlob || colType.includes('BLOB') || isHexBlob(valStr);
    var isJsonVal = opts.isJson || isJson(valStr);

    var initialTab = isJsonVal ? 'json' : (isBlob ? 'blob' : 'text');

    var overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-xs p-3 md:p-6 opacity-0 transition-opacity duration-200';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    var card = document.createElement('div');
    card.className = 'app-card flex flex-col w-full max-w-4xl max-h-[92vh] overflow-hidden shadow-2xl border border-base-300 transform scale-95 transition-transform duration-200 bg-base-100';

    // Header
    var header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-3 border-b border-base-200 px-5 py-3.5 bg-base-200/30';
    header.innerHTML =
      '<div class="flex items-center gap-3 min-w-0">' +
      '  <span class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary font-mono font-bold text-xs">' +
      (isBlob ? '🗃️' : (isJsonVal ? '{ }' : '📝')) +
      '  </span>' +
      '  <div class="min-w-0">' +
      '    <div class="flex items-center gap-2">' +
      '      <h3 class="text-base font-bold text-base-content truncate">' + escapeHtml(col) + '</h3>' +
      '      <span class="chip chip-type text-[10px]">' + escapeHtml(colType || (isBlob ? 'BLOB' : (isJsonVal ? 'JSON' : 'TEXT'))) + '</span>' +
      (isNull ? '<span class="chip chip-null">NULL</span>' : '') +
      '    </div>' +
      '    <p class="text-xs text-base-content/50 truncate">Table <span class="font-mono font-semibold">' + escapeHtml(table) + '</span>' + (pk ? ' · PK <span class="font-mono">' + escapeHtml(pk) + '</span>' : '') + '</p>' +
      '  </div>' +
      '</div>' +
      '<div class="flex items-center gap-2">' +
      '  <button type="button" class="btn btn-ghost btn-xs btn-circle js-inspector-close text-base-content/40 hover:text-base-content" aria-label="Close">&times;</button>' +
      '</div>';
    card.appendChild(header);

    // Tab Bar
    var tabBar = document.createElement('div');
    tabBar.className = 'flex items-center justify-between border-b border-base-200 bg-base-200/20 px-5 py-2';
    tabBar.innerHTML =
      '<div class="flex gap-1" id="inspector-tabs">' +
      (isJsonVal || (!isBlob && valStr.length > 0) ? '<button type="button" data-tab="json" class="btn btn-xs ' + (initialTab === 'json' ? 'btn-primary' : 'btn-ghost') + ' gap-1">🧩 JSON Tree & Editor</button>' : '') +
      (isBlob ? '<button type="button" data-tab="blob" class="btn btn-xs ' + (initialTab === 'blob' ? 'btn-primary' : 'btn-ghost') + ' gap-1">🖼️ Media & Hex Dump</button>' : '') +
      '<button type="button" data-tab="text" class="btn btn-xs ' + (initialTab === 'text' ? 'btn-primary' : 'btn-ghost') + ' gap-1">📝 Raw Text / Code</button>' +
      '</div>' +
      '<div id="tab-meta" class="text-xs text-base-content/50 font-mono"></div>';
    card.appendChild(tabBar);

    // Content Body Container
    var body = document.createElement('div');
    body.className = 'flex-1 overflow-y-auto p-5 space-y-4 min-h-[350px]';
    card.appendChild(body);

    // Footer
    var footer = document.createElement('div');
    footer.className = 'flex flex-wrap items-center justify-between gap-3 border-t border-base-200 bg-base-200/30 px-5 py-3.5';
    footer.innerHTML =
      '<div class="flex items-center gap-2" id="inspector-left-actions"></div>' +
      '<div class="flex items-center gap-2">' +
      '  <button type="button" class="btn btn-ghost btn-sm js-inspector-close">Close</button>' +
      (!readonly ? '  <button type="button" id="inspector-save-btn" class="btn btn-primary btn-sm gap-1.5">Save Changes</button>' : '') +
      '</div>';
    card.appendChild(footer);

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    requestAnimationFrame(function () {
      overlay.classList.remove('opacity-0');
      overlay.classList.add('opacity-100');
      card.classList.remove('scale-95');
      card.classList.add('scale-100');
    });

    var tabMeta = card.querySelector('#tab-meta');
    var leftActions = card.querySelector('#inspector-left-actions');
    var saveBtn = card.querySelector('#inspector-save-btn');

    var currentVal = valStr;
    var currentTab = initialTab;

    // ---- Render Functions ----

    function renderJsonTab() {
      body.innerHTML = '';
      leftActions.innerHTML = '';
      tabMeta.textContent = '';

      var isParsed = false;
      var parsedObj = null;
      try {
        parsedObj = JSON.parse(currentVal);
        isParsed = true;
      } catch (e) {
        isParsed = false;
      }

      if (!isParsed) {
        body.innerHTML =
          '<div class="alert alert-warning text-xs p-3">' +
          '<span>Content is not valid JSON. You can edit raw text or format it.</span>' +
          '</div>' +
          '<textarea id="json-raw-input" class="field-input font-mono text-[13px] h-72 w-full resize-none p-3.5" spellcheck="false">' + escapeHtml(currentVal) + '</textarea>';
        var ta = body.querySelector('#json-raw-input');
        ta.addEventListener('input', function () { currentVal = ta.value; });
        return;
      }

      var stats = 'Size: ' + formatBytes(new Blob([currentVal]).size);
      tabMeta.textContent = stats;

      // Sub-views for JSON: Tree View vs Formatted Textarea Editor
      var container = document.createElement('div');
      container.className = 'space-y-3';

      var toolbar = document.createElement('div');
      toolbar.className = 'flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-base-200';
      toolbar.innerHTML =
        '<div class="flex items-center gap-1.5">' +
        '  <button type="button" id="btn-view-tree" class="btn btn-xs btn-outline active">Tree View</button>' +
        '  <button type="button" id="btn-view-code" class="btn btn-xs btn-outline">Code Editor</button>' +
        '</div>' +
        '<div class="flex items-center gap-1.5">' +
        '  <button type="button" id="btn-prettify-json" class="btn btn-ghost btn-xs">Beautify</button>' +
        '  <button type="button" id="btn-minify-json" class="btn btn-ghost btn-xs">Minify</button>' +
        '  <button type="button" id="btn-copy-json" class="btn btn-ghost btn-xs gap-1">Copy JSON</button>' +
        '</div>';
      container.appendChild(toolbar);

      var treeViewEl = document.createElement('div');
      treeViewEl.className = 'rounded-xl border border-base-300 bg-base-200/30 p-4 max-h-[420px] overflow-y-auto';
      treeViewEl.appendChild(buildJsonTree(parsedObj, undefined, true));
      container.appendChild(treeViewEl);

      var editorViewEl = document.createElement('div');
      editorViewEl.className = 'hidden space-y-2';
      editorViewEl.innerHTML =
        '<textarea id="json-editor-ta" class="field-input font-mono text-[13px] h-96 w-full resize-none p-3.5" spellcheck="false">' +
        escapeHtml(JSON.stringify(parsedObj, null, 2)) +
        '</textarea>' +
        '<div id="json-validation-msg" class="text-xs font-medium text-success">✓ Valid JSON</div>';
      container.appendChild(editorViewEl);

      body.appendChild(container);

      // Wire JSON toolbar
      var treeBtn = toolbar.querySelector('#btn-view-tree');
      var codeBtn = toolbar.querySelector('#btn-view-code');
      var editorTa = editorViewEl.querySelector('#json-editor-ta');
      var validMsg = editorViewEl.querySelector('#json-validation-msg');

      function setJsonSubView(view) {
        if (view === 'tree') {
          treeBtn.className = 'btn btn-xs btn-primary';
          codeBtn.className = 'btn btn-xs btn-outline';
          treeViewEl.classList.remove('hidden');
          editorViewEl.classList.add('hidden');
        } else {
          codeBtn.className = 'btn btn-xs btn-primary';
          treeBtn.className = 'btn btn-xs btn-outline';
          treeViewEl.classList.add('hidden');
          editorViewEl.classList.remove('hidden');
        }
      }

      setJsonSubView('tree');

      treeBtn.addEventListener('click', function () {
        setJsonSubView('tree');
      });

      codeBtn.addEventListener('click', function () {
        setJsonSubView('code');
      });

      toolbar.querySelector('#btn-prettify-json').addEventListener('click', function () {
        var raw = editorTa.value || currentVal;
        try {
          var p = JSON.parse(raw);
          currentVal = JSON.stringify(p, null, 2);
          editorTa.value = currentVal;
          treeViewEl.innerHTML = '';
          treeViewEl.appendChild(buildJsonTree(p, undefined, true));
          validMsg.className = 'text-xs font-medium text-success';
          validMsg.textContent = '✓ Beautified valid JSON';
          setJsonSubView('code');
          if (saveBtn) saveBtn.disabled = false;
          UI.showToast('JSON beautified.', 'success');
        } catch (e) {
          validMsg.className = 'text-xs font-medium text-error';
          validMsg.textContent = '❌ Syntax Error: ' + e.message;
          UI.showToast('Invalid JSON: ' + e.message, 'error');
        }
      });

      toolbar.querySelector('#btn-minify-json').addEventListener('click', function () {
        var raw = editorTa.value || currentVal;
        try {
          var p = JSON.parse(raw);
          currentVal = JSON.stringify(p);
          editorTa.value = currentVal;
          treeViewEl.innerHTML = '';
          treeViewEl.appendChild(buildJsonTree(p, undefined, true));
          validMsg.className = 'text-xs font-medium text-success';
          validMsg.textContent = '✓ Minified valid JSON';
          setJsonSubView('code');
          if (saveBtn) saveBtn.disabled = false;
          UI.showToast('JSON minified.', 'success');
        } catch (e) {
          validMsg.className = 'text-xs font-medium text-error';
          validMsg.textContent = '❌ Syntax Error: ' + e.message;
          UI.showToast('Invalid JSON: ' + e.message, 'error');
        }
      });

      toolbar.querySelector('#btn-copy-json').addEventListener('click', function () {
        var raw = editorTa.value || currentVal;
        navigator.clipboard.writeText(raw).then(function () {
          UI.showToast('JSON copied to clipboard.', 'success');
        });
      });

      editorTa.addEventListener('input', function () {
        currentVal = editorTa.value;
        try {
          JSON.parse(currentVal);
          validMsg.className = 'text-xs font-medium text-success';
          validMsg.textContent = '✓ Valid JSON';
          if (saveBtn) saveBtn.disabled = false;
        } catch (e) {
          validMsg.className = 'text-xs font-medium text-error';
          validMsg.textContent = '❌ Syntax Error: ' + e.message;
          if (saveBtn) saveBtn.disabled = true;
        }
      });
    }

    function renderBlobTab() {
      body.innerHTML = '<div class="py-12 text-center text-sm text-base-content/40 font-mono">Loading BLOB data...</div>';
      leftActions.innerHTML = '';
      tabMeta.textContent = '';

      var blobEndpoint = (window.APP && window.APP.basePath || '') + '/api/tables/' + encodeURIComponent(table) + '/row/' + encodeURIComponent(pk) + '/blob/' + encodeURIComponent(col);

      // Fetch metadata from API
      Api.get(blobEndpoint + '/meta')
        .then(function (res) {
          var meta = res.data || {};
          tabMeta.textContent = (meta.mime || 'BLOB') + ' · ' + (meta.sizeFormatted || '0 B');

          body.innerHTML = '';

          var container = document.createElement('div');
          container.className = 'space-y-4';

          // Media Preview Section (if image or audio)
          if (meta.isImage) {
            var imgWrap = document.createElement('div');
            imgWrap.className = 'flex flex-col items-center justify-center p-4 rounded-xl border border-base-300 bg-base-200/40 min-h-[220px]';
            imgWrap.innerHTML =
              '<div class="relative group max-w-full max-h-[300px] overflow-hidden rounded-lg shadow-sm">' +
              '  <img src="' + blobEndpoint + '" alt="' + escapeHtml(col) + '" class="max-h-[280px] max-w-full object-contain rounded-lg transition-transform" id="blob-preview-img" />' +
              '</div>' +
              '<div class="mt-3 flex items-center gap-3 text-xs text-base-content/60 font-mono">' +
              '  <span>Format: <b>' + escapeHtml(meta.ext.toUpperCase()) + '</b></span>' +
              '  <span>Size: <b>' + escapeHtml(meta.sizeFormatted) + '</b></span>' +
              '  <a href="' + blobEndpoint + '" target="_blank" class="btn btn-ghost btn-xs text-primary">Open in new tab ↗</a>' +
              '</div>';
            container.appendChild(imgWrap);
          } else if (meta.isAudio) {
            var audioWrap = document.createElement('div');
            audioWrap.className = 'flex flex-col items-center justify-center p-6 rounded-xl border border-base-300 bg-base-200/40';
            audioWrap.innerHTML =
              '<audio controls class="w-full max-w-md mb-2"><source src="' + blobEndpoint + '" type="' + escapeHtml(meta.mime) + '"></audio>' +
              '<div class="text-xs text-base-content/50 font-mono">' + escapeHtml(meta.mime) + ' · ' + escapeHtml(meta.sizeFormatted) + '</div>';
            container.appendChild(audioWrap);
          }

          // 3-Column Hex Dump Viewer
          var hexWrap = document.createElement('div');
          hexWrap.className = 'space-y-2';

          var hexHeader = document.createElement('div');
          hexHeader.className = 'flex items-center justify-between';
          hexHeader.innerHTML =
            '<h4 class="text-xs font-semibold uppercase tracking-wider text-base-content/50 font-mono">Hex Dump (Offset | Hex | ASCII)</h4>' +
            '<button type="button" id="btn-copy-hex" class="btn btn-ghost btn-xs">Copy Hex</button>';
          hexWrap.appendChild(hexHeader);

          var hexPre = document.createElement('div');
          hexPre.className = 'overflow-x-auto rounded-xl border border-base-300 bg-neutral p-3 font-mono text-xs leading-relaxed text-neutral-content max-h-[300px] select-text';

          var hexDump = meta.hexDump;
          if (hexDump && hexDump.lines && hexDump.lines.length) {
            var linesHtml = hexDump.lines.map(function (line) {
              return '<div class="grid grid-cols-[80px_1fr_150px] gap-3 hover:bg-white/[0.06] px-1 rounded">' +
                '<span class="text-primary/70 select-none">' + line.offset + '</span>' +
                '<span class="text-accent/90">' + escapeHtml(line.hex) + '</span>' +
                '<span class="text-neutral-content/70 border-l border-white/10 pl-2">' + escapeHtml(line.ascii) + '</span>' +
                '</div>';
            }).join('');
            hexPre.innerHTML = linesHtml;
          } else {
            hexPre.innerHTML = '<div class="text-center text-neutral-content/40 py-4">No binary content</div>';
          }
          hexWrap.appendChild(hexPre);
          container.appendChild(hexWrap);

          body.appendChild(container);

          // Wire Copy Hex
          hexHeader.querySelector('#btn-copy-hex').addEventListener('click', function () {
            if (valStr.startsWith('0x') || valStr.startsWith('0X')) {
              navigator.clipboard.writeText(valStr).then(function () {
                UI.showToast('Hex data copied.', 'success');
              });
            } else {
              UI.showToast('Hex copied.', 'success');
            }
          });

          // Download & Upload Buttons in Action Bar
          leftActions.innerHTML =
            '<a href="' + blobEndpoint + '?download=1" class="btn btn-outline btn-sm gap-1.5">' +
            '  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>' +
            '  Download File' +
            '</a>' +
            (!readonly ?
              '<label class="btn btn-outline btn-sm gap-1.5 cursor-pointer">' +
              '  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>' +
              '  Replace File' +
              '  <input type="file" id="blob-file-upload-input" class="hidden" />' +
              '</label>' : '');

          var uploadInput = leftActions.querySelector('#blob-file-upload-input');
          if (uploadInput) {
            uploadInput.addEventListener('change', function (e) {
              var file = e.target.files && e.target.files[0];
              if (!file) return;
              var reader = new FileReader();
              reader.onload = function () {
                var base64 = reader.result;
                Api.put(blobEndpoint, { data: base64, format: 'base64' })
                  .then(function () {
                    UI.showToast('BLOB file uploaded successfully.', 'success');
                    renderBlobTab();
                    if (onSave) onSave('0x...');
                  })
                  .catch(function (err) {
                    UI.showError(err.message);
                  });
              };
              reader.readAsDataURL(file);
            });
          }
        })
        .catch(function (err) {
          body.innerHTML = '<div class="alert alert-error text-xs p-3">Failed to load BLOB metadata: ' + escapeHtml(err.message) + '</div>';
        });
    }

    function renderTextTab() {
      body.innerHTML = '';
      leftActions.innerHTML = '';
      tabMeta.textContent = 'Length: ' + currentVal.length + ' chars';

      var container = document.createElement('div');
      container.className = 'space-y-3';

      var toolbar = document.createElement('div');
      toolbar.className = 'flex items-center justify-between pb-2 border-b border-base-200';
      toolbar.innerHTML =
        '<span class="text-xs text-base-content/50 font-mono">Lines: ' + (currentVal.split('\n').length) + '</span>' +
        '<button type="button" id="btn-copy-text" class="btn btn-ghost btn-xs gap-1">Copy Text</button>';
      container.appendChild(toolbar);

      var textarea = document.createElement('textarea');
      textarea.className = 'field-input font-mono text-[13px] h-80 w-full resize-none p-3.5';
      textarea.spellcheck = false;
      textarea.value = currentVal;
      if (readonly) textarea.readOnly = true;

      textarea.addEventListener('input', function () {
        currentVal = textarea.value;
        tabMeta.textContent = 'Length: ' + currentVal.length + ' chars';
      });

      container.appendChild(textarea);
      body.appendChild(container);

      toolbar.querySelector('#btn-copy-text').addEventListener('click', function () {
        navigator.clipboard.writeText(currentVal).then(function () {
          UI.showToast('Text copied to clipboard.', 'success');
        });
      });
    }

    function switchTab(tab) {
      currentTab = tab;
      tabBar.querySelectorAll('#inspector-tabs button').forEach(function (btn) {
        var active = btn.dataset.tab === tab;
        btn.className = 'btn btn-xs ' + (active ? 'btn-primary' : 'btn-ghost') + ' gap-1';
      });
      if (tab === 'json') renderJsonTab();
      else if (tab === 'blob') renderBlobTab();
      else renderTextTab();
    }

    tabBar.querySelectorAll('#inspector-tabs button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.dataset.tab);
      });
    });

    switchTab(initialTab);

    // Close Handler
    function close() {
      overlay.classList.remove('opacity-100');
      overlay.classList.add('opacity-0');
      card.classList.remove('scale-100');
      card.classList.add('scale-95');
      setTimeout(function () { overlay.remove(); }, 180);
    }

    card.querySelectorAll('.js-inspector-close').forEach(function (btn) {
      btn.addEventListener('click', close);
    });

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    // Save Changes Handler
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        if (onSave) {
          onSave(currentVal);
        }
        close();
      });
    }
  }

  window.Inspector = {
    open: openInspector,
  };
})();
