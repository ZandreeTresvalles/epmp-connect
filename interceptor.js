/**
 * EPMP Connect — product-list interceptor (content script, MAIN world).
 *
 * Runs at document_start on Seller Center pages and passively records the
 * product-list API responses the page fetches on its own (fetch + XHR), so the
 * background worker can discover the catalog endpoint without us reverse-
 * engineering each platform's private API. Results go into
 * window.__epmpProductCapture (max 6 entries), the newest/most-likely first.
 *
 * This is best-effort telemetry only — it never blocks the page and is only
 * consumed when a capture supplies a productListUrl (EPMP flow).
 */

(function () {
  'use strict';
  if (window.__epmpProductCaptureInstalled) return;
  window.__epmpProductCaptureInstalled = true;
  window.__epmpProductCapture = [];

  const MAX = 6;
  // URLs that look like a product-list endpoint across Shopee / Lazada / TikTok.
  const RE = /(get_product_list|mpsku\/list|products?\/(list|search)|search_v3|product_v3|mtop.*product|(sea_)?products?\/(list|search|get)|product\/local\/products\/list)/i;
  // Endpoints we PREFER (the real catalog, not a widget/suggestion feed).
  const PREFER = /(search_product_list|get_product_list|product\/local\/products\/list|mpsku\/list)/i;

  function looksLikeProducts(json) {
    if (!json || typeof json !== 'object') return false;
    const roots = [json, json.data, json.data?.result, json.data?.module];
    const keys = ['list', 'products', 'items', 'product_list', 'page_list', 'productList', 'dataList'];
    for (const root of roots) {
      if (!root || typeof root !== 'object') continue;
      for (const k of keys) {
        const v = root[k];
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') return true;
      }
    }
    return false;
  }

  function record(url, method, body, json) {
    if (!RE.test(url)) return;
    if (!looksLikeProducts(json)) return;
    const entry = { url, method, body: body || null, json, preferred: PREFER.test(url) };
    if (entry.preferred) window.__epmpProductCapture.unshift(entry);
    else window.__epmpProductCapture.push(entry);
    if (window.__epmpProductCapture.length > MAX) window.__epmpProductCapture.length = MAX;
  }

  // ── Patch fetch ──────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === 'string' ? req : req?.url;
      const method = (args[1]?.method || (typeof req === 'object' && req?.method) || 'GET').toUpperCase();
      const body = args[1]?.body;
      if (url && RE.test(url)) {
        res.clone().json().then((json) => record(url, method, body, json)).catch(() => {});
      }
    } catch { /* never disturb the page */ }
    return res;
  };

  // ── Patch XHR ────────────────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__epmpUrl = url;
    this.__epmpMethod = (method || 'GET').toUpperCase();
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__epmpUrl && RE.test(this.__epmpUrl)) {
      this.addEventListener('load', () => {
        try {
          const json = JSON.parse(this.responseText);
          record(this.__epmpUrl, this.__epmpMethod, body, json);
        } catch { /* not JSON */ }
      });
    }
    return origSend.call(this, body);
  };
})();
