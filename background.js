/**
 * EPMP Connect — background service worker (unified capture engine).
 *
 * One extension, every project. It reconciles the three predecessor
 * extensions (audit-reports, encoder-reports/ReportBot, epmp):
 *
 *   - Bridge flow (encoder + epmp): the project's web app triggers a capture.
 *     We open the platform login tab, inject a banner, and the operator clicks
 *     "Capture Session" after logging in. We read cookies + localStorage, build
 *     a Playwright storageState, and POST it with the one-time capture token.
 *   - Popup flow (audit + fallback): the operator captures the ACTIVE tab from
 *     the toolbar popup (see popup.js). Same upload contract.
 *   - Product-list discovery (epmp): when a productListUrl is supplied, we
 *     navigate the tab there and let interceptor.js record the catalog endpoint,
 *     attaching it to the upload. Best-effort — never blocks the session capture.
 *
 * Capture context lives in chrome.storage.session (survives SW restarts).
 *
 * Upload contract (all backends agree): POST {origin}/api/v1/automation/sessions
 * with Authorization: Bearer <token>, body { storageState, ...optional }.
 */

// page-state.js is THE canonical answer to "what kind of page is this?" —
// login form / dashboard / still-authenticating / genuinely authenticated
// content. Loaded first so every predicate below resolves from it. A classic
// script (no ES export) precisely so the same file also injects into a page
// and require()s under node --test. See its header for the CANONICAL AUTH
// SPEC mirrored in the worker + box.
// node --test: importScripts doesn't exist there, and there is no global
// `self` — alias it to globalThis (page-state.js's own node guard populates
// self.EpmpPageState, exactly like it populates the real `self` in the
// service-worker realm) before pulling the file in via require(). Dead code
// in the browser: `importScripts` always exists in a service worker, so the
// `else` branch never runs there.
if (typeof importScripts === 'function') {
  importScripts('page-state.js');
} else if (typeof require !== 'undefined') {
  globalThis.self = globalThis.self || globalThis;
  require('./page-state.js');
}

// ── Platform config ──────────────────────────────────────────────────────────
// Cookie domains are the broad registrable domains. chrome.cookies.getAll({domain})
// matches the domain AND all subdomains, so these cover seller.*, subaccount.*,
// accounts.*, sellercenter.* etc. without listing each host.
const PLATFORM_COOKIE_DOMAINS = {
  SHOPEE: ['shopee.ph', 'shopee.com'],
  LAZADA: ['lazada.com.ph', 'lazada.com'],
  TIKTOK: ['tiktok.com', 'tiktokshop.com'],
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Test-only timing seam ────────────────────────────────────────────────────
// Every value here is a real production default — unchanged from whatever
// each feature shipped with (see the comments at each call site for why that
// particular number). They live on one mutable object, instead of as
// standalone consts, ONLY so capture-flow.test.js can shrink them before
// driving a flow that would otherwise really wait: hasAuthenticatedContent's
// 8s timeout, runDiscovery's up-to-30s poll loop, the 1.5s cookie-settle
// retry, the 1.7s post-capture hygiene pause. node --test must stay hermetic
// (no real multi-second waits) — nothing in the browser ever mutates this
// object, so the production path always runs with these exact defaults.
const TEST_TIMEOUTS = {
  AUTH_CONTENT_POLL_INTERVAL_MS: 500,
  AUTH_CONTENT_TIMEOUT_MS: 8000,
  AUTO_CAPTURE_SETTLE_MS: 1500,
  POST_CAPTURE_HYGIENE_DELAY_MS: 1700,
  DISCOVERY_POLL_INTERVAL_MS: 2500,
  DISCOVERY_MAX_ITERATIONS: 12,
};

// ── Page-state predicates → page-state.js ───────────────────────────────────
// The four questions this file used to answer inline — AUTH_PATH,
// DASHBOARD_PATTERNS, LOGIN_PATH, LOGIN_PAGE_PATTERNS — plus the positive
// authenticated-content check the capture guard needs, now live in ONE
// canonical module. Answering them in several places, each slightly
// different, is exactly what produced five point-fix releases in two days
// (see page-state.js's header). Never re-define them here.
// NEVER destructure these into bare top-level `const`s here. importScripts()
// shares ONE global lexical scope with this file, so a top-level
// `const isAuthPath = …` in background.js collides with page-state.js's own
// top-level declaration of the same name and the service worker dies at
// registration with "Identifier 'X' has already been declared" — which
// presents to the operator as "Extension did not respond — is EPMP Connect
// installed?" (shipped briefly in v2.7.0; see page-state-collision.test.js,
// which fails if this rule is broken again). Node's require() gives each
// module its own scope, so node --test can NOT catch this — only the
// collision test can.
const PageState = self.EpmpPageState;

// Locally-named aliases (names that deliberately do NOT exist in
// page-state.js, so they cannot collide).
const looksLikeDashboard = PageState.isDashboardUrl;
const looksLikeLoginPage = PageState.isLoginPage;
const looksLikeAuthPath = PageState.isAuthPath;

// ── Upload URL normalization ─────────────────────────────────────────────────
// Callers give us one of: a bare origin (https://host), a base ending in /api,
// or a full upload URL. Normalize all to {origin}/api/v1/automation/sessions.
function resolveUploadUrl(input) {
  if (!input) return null;
  let s = String(input).trim().replace(/\/+$/, '');
  if (/\/automation\/sessions$/.test(s)) return s;        // already a full upload URL
  s = s.replace(/\/api$/, '');                            // drop a trailing /api if present
  return `${s}/api/v1/automation/sessions`;
}

// ── Capture context (per login tab), persisted across SW restarts ────────────
async function setContext(tabId, ctx) {
  await chrome.storage.session.set({ [`ctx_${tabId}`]: ctx });
}
async function getContext(tabId) {
  const key = `ctx_${tabId}`;
  const bag = await chrome.storage.session.get(key);
  return bag[key] || null;
}
async function clearContext(tabId) {
  await chrome.storage.session.remove(`ctx_${tabId}`);
}

// ── Cookie / localStorage helpers ────────────────────────────────────────────
// Playwright/CDP-friendly cookie: always emit `expires` (-1 = session cookie),
// map sameSite to Strict|Lax|None (unspecified/default -> Lax).
function toPlaywrightCookie(c) {
  const sameSiteMap = {
    strict: 'Strict', lax: 'Lax', no_restriction: 'None', unspecified: 'Lax',
  };
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.session || typeof c.expirationDate !== 'number' ? -1 : Math.round(c.expirationDate),
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: sameSiteMap[c.sameSite] || 'Lax',
  };
}

