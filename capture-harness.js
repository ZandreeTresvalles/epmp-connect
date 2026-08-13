/**
 * test-harness.js — DI fakes for `chrome.tabs`, `chrome.scripting`,
 * `chrome.cookies`, `chrome.storage.session`, `chrome.runtime`, and `fetch`,
 * so `background.js` can be `require()`d and driven end-to-end under
 * `node --test` with zero browser (see capture-flow.test.js).
 *
 * ── WHY A HARNESS INSTEAD OF PER-TEST MOCKS ─────────────────────────────────
 * background.js registers its `chrome.tabs.onUpdated` / `onRemoved` /
 * `chrome.runtime.onMessage` listeners ONCE, at require()-time (top-level
 * `addListener(...)` calls — see background.js's node-compat notes). That
 * means `globalThis.chrome` must already exist, fully shaped, BEFORE the
 * first `require('./background.js')` in a test file — there is no later hook
 * to inject it. One shared fake built here, installed once per test file via
 * `harness.install()`, then `reset()` between tests, is what makes that
 * possible without re-requiring the module (which node's module cache would
 * silently no-op anyway).
 *
 * ── HOW SCRIPTED chrome.scripting.executeScript RESULTS WORK ────────────────
 * background.js calls `chrome.scripting.executeScript` for many different
 * purposes (inject a file, invoke a page-context helper, poll a marker...),
 * always with a real function passed as `func`. Rather than actually
 * evaluating that function against a fake DOM (no DOM exists here), the fake
 * below recognizes WHICH helper is being invoked by a stable substring in
 * `func.toString()` — every page-context helper background.js injects has a
 * distinct, greppable name (`__epmpIsAuthenticatedContent`,
 * `__epmpProductCapture`, `__epmpConnectFillLogin`, `__epmpConnectShowBanner`)
 * or a distinct body shape (`localStorage.length`, `el.click()`) — and
 * returns whatever the test configured for that tab via the setters below.
 * A `files:[...]`-only call (script injection, no invocation) is a no-op:
 * nothing in background.js reads its result.
 *
 * Run via capture-flow.test.js: `node --test`.
 */
'use strict';

