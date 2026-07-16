# EPMP Connect

One shared browser extension that captures authenticated **Shopee**, **Lazada**,
and **TikTok** Seller Center sessions and uploads them to a backend, so
automation can act on a brand's behalf without ever handling a password or
fighting platform anti-bot.

It replaces the three separate copies that used to live inside the
`audit-reports`, `encoder-reports` (ReportBot), and `epmp` repos. All three
projects now use **this** extension.

> It does **not** automate login. A human logs in (real browser, real IP, their
> own 2FA). The extension only captures the resulting session.

---

## How it works

Two capture flows, one upload contract:

1. **In-app flow (recommended).** A project's web app has an **Authenticate** /
   **Connect** button. Clicking it asks the extension (via the page bridge) to
   open the platform login tab and show a capture banner. Once the operator logs
   in and the tab lands on an authenticated Seller Center dashboard, the
   extension **auto-captures** the session (one attempt per tab). The banner's
   **Capture Session** button remains as a manual fallback. Login itself is never
   automated — the human logs in with their own 2FA; auto-detection only decides
   *when* to read the resulting session, and login/2FA pages are excluded so it
   never fires mid-login.
2. **Popup flow (manual-retry fallback).** If auto-capture doesn't fire or needs to
   be retried, open the Seller Center tab, click the extension toolbar icon, and
   click **Capture Session**. The popup will use the capture context stored by the
   in-app flow, or show a helpful error prompting you to start via EPMP's
   **Authenticate** button.

Both read cookies (`chrome.cookies`) + `localStorage` (`chrome.scripting`),
build a Playwright `storageState`, and POST it with the one-time token.

```
POST {backend}/api/v1/automation/sessions
Authorization: Bearer <one-time-capture-token>
Content-Type: application/json

{ "storageState": { "cookies": [...], "origins": [ { "origin": "...", "localStorage": [ { "name": "...", "value": "..." } ] } ] } }
```

The backend base URL is normalized: you may pass a bare origin
(`https://host`), a base ending in `/api`, or a full upload URL — all resolve to
`{origin}/api/v1/automation/sessions`.

### Product-list discovery (optional, EPMP)

When a capture supplies a `productListUrl`, `interceptor.js` (MAIN world) passively
records the product-list API response the page fetches, and the worker attaches
`{ productEndpoint, sampleResponse, endpointStatus }` to the upload. Best-effort:
if discovery fails, the session capture still succeeds. Backends that don't use it
simply ignore the extra keys.

---

## Install (per operator machine)

1. Download / clone this repo.
2. Open `chrome://extensions`, toggle **Developer mode** (top-right).
3. **Load unpacked** → select this folder.
4. Confirm the extension ID reads `gbkihcopmoldfdmponifjffomhhdaplp`.

The pinned `key` in `manifest.json` keeps that ID stable across machines, which is
how the in-app **Authenticate** button detects the extension. The matching private
signing key is **not** in this repo — it's only needed to pack a signed `.crx`;
unpacked installs don't use it.

### Backend URL

- **In-app flow:** the web app passes its own backend URL — nothing to configure.
- **Popup flow:** open the popup → **Settings** → enter your project's backend base
  URL once (saved locally). There is intentionally **no** baked-in default, so this
  public repo never hard-codes any environment's hostname.

---

## Integrating a web app (the page ↔ extension bridge)

`bridge.js` is injected on the frontend origins listed in `manifest.json`
(`content_scripts`). Add your app's origin there if it isn't already. The bridge
speaks **two dialects** — you can use whichever your app already implemented; no
frontend change is required to adopt this extension.

### EPMP dialect

```js
// page -> extension
window.postMessage({ __epmpPage: true, requestId, type: 'ping' }, location.origin);
window.postMessage({ __epmpPage: true, requestId, type: 'capture', payload }, location.origin);
// extension -> page
//   { __epmpConnect: true, type: 'ready', version }              (on load)
//   { __epmpConnect: true, requestId, type: 'pong', version }
//   { __epmpConnect: true, requestId, type: 'capture-ack', ok, error, tabId }
```
`payload` = `{ platform, captureToken, uploadUrl, loginUrl, productListUrl?, brandId?, brandName?, forceFreshLogin? }`

