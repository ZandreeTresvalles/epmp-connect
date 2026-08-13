/**
 * page-state.js — THE canonical answer to "what kind of page is this?"
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * On 2026-08-13/14 five extension releases (v2.5.0→v2.6.4) each patched a
 * symptom of ONE root problem: "is this an authenticated Seller Center page?"
 * was answered in five different, weak, drifting ways —
 *   - AUTH_PATH (negative URL test) gated the capture upload,
 *   - LOGIN_PAGE_PATTERNS gated autofill,
 *   - DASHBOARD_PATTERNS gated auto-capture,
 *   - the extension had NO positive authenticated-content check at all,
 *   - while the worker (services/automation-worker/src/platforms/session-check.ts
 *     and its hand-mirror in the box's epmp-worker.js) used a POSITIVE
 *     content-marker check the extension never shared.
 * Result: a capture whose login had failed still uploaded (its cookies
 * existed, its URL wasn't a login URL), and died on first use.
 *
 * Every page-state question now routes through this module. background.js
 * must not re-define any of these predicates.
 *
 * ── CANONICAL AUTH SPEC (keep in sync across all three codebases) ──────────
 * These three definitions are mirrored, verbatim, in:
 *   1. this file (extension),
 *   2. services/automation-worker/src/platforms/session-check.ts (Playwright),
 *   3. ~/marketing-automation/scheduler/epmp-worker.js on the box (Puppeteer).
 * They cannot be a shared import — the three run in incompatible runtimes
 * (buildless MV3 / TS+Playwright / plain-JS+Puppeteer). A parity test asserts
 * they match; if you change one, change all three or the test fails.
 *
 *   SPEC-1 AUTHENTICATED_CONTENT_SELECTOR — the positive "a real logged-in
 *          shell rendered" marker.
 *   SPEC-2 ANY-VISIBLE rule — a marker counts when ANY match is visible, not
 *          when the FIRST match is. (Lazada's first match is a height:0
 *          collapsed sidebar wrapper; anchoring on it made every Lazada
 *          session grade "url-only" forever — the "Verifying…" bug.)
 *   SPEC-3 AUTH_PATH — the union of login/2FA/verification path fragments
 *          that mean "still authenticating".
 *
 * Loaded three ways, so it stays a CLASSIC script (no ES `export`):
 *   - `importScripts('page-state.js')` in the service worker,
 *   - `chrome.scripting.executeScript({files:['page-state.js']})` into a page
 *     (then call `window.__epmpIsAuthenticatedContent()`),
 *   - `require('./page-state.js')` in node --test.
 */