async function collectCookies(platform) {
  const domains = PLATFORM_COOKIE_DOMAINS[platform] || [];
  const seen = new Set();
  const out = [];
  for (const domain of domains) {
    let cookies = [];
    try { cookies = await chrome.cookies.getAll({ domain }); } catch { /* ignore */ }
    for (const c of cookies) {
      const key = `${c.name}|${c.domain}|${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(toPlaywrightCookie(c));
    }
  }
  return out;
}

// Read localStorage from the tab as [{name,value}]. Best-effort per origin.
async function collectLocalStorage(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const out = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            out.push({ name: k, value: localStorage.getItem(k) });
          }
        } catch { /* storage blocked */ }
        return { origin: location.origin, items: out };
      },
    });
    return res?.result || null;
  } catch {
    return null;
  }
}

// ── Post-capture hygiene (v2.5.0) ────────────────────────────────────────────
// After EVERY successful capture — all three platforms, always on, no toggle
// — the operator is deliberately logged out of the platform LOCALLY, so the
// next brand's capture on this machine cannot silently reuse whichever
// account happened to still be signed in. That's exactly how the wrong-shop
// captures this plan responds to happened (one login, multiple brands, no
// logout in between). Cookie deletion only: this code NEVER navigates to, or
// fetches, a platform logout endpoint — that could invalidate the
// server-side session token we just captured and uploaded.
//
// Runs from exactly one call site: the single uploadSession() success point
// inside captureFromTab() below. A thrown/rejected upload never reaches this
// code, so a failed capture/upload always leaves cookies and the tab
// untouched — the operator can retry without re-login.
//
// Every step is independently best-effort and fail-open (its own try/catch):
// a hygiene failure is logged to the service-worker console but never turns
// a successful capture into a failure or blocks the return value.

// Delete every cookie chrome.cookies.getAll() returns for the platform's
// registrable domains. Deliberately reuses PLATFORM_COOKIE_DOMAINS (declared
// above) rather than a second hardcoded list — it's already the code-level
// mirror of manifest.json's host_permissions (kept in sync by convention, see
// CLAUDE.md) and the exact domain set collectCookies() reads for this
// platform, so "cookies we captured" and "cookies we wipe" can never drift
// apart. chrome.cookies.getAll({domain}) matches the domain AND all
// subdomains, so seller.*/accounts.*/sellercenter.* etc. are covered.
// Also the implementation behind the pre-login forceFreshLogin wipe (the
// former clearPlatformCookies was consolidated into this in v2.5.0).
async function removeCookiesForPlatform(platform) {
  const domains = PLATFORM_COOKIE_DOMAINS[platform] || [];
  const seen = new Set();
  let removed = 0;
  let failed = 0;

  for (const domain of domains) {
    let cookies = [];
    try {
      cookies = await chrome.cookies.getAll({ domain });
    } catch {
      failed += 1;
      continue;
    }

    for (const c of cookies) {
      const key = `${c.name}|${c.domain}|${c.path}|${c.storeId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Reconstruct the removal URL: https:// + domain with any leading dot
      // stripped + path. Always https — Chrome only matches a Secure cookie
      // against an https:// removal URL, and every platform here is
      // https-only anyway, so this covers secure cookies without excluding
      // non-secure ones.
      const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      const details = { url: `https://${host}${c.path || '/'}`, name: c.name, storeId: c.storeId };

      try {
        if (c.partitionKey) {
          // Partitioned (CHIPS) cookie — pass partitionKey through so the
          // right partition is targeted. Some Chrome/cookies-API versions
          // reject an unrecognized partitionKey field on remove(); retry
          // without it rather than counting that as a real failure.
          try {
            await chrome.cookies.remove({ ...details, partitionKey: c.partitionKey });
            removed += 1;
            continue;
          } catch {
            /* fall through to the unpartitioned retry below */
          }
        }
        await chrome.cookies.remove(details);
        removed += 1;
      } catch {
        failed += 1;
      }
    }
  }

  return { removed, failed };
}

// ── Pre-capture wipe scope: cookies only (v2.6.1) ────────────────────────────
// v2.6.0 introduced a hard guard here that wiped BOTH cookies AND site
// storage/cache — localStorage, IndexedDB, Service Workers, Cache Storage,
// and the HTTP cache via chrome.browsingData.remove over a list of enumerated
// per-platform origins, plus a one-shot in-tab localStorage/sessionStorage
// clear once the login tab loaded. The intent was closing the wrong-shop
// capture gap where a stale localStorage/IndexedDB token could silently
// resurrect a session even after every cookie for the domain was gone.
//
// In practice the site-storage half of that wipe broke fresh logins instead
// of protecting them: Shopee and TikTok both use browser site-storage state
// as part of their DEVICE-TRUST fingerprint, and wiping it out from under a
// login makes the device look brand-new to the platform every single time —
// Shopee responds by force-logging the operator back out right after login
// succeeds, and TikTok throws up a "Browser invalid" wall before the session
// is usable. Confirmed by direct comparison: a Shopee capture succeeded at
// 12:57 under v2.5.0 (cookie wipes only) and died at 13:27 under v2.6.0
// (cookie + site-storage wipes), with no other change in between.
//
// Cookies alone carry the login state on all three platforms, so
// removeCookiesForPlatform() (above) is already sufficient to guarantee a
// fresh, non-reused login — the fresh-login guarantee this guard exists for
// never depended on the site-storage half. v2.6.1 therefore scopes this guard
// back down to cookies-only: startCapture() below now calls
// removeCookiesForPlatform(platform) directly instead of a separate
// site-data-wiping wrapper. The guard is still unconditional and still runs
// before the login tab opens — only its blast radius shrank back to what
// v2.5.0 shipped. wipePlatformSiteData/siteDataOriginsForPlatform/
// SITE_DATA_ORIGIN_PREFIXES/EXTRA_SITE_DATA_HOSTS/clearTabStorage and the
// `browsingData` manifest permission are gone — nothing else in this file
// used them.

// Fallback "what tab was the operator probably looking at" when no explicit
// originating tab is known (the popup and banner-button capture paths never
// open a separate tab, so there's nothing to remember there). Derived from
// bridge.js's own content-script match patterns in the manifest — the known
// frontend origins — rather than a second hardcoded URL list.
function frontendOriginPatterns() {
  try {
    const scripts = chrome.runtime.getManifest().content_scripts || [];
    const bridgeEntry = scripts.find((cs) => (cs.js || []).includes('bridge.js'));
    return (bridgeEntry && bridgeEntry.matches) || [];
  } catch {
    return [];
  }
}

async function findFallbackOriginTab() {
  const patterns = frontendOriginPatterns();
  if (!patterns.length) return null;
  try {
    const tabs = await chrome.tabs.query({ url: patterns });
    if (!tabs.length) return null;
    // Most-recently-active first when the field is available (Chrome 121+);
    // otherwise query() order is a good enough guess — this is a fallback,
    // never a guarantee.
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return tabs[0];
  } catch {
    return null;
  }
}

// Refocus the tab that kicked off this capture (bridge flow: ctx.originTabId)
// or, failing that, the most recently active known frontend tab. No-ops if
// neither is available — the plan's "fail-open" contract: worst case, nothing
// is focused.
async function refocusOriginTab(ctx) {
  let originTab = null;
  if (ctx.originTabId) {
    try { originTab = await chrome.tabs.get(ctx.originTabId); } catch { originTab = null; }
  }
  if (!originTab) originTab = await findFallbackOriginTab();
  if (!originTab) return;
  await chrome.tabs.update(originTab.id, { active: true });
  await chrome.windows.update(originTab.windowId, { focused: true });
}

// The orchestration: tell the operator, wipe cookies, close the tab, refocus.
// Order matters for the banner message — it must be pushed (and briefly
// visible) BEFORE the tab closes underneath it.
async function runPostCaptureHygiene(tabId, ctx) {
  const platform = ctx.platform;
  const label = PLATFORM_LABELS[platform] || platform;
  const message = `Captured ✓ — you've been logged out of ${label} so the next brand starts from a clean login.`;

  // Brief — the flow should still feel fast. showBannerState already
  // swallows a failure (tab already gone/navigated) via its own try/catch.
  await showBannerState(tabId, platform, 'success', message).catch(() => {});
  await delay(TEST_TIMEOUTS.POST_CAPTURE_HYGIENE_DELAY_MS);

  try {
    const { removed, failed } = await removeCookiesForPlatform(platform);
    console.log(`[EPMP Connect] post-capture hygiene: removed ${removed} ${label} cookie(s)`
      + (failed ? `, ${failed} failed` : ''));
  } catch (e) {
    console.warn('[EPMP Connect] post-capture hygiene: cookie wipe threw', e);
  }

  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    console.warn('[EPMP Connect] post-capture hygiene: failed to close capture tab', e);
  }

  try {
    await refocusOriginTab(ctx);
  } catch (e) {
    console.warn('[EPMP Connect] post-capture hygiene: failed to refocus originating tab', e);
  }
}

