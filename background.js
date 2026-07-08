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
// Patterns mirror the post-login warm-up URLs each backend's own scraper
// already treats as "logged in" (see e.g. encoder-reports_2's shopeeApi.ts /
// lazadaApi.ts / tiktokApi.ts warm-up + login-redirect checks).
const DASHBOARD_PATTERNS = {
  LAZADA: (u) => /(^|\.)sellercenter\.lazada\.com\.ph$/.test(u.hostname)
    && !/\/(login|signin)/i.test(u.pathname),
  SHOPEE: (u) => /(^|\.)seller\.shopee\.ph$/.test(u.hostname)
    && /\/(portal\/sale\/order|datacenter)/i.test(u.pathname),
  TIKTOK: (u) => /(^|\.)seller(-ph)?\.tiktok\.com$/.test(u.hostname)
    && /\/(compass\/data-overview|order)/i.test(u.pathname)
    && !/\/account\/login/i.test(u.pathname),
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
  return { ok: true, cookieCount: storageState.cookies.length, endpointDiscovered };
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
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  const ctx = await getContext(tabId);
  if (!ctx) return;

  injectBanner(tabId, ctx.platform);

  if (!ctx.autoCaptureAttempted && looksLikeDashboard(ctx.platform, tab.url || '')) {
    const result = await captureFromTab(tabId).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!result.ok) {
      // Leave the context (and banner) in place so the operator can still
      // capture manually; just stop auto-retrying on this tab.
      await setContext(tabId, { ...ctx, autoCaptureAttempted: true });
    }
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

  // Popup-initiated capture of a specific tab (from popup.js).
  if (type === 'CAPTURE_ACTIVE_TAB') {
    captureFromTab(msg.tabId, {
      platform: msg.platform,
      token: msg.token,
      uploadUrl: msg.backendUrl,
    })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  return false;
});