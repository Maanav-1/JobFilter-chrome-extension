# JobFilter

A Chrome Extension (Manifest V3) that screens job descriptions against your resume and logs applications to a Google Sheet — without leaving the page you're on.

A floating, draggable overlay is injected into every tab. Two buttons:

- **Check this JD** — sends the page's job description and your active resume to Gemini, returns an Apply / Skip verdict against a fixed set of hard-skip rules (visa requirements, sponsorship language, seniority mismatch, unpaid/volunteer roles, severe tech-stack mismatch).
- **Log application** — extracts company / title / notes from the page and appends a row to a named Table in your Google Sheet.

No build step. Plain HTML / CSS / vanilla JS. No external runtime dependencies.

---

## Features

- Floating overlay on every page; draggable, position persisted. Visibility is per-tab — clicking the toolbar icon toggles the overlay on the active tab only.
- Site-aware DOM scraping for LinkedIn, Workday, Greenhouse, Lever, Symplicity, with a generic fallback — only the job posting body is sent to the model, not nav/footer/related jobs.
- Resume manager: drag-and-drop PDF upload, parsed via Gemini's `inline_data` PDF input, multiple resumes supported with one active at a time. The active resume can be switched directly from the overlay.
- Sheets append targets a named Sheets-native Table by name. Resolves the table to its current A1 range via the Spreadsheet metadata API and uses `insertDataOption=INSERT_ROWS` so the row joins the table cleanly via auto-extension.
- Gemini extraction and Google Sheets context setup (auth + metadata + range resolution) run concurrently per log; `Promise.all` gates the final append.
- Robust against extension reloads — content script detects orphaned context and surfaces a clear "refresh this page" message instead of hanging the spinner. Hard timeouts on every action.

---

## File structure

```
chrome-extension/
├── manifest.json     # MV3 manifest, OAuth client ID, host permissions
├── background.js     # service worker; Gemini + Sheets API; toolbar click handler
├── content.js        # injected overlay UI + DOM scraping
├── content.css       # scoped overlay styles, light/dark via prefers-color-scheme
├── options.html      # settings page
├── options.js        # config save/load + resume upload (PDF → Gemini → text)
├── options.css
├── icons/
│   └── icon128.png
└── README.md
```

---

## Setup

### 1. Google Cloud — OAuth client for Sheets