// ── Re-injection safety (v2.7.2) ────────────────────────────────────────────
// EVERYTHING below is wrapped in an IIFE. chrome.scripting.executeScript({files})
// evaluates this file into the target world's GLOBAL scope, and the capture
// gate injects it on every poll tick — a top-level `const` would therefore
// throw "Identifier 'AUTH_PATH' has already been declared" on the 2nd
// injection, which the caller swallows, so the authenticated-content check
// could never succeed after its first tick and captures hung ("this capture
// looks stuck"). The same shape killed the service worker in 2.7.0. Inside a
// function scope, re-running the file is simply idempotent.
(function () {
// ── SPEC-3: AUTH_PATH ───────────────────────────────────────────────────────
// Mirrors what each backend's own scraper treats as "still logging in":
//   - encoder-reports tiktok.ts: /account/login | /passport/ | /sign-in | login
//   - encoder-reports lazadaApi.ts: /login | /signin
//   - audit-reports shopeeInventory.ts: /login | /sign-in | /passport
// Tested against the URL's PATHNAME (not the whole URL): a legitimate
// post-login URL can carry a login-ish query param (Shopee's own
// `?next=…%2Flogin`), and refusing a good capture over a query string is the
// false-negative this module exists to prevent. Every real
// still-authenticating URL seen in production matches on pathname alone
// (`/seller/login?status=high_risk_verification`, `/signin/oauth/identifier`).
const AUTH_PATH = /(\/(login|signin|sign-in|passport|account\/login|verify|verification|2fa|otp|captcha))/i;

// A NARROWER subset of AUTH_PATH: login/signin/passport only, excluding
// verify/2fa/otp/captcha — those are post-username steps where no
// username+password form exists, so autofill must not fire on them.
const LOGIN_PATH = /(\/(login|signin|sign-in|passport|account\/login))/i;

// ── SPEC-1: the authenticated-content marker ────────────────────────────────
// Identical string in session-check.ts and the box worker. Deliberately
// generic (the authenticated shell of all three Seller Centers renders a
// nav/sidebar/header/dashboard container) — specificity lives in the
// ANY-VISIBLE rule below, not in per-platform selectors.
const AUTHENTICATED_CONTENT_SELECTOR = 'nav, [class*="sidebar"], [class*="header"], [class*="dashboard"]';

// ── Per-platform URL shapes ────────────────────────────────────────────────
// Doctrine (unchanged from the original background.js block): a seller lands
// authenticated on the Seller Center HOST but the post-login PATH varies per
// account (Shopee → /portal/home, /portal/sale/order…; TikTok → /order,
// /compass/*…). So we never match a specific dashboard path — a page counts as
// a dashboard URL when it is on the seller-center host and is NOT AUTH_PATH.
const DASHBOARD_PATTERNS = {
  LAZADA: (u) => /(^|\.)sellercenter\.lazada\.com\.ph$/.test(u.hostname) && !AUTH_PATH.test(u.pathname),
  SHOPEE: (u) => /(^|\.)seller\.shopee\.ph$/.test(u.hostname) && !AUTH_PATH.test(u.pathname),
  TIKTOK: (u) => /(^|\.)seller(-ph)?\.tiktok\.com$/.test(u.hostname) && !AUTH_PATH.test(u.pathname),
};

// The opposite assertion: we are ON the login form itself, so filling it is
// safe and useful.
//
// SHOPEE has TWO real login surfaces (both probed live 2026-08-13):
//   subaccount.shopee.com/login/        — the Sub-account Platform form
//   account.seller.shopee.com/signin/…  — the unified "Main / Sub Account"
//     OAuth form, which Shopee mints (freshly SIGNED, ~10 min TTL) when the
//     "Login with Main/Sub Account" button on accounts.shopee.ph is clicked.
// Both render `input.shopee-input__input` text+password fields, which is what
// login-fill.js's SHOPEE selector already targets.
//
// TIKTOK: the seller-center host redirects to TikTok's own account-login page
// on a DIFFERENT host before the form mounts, so this matches any
// `*.tiktok.com` host (still gated on LOGIN_PATH, so never the feed).
const LOGIN_PAGE_PATTERNS = {
  LAZADA: (u) => /(^|\.)sellercenter\.lazada\.com\.ph$/.test(u.hostname) && LOGIN_PATH.test(u.pathname),
  SHOPEE: (u) => (/(^|\.)subaccount\.shopee\.com$/.test(u.hostname)
      && (u.pathname === '/' || LOGIN_PATH.test(u.pathname)))
    || (/(^|\.)account\.seller\.shopee\.com$/.test(u.hostname) && LOGIN_PATH.test(u.pathname)),
  TIKTOK: (u) => /(^|\.)tiktok\.com$/.test(u.hostname) && LOGIN_PATH.test(u.pathname),
};

// Every URL predicate parses defensively and returns false on a malformed URL
// — an unparseable URL is never evidence of anything.
function withUrl(urlStr, fn) {
  try {
    return fn(new URL(urlStr));
  } catch {
    return false;
  }
}

/** True when the URL's PATH says the operator is still authenticating. */
function isAuthPath(urlStr) {
  return withUrl(urlStr, (u) => AUTH_PATH.test(u.pathname));
}

/** True when this is the platform's own login FORM page (autofill target). */
function isLoginPage(platform, urlStr) {
  const check = LOGIN_PAGE_PATTERNS[platform];
  return !!check && withUrl(urlStr, check);
}

/** True when the URL looks like an authenticated seller-center page. */
function isDashboardUrl(platform, urlStr) {
  const check = DASHBOARD_PATTERNS[platform];
  return !!check && withUrl(urlStr, check);
}

// ── SPEC-2: ANY-VISIBLE authenticated-content check ────────────────────────
// The positive proof the extension previously lacked entirely. Ported from
// the worker's FIXED implementation (`hasAuthenticatedMarker`): ANY matching
// element being visible counts — never "the first match is visible", which
// times out on Lazada's height:0 sidebar wrapper even though nav/header are
// plainly on screen.
//
// Takes a `doc` so it is unit-testable with a fake document; the injected
// wrapper below passes the real one.
function isAuthenticatedContent(doc, selector) {
  const sel = selector || AUTHENTICATED_CONTENT_SELECTOR;
  let els;
  try {
    els = Array.from(doc.querySelectorAll(sel));
  } catch {
    return false;
  }
  return els.some((el) => {
    if (!el) return false;
    // offsetParent is null for display:none (and detached) elements.
    if ('offsetParent' in el && el.offsetParent === null) return false;
    if (typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
    }
    if (typeof getComputedStyle === 'function') {
      try {
        if (getComputedStyle(el).visibility === 'hidden') return false;
      } catch { /* not a real element / no view — fall through */ }
    }
    return true;
  });
}

// Page-context entry point (injected via chrome.scripting files:[...]).
// `window` exists only in a real page — never in the service worker or node.
if (typeof window !== 'undefined') {
  window.__epmpIsAuthenticatedContent = function () {
    return isAuthenticatedContent(document);
  };
}

// Service-worker entry point: importScripts() shares this realm, so expose one
// explicit namespace rather than relying on cross-script lexical bindings.
if (typeof self !== 'undefined') {
  self.EpmpPageState = {
    AUTH_PATH,
    LOGIN_PATH,
    AUTHENTICATED_CONTENT_SELECTOR,
    DASHBOARD_PATTERNS,
    LOGIN_PAGE_PATTERNS,
    isAuthPath,
    isLoginPage,
    isDashboardUrl,
    isAuthenticatedContent,
  };
}

// node --test entry point. `module` never exists in a browser/SW context.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AUTH_PATH,
    LOGIN_PATH,
    AUTHENTICATED_CONTENT_SELECTOR,
    DASHBOARD_PATTERNS,
    LOGIN_PAGE_PATTERNS,
    isAuthPath,
    isLoginPage,
    isDashboardUrl,
    isAuthenticatedContent,
  };
}
}());
