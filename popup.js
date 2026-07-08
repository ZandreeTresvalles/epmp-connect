/**
 * EPMP Connect — popup (manual capture of the ACTIVE tab).
 *
 * The universal fallback for every backend: pick nothing, paste the one-time
 * token, (optionally) set the backend URL once, and capture the session on the
 * Seller Center tab you're currently viewing. The heavy lifting (cookies +
 * localStorage + upload) is done by background.js so the logic stays in one
 * place. Backend URL ships with NO default — enter it once; it's saved locally.
 */

// ── Platform detection (active tab URL) ──────────────────────────────────────
const PLATFORMS = {
  SHOPEE: { label: 'Shopee', match: (u) => /(^|\.)shopee\.(ph|com)/.test(host(u)) },
  LAZADA: { label: 'Lazada', match: (u) => /(^|\.)lazada\.com(\.ph)?/.test(host(u)) },
  TIKTOK: { label: 'TikTok', match: (u) => /(^|\.)tiktok(shop)?\.com/.test(host(u)) },
};

function host(u) { try { return new URL(u).host; } catch { return ''; } }

function detectPlatform(url) {
  for (const [key, cfg] of Object.entries(PLATFORMS)) if (cfg.match(url)) return key;
  return null;
}

// ── UI helpers ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function setBadge(platform) {
  const badge = $('platformBadge');
  const text = $('platformText');
  badge.className = 'platform-badge ' + (platform ? 'detected' : 'undetected');
  text.textContent = platform
    ? `${PLATFORMS[platform].label} Seller Center detected`
    : 'Open a Shopee / Lazada / TikTok Seller Center tab';
}

function setStatus(kind, msg, spinner) {
  const box = $('statusMsg');
  box.className = 'status show ' + kind;
  $('statusIcon').innerHTML = spinner ? '<span class="spinner"></span>' : '';
  $('statusText').textContent = msg;
}

// ── Init ─────────────────────────────────────────────────────────────────────
let activeTab = null;
let activePlatform = null;

document.addEventListener('DOMContentLoaded', async () => {
  // No baked-in default — this is a public, multi-project extension.
  const stored = await chrome.storage.local.get('apiUrl');
  $('apiUrlInput').value = stored.apiUrl || '';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab;
    activePlatform = tab?.url ? detectPlatform(tab.url) : null;
  } catch { /* tabs API unavailable */ }
  setBadge(activePlatform);

  $('settingsToggle').addEventListener('click', () => {
    const open = $('settingsPanel').classList.toggle('open');
    $('settingsToggle').innerHTML = (open ? '▲' : '⚙') + ' Settings';
    // If no backend saved yet, nudge the operator to fill it in.
    if (open && !$('apiUrlInput').value) $('apiUrlInput').focus();
  });

  $('apiUrlInput').addEventListener('blur', async () => {
    await chrome.storage.local.set({ apiUrl: $('apiUrlInput').value.trim() });
  });

  $('captureBtn').addEventListener('click', onCapture);
});

async function onCapture() {
  const token = $('tokenInput').value.trim();
  const backendUrl = $('apiUrlInput').value.trim();

  if (!token) { setStatus('error', 'Paste the one-time token from the Sessions page.'); return; }
  if (!backendUrl) {
    $('settingsPanel').classList.add('open');
    setStatus('error', 'Set the Backend API URL in Settings first.');
    return;
  }
  if (!activePlatform) { setStatus('error', 'Open a Seller Center tab, then capture.'); return; }

  await chrome.storage.local.set({ apiUrl: backendUrl });
  $('captureBtn').disabled = true;
  setStatus('loading', 'Capturing session…', true);

  chrome.runtime.sendMessage(
    { type: 'CAPTURE_ACTIVE_TAB', tabId: activeTab.id, platform: activePlatform, token, backendUrl },
    (res) => {
      $('captureBtn').disabled = false;
      if (chrome.runtime.lastError) { setStatus('error', chrome.runtime.lastError.message); return; }
      if (res?.ok) {
        setStatus('success', `Captured ${res.cookieCount} cookies. Session uploaded.`);
        $('tokenInput').value = '';
      } else {
        setStatus('error', res?.error || 'Capture failed.');
      }
    },
  );
}