1. <https://console.cloud.google.com/> → create or select a project.
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → OAuth consent screen** → User type: **External** → fill app name and support email → add scope `https://www.googleapis.com/auth/spreadsheets` → add yourself as a Test user. (Keep publishing status as **Testing**; Google verification is not needed for personal use.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Chrome Extension**
   - Item ID: leave blank for now (filled in step 3)

### 2. Load the unpacked extension

1. `chrome://extensions` → toggle **Developer mode**.
2. **Load unpacked** → select this folder.
3. Copy the **Extension ID** (32 lowercase letters) from the JobFilter card.

### 3. Wire the Extension ID into Google Cloud

1. Back in Google Cloud Credentials → paste the Extension ID into the OAuth client's **Item ID** field → **Create** → copy the **Client ID**.
2. Open `manifest.json` and put the client ID into `oauth2.client_id`.
3. `chrome://extensions` → JobFilter → reload.

### 4. Get a Gemini API key

1. <https://aistudio.google.com/app/apikey> → **Create API key** → copy.

### 5. Create the Google Sheet

1. Create a sheet at <https://sheets.google.com>.
2. Add headers in row 1 (suggested): `Company | Title | Date | Status | URL | Notes`.
3. Select the header row + a few data rows → **Format → Convert to table** → name the table (e.g. `Table3`). The append targets this named Table.
4. Copy the Sheet ID from the URL (the long string between `/d/` and `/edit`).

### 6. Configure the extension

1. Right-click the JobFilter icon → **Options**.
2. Fill in:
   - **Gemini API key**
   - **Gemini model** (default: `gemini-3.1-flash-lite-preview`; leave blank to use the default)
   - **Google Sheet ID**
   - **Table name** (e.g. `Table3` — must match the Sheets-native Table name exactly, case-sensitive)
3. Save.
4. Drop your **resume PDF** into the upload zone. It auto-becomes active.

---

## Usage

- Click the toolbar icon to toggle the overlay on the active tab. Visibility is local to each tab — opening it on one tab does not show it on others.
- Drag from the 6-dot handle to reposition; the position is saved.
- Click the resume label at the bottom of the overlay to switch which resume is active.

### Check this JD
Sends a trimmed extract of the page (~12 KB) plus the active resume's parsed text to Gemini, returns:

- **APPLY** — entry-level / internship, no visa restrictions, reasonable tech overlap.
- **SKIP** — one of the hard-skip rules fired:
  1. US Citizenship / Security Clearance / ITAR / Export Control
  2. Explicit no-sponsorship language
  3. Mid-Senior level (3+ years post-grad)
  4. Unpaid / volunteer / for-academic-credit only
  5. Severe tech stack mismatch

Result is shown in the overlay and persists until the next action.

### Log application
1. Gemini extracts `{company, title, notes}` from the page.
2. JobFilter authenticates with Google (first time only — token is cached after).
3. The named Table is resolved via `GET /v4/spreadsheets/{id}?fields=sheets(properties(title),tables)`.
4. The row `[company, title, today (MM/DD/YYYY), "Applied", url, notes]` is inserted at the table's lower boundary.
5. Confirmation card shows the target cell, e.g. `'2026'!A12:F12`. Auto-clears after 5s.

---

## Configuration / storage schema

Everything lives in `chrome.storage.local`:

```js
{
  geminiApiKey: "string",
  geminiModel: "string",          // optional; defaults to gemini-3.1-flash-lite-preview
  sheetId: "string",
  sheetTableName: "string",       // name of a Sheets-native Table
  resumes: [
    { id, name, parsedText, uploadDate, charCount }
  ],
  activeResumeId: "string",
  overlayPosition: { x, y } | null
}
```

---

## Architecture notes

- **No build step.** Plain MV3 — the folder loads directly via `chrome://extensions → Load unpacked`.
- **Service worker** (`background.js`) handles every external API call. Gemini uses an API key in the URL; Sheets uses an OAuth bearer token from `chrome.identity.getAuthToken`.
- **Content script** (`content.js`) is a single IIFE with a `window.__jfOverlayInjected` guard — safe to be loaded once per page even on SPA route changes. All `chrome.*` calls are wrapped to handle the "extension context invalidated" case after a developer reload.
- **Overlay visibility is per-tab.** A toolbar click sends `{ type: 'TOGGLE' }` to the active tab via `chrome.tabs.sendMessage`; the content script flips its local DOM state. `chrome.runtime.lastError` is swallowed for tabs without a content script (chrome://, the Web Store, etc.). No global visibility flag in storage.
- **JD scraping** uses a hostname-keyed selector waterfall (LinkedIn → Workday → Greenhouse → Lever → Symplicity → generic `main` / `[role=main]` → fallback to `document.body.innerText`). Trims to 12 KB for Check JD, 8 KB for Log Job before going to Gemini.
- **Sheets append** runs in parallel with Gemini extraction via `Promise.all`. The named-Table lookup converts the table's `GridRange` to A1 notation so `values:append` can target it (the values endpoint does not understand raw Table names — only A1 ranges and named ranges).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Access blocked: JobFilter has not completed verification` | Your OAuth consent screen is in Testing mode and your account isn't a test user | Google Cloud → OAuth consent screen → add your email under Test users |
| `models/<name> is not found for API version v1beta` | Wrong Gemini model ID | List models with `curl "https://generativelanguage.googleapis.com/v1beta/models?key=KEY"` and paste a valid one in Options |
| `Unable to parse range: Table3` | Targeting a Sheets-native Table by name without resolution | Already handled in `background.js` — confirm the Table name matches exactly (case-sensitive) |
| Spinner hangs after clicking Log application | Content script orphaned by an extension reload | Refresh the tab. The script now detects this state and surfaces a clear error |
| Append lands far below your table (e.g. row 259) | Stray data anywhere in the tab's columns | Either clean up via Ctrl+End, or rely on the Table name resolution which targets the table's exact bounds |
| `Google sign-in failed` | OAuth token expired / revoked | `chrome://extensions` → reload the extension, then click Log application again to re-consent |

To clear a stuck token:
```js
chrome.identity.clearAllCachedAuthTokens(() => console.log('cleared'))
```
Run that in the extension service worker console (`chrome://extensions` → JobFilter → "service worker" link).

---

## API quotas

- **Sheets API**: 300 req/min/project, 60 read/write per user/min, no daily cap. Each Log Application uses 2 Sheets calls (metadata GET + values:append). Personal use will not approach the limit.
- **Gemini Flash Lite (free tier)**: ~15 req/min and a per-day cap (~1k–1.5k depending on Google's current policy). Each Check JD or Log Application uses 1 Gemini call. If you hit the cap, enable billing on the Cloud project — Flash Lite is essentially free at personal-use volume.
