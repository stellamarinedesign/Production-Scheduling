// package-changes.js — the packages as this page has them, and the changes
// made here that the server does not have yet.
//
// FIRST WHAT THE BOARD HOLDS, THEN WHAT THE SERVER SAYS. A package is drawn
// from the copy the board loaded with; the server's is read behind it and
// takes its place. With neither there is nothing to change: a package is
// written whole, so one built from nothing would replace the one that is
// there.
//
// ON SCREEN AT ONCE, WRITTEN BEHIND. A change is a function of the document it
// changes. The screen has what was loaded with the waiting changes on top. The
// write reads the document as the server has it, makes the same change to that
// and saves it, so another manager's change meanwhile is kept and nothing is
// ever built from an old copy. A refused change is taken back, and only that
// one. Offline a write waits for the connection, and nothing else waits for it.

import { Store } from './store.js';
import { LIBRARY_KEY } from './packages.js';

let base = null;               // key -> document, as loaded; null until something has been
let waiting = [];              // { key, apply, at } - not taken by the server yet, oldest first
let taken = [];                // the ones it has taken, for a read that began before them
const turns = new Map();       // key -> its last write, so two changes to one document go in turn

/** The packages with one document replaced, or taken out (null). */
const put = (all, key, data) => {
  const out = { ...all };
  if (data) out[key] = data; else delete out[key];
  return out;
};

/** The packages with changes made to them, in order. */
const made = (all, changes) => changes.reduce((a, c) => put(a, c.key, c.apply(a[c.key] ?? null, a)), all);

/** Is there a copy, the board's or the server's? Nothing can be changed without one. */
export const packagesKnown = () => base !== null;

/** Every package as the screen has it, the library and the plinth folder with them. */
export const packagesNow = () => made(base ?? {}, waiting);

/**
 * The copy the board holds. An empty one is not a copy: the board takes a
 * failed load for no packages. Nor is one taken under a change on its way,
 * which it would already have in it.
 */
export function adoptPackages(packages) {
  if (waiting.length || !packages || !Object.keys(packages).length) return;
  base = { ...packages };
}

/** Read every package as the server has it. Throws when it cannot; what was there before stays. */
export async function readPackages() {
  const since = taken.length;
  const fresh = await Store.loadPackages();
  // A change taken while this was on its way is not undone by it.
  base = made({ ...fresh }, taken.slice(since));
  return packagesNow();
}

/**
 * Make a change: in `packagesNow` at once, written behind it.
 *
 * @param {string} key  the document
 * @param {(doc: Object|null, all: Object) => Object|null} apply
 *        the document as it is (null: there is none) to the document as it is to
 *        be (null: removed), every package given beside it. Made more than once -
 *        on the screen's copy, then on the server's - so making it again changes nothing.
 * @returns {Promise<void>}  once the server has it. Rejects when it was refused, the
 *        change then taken back. Offline, neither until the connection returns.
 */
export function changePackage(key, apply) {
  if (!base) return Promise.reject(new Error('No packages loaded to change'));
  const c = { key, apply, at: Date.now() };
  waiting = [...waiting, c];
  const done = (turns.get(key) ?? Promise.resolve()).then(() => write(c))
    .finally(() => { waiting = waiting.filter((w) => w !== c); });
  turns.set(key, done.catch(() => {}));
  return done;
}

async function write(c) {
  const cur = await Store.loadPackage(c.key);
  // Nothing in the app removes the library, so with one loaded, none is no answer to build on.
  if (!cur && c.key === LIBRARY_KEY && base[LIBRARY_KEY]) throw new Error('The library was not found');
  const next = c.apply(cur, put(base, c.key, cur));
  await Store.savePackage(c.key, next);
  base = put(base, c.key, next);
  taken = [...taken, c];
}

/** Has any change waited this long for an answer? */
export const unsentFor = (ms) => waiting.some((c) => Date.now() - c.at >= ms);

/** For the test suite: as a fresh page has it. */
export function _resetPackageChanges() {
  base = null;
  waiting = [];
  taken = [];
  turns.clear();
}
