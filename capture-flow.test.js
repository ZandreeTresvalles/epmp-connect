/**
 * capture-flow.test.js — the regression net for the capture pipeline in
 * background.js, driven through test-harness.js's DI fakes (zero browser).
 *
 * Each `test()` below is traceable to a specific incident from the
 * 2026-08-13/14 release run (see docs/superpowers/plans/
 * 2026-08-14-capture-session-robustness-consolidation.md, "CONTEXT" table):
 *
 *   Bug (release)                              | Test(s) that lock it down
 *   --------------------------------------------|--------------------------
 *   Shopee dies same minute (v2.6.2 root cause) | "dead session ... refused"
 *   — uploaded a logged-out session because     | (no positive proof -> no
 *     `cookies.length>0` alone was trusted      |  upload, no hygiene)
 *   Shopee -> main login not sub (v2.6.3)       | "Main/Sub Account button
 *   — wrong login surface reached               |  is clicked exactly once"
 *   Autofill never fired (v2.6.4)               | cross-link to
 *   — acted once instead of waiting for mount   |  login-fill.test.js
 *   "Verifying..." forever / any-visible fix    | "marker-visible -> uploaded"
 *   — first-match anchoring on a 0-height wrapper| + hasAuthenticatedContent
 *     time boxed out the true dashboard content | unit tests below
 *   Discovery's own strong signal was discarded  | "endpointStatus discovered
 *   by the old URL-only capture guard            |  -> uploaded"
 *   Auto-capture fired on URL match before the   | "bails when ... marker
 *   SPA shell rendered (this plan's M2 fix)      |  has not rendered yet" /
 *                                                 | "proceeds ... once visible"
 *
 * Run: node --test capture-flow.test.js  (or `node --test` for the whole repo).
 */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./capture-harness.js');

const harness = createHarness();
// MUST happen before the first require('./background.js') below: background.js
// registers chrome.tabs.onUpdated / onRemoved / chrome.runtime.onMessage
// listeners at module-load time (top-level addListener calls), so `chrome`
// has to already exist on globalThis — see test-harness.js's header.
harness.install();

// A single require — node's module cache means a second require() would just
// hand back these same exports without re-running the top-level addListener
// calls, so there is no "fresh module per test" available (or needed):
// harness.reset() below clears per-test state instead.
const background = require('./background.js');

// Shrink every real production delay/poll this suite could otherwise hit —
// hasAuthenticatedContent's 8s timeout, runDiscovery's up-to-30s loop, the
// 1.5s cookie-settle retry, the 1.7s post-capture hygiene pause — down to a
// few ms. This mutates the SAME object background.js reads at call time (see
// TEST_TIMEOUTS's header comment there), so it applies to every test below
// without touching any call site.
Object.assign(background.TEST_TIMEOUTS, {
  AUTH_CONTENT_POLL_INTERVAL_MS: 2,
  AUTH_CONTENT_TIMEOUT_MS: 20,
  AUTO_CAPTURE_SETTLE_MS: 2,
  POST_CAPTURE_HYGIENE_DELAY_MS: 2,
  DISCOVERY_POLL_INTERVAL_MS: 2,
  DISCOVERY_MAX_ITERATIONS: 3,
});

beforeEach(() => {
  harness.reset();
});

// ── Sanity: background.js must register exactly one of each listener ───────
// A guard against accidentally double-registering (e.g. a future edit that
// wraps addListener in something re-run per capture), which would silently
// double-fire every auto-capture / message-router path.
test('background.js registers exactly one listener of each kind at load time', () => {
  assert.deepEqual(harness.getListenerCounts(), {
    tabsOnUpdated: 1,
    tabsOnRemoved: 1,
    runtimeOnMessage: 1,
  });
});

// ── hasAuthenticatedContent: the positive-proof primitive ──────────────────
test('hasAuthenticatedContent: resolves true immediately when the marker is visible (no unnecessary polling)', async () => {
  const tabId = 101;
  harness.setAuthenticatedContent(tabId, true);

  const result = await background.hasAuthenticatedContent(tabId, { intervalMs: 2, timeoutMs: 50 });

  assert.equal(result, true);
  const markerChecks = harness.getScriptingCallsMatching('__epmpIsAuthenticatedContent');
  assert.equal(markerChecks.length, 1, 'should not need a second poll once the first check succeeds');
});

test('hasAuthenticatedContent: gives up at the deadline — and keeps re-injecting page-state.js each tick — when the marker never renders', async () => {
  const tabId = 102;
  harness.setAuthenticatedContent(tabId, false);

  const result = await background.hasAuthenticatedContent(tabId, { intervalMs: 2, timeoutMs: 15 });

  assert.equal(result, false, 'no marker ever appeared, so this must never report authenticated');
  const fileInjections = harness.getScriptingCalls()
    .filter((d) => Array.isArray(d.files) && d.files.includes('page-state.js'));
  assert.ok(
    fileInjections.length > 1,
    `expected multiple re-injections (a navigation mid-poll wipes the previous one), got ${fileInjections.length}`,
  );
});

