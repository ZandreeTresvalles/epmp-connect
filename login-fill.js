/**
 * EPMP Connect — seller-login auto-fill (injected on-demand into the login tab,
 * ISOLATED world, mirrors banner.js's own injection pattern).
 *
 * background.js calls chrome.scripting.executeScript({ files: ['login-fill.js'] })
 * once the tab is confirmed to be ON the platform's login page (host + path
 * match — see LOGIN_PAGE_PATTERNS in background.js), then invokes
 * window.__epmpConnectFillLogin(platform, username, password) via a second
 * executeScript call to actually run it and read back the result.
 *
 * Security contract (do not weaken):
 *   - NEVER auto-submit the form — fill only. The operator clicks Login and
 *     completes OTP/2FA themselves.
 *   - NEVER console.log (or otherwise surface) the username/password. The
 *     only thing that crosses back to background.js is a plain integer count
 *     of fields filled (0, 1, or 2) — see the return value below.
 *   - NEVER guess: pickLoginFields() only returns a field when EXACTLY ONE
 *     visible element matches that field's selector. Zero or multiple visible
 *     matches means "skip that field," not "take the first one."
 *
 * Re-injection gotcha (same as banner.js): chrome.scripting.executeScript with
 * `files` re-runs this entire script's top level every time it's injected,
 * reusing the SAME isolated-world global scope — so top-level `const`/`let`/
 * `class` would throw "already declared" on the second injection. `function`
 * declarations and plain assignments are safe to redeclare/reassign, so this
 * file only ever uses those at its top level.
 */

/**
 * Pick the (at most one) visible username/password input on the login page.
 * Pure DOM-picking logic beyond `doc.querySelectorAll` + a visibility check,
 * so it's unit-testable from Node with a fake `doc`/element shape — see the
 * `module.exports` guard at the bottom and login-fill.test.js.
 *
 * @param {Document} doc
 * @param {'LAZADA'|'SHOPEE'|'TIKTOK'} platform
 * @returns {{ usernameEl: object|null, passwordEl: object|null }}
 */
