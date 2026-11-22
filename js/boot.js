// boot.js — start-up: draw from the device, watch the network, hold the edits.
//
// Three things every page's start-up shares, kept out of the pages so each
// wires them in a few lines:
//
//   THE COPY SAVED ON THE DEVICE. What the page last loaded from the server,
//   in IndexedDB, drawn at once on the next open and replaced when the server
//   answers. IndexedDB rather than localStorage: the part list alone is a
//   third of a megabyte, and localStorage is a few megabytes shared by every
//   app on the github.io address. In test mode nothing is written to it; the
//   writes stay in memory for the session, as test-mode.js keeps everything.
//
//   A TIME LIMIT ON EACH STEP. A request that goes dead leaves a step waiting
//   for as long as the browser or the SDK cares to - a minute, for Firebase
//   sign-in on a phone. Each step gets LIMIT; past it Firestore's streams are
//   restarted, then the page reloads once on fresh connections, and only then
//   does the page say it has no answer. Offline is said at once.
//
//   THE HOLD. While the screen is the saved copy, the controls that change
//   anything are disabled - Pete's call, 23 Nov 2026 - with the reason beside
//   them (`.held-note`, shown while the page carries `is-held`).

import { isTestMode } from './test-mode.js';

// ---- the copy saved on the device -------------------------------------------

const DB_NAME = 'stella-board';
const DB_STORE = 'saved';

let opening = null;
function openDb() {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(DB_STORE); } catch { /* there already */ } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
    // A store that does not open promptly is no store: the page loads from the
    // server as it always did.
    setTimeout(() => resolve(null), 1500);
  });
  return opening;
}

// Test mode: what would have been written, for this page only.
const scratch = new Map();
let scratchCleared = false;