### ReportBot dialect

```js
// page -> extension  (tag: __rb_ext__, correlation key: id)
window.postMessage({ __rb_ext__: true, id, type: 'PING' }, '*');
window.postMessage({ __rb_ext__: true, id, type: 'REQUEST_CAPTURE', payload }, '*');
// extension -> page
//   { __rb_ext__: true, id, response }   or   { __rb_ext__: true, id, error }
```
`payload` = `{ platform, token, backendUrl, loginUrl }`

`platform` is `SHOPEE` | `LAZADA` | `TIKTOK`. The token is a single-use capture
token minted by the backend's Sessions page.

---

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — pinned `key`, scoped host permissions, bridge + interceptor content scripts |
| `background.js` | Capture engine — dual-dialect message router, cookie/localStorage capture, upload, banner + discovery orchestration |
| `bridge.js` | Page ↔ background relay (content script) — speaks both EPMP and ReportBot dialects |
| `interceptor.js` | MAIN-world content script — passively records the product-list API response |
| `banner.js` | Injected login-tab banner with the **Capture Session** button |
| `popup.html` / `popup.js` | Toolbar popup — manual active-tab capture fallback |

## Permissions — why each is needed

| Permission | Reason |
|---|---|
| `cookies` | Read platform session cookies (HttpOnly — unreadable by page JS) |
| `scripting` | Read `localStorage`; inject the capture banner |
| `tabs` | Open and track the login tab |
| `activeTab` | Capture the current tab from the popup |
| `storage` | Persist the popup's backend URL + per-tab capture context |
| host: `*.shopee.ph`, `*.shopee.com`, `*.lazada.com.ph`, `*.lazada.com`, `*.tiktok.com`, `*.tiktokshop.com` | Scoped to the three platforms — never `<all_urls>` |

`bridge.js` runs only on the listed frontend origins, so no other site can drive
the extension.

## Platform cookie domains

Broad registrable domains (matched with all subdomains):

- **Shopee:** `shopee.ph`, `shopee.com`
- **Lazada:** `lazada.com.ph`, `lazada.com`
- **TikTok:** `tiktok.com`, `tiktokshop.com`

## Versioning

`2.2.0` — capture feedback and simplified popup UX: the banner now shows explicit
success, notice, and error states (persistent green checkmark + brand name on
success; non-fatal notices on auto-capture failure; no silent closes). The popup's
manual **Capture Session** button no longer requires pasting a one-time token —
it now uses the capture context stored by the in-app **Authenticate** flow when
available, falling back to a helpful error message if needed. Backward compatible:
explicit tokens are still accepted for ReportBot dialect and other backends.
Also hardens product-list discovery (`interceptor.js`): a discovered endpoint must
now return *hydrated* rows (carrying a product name), not just an array of objects,
so an id-only prefetch endpoint can no longer win discovery over the real catalog
endpoint (e.g. Shopee `search_product_list`) — the cause of brands syncing back
nameless "Unnamed product" rows.

`2.1.1` — auto-capture reliability: dashboard detection is now host-based (any
authenticated Seller Center page that isn't a login/2FA page) across all three
platforms instead of one hard-coded path, so it fires regardless of which page a
seller lands on after login; retries once on the cookie-settle race; and adds an
`autoCaptureInFlight` re-entrancy guard so product-endpoint discovery's own tab
navigation can't trigger a second concurrent capture. Manual **Capture Session**
button unchanged as fallback.

`2.1.0` — automated capturing: the bridge flow now auto-captures when the tab
lands on a known Seller Center dashboard URL (one attempt per tab; the banner's
manual **Capture Session** button remains as fallback).

`2.0.0` — first unified release (merge of audit-reports, encoder-reports, and
epmp capture extensions).
