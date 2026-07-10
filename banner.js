/**
 * EPMP Connect — capture banner (injected into the login tab, ISOLATED world).
 *
 * The background worker injects this file into the platform login tab, then
 * calls window.__epmpConnectShowBanner(platform). The operator logs in normally
 * (real browser, real IP, their own 2FA) and clicks "Capture Session" when they
 * reach the dashboard. We do NOT auto-detect login — multi-step 2FA makes that
 * unreliable; a human click is 100% accurate. The click asks the background
 * worker to read cookies + localStorage and upload.
 */

window.__epmpConnectShowBanner = function (platform) {
  const BAR_ID = '__epmp_connect_bar__';
  if (document.getElementById(BAR_ID)) return; // idempotent

  const label = ({ SHOPEE: 'Shopee', LAZADA: 'Lazada', TIKTOK: 'TikTok' })[platform] || 'Seller Center';

  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
    'display:flex', 'align-items:center', 'gap:12px',
    'padding:10px 16px', 'font:600 13px/1.4 -apple-system,Segoe UI,sans-serif',
    'color:#fff', 'background:linear-gradient(90deg,#06b6d4,#3b82f6)',
    'box-shadow:0 2px 8px rgba(0,0,0,.25)',
  ].join(';');

  bar.innerHTML =
    '<span style="font-size:15px">⚡</span>' +
    `<span>EPMP Connect — log in to <b>${label}</b>, then capture your session.</span>` +
    '<span id="__epmp_status__" style="opacity:.9;font-weight:500"></span>' +
    '<button id="__epmp_capture_btn__" style="margin-left:auto;padding:6px 14px;border:0;border-radius:6px;' +
    'background:#fff;color:#0891b2;font-weight:700;cursor:pointer">Capture Session</button>' +
    '<button id="__epmp_dismiss_btn__" style="padding:6px 10px;border:0;border-radius:6px;' +
    'background:rgba(255,255,255,.2);color:#fff;cursor:pointer">✕</button>';

  document.documentElement.appendChild(bar);
  // Nudge the page down so the banner never hides the login form.
  document.documentElement.style.setProperty('margin-top', '44px', 'important');

  const statusEl = bar.querySelector('#__epmp_status__');
  const btn = bar.querySelector('#__epmp_capture_btn__');
  const setStatus = (t) => { statusEl.textContent = t; };

  bar.querySelector('#__epmp_dismiss_btn__').addEventListener('click', () => {
    bar.remove();
    document.documentElement.style.removeProperty('margin-top');
  });

  btn.addEventListener('click', () => {
    btn.disabled = true;
    setStatus('Capturing…');
    chrome.runtime.sendMessage({ type: 'capture-now' }, (res) => {
      if (chrome.runtime.lastError) {
        btn.disabled = false;
        setStatus('❌ ' + chrome.runtime.lastError.message);
        return;
      }
      if (res?.ok) {
        setStatus(`✅ Captured ${res.cookieCount} cookies${res.endpointDiscovered ? ' + catalog' : ''}. You can close this tab.`);
        btn.textContent = 'Done';
        setTimeout(() => { try { window.close(); } catch { /* ignore */ } }, 2500);
      } else if (res?.error === 'No capture context for this tab') {
        // Most likely cause: an earlier auto-capture on this tab already
        // succeeded and cleared the context (see markBannerCaptured in
        // background.js, which should normally beat us to this state —
        // this is the fallback if that update didn't land in time).
        btn.disabled = true;
        btn.textContent = 'Done';
        setStatus('✅ Already captured for this tab. Reopen the capture flow if you need to re-capture.');
      } else {
        btn.disabled = false;
        setStatus('❌ ' + (res?.error || 'Capture failed'));
      }
    });
  });
};

// Called by background.js right after a one-shot auto-capture succeeds, so the
// banner reflects reality instead of leaving a "Capture Session" button that
// would otherwise fail with a confusing "no capture context" error if clicked.
window.__epmpConnectMarkCaptured = function (result) {
  const bar = document.getElementById('__epmp_connect_bar__');
  if (!bar) return;
  const statusEl = bar.querySelector('#__epmp_status__');
  const btn = bar.querySelector('#__epmp_capture_btn__');
  if (statusEl) {
    statusEl.textContent = `✅ Captured ${result?.cookieCount ?? ''} cookies automatically. You can close this tab.`;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Done'; }
};