// ── Banner injection (login tab) ─────────────────────────────────────────────
async function injectBanner(tabId, platform) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['banner.js'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (p) => window.__epmpConnectShowBanner && window.__epmpConnectShowBanner(p),
      args: [platform || ''],
    });
  } catch { /* tab may not be ready; onUpdated will retry */ }
}

// ── Seller-login auto-fill (v2.3.0) ──────────────────────────────────────────
// First-party autofill into the operator's OWN login form — not stealth, not
// anti-bot evasion. Fills only; the operator still clicks Login and completes
// OTP/2FA by hand. See login-fill.js (injected below) for the field-picking
// and value-setting logic and its security contract (never auto-submit,
// never log the values).
//
// At most LOGIN_FILL_MAX_ATTEMPTS onUpdated 'complete' events get a fill
// attempt per tab — normally just the first arrival, but SPA logins can
// redirect through more than one URL that matches the login-page pattern
// before the real form mounts, or (rarely) re-render and clear what was just
// typed; a second attempt covers that without ever spinning indefinitely.
// `login` is wiped from the tab context as soon as a fill actually sets a
// field, or once the attempt cap is reached with nothing to show for it —
// either way it never lingers in chrome.storage.session longer than needed.
const LOGIN_FILL_MAX_ATTEMPTS = 2;

// Inject login-fill.js (if not already present on this tab) and invoke it.
// Returns the number of fields filled (0/1/2); never throws.
async function fillLoginFields(tabId, platform, username, password) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['login-fill.js'] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (p, u, pw) => (window.__epmpConnectFillLogin ? window.__epmpConnectFillLogin(p, u, pw) : 0),
      args: [platform, username, password],
    });
    return res?.result || 0;
  } catch {
    return 0; // tab navigated away mid-injection, CSP blocked it, etc. — best-effort.
  }
}