function createHarness() {
  const state = {
    nextTabId: 1,
    tabs: new Map(), // tabId -> { id, url, active }
    removedTabIds: [],
    updatedTabCalls: [], // { tabId, changes }
    focusedWindowIds: [],

    storageSession: {}, // key -> value

    cookies: [], // { name, value, domain, path, session, expirationDate, httpOnly, secure, sameSite, storeId, partitionKey }
    removedCookies: [], // the `details` passed to chrome.cookies.remove
    cookiesGetAllShouldThrowForDomain: new Set(),
    cookiesRemoveShouldThrowForName: new Set(),

    scriptingCalls: [], // every `details` object passed to executeScript
    authenticatedContent: {}, // tabId -> boolean, what __epmpIsAuthenticatedContent() "returns"
    productCapture: {}, // tabId -> array|null, what window.__epmpProductCapture "is"
    localStorageByTab: {}, // tabId -> { origin, items }
    fillLoginResult: {}, // tabId -> number of fields "filled"
    shopeeButtonPresent: {}, // tabId -> boolean

    fetchCalls: [], // { url, init }
    fetchImpl: defaultFetchImpl,

    manifest: {
      version: '2.7.0',
      content_scripts: [
        {
          matches: ['https://epmp-orpin.vercel.app/*', 'http://localhost:3000/*'],
          js: ['bridge.js'],
        },
      ],
    },

    tabsOnUpdatedListeners: [],
    tabsOnRemovedListeners: [],
    runtimeOnMessageListeners: [],
  };

  async function defaultFetchImpl(_url, _init) {
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  }

  // ── chrome.tabs ────────────────────────────────────────────────────────────
  const tabs = {
    async create({ url } = {}) {
      const id = state.nextTabId++;
      const tab = { id, url, active: true };
      state.tabs.set(id, tab);
      return { ...tab };
    },
    async get(tabId) {
      const t = state.tabs.get(tabId);
      if (!t) {
        const err = new Error(`No tab with id: ${tabId}`);
        throw err;
      }
      return { ...t };
    },
    async update(tabId, changes = {}) {
      state.updatedTabCalls.push({ tabId, changes });
      const t = state.tabs.get(tabId);
      if (!t) return undefined;
      if (typeof changes.url === 'string') t.url = changes.url;
      if (typeof changes.active === 'boolean') t.active = changes.active;
      return { ...t };
    },
    async remove(tabId) {
      state.removedTabIds.push(tabId);
      state.tabs.delete(tabId);
    },
    async query(_opts = {}) {
      // Simplified on purpose: real chrome.tabs.query({url}) glob-matches;
      // tests seed exactly the tabs they want findFallbackOriginTab() to see
      // via harness.seedTab(), so returning every known tab is sufficient and
      // keeps this fake from needing a URL-pattern matcher no test exercises.
      return Array.from(state.tabs.values()).map((t) => ({ ...t }));
    },
    onUpdated: { addListener(cb) { state.tabsOnUpdatedListeners.push(cb); } },
    onRemoved: { addListener(cb) { state.tabsOnRemovedListeners.push(cb); } },
  };

  // ── chrome.windows (only .update is called, by refocusOriginTab) ───────────
  const windows = {
    async update(windowId, changes) {
      state.focusedWindowIds.push({ windowId, changes });
    },
  };

  // ── chrome.cookies ───────────────────────────────────────────────────────
  const cookies = {
    async getAll({ domain } = {}) {
      if (state.cookiesGetAllShouldThrowForDomain.has(domain)) {
        throw new Error(`fake getAll() failure for domain ${domain}`);
      }
      return state.cookies.filter((c) => c.domain === domain).map((c) => ({ ...c }));
    },
    async remove(details) {
      state.removedCookies.push(details);
      if (state.cookiesRemoveShouldThrowForName.has(details.name)) {
        throw new Error(`fake remove() failure for cookie ${details.name}`);
      }
      const host = (details.url || '').replace(/^https?:\/\//, '').split('/')[0];
      state.cookies = state.cookies.filter((c) => {
        const cHost = (c.domain || '').startsWith('.') ? c.domain.slice(1) : c.domain;
        return !(c.name === details.name && cHost === host);
      });
    },
  };

  // ── chrome.scripting ─────────────────────────────────────────────────────
  // See the module header for the "how scripted results work" explanation.
  async function executeScript(details) {
    state.scriptingCalls.push(details);
    const tabId = details && details.target && details.target.tabId;

    if (Array.isArray(details.files)) {
      // File injection only (banner.js / login-fill.js / page-state.js) —
      // no call site reads this result.
      return [{ result: undefined }];
    }

    const fn = details.func;
    const src = typeof fn === 'function' ? fn.toString() : '';

    if (src.includes('__epmpProductCapture')) {
      const captured = state.productCapture[tabId];
      return [{ result: captured === undefined ? null : captured }];
    }
    if (src.includes('__epmpIsAuthenticatedContent')) {
      const v = state.authenticatedContent[tabId];
      return [{ result: v === undefined ? false : v }];
    }
    if (src.includes('localStorage.length')) {
      const ls = state.localStorageByTab[tabId];
      return [{ result: ls === undefined ? { origin: 'https://example.test', items: [] } : ls }];
    }
    if (src.includes('__epmpConnectFillLogin')) {
      const v = state.fillLoginResult[tabId];
      return [{ result: typeof v === 'number' ? v : 0 }];
    }
    if (src.includes('__epmpConnectShowBanner')) {
      return [{ result: true }]; // banner push — result unused by callers
    }
    if (src.includes('el.click()')) {
      const raw = state.shopeeButtonPresent[tabId];
      const present = typeof raw === 'function' ? raw() : raw;
      return [{ result: !!present }];
    }
    return [{ result: undefined }];
  }

  // ── chrome.storage.session (+ a stub .local — background.js never touches
  // it, but popup.js does, so keeping the shape complete costs nothing) ────
  const storage = {
    session: {
      async get(key) {
        if (typeof key === 'string') return { [key]: state.storageSession[key] };
        return { ...state.storageSession };
      },
      async set(obj) { Object.assign(state.storageSession, obj); },
      async remove(key) { delete state.storageSession[key]; },
    },
    local: {
      async get() { return {}; },
      async set() {},
      async remove() {},
    },
  };

  // ── chrome.runtime ───────────────────────────────────────────────────────
  const runtime = {
    getManifest() { return state.manifest; },
    onMessage: { addListener(cb) { state.runtimeOnMessageListeners.push(cb); } },
  };

  const chrome = { tabs, windows, cookies, scripting: { executeScript }, storage, runtime };

  // ── fetch (global) ───────────────────────────────────────────────────────
  async function fakeFetch(url, init) {
    state.fetchCalls.push({ url, init });
    return state.fetchImpl(url, init);
  }

  return {
    chrome,

    /** Point globalThis.chrome / globalThis.fetch at the fakes. Call this
     * BEFORE the first `require('./background.js')` in a test file — its
     * top-level `addListener(...)` calls need `chrome` to already exist. */
    install() {
      globalThis.chrome = chrome;
      globalThis.fetch = fakeFetch;
    },

    /** Clear all per-test state EXCEPT the registered listeners — those are
     * captured once, at background.js's module-load time, and would be lost
     * (with no way to re-register them short of re-requiring, which node's
     * module cache won't actually do) if this cleared them too. */
    reset() {
      state.nextTabId = 1;
      state.tabs.clear();
      state.removedTabIds = [];
      state.updatedTabCalls = [];
      state.focusedWindowIds = [];
      state.storageSession = {};
      state.cookies = [];
      state.removedCookies = [];
      state.cookiesGetAllShouldThrowForDomain.clear();
      state.cookiesRemoveShouldThrowForName.clear();
      state.scriptingCalls = [];
      state.authenticatedContent = {};
      state.productCapture = {};
      state.localStorageByTab = {};
      state.fillLoginResult = {};
      state.shopeeButtonPresent = {};
      state.fetchCalls = [];
      state.fetchImpl = defaultFetchImpl;
    },

    // ── tab seeding / inspection ───────────────────────────────────────────
    seedTab(tabId, url, extra) {
      state.tabs.set(tabId, { id: tabId, url, active: true, ...extra });
      if (tabId >= state.nextTabId) state.nextTabId = tabId + 1;
      return tabId;
    },
    setTabUrl(tabId, url) {
      const t = state.tabs.get(tabId);
      if (t) t.url = url;
    },
    getTab(tabId) { const t = state.tabs.get(tabId); return t ? { ...t } : null; },
    getRemovedTabIds() { return [...state.removedTabIds]; },
    getUpdatedTabCalls() { return [...state.updatedTabCalls]; },

    // ── scripting scenario setters ──────────────────────────────────────────
    setAuthenticatedContent(tabId, isAuthed) { state.authenticatedContent[tabId] = !!isAuthed; },
    setProductCapture(tabId, captured) { state.productCapture[tabId] = captured; },
    setLocalStorage(tabId, ls) { state.localStorageByTab[tabId] = ls; },
    setFillLoginResult(tabId, count) { state.fillLoginResult[tabId] = count; },
    /** `present` may be a boolean, or a function evaluated at each poll —
     *  the latter models a button that only mounts after N attempts. */
    setShopeeButtonPresent(tabId, present) {
      state.shopeeButtonPresent[tabId] = typeof present === 'function' ? present : !!present;
    },
    getScriptingCalls() { return [...state.scriptingCalls]; },
    /** Scripting calls whose injected function body contains `needle` —
     * e.g. 'el.click()' to count Shopee Main/Sub button click attempts. */
    getScriptingCallsMatching(needle) {
      return state.scriptingCalls.filter((d) => typeof d.func === 'function' && d.func.toString().includes(needle));
    },

    // ── cookies ──────────────────────────────────────────────────────────────
    seedCookies(domain, cookieList) {
      for (const c of cookieList) state.cookies.push({ domain, path: '/', ...c });
    },
    getCookies() { return [...state.cookies]; },
    getRemovedCookies() { return [...state.removedCookies]; },
    makeCookiesGetAllThrow(domain) { state.cookiesGetAllShouldThrowForDomain.add(domain); },
    makeCookieRemoveThrow(name) { state.cookiesRemoveShouldThrowForName.add(name); },

    // ── fetch / upload ───────────────────────────────────────────────────────
    setFetchImpl(fn) { state.fetchImpl = fn; },
    getFetchCalls() { return [...state.fetchCalls]; },
    /** Parsed JSON body of the Nth (default: last) fetch call, or null. */
    getFetchBody(index) {
      const calls = state.fetchCalls;
      if (!calls.length) return null;
      const call = calls[typeof index === 'number' ? index : calls.length - 1];
      try { return JSON.parse(call.init && call.init.body); } catch { return null; }
    },

    // ── manifest ─────────────────────────────────────────────────────────────
    setManifest(partial) { Object.assign(state.manifest, partial); },

    // ── listener triggers ────────────────────────────────────────────────────
    /** Invoke every registered chrome.tabs.onUpdated listener (there should
     * be exactly one — background.js's handleTabsOnUpdated) and await it. */
    async fireTabsOnUpdated(tabId, info, tab) {
      const results = [];
      for (const cb of state.tabsOnUpdatedListeners) results.push(await cb(tabId, info, tab));
      return results;
    },
    async fireTabsOnRemoved(tabId) {
      for (const cb of state.tabsOnRemovedListeners) await cb(tabId);
    },
    /** Invoke every registered chrome.runtime.onMessage listener the same
     * way Chrome does: pass a sendResponse collector, and resolve with
     * whatever value was passed to it (mirrors the extension's async
     * sendResponse pattern used throughout background.js). */
    fireRuntimeMessage(msg, sender) {
      return new Promise((resolve) => {
        let responded = false;
        const sendResponse = (value) => { responded = true; resolve(value); };
        for (const cb of state.runtimeOnMessageListeners) {
          const keepAlive = cb(msg, sender || {}, sendResponse);
          if (!keepAlive && !responded) resolve(undefined);
        }
      });
    },

    getListenerCounts() {
      return {
        tabsOnUpdated: state.tabsOnUpdatedListeners.length,
        tabsOnRemoved: state.tabsOnRemovedListeners.length,
        runtimeOnMessage: state.runtimeOnMessageListeners.length,
      };
    },
  };
}

module.exports = { createHarness };