// ── runDiscovery: the strongest accept signal ───────────────────────────────
test('runDiscovery: no productListUrl -> endpointStatus null, no navigation attempted', async () => {
  const tabId = 103;

  const disc = await background.runDiscovery(tabId, null, null);

  assert.equal(disc.endpointStatus, null);
  assert.equal(harness.getUpdatedTabCalls().length, 0, 'must not navigate the tab when there is nothing to discover');
});

test('runDiscovery: a preferred hit on the first poll -> discovered, with the product endpoint captured', async () => {
  const tabId = 104;
  harness.setProductCapture(tabId, [{
    preferred: true,
    url: 'https://seller.shopee.ph/api/v3/product/list?page_number=1',
    method: 'GET',
    json: { items: [{ name: 'Widget' }] },
  }]);

  const disc = await background.runDiscovery(tabId, 'https://seller.shopee.ph/portal/product/list', null);

  assert.equal(disc.endpointStatus, 'discovered');
  assert.equal(disc.productEndpoint.pageParam, 'page_number');
  assert.deepEqual(harness.getUpdatedTabCalls()[0].changes, { url: 'https://seller.shopee.ph/portal/product/list' });
});

test('runDiscovery: nothing ever captured -> unverified after exhausting the poll budget (never hangs)', async () => {
  const tabId = 105;
  harness.setProductCapture(tabId, null);

  const disc = await background.runDiscovery(tabId, 'https://seller.shopee.ph/portal/product/list', null);

  assert.equal(disc.endpointStatus, 'unverified');
});

// ── captureFromTab: the positive-proof capture guard (T2.1) ────────────────
test('captureFromTab: dead session (no marker, discovery unverified, on a login URL) -> refused, no upload, no cookie wipe', async () => {
  const tabId = 201;
  harness.seedTab(tabId, 'https://accounts.shopee.ph/seller/login');
  // Shopee sets cookies on its own login page too — this is exactly the
  // v2.6.2 false-positive signal (`cookies.length>0`) the guard must ignore.
  harness.seedCookies('shopee.ph', [{ name: 'SPC_SEC', value: 'x' }]);
  harness.setAuthenticatedContent(tabId, false);
  await background.setContext(tabId, {
    platform: 'SHOPEE', token: 't1', uploadUrl: 'https://epmp.example.test/api', brandName: 'ArlaPH',
  });

  const result = await background.captureFromTab(tabId);

  assert.equal(result.ok, false);
  assert.match(result.error, /not authenticated/i);
  assert.match(result.error, /login\/verification/i);
  assert.equal(harness.getFetchCalls().length, 0, 'must never upload an unauthenticated capture');
  assert.equal(harness.getRemovedCookies().length, 0, 'a refusal must never run post-capture hygiene / wipe cookies');
  assert.equal(harness.getRemovedTabIds().length, 0, 'a refusal must leave the tab open so the operator can retry');
  const ctxAfter = await background.getContext(tabId);
  assert.ok(ctxAfter, 'context must survive a refusal so the operator can finish logging in and retry on the same tab');
});

test('captureFromTab: endpointStatus discovered -> uploaded (strongest proof; no marker needed)', async () => {
  const tabId = 202;
  harness.seedTab(tabId, 'https://seller.shopee.ph/portal/home');
  harness.seedCookies('shopee.ph', [{ name: 'SPC_SEC', value: 'y' }]);
  harness.setProductCapture(tabId, [{
    preferred: true,
    url: 'https://seller.shopee.ph/api/v3/product/list?page_number=1',
    method: 'GET',
    json: { items: [{ name: 'Widget' }] },
  }]);
  // Deliberately leave the marker unset (false) — discovery alone must carry this.
  harness.setAuthenticatedContent(tabId, false);
  await background.setContext(tabId, {
    platform: 'SHOPEE',
    token: 't2',
    uploadUrl: 'https://epmp.example.test/api',
    productListUrl: 'https://seller.shopee.ph/portal/product/list',
    brandName: 'ArlaPH',
  });

  const result = await background.captureFromTab(tabId);

  assert.equal(result.ok, true);
  assert.equal(harness.getFetchCalls().length, 1);
  const body = harness.getFetchBody();
  assert.equal(body.endpointStatus, 'discovered');
  assert.ok(body.productEndpoint, 'the discovered endpoint must ride along in the upload body');
  assert.ok(harness.getRemovedCookies().length > 0, 'a successful capture must run post-capture hygiene');
  assert.deepEqual(harness.getRemovedTabIds(), [tabId]);
  assert.equal(await background.getContext(tabId), null, 'context clears on success');
});