// ── Shopee: steer to the Main/Sub Account login (v2.6.3) ────────────────────
// Shopee's seller login (accounts.shopee.ph/seller/login) defaults to the
// MAIN-account form (`input[name=loginKey]`), but this org logs in with
// SUB-accounts (e.g. `arlaph.dataccess`). That page carries a
// "Login with Main/Sub Account" button which navigates to Shopee's unified
// OAuth form at account.seller.shopee.com — placeholder
// "Main/subaccount name/phone/email", hint "input main/subaccount login name
// 'XXX:main'" — whose redirect_uri establishes a real Seller Centre session.
//
// That OAuth URL CANNOT be linked to directly: it carries `sign`, `timestamp`
// and `max_auth_age=600`, i.e. Shopee signs it per-request and it expires in
// ~10 minutes (probed: stripping those params returns
// "400 Error Param: ClientId/Scope/RedirectUri required"). Clicking Shopee's
// own button is therefore the only durable way to reach it — Shopee mints a
// fresh signed URL each time.
//
// SCOPE: this clicks ONE navigation button on the operator's own login page.
// It never types, submits, or reads credentials — the "fill only, never
// auto-submit" contract is untouched. One-shot per tab (ctx.mainSubClicked)
// so a failed click can never loop, and entirely fail-open: if the button is
// absent or the click throws, the operator simply stays on the page they can
// still use by hand.
const SHOPEE_MAIN_SUB_BUTTON_RE = /login with main\s*\/?\s*sub account/i;

function isShopeeMainLoginPage(urlStr) {
  try {
    const u = new URL(urlStr);
    return /(^|\.)accounts\.shopee\.[a-z.]+$/i.test(u.hostname) && /\/seller\/login/i.test(u.pathname);
  } catch {
    return false;
  }
}

async function clickShopeeMainSubLogin(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [SHOPEE_MAIN_SUB_BUTTON_RE.source],
      func: (reSrc) => {
        const re = new RegExp(reSrc, 'i');
        const el = Array.from(document.querySelectorAll('button, a, [role="button"]'))
          .find((e) => re.test((e.textContent || '').replace(/\s+/g, ' ').trim()));
        if (!el) return false;
        el.click();
        return true;
      },
    });
    return Boolean(res && res.result);
  } catch {
    return false; // tab navigated away / CSP / no permission — best-effort.
  }
}

// Called from the onUpdated listener below whenever a tracked tab carries a
// still-live `login` and finishes loading. No-ops immediately (and cheaply)
// unless the tab is actually on the platform's login page.
async function attemptLoginFill(tabId, ctx, tab) {
  if (!ctx.login || !ctx.login.username || !ctx.login.password) return;

  const attempts = ctx.loginFillAttempts || 0;
  if (attempts >= LOGIN_FILL_MAX_ATTEMPTS) {
    // Cap already reached on a previous 'complete' event — should have been
    // wiped then, but wipe defensively here too rather than leave it stale.
    const latest = await getContext(tabId);
    if (latest && latest.login) {
      const { login, ...rest } = latest;
      await setContext(tabId, rest);
    }
    return;
  }

  if (!looksLikeLoginPage(ctx.platform, tab.url || '')) return;

  const nextAttempts = attempts + 1;
  const filledCount = await fillLoginFields(tabId, ctx.platform, ctx.login.username, ctx.login.password);

  const latest = await getContext(tabId);
  if (!latest) return; // capture already completed / tab closed meanwhile

  if (filledCount > 0 || nextAttempts >= LOGIN_FILL_MAX_ATTEMPTS) {
    // Either we actually set something (done — wipe now so the credentials
    // don't linger), or we've used every attempt with nothing to show for it
    // (also wipe — no more tries, never spin).
    const { login, ...rest } = latest;
    await setContext(tabId, { ...rest, loginFillAttempts: nextAttempts });
  } else {
    await setContext(tabId, { ...latest, loginFillAttempts: nextAttempts });
  }
}

// ── Banner state helpers (success / notice / error feedback) ────────────────
// Every terminal capture outcome — success, or a failure the operator needs to
// know about — pushes an explicit state into the banner (see banner.js) so a
// capture never resolves in silence. Best-effort throughout: a banner-push
// failure (tab closed/navigated away mid-capture, etc.) must never affect the
// capture result itself, so every caller treats this as fire-and-forget.
const PLATFORM_LABELS = { SHOPEE: 'Shopee', LAZADA: 'Lazada', TIKTOK: 'TikTok' };

function captureLabel(ctx) {
  const platform = ctx && ctx.platform;
  return (ctx && ctx.brandName) || PLATFORM_LABELS[platform] || platform || 'Seller Center';
}

function successMessage(ctx) {
  return `Session captured for ${captureLabel(ctx)} — EPMP is connected. You can close this tab.`;
}

async function showBannerState(tabId, platform, state, message) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['banner.js'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (p, s, m) => window.__epmpConnectShowBanner && window.__epmpConnectShowBanner(p, { state: s, message: m }),
      args: [platform || '', state, message || ''],
    });
  } catch { /* tab may be gone/navigated away — feedback is best-effort */ }
}

// ── Product-list discovery (epmp) ────────────────────────────────────────────
// interceptor.js (MAIN world) records product-list responses into
// window.__epmpProductCapture. We navigate to productListUrl, poll for a hit,
// and shape a { productEndpoint, sampleResponse } to attach to the upload.
// `onProgress(elapsedSeconds)` fires each poll tick so the banner can count
// up instead of freezing — this ~30s page-reload-then-wait is the exact
// stretch operators reported as "the site refreshes and gets stuck".
async function runDiscovery(tabId, productListUrl, onProgress) {
  if (!productListUrl) return { endpointStatus: null };
  try {
    await chrome.tabs.update(tabId, { url: productListUrl });
    for (let i = 0; i < TEST_TIMEOUTS.DISCOVERY_MAX_ITERATIONS; i++) {
      await delay(TEST_TIMEOUTS.DISCOVERY_POLL_INTERVAL_MS);
      if (onProgress) {
        try {
          await onProgress(Math.round(((i + 1) * TEST_TIMEOUTS.DISCOVERY_POLL_INTERVAL_MS) / 1000));
        } catch { /* feedback only */ }
      }
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => (window.__epmpProductCapture || null),
      });
      const captured = res?.result;
      if (Array.isArray(captured) && captured.length) {
        const preferred = captured.find((c) => c.preferred) || (i >= 3 ? captured[0] : null);
        if (preferred) {
          const pageParam = ['page_number', 'pageNum', 'page', 'offset'].find(
            (p) => preferred.url?.includes(p) || (preferred.body && String(preferred.body).includes(p)),
          );
          return {
            endpointStatus: 'discovered',
            productEndpoint: { url: preferred.url, method: preferred.method, body: preferred.body, pageParam },
            sampleResponse: preferred.json,
          };
        }
      }
    }
    return { endpointStatus: 'unverified' };
  } catch {
    return { endpointStatus: 'unverified' };
  }
}

