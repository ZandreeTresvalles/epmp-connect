# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

EPMP Connect is a **Manifest V3 Chrome extension** (plain JS, no framework) that
captures an authenticated Shopee / Lazada / TikTok Seller Center session and
uploads it to a project backend as a Playwright `storageState`. It is the single
shared capture extension for three sibling projects — **epmp**, **encoder-reports
(ReportBot)**, and **audit-reports** — which previously each shipped their own copy.

It does **not** automate login. A human logs in normally (real browser, real IP,
own 2FA); the extension only reads the resulting cookies + `localStorage` and POSTs
them with a one-time capture token.

## No toolchain

There is no build, lint, test, or package step — no `package.json`, no bundler.
The repo is loaded directly as an unpacked extension.

- **Load / run:** `chrome://extensions` → enable Developer mode → **Load unpacked** →
  select this folder. Confirm the extension ID is `gbkihcopmoldfdmponifjffomhhdaplp`.
- **After editing any file:** click the extension's **reload** icon on
  `chrome://extensions` (a content-script/manifest change also needs a page reload).
- **Debug:** service worker logs via the "service worker" link on the extensions
  page; `bridge.js`/`banner.js` (ISOLATED) log to the page console; `interceptor.js`
  (MAIN) also logs to the page console.

The pinned `manifest.json` `key` is what keeps the extension ID stable across
machines — do **not** change it. The in-app **Authenticate** button detects the
extension by that fixed ID. The matching private signing key is not in this repo.

## Architecture

Everything routes through `background.js` (the service worker), which is the single
capture engine. The other files are thin edges that talk to it.

**Two capture flows, one upload contract:**

1. **Bridge flow** (app-initiated): a project web app posts a message → `bridge.js`
   relays it to `background.js` → `startCapture()` opens the platform login tab and
   stores a per-tab context → `onUpdated` injects `banner.js` → operator logs in and
   clicks **Capture Session** → `captureFromTab()` reads cookies + localStorage and
   uploads.
2. **Popup flow** (manual fallback): operator opens the Seller Center tab, opens the
   toolbar popup (`popup.html`/`popup.js`), pastes the token → `CAPTURE_ACTIVE_TAB`
   → same `captureFromTab()`.

**Dual-dialect contract — the central design constraint.** So no frontend had to
change when the three extensions merged, both `background.js` and `bridge.js` speak
**two message dialects** for every operation and treat them as synonyms:

- **liveness** — EPMP `ping` → `pong`; ReportBot `PING`
- **app → ext capture** — EPMP `capture` → `capture-ack`; ReportBot `REQUEST_CAPTURE`
- **banner button** — EPMP `capture-now`; ReportBot `DO_CAPTURE`

`startCapture()` normalizes the two payload shapes (`token`/`captureToken`,
`uploadUrl`/`backendUrl`) into one internal context. If you add an operation, wire
**both** dialect names or one frontend breaks.

**Content-script worlds (both declared in `manifest.json`):**

- `bridge.js` — ISOLATED world, on the three frontend Vercel origins + localhost.
  It only relays messages that carry a known tag AND come from `window` itself, so
  arbitrary sites can't drive the extension. **Add a new frontend origin here** (and
  in `content_scripts`) for a new project to use the in-app button.
- `interceptor.js` — MAIN world, `document_start`, on Seller Center hosts. It
  monkey-patches `fetch`/`XHR` to passively record product-list API responses into
  `window.__epmpProductCapture`. Purely best-effort telemetry for EPMP's optional
  catalog-endpoint discovery — it must never disturb the page.

**Upload contract** (all backends agree): `POST {origin}/api/v1/automation/sessions`
with `Authorization: Bearer <one-time-token>` and body `{ storageState, ...optional }`.
`resolveUploadUrl()` normalizes a bare origin, a `/api` base, or a full upload URL to
that same endpoint — callers may pass any of the three.

**Per-tab capture context** lives in `chrome.storage.session` (keyed `ctx_<tabId>`)
so it survives service-worker restarts; it's cleared on capture success or tab close.

## Conventions & gotchas

- **No baked-in backend URL** — this is a public repo. The popup requires the
  operator to enter the backend base URL once (saved to `chrome.storage.local`); the
  bridge flow gets the URL from the calling web app. Never hard-code an environment
  hostname.
- **Cookie collection is by broad registrable domain** (`PLATFORM_COOKIE_DOMAINS`),
  not per-host: `chrome.cookies.getAll({domain})` matches all subdomains, so
  `seller.*`, `accounts.*`, `sellercenter.*` are covered without listing each. To
  support a new platform, add its domains there **and** the popup regex in `popup.js`
  **and** host permissions in `manifest.json`.
- **Cookies are shaped for Playwright/CDP** in `toPlaywrightCookie()`: always emit
  `expires` (`-1` for session cookies) and map `sameSite` to `Strict|Lax|None`.
- **Auto-capture fires on dashboard-URL detection; the human click is the
  always-available fallback.** When a bridge-initiated login tab lands on an
  authenticated Seller Center page, `background.js` auto-runs the capture once
  (one-shot per tab via `autoCaptureAttempted`); the banner's **Capture Session**
  button stays available if auto-detection never fires. This is safe because:
  (a) a false positive fails harmlessly with "No cookies found" and never
  uploads a partial session; (b) the `DASHBOARD_PATTERNS` explicitly exclude
  login / 2FA / verification pages (`AUTH_PATH`), so it won't fire mid-login; and
  (c) on the one recoverable miss ("No cookies found" — the dashboard rendered a
  beat before cookies were written) it waits a short settle window and retries
  once before deferring to the manual button. The patterns are host-based ("any
  authenticated seller-center page that isn't a login/auth page"), mirroring what
  each sibling scraper treats as "logged in" — do NOT narrow them to a single
  hand-picked path (the post-login landing page varies per account/platform), and
  do NOT remove the manual fallback or the one-shot guard.
- **Host permissions are scoped** to the three platforms — never widen to
  `<all_urls>`.
- Bump `version` in `manifest.json` and the Versioning note in `README.md` together
  on release.
