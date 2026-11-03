// test-mode.js — a board that takes every change and keeps none of them.
//
// WHAT IT IS. Entered by `?test` on the URL, carried on the links between the
// three pages, or by the tester role (auth.js), which is in it always. Nothing
// about the mode is persisted anywhere - not localStorage, not sessionStorage,
// not IndexedDB, not a cookie: the URL and the role are the only state, so a
// reload is a fresh test session and Exit is a plain navigation to the same
// page without the flag.
//
// WHERE THE WRITES GO. In firestore mode the store's function namespace is
// wrapped (`wrapFirestore`): reads and listeners pass through until the first
// write; every write first awaits the network being disabled, once, and is
// then handed to the SDK without awaiting its promise, which never settles
// while offline. The SDK applies the write to its memory cache at once, so
// every listener and every later read sees it, with the real merge, delete
// and query semantics, and nothing leaves the browser. After that first
// write, reads come from the cache functions, a miss reading as empty. The
// wrapper throws on any name it does not wrap, so a new write function cannot
// slip past it; `enableNetwork` is imported nowhere.
//
// WHAT THE CACHE KEEPS. The memory cache's garbage collector is eager: a
// document is dropped the moment no listener holds it, so a plain one-shot
// read would leave nothing behind for after the freeze - the parts page
// re-reads every correction after each one, the codes page re-reads the map
// after each save, and both would come back near-empty. So a read before the
// freeze also opens a listener on its target and never releases it. The SDK
// serves both from the one target (one read per document), and the listener
// holds the documents for the rest of the session.
//
// WHAT STAYS ON THE MACHINE. Nothing. localStorage goes behind `storage()`:
// in test mode a map, read from localStorage the first time a key is wanted
// and written only in memory. The store's local mode and the per-device
// preferences both go through it.

const FLAG = 'test';

/** The approved words. Nothing else about the mode is said on screen. */
export const NOT_AVAILABLE = 'Not available in test mode.';
export const TITLE_PREFIX = 'Test mode – ';
const BANNER_WORD = 'Test mode';
const EXIT_WORD = 'Exit';

/** Is the flag on this query string? `?test`, `?test=` and `?a=1&test` all count. */
export const hasFlag = (search = location.search) => new URLSearchParams(search).has(FLAG);

const state = { on: hasFlag(), forced: false };

export const isTestMode = () => state.on;
/** In by the tester role rather than the flag: no Exit, and the flag changes nothing. */
export const isForced = () => state.forced;

/**
 * Turn the mode on from code: the tester role (auth.js), once it is known.
 * There is no way back but a navigation, which is the point.
 */
export function enterTestMode({ forced = false } = {}) {
  state.on = true;
  if (forced) state.forced = true;
}

/** For the test suite only: the mode as a fresh page would have it. */
export function _resetTestMode(on = false) {
  state.on = on;
  state.forced = false;
  scratch = null;
  banner?.remove();
  banner = null;
  if (document.title.startsWith(TITLE_PREFIX)) document.title = document.title.slice(TITLE_PREFIX.length);
}

// ---- the links between the pages ---------------------------------------------

/** An href in three: the path, the query without its '?', the hash with its '#'. */
function parts(href) {
  const s = String(href ?? '');
  const h = s.indexOf('#');
  const hash = h < 0 ? '' : s.slice(h);
  const rest = h < 0 ? s : s.slice(0, h);
  const q = rest.indexOf('?');
  return { path: q < 0 ? rest : rest.slice(0, q), query: q < 0 ? '' : rest.slice(q + 1), hash };
}

/** Not one of our pages: a scheme, a protocol-relative URL, or an anchor on this page. */
const foreign = (path, href) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path) || String(href ?? '').startsWith('#');

/**
 * The href with the flag on it: `parts` -> `parts?test`, `./?a=1#x` ->
 * `./?a=1&test#x`. Unchanged when it carries it already, or is not ours.
 */