// ── Positive authentication proof (v2.7.0) ──────────────────────────────────
// Asks the TAB whether a signed-in Seller Center shell actually rendered,
// using page-state.js's ANY-VISIBLE rule — the same SPEC the worker grades
// live sessions with, so "authenticated" means one thing across the capture
// path and the heartbeat that later validates what we captured.
//
// Polls rather than asking once: these Seller Centers are JS-rendered SPAs, so
// the shell mounts well after the tab reports "complete" (Shopee's Main/Sub
// OAuth form needed ~9s in a live probe). Asking once is precisely the bug
// that made autofill silently no-op for every brand — see fillWhenReady in
// login-fill.js. Bounded, and never throws: a false return means "could not
// prove it", which the caller treats as not-authenticated.
async function hasAuthenticatedContent(tabId, opts) {
  const o = opts || {};
  const intervalMs = o.intervalMs || TEST_TIMEOUTS.AUTH_CONTENT_POLL_INTERVAL_MS;
  const timeoutMs = o.timeoutMs || TEST_TIMEOUTS.AUTH_CONTENT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // Re-injected each tick on purpose: it is idempotent (the file only
      // redefines the same function) and a navigation mid-poll wipes the
      // previous injection, which is exactly when we must not go blind.
      await chrome.scripting.executeScript({ target: { tabId }, files: ['page-state.js'] });
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => (typeof window.__epmpIsAuthenticatedContent === 'function'
          ? window.__epmpIsAuthenticatedContent()
          : false),
      });
      if (res && res.result === true) return true;
    } catch {
      // Tab navigating / CSP / not injectable yet — keep trying until the
      // deadline rather than concluding "not authenticated" from one miss.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(intervalMs, remaining));
  }
}

// ── Build storageState + upload ──────────────────────────────────────────────
async function buildStorageState(platform, tabId) {
  const cookies = await collectCookies(platform);
  const ls = await collectLocalStorage(tabId);
  const origins = ls && ls.items && ls.items.length
    ? [{ origin: ls.origin, localStorage: ls.items }]
    : [];
  return { cookies, origins };
}

async function uploadSession(uploadUrl, token, body) {
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`Upload failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return res.json().catch(() => ({}));
}

// ── Capture from a specific tab (banner "Capture Session" or popup) ───────────
async function captureFromTab(tabId, ctxOverride) {
  const ctx = ctxOverride || (await getContext(tabId));
  if (!ctx) return { ok: false, error: 'No capture context for this tab' };
  if (!PLATFORM_COOKIE_DOMAINS[ctx.platform]) {
    return { ok: false, error: `Unsupported platform: ${ctx.platform}` };
  }
  const uploadUrl = resolveUploadUrl(ctx.uploadUrl || ctx.backendUrl);
  if (!uploadUrl) return { ok: false, error: 'No backend URL configured' };

  // Live progress ('working' banner state) through every slow phase below.
  // Best-effort feedback, never load-bearing: showBannerState already
  // swallows injection failures, and capture must succeed banner or not.
  const catalogLabel = `${PLATFORM_LABELS[ctx.platform] || ctx.platform} product list${ctx.brandName ? ` for ${ctx.brandName}` : ''}`;
  showBannerState(tabId, ctx.platform, 'working', `Capturing your ${captureLabel(ctx)} session…`);

  const storageState = await buildStorageState(ctx.platform, tabId);
  if (!storageState.cookies.length) {
    return { ok: false, error: 'No cookies found — is the login complete?' };
  }

  const body = { storageState };
  let endpointDiscovered = false;
  if (ctx.productListUrl) {
    showBannerState(
      tabId, ctx.platform, 'working',
      `Session captured — reading your ${catalogLabel}. The page reloads for this (normal); takes up to 30 seconds…`,
    );
    const disc = await runDiscovery(tabId, ctx.productListUrl, (elapsed) =>
      showBannerState(tabId, ctx.platform, 'working', `Reading your ${catalogLabel}… ${elapsed}s (up to 30s)`));
    if (disc.endpointStatus) body.endpointStatus = disc.endpointStatus;
    if (disc.productEndpoint) { body.productEndpoint = disc.productEndpoint; endpointDiscovered = true; }
    if (disc.sampleResponse) body.sampleResponse = disc.sampleResponse;
  }

  // ── Positive-proof authentication gate ─────────────────────────────────────
  // A capture may only be uploaded on POSITIVE evidence that the operator is
  // logged in. v2.6.2 shipped the first half of this (refuse when the URL is a
  // login/verification page) after a failed-OTP capture uploaded a logged-OUT
  // session that died on its first heartbeat (ArlaPH SHOPEE, 2026-08-13) —
  // `storageState.cookies.length > 0` passes for a logged-out page, because
  // Shopee/Lazada set cookies on their login pages too.
  //
  // But "the URL isn't a login page" is the ABSENCE of bad news, not evidence
  // of good news: a captcha wall, an interstitial, an error page or a
  // half-rendered shell all pass it. So the gate now requires one of two
  // POSITIVE signals, mirroring what the worker's heartbeat demands of a live
  // session:
  //   (a) discovery actually completed an authenticated product-API call
  //       (`endpointStatus === 'discovered'`) — the strongest possible proof,
  //       already computed above and, until now, thrown away by this guard; or
  //   (b) an authenticated-content marker is visible in the tab
  //       (page-state.js's ANY-VISIBLE rule, the same SPEC the worker grades
  //       sessions with).
  // Refuse only when BOTH are absent — a genuinely logged-in capture whose
  // product endpoint is merely slow still passes on (b), so this hardens the
  // gate without introducing false refusals.
  //
  // Fails BEFORE the upload and BEFORE post-capture hygiene, so nothing is
  // persisted and no cookies are wiped: the operator finishes logging in and
  // retries on the same tab.
  const liveTab = await chrome.tabs.get(tabId).catch(() => null);
  const liveUrl = (liveTab && liveTab.url) || '';
  const authedByDiscovery = body.endpointStatus === 'discovered';
  const authedByContent = authedByDiscovery ? false : await hasAuthenticatedContent(tabId);
  if (!authedByDiscovery && !authedByContent) {
    const onLoginUrl = looksLikeAuthPath(liveUrl);
    showBannerState(
      tabId, ctx.platform, 'error',
      onLoginUrl
        ? `Not logged in yet — the ${PLATFORM_LABELS[ctx.platform] || ctx.platform} page is still on a login/verification screen. Finish logging in (including any OTP), then capture again.`
        : `Couldn't confirm you're logged in to ${PLATFORM_LABELS[ctx.platform] || ctx.platform} — the page didn't load a signed-in Seller Center. Finish logging in (or reload the Seller Center), then capture again.`,
    );
    return {
      ok: false,
      error: onLoginUrl
        ? `Session not authenticated — the page is on a login/verification URL (${liveUrl.slice(0, 80)}). Complete login, then re-capture.`
        : `Session not authenticated — no authenticated Seller Center content and no product endpoint at ${liveUrl.slice(0, 80)}. Complete login, then re-capture.`,
    };
  }

  showBannerState(tabId, ctx.platform, 'working', `Uploading your ${captureLabel(ctx)} session to EPMP…`);
  await uploadSession(uploadUrl, ctx.token, body);
  await clearContext(tabId);

  const result = {
    ok: true,
    cookieCount: storageState.cookies.length,
    endpointDiscovered,
    label: captureLabel(ctx),
  };

  // Post-capture hygiene (v2.5.0, see runPostCaptureHygiene above) — this is
  // the exact success point: uploadSession() above already resolved without
  // throwing, so a failed upload/capture never reaches here and never
  // touches cookies or the tab. Awaited so cookie-wipe/tab-close finish
  // before this promise resolves, but its own fail-open contract means it
  // can never turn `result` into a failure.
  await runPostCaptureHygiene(tabId, ctx).catch((e) => {
    console.warn('[EPMP Connect] post-capture hygiene rejected unexpectedly', e);
  });

  return result;
}

