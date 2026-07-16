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

// ── Dashboard auto-detection ─────────────────────────────────────────────────
// Predecessor extensions deliberately required a manual "Capture Session"
// click because multi-step 2FA makes auto-detecting "login complete"
// unreliable. This trades that safety margin for a hands-off flow: a false
// positive just fails harmlessly ("No cookies found"), and the banner's
// manual button stays available as a fallback if auto-detection never fires.
//
// Detection doctrine (mirrors what each backend's own scraper treats as
// "logged in"): a seller lands authenticated on the Seller Center HOST but the
// post-login landing PATH varies per account (Shopee → /portal/home,
// /portal/sale/order, /datacenter/…; TikTok → /order, /compass/*, /homepage,
// etc.). The scrapers therefore never match a specific dashboard path — they
// treat the session as valid whenever the URL is on the seller-center host and
// is NOT a login/auth page. We use the same test here so auto-capture fires on
// ANY authenticated landing page, not just one hand-picked route.
//   - encoder-reports shopeeApi.ts: logged-in ⇔ url.startsWith('https://seller.shopee.ph')
//   - encoder-reports tiktok.ts / tiktokApi.ts: logged-out ⇔ url includes
//     /account/login | /passport/ | /sign-in | login
//   - encoder-reports lazadaApi.ts / lazada.ts: logged-out ⇔ url includes /login | /signin
//   - audit-reports shopeeInventory.ts / tiktokInventory.ts: logged-out ⇔ url
//     includes /login | /sign-in | /passport
// AUTH_PATH is the union of those login/2FA/verification path fragments; a URL
// that matches it is treated as "still logging in" and auto-capture is held off.
const AUTH_PATH = /(\/(login|signin|sign-in|passport|account\/login|verify|verification|2fa|otp|captcha))/i;

const DASHBOARD_PATTERNS = {
  LAZADA: (u) => /(^|\.)sellercenter\.lazada\.com\.ph$/.test(u.hostname)
    && !AUTH_PATH.test(u.pathname),
  SHOPEE: (u) => /(^|\.)seller\.shopee\.ph$/.test(u.hostname)
    && !AUTH_PATH.test(u.pathname),
  TIKTOK: (u) => /(^|\.)seller(-ph)?\.tiktok\.com$/.test(u.hostname)
    && !AUTH_PATH.test(u.pathname),
};

function looksLikeDashboard(platform, urlStr) {
  try {
    const check = DASHBOARD_PATTERNS[platform];
    return !!check && check(new URL(urlStr));
  } catch {
    return false;
  }
}

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

// Optionally clear a platform's cookies before login (epmp forceFreshLogin).
async function clearPlatformCookies(platform) {
  const domains = PLATFORM_COOKIE_DOMAINS[platform] || [];
  for (const domain of domains) {
    let cookies = [];
    try { cookies = await chrome.cookies.getAll({ domain }); } catch { /* ignore */ }
    for (const c of cookies) {
      const scheme = c.secure ? 'https' : 'http';
      const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      const url = `${scheme}://${host}${c.path || '/'}`;
      try { await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId }); } catch { /* ignore */ }
    }
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
async function runDiscovery(tabId, productListUrl) {
  if (!productListUrl) return { endpointStatus: null };
  try {
    await chrome.tabs.update(tabId, { url: productListUrl });
    for (let i = 0; i < 12; i++) {
      await delay(2500);
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

  const storageState = await buildStorageState(ctx.platform, tabId);
  if (!storageState.cookies.length) {
    return { ok: false, error: 'No cookies found — is the login complete?' };
  }

  const body = { storageState };
  let endpointDiscovered = false;
  if (ctx.productListUrl) {
    const disc = await runDiscovery(tabId, ctx.productListUrl);
    if (disc.endpointStatus) body.endpointStatus = disc.endpointStatus;
    if (disc.productEndpoint) { body.productEndpoint = disc.productEndpoint; endpointDiscovered = true; }
    if (disc.sampleResponse) body.sampleResponse = disc.sampleResponse;
  }

  await uploadSession(uploadUrl, ctx.token, body);
  await clearContext(tabId);
  return {
    ok: true,
    cookieCount: storageState.cookies.length,
    endpointDiscovered,
    label: captureLabel(ctx),
  };
}

// ── Start a bridge-initiated capture (open login tab + banner) ───────────────
async function startCapture(payload) {
  // Normalize the two frontend dialects into one context.
  const platform = String(payload.platform || '').toUpperCase();
  const token = payload.token || payload.captureToken;
  const uploadUrl = payload.uploadUrl || payload.backendUrl;
  const { loginUrl, productListUrl, forceFreshLogin, brandId, brandName } = payload;

  if (!platform || !PLATFORM_COOKIE_DOMAINS[platform]) {
    return { ok: false, error: `Invalid platform: ${payload.platform}` };
  }
  if (!token) return { ok: false, error: 'Missing capture token' };
  if (!loginUrl) return { ok: false, error: 'Missing login URL' };
  if (!resolveUploadUrl(uploadUrl)) return { ok: false, error: 'Missing backend URL' };

  if (forceFreshLogin) await clearPlatformCookies(platform);

  const tab = await chrome.tabs.create({ url: loginUrl });
  await setContext(tab.id, { platform, token, uploadUrl, loginUrl, productListUrl, brandId, brandName });
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
const AUTO_CAPTURE_SETTLE_MS = 1500;
const NO_COOKIES_RE = /no cookies found/i;

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const ctx = await getContext(tabId);
  if (!ctx) return;

  injectBanner(tabId, ctx.platform);

  // Bail if already attempted (one-shot), already running (re-entrancy from a
  // discovery navigation), or this isn't an authenticated dashboard URL.
  if (ctx.autoCaptureAttempted || ctx.autoCaptureInFlight
      || !looksLikeDashboard(ctx.platform, tab.url || '')) return;

  // Claim the in-flight slot BEFORE any await, so the next 'complete' event that
  // discovery's own navigation fires reads the flag and bails.
  await setContext(tabId, { ...ctx, autoCaptureInFlight: true });

  let result = await captureFromTab(tabId).catch((e) => ({ ok: false, error: String(e?.message || e) }));

  // One retry, only for the cookie-settle race — and only if the context is
  // still present (a concurrent success/tab-close would have cleared it).
  if (!result.ok && NO_COOKIES_RE.test(result.error || '')) {
    await delay(AUTO_CAPTURE_SETTLE_MS);
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
});

chrome.tabs.onRemoved.addListener((tabId) => { clearContext(tabId); });

// ── Message router — speaks BOTH the ReportBot and EPMP dialects ─────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;

  // Liveness ping (both dialects: 'ping' / 'PING').
  if (type === 'ping' || type === 'PING') {
    sendResponse({ ok: true, pong: true, version: chrome.runtime.getManifest().version });
    return false;
  }

  // Bridge-initiated capture (epmp 'capture' / ReportBot 'REQUEST_CAPTURE').
  if (type === 'capture' || type === 'REQUEST_CAPTURE') {
    startCapture(msg.payload || {})
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
});