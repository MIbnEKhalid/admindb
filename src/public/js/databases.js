/* Databases landing page: create SQLite databases, connect PostgreSQL databases,
 * toggle readonly mode, delete/disconnect databases, and browse filesystem. */
(function () {
  'use strict';
  const nameInput = document.getElementById('new-db-name');
  const createBtn = document.getElementById('create-db');
  const pgNameInput = document.getElementById('pg-conn-name');
  const pgUriInput = document.getElementById('pg-conn-uri');
  const pgRoInput = document.getElementById('pg-conn-readonly');
  const connectPgBtn = document.getElementById('connect-pg');
  const fsRoInput = document.getElementById('fs-readonly');

  const escapeHtml = window.Utils ? window.Utils.escapeHtml : function(s) { return String(s == null ? '' : s); };
  const fmtSize = window.Utils ? window.Utils.formatBytes : function(n) { return (n || 0) + ' B'; };

  // ---- Create SQLite DB ----------------------------------------------------

  async function createDb() {
    const name = (nameInput.value || '').trim();
    if (!name) return UI.showError('Enter a database name.');
    try {
      const data = await Api.post('/api/databases', { name });
      UI.showToast(data.message || 'Database created.', 'success');
      setTimeout(() => {
        window.location.href = Api.basePath + '/home/' + encodeURIComponent(data.id);
      }, 400);
    } catch (e) {
      UI.showError(e.message);
    }
  }

  if (createBtn) createBtn.addEventListener('click', createDb);
  if (nameInput) {
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createDb();
    });
  }

  // ---- Connect PostgreSQL DB -----------------------------------------------

  async function connectPg() {
    const name = (pgNameInput ? pgNameInput.value : '').trim();
    const connectionString = (pgUriInput ? pgUriInput.value : '').trim();
    const readonly = pgRoInput ? pgRoInput.checked : false;
    if (!connectionString) {
      return UI.showError('Enter a PostgreSQL connection URI (e.g. postgresql://user:password@localhost:5432/dbname).');
    }
    if (connectPgBtn) {
      connectPgBtn.disabled = true;
      connectPgBtn.textContent = 'Connecting…';
    }
    try {
      const data = await Api.post('/api/databases/connect-postgres', { name, connectionString, readonly });
      UI.showToast(data.message || 'PostgreSQL connected.', 'success');
      setTimeout(() => {
        window.location.href = Api.basePath + '/home/' + encodeURIComponent(data.id);
      }, 400);
    } catch (e) {
      UI.showError(e.message);
      if (connectPgBtn) {
        connectPgBtn.disabled = false;
        connectPgBtn.innerHTML = (window.AdminIcons ? AdminIcons.get('plus', 'h-4 w-4') : '') + ' Connect PostgreSQL';
      }
    }
  }

  if (connectPgBtn) connectPgBtn.addEventListener('click', connectPg);
  if (pgUriInput) {
    pgUriInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') connectPg();
    });
  }

  // ---- Toggle Read-only / Writable Mode ------------------------------------

  document.querySelectorAll('.js-toggle-db-mode').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!id) return;
      const currentRo = btn.dataset.readonly === 'true';
      const targetRo = !currentRo;
      try {
        const data = await Api.post('/api/databases/' + encodeURIComponent(id) + '/mode', { readonly: targetRo });
        UI.showToast(data.message || `Mode updated to ${targetRo ? 'Read-only' : 'Writable'}.`, 'success');
        window.location.reload();
      } catch (e) {
        UI.showError(e.message);
      }
    });
  });

  // ---- Delete SQLite DB ----------------------------------------------------

  document.querySelectorAll('.js-delete-db').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!id) return;
      const confirmed = await UI.confirm({
        title: 'Delete Database',
        message: 'Are you sure you want to permanently delete database "' + id + '"? This will remove the SQLite database file and all stored tables and records from the disk.',
        item: id,
        itemType: 'Database',
        requireInputMatch: id,
        confirmText: 'Delete database',
        danger: true,
      });
      if (!confirmed) return;
      Api.del('/api/databases/' + encodeURIComponent(id))
        .then((data) => {
          UI.showToast(data.message || 'Database deleted.', 'success');
          window.location.reload();
        })
        .catch((e) => UI.showError(e.message));
    });
  });

  // ---- Disconnect PostgreSQL DB --------------------------------------------

  document.querySelectorAll('.js-disconnect-db').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name || id;
      if (!id) return;
      const confirmed = await UI.confirm({
        title: 'Disconnect PostgreSQL Database',
        message: 'Are you sure you want to disconnect database "' + name + '" from AdminDB? This closes the connection pool in AdminDB; your remote database and data are untouched.',
        confirmText: 'Disconnect database',
        danger: false,
      });
      if (!confirmed) return;
      Api.del('/api/databases/' + encodeURIComponent(id))
        .then((data) => {
          UI.showToast(data.message || 'Database disconnected.', 'success');
          window.location.reload();
        })
        .catch((e) => UI.showError(e.message));
    });
  });

  // ---- Filesystem browser --------------------------------------------------

  const fsPathInput = document.getElementById('fs-path');
  const fsGoBtn = document.getElementById('fs-go');
  const fsUpBtn = document.getElementById('fs-up');
  const fsCurrent = document.getElementById('fs-current');
  const fsListing = document.getElementById('fs-listing');

  let fsState = { path: '', parent: null };

  function renderFs(data) {
    fsState = { path: data.path, parent: data.parent };
    if (fsCurrent) fsCurrent.textContent = data.path;
    if (fsPathInput) fsPathInput.value = data.path;
    if (fsUpBtn) fsUpBtn.disabled = !data.parent;
    if (!fsListing) return;
    fsListing.innerHTML = '';
    if (!data.entries.length) {
      fsListing.innerHTML = '<div class="px-4 py-6 text-center text-sm text-base-content/40">No folders or database files here.</div>';
      return;
    }
    const folderIcon = window.AdminIcons ? AdminIcons.get('folder', 'h-3.5 w-3.5') : '📁';
    const dbIcon = window.AdminIcons ? AdminIcons.get('database', 'h-3.5 w-3.5') : '🗄️';

    data.entries.forEach((e) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-primary/[0.06]';
      row.title = e.path;
      if (e.isDir) {
        row.innerHTML =
          '<span class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-base-200 text-base-content/50">' + folderIcon + '</span>' +
          '<span class="min-w-0 flex-1 truncate font-medium text-base-content/80">' + escapeHtml(e.name) + '</span>' +
          '<span class="text-xs text-base-content/35">folder</span>';
        row.addEventListener('click', () => loadFs(e.path));
      } else {
        row.innerHTML =
          '<span class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">' + dbIcon + '</span>' +
          '<span class="min-w-0 flex-1 truncate font-mono text-[13px] text-base-content/85">' + escapeHtml(e.name) + '</span>' +
          '<span class="text-xs text-base-content/40">' + fmtSize(e.size) + '</span>';
        row.addEventListener('click', () => openDb(e.path));
      }
      fsListing.appendChild(row);
    });
  }

  async function loadFs(p) {
    try {
      const data = await Api.get('/api/fs/list' + (p ? '?path=' + encodeURIComponent(p) : ''));
      renderFs(data);
    } catch (e) {
      UI.showError(e.message);
    }
  }

  function goUp() {
    if (fsState.parent) loadFs(fsState.parent);
  }

  async function openDb(p) {
    const readonly = fsRoInput ? fsRoInput.checked : false;
    try {
      const data = await Api.post('/api/databases/open', { path: p, readonly });
      UI.showToast(data.message || 'Database opened.', 'success');
      window.location.href = Api.basePath + '/home/' + encodeURIComponent(data.id);
    } catch (e) {
      UI.showError(e.message);
    }
  }

  if (fsListing) {
    loadFs('');
    if (fsGoBtn) {
      fsGoBtn.addEventListener('click', () => loadFs((fsPathInput.value || '').trim() || ''));
    }
    if (fsPathInput) {
      fsPathInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loadFs((fsPathInput.value || '').trim() || '');
      });
    }
    if (fsUpBtn) fsUpBtn.addEventListener('click', goUp);
  }
})();