// ── Start a bridge-initiated capture (open login tab + banner) ───────────────
// originTabId (v2.5.0): the tab that sent the 'capture'/'REQUEST_CAPTURE'
// message, i.e. the project web app's own tab — NOT the new platform login
// tab created below. Stored on the capture context so post-capture hygiene
// can refocus it once the capture succeeds. Only the bridge flow has this;
// the popup and banner-button flows capture whatever tab the operator is
// already looking at, so there's no separate "originating" tab to remember.
async function startCapture(payload, originTabId) {
  // Normalize the two frontend dialects into one context.
  const platform = String(payload.platform || '').toUpperCase();
  const token = payload.token || payload.captureToken;
  const uploadUrl = payload.uploadUrl || payload.backendUrl;
  // `forceFreshLogin` is still accepted on the payload for back-compat (some
  // callers may still send it), but as of v2.6.0 it is no longer
  // load-bearing — see the unconditional wipe below.
  const { loginUrl, productListUrl, forceFreshLogin: _forceFreshLoginUnused, brandId, brandName, login } = payload;

  if (!platform || !PLATFORM_COOKIE_DOMAINS[platform]) {
    return { ok: false, error: `Invalid platform: ${payload.platform}` };
  }
  if (!token) return { ok: false, error: 'Missing capture token' };
  if (!loginUrl) return { ok: false, error: 'Missing login URL' };
  if (!resolveUploadUrl(uploadUrl)) return { ok: false, error: 'Missing backend URL' };

  // Hard guard (v2.6.0; scoped to cookies-only in v2.6.1): clicking Connect
  // must ALWAYS start from a logged-out platform — cookies wiped BEFORE the
  // login tab opens, every platform, no exceptions. This used to be
  // conditional on `forceFreshLogin`, which the web app never actually sent
  // (that gap is exactly how the wrong-shop capture incident happened).
  // v2.6.0 additionally wiped site storage/cache here, which regressed
  // Shopee/TikTok device-trust fingerprinting and broke fresh logins (see
  // the "Pre-capture wipe scope" comment above) — v2.6.1 drops that half.
  // Cookies alone are sufficient: login state lives in cookies on all three
  // platforms, so this preserves the fresh-login guarantee without touching
  // site storage. A wipe failure is logged and NEVER blocks the login tab
  // from opening; removeCookiesForPlatform already swallows its own internal
  // failures, so this catch only guards against an unexpected rejection of
  // the wrapper promise itself.
  await removeCookiesForPlatform(platform).catch((e) => {
    console.warn(`[EPMP Connect] startCapture: cookie wipe rejected unexpectedly for ${platform}`, e);
  });

  // Optional platform-accounts vend (EPMP): { username, password } for
  // seller-login auto-fill on the login tab. Validated defensively — never
  // trust the shape of an external payload — and never logged. Anything
  // malformed is dropped silently rather than surfacing a secret in an error.
  const safeLogin = (login && typeof login.username === 'string' && typeof login.password === 'string')
    ? { username: login.username, password: login.password }
    : null;

  const tab = await chrome.tabs.create({ url: loginUrl });
  await setContext(tab.id, {
    platform, token, uploadUrl, loginUrl, productListUrl, brandId, brandName, login: safeLogin,
    originTabId: originTabId || null,
  });
  // Banner is (re)injected by the onUpdated listener once the tab finishes loading.
  return { ok: true, started: true, tabId: tab.id };
}

