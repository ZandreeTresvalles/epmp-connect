/**
 * Unit tests for the pure DOM-picking logic in login-fill.js.
 *
 * No jsdom / bundler available in this repo (see CLAUDE.md: no build/test
 * step), so we simulate `document.querySelectorAll` with a tiny fake `doc`
 * whose elements are plain objects exposing just what pickLoginFields()
 * touches: getBoundingClientRect() and offsetParent. That's enough to
 * exercise every branch (0 / 1 / >1 visible matches; hidden elements
 * filtered out) without a real DOM.
 *
 * Run: node --test login-fill.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickLoginFields } = require('./login-fill.js');

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
  const username = visibleEl({ tag: 'username' });
  const password = visibleEl({ tag: 'password' });
  const doc = fakeDoc({
    'input[type="text"], input[type="email"]': [username],
    'input[type="password"]': [password],
  });
  const { usernameEl, passwordEl } = pickLoginFields(doc, 'TIKTOK');
  assert.equal(usernameEl, username);
  assert.equal(passwordEl, password);
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