test('captureFromTab: no discovery attempted, authenticated-content marker visible -> uploaded', async () => {
  const tabId = 203;
  harness.seedTab(tabId, 'https://sellercenter.lazada.com.ph/apps/dashboard');
  harness.seedCookies('lazada.com.ph', [{ name: 'lzd_sid', value: 'z' }]);
  harness.setAuthenticatedContent(tabId, true);
  await background.setContext(tabId, {
    platform: 'LAZADA', token: 't3', uploadUrl: 'https://epmp.example.test/api', brandName: 'BrandX',
  });

  const result = await background.captureFromTab(tabId);

  assert.equal(result.ok, true);
  assert.equal(harness.getFetchCalls().length, 1);
  const body = harness.getFetchBody();
  assert.equal(body.endpointStatus, undefined, 'no productListUrl was supplied, so discovery must never have run');
  assert.ok(harness.getRemovedCookies().length > 0);
  assert.deepEqual(harness.getRemovedTabIds(), [tabId]);
});

// Cross-link, not a duplicate: the "act once instead of wait-for-condition"
// autofill regression already has full coverage under login-fill.test.js.
test('cross-link: autofill late-mount regression is covered by login-fill.test.js, not duplicated here', () => {
  // See login-fill.test.js: "fillWhenReady: fills a form that mounts AFTER
  // the first poll (the SPA regression)". background.js's attemptLoginFill()
  // delegates the actual late-mount polling to fillWhenReady() inside
  // login-fill.js (injected into the tab via chrome.scripting.executeScript),
  // so that regression's coverage lives there. This assertion only keeps the
  // cross-link discoverable/greppable from this file.
  assert.ok(true);
});

// ── The auto-capture path (chrome.tabs.onUpdated) ───────────────────────────
test('onUpdated auto-capture: the Shopee Main/Sub Account button is clicked exactly once per tab', async () => {
  const tabId = 301;
  const loginUrl = 'https://accounts.shopee.ph/seller/login';
  harness.seedTab(tabId, loginUrl);
  harness.setShopeeButtonPresent(tabId, true);
  await background.setContext(tabId, {
    platform: 'SHOPEE', token: 't4', uploadUrl: 'https://epmp.example.test/api',
  });

  await background.handleTabsOnUpdated(tabId, { status: 'complete' }, { id: tabId, url: loginUrl });
  assert.equal(harness.getScriptingCallsMatching('el.click()').length, 1,
    'the first complete event on the main-login page clicks the button once');
  const ctxAfterFirst = await background.getContext(tabId);
  assert.equal(ctxAfterFirst.mainSubClicked, true);

  // A second 'complete' event on the SAME (still main-login) URL — e.g. a
  // stray re-render — must NOT click a second time (v2.6.3's one-shot guard).
  await background.handleTabsOnUpdated(tabId, { status: 'complete' }, { id: tabId, url: loginUrl });
  assert.equal(harness.getScriptingCallsMatching('el.click()').length, 1,
    'the one-shot guard must prevent a second click');
  assert.equal(harness.getFetchCalls().length, 0, 'no capture should ever be attempted from the login page itself');
});

test('onUpdated auto-capture: bails when the dashboard URL matches but the authenticated marker has not rendered yet', async () => {
  const tabId = 302;
  const dashboardUrl = 'https://sellercenter.lazada.com.ph/apps/dashboard';
  harness.seedTab(tabId, dashboardUrl);
  harness.setAuthenticatedContent(tabId, false); // URL says "arrived"; content says "not really"
  await background.setContext(tabId, {
    platform: 'LAZADA', token: 't5', uploadUrl: 'https://epmp.example.test/api',
  });

  await background.handleTabsOnUpdated(tabId, { status: 'complete' }, { id: tabId, url: dashboardUrl });

  assert.equal(harness.getFetchCalls().length, 0, 'must not capture a URL-matched-but-not-rendered page');
  const ctx = await background.getContext(tabId);
  assert.ok(ctx, 'context must survive so a later complete event (or the manual banner button) can still try');
  assert.equal(ctx.autoCaptureInFlight, false, 'the in-flight slot must be released on a readiness miss');
  assert.ok(!ctx.autoCaptureAttempted, 'a readiness miss is NOT the one attempt — it must stay eligible to retry');
});

test('onUpdated auto-capture: proceeds hands-off once the marker is visible', async () => {
  const tabId = 303;
  const dashboardUrl = 'https://sellercenter.lazada.com.ph/apps/dashboard';
  harness.seedTab(tabId, dashboardUrl);
  harness.seedCookies('lazada.com.ph', [{ name: 'lzd_sid', value: 'w' }]);
  harness.setAuthenticatedContent(tabId, true);
  await background.setContext(tabId, {
    platform: 'LAZADA', token: 't6', uploadUrl: 'https://epmp.example.test/api', brandName: 'BrandY',
  });

  await background.handleTabsOnUpdated(tabId, { status: 'complete' }, { id: tabId, url: dashboardUrl });

  assert.equal(harness.getFetchCalls().length, 1, 'a passing readiness gate should trigger exactly one hands-off capture');
  assert.equal(await background.getContext(tabId), null, 'a successful auto-capture clears the context');
  assert.ok(
    harness.getScriptingCallsMatching('__epmpConnectShowBanner').length > 0,
    'the operator must see a banner confirmation, not a silently closing tab',
  );
});
