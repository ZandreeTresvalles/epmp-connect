/**
 * page-state-collision.test.js — the service-worker REALM test.
 *
 * WHY THIS EXISTS (v2.7.0 shipped broken without it):
 * `importScripts('page-state.js')` runs page-state.js in the SAME global
 * lexical scope as background.js. So a top-level `const isAuthPath = …` in
 * background.js collides with page-state.js's own top-level declaration of
 * that name, and Chrome refuses to register the service worker:
 *
 *   Uncaught SyntaxError: Failed to execute 'importScripts' on
 *   'WorkerGlobalScope': Identifier 'AUTHENTICATED_CONTENT_SELECTOR' has
 *   already been declared
 *   Service worker registration failed. Status code: 15
 *
 * The extension is then completely dead — the operator sees
 * "Extension did not respond — is EPMP Connect installed?".
 *
 * Node's `require()` gives every module its OWN scope, so all 46 other tests
 * passed against a build that could not even start. Only a shared-realm test
 * catches this class of bug, so this one rebuilds that realm with `vm`:
 * one context, a real importScripts that evaluates into it, and the same
 * load order Chrome uses.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function makeServiceWorkerRealm() {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop, hasListener: () => false };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    chrome: {
      tabs: {
        onUpdated: listener,
        onRemoved: listener,
        onActivated: listener,
        get: noop, update: noop, remove: noop, query: async () => [], create: noop, sendMessage: noop,
      },
      runtime: {
        onMessage: listener,
        onInstalled: listener,
        onStartup: listener,
        getManifest: () => ({ version: '0.0.0', content_scripts: [] }),
        id: 'test-extension-id',
        lastError: null,
      },
      storage: { session: { set: noop, get: async () => ({}), remove: noop }, local: { set: noop, get: async () => ({}) } },
      cookies: { getAll: async () => [], remove: noop },
      scripting: { executeScript: async () => [{ result: null }] },
      windows: { update: noop },
      action: { onClicked: listener },
      notifications: { create: noop },
    },
  };
  // A service worker's global IS `self` (and `globalThis`).
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

test('service worker registers: background.js + page-state.js share one lexical scope with NO duplicate declarations', () => {
  const dir = __dirname;
  const sandbox = makeServiceWorkerRealm();
  const context = vm.createContext(sandbox);

  // The real thing: importScripts evaluates the file into THIS SAME realm,
  // which is precisely what makes duplicate top-level declarations fatal.
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), context, { filename: file });
    }
  };

  const backgroundSrc = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
  try {
    vm.runInContext(backgroundSrc, context, { filename: 'background.js' });
  } catch (err) {
    assert.fail(
      'Service worker would FAIL TO REGISTER (the extension appears "not installed" to the operator).\n' +
        `  ${err.name}: ${err.message}\n` +
        '  Cause: background.js and page-state.js share one global lexical scope via importScripts().\n' +
        '  Fix: do NOT declare a top-level const/let/function in background.js with a name that\n' +
        '  page-state.js already declares — read it off `self.EpmpPageState` under a different\n' +
        '  local name instead (see the PageState alias block in background.js).',
    );
  }

  // Sanity: the realm really did load page-state and wire the worker up.
  assert.equal(typeof sandbox.EpmpPageState, 'object', 'page-state.js should have populated self.EpmpPageState');
  assert.equal(typeof sandbox.EpmpPageState.isAuthPath, 'function');
});

test('no top-level identifier is declared in BOTH page-state.js and background.js', () => {
  const dir = __dirname;
  const topLevelDecls = (src) => {
    const names = new Set();
    // Only column-0 declarations are top level in these files.
    const re = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
    return names;
  };
  const ps = topLevelDecls(fs.readFileSync(path.join(dir, 'page-state.js'), 'utf8'));
  const bg = topLevelDecls(fs.readFileSync(path.join(dir, 'background.js'), 'utf8'));
  const clash = [...ps].filter((n) => bg.has(n));
  assert.deepEqual(
    clash,
    [],
    `These identifiers are declared at top level in BOTH files and will kill the service worker ` +
      `at registration: ${clash.join(', ')}. Rename the background.js copy (read it off ` +
      '`self.EpmpPageState` under a local alias).',
  );
});
