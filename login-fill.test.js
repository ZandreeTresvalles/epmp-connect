/**
 * Unit tests for the pure DOM-picking logic in login-fill.js.
 *
 * No jsdom / bundler available in this repo (see CLAUDE.md: no build/test
 * step), so we simulate `document.querySelectorAll` with two tiny fake
 * `doc` shapes:
 *   - fakeDoc: a selector-string -> elements map, for tests that only care
 *     about the exact selector reaching querySelectorAll() (most cases).
 *   - fakeAttrDoc (v2.6.1): actually parses a comma-joined selector into its
 *     `input[attr(*)="value" i?]` fragments and matches each against an
 *     element's attribute-shaped properties — needed for TikTok's broadened,
 *     multi-alternative username selector, where a fixture must demonstrate
 *     it's caught by ONE SPECIFIC alternative (e.g. only `placeholder`, not
 *     `type`/`name`), which a plain string-keyed map can't express since the
 *     real code always queries the whole comma list in a single call.
 * Elements are plain objects exposing just what pickLoginFields() touches:
 * getBoundingClientRect(), offsetParent, and (for fakeAttrDoc) plain
 * attribute-named properties like `type`/`name`/`placeholder`/`autocomplete`.
 * That's enough to exercise every branch (0 / 1 / >1 visible matches; hidden
 * elements filtered out) without a real DOM.
 *
 * Run: node --test login-fill.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickLoginFields, buildLoginSelectors } = require('./login-fill.js');

function visibleEl(extra) {
  return Object.assign(
    {
      offsetParent: {}, // non-null => not display:none
      getBoundingClientRect: () => ({ width: 100, height: 20 }),
    },
    extra,
  );
}

function hiddenEl() {
  return {
    offsetParent: null, // display:none
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  };
}

// Fake `doc` whose querySelectorAll dispatches on a selector->elements map,
// mirroring how the real selectors partition username vs password inputs.
function fakeDoc(bySelector) {
  return {
    querySelectorAll(selector) {
      return bySelector[selector] || [];
    },
  };
}

// TIKTOK's username selector (see buildLoginSelectors() in login-fill.js) is
// a single comma-joined list of alternatives, and pickSingle() always passes
// that WHOLE string to querySelectorAll() in one call — never one
// alternative at a time. A `fakeDoc` keyed by exact selector string (above)
// can't exercise "this element matches ONLY the placeholder alternative,
// not the others" because the real call never queries a lone alternative in
// isolation. fakeAttrDoc actually parses the comma list and evaluates each
// `input[attr(*)="value" i?]` fragment against each element's own
// attribute-shaped properties, the same way a real browser evaluates a
// grouped CSS selector — so these tests genuinely exercise which broadened
// alternative caught a given fixture, not just whether the plumbing passes
// a string through.
function elementMatchesSelectorPart(el, part) {
  const m = /^input\[([a-zA-Z]+)(\*=|=)"([^"]+)"(?:\s+i)?\]$/.exec(part.trim());
  if (!m) return false;
  const [, attr, op, value] = m;
  const actual = el[attr];
  if (actual == null) return false;
  const a = String(actual).toLowerCase();
  const v = value.toLowerCase();
  return op === '*=' ? a.includes(v) : a === v;
}

function fakeAttrDoc(elements) {
  return {
    querySelectorAll(selector) {
      const parts = selector.split(',').map((s) => s.trim());
      return elements.filter((el) => parts.some((p) => elementMatchesSelectorPart(el, p)));
    },
  };
}

test('LAZADA: exactly one visible match for each field -> both picked', () => {
  const username = visibleEl({ tag: 'username' });
  const password = visibleEl({ tag: 'password' });
  const doc = fakeDoc({
    'input#account': [username],
    'input[type="password"]': [password],
  });
  const { usernameEl, passwordEl } = pickLoginFields(doc, 'LAZADA');
  assert.equal(usernameEl, username);
  assert.equal(passwordEl, password);
});

test('SHOPEE: exactly one visible match for each field -> both picked', () => {
  const username = visibleEl({ tag: 'username' });
  const password = visibleEl({ tag: 'password' });
  const doc = fakeDoc({
    'input.shopee-input__input[type="text"]': [username],
    'input.shopee-input__input[type="password"]': [password],
  });
  const { usernameEl, passwordEl } = pickLoginFields(doc, 'SHOPEE');
  assert.equal(usernameEl, username);
  assert.equal(passwordEl, password);
});

test('TIKTOK: exactly one visible match for each field -> both picked', () => {
  const tiktokSel = buildLoginSelectors().TIKTOK;
  const username = visibleEl({ tag: 'username' });
  const password = visibleEl({ tag: 'password' });
  const doc = fakeDoc({
    [tiktokSel.username]: [username],
    [tiktokSel.password]: [password],
  });
  const { usernameEl, passwordEl } = pickLoginFields(doc, 'TIKTOK');
  assert.equal(usernameEl, username);
  assert.equal(passwordEl, password);
});

// v2.6.1: TikTok's account-login page selector was broadened beyond plain
// type="text"/type="email" to also match on name/placeholder/autocomplete
// tokens (see buildLoginSelectors() in login-fill.js). These fixtures give
// the username element ONLY a `placeholder` (or only a `name`) — no `type`
// of "text"/"email" and no other matching attribute — so they only pass if
// pickSingle() is actually catching it via one of the newly-added
// alternatives, not the original two type-based ones.
test('TIKTOK: email field matched only by placeholder token is still picked', () => {
  // A plausible real-world shape: a plain <input placeholder="Email address">
  // with no type/name/autocomplete signal at all.
  const username = visibleEl({ placeholder: 'Email address' });
  const password = visibleEl({ type: 'password' });
  const doc = fakeAttrDoc([username, password]);
  const { usernameEl, passwordEl } = pickLoginFields(doc, 'TIKTOK');
  assert.equal(usernameEl, username);
  assert.equal(passwordEl, password);
});

test('TIKTOK: email field matched only by name token is still picked', () => {
  const username = visibleEl({ name: 'email' });
  const password = visibleEl({ type: 'password' });
  const doc = fakeAttrDoc([username, password]);
  const { usernameEl, passwordEl } = pickLoginFields(doc, 'TIKTOK');
  assert.equal(usernameEl, username);
  assert.equal(passwordEl, password);
});

test('TIKTOK: password field selector is untouched by the broadening (type="password" only)', () => {
  // Sanity check on the security contract: even though the username side now
  // matches many attribute shapes, the password selector must still be
  // exactly 'input[type="password"]' — an element that merely LOOKS like a
  // password field by name/placeholder (but isn't type="password") must
  // never be picked as the password field.
  const tiktokSel = buildLoginSelectors().TIKTOK;
  assert.equal(tiktokSel.password, 'input[type="password"]');
  const decoy = visibleEl({ name: 'password', placeholder: 'Password' }); // no type="password"
  const doc = fakeAttrDoc([decoy]);
  const { passwordEl } = pickLoginFields(doc, 'TIKTOK');
  assert.equal(passwordEl, null);
});

// Simulates the "loads late" concern from the v2.6.1 task: the login-page
// document initially has no matching inputs at all (form not mounted yet —
// the first onUpdated 'complete' event fires before the SPA renders it),
// then a second attempt against the SAME platform, once the form has
// mounted, successfully picks both fields. This exercises pickLoginFields()
// being called twice against two different `doc` snapshots, mirroring what
// attemptLoginFill()'s LOGIN_FILL_MAX_ATTEMPTS retry does in background.js —
// pickLoginFields itself has no memory of a "previous attempt", so a
// late-mounted form is only ever a matter of what the second `doc` contains.
test('TIKTOK: late-mounted form — first attempt empty, second attempt (fresh doc) picks both', () => {
  const emptyDoc = fakeAttrDoc([]); // form not mounted yet: nothing to match
  const firstAttempt = pickLoginFields(emptyDoc, 'TIKTOK');
  assert.equal(firstAttempt.usernameEl, null);
  assert.equal(firstAttempt.passwordEl, null);

  const username = visibleEl({ autocomplete: 'username' });
  const password = visibleEl({ type: 'password' });
  const mountedDoc = fakeAttrDoc([username, password]);
  const secondAttempt = pickLoginFields(mountedDoc, 'TIKTOK');
  assert.equal(secondAttempt.usernameEl, username);
  assert.equal(secondAttempt.passwordEl, password);
});

test('zero visible matches -> field skipped, never guessed', () => {
  const doc = fakeDoc({
    'input#account': [],
    'input[type="password"]': [visibleEl()],
  });
  const { usernameEl, passwordEl } = pickLoginFields(doc, 'LAZADA');
  assert.equal(usernameEl, null);
  assert.notEqual(passwordEl, null);
});

test('multiple visible matches -> field skipped, never guessed', () => {
  const doc = fakeDoc({
    'input#account': [visibleEl(), visibleEl()], // ambiguous
    'input[type="password"]': [visibleEl()],
  });
  const { usernameEl, passwordEl } = pickLoginFields(doc, 'LAZADA');
  assert.equal(usernameEl, null); // ambiguous -> skipped
  assert.notEqual(passwordEl, null);
});

test('hidden matches are filtered out before the visible-count check', () => {
  // One hidden decoy + one visible real field -> still exactly one visible
  // match, so it's picked (hidden elements don't count toward ambiguity).
  const realField = visibleEl();
  const doc = fakeDoc({
    'input#account': [hiddenEl(), realField],
    'input[type="password"]': [visibleEl()],
  });
  const { usernameEl } = pickLoginFields(doc, 'LAZADA');
  assert.equal(usernameEl, realField);
});

test('all matches hidden -> treated as zero visible matches -> skipped', () => {
  const doc = fakeDoc({
    'input#account': [hiddenEl(), hiddenEl()],
    'input[type="password"]': [visibleEl()],
  });
  const { usernameEl } = pickLoginFields(doc, 'LAZADA');
  assert.equal(usernameEl, null);
});

test('unknown platform -> no selectors, both fields null', () => {
  const doc = fakeDoc({});
  const { usernameEl, passwordEl } = pickLoginFields(doc, 'NOT_A_PLATFORM');
  assert.equal(usernameEl, null);
  assert.equal(passwordEl, null);
});

// ── fillWhenReady: wait for late-mounting SPA fields (v2.6.4) ───────────────
// The regression these lock down: background.js injects the fill on the tab's
// 'complete' event, which fires BEFORE an SPA renders its login form. The old
// one-shot implementation queried once, found nothing, and returned 0 — and
// since an SPA fires no second 'complete', autofill silently never happened.
// Measured: Shopee's Main/Sub OAuth form needed ~9s before its inputs existed.
function makeInput(cls, type) {
  return {
    className: cls,
    type,
    offsetParent: {},
    value: '',
    getBoundingClientRect: () => ({ width: 200, height: 30 }),
    dispatchEvent() { return true; },
  };
}

// A doc that renders NOTHING until the Nth querySelectorAll call, then serves
// the real Shopee form — the exact late-mount shape.
function lateMountDoc(readyAfterCalls, elements) {
  let calls = 0;
  return {
    get callCount() { return calls; },
    querySelectorAll(selector) {
      calls += 1;
      if (calls < readyAfterCalls) return [];
      return elements[selector] || [];
    },
  };
}

// Deterministic clock/sleep so the polling loop is exercised without waiting.
function fakeTimers() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('fillWhenReady: fills a form that mounts AFTER the first poll (the SPA regression)', async () => {
  const { fillWhenReady } = require('./login-fill.js');
  const user = makeInput('shopee-input__input', 'text');
  const pass = makeInput('shopee-input__input', 'password');
  // pickLoginFields queries username and password selectors separately, so a
  // form that appears on the 3rd query is "late" for both.
  const doc = lateMountDoc(3, {
    'input.shopee-input__input[type="text"]': [user],
    'input.shopee-input__input[type="password"]': [pass],
  });
  const { now, sleep } = fakeTimers();
  const filled = await fillWhenReady(doc, 'SHOPEE', 'arlaph.dataccess', 'pw', { now, sleep, intervalMs: 250, timeoutMs: 15000 });
  assert.equal(filled, 2, 'both fields filled once the form mounted');
  assert.equal(user.value, 'arlaph.dataccess');
  assert.equal(pass.value, 'pw');
});

test('fillWhenReady: fills each field independently as it appears', async () => {
  const { fillWhenReady } = require('./login-fill.js');
  const user = makeInput('shopee-input__input', 'text');
  const pass = makeInput('shopee-input__input', 'password');
  let calls = 0;
  const doc = {
    querySelectorAll(selector) {
      calls += 1;
      if (selector === 'input.shopee-input__input[type="text"]') return [user];
      // password only shows up later (two-step-ish form)
      return calls > 4 ? [pass] : [];
    },
  };
  const { now, sleep } = fakeTimers();
  const filled = await fillWhenReady(doc, 'SHOPEE', 'u', 'p', { now, sleep, intervalMs: 250, timeoutMs: 15000 });
  assert.equal(filled, 2);
  assert.equal(user.value, 'u');
  assert.equal(pass.value, 'p');
});

test('fillWhenReady: gives up at the deadline instead of spinning forever', async () => {
  const { fillWhenReady } = require('./login-fill.js');
  const doc = { querySelectorAll: () => [] }; // form never mounts
  const { now, sleep } = fakeTimers();
  const filled = await fillWhenReady(doc, 'SHOPEE', 'u', 'p', { now, sleep, intervalMs: 250, timeoutMs: 1000 });
  assert.equal(filled, 0, 'returns 0 rather than hanging');
});

test('fillWhenReady: never fills a password field it was not given a password for', async () => {
  const { fillWhenReady } = require('./login-fill.js');
  const user = makeInput('shopee-input__input', 'text');
  const pass = makeInput('shopee-input__input', 'password');
  const doc = fakeDoc({
    'input.shopee-input__input[type="text"]': [user],
    'input.shopee-input__input[type="password"]': [pass],
  });
  const { now, sleep } = fakeTimers();
  const filled = await fillWhenReady(doc, 'SHOPEE', 'u', '', { now, sleep });
  assert.equal(filled, 1);
  assert.equal(pass.value, '', 'password input left untouched');
});

// ── TikTok email tab (v2.7.2) ───────────────────────────────────────────────
// Probed live 2026-08-14: seller-ph.tiktok.com/account/login renders BOTH
// forms and defaults to PHONE — the visible field is
// input[type=tel][name=mobile], while input[type=email][name=email] is hidden
// until "Log in with email" is clicked. The old selector list matched the
// phone box by placeholder, so the operator's EMAIL was typed into it.
function tkInput({ type, name, ph, visible }) {
  return {
    type, name, placeholder: ph, className: '',
    offsetParent: visible ? {} : null,
    getBoundingClientRect: () => ({ width: visible ? 300 : 0, height: visible ? 32 : 0 }),
    value: '', dispatchEvent() { return true; },
  };
}

// A doc that answers real attribute selectors against a fixed element set.
function tkDoc(elements, onTabClick) {
  const matches = (el, sel) => sel.split(',').map((s) => s.trim()).some((part) => {
    let m = /^input\[type="([^"]+)"\]$/.exec(part);
    if (m) return el.type === m[1];
    m = /^input\[(name|placeholder)\*="([^"]+)" i\]$/.exec(part);
    if (m) return String(el[m[1] === 'name' ? 'name' : 'placeholder'] || '').toLowerCase().includes(m[2].toLowerCase());
    m = /^input\[autocomplete="([^"]+)"\]$/.exec(part);
    if (m) return el.autocomplete === m[1];
    return false;
  });
  return {
    querySelectorAll(sel) {
      if (/span, div, button, a/.test(sel)) {
        return [{
          textContent: 'Log in with email', children: [],
          offsetParent: {}, getBoundingClientRect: () => ({ width: 120, height: 20 }),
          click: onTabClick,
        }];
      }
      return elements.filter((e) => matches(e, sel));
    },
  };
}

test('TikTok: the email address is NEVER typed into the phone field', () => {
  const phone = tkInput({ type: 'tel', name: 'mobile', ph: 'Enter your phone number', visible: true });
  const email = tkInput({ type: 'email', name: 'email', ph: 'Enter your email address', visible: false });
  const pass = tkInput({ type: 'password', name: 'password', ph: 'Enter your password', visible: true });
  const { usernameEl } = pickLoginFields(tkDoc([phone, email, pass]), 'TIKTOK');
  assert.equal(usernameEl, null, 'with only the phone box visible, there is no username field to fill');
});

test('TikTok: picks the email input once the email tab is showing', () => {
  const email = tkInput({ type: 'email', name: 'email', ph: 'Enter your email address', visible: true });
  const pass = tkInput({ type: 'password', name: 'password', ph: 'Enter your password', visible: true });
  const { usernameEl, passwordEl } = pickLoginFields(tkDoc([email, pass]), 'TIKTOK');
  assert.equal(usernameEl, email);
  assert.equal(passwordEl, pass);
});

test('ensureTikTokEmailTab: clicks "Log in with email" while the email field is hidden', () => {
  const { ensureTikTokEmailTab } = require('./login-fill.js');
  let clicked = 0;
  const email = tkInput({ type: 'email', name: 'email', ph: 'Enter your email address', visible: false });
  assert.equal(ensureTikTokEmailTab(tkDoc([email], () => { clicked += 1; })), true);
  assert.equal(clicked, 1);
});

test('ensureTikTokEmailTab: no-ops once an email field is visible', () => {
  const { ensureTikTokEmailTab } = require('./login-fill.js');
  let clicked = 0;
  const email = tkInput({ type: 'email', name: 'email', ph: 'Enter your email address', visible: true });
  assert.equal(ensureTikTokEmailTab(tkDoc([email], () => { clicked += 1; })), false);
  assert.equal(clicked, 0, 'must not keep clicking the tab');
});
