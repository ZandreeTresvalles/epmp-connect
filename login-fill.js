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

  // LAZADA / SHOPEE selectors below are verified against the real seller login
  // forms. TIKTOK has no confirmed stable selector (its Seller Center login
  // form was not directly inspectable while building this), so it falls back
  // to generic input-type matching and leans entirely on the single-visible-
  // match guard above: if that page ever renders more than one visible
  // text/email input (or none), the username field is skipped rather than
  // guessed.
  const SELECTORS = {
    LAZADA: { username: 'input#account', password: 'input[type="password"]' },
    SHOPEE: {
      username: 'input.shopee-input__input[type="text"]',
      password: 'input.shopee-input__input[type="password"]',
    },
    TIKTOK: {
      username: 'input[type="text"], input[type="email"]',
      password: 'input[type="password"]',
    },
  };

  const sel = SELECTORS[platform];
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

// Only defined in a real page context (has `window`) — guarded so this file
// can also be `require()`d from a plain Node test without throwing.
if (typeof window !== 'undefined') {
  /**
   * Fill the login form. Never submits, never logs username/password.
   * Returns a plain count (0/1/2) of fields actually set — the only thing
   * that crosses back to background.js.
   */
  window.__epmpConnectFillLogin = function (platform, username, password) {
    const { usernameEl, passwordEl } = pickLoginFields(document, platform);
    let filled = 0;
    if (usernameEl && username) {
      setNativeInputValue(usernameEl, username);
      filled += 1;
    }
    if (passwordEl && password) {
      setNativeInputValue(passwordEl, password);
      filled += 1;
    }
    return filled;
  };
}

// Test-only export (Node, via `require('./login-fill.js')`). `module` never
// exists in the browser's isolated-world content-script context, so this is
// dead code there — the guard just keeps it from throwing if it ever did.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pickLoginFields, setNativeInputValue };
}
