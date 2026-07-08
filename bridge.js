/**
 * EPMP Connect — page bridge (content script, ISOLATED world).
 *
 * Relays window.postMessage calls from a project's web app into the background
 * service worker and back. It speaks BOTH predecessor dialects so no frontend
 * needs changing:
 *
 *   - EPMP dialect:      page posts { __epmpPage: true, requestId, type, payload }
 *                        bridge replies { __epmpConnect: true, requestId, type, ... }
 *                        types: 'ping' -> 'pong', 'capture' -> 'capture-ack'
 *   - ReportBot dialect: page posts { __rb_ext__: true, id, type, payload }
 *                        bridge replies { __rb_ext__: true, id, response|error }
 *                        types: 'PING' | 'REQUEST_CAPTURE' | 'DO_CAPTURE'
 *
 * Only messages that carry a known tag AND originate from this same window are
 * relayed, so an arbitrary site cannot drive the extension.
 */

(function () {
  'use strict';

  const version = chrome.runtime.getManifest().version;

  // Announce presence in both dialects so either frontend's detector sees us.
  window.postMessage({ __epmpConnect: true, type: 'ready', version }, window.location.origin);
  window.postMessage({ __rb_ext__: true, type: 'ready', version }, '*');

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // ── EPMP dialect ──────────────────────────────────────────────────────────
    if (data.__epmpPage === true) {
      const { requestId, type, payload } = data;
      const reply = (extra) =>
        window.postMessage({ __epmpConnect: true, requestId, ...extra }, window.location.origin);

      if (type === 'ping') {
        reply({ type: 'pong', version });
        return;
      }
      if (type === 'capture') {
        chrome.runtime.sendMessage({ type: 'capture', payload }, (res) => {
          if (chrome.runtime.lastError) {
            reply({ type: 'capture-ack', ok: false, error: chrome.runtime.lastError.message });
          } else {
            reply({ type: 'capture-ack', ok: !!res?.ok, error: res?.error, tabId: res?.tabId });
          }
        });
        return;
      }
      return;
    }

    // ── ReportBot dialect ─────────────────────────────────────────────────────
    if (data.__rb_ext__ === true && data.id && data.type) {
      // Ignore our own outgoing replies (they also carry __rb_ext__).
      if (data.response !== undefined || data.error !== undefined) return;
      const { id, type, payload } = data;
      const reply = (response, error) =>
        window.postMessage({ __rb_ext__: true, id, ...(error ? { error } : { response }) }, '*');

      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) reply(undefined, chrome.runtime.lastError.message);
        else if (res?.error) reply(undefined, res.error);
        else reply(res || { ok: true });
      });
      return;
    }
  });
})();
