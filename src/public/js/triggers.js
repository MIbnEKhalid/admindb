/* Triggers page: create / drop triggers with a live SQL preview. */
(function () {
  'use strict';
  const cfgEl = document.getElementById('triggers-config');
  if (!cfgEl) return;

  function escapeHtml(s) {
    return (window.UI && UI.escapeHtml) ? UI.escapeHtml(s) : String(s == null ? '' : s);
  }

  function showError(el, msg) {
    el.classList.remove('hidden');
    el.innerHTML = '<div class="flex items-start gap-2.5 rounded-xl border border-error/40 bg-error/10 px-4 py-3 text-sm font-medium text-error"><span>' + escapeHtml(msg) + '</span></div>';
  }

  // ---- Editor gutter ------------------------------------------------------

  const editor = document.getElementById('trigger-body');
  const gutter = document.getElementById('trigger-gutter');
  function updateGutter() {
    if (!gutter || !editor) return;
    const lines = editor.value.split('\n').length;
    let html = '';
    for (let i = 1; i <= lines; i++) html += i + '\n';
    gutter.textContent = html;
    gutter.scrollTop = editor.scrollTop;
  }
  if (editor && gutter) {
    editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
    editor.addEventListener('input', updateGutter);
    updateGutter();
  }

  // ---- New trigger form ---------------------------------------------------

  const newBtn = document.getElementById('new-trigger');
  const panel = document.getElementById('new-trigger-panel');
  const nameInput = document.getElementById('trigger-name');
  const tableInput = document.getElementById('trigger-table');
  const timingInput = document.getElementById('trigger-timing');
  const eventInput = document.getElementById('trigger-event');
  const whenInput = document.getElementById('trigger-when');
  const bodyInput = document.getElementById('trigger-body');
  const errEl = document.getElementById('trigger-error');
  const createBtn = document.getElementById('create-trigger');
  const cancelBtn = document.getElementById('cancel-trigger');
  const preview = document.getElementById('trigger-preview');
  const previewCode = document.getElementById('trigger-preview-code');
  const previewHint = document.getElementById('trigger-preview-hint');
  let previewTimer = null;

  function currentEvent() {
    return eventInput ? eventInput.value : 'INSERT';
  }

  function renderPreview() {
    clearTimeout(previewTimer);
    const name = (nameInput.value || '').trim();
    const table = tableInput.value || '';
    const event = currentEvent();
    if (!name && !table && !(bodyInput.value || '').trim()) {
      preview.classList.add('hidden');
      previewCode.textContent = '';
      if (previewHint) previewHint.classList.remove('hidden');
      return;
    }
    previewTimer = setTimeout(async () => {
      try {
        const data = await Api.post('/api/triggers/generate', {
          name,
          table,
          timing: timingInput.value,
          event,
          when: (whenInput.value || '').trim() || undefined,
          body: bodyInput.value,
        });
        previewCode.textContent = data.sql;
        preview.classList.remove('hidden');
        if (previewHint) previewHint.classList.add('hidden');
      } catch (e) {
        preview.classList.add('hidden');
        previewCode.textContent = '';
        if (previewHint) previewHint.classList.remove('hidden');
      }
    }, 250);
  }

  if (newBtn && panel) {
    newBtn.addEventListener('click', () => {
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) {
        errEl.classList.add('hidden');
        nameInput.focus();
        renderPreview();
      }
    });
  }
  [nameInput, tableInput, timingInput, eventInput, whenInput, bodyInput].forEach((el) => {
    if (el) el.addEventListener('input', renderPreview);
  });

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      panel.classList.add('hidden');
      errEl.classList.add('hidden');
    });
  }

  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      errEl.classList.add('hidden');
      const name = (nameInput.value || '').trim();
      const table = tableInput.value || '';
      const body = (bodyInput.value || '').trim();
      const event = currentEvent();
      if (!name) return showError(errEl, 'Trigger name is required.');
      if (!table) return showError(errEl, 'Select a table for the trigger.');
      if (!body) return showError(errEl, 'Trigger body is required.');
      createBtn.disabled = true;
      try {
        const data = await Api.post('/api/triggers', {
          name,
          table,
          timing: timingInput.value,
          event,
          when: (whenInput.value || '').trim() || undefined,
          body,
        });
        UI.showToast(data.message || 'Trigger created.', 'success');
        window.location.reload();
      } catch (e) {
        showError(errEl, e.message);
      } finally {
        createBtn.disabled = false;
      }
    });
  }

  // ---- Drop trigger -------------------------------------------------------

  document.querySelectorAll('.trigger-drop').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.trigger;
      if (!name) return;
      if (!window.confirm('Drop trigger "' + name + '" permanently?')) return;
      try {
        const data = await Api.del('/api/triggers/' + encodeURIComponent(name));
        UI.showToast(data.message || 'Trigger dropped.', 'success');
        window.location.reload();
      } catch (e) {
        UI.showError(e.message);
      }
    });
  });
})();
