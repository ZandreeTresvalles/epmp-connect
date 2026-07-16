/**
 * EPMP Connect — capture banner (injected into the login tab, ISOLATED world).
 *
 * The background worker injects this file into the platform login tab, then
 * calls window.__epmpConnectShowBanner(platform, opts). The operator logs in
 * normally (real browser, real IP, their own 2FA). background.js auto-captures
 * once the tab lands on an authenticated Seller Center dashboard URL; this
 * banner's "Capture Session" button is the always-available manual fallback
 * (and covers any account whose landing page auto-detection misses). Either
 * path asks the background worker to read cookies + localStorage and upload.
 *
 * States (opts.state):
 *   - (none) / 'default' — the initial "log in, then Capture Session" prompt.
 *   - 'notice'  — a non-fatal note layered onto the default prompt (e.g. an
 *     auto-capture attempt that didn't finish); the Capture Session button
 *     stays live so the operator can retry manually.
 *   - 'error'   — a capture attempt failed; message shown, button re-enabled.
 *   - 'success' — a capture completed — from ANY path (auto-capture, this
 *     banner's own button, or the popup). Replaces the prompt with a green
 *     confirmation + a dismiss control. Pushed on EVERY successful capture
 *     path so the operator always gets explicit confirmation instead of the
 *     banner silently vanishing (the reported "closes by itself").
 *
 * Cross-injection state: chrome.scripting.executeScript({files:['banner.js']})
 * re-runs this entire file every time background.js calls it (once to show
 * the default prompt, again later to push a notice/success/error), so
 * anything that must survive those repeat injections — the remembered
 * state/message, the dismissed flag, the self-heal watcher — is stashed on
 * `window`, never in a closure. Relatedly: nothing at this file's top level
 * may be a `const`/`let`/`class` declaration outside the single assignment
 * below, because re-declaring one a second time in the same page throws
 * "already declared" and silently kills the whole injection (a plain
 * assignment, by contrast, is always safe to re-run).
 *
 * Self-heal: heavy SPA seller dashboards (TikTok especially) can wipe the
 * whole appended DOM subtree on client-side navigation, silently removing the
 * banner node — including a just-shown "captured" confirmation. That is the
 * "closes by itself" symptom operators reported. A MutationObserver watches
 * for the node disappearing and re-creates it in its last known state for a
 * bounded window, so the confirmation can't silently disappear underneath the
 * operator. An explicit dismiss click retires it for the rest of this page's
 * lifetime (until a genuinely new state is pushed).
 */

