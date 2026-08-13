/**
 * page-state.test.js — T1.3.
 *
 * Locks down the canonical page-state predicates against the REAL URLs seen
 * in production on 2026-08-13/14. Each case here is a bug that actually
 * happened or a guard that actually saved a capture, so a regression in
 * page-state.js fails here rather than in the operator's browser.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAuthPath,
  isLoginPage,
  isDashboardUrl,
  isAuthenticatedContent,
  AUTHENTICATED_CONTENT_SELECTOR,
} = require('./page-state.js');

// [platform, url, { login, auth, dash }] — every expectation asserted.
const URL_CASES = [
  // Shopee MAIN seller login: an auth path, NOT the sub-account form we fill.
  ['SHOPEE', 'https://accounts.shopee.ph/seller/login?next=https%3A%2F%2Fseller.shopee.ph%2Fportal%2Fproduct%2Flist%2Fall',
    { login: false, auth: true, dash: false }],
  // Shopee unified Main/Sub OAuth form — the page v2.6.3 steers to and fills.
  ['SHOPEE', 'https://account.seller.shopee.com/signin/oauth/identifier?account_type=2&region=PH',
    { login: true, auth: true, dash: false }],
  // Shopee Sub-account Platform form (the other real login surface).
  ['SHOPEE', 'https://subaccount.shopee.com/login/?status=high_risk_verification',
    { login: true, auth: true, dash: false }],
  // The OAuth callback: must NOT read as an auth path, or v2.6.2's gate would
  // refuse a GOOD capture at the very moment login succeeded.
  ['SHOPEE', 'https://seller.shopee.ph/api/selleraccount/subaccount_oauth_callback/',
    { login: false, auth: false, dash: true }],
  // Authenticated landing page.
  ['SHOPEE', 'https://seller.shopee.ph/portal/product/list/all',
    { login: false, auth: false, dash: true }],
  ['LAZADA', 'https://sellercenter.lazada.com.ph/apps/seller/login?login=1',
    { login: true, auth: true, dash: false }],
  ['LAZADA', 'https://sellercenter.lazada.com.ph/apps/product/list?tab=online_product',
    { login: false, auth: false, dash: true }],
  // TikTok redirects OFF the seller host to log in — the v2.6.1 widening.
  ['TIKTOK', 'https://www.tiktok.com/login/phone-or-email',
    { login: true, auth: true, dash: false }],
  ['TIKTOK', 'https://seller-ph.tiktok.com/product/manage?shop_region=PH',
    { login: false, auth: false, dash: true }],
];

for (const [platform, url, expected] of URL_CASES) {
  test(`page-state: ${platform} ${url.slice(0, 62)}`, () => {
    assert.equal(isLoginPage(platform, url), expected.login, 'isLoginPage');
    assert.equal(isAuthPath(url), expected.auth, 'isAuthPath');
    assert.equal(isDashboardUrl(platform, url), expected.dash, 'isDashboardUrl');
  });
}

test('page-state: a login-ish QUERY param never makes a good page look like a login', () => {
  // AUTH_PATH is tested against the PATHNAME precisely so Shopee's own
  // `?next=…%2Flogin` can't get a genuinely authenticated capture refused.
  assert.equal(isAuthPath('https://seller.shopee.ph/portal/product/list/all?next=/seller/login'), false);
});

test('page-state: malformed URLs are never evidence of anything', () => {
  for (const bad of ['', 'not a url', 'javascript:void(0)']) {
    assert.equal(isAuthPath(bad), false);
    assert.equal(isLoginPage('SHOPEE', bad), false);
    assert.equal(isDashboardUrl('SHOPEE', bad), false);
  }
});

test('page-state: unknown platform never matches', () => {
  assert.equal(isLoginPage('MERCADO', 'https://accounts.shopee.ph/seller/login'), false);
  assert.equal(isDashboardUrl('MERCADO', 'https://seller.shopee.ph/portal/home'), false);
});

// ── SPEC-2: the any-visible rule ────────────────────────────────────────────
function el({ w = 200, h = 30, visibility = 'visible', detached = false } = {}) {
  return {
    offsetParent: detached ? null : {},
    getBoundingClientRect: () => ({ width: w, height: h }),
    __visibility: visibility,
  };
}
const docOf = (els) => ({ querySelectorAll: () => els });

test('page-state: ANY visible match counts — not the FIRST match (the Verifying-forever bug)', () => {
  // Lazada's real shape: the first match is a height:0 collapsed sidebar
  // wrapper, a later one (nav/header) is genuinely on screen. Anchoring on
  // the first match is what graded every Lazada session url-only forever.
  const doc = docOf([el({ h: 0 }), el({ w: 220, h: 48 })]);
  assert.equal(isAuthenticatedContent(doc), true);
});

test('page-state: zero-size and detached elements alone are NOT proof', () => {
  assert.equal(isAuthenticatedContent(docOf([el({ h: 0 })])), false);
  assert.equal(isAuthenticatedContent(docOf([el({ w: 0 })])), false);
  assert.equal(isAuthenticatedContent(docOf([el({ detached: true })])), false);
});

test('page-state: an empty document is not authenticated', () => {
  assert.equal(isAuthenticatedContent(docOf([])), false);
});

test('page-state: a throwing querySelectorAll degrades to "not proven", never throws', () => {
  assert.equal(isAuthenticatedContent({ querySelectorAll() { throw new Error('detached'); } }), false);
});

test('page-state: the canonical selector covers the four shell containers', () => {
  for (const frag of ['nav', 'sidebar', 'header', 'dashboard']) {
    assert.ok(AUTHENTICATED_CONTENT_SELECTOR.includes(frag), `selector must cover ${frag}`);
  }
});
