const GEMINI_MODEL_DEFAULT = 'gemini-3.1-flash-lite-preview';
const geminiEndpoint = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

const apiKeyInput = document.getElementById('geminiApiKey');
const modelInput = document.getElementById('geminiModel');
const sheetIdInput = document.getElementById('sheetId');
const sheetTabNameInput = document.getElementById('sheetTabName');
const saveBtn = document.getElementById('saveConfig');
const configToast = document.getElementById('configToast');

const resumeListEl = document.getElementById('resumeList');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const uploadStatus = document.getElementById('uploadStatus');
const uploadStatusText = uploadStatus.querySelector('.upload-status-text');
const uploadError = document.getElementById('uploadError');

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (i) => resolve(i || {})));
}
function setStorage(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
}

function showToast(el, message, isError) {
  el.textContent = message;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

function showUploadError(message) {
  uploadError.textContent = message;
  uploadError.hidden = false;
}
function clearUploadError() {
  uploadError.hidden = true;
  uploadError.textContent = '';
}

async function loadConfig() {
  const { geminiApiKey, geminiModel, sheetId, sheetTabName } = await getStorage([
    'geminiApiKey', 'geminiModel', 'sheetId', 'sheetTabName'
  ]);
  if (geminiApiKey) apiKeyInput.value = geminiApiKey;
  if (geminiModel) modelInput.value = geminiModel;
  if (sheetId) sheetIdInput.value = sheetId;
  if (sheetTabName) sheetTabNameInput.value = sheetTabName;
}

saveBtn.addEventListener('click', async () => {
  const geminiApiKey = apiKeyInput.value.trim();
  const geminiModel = modelInput.value.trim();
  const sheetId = sheetIdInput.value.trim();
  const sheetTabName = sheetTabNameInput.value.trim();
  await setStorage({ geminiApiKey, geminiModel, sheetId, sheetTabName });
  showToast(configToast, 'Saved ✓', false);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderResumes(resumes, activeId) {
  if (!resumes.length) {
    resumeListEl.innerHTML = `<div class="resume-empty">No resumes uploaded yet. Drop a PDF below to get started.</div>`;
    return;
  }
  const single = resumes.length === 1;
  resumeListEl.innerHTML = resumes.map((r) => {
    const isActive = r.id === activeId;
    const tokens = Math.round((r.charCount || 0) / 4);
    const deleteDisabled = isActive || single;
    return `
      <div class="resume-card${isActive ? ' is-active' : ''}">
        <div class="resume-info">
          <div class="resume-name">${escapeHtml(r.name)}</div>
          <div class="resume-meta">Uploaded ${escapeHtml(r.uploadDate || '')} · ~${tokens.toLocaleString()} tokens</div>
        </div>
        <div class="resume-actions">
          ${isActive
            ? `<span class="badge-active">Active</span>`
            : `<button class="btn outline" data-set-active="${escapeHtml(r.id)}" type="button">Set Active</button>`}
          <button
            class="btn-delete"
            data-delete="${escapeHtml(r.id)}"
            type="button"
            title="${deleteDisabled ? (isActive ? 'Cannot delete the active resume' : 'Cannot delete the only resume') : 'Delete'}"
            ${deleteDisabled ? 'disabled' : ''}
          >&times;</button>
        </div>
      </div>
    `;
  }).join('');

  resumeListEl.querySelectorAll('[data-set-active]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-set-active');
      await setStorage({ activeResumeId: id });
      await refreshResumes();
    });
  });
  resumeListEl.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const id = btn.getAttribute('data-delete');
      const { resumes: current = [], activeResumeId } = await getStorage(['resumes', 'activeResumeId']);
      const next = current.filter((r) => r.id !== id);
      const update = { resumes: next };
      if (id === activeResumeId) {
        update.activeResumeId = next[0]?.id || '';
      }
      await setStorage(update);
      await refreshResumes();
    });
  });
}

async function refreshResumes() {
  const { resumes = [], activeResumeId } = await getStorage(['resumes', 'activeResumeId']);
  renderResumes(resumes, activeResumeId);
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || '';
      const idx = String(result).indexOf('base64,');
      if (idx === -1) {
        reject(new Error('Failed to read file as base64.'));
        return;
      }
      resolve(String(result).slice(idx + 'base64,'.length));
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader error.'));
    reader.readAsDataURL(file);
  });
}

async function parseResumeWithGemini(apiKey, model, base64) {
  const url = `${geminiEndpoint(model)}?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'application/pdf', data: base64 } },
        { text: 'Extract all relevant information from this resume for job matching: full name, skills, tech stack, education, visa/work authorization status, experience level, notable projects. Return as clean plain text, optimized for use as context in job screening prompts.' }
      ]
    }]
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let msg = `Gemini API error ${res.status}`;
    try {
      const j = JSON.parse(errText);
      if (j?.error?.message) msg = j.error.message;
    } catch (_) {
      if (errText) msg += `: ${errText.slice(0, 300)}`;
    }
    throw new Error(msg);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text content.');
  return text.trim();
}

async function handleFile(file) {
  clearUploadError();
  if (!file) return;
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    showUploadError('Only PDF files are supported.');
    return;
  }
  const { geminiApiKey, geminiModel } = await getStorage(['geminiApiKey', 'geminiModel']);
  if (!geminiApiKey) {
    showUploadError('Set your Gemini API key above and click Save first.');
    return;
  }
  const model = (geminiModel || '').trim() || GEMINI_MODEL_DEFAULT;

  uploadStatus.hidden = false;
  uploadStatusText.textContent = `Parsing ${file.name}…`;
  dropZone.style.pointerEvents = 'none';

  try {
    const base64 = await readFileAsBase64(file);
    const parsedText = await parseResumeWithGemini(geminiApiKey, model, base64);
    const newResume = {
      id: crypto.randomUUID(),
      name: file.name,
      parsedText,
      uploadDate: new Date().toLocaleDateString(),
      charCount: parsedText.length
    };
    const { resumes = [], activeResumeId } = await getStorage(['resumes', 'activeResumeId']);
    const nextResumes = [...resumes, newResume];
    const update = { resumes: nextResumes };
    if (!resumes.length || !activeResumeId) update.activeResumeId = newResume.id;
    await setStorage(update);
    await refreshResumes();
  } catch (e) {
    showUploadError(e.message || String(e));
  } finally {
    uploadStatus.hidden = true;
    dropZone.style.pointerEvents = '';
    fileInput.value = '';
  }
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) handleFile(f);
});

['dragenter', 'dragover'].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('is-drag');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('is-drag');
  });
});
dropZone.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.resumes || changes.activeResumeId) refreshResumes();
});

loadConfig();
refreshResumes();
