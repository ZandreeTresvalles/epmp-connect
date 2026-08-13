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

### Seller-login auto-fill (optional)

When a capture's `payload.login` carries `{ username, password }`, `login-fill.js`
is injected once the login tab lands on the platform's own login page (host +
path match) and fills the username + password inputs — using each platform's
selectors for Lazada and Shopee, and a broadened, defensive single-visible-match
fallback for TikTok (v2.6.1: matches on `type`, `name`, `placeholder`, and
`autocomplete` tokens for the username/email field; the password field stays
`type="password"` only, never broadened). It only **fills**: it never submits
the form, and the operator still completes login (and OTP/2FA) by hand. Values
are never logged. `login` is wiped from the tab's stored capture context as soon
as a fill sets a field, or after at most two attempts if nothing matched — so it
never lingers. Omit `login` and the extension behaves exactly as before.

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
`payload` = `{ platform, captureToken, uploadUrl, loginUrl, productListUrl?, brandId?, brandName?, forceFreshLogin?, login? }`

`login?` = `{ username, password }` — optional. When the calling backend vends a
stored seller-login for this (brand, platform), the extension auto-fills the
login form's username + password fields once the tab lands on the platform's
login page (see [Seller-login auto-fill](#seller-login-auto-fill-optional)
below). Omit it and nothing changes from prior versions.

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
| `login-fill.js` | Injected on-demand into the login tab — auto-fills username/password when `payload.login` is supplied; never auto-submits, never logs the values |
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

`browsingData` was requested in `2.6.0` (to clear localStorage/IndexedDB/Service
Workers/Cache Storage/cache before a bridge-flow login tab opens) and **removed
in `2.6.1`** — see the changelog below for why.

`bridge.js` runs only on the listed frontend origins, so no other site can drive
the extension.

## Platform cookie domains

Broad registrable domains (matched with all subdomains):

- **Shopee:** `shopee.ph`, `shopee.com`
- **Lazada:** `lazada.com.ph`, `lazada.com`
- **TikTok:** `tiktok.com`, `tiktokshop.com`

## Versioning

`2.6.4` — **autofill now waits for the login form to render.** Every one of
these login pages is a JS-rendered SPA, but the fill ran exactly once, on the
tab's `complete` event — which fires when the *document* finishes loading,
typically before the framework has rendered any inputs. It found nothing,
returned 0, and never retried (an SPA fires no second `complete`, so the one
remaining attempt never came either). That is why autofill appeared to work
occasionally and silently did nothing the rest of the time — on every brand
and every platform, regardless of stored credentials. Measured 2026-08-13:
Shopee's Main/Sub OAuth form needed ~9 seconds before its inputs existed.
`fillWhenReady()` now polls every 250ms for up to 15s, filling the username
and password independently the moment each becomes available (so a form whose
password field mounts later is also covered), and stops as soon as both are
done or the deadline passes. Still fill-only — it never submits, and never
logs the values.

`2.6.3` — steer Shopee captures to the **Main / Sub Account** login. Shopee's
seller login defaults to the main-account form (`input[name=loginKey]`), but
brands connect through SUB-accounts (e.g. `arlaph.dataccess`). That page has a
**"Login with Main/Sub Account"** button which navigates to Shopee's unified
OAuth form at `account.seller.shopee.com` (placeholder "Main/subaccount
name/phone/email"), whose `redirect_uri` establishes a real Seller Centre
session. That OAuth URL cannot be linked directly — it carries `sign`,
`timestamp` and `max_auth_age=600`, so Shopee signs it per request and it
expires in ~10 minutes (probed: stripping the params returns "400 Error Param:
ClientId/Scope/RedirectUri required"). The extension therefore clicks Shopee's
own button, one-shot per tab and fail-open: if the button isn't found the
operator just uses the page by hand. `LOGIN_PAGE_PATTERNS.SHOPEE` now also
matches `account.seller.shopee.com`, so vault autofill fires on the OAuth form
(its `input.shopee-input__input` fields are exactly what the existing SHOPEE
selector targets). This clicks one navigation button only — it never types,
submits, or reads credentials.

`2.6.2` — refuse to capture an unauthenticated session. The only pre-upload
check was `storageState.cookies.length > 0`, but Shopee/Lazada set cookies on
their login/verification pages too — so a capture whose login never completed
(e.g. a failed OTP verification that silently logged the operator back out)
uploaded a logged-OUT session, which bounced straight to
`accounts.shopee.ph/seller/login` on its first heartbeat and read as "expired
within the same minute" (ArlaPH SHOPEE, 2026-08-13). `captureFromTab` now
checks the tab's live URL against `AUTH_PATH` (login/signin/passport/verify/
otp/captcha) right before upload — after `runDiscovery` has navigated to the
product list, a dead session redirects that navigation to a login URL, making
the current URL the authoritative "are we actually logged in" signal. On a
login/verification URL it shows an error banner ("Not logged in yet — finish
logging in, then capture again") and returns without uploading or running
post-capture hygiene, so nothing is persisted and no cookies are wiped — the
operator finishes login and retries.

`2.6.1` — two fixes:

- **Pre-capture wipe scoped back to cookies-only.** `2.6.0`'s pre-login hard
  guard wiped cookies AND site storage/cache (localStorage, IndexedDB, Service
  Workers, Cache Storage, the HTTP cache — `wipePlatformSiteData()`, plus a
  one-shot in-tab `localStorage`/`sessionStorage` clear) before every login tab
  opened. That broke fresh logins instead of protecting them: Shopee and
  TikTok use browser site-storage state as part of their DEVICE-TRUST
  fingerprint, so wiping it made every fresh login look like a brand-new,
  untrusted device — Shopee force-logged the operator back out right after
  login succeeded, and TikTok showed a "Browser invalid" wall. Confirmed by
  direct comparison: a Shopee capture succeeded under `2.5.0` (cookie wipes
  only) and died shortly after under `2.6.0` (cookie + site-storage wipes),
  with no other change in between. Cookies alone carry the login state on all
  three platforms, so the guard is scoped back to cookies-only —
  `removeCookiesForPlatform()`, same as `2.5.0`'s post-capture hygiene. It is
  still **unconditional** and still runs before the login tab opens; only its
  blast radius shrank. `wipePlatformSiteData`, `siteDataOriginsForPlatform`,
  `clearTabStorage`, and the `browsingData` permission are removed — nothing
  else used them.
- **TikTok seller-login auto-fill broadened.** A real capture showed TikTok
  Seller Center's login form (`seller-ph.tiktok.com` redirecting to TikTok's
  own account-login page) never got filled. Two contributing fixes:
  (1) `LOGIN_PAGE_PATTERNS.TIKTOK` in `background.js` previously only matched
  the `seller(-ph).tiktok.com` host itself — the redirect target lands on a
  different `*.tiktok.com` host, which the pattern never matched, so the fill
  never fired at all; it's now broadened to any `*.tiktok.com` host (still
  gated on a login-shaped path). (2) `login-fill.js`'s TikTok username
  selector was a plain `type="text"`/`type="email"` match; it's now broadened
  to also match on `name`/`placeholder`/`autocomplete` tokens plausible for an
  email/username field (`email`, `account`, `loginName`, `username`, `phone`).
  The password selector is **unchanged** — `type="password"` only, never
  broadened or weakened — and the single-visible-match guard (skip rather than
  guess on 0 or >1 matches) still applies to every alternative. TikTok's actual
  login-page host and DOM could not be confirmed against a live page while
  making this fix; see the extension repo's task report for what remains
  unverified.

`2.6.0` — fresh-capture hard guard (pre-login wipe): the bridge flow's
`startCapture()` — the flow that opens a NEW platform login tab, never the
banner/popup "capture the tab I'm already looking at" flows — now
**unconditionally** wipes that platform's cookies AND site storage/cache
*before* the login tab opens, on all three platforms, every time. Previously
this only ran when the caller's payload set `forceFreshLogin`, and no caller
ever actually set it — so an operator still logged into Brand A's Shopee who
clicked Connect for Brand B got a login tab that was already authenticated as
Brand A, and captured the wrong shop's session under the wrong brand. The
payload flag is still accepted for back-compat but is no longer load-bearing.
Two wipes run together: `wipePlatformSiteData()` = the existing
`removeCookiesForPlatform()` (cookies) PLUS `chrome.browsingData.remove()`
(localStorage, IndexedDB, Service Workers, Cache Storage, and the HTTP cache)
scoped to that platform's known seller/accounts/sellercenter/sub-account
origins — `browsingData`'s `origins` filter matches an EXACT origin, not a
subdomain wildcard, so those hosts are enumerated explicitly rather than
relying on the bare registrable domain. Because an exact-origin list can never
guarantee full coverage of every host a seller might be logged into, the login
tab itself also runs a direct `localStorage.clear()` + `sessionStorage.clear()`
once it loads (`clearTabStorage()`, once per tab, before the banner/autofill/
auto-capture logic gets a chance to run) — this clears whatever the ACTUAL
origin turns out to be, no enumeration required. Both wipes are fail-open: any
failure is logged to the service-worker console and never blocks the login tab
from opening. New `browsingData` manifest permission (accepted cost — this is
an unpacked install, not the Web Store).

`2.5.0` — post-capture hygiene (auto-logout): after every successful capture,
on all three platforms, the extension deliberately logs the operator out of
that platform **locally** — cookie deletion via `chrome.cookies` only, never a
logout request (which could invalidate the session token just captured) —
then closes the capture tab and refocuses whichever tab kicked off the
capture (the bridge flow's originating web-app tab, or, if that's unknown,
the most recently active known frontend tab). The banner shows "Captured ✓ —
you've been logged out of {platform} so the next brand starts from a clean
login." before the tab closes. Fixes the class of wrong-shop captures where
two brands got captured back-to-back under one still-logged-in seller account
with no logout in between. Always on, no toggle, and fail-open throughout: a
hygiene step that fails is logged but never fails the capture, and a failed
capture/upload leaves cookies and the tab untouched so the operator can retry
without re-login.

`2.4.0` — live capture progress: a new `working` banner state (⏳, no Capture
button) narrates every slow phase of a capture — "capturing your session…",
then "reading your product list… Ns (up to 30s)" counting up on each discovery
poll tick, then "uploading to EPMP…" — before resolving into the existing
success/notice/error states. Fixes the "after capture the site refreshes and
gets stuck" report: the product-list discovery deliberately reloads the tab and
polls for up to ~30 seconds, and previously showed nothing at all while it did.

`2.3.0` — seller-login auto-fill: when a bridge-flow capture's `payload.login`
carries `{ username, password }` (vended by EPMP's platform-accounts vault), the
extension fills the username + password fields once the login tab lands on the
platform's own login page — `input#account` + `input[type=password]` for Lazada,
`input.shopee-input__input[type=text/password]` for Shopee, and a defensive
single-visible-match fallback (skip rather than guess on 0 or >1 matches) for
TikTok. Fill-only: it never submits the form and never touches OTP/2FA — the
operator still completes login by hand. Values are never logged, and `login` is
wiped from the tab's stored capture context as soon as a field is set (or after
at most two attempts if nothing matched), so it never lingers. Omitting `login`
from the payload leaves every existing capture flow unchanged.

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
