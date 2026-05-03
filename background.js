const GEMINI_MODEL_DEFAULT = 'gemini-3.1-flash-lite-preview';
const geminiEndpoint = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

const CHECK_JD_SYSTEM = `You are an expert technical recruiter evaluating a job description against a candidate's resume.
CANDIDATE PROFILE: The candidate is an international student on an F-1 Visa (requires CPT/OPT/H1-B).
HARD SKIP CONDITIONS (Output "Skip" immediately if ANY are met):
1. VISA/CLEARANCE: JD requires US Citizenship, Security Clearance, or mentions ITAR / Export Control.
2. SPONSORSHIP: JD explicitly states "no sponsorship provided", "does not sponsor F-1/OPT/CPT", or "must be authorized to work in the US without future sponsorship".
3. EXPERIENCE LEVEL: JD is clearly for a Mid-Senior level role requiring 3+ years of full-time, post-grad industry experience.
TECH STACK MATCH (Output "Skip" if):
4. There is a severe mismatch between the core technologies required in the JD and the candidate's resume.
If the JD is entry-level/internship, does not restrict F-1 visas, and has reasonable tech stack overlap, output "Apply".
OUTPUT FORMAT: Respond ONLY with a valid JSON object. No markdown or backticks.
{"decision": "Apply" | "Skip", "reason": "One short sentence explaining why, max 15 words."}`;

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
  const userMsg = `Here is my active resume:\n${active.parsedText}\n\nHere is the Job Description:\n${jdText}`;
  try {
    const parsed = await callGeminiJsonWithRetry(geminiApiKey, model, CHECK_JD_SYSTEM, userMsg);
    return { success: true, ...parsed };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
}

async function handleLogJob(payload) {
  const { geminiApiKey, geminiModel, sheetId, sheetTabName } = await getStorage([
    'geminiApiKey', 'geminiModel', 'sheetId', 'sheetTabName'
  ]);
  if (!geminiApiKey) {
    return { success: false, error: 'Set your API key in Options (right-click extension icon → Options)' };
  }
  if (!sheetId) {
    return { success: false, error: 'Set your Sheet ID in Options first' };
  }
  const model = (geminiModel || '').trim() || GEMINI_MODEL_DEFAULT;
  const tabName = (sheetTabName || '').trim();
  const range = tabName ? `${tabName}!A:F` : 'A:F';
  const pageText = (payload.text || '').slice(0, 8000);
  let extracted;
  try {
    extracted = await callGeminiJsonWithRetry(geminiApiKey, model, LOG_JOB_SYSTEM, pageText);
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
  const company = String(extracted.company || '').trim();
  const title = String(extracted.title || '').trim();
  const notes = String(extracted.notes || '').trim();
  const date = todayMMDDYYYY();
  const url = payload.url || '';

  let token;
  try {
    token = await getAuthToken(true);
  } catch (e) {
    return { success: false, error: `Google sign-in failed: ${e.message}` };
  }

  const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
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
  return { success: true, company, title, date, notes };
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE' }, () => {
    if (chrome.runtime.lastError) {
      // Content script may not be loaded on this tab (e.g. chrome:// pages). Silently ignore.
      void chrome.runtime.lastError;
    }
  });
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
