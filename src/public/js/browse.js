/* Row actions on the table browse page: delete, page-size, row filters, and
 * CSV import. */
(function () {
  'use strict';

  const base = (window.APP && window.APP.basePath) || '';

  // ---- Delete row --------------------------------------------------------

  document.querySelectorAll('.js-delete-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const table = btn.dataset.table;
      const pk = btn.dataset.pk;
      if (!table || !pk) return;
      if (!window.confirm('Delete this row? This cannot be undone.')) return;
      Api.del('/api/tables/' + encodeURIComponent(table) + '/row/' + encodeURIComponent(pk))
        .then(() => {
          UI.showToast('Row deleted.', 'success');
          window.location.reload();
        })
        .catch((e) => UI.showError(e.message));
    });
  });

  // ---- Page size (keeps current filters) ----------------------------------

  const sizeSel = document.getElementById('page-size');
  if (sizeSel) {
    sizeSel.addEventListener('change', () => {
      const table = sizeSel.dataset.table;
      const size = sizeSel.value;
      const orderBy = sizeSel.dataset.orderby || '';
      const orderDir = sizeSel.dataset.orderdir || 'asc';
      const filters = sizeSel.dataset.filters || '';
      let href =
        base + '/tables/' + encodeURIComponent(table) + '?page=1&size=' + encodeURIComponent(size) +
        '&orderBy=' + encodeURIComponent(orderBy) + '&orderDir=' + encodeURIComponent(orderDir);
      if (filters) href += '&' + filters;
      window.location.href = href;
    });
  }

  // ---- Row filters --------------------------------------------------------

  const filterForm = document.getElementById('filter-form');
  const clearBtn = document.getElementById('clear-filter');
  if (filterForm) {
    function currentFilters() {
      const out = {};
      filterForm.querySelectorAll('.filter-input').forEach((input) => {
        const v = (input.value || '').trim();
        if (v) out[input.name] = v;
      });
      return out;
    }
    function navigate(filters) {
      let table = '';
      const m = window.location.pathname.match(/\/tables\/([^/]+)(?:\/|$)/);
      if (m) table = decodeURIComponent(m[1]);
      if (!table) return;
      const qs = new URLSearchParams({ page: '1', size: '50' });
      const keys = Object.keys(filters);
      if (keys.length) qs.set('f', JSON.stringify(filters));
      window.location.href = base + '/tables/' + encodeURIComponent(table) + '?' + qs.toString();
    }
    filterForm.addEventListener('submit', (e) => {
      e.preventDefault();
      navigate(currentFilters());
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', () => navigate({}));
    }
  }

  // ---- CSV import ---------------------------------------------------------

  const importBtn = document.getElementById('import-csv');
  const importPanel = document.getElementById('import-panel');
  const importClose = document.getElementById('import-csv-close');
  const importText = document.getElementById('import-csv-text');
  const importFile = document.getElementById('import-csv-file');
  const importSubmit = document.getElementById('import-csv-submit');

  if (importBtn && importPanel) {
    importBtn.addEventListener('click', () => {
      importPanel.classList.toggle('hidden');
      if (!importPanel.classList.contains('hidden')) importText.focus();
    });
  }
  if (importClose) {
    importClose.addEventListener('click', () => importPanel.classList.add('hidden'));
  }
  if (importFile) {
    importFile.addEventListener('change', () => {
      const file = importFile.files && importFile.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        importText.value = String(reader.result || '');
      };
      reader.readAsText(file);
    });
  }
  if (importSubmit && importText) {
    importSubmit.addEventListener('click', async () => {
      const csv = importText.value.trim();
      if (!csv) return UI.showError('Paste or choose a CSV file first.');
      const m = window.location.pathname.match(/\/tables\/([^/]+)(?:\/|$)/);
      const table = m ? decodeURIComponent(m[1]) : '';
      if (!table) return UI.showError('Could not determine the table.');
      importSubmit.disabled = true;
      try {
        const data = await Api.post('/api/tables/' + encodeURIComponent(table) + '/rows/import', { csv });
        UI.showToast(data.message || 'Import complete.', 'success');
        window.location.reload();
      } catch (e) {
        UI.showError(e.message);
      } finally {
        importSubmit.disabled = false;
      }
    });
  }
})();