export function withTestFlag(href) {
  const { path, query, hash } = parts(href);
  if (foreign(path, href) || new URLSearchParams(query).has(FLAG)) return String(href ?? '');
  return `${path}?${query ? `${query}&` : ''}${FLAG}${hash}`;
}

/** The href without the flag, every other parameter kept. */
export function withoutTestFlag(href) {
  const { path, query, hash } = parts(href);
  const params = new URLSearchParams(query);
  params.delete(FLAG);
  const q = params.toString();
  return `${path}${q ? `?${q}` : ''}${hash}`;
}

/** A link to another page, carrying the flag when this page has it. */
export const carryFlag = (href) => (hasFlag() ? withTestFlag(href) : href);

/** Every link under `root` that is one of ours carries the flag. */
export function flagLinks(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    const next = withTestFlag(href);
    if (next !== href) a.setAttribute('href', next);
  }
}

// ---- what would have been localStorage ---------------------------------------

let scratch = null;

/**
 * localStorage, or in test mode a map in its place: a key is read from
 * localStorage the first time it is wanted, and every write stays here.
 * Removal is remembered too, so a removed key does not read as its old value.
 */
export function storage() {
  if (!state.on) return localStorage;
  if (!scratch) {
    const map = new Map();
    scratch = {
      getItem(key) {
        if (map.has(key)) return map.get(key);
        try { return localStorage.getItem(key); } catch { return null; }
      },
      setItem(key, value) { map.set(key, String(value)); },
      removeItem(key) { map.set(key, null); },
    };
  }
  return scratch;
}

/**
 * Per-device preferences, by key: the Gantt view, the part orders toggle, the
 * warehouse paper, the watermaker page, the published marker, the collapsed
 * categories. Never throws: a browser that refuses storage has no preferences.
 */
export const prefs = {
  get(key) { try { return storage().getItem(key); } catch { return null; } },
  set(key, value) { try { storage().setItem(key, value); } catch { /* no preference, then */ } },
  remove(key) { try { storage().removeItem(key); } catch { /* nothing to remove */ } },
};

// ---- Firebase Auth --------------------------------------------------------------

/** What the three Auth writes throw in test mode. The UI shows it as the toast. */
export const notAvailable = () => Object.assign(new Error(NOT_AVAILABLE), { code: 'test-mode' });
export const isNotAvailable = (e) => e?.code === 'test-mode';

// ---- Firestore ---------------------------------------------------------------------

/** What a document read gives for a document the cache does not hold. */
const noDoc = (ref) => ({
  id: ref?.id,
  ref,
  exists: () => false,
  data: () => undefined,
  get: () => undefined,
  metadata: { fromCache: true, hasPendingWrites: false },
});

/** What a query read gives when the cache has nothing for it. */
const noDocs = () => ({
  empty: true,
  size: 0,
  docs: [],
  forEach() {},
  docChanges: () => [],
  metadata: { fromCache: true, hasPendingWrites: false },
});

/** Handed through untouched. Anything else throws; see `wrapFirestore`. */
const PASS = ['doc', 'collection', 'query', 'where', 'orderBy', 'limit', 'startAfter', 'onSnapshot', 'deleteField'];

const own = (o, name) => Object.prototype.hasOwnProperty.call(o, name);

/**
 * The Firestore function namespace for test mode, over the real one.
 *
 * Every write awaits `freeze()`, which runs `disableNetwork(db)` exactly once,
 * then calls the real function without awaiting it and resolves (`addDoc`
 * with the new reference, made here with `doc()`, since the real promise
 * never settles). `writeBatch` gives a batch whose `commit` does the same.
 * Reads pass through until the first write, each holding its target with a
 * listener so the cache keeps what it read; from then on they come from the
 * cache, a miss as an empty snapshot. Should `disableNetwork` itself fail,
 * every write fails with it: nothing is handed to the SDK that could leave.
 *
 * @param fs  the real namespace, as firebase.js imports it
 * @param db  the Firestore instance the store holds
 */