// Per-platform field selectors. A plain `function` (not a top-level `const`),
// deliberately, per this file's re-injection gotcha above — it's cheap to
// rebuild on every call and stays safe to redeclare on repeat injection.
// Exported for tests too (see the `module.exports` guard at the bottom), so
// login-fill.test.js can assert against the exact selector strings rather
// than duplicating them.
//
// ── Re-injection safety (v2.7.2) ────────────────────────────────────────────
// Wrapped in an IIFE for the same reason as page-state.js: background.js
// injects this file once per fill attempt, and a top-level `const` makes the
// SECOND injection throw "already been declared" — silently costing the
// retry that exists precisely for late-mounting forms.
(function () {
// NOTE (v2.6.4): the "TIKTOK never auto-filled" evidence below predates the
// late-mount fix in fillWhenReady(). The fill used to run once, immediately
// on the tab's 'complete' event — before ANY of these SPAs had rendered their
// form — so a miss proved nothing about the selectors. Re-verify against a
// live TikTok page before broadening these further; the timing bug was the
// more likely culprit, and it applied to all three platforms.
//
// LAZADA / SHOPEE selectors below are verified against the real seller login
// forms. TIKTOK still has no confirmed stable selector — a real capture
// (2026-08-13) showed the seller login form did NOT get auto-filled, and its
// login page was not directly inspectable while broadening this list (see
// the v2.6.1 task report's flagged concern). Rather than one plain
// input-type match, TIKTOK's selector is broadened to also match on
// name/placeholder/autocomplete tokens TikTok's account-login page plausibly
// uses for its email/username field — 'email', 'account', 'loginName',
// 'username', 'phone' — on top of type="text"/type="email". This is
// heuristic broadening, not a confirmed selector: it leans entirely on the
// single-visible-match guard below. If the real page ever renders more than
// one visible match across all of these (or none), the username field is
// still skipped rather than guessed. The password selector is deliberately
// UNCHANGED — type="password" is the one signal that's never ambiguous, so
// it is never broadened or weakened.
function buildLoginSelectors() {
  return {
    LAZADA: { username: 'input#account', password: 'input[type="password"]' },
    SHOPEE: {
      username: 'input.shopee-input__input[type="text"]',
      password: 'input.shopee-input__input[type="password"]',
    },
    // TIKTOK (probed live 2026-08-14 on seller-ph.tiktok.com/account/login):
    // the page renders BOTH forms and defaults to PHONE — the visible field is
    // `input[type=tel][name=mobile]` ("Enter your phone number") while
    // `input[type=email][name=email]` sits hidden until the "Log in with
    // email" tab is clicked (see ensureTikTokEmailTab). This org logs in with
    // EMAIL, so phone-matching tokens are deliberately REMOVED: they made the
    // phone box the single visible match, and the email address was typed
    // into it. `input[type="text"]` is dropped for the same reason — it
    // matched the country-code search box.
    TIKTOK: {
      username: [
        'input[type="email"]',
        'input[name*="email" i]',
        'input[placeholder*="email" i]',
        'input[name*="account" i]',
        'input[name*="loginName" i]',
        'input[name*="username" i]',
        'input[autocomplete="username"]',
        'input[autocomplete="email"]',
      ].join(', '),
      password: 'input[type="password"]',
    },
  };
}

function pickLoginFields(doc, platform) {
  function isVisible(el) {
    if (!el) return false;
    // offsetParent is null for display:none (and detached) elements.
    if ('offsetParent' in el && el.offsetParent === null) return false;
    // A zero-size rect also catches visibility:hidden / collapsed elements.
    if (typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
    }
    return true;
  }

  function pickSingle(selector) {
    if (!selector) return null;
    let all;
    try {
      all = Array.from(doc.querySelectorAll(selector)).filter(isVisible);
    } catch {
      return null;
    }
    return all.length === 1 ? all[0] : null; // 0 or >1 visible matches: never guess.
  }

  const sel = buildLoginSelectors()[platform];
  if (!sel) return { usernameEl: null, passwordEl: null };
  return { usernameEl: pickSingle(sel.username), passwordEl: pickSingle(sel.password) };
}

// Set an <input> value the way a real keystroke would, so React/Vue's
// controlled-input machinery (which patches the DOM property getter/setter
// pair, not just the attribute) actually registers the new value. A plain
// `el.value = x` updates the DOM but not the framework's internal state, so
// the very next re-render (or the framework's own change handler) silently
// reverts it — the classic "I set .value but the form still shows empty"
// trap. Going through the native prototype's setter, then dispatching
// `input`/`change`, is the standard workaround.
function setNativeInputValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const nativeSetter = (proto && Object.getOwnPropertyDescriptor(proto, 'value')
    && Object.getOwnPropertyDescriptor(proto, 'value').set)
    || (typeof HTMLInputElement !== 'undefined'
      && Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      && Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set);
  if (nativeSetter) nativeSetter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── TikTok: switch to the EMAIL tab (v2.7.2) ────────────────────────────────
// TikTok's seller login opens on the PHONE tab; the email field exists but is
// hidden until "Log in with email" is clicked. Without this the fill either
// found no visible email field or (worse) put the email address in the phone
// box. Clicks ONLY that tab — a navigation/UI toggle on the operator's own
// login page, never a submit, and never anything credential-related.
// Idempotent and cheap: no-ops as soon as an email input is visible.
function isElementVisible(el) {
  if (!el) return false;
  if ('offsetParent' in el && el.offsetParent === null) return false;
  if (typeof el.getBoundingClientRect === 'function') {
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return false;
  }
  return true;
}

function ensureTikTokEmailTab(doc) {
  let emailInputs = [];
  try {
    emailInputs = Array.from(doc.querySelectorAll('input[type="email"], input[name*="email" i]'));
  } catch {
    return false;
  }
  if (emailInputs.some(isElementVisible)) return false; // already on the email form

  let candidates = [];
  try {
    candidates = Array.from(doc.querySelectorAll('span, div, button, a'));
  } catch {
    return false;
  }
  const tab = candidates.find((e) => {
    const text = (e.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/^log ?in with email$|email login/i.test(text)) return false;
    return (!e.children || e.children.length === 0) && isElementVisible(e);
  });
  if (tab && typeof tab.click === 'function') {
    tab.click();
    return true;
  }
  return false;
}

// ── Wait for late-mounting fields (v2.6.4) ──────────────────────────────────
// Every one of these login pages is a JS-rendered SPA, and background.js
// injects this on the tab's `status === 'complete'` event — which fires when
// the DOCUMENT finished loading, i.e. typically BEFORE the framework has
// rendered the form. The original one-shot implementation ran a single
// synchronous `pickLoginFields` at that instant, found nothing, and returned
// 0 with no retry: since an SPA does not fire a second 'complete', the one
// remaining attempt never came either. That is why autofill "worked
// sometimes" (a slow/cached load that happened to have the form up) and
// silently did nothing the rest of the time, on every brand and platform.
// Measured 2026-08-13: the Shopee Main/Sub OAuth form needed ~9s before its
// inputs existed in the DOM.
//
// So: poll instead of guessing once. Each field is filled independently the
// moment IT becomes available (which also covers a form whose password field
// mounts after the username step), and the loop exits as soon as both are
// done or the deadline passes. Bounded, never throws, and entirely
// brand-agnostic — it fixes autofill for every brand and any future platform
// whose form mounts late, rather than per-page selector guessing.
const FILL_POLL_INTERVAL_MS = 250;
const FILL_TIMEOUT_MS = 15000;

async function fillWhenReady(doc, platform, username, password, opts) {
  const o = opts || {};
  const intervalMs = o.intervalMs || FILL_POLL_INTERVAL_MS;
  const timeoutMs = o.timeoutMs || FILL_TIMEOUT_MS;
  const now = o.now || (() => Date.now());
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const deadline = now() + timeoutMs;
  let filled = 0;
  // A credential half we were not given is "already done" — never block the
  // loop (or the deadline) waiting for a field we would not fill anyway.
  let usernameDone = !username;
  let passwordDone = !password;

  for (;;) {
    // TikTok opens on the phone tab — reveal the email form before picking.
    if (platform === 'TIKTOK' && !usernameDone) ensureTikTokEmailTab(doc);
    const { usernameEl, passwordEl } = pickLoginFields(doc, platform);
    if (!usernameDone && usernameEl) {
      setNativeInputValue(usernameEl, username);
      usernameDone = true;
      filled += 1;
    }
    if (!passwordDone && passwordEl) {
      setNativeInputValue(passwordEl, password);
      passwordDone = true;
      filled += 1;
    }
    if (usernameDone && passwordDone) return filled;
    if (now() >= deadline) return filled;
    await sleep(intervalMs);
  }
}

// Only defined in a real page context (has `window`) — guarded so this file
// can also be `require()`d from a plain Node test without throwing.
if (typeof window !== 'undefined') {
  /**
   * Fill the login form. Never submits, never logs username/password.
   * Resolves to a plain count (0/1/2) of fields actually set — the only
   * thing that crosses back to background.js. Returning a Promise is safe:
   * `chrome.scripting.executeScript` awaits a promise result before
   * resolving `res.result`.
   */
  window.__epmpConnectFillLogin = function (platform, username, password) {
    return fillWhenReady(document, platform, username, password);
  };
}

// Test-only export (Node, via `require('./login-fill.js')`). `module` never
// exists in the browser's isolated-world content-script context, so this is
// dead code there — the guard just keeps it from throwing if it ever did.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pickLoginFields, setNativeInputValue, buildLoginSelectors, fillWhenReady, ensureTikTokEmailTab };
}
}());
