/* Databases landing page: create/delete database files, and a filesystem
 * browser for opening existing SQLite files. */
(function () {
  'use strict';
  const nameInput = document.getElementById('new-db-name');
  const createBtn = document.getElementById('create-db');

  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
  }

  function fmtSize(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u += 1;
    }
    return (u === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[u];
  }

  async function createDb() {
    const name = (nameInput.value || '').trim();
    if (!name) return UI.showError('Enter a database name.');
    try {
      const data = await Api.post('/api/databases', { name });
      UI.showToast(data.message || 'Database created.', 'success');
      setTimeout(() => {
        window.location.href = Api.basePath + '/' + encodeURIComponent(data.id);
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

  document.querySelectorAll('.js-delete-db').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (!id) return;
      if (!window.confirm('Delete database "' + id + '" permanently? This removes the file and all of its data.')) return;
      Api.del('/api/databases/' + encodeURIComponent(id))
        .then((data) => {
          UI.showToast(data.message || 'Database deleted.', 'success');
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

  const FOLDER_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>';
  const DB_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 1.1.9 2 2 2h12a2 2 0 002-2V7M4 7c0-1.1.9-2 2-2h12a2 2 0 012 2M4 7c0 1.1.9 2 2 2h12a2 2 0 002-2" /></svg>';

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
    data.entries.forEach((e) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-primary/[0.06]';
      row.title = e.path;
      if (e.isDir) {
        row.innerHTML =
          '<span class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-base-200 text-base-content/50">' + FOLDER_ICON + '</span>' +
          '<span class="min-w-0 flex-1 truncate font-medium text-base-content/80">' + escapeHtml(e.name) + '</span>' +
          '<span class="text-xs text-base-content/35">folder</span>';
        row.addEventListener('click', () => loadFs(e.path));
      } else {
        row.innerHTML =
          '<span class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">' + DB_ICON + '</span>' +
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
    try {
      const data = await Api.post('/api/databases/open', { path: p });
      UI.showToast(data.message || 'Database opened.', 'success');
      window.location.href = Api.basePath + '/' + encodeURIComponent(data.id);
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