function request(mode, run) {
  return openDb().then((db) => new Promise((resolve) => {
    if (!db) { resolve(null); return; }
    try {
      const tx = db.transaction(DB_STORE, mode);
      const r = run(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(r?.result ?? null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  }));
}

/** Never throws, never waits long; null when there is nothing or no store. */
export const deviceCache = {
  get(key) {
    if (isTestMode()) {
      if (scratch.has(key)) return Promise.resolve(scratch.get(key));
      if (scratchCleared) return Promise.resolve(null);
    }
    return request('readonly', (s) => s.get(key));
  },
  set(key, value) {
    if (isTestMode()) { scratch.set(key, value); return Promise.resolve(); }
    return request('readwrite', (s) => s.put(value, key)).then(() => {});
  },
  clear() {
    if (isTestMode()) { scratch.clear(); scratchCleared = true; return Promise.resolve(); }
    return request('readwrite', (s) => s.clear()).then(() => {});
  },
};

/** For the test suite: test mode's writes as a fresh page would have them. */
export function _resetDeviceCache() { scratch.clear(); scratchCleared = false; }

/**
 * Who this device last saw signed in, and as what. The role is what lets the
 * saved copy be drawn before the sign-in and the access list are confirmed;
 * the page checks both and reloads on a different answer.
 */
export const recallSession = async () => {
  const s = await deviceCache.get('session');
  return s?.email && s?.role ? s : null;
};
export const rememberSession = (email, role) =>
  deviceCache.set('session', { email: String(email ?? '').trim().toLowerCase(), role });

/** On sign-out, or a sign-in that did not come back: nothing is left for the next person. */
export const forgetDevice = () => deviceCache.clear();

// ---- a time limit on each step ------------------------------------------------

export const LIMIT = 8000;

/**
 * Firestore restarts its streams when the browser reports the network has
 * changed: the SDK listens for `online` on the window and, unless the network
 * was switched off on purpose (test mode switches it off; see test-mode.js),
 * drops its connection and opens a new one. A synthetic `online` asks for
 * exactly that, without the page itself ever turning the network back on.
 */
export function restartStreams() {
  window.dispatchEvent(new Event('online'));
}

/** When a response last completed, on the page's clock (as watchdog.js reads it). */
function lastResponse() {
  let t = 0;
  for (const e of performance.getEntriesByType?.('resource') ?? []) if (e.responseEnd > t) t = e.responseEnd;
  return t;
}

/** No dialog open: a reload now would lose nothing. */
const nothingOpen = () => !document.querySelector('.overlay.show, dialog[open]');

/**
 * Watch the page's start-up, one step at a time.
 *
 *   step(name, kind)  a step has begun; `kind` 'firestore' is retried by
 *                     restarting the streams before anything else
 *   saved()           a copy saved on the device is on screen
 *   fail()            a step failed outright: say so now
 *   done()            start-up is over; the line goes, the watch stops
 *
 * @param {object} [opts]
 * @param {() => boolean} [opts.canReload]  whether reloading now loses nothing
 * @param {number} [opts.limit]            the time limit on a step, in ms
 * @param {() => boolean} [opts.online]    whether the browser says it is online
 * @param {() => number} [opts.progress]   when a response last completed
 * @param {object} [opts.boot]             watchdog.js's `window.__boot`
 *        (limit, online, progress and boot are there for the test suite)
 */
export function startup({ canReload = nothingOpen, limit = LIMIT, online = () => navigator.onLine !== false,
  progress = lastResponse, boot = window.__boot } = {}) {
  const B = boot ?? { say() {}, reloadOnce: () => false };
  B.started = true;
  let kind = null;
  let timer = null;
  let finished = false;
  let restarted = false;
  let failing = false;

  const arm = (ms = limit) => { clearTimeout(timer); timer = setTimeout(expire, ms); };
  function expire() {
    if (finished) return;
    if (!online()) { B.say('offline'); return; }                         // `online` arms again
    // Still arriving - a slow link, not a dead one: give it the time.
    if (!failing && performance.now() - progress() < limit) { arm(); return; }
    if (kind === 'firestore' && !restarted) {
      restarted = true;
      restartStreams();
      // The page already reloaded itself for this: no answer is the news.
      if (B.recent?.()) { failing = true; B.say('failing'); }
      arm();
      return;
    }
    if (!failing && canReload() && B.reloadOnce()) return;
    // The restart and the reload are spent. Still retrying, as the words say:
    // the SDK keeps trying on its own. The page stops interfering, so a link
    // that is slow rather than dead is never cut off mid-download again.
    failing = true;
    B.say('failing');
  }

  window.addEventListener('offline', () => { if (!finished) B.say('offline'); });
  window.addEventListener('online', (e) => {
    if (!e.isTrusted || finished) return;
    B.say(failing ? 'failing' : null);
    arm();
  });
  if (!online()) B.say('offline');

  return {
    step(name, k = 'network') {
      if (finished) return;
      kind = k;
      restarted = false;
      arm();
    },
    saved() {
      B.saved = true;
      if (!online()) B.say('offline');
    },
    fail() {
      if (finished) return;
      failing = true;
      clearTimeout(timer);
      B.say('failing');
    },
    /** A step that cannot be retried in the page (the SDK did not load): reload once, else say so. */
    retry() {
      if (finished) return;
      if (!online()) { B.say('offline'); return; }
      if (canReload() && B.reloadOnce()) return;
      this.fail();
    },
    done() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      B.done = true;
      B.say(null);
    },
  };
}

// ---- the hold -------------------------------------------------------------------

/**
 * Disable every control matching `selector`, now and as the page draws more,
 * until the returned function is called. A control the page has disabled for
 * its own reasons is left as the page set it, and one the page enables while
 * the hold is on is disabled again. Release enables only what the hold
 * disabled; redraw after it, so the page's own states come back.
 *
 * @returns {() => void} release
 */
export function hold(selector) {
  const mine = new Set();
  const take = (n) => { if (!n.disabled) { n.disabled = true; mine.add(n); } };
  const scan = (root) => {
    if (root.matches?.(selector)) take(root);
    for (const n of root.querySelectorAll?.(selector) ?? []) take(n);
  };
  document.documentElement.classList.add('is-held');
  scan(document.body);
  const watch = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') { if (!r.target.disabled && r.target.matches(selector)) take(r.target); continue; }
      for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
    }
  });
  watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    watch.disconnect();
    for (const n of mine) n.disabled = false;
    mine.clear();
    document.documentElement.classList.remove('is-held');
  };
}

/** Is a hold on? For the few controls that are not form elements (the Gantt's bars). */
export const isHeld = () => document.documentElement.classList.contains('is-held');
