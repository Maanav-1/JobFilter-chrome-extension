const GEMINI_MODEL_DEFAULT = 'gemini-3.1-flash-lite';
const geminiEndpoint = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

function buildCheckJdSystem(resumeProfile) {
  return `You are an expert technical recruiter screening a job description for a specific candidate. Reason about fit the way an experienced engineering recruiter would — scan for blockers first, weigh actual technical overlap second, output one decision. Do not run a shallow keyword check.

CANDIDATE PROFILE
${resumeProfile}

WORK AUTHORIZATION CONTEXT
- F-1 visa, currently CPT-eligible. CPT is a valid US work authorization issued by the school for internships and co-ops; it does NOT require any employer-sponsored petition. Generic "must be authorized to work in the US" is satisfied by CPT and is NOT a blocker. Treat work-authorization language as a blocker ONLY when the JD explicitly rules out F-1 / CPT / OPT or requires authorization "now and in the future without sponsorship" (see HARD SKIP 2).

HARD SKIP — output "Skip" immediately if ANY of these are present:
1. CITIZENSHIP / CLEARANCE: requires US Citizenship, US Permanent Residency, Active Security Clearance, Public Trust, or mentions ITAR / Export Control restrictions.
2. NO SPONSORSHIP: JD explicitly says "no sponsorship", "does not sponsor F-1 / OPT / CPT", "must be authorized to work in the US now and in the future without sponsorship", or equivalent forward-looking sponsorship exclusion. Generic "must be authorized to work in the US" alone is NOT a blocker — CPT covers it.
3. SENIORITY: clearly a mid / senior / staff / principal role requiring 3+ years of full-time post-graduation industry experience. New-grad and intern roles do not count even if they list "experience preferred".
4. UNPAID: explicitly described as unpaid, volunteer, or strictly for academic credit only.
5. LOCATION: role is based entirely outside the United States (e.g. India-only, EMEA-only, APAC-only). Remote-USA, hybrid-USA, and unspecified locations are fine.

SOFT SKIP — output "Skip" if the role is fundamentally outside the candidate's technical lane:
6. WRONG STACK: the core required stack is a language or ecosystem with no realistic overlap with the candidate's profile — e.g. .NET / C#, Ruby on Rails, PHP / Laravel, Swift / iOS native, Kotlin / Android native, SAP / ABAP, Salesforce / Apex, COBOL / mainframe, bare-metal embedded C / firmware, MATLAB / Simulink as the primary stack. A single passing mention is NOT a skip — only skip when the listed stack is unambiguously the role's center of gravity.
7. NON-TECHNICAL ROLE: the role is digital marketing, SEO, copywriting, content design, sales, recruiting, HR, finance / accounting, business analyst, non-engineering product management, UX research, or customer success — anything that does not involve building or shipping software / ML systems.
8. WRONG DOMAIN: hardware-heavy or non-software engineering — mechanical, civil / structural, biomedical hardware, electrical / circuit design, chemistry / wet-lab, manufacturing process, BIM / CAD / Revit / AutoCAD, GIS as the primary discipline (not "consumes GIS data"). Skip even if Python is mentioned, because the day-to-day work is not software engineering.

APPLY — output "Apply" when ALL of these hold:
- The role is a software engineering / SDE / full-stack / backend / frontend / ML / AI / data-engineering / platform / infra / research-engineering INTERNSHIP, co-op, or new-grad position.
- None of HARD SKIP 1–5 fire.
- The required stack has any realistic overlap with the candidate — even partial. Backend Java / Python / TypeScript / React / SQL / NoSQL / AWS / Azure, RAG / LLM / embeddings / vector DB work, and CV (YOLO / MediaPipe) work all count. Entry-level roles with "we will teach you the stack" or no fixed stack also count.

REASONING & OUTPUT REQUIREMENTS
- Name the specific blocker or the specific fit reason. Use the actual technology, clause, or domain word — e.g. "Requires active Secret clearance and US citizenship", ".NET / C# core stack, no Java overlap", "Mechanical engineering co-op, CAD-focused", "Backend Python + AWS internship, strong overlap with Spring Boot and FastAPI".
- Never use vague phrases like "severe mismatch", "doesn't fit", "not a good match", or "stack misaligned". Always name what specifically does not fit.
- Maximum 20 words in the reason field.

OUTPUT FORMAT
Respond with ONLY a single valid JSON object. No prose before or after. No markdown. No code fences. No backticks.
{"decision": "Apply" | "Skip", "reason": "specific reason naming the blocker or fit, max 20 words"}`;
}

