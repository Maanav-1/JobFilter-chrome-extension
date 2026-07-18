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

  // Returns a live, attached overlay. If the host page tore our node out of the
  // DOM (SPA route change, React hydration-recovery re-render, an autofill
  // extension rewriting the document, etc.) our `root` variable still points at
  // a detached element — rebuild from scratch so the toggle keeps working
  // without a full page reload.
  function ensureOverlay() {
    if (root && root.isConnected) return root;
    root = null;
    return createOverlay();
  }

  function createOverlay() {
    if (root && root.isConnected) return root;
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
          <div class="jf-log-row">
            <button class="jf-btn jf-btn-outline" data-action="log" data-role="intern" type="button">Log intern</button>
            <button class="jf-btn jf-btn-outline" data-action="log" data-role="fulltime" type="button">Log full-time</button>
          </div>
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
    root.querySelectorAll('[data-action="log"]').forEach((btn) => {
      btn.addEventListener('click', () => onLogClick(btn.getAttribute('data-role')));
    });
    $('.jf-drag').addEventListener('mousedown', onDragStart);
    resumeLabelEl.addEventListener('click', toggleResumeMenu);
    document.addEventListener('mousedown', onDocClickForMenu, true);

    return root;
  }

  function applyPosition(pos) {
    if (!root) return;
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      // Clamp so the ENTIRE overlay fits inside the current viewport. The
      // previous implementation only guaranteed ~40px visible, which on
      // narrower windows (e.g. saved x=1081 on a wider monitor, current window
      // 1080–1280) left users staring at a fingernail-thin sliver and thinking
      // the extension never opened.
      const overlayW = 240;
      const overlayH = 260; // conservative upper bound for card height
      const maxX = Math.max(0, window.innerWidth - overlayW);
      const maxY = Math.max(0, window.innerHeight - overlayH);
      const x = Math.max(0, Math.min(maxX, pos.x));
      const y = Math.max(0, Math.min(maxY, pos.y));
      // If clamping had to move the saved coords by more than half the overlay
      // on either axis, the saved position is meaningfully off this viewport.
      // Reset to default top-right instead of pinning to the edge — gives the
      // user a familiar starting point.
      const drifted = Math.abs(x - pos.x) > overlayW / 2 || Math.abs(y - pos.y) > overlayH / 2;
      if (drifted) {
        root.style.top = `${DEFAULT_TOP}px`;
        root.style.right = `${DEFAULT_RIGHT}px`;
        root.style.left = 'auto';
        return;
      }
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
      root.style.right = 'auto';
    } else {
      root.style.top = `${DEFAULT_TOP}px`;
      root.style.right = `${DEFAULT_RIGHT}px`;
      root.style.left = 'auto';
    }
  }

  function showOverlay() {
    ensureOverlay();
    chrome.storage.local.get(['overlayPosition'], (items) => {
      ensureOverlay();
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
    // ensureOverlay rebuilds if our node was detached by the host page, so a
    // detached-but-non-null `root` can't make the toggle silently no-op.
    const wasHidden = !root || !root.isConnected || root.getAttribute('data-jf-hidden') === 'true';
    ensureOverlay();
    if (wasHidden) showOverlay();
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

  // Site-specific selectors keep the JD payload tight: we ship just the posting body
  // to the model instead of nav, footer, related jobs, etc.
  const SITE_SELECTORS = [
    ['linkedin.com',     '#job-details, .jobs-description__content'],
    ['symplicity.com',   '.content-container-inner'],
    ['workday',          '[data-automation-id="jobPostingDescription"]'],
    ['myworkdayjobs',    '[data-automation-id="jobPostingDescription"]'],
    ['greenhouse.io',    '#content'],
    ['icims.com',        '.iCIMS_JobContent, .iCIMS_JobContainer'],
    ['jobs.lever.co',    '.posting-page, .section-wrapper']
  ];
  const GENERIC_SELECTOR = 'main, [role="main"], #main-content, .job-description, .posting-body, .iCIMS_JobContainer';

  function readSelectorText(selector) {
    try {
      const node = document.querySelector(selector);
      if (!node) return '';
      return (node.innerText || '').trim();
    } catch (_) {
      return '';
    }
  }

  function getPageText(maxChars) {
    const host = (window.location.hostname || '').toLowerCase();
    const siteSelector = (SITE_SELECTORS.find(([needle]) => host.includes(needle)) || [])[1];

    let text = '';

    // iCIMS portals (e.g. Uber, T-Mobile, many F500 careers sites) frequently embed the
    // posting body inside <iframe id="icims_content_iframe">. When the parent and frame
    // are same-origin we can reach into contentDocument directly; cross-origin frames
    // throw on access and we fall through to the normal waterfall below.
    try {
      const icimsFrame = document.querySelector('iframe#icims_content_iframe');
      if (icimsFrame && icimsFrame.contentDocument) {
        const inner = icimsFrame.contentDocument.querySelector('.iCIMS_JobContent, .iCIMS_JobContainer, body');
        const innerText = inner && inner.innerText;
        if (innerText) text = innerText.trim();
      }
    } catch (_) {
      // cross-origin iframe — nothing accessible, fall through
    }

    if (!text && siteSelector) text = readSelectorText(siteSelector);
    if (!text) text = readSelectorText(GENERIC_SELECTOR);
    if (!text) text = ((document.body && document.body.innerText) || '').trim();

    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  // Greenhouse job boards are commonly embedded into a company's own careers page
  // via a cross-origin <iframe src="https://boards.greenhouse.io/embed/job_app?...">.
  // body.innerText on the host page never sees the iframe's content, so the scraped
  // text is just the company shell with no role info. We can't read the cross-origin
  // frame, but we CAN read the board token and job id from the top-frame DOM/URL and
  // hand them to the background worker, which fetches the real JD from Greenhouse's
  // public JSON API. Returns { boardToken, jobId } or null.
  function getGreenhouseEmbedRef() {
    let boardToken = null;
    let jobId = null;

    // Job id: ?gh_jid=... on the host page URL is the canonical signal.
    try {
      jobId = new URLSearchParams(window.location.search).get('gh_jid') || null;
    } catch (_) { /* malformed search string */ }

    // Board token: the embed loader script carries ?for=<token>.
    const script = document.querySelector(
      'script[src*="greenhouse.io/embed/job_board/js"], script[src*="greenhouse.io/embed/job_board"]'
    );
    if (script && script.src) {
      const m = script.src.match(/[?&]for=([^&]+)/);
      if (m) { try { boardToken = decodeURIComponent(m[1]); } catch (_) { boardToken = m[1]; } }
    }

    // Fallback / also fills job id: the embed iframe src carries both for= and token=.
    // iframe.src is a plain string attribute — readable even though the frame is
    // cross-origin (we only read the attribute, never contentDocument).
    const iframe = document.querySelector(
      'iframe#grnhse_iframe, iframe[src*="greenhouse.io/embed/job_app"]'
    );
    if (iframe && iframe.src) {
      try {
        const u = new URL(iframe.src, window.location.href);
        if (!boardToken) boardToken = u.searchParams.get('for');
        if (!jobId) jobId = u.searchParams.get('token');
      } catch (_) { /* unparseable iframe src */ }
    }

    if (boardToken && jobId) return { boardToken, jobId };
    return null;
  }

  function onCheckClick() {
    setLoading('Checking JD…');
    startPendingTimeout(60);
    safeSendMessage(
      {
        type: 'CHECK_JD',
        text: getPageText(20000),
        url: window.location.href,
        greenhouseRef: getGreenhouseEmbedRef()
      },
      (resp, err) => {
        clearPendingTimeout();
        if (err) { setError(err.message); return; }
        if (!resp || !resp.success) { setError(resp?.error || 'Unknown error.'); return; }
        setDecision(resp);
      }
    );
  }

  function onLogClick(role) {
    const label = role === 'fulltime' ? 'full-time' : 'intern';
    setLoading(`Logging ${label} job…`);
    startPendingTimeout(120);
    safeSendMessage(
      {
        type: 'LOG_JOB',
        role,
        text: getPageText(15000),
        url: window.location.href,
        greenhouseRef: getGreenhouseEmbedRef()
      },
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'TOGGLE') {
      toggleOverlay();
      // Respond synchronously so the sender's awaited promise resolves with
      // { ok: true } instead of rejecting on port-closed in MV3 — preventing
      // background.js from interpreting "no response" as "no receiver" and
      // re-injecting + sending a second TOGGLE that cancels the first.
      try { sendResponse({ ok: true }); } catch (_) { /* sender already gone */ }
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.resumes || changes.activeResumeId) {
      if (root && root.getAttribute('data-jf-hidden') !== 'true') refreshResumeLabel();
    }
  });

  // Build the overlay hidden; visibility is per-tab and only flips when the user
  // clicks the toolbar icon (which fires a TOGGLE message to this tab).
  createOverlay();
})();
