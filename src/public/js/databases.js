/* Databases landing page: create and delete SQLite database files. */
(function () {
  'use strict';
  const nameInput = document.getElementById('new-db-name');
  const createBtn = document.getElementById('create-db');

  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
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
})();
