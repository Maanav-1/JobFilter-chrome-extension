(() => {
  if (window.__jfOverlayInjected) return;
  window.__jfOverlayInjected = true;

  const ROOT_ID = 'jf-overlay';
  const DEFAULT_TOP = 16;
  const DEFAULT_RIGHT = 16;

  let root = null;
  let resultEl = null;
  let resumeLabelEl = null;
  let resumeMenuEl = null;
  let logClearTimer = null;
  let dragState = null;
  let pendingTimeoutId = null;

  function isExtensionContextValid() {
    try { return Boolean(chrome?.runtime?.id); } catch (_) { return false; }
  }

  function isContextInvalidatedError(msg) {
    return typeof msg === 'string' && /Extension context invalidated|message port closed/i.test(msg);
  }

  function safeSendMessage(payload, onResponse) {
    if (!isExtensionContextValid()) {
      onResponse(null, new Error('Extension was reloaded — refresh this page to continue.'));
      return;
    }
    try {
      chrome.runtime.sendMessage(payload, (resp) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          const msg = isContextInvalidatedError(lastErr.message)
            ? 'Extension was reloaded — refresh this page to continue.'
            : (lastErr.message || 'Extension messaging failed.');
          onResponse(null, new Error(msg));
          return;
        }
        onResponse(resp, null);
      });
    } catch (e) {
      const msg = isContextInvalidatedError(e?.message)
        ? 'Extension was reloaded — refresh this page to continue.'
        : (e?.message || 'Extension messaging failed.');
      onResponse(null, new Error(msg));
    }
  }

  function clearPendingTimeout() {
    if (pendingTimeoutId) { clearTimeout(pendingTimeoutId); pendingTimeoutId = null; }
  }

  function startPendingTimeout(seconds) {
    clearPendingTimeout();
    pendingTimeoutId = setTimeout(() => {
      pendingTimeoutId = null;
      setError(`No response after ${seconds}s. The background worker may have stalled — try again, and if it persists check the extension service worker logs.`);
    }, seconds * 1000);
  }

  function $(sel, parent) { return (parent || root).querySelector(sel); }

  function createOverlay() {
    if (root) return root;
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('data-jf-hidden', 'true');
    root.innerHTML = `
      <div class="jf-card" role="dialog" aria-label="JobFilter">
        <div class="jf-header">
          <div class="jf-drag" title="Drag to move" aria-label="Drag handle">
            <span></span><span></span>
            <span></span><span></span>
            <span></span><span></span>
          </div>
          <div class="jf-title">JobFilter</div>
          <button class="jf-close" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="jf-body">
          <button class="jf-btn jf-btn-primary" data-action="check" type="button">Check this JD</button>
          <button class="jf-btn jf-btn-outline" data-action="log" type="button">Log application</button>
          <div class="jf-result" data-empty="true"></div>
          <div class="jf-resume-row">
            <button class="jf-resume-label" type="button" aria-haspopup="listbox">
              <span class="jf-resume-text">Using: —</span>
              <span class="jf-caret">▾</span>
            </button>
            <div class="jf-resume-menu" role="listbox" hidden></div>
          </div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(root);

    resultEl = $('.jf-result');
    resumeLabelEl = $('.jf-resume-label');
    resumeMenuEl = $('.jf-resume-menu');

    $('.jf-close').addEventListener('click', hideOverlay);
    $('[data-action="check"]').addEventListener('click', onCheckClick);
    $('[data-action="log"]').addEventListener('click', onLogClick);
    $('.jf-drag').addEventListener('mousedown', onDragStart);
    resumeLabelEl.addEventListener('click', toggleResumeMenu);
    document.addEventListener('mousedown', onDocClickForMenu, true);

    return root;
  }

  function applyPosition(pos) {
    if (!root) return;
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      root.style.left = `${pos.x}px`;
      root.style.top = `${pos.y}px`;
      root.style.right = 'auto';
    } else {
      root.style.top = `${DEFAULT_TOP}px`;
      root.style.right = `${DEFAULT_RIGHT}px`;
      root.style.left = 'auto';
    }
  }

  function showOverlay() {
    if (!root) createOverlay();
    chrome.storage.local.get(['overlayPosition'], (items) => {
      applyPosition(items?.overlayPosition || null);
      root.removeAttribute('data-jf-hidden');
      refreshResumeLabel();
    });
  }

  function hideOverlay() {
    if (!root) return;
    root.setAttribute('data-jf-hidden', 'true');
    closeResumeMenu();
  }

  function toggleOverlay() {
    if (!root) {
      createOverlay();
      showOverlay();
      return;
    }
    if (root.getAttribute('data-jf-hidden') === 'true') showOverlay();
    else hideOverlay();
  }

  function onDragStart(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = root.getBoundingClientRect();
    dragState = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top
    };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(e) {
    if (!dragState) return;
    const x = Math.max(0, Math.min(window.innerWidth - 40, e.clientX - dragState.offsetX));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragState.offsetY));
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.right = 'auto';
  }

  function onDragEnd() {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    if (!dragState) return;
    dragState = null;
    const x = parseInt(root.style.left, 10) || 0;
    const y = parseInt(root.style.top, 10) || 0;
    if (!isExtensionContextValid()) return;
    try {
      chrome.storage.local.set({ overlayPosition: { x, y } });
    } catch (_) { /* context invalidated mid-drag — silently drop */ }
  }

  function setLoading(message) {
    if (logClearTimer) { clearTimeout(logClearTimer); logClearTimer = null; }
    resultEl.removeAttribute('data-empty');
    resultEl.innerHTML = `
      <div class="jf-loading">
        <span class="jf-spinner" aria-hidden="true"></span>
        <span>${escapeHtml(message)}</span>
      </div>
    `;
  }

  function setError(message) {
    clearPendingTimeout();
    if (logClearTimer) { clearTimeout(logClearTimer); logClearTimer = null; }
    resultEl.removeAttribute('data-empty');
    resultEl.innerHTML = `
      <div class="jf-card-result jf-error">
        <div class="jf-badge jf-badge-error">ERROR</div>
        <div class="jf-reason">${escapeHtml(message)}</div>
      </div>
    `;
  }

  function setDecision(result) {
    if (logClearTimer) { clearTimeout(logClearTimer); logClearTimer = null; }
    resultEl.removeAttribute('data-empty');
    const decision = (result.decision || '').toLowerCase() === 'apply' ? 'apply' : 'skip';
    const cls = decision === 'apply' ? 'jf-apply' : 'jf-skip';
    const label = decision === 'apply' ? 'APPLY' : 'SKIP';
    resultEl.innerHTML = `
      <div class="jf-card-result ${cls}">
        <div class="jf-badge">${label}</div>
        <div class="jf-reason">${escapeHtml(result.reason || '')}</div>
      </div>
    `;
  }

  function setLogged(result) {
    resultEl.removeAttribute('data-empty');
    const wroteTo = result.updatedRange || result.requestedRange || '—';
    resultEl.innerHTML = `
      <div class="jf-card-result jf-logged">
        <div class="jf-logged-head">Logged ✓</div>
        <div class="jf-kv"><span>Company</span><strong>${escapeHtml(result.company || '—')}</strong></div>
        <div class="jf-kv"><span>Title</span><strong>${escapeHtml(result.title || '—')}</strong></div>
        <div class="jf-kv"><span>Date</span><strong>${escapeHtml(result.date || '—')}</strong></div>
        <div class="jf-kv"><span>Notes</span><strong>${escapeHtml(result.notes || '—')}</strong></div>
        <div class="jf-kv"><span>Wrote to</span><strong>${escapeHtml(wroteTo)}</strong></div>
      </div>
    `;
    if (logClearTimer) clearTimeout(logClearTimer);
    logClearTimer = setTimeout(() => {
      resultEl.innerHTML = '';
      resultEl.setAttribute('data-empty', 'true');
      logClearTimer = null;
    }, 10000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function getPageText(maxChars) {
    const raw = (document.body && document.body.innerText) || '';
    return raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  }

  function onCheckClick() {
    setLoading('Checking JD…');
    startPendingTimeout(60);
    safeSendMessage(
      { type: 'CHECK_JD', text: getPageText(20000), url: window.location.href },
      (resp, err) => {
        clearPendingTimeout();
        if (err) { setError(err.message); return; }
        if (!resp || !resp.success) { setError(resp?.error || 'Unknown error.'); return; }
        setDecision(resp);
      }
    );
  }

  function onLogClick() {
    setLoading('Logging job…');
    startPendingTimeout(120);
    safeSendMessage(
      { type: 'LOG_JOB', text: getPageText(15000), url: window.location.href },
      (resp, err) => {
        clearPendingTimeout();
        if (err) { setError(err.message); return; }
        if (!resp || !resp.success) { setError(resp?.error || 'Unknown error.'); return; }
        setLogged(resp);
      }
    );
  }

  function refreshResumeLabel() {
    chrome.storage.local.get(['resumes', 'activeResumeId'], (items) => {
      const resumes = items?.resumes || [];
      const active = resumes.find((r) => r.id === items?.activeResumeId);
      const textEl = resumeLabelEl.querySelector('.jf-resume-text');
      if (!resumes.length) {
        textEl.textContent = 'No resume — open Options';
      } else if (active) {
        textEl.textContent = `Using: ${active.name}`;
      } else {
        textEl.textContent = 'Using: (none selected)';
      }
    });
  }

  function toggleResumeMenu(e) {
    e.stopPropagation();
    if (!resumeMenuEl.hasAttribute('hidden')) {
      closeResumeMenu();
      return;
    }
    chrome.storage.local.get(['resumes', 'activeResumeId'], (items) => {
      const resumes = items?.resumes || [];
      if (!resumes.length) {
        resumeMenuEl.innerHTML = `<div class="jf-menu-empty">No resumes uploaded.</div>`;
      } else {
        resumeMenuEl.innerHTML = resumes.map((r) => `
          <button class="jf-menu-item${r.id === items.activeResumeId ? ' is-active' : ''}" data-id="${escapeHtml(r.id)}" type="button">
            <span class="jf-menu-name">${escapeHtml(r.name)}</span>
            ${r.id === items.activeResumeId ? '<span class="jf-menu-check">●</span>' : ''}
          </button>
        `).join('');
        resumeMenuEl.querySelectorAll('.jf-menu-item').forEach((btn) => {
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const id = btn.getAttribute('data-id');
            chrome.storage.local.set({ activeResumeId: id }, () => {
              refreshResumeLabel();
              closeResumeMenu();
            });
          });
        });
      }
      resumeMenuEl.removeAttribute('hidden');
    });
  }

  function closeResumeMenu() {
    if (resumeMenuEl) resumeMenuEl.setAttribute('hidden', '');
  }

  function onDocClickForMenu(e) {
    if (!root || !resumeMenuEl) return;
    if (resumeMenuEl.hasAttribute('hidden')) return;
    if (resumeMenuEl.contains(e.target) || resumeLabelEl.contains(e.target)) return;
    closeResumeMenu();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'TOGGLE') {
      if (!root) createOverlay();
      toggleOverlay();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.resumes || changes.activeResumeId) {
      if (root && root.getAttribute('data-jf-hidden') !== 'true') refreshResumeLabel();
    }
  });

  createOverlay();
})();