// Re-inject the banner, and attempt auto-capture, whenever a tracked tab
// finishes loading. Auto-capture is best-effort and one-shot per tab: on
// success captureFromTab() already clears the context (so it won't refire);
// on failure we mark it attempted and leave the banner as the manual fallback
// rather than retrying indefinitely on every subsequent 'complete' event.
//
// Re-entrancy guard (autoCaptureInFlight): a single auto-capture can itself
// trigger more 'complete' events on the SAME tab — when ctx.productListUrl is
// set (epmp), captureFromTab() runs runDiscovery(), which navigates the tab to
// the product-list URL and polls for up to 30s. That product-list URL is an
// authenticated, non-login page, so it MATCHES the (host-based) dashboard
// patterns and the resulting 'complete' would otherwise start a SECOND
// concurrent captureFromTab() — double-uploading the single-use token (the 2nd
// upload 401s "already used") and racing two navigations on one tab. We set an
// in-flight flag before awaiting the capture and bail on any re-entrant event
// while it's set. (This is broader than skipping discovery on the auto path,
// which we deliberately do NOT do: discovery is the whole point of the epmp
// bridge flow, and it must keep working when auto-capture is the trigger.)
//
// "No cookies found" is the one recoverable failure: the tab reached the
// dashboard URL a beat before the platform finished writing its session
// cookies. We give the cookies a short settle window and retry once before
// giving up — this converts a race-condition miss into a successful hands-off
// capture without widening the trigger or dropping the one-shot guarantee. The
// retry is within this same handler invocation, so the in-flight guard already
// covers it. Any other error (bad token, unsupported platform, upload HTTP
// failure) is not retried; we mark the tab attempted and fall back to the
// manual banner button.
const NO_COOKIES_RE = /no cookies found/i;

async function handleTabsOnUpdated(tabId, info, tab) {
  if (info.status !== 'complete') return;
  let ctx = await getContext(tabId);
  if (!ctx) return;

  injectBanner(tabId, ctx.platform);

  // Shopee only (v2.6.3): if we've landed on the MAIN seller login, click
  // through to the Main/Sub Account form once — this org logs in with
  // sub-accounts. See clickShopeeMainSubLogin for why the OAuth URL can't be
  // linked directly. The click navigates, so autofill runs on the NEXT
  // 'complete' event (account.seller.shopee.com is allowed by
  // LOGIN_PAGE_PATTERNS.SHOPEE); returning here keeps this tick cheap.
  if (ctx.platform === 'SHOPEE' && !ctx.mainSubClicked && isShopeeMainLoginPage(tab.url || '')) {
    await setContext(tabId, { ...ctx, mainSubClicked: true });
    const clicked = await clickShopeeMainSubLogin(tabId);
    console.log(`[EPMP Connect] Shopee Main/Sub Account button: ${clicked ? 'clicked' : 'not found (operator can click it manually)'}`);
    if (clicked) return;
    ctx = (await getContext(tabId)) || ctx;
  }

  // Seller-login auto-fill: independent of the auto-capture flow below (it
  // targets the LOGIN page, auto-capture targets the DASHBOARD page — the
  // two URL patterns are mutually exclusive by construction). No-ops unless
  // ctx.login is still present, so this is cheap on every other 'complete'.
  // Re-read the context afterward: attemptLoginFill may have wiped `login`
  // (or bumped loginFillAttempts) in storage, and every `{ ...ctx, ... }`
  // spread below must build on that fresh copy — otherwise this stale `ctx`
  // (captured before the wipe) would resurrect the just-cleared credentials
  // the next time this handler writes the context back out.
  if (ctx.login) {
    await attemptLoginFill(tabId, ctx, tab).catch(() => {});
    ctx = await getContext(tabId);
    if (!ctx) return; // capture completed / tab closed while we awaited
  }

  // Bail if already attempted (one-shot), already running (re-entrancy from a
  // discovery navigation), or this isn't an authenticated dashboard URL.
  if (ctx.autoCaptureAttempted || ctx.autoCaptureInFlight
      || !looksLikeDashboard(ctx.platform, tab.url || '')) return;

  // Claim the in-flight slot BEFORE any await, so the next 'complete' event that
  // discovery's own navigation fires reads the flag and bails.
  await setContext(tabId, { ...ctx, autoCaptureInFlight: true });

  // Readiness gate (v2.7.0): a matching dashboard URL only says the browser
  // ARRIVED somewhere authenticated-looking — not that a signed-in shell
  // rendered. Firing on the URL alone starts a capture against a blank or
  // still-mounting SPA, which then has to be refused downstream. Waiting for
  // the same authenticated-content marker the capture gate (and the worker's
  // heartbeat) uses turns auto-capture into "fire when the page is actually
  // ready", the wait-for-condition rule this whole release is built on.
  //
  // The slot is claimed FIRST and released here on a miss: the re-entrancy
  // guard above must never be preceded by an await, and `autoCaptureAttempted`
  // is deliberately NOT set — an unready page hasn't had its one attempt yet,
  // so a later 'complete' (or the banner's manual button) can still capture.
  if (!(await hasAuthenticatedContent(tabId))) {
    const stillThere = await getContext(tabId);
    if (stillThere) await setContext(tabId, { ...stillThere, autoCaptureInFlight: false });
    return;
  }

  let result = await captureFromTab(tabId).catch((e) => ({ ok: false, error: String(e?.message || e) }));

  // One retry, only for the cookie-settle race — and only if the context is
  // still present (a concurrent success/tab-close would have cleared it).
  if (!result.ok && NO_COOKIES_RE.test(result.error || '')) {
    await delay(TEST_TIMEOUTS.AUTO_CAPTURE_SETTLE_MS);
    if (await getContext(tabId)) {
      result = await captureFromTab(tabId).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    }
  }

  // On success, push a persistent green confirmation into the banner. Before
  // this, captureFromTab() clearing the context was the ONLY visible effect of
  // a successful auto-capture — nothing rendered any feedback, so a banner
  // wiped by an SPA re-render (or simply nobody looking at that instant) reads
  // as the tab silently closing/vanishing with no confirmation. This is the
  // fix for that "sometimes it closes by itself" report.
  // On failure, clear the in-flight flag and mark the tab attempted so it won't
  // refire — but leave the context (and banner) in place for the manual
  // fallback, and surface a non-fatal notice explaining why auto-capture
  // didn't finish instead of leaving the default prompt with no explanation.
  // Guard the write: if the context was cleared meanwhile (late success / tab
  // close), don't recreate it.
  if (result.ok) {
    showBannerState(tabId, ctx.platform, 'success', successMessage(ctx));
  } else if (await getContext(tabId)) {
    await setContext(tabId, { ...ctx, autoCaptureInFlight: false, autoCaptureAttempted: true });
    showBannerState(
      tabId,
      ctx.platform,
      'notice',
      `Auto-capture did not complete: ${result.error || 'unknown error'}. Log in fully, then click Capture Session.`,
    );
  }
}
chrome.tabs.onUpdated.addListener(handleTabsOnUpdated);

