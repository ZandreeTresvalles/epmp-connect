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

  // Pull the product array out of a product-list response (known shapes).
  function productArray(json) {
    if (!json || typeof json !== 'object') return null;
    const roots = [json, json.data, json.data?.result, json.data?.module];
    const keys = ['list', 'products', 'items', 'product_list', 'page_list', 'productList', 'dataList'];
    for (const root of roots) {
      if (!root || typeof root !== 'object') continue;
      for (const k of keys) {
        const v = root[k];
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
      }
    }
    return null;
  }

  function looksLikeProducts(json) {
    return productArray(json) !== null;
  }

  // Does the product array carry actual product data (a name), or is it an
  // ID-only list? Seller Center fires several product-shaped XHRs — some return
  // hydrated rows (name/price/image, e.g. Shopee's `search_product_list`) and
  // some return only item IDs (an id-only prefetch). A replay of an id-only
  // endpoint yields nameless rows the backend can't persist, so we must NOT let
  // one win discovery over a hydrated sibling. Checking a few entries for a
  // name-ish field distinguishes them without hard-coding any endpoint.
  function looksHydrated(json) {
    const arr = productArray(json);
    if (!arr) return false;
    const hasName = (o) =>
      o && typeof o === 'object' &&
      [o.name, o.product_name, o.productName, o.title, o.product && o.product.name].some(
        (v) => typeof v === 'string' && v.trim(),
      );
    return arr.slice(0, 5).some(hasName);
  }

  function record(url, method, body, json) {
    if (!RE.test(url)) return;
    if (!looksLikeProducts(json)) return;
    const hydrated = looksHydrated(json);
    // "preferred" (the entry discovery locks onto first) requires BOTH a
    // catalog-shaped URL AND hydrated rows — an id-only response never wins.
    const entry = { url, method, body: body || null, json, hydrated, preferred: hydrated && PREFER.test(url) };
    // Hydrated responses bubble to the front so `captured[0]` / find(preferred)
    // pick real product data; id-only responses sink to the back as a last
    // resort (the backend then falls back to the in-page worker).
    if (hydrated) window.__epmpProductCapture.unshift(entry);
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