const LOG_JOB_SYSTEM = `Extract job details from this page. Respond ONLY with valid JSON, no markdown, no backticks:
{"company": "string", "title": "string", "notes": "string (req ID if found, or internship term, or empty string)"}`;

function stripFences(text) {
  if (!text) return '';
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  return t;
}

function extractJsonObject(text) {
  const stripped = stripFences(text);
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    return stripped.slice(first, last + 1);
  }
  return stripped;
}

async function callGemini(apiKey, model, systemInstruction, userText) {
  const url = `${geminiEndpoint(model)}?key=${encodeURIComponent(apiKey)}`;
  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }]
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no text content.');
  return text;
}

async function callGeminiJsonWithRetry(apiKey, model, systemInstruction, userText) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try {
      raw = await callGemini(apiKey, model, systemInstruction, userText);
    } catch (e) {
      if (attempt === 1) throw e;
      continue;
    }
    try {
      return JSON.parse(extractJsonObject(raw));
    } catch (_) {
      if (attempt === 1) {
        throw new Error('Could not parse response. Try again.');
      }
    }
  }
  throw new Error('Could not parse response. Try again.');
}

function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (items) => resolve(items || {}));
  });
}

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'Failed to get auth token.'));
        return;
      }
      resolve(token);
    });
  });
}

function todayMMDDYYYY() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function colIndexToA1(idx) {
  let s = '';
  let n = idx;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function quoteSheetTitle(title) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(title)
    ? title
    : `'${String(title).replace(/'/g, "''")}'`;
}