window.__epmpConnectShowBanner = function (platform, opts) {
  const BAR_ID = '__epmp_connect_bar__';
  const SELF_HEAL_WINDOW_MS = 5 * 60 * 1000; // "a reasonable window" post-capture
  const LABELS = { SHOPEE: 'Shopee', LAZADA: 'Lazada', TIKTOK: 'TikTok' };

  // Namespaced state that survives repeat injections of this same file.
  const G = window.__epmpConnectBanner || (window.__epmpConnectBanner = {
    dismissed: false,
    observer: null,
    platform: null,
    state: 'default',
    message: '',
  });

  if (platform) G.platform = platform;
  if (opts && opts.state) {
    // A fresh, explicit state push (success/notice/error) always gets shown,
    // even if the operator dismissed an earlier banner on this same page —
    // dismiss means "stop showing me THAT", not "never tell me anything else".
    G.state = opts.state;
    G.message = opts.message || '';
    G.dismissed = false;
  }

  const already = document.getElementById(BAR_ID);
  if (already && !opts) return; // idempotent: already showing, nothing new to apply
  if (G.dismissed) return;      // dismissed, and nothing new was pushed — don't resurrect

  const platformLabel = LABELS[G.platform] || G.platform || 'Seller Center';

  function stopSelfHeal() {
    if (G.observer) {
      try { G.observer.disconnect(); } catch { /* ignore */ }
      G.observer = null;
    }
  }

  function startSelfHeal() {
    if (G.observer) return; // already watching
    const healUntil = Date.now() + SELF_HEAL_WINDOW_MS;
    try {
      const observer = new MutationObserver(() => {
        if (G.dismissed || Date.now() > healUntil) { stopSelfHeal(); return; }
        if (!document.getElementById(BAR_ID)) window.__epmpConnectShowBanner(G.platform);
      });
      observer.observe(document.documentElement, { childList: true });
      G.observer = observer;
    } catch { /* self-heal is best-effort; never block the banner itself */ }
  }

  function dismiss(node) {
    G.dismissed = true;
    stopSelfHeal();
    node.remove();
    document.documentElement.style.removeProperty('margin-top');
  }

  function barShellCss(gradient) {
    return [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'gap:12px',
      'padding:10px 16px', 'font:600 13px/1.4 -apple-system,Segoe UI,sans-serif',
      'color:#fff', `background:${gradient}`,
      'box-shadow:0 2px 8px rgba(0,0,0,.25)',
    ].join(';');
  }

  function buildDefaultBar() {
    const node = document.createElement('div');
    node.style.cssText = barShellCss('linear-gradient(90deg,#06b6d4,#3b82f6)');

    const icon = document.createElement('span');
    icon.style.fontSize = '15px';
    icon.textContent = '⚡';

    const lead = document.createElement('span');
    lead.append('EPMP Connect — log in to ');
    const b = document.createElement('b');
    b.textContent = platformLabel;
    lead.append(b, ', then capture your session.');

    const status = document.createElement('span');
    status.id = '__epmp_status__';
    status.style.cssText = 'opacity:.9;font-weight:500';
    if (G.state === 'notice') status.textContent = 'ℹ️ ' + G.message;
    else if (G.state === 'error') status.textContent = '❌ ' + G.message;

    const captureBtn = document.createElement('button');
    captureBtn.id = '__epmp_capture_btn__';
    captureBtn.textContent = 'Capture Session';
    captureBtn.style.cssText = 'margin-left:auto;padding:6px 14px;border:0;border-radius:6px;'
      + 'background:#fff;color:#0891b2;font-weight:700;cursor:pointer';

    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = '✕';
    dismissBtn.style.cssText = 'padding:6px 10px;border:0;border-radius:6px;'
      + 'background:rgba(255,255,255,.2);color:#fff;cursor:pointer';
    dismissBtn.addEventListener('click', () => dismiss(node));

    captureBtn.addEventListener('click', () => {
      captureBtn.disabled = true;
      status.textContent = 'Capturing…';
      chrome.runtime.sendMessage({ type: 'capture-now' }, (res) => {
        if (chrome.runtime.lastError) {
          window.__epmpConnectShowBanner(G.platform, { state: 'error', message: chrome.runtime.lastError.message });
          return;
        }
        if (res?.ok) {
          const label = res.label || platformLabel;
          window.__epmpConnectShowBanner(G.platform, {
            state: 'success',
            message: `Session captured for ${label} — EPMP is connected.`
              + (res.endpointDiscovered ? ' Catalog endpoint discovered too.' : '')
              + ' You can close this tab.',
          });
        } else {
          window.__epmpConnectShowBanner(G.platform, { state: 'error', message: res?.error || 'Capture failed' });
        }
      });
    });

    node.append(icon, lead, status, captureBtn, dismissBtn);
    return node;
  }

  function buildSuccessBar() {
    const node = document.createElement('div');
    node.style.cssText = barShellCss('linear-gradient(90deg,#16a34a,#22c55e)');

    const icon = document.createElement('span');
    icon.style.fontSize = '15px';
    icon.textContent = '✅';

    const text = document.createElement('span');
    text.textContent = G.message
      || `Session captured for ${platformLabel} — EPMP is connected. You can close this tab.`;

    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss ✕';
    dismissBtn.style.cssText = 'margin-left:auto;padding:6px 10px;border:0;border-radius:6px;'
      + 'background:rgba(255,255,255,.25);color:#fff;font-weight:700;cursor:pointer';
    dismissBtn.addEventListener('click', () => dismiss(node));

    node.append(icon, text, dismissBtn);
    return node;
  }

  // Always rebuild from scratch when we get here (fresh injection, or an
  // explicit state push) — the bar has no input/focus state worth preserving,
  // so destroy-and-recreate is simpler and safer than patching a live node.
  if (already) already.remove();
  const bar = G.state === 'success' ? buildSuccessBar() : buildDefaultBar();
  bar.id = BAR_ID;
  document.documentElement.appendChild(bar);
  // Nudge the page down so the banner never hides the login form.
  document.documentElement.style.setProperty('margin-top', '44px', 'important');

  startSelfHeal();
};