export function wrapFirestore(fs, db) {
  let frozen = null;      // the one disableNetwork, once the first write asks for it
  const freeze = () => frozen ?? (frozen = Promise.resolve().then(() => fs.disableNetwork(db)));

  // The targets held live for the session. A document or a collection has a
  // path to key on; a composed query is held each time, which costs nothing
  // on the wire: the SDK serves every listener on one target from one read.
  const held = new Set();
  const hold = (target) => {
    const key = typeof target?.path === 'string' ? target.path : null;
    if (key !== null) {
      if (held.has(key)) return;
      held.add(key);
    }
    try { fs.onSnapshot(target, () => {}, () => {}); } catch { /* the read itself reports it */ }
  };

  const read = (fn, cached, miss) => async (target, ...rest) => {
    if (!frozen) {
      hold(target);
      return fs[fn](target, ...rest);
    }
    await frozen.catch(() => {});
    try { return await fs[cached](target, ...rest); } catch { return miss(target); }
  };

  const write = (fn) => async (...args) => {
    await freeze();
    Promise.resolve(fs[fn](...args)).catch(() => {});
  };

  const wrapped = {
    getDoc: read('getDoc', 'getDocFromCache', noDoc),
    getDocs: read('getDocs', 'getDocsFromCache', noDocs),
    setDoc: write('setDoc'),
    deleteDoc: write('deleteDoc'),
    async addDoc(col, data) {
      await freeze();
      const ref = fs.doc(col);
      Promise.resolve(fs.setDoc(ref, data)).catch(() => {});
      return ref;
    },
    writeBatch(...args) {
      const batch = fs.writeBatch(...args);
      const w = {
        set: (...a) => { batch.set(...a); return w; },
        update: (...a) => { batch.update(...a); return w; },
        delete: (...a) => { batch.delete(...a); return w; },
        commit: async () => {
          await freeze();
          Promise.resolve(batch.commit()).catch(() => {});
        },
      };
      return w;
    },
  };
  for (const name of PASS) wrapped[name] = (...args) => fs[name](...args);

  return new Proxy(wrapped, {
    get(target, name) {
      if (typeof name === 'symbol' || name === 'then') return undefined;
      if (own(target, name)) return target[name];
      throw new Error(`Test mode: Firestore.${name} is not wrapped`);
    },
    has: (target, name) => own(target, name),
  });
}

// ---- the page --------------------------------------------------------------------

let banner = null;

/**
 * Put the page in the mode: the title prefix, the banner (its Exit only when
 * the flag is the reason), and the flag on the links to the other pages when
 * this page carries it. Idempotent: called at boot and again once the role is
 * known. Returns the banner, or null when the page is not in the mode.
 */
export function showTestMode() {
  if (!state.on) return null;
  if (!document.title.startsWith(TITLE_PREFIX)) document.title = TITLE_PREFIX + document.title;
  if (!banner || !banner.isConnected) {
    banner = document.createElement('div');
    banner.className = 'test-mode';
    banner.id = 'testMode';
    const word = document.createElement('span');
    word.textContent = BANNER_WORD;
    const exit = document.createElement('button');
    exit.className = 'mini';
    exit.id = 'testExit';
    exit.textContent = EXIT_WORD;
    exit.addEventListener('click', exitTestMode);
    banner.append(word, exit);
    document.body.prepend(banner);
  }
  banner.querySelector('#testExit').hidden = state.forced;
  if (hasFlag()) flagLinks(document);
  return banner;
}

/** Back to the real board: this page, without the flag, loaded afresh. */
export function exitTestMode() {
  location.assign(withoutTestFlag(`${location.pathname}${location.search}${location.hash}`));
}

/** From the cog: this page again, with the flag, in this tab. */
export function openTestMode() {
  location.assign(withTestFlag(`${location.pathname}${location.search}${location.hash}`));
}