async function fetchSpreadsheetMeta(token, sheetId) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets(properties(title),tables)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    let msg = `Sheets metadata fetch failed (${res.status})`;
    try {
      const j = JSON.parse(errBody);
      if (j?.error?.message) msg = j.error.message;
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

function findTableRange(meta, tableName) {
  const target = String(tableName).trim().toLowerCase();
  const tablesSeen = [];
  for (const sheet of (meta?.sheets || [])) {
    const sheetTitle = sheet?.properties?.title || '';
    for (const t of (sheet?.tables || [])) {
      const tName = t?.name || t?.displayName || '';
      if (tName) tablesSeen.push(tName);
      if (tName.toLowerCase() === target) {
        const r = t?.range || {};
        const sCol = r.startColumnIndex ?? 0;
        const eCol = (r.endColumnIndex ?? (sCol + 1)) - 1;
        const sRow = (r.startRowIndex ?? 0) + 1;
        const eRow = r.endRowIndex ?? sRow;
        return {
          range: `${quoteSheetTitle(sheetTitle)}!${colIndexToA1(sCol)}${sRow}:${colIndexToA1(eCol)}${eRow}`,
          tablesSeen
        };
      }
    }
  }
  return { range: null, tablesSeen };
}

async function handleCheckJd(payload) {
  const { geminiApiKey, geminiModel, activeResumeId, resumes } = await getStorage([
    'geminiApiKey', 'geminiModel', 'activeResumeId', 'resumes'
  ]);
  if (!geminiApiKey) {
    return { success: false, error: 'Set your API key in Options (right-click extension icon → Options)' };
  }
  if (!resumes || !resumes.length) {
    return { success: false, error: 'Upload a resume in Options first' };
  }
  const active = resumes.find((r) => r.id === activeResumeId) || resumes[0];
  if (!active || !active.parsedText) {
    return { success: false, error: 'No active resume selected. Open the overlay menu or Options to pick one.' };
  }
  const model = (geminiModel || '').trim() || GEMINI_MODEL_DEFAULT;
  const jdText = (payload.text || '').slice(0, 12000);
  const systemPrompt = buildCheckJdSystem(active.parsedText);
  const userMsg = `Here is the Job Description:\n${jdText}`;
  try {
    const parsed = await callGeminiJsonWithRetry(geminiApiKey, model, systemPrompt, userMsg);
    return { success: true, ...parsed };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
}

async function handleLogJob(payload) {
  const { geminiApiKey, geminiModel, sheetId, sheetTableName } = await getStorage([
    'geminiApiKey', 'geminiModel', 'sheetId', 'sheetTableName'
  ]);
  if (!geminiApiKey) {
    return { success: false, error: 'Set your API key in Options (right-click extension icon → Options)' };
  }
  if (!sheetId) {
    return { success: false, error: 'Set your Sheet ID in Options first' };
  }
  const model = (geminiModel || '').trim() || GEMINI_MODEL_DEFAULT;
  const tableName = (sheetTableName || '').trim();
  const pageText = (payload.text || '').slice(0, 8000);

  // Run Gemini extraction concurrently with Sheets context setup (auth → metadata → range).
  // Both legs are independent; the final values:append needs results from both, so we
  // gate on Promise.all.
  const geminiPromise = callGeminiJsonWithRetry(geminiApiKey, model, LOG_JOB_SYSTEM, pageText)
    .catch((e) => { throw new Error(`Job extraction failed: ${e.message || e}`); });

  const sheetsContextPromise = (async () => {
    let token;
    try {
      token = await getAuthToken(true);
    } catch (e) {
      throw new Error(`Google sign-in failed: ${e.message || e}`);
    }
    let range = 'A:F';
    if (tableName) {
      let meta;
      try {
        meta = await fetchSpreadsheetMeta(token, sheetId);
      } catch (e) {
        throw new Error(`Could not read spreadsheet metadata: ${e.message || e}`);
      }
      const lookup = findTableRange(meta, tableName);
      if (!lookup.range) {
        const list = lookup.tablesSeen.length
          ? ` Found tables: ${lookup.tablesSeen.join(', ')}.`
          : ' This spreadsheet has no named Tables. (Sheets → select your table → click the table icon to name it.)';
        throw new Error(`Table "${tableName}" not found.${list}`);
      }
      range = lookup.range;
    }
    return { token, range };
  })();

  let extracted;
  let sheetsContext;
  try {
    [extracted, sheetsContext] = await Promise.all([geminiPromise, sheetsContextPromise]);
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
  const { token, range } = sheetsContext;

  const company = String(extracted.company || '').trim();
  const title = String(extracted.title || '').trim();
  const notes = String(extracted.notes || '').trim();
  const date = todayMMDDYYYY();
  const url = payload.url || '';

  const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(sheetUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values: [[company, title, date, 'Applied', url, notes]] })
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    let msg = `Sheets API error ${res.status}`;
    try {
      const j = JSON.parse(errBody);
      if (j?.error?.message) msg = j.error.message;
    } catch (_) {
      if (errBody) msg += `: ${errBody.slice(0, 300)}`;
    }
    return { success: false, error: msg };
  }
  let updatedRange = '';
  try {
    const j = await res.json();
    updatedRange = j?.updates?.updatedRange || '';
  } catch (_) { /* response body parse failure is non-fatal */ }
  return { success: true, company, title, date, notes, updatedRange, requestedRange: range };
}

// Toolbar click toggles the overlay only on the active tab.
//
// Fast path: ping the content script with a TOGGLE message; if it answers, done.
// Fallback: on heavy-React pages (e.g. job-boards.greenhouse.io) the page can stay
// main-thread-busy long enough that Chrome never fires document_idle, so the
// content script never auto-injects. When the ping fails with "Receiving end
// does not exist", we explicitly inject content.css + content.js via
// chrome.scripting and retry TOGGLE. The injectImmediately flag is critical
// here: without it, chrome.scripting.executeScript also defaults to
// document_idle, which would stall on the same heuristic that prevented the
// initial auto-injection.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE' });
    return;
  } catch (e) {
    // Only fall through to on-demand injection when the error is specifically
    // "no receiver". Any other error (notably "The message port closed before
    // a response was received") means the content script IS there and almost
    // certainly already handled the TOGGLE — re-injecting and re-sending would
    // fire a SECOND TOGGLE that cancels the first, making the overlay look
    // like it never opened.
    const msg = (e && e.message) || '';
    const noReceiver = /Receiving end does not exist|Could not establish connection/i.test(msg);
    if (!noReceiver) {
      // Content script handled TOGGLE; we just didn't get a clean response.
      // Nothing more to do — bail out without re-injecting.
      return;
    }
  }
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
      injectImmediately: true
    });
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE' });
  } catch (e) {
    // Restricted page (chrome://, Web Store, view-source:) or an injection
    // error — surface it in the service-worker log so we can diagnose.
    console.warn('[JobFilter] On-demand injection failed:', e?.message || e);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'CHECK_JD') {
    handleCheckJd(msg).then(sendResponse).catch((e) =>
      sendResponse({ success: false, error: e.message || String(e) })
    );
    return true;
  }
  if (msg.type === 'LOG_JOB') {
    handleLogJob(msg).then(sendResponse).catch((e) =>
      sendResponse({ success: false, error: e.message || String(e) })
    );
    return true;
  }
  return false;
});