function handleTabsOnRemoved(tabId) { clearContext(tabId); }
chrome.tabs.onRemoved.addListener(handleTabsOnRemoved);

// ── Message router — speaks BOTH the ReportBot and EPMP dialects ─────────────
function handleRuntimeMessage(msg, sender, sendResponse) {
  const type = msg?.type;

  // Liveness ping (both dialects: 'ping' / 'PING').
  if (type === 'ping' || type === 'PING') {
    sendResponse({ ok: true, pong: true, version: chrome.runtime.getManifest().version });
    return false;
  }

  // Bridge-initiated capture (epmp 'capture' / ReportBot 'REQUEST_CAPTURE').
  // sender.tab is set automatically because bridge.js is a content script —
  // it's the web-app tab that ASKED for this capture, distinct from the new
  // platform login tab startCapture() is about to open. Stashed as
  // originTabId so post-capture hygiene can refocus it later.
  if (type === 'capture' || type === 'REQUEST_CAPTURE') {
    startCapture(msg.payload || {}, sender?.tab?.id)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // Banner button (epmp 'capture-now' / ReportBot 'DO_CAPTURE').
  if (type === 'capture-now' || type === 'DO_CAPTURE') {
    const tabId = sender?.tab?.id;
    captureFromTab(tabId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // Popup-initiated capture of a specific tab (from popup.js). popup.html has
  // its own success/error status line, but the operator isn't necessarily
  // watching the (tiny, easily-dismissed) popup — mirror the result into an
  // in-page banner on the captured tab too, same as every other capture path.
  // sendResponse fires first so this best-effort banner push never delays or
  // breaks the response popup.js is waiting on.
  //
  // If no token is supplied, fall back to the active tab's stored capture context
  // (getContext(tabId) → captureFromTab). If neither context nor token exists,
  // respond with a clear error and show the in-page hint. Backward compatible:
  // still accepts an explicit token in the message payload (for other backends,
  // ReportBot dialect, or manual token-paste fallback if needed later).
  if (type === 'CAPTURE_ACTIVE_TAB') {
    (async () => {
      // If explicit token provided, use it; otherwise fall back to stored context
      let ctx = null;
      if (msg.token) {
        // Backward compatibility: explicit token supplied (ReportBot dialect, etc.)
        ctx = {
          platform: msg.platform,
          token: msg.token,
          uploadUrl: msg.backendUrl,
        };
      } else {
        // No token: try the stored capture context from the active tab
        ctx = await getContext(msg.tabId);
        if (!ctx) {
          // Neither context nor token — show user the Authenticate flow hint
          const error = 'Open EPMP → Settings → Brand Connections and click Authenticate — capture starts automatically.';
          sendResponse({ ok: false, error });
          showBannerState(
            msg.tabId,
            msg.platform,
            'notice',
            error,
          );
          return;
        }
      }

      const ctxLike = { platform: ctx.platform, brandName: ctx.brandName };
      try {
        const res = await captureFromTab(msg.tabId, ctx);
        sendResponse(res);
        if (res.ok) {
          showBannerState(msg.tabId, msg.platform, 'success', successMessage(ctxLike));
        } else {
          showBannerState(
            msg.tabId,
            msg.platform,
            'notice',
            `Capture did not complete: ${res.error || 'unknown error'}. Log in fully, then try again.`,
          );
        }
      } catch (e) {
        const error = String(e?.message || e);
        sendResponse({ ok: false, error });
        showBannerState(
          msg.tabId,
          msg.platform,
          'notice',
          `Capture did not complete: ${error}. Log in fully, then try again.`,
        );
      }
    })();
    return true;
  }

  return false;
}
chrome.runtime.onMessage.addListener(handleRuntimeMessage);

// node --test entry point (mirrors login-fill.js's own guard at the bottom of
// that file). `module` never exists in the service-worker/browser realm, so
// this whole block is dead code there — it only runs under require(). Export
// surface for capture-flow.test.js: the capture pipeline itself
// (captureFromTab/runDiscovery/hasAuthenticatedContent/startCapture), the
// Shopee Main/Sub helpers, the storage.session helpers so tests can seed/read
// per-tab context the same way the real flow does, the three top-level
// listener callbacks (so tests can drive onUpdated/onRemoved/onMessage
// directly instead of only their DI fakes' addListener capture), and
// TEST_TIMEOUTS so a test can shrink real production delays/polls to a few ms
// before driving a flow. Nothing about these functions' behavior changes
// between the browser and node --test.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    captureFromTab,
    hasAuthenticatedContent,
    runDiscovery,
    startCapture,
    clickShopeeMainSubLogin,
    isShopeeMainLoginPage,
    removeCookiesForPlatform,
    handleTabsOnUpdated,
    handleTabsOnRemoved,
    handleRuntimeMessage,
    getContext,
    setContext,
    clearContext,
    TEST_TIMEOUTS,
  };
}