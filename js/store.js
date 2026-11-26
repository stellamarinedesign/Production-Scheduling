// store.js — persistence for manager edits, vessel codes and import history.
//
// TWO BACKENDS, ONE INTERFACE.
//
// Firestore is the destination, but the board has to be usable before the
// Firebase project exists. So the store falls back to localStorage whenever
// Firebase is unconfigured or unreachable, and the UI says plainly which mode
// it is in. A board that silently stops persisting is worse than one that says
// it is local-only.
//
// Collections (STELLA_PRODUCTION_BOARD_CONTEXT.md §6, as amended):
//   vesselCodes/{stellaCode}  { boat, models[], hull_prefix[], items[],
//                               display, _confirmed }
//   jobOverrides/{prodNo}     { hidden, hiddenReason, labelOverride, updatedAt,
//                               completed, completedAt, completedBy, progress,
//                               touchedBy, touchedAt }
//   itemOverrides/{itemId}    { inventoryId, label, displayCode, updatedAt }
//   imports/{importId}        { retrievedAt, sourceId, sourceLabel, uploadedBy,
//                               horizonWeeks, maxStock, jobs[], rowsJson }
//   settings/board            { horizonWeeks, maxStock, autoFit,
//                               builders[{ name, marker }] }

import { getFirebase, failureReason, isConfigured } from './firebase.js';
import { toDateOnly, toISO } from './transform.js';
import { upgradeCodeMap, LEGACY_MODELS_KEY } from './vessel-codes.js';
import { normaliseAccess, markLoaded, isLoaded } from './access.js';
import { isTestMode, storage, wrapFirestore } from './test-mode.js';

const LS_PREFIX = 'stella.board.';
// Through `storage()` (test-mode.js): localStorage, or in test mode a map in
// its place, so nothing written during a test reaches the machine.
const lsGet = (k, fallback) => {
  try { const v = storage().getItem(LS_PREFIX + k); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
};
/** Firestore doc ids cannot contain '/'; item codes like SRLZZZXX04/24 can. */
const encodeItemId = (id) => String(id).replace(/\//g, '__');
/**
 * A vessel code as a document id, and back. A code can carry '/' too: a
 * lifter for two models reads as one code, XX01/XX02. Written as '__', as item
 * ids are, and read back as the code, so nothing above the store ever sees
 * the document id. (The first such code hit the live board on 2026-10-30 and
 * its save threw, which left the new-code dialog stuck.)
 */
const codeDocId = encodeItemId;
const codeFromDocId = (id) => String(id).replace(/__/g, '/');

const lsSet = (k, v) => { try { storage().setItem(LS_PREFIX + k, JSON.stringify(v)); } catch {} };

/**
 * Pack raw ERP rows for storage on the import record.
 *
 * As a JSON STRING, not a nested object: Firestore would otherwise coerce the
 * values to its own types on the way back out, and the adapter contract is that
 * rows reach the transform exactly as the source produced them.
 *
 * Date cells are written as YYYY-MM-DD from their LOCAL parts. JSON.stringify
 * emits UTC for a Date, so a local-midnight 12 Nov becomes
 * "2026-11-11T14:00:00Z" in a positive-offset timezone — and toDateOnly reads
 * the date off the front of an ISO string, so every date would come back a day
 * early. Brisbane is UTC+10, which is exactly the direction that breaks.
 */
export function packRows(rows) {
  return JSON.stringify(rows, function reviveDates(key, value) {
    // `this[key]` is the pre-toJSON value, so the Date is still a Date here.
    const raw = this[key];
    if (raw instanceof Date) return toISO(toDateOnly(raw));
    return value;
  });
}

export const unpackRows = (json) => (json ? JSON.parse(json) : null);

// Every field a job override can carry, and therefore every field that keeps
// the record alive.
//
// An override with nothing meaningful left is deleted rather than kept as an
// empty husk. That check used to be written inline as `!hidden && !labelOverride
// && !completed`, which meant the first field added after it — `status` — was
// written and then immediately deleted by the very next line. The record simply
// never survived the round trip.
//
// One list, named, used by both backends. Add a field here when you add a
// field, and nothing silently disappears.
export const OVERRIDE_FIELDS = ['hidden', 'labelOverride', 'completed', 'status', 'progress', 'hullOverride', 'plinth'];

export const isEmptyOverride = (o) => !OVERRIDE_FIELDS.some((f) => {
  const v = o?.[f];
  return v !== undefined && v !== null && v !== false && v !== '';
});

/**
 * Should a published import replace what this device already has?
 *
 * NEWER, not merely different. This was an inequality check, which meant a
 * snapshot carrying an OLDER record replaced the export the manager had just
 * applied — the board silently reverted to the previous sheet and their import
 * was gone. It surfaced when a publish was refused for being too large: the
 * newest record in the collection was still the previous one, and the watcher
 * handed it straight back.
 *
 * `retrievedAt` is an ISO-8601 string stamped by the adapter, so it sorts
 * lexicographically. A record without one is never newer than anything.
 */
export const isNewerImport = (rec, currentRetrievedAt) => {
  const at = rec?.retrievedAt ?? '';
  if (!at || !rec?.rowsJson) return false;
  return at > (currentRetrievedAt ?? '');
};

/**
 * Can the bootstrap file be there at all? A local board, or a copy served on
 * this machine to fill a fresh project. The live site has never carried it.
 */
export const seedServed = (mode, host) => mode === 'local'
  || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) || /\.localhost$/.test(host);

/** Firestore's ceiling on writes in one batch. */
export const BATCH_SIZE = 500;

/** A list in pieces of at most `size`, in order. */
export const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Is an activity entry about this job? Its own lines, and the item-wide
 * lines on its code, which are logged with no production number.
 */
export const aboutJob = (prodNo, inventoryId = null) => (r) =>
  r?.prodNo === prodNo || Boolean(!r?.prodNo && inventoryId && r?.inventoryId === inventoryId);

/** Sort by `at`, an ISO timestamp, newest first. */
export const newestFirst = (a, b) => String(b?.at ?? '').localeCompare(String(a?.at ?? ''));

export const Store = {
  mode: 'local',          // 'firestore' | 'local'
  reason: '',             // why local, when local
  _db: null,
  _fs: null,              // firestore function namespace
  _testing: false,        // the namespace is the test-mode wrapper

  async init() {
    const fb = await getFirebase();
    if (!fb) {
      this.mode = 'local';
      this.reason = isConfigured()
        ? `Firebase unreachable (${failureReason()}) — edits are saved on this device only.`
        : 'Firebase not configured — edits are saved on this device only.';
      return this.mode;
    }
    this._db = fb.db;
    this._fs = fb.fs;
    this.mode = 'firestore';
    this.reason = '';
    if (isTestMode()) this.enterTestMode();
    return this.mode;
  },

  /**
   * Test mode: from here on every Firestore write stays in this browser. The
   * function namespace is wrapped once (see test-mode.js), and the first page
   * of the activity log is read now, so the log still has it after the first
   * change, when reads come from the cache. Called by init when the URL
   * carries the flag, and by the pages once a tester's role is known.
   */
  enterTestMode() {
    if (this.mode !== 'firestore' || this._testing) return;
    this._testing = true;
    this._fs = wrapFirestore(this._fs, this._db);
    this.listActivityPage().catch(() => {});
  },

  // ---- vessel codes -------------------------------------------------------

  /**
   * The code map, seeded from the shipped JSON on first run.
   *
   * Merging is PER FIELD, not per code. Spreading whole entries
   * (`{...seed, ...stored}`) means a stored code shadows its seed entry
   * entirely, so any field later ADDED to the seed — `boat` was exactly this —
   * never reaches an install that already ran once. Stored values still win
   * wherever they exist; the seed only fills gaps.
   */
  async loadCodes() {
    // The seed is a BOOTSTRAP and is not in the repository — it is the product
    // structure of every boat, and as a static file it was readable by anyone
    // who knew the URL. Firestore is the source of truth once seeded, so a
    // deployment that has been seeded never needs it. Absent, this is `{}` and
    // everything comes from the store.
    //
    // Seeding a FRESH environment means copying the file from the private
    // handoff folder into data/ for one load. See the private SETUP document.
    const seed = upgradeCodeMap(await Store._seed()).map;
    const merge = (stored) => {
      const out = { ...seed };
      for (const [code, entry] of Object.entries(stored ?? {})) {
        out[code] = { ...(seed[code] ?? {}), ...entry };
      }
      return out;
    };

    if (this.mode === 'local') {
      const raw = lsGet('vesselCodes', null);
      if (!raw) { lsSet('vesselCodes', seed); return seed; }
      const { map: stored, upgraded } = upgradeCodeMap(raw);
      if (upgraded.length) lsSet('vesselCodes', stored);
      return merge(stored);
    }

    const { collection, doc, setDoc } = this._fs;
    const snap = await this._read(collection(this._db, 'vesselCodes'));
    if (snap.empty && !Object.keys(seed).length) return {};
    if (snap.empty) {
      await Promise.all(Object.entries(seed).map(([code, entry]) =>
        setDoc(doc(this._db, 'vesselCodes', codeDocId(code)), entry)));
      return seed;
    }
    const raw = {};
    snap.forEach((d) => { raw[codeFromDocId(d.id)] = d.data(); });
    const { map: stored, upgraded } = upgradeCodeMap(raw);
    if (upgraded.length) await this._rewriteLegacyCodes(stored, upgraded);
    return merge(stored);
  },

  /**
   * Rewrite records that still carry the model list under its old key: `models`
   * in, the old field deleted. Only those two fields are touched, so an edit made
   * meanwhile on another device survives.
   *
   * Best effort. Only a manager may write, and anybody else simply reads the
   * upgraded copy in memory; the first manager to load the codes does it for
   * everyone. See `upgradeCodeMap`.
   */
  async _rewriteLegacyCodes(stored, codes) {
    const { doc, setDoc, deleteField } = this._fs;
    try {
      await Promise.all(codes.map((code) => setDoc(doc(this._db, 'vesselCodes', codeDocId(code)),
        { models: stored[code].models ?? [], [LEGACY_MODELS_KEY]: deleteField() }, { merge: true })));
      console.info(`[codes] ${codes.length} records rewritten with \`models\``);
    } catch (e) {
      console.warn('[codes] could not rewrite the old model field', e.message);
    }
  },

  /** The bootstrap map, or {} when it is not deployed. Never throws. */
  async _seed() {
    if (this.__seed) return this.__seed;
    if (!seedServed(this.mode, location.hostname)) return (this.__seed = {});
    try {
      const r = await fetch(new URL('../data/vessel-codes.seed.json', import.meta.url),
        { cache: 'no-store' });
      this.__seed = r.ok ? await r.json() : {};
    } catch { this.__seed = {}; }
    return this.__seed;
  },

  async saveCode(code, patch) {
    if (this.mode === 'local') {
      const all = lsGet('vesselCodes', {});
      all[code] = { ...(all[code] ?? {}), ...patch };
      lsSet('vesselCodes', all);
      return;
    }
    const { doc, setDoc } = this._fs;
    await setDoc(doc(this._db, 'vesselCodes', codeDocId(code)), patch, { merge: true });
  },

  /**
   * Several codes at once, in one batch: all of it is saved or none of it is,
   * so a rename cannot stop half-way along a line.
   *
   * @param {Object<string,Object>} patches  code -> the fields to write
   * @returns {Promise<number>} how many
   */
  async saveCodes(patches) {
    const entries = Object.entries(patches ?? {});
    if (!entries.length) return 0;
    if (this.mode === 'local') {
      const all = lsGet('vesselCodes', {});
      for (const [code, patch] of entries) all[code] = { ...(all[code] ?? {}), ...patch };
      lsSet('vesselCodes', all);
      return entries.length;
    }
    const { doc, writeBatch } = this._fs;
    const batch = writeBatch(this._db);
    for (const [code, patch] of entries) batch.set(doc(this._db, 'vesselCodes', codeDocId(code)), patch, { merge: true });
    await batch.commit();
    return entries.length;
  },

  /**
   * Remove a vessel code entirely.
   *
   * Only used to undo a code accepted moments ago, when somebody cancels a
   * resolve run partway through. Anything longer-lived is edited on the vessel
   * codes page, never deleted from under a board that is already using it.
   */
  async deleteCode(code) {
    if (this.mode === 'local') {
      const all = lsGet('vesselCodes', {});
      delete all[code];
      lsSet('vesselCodes', all);
      return;
    }
    const { doc, deleteDoc } = this._fs;
    await deleteDoc(doc(this._db, 'vesselCodes', codeDocId(code)));
  },

  /**
   * Write a whole map, one document per code, a batch at a time.
   *
   * Used by the drop-in on the vessel codes page. Unlike `mergeCodes` this is
   * deliberate and overwrites: somebody has chosen a file and confirmed what it
   * changes, so a hand-confirmed `display` in the file is the answer, not
   * something to protect the store from.
   *
   * Up to BATCH_SIZE codes are saved together or not at all. Past that a batch
   * can fail with others before it saved, and the error says how many codes
   * those were (`saved`), in the order of the map.
   *
   * @param {(saved: number, of: number) => void} [onSaved]  after each batch
   */
  async putCodes(map, onSaved = () => {}) {
    const entries = Object.entries(map ?? {});
    let saved = 0;
    for (const part of chunk(entries, BATCH_SIZE)) {
      try { await this.saveCodes(Object.fromEntries(part)); } catch (e) { throw Object.assign(e, { saved }); }
      saved += part.length;
      onSaved(saved, entries.length);
    }
    return saved;
  },

  /** Merge newly-derived codes in without ever overwriting a `display`. */
  async mergeCodes(map, addedCodes) {
    if (!addedCodes.length) return;
    if (this.mode === 'local') { lsSet('vesselCodes', map); return; }
    const { doc, setDoc } = this._fs;
    await Promise.all(addedCodes.map((c) => setDoc(doc(this._db, 'vesselCodes', codeDocId(c)), map[c], { merge: true })));
  },

  // ---- per-job overrides --------------------------------------------------
  // Keyed on production number, which is stable and never reused, so a manual
  // decision survives the next export upload.

  async loadOverrides() {
    if (this.mode === 'local') return lsGet('jobOverrides', {});
    const { collection } = this._fs;
    const snap = await this._read(collection(this._db, 'jobOverrides'));
    const out = {};
    snap.forEach((d) => { out[d.id] = d.data(); });
    return out;
  },

  /**
   * Mark jobs done, or undo it. Completion rides on jobOverrides because it is
   * the same kind of thing — a manager decision keyed on a production number
   * that has to survive the next upload — and because reusing the collection
   * means no Firestore rules change, which is the step most easily forgotten.
   */
  /**
   * Mark jobs complete.
   *
   * `snapshots` is what keeps History honest. History used to be built only
   * from rows in the CURRENT export, so the moment the ERP finally closed a job
   * we had already marked done, it fell out of the export and vanished from the
   * record — the one view whose whole job is to remember. A completed job now
   * carries enough of itself to be rendered without the export it came from.
   *
   * @param {Object<string,Object>} snapshots  prodNo -> the job as it was
   */
  async setCompleted(prodNos, done, who, snapshots = {}) {
    const patchFor = (prodNo) => (done
      ? {
        completed: true,
        completedAt: new Date().toISOString(),
        completedBy: who ?? null,
        snapshot: snapshots[prodNo] ?? null,
      }
      : { completed: false, completedAt: null, completedBy: null, snapshot: null });
    // Undone one at a time: a record with nothing left in it has to go, which
    // is a read. Done, it goes as one batch, so a sweep of the backlog is one
    // round trip and cannot be left half made.
    if (this.mode === 'local' || !done) {
      for (const prodNo of prodNos) await this.setOverride(prodNo, patchFor(prodNo), who ?? null);
      return;
    }
    const { doc, writeBatch } = this._fs;
    for (const part of chunk(prodNos, BATCH_SIZE)) {
      const now = new Date().toISOString();
      const batch = writeBatch(this._db);
      for (const prodNo of part) {
        batch.set(doc(this._db, 'jobOverrides', prodNo),
          { ...patchFor(prodNo), updatedAt: now, touchedBy: who ?? null, touchedAt: now }, { merge: true });
      }
      await batch.commit();
    }
  },

  /**
   * `who` is the person making the change. Given, the write also stamps
   * `touchedBy`/`touchedAt`, which is what History's Last changed column reads;
   * the stamp alone keeps no record alive (see OVERRIDE_FIELDS).
   */
  async setOverride(prodNo, patch, who) {
    const now = new Date().toISOString();
    const stamped = { ...patch, updatedAt: now, ...(who !== undefined ? { touchedBy: who ?? null, touchedAt: now } : {}) };
    if (this.mode === 'local') {
      const all = lsGet('jobOverrides', {});
      all[prodNo] = { ...(all[prodNo] ?? {}), ...stamped };
      if (isEmptyOverride(all[prodNo])) delete all[prodNo];
      lsSet('jobOverrides', all);
      return;
    }
    const { doc, setDoc, deleteDoc, getDoc } = this._fs;
    const ref = doc(this._db, 'jobOverrides', prodNo);
    await setDoc(ref, stamped, { merge: true });
    if (isEmptyOverride((await getDoc(ref)).data() ?? {})) await deleteDoc(ref);
  },

  // ---- per-item overrides -------------------------------------------------
  // Keyed on Inventory ID — the ERP's stable product identity. A production
  // number identifies one order; an Inventory ID identifies the product, so a
  // decision latched here applies to every future order for it.

  async loadItemOverrides() {
    if (this.mode === 'local') return lsGet('itemOverrides', {});
    const { collection } = this._fs;
    const snap = await this._read(collection(this._db, 'itemOverrides'));
    const out = {};
    snap.forEach((d) => { const v = d.data(); out[v.inventoryId ?? d.id] = v; });
    return out;
  },

  async setItemOverride(inventoryId, patch) {
    // Firestore doc ids cannot contain '/', and item codes do (SRLZZZXX04/24).
    const id = encodeItemId(inventoryId);
    const stamped = { ...patch, inventoryId, updatedAt: new Date().toISOString() };
    if (this.mode === 'local') {
      const all = lsGet('itemOverrides', {});
      all[inventoryId] = { ...(all[inventoryId] ?? {}), ...stamped };
      const o = all[inventoryId];
      for (const k of ['label', 'displayCode', 'partOrder']) if (o[k] === null) delete o[k];
      if (!o.label && !o.displayCode && o.partOrder == null) delete all[inventoryId];
      lsSet('itemOverrides', all);
      return;
    }
    const { doc, setDoc, deleteDoc, getDoc } = this._fs;
    const ref = doc(this._db, 'itemOverrides', id);
    await setDoc(ref, stamped, { merge: true });
    const after = (await getDoc(ref)).data() ?? {};
    if (!after.label && !after.displayCode && after.partOrder == null) await deleteDoc(ref);
  },

  // ---- production packages --------------------------------------------------
  //
  // Which folders and documents a job's paperwork comes from: one document per
  // item code (`item~CODE`) or per job (`job~PRODNO`), see packages.js. Paths
  // are relative to the Stella Systems folder, never a PC's full path.

  async loadPackages() {
    if (this.mode === 'local') return lsGet('packages', {});
    const { collection } = this._fs;
    const snap = await this._read(collection(this._db, 'packages'));
    const out = {};
    snap.forEach((d) => { out[d.id] = d.data(); });
    return out;
  },

  /**
   * One package, or the library, as the server has it; null if there is none.
   * Read as every other document is (`_read`): a change is made to what this
   * returns and the whole of it written back, so it is never the SDK's cache.
   */
  async loadPackage(key) {
    if (this.mode === 'local') return lsGet('packages', {})[key] ?? null;
    const { doc } = this._fs;
    const snap = await this._read(doc(this._db, 'packages', key), 'doc');
    return snap.exists() ? snap.data() : null;
  },

  /**
   * Write a package, or remove it (`data` null). The same collection holds the
   * standard items library, under `library`; which document is empty enough
   * to remove is packages.js's call, not this one's.
   */
  async savePackage(key, data) {
    const stamped = data ? { ...data, updatedAt: new Date().toISOString() } : null;
    if (this.mode === 'local') {
      const all = lsGet('packages', {});
      if (stamped) all[key] = stamped; else delete all[key];
      lsSet('packages', all);
      return;
    }
    const { doc, setDoc, deleteDoc } = this._fs;
    const ref = doc(this._db, 'packages', key);
    if (stamped) await setDoc(ref, stamped); else await deleteDoc(ref);
  },

  // ---- settings -----------------------------------------------------------

  async loadSettings() {
    if (this.mode === 'local') return this.boardSettings(lsGet('settings', {}));
    const { doc } = this._fs;
    const snap = await this._read(doc(this._db, 'settings', 'board'), 'doc');
    return this.boardSettings(snap.exists() ? snap.data() : {});
  },

  /**
   * The board settings as the board uses them: the stored document over the
   * defaults, and the builders from the private file when the document has
   * none. One place, for the read and for the listener's first answer alike.
   */
  async boardSettings(stored) {
    const out = { horizonWeeks: 12, maxStock: null, autoFit: true, builders: [], ...(stored ?? {}) };
    if (!Array.isArray(out.builders) || !out.builders.length) out.builders = await this._buildersFile();
    return out;
  },

  /**
   * The builders from a private file, for a board whose settings have none.
   *
   * The settings document is where they live. This is for a LOCAL board — a
   * scratch copy served for testing, where every fresh port starts with empty
   * storage — and, like the code seed, the file is gitignored and never
   * deployed. [] when absent. Never throws.
   */
  async _buildersFile() {
    try {
      const r = await fetch(new URL('../data/builders.json', import.meta.url), { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j) ? j : (Array.isArray(j?.builders) ? j.builders : []);
    } catch { return []; }
  },

  /**
   * Who sees the manager view. Kept in Firestore rather than in the shipped
   * JavaScript, which anyone can fetch — see auth.js.
   *
   * In local mode there is no Firestore and no sign-in either, so the single
   * user of a local board is the manager by definition.
   *
   * THREE ANSWERS, AND NO ONE OF THEM IS TAKEN FOR ANOTHER:
   *
   *   the lists          the server has the document, and this is it
   *   `missing: true`    the server has none, and five empty lists
   *   it throws          refused, or not answered: nothing is known
   *
   * A read that failed used to come back as five empty lists, which is what a
   * board nobody has been given looks like. The board offered itself to whoever
   * was on no list, and the Accounts panel offered to save from nothing.
   */
  /**
   * The lists, each time they change: Hubinator writes them, and a page open
   * at the time is drawn for the role it had (sign-in.js, watchRole). `null`
   * while there is no document.
   */
  watchAccess(cb, onError) {
    return this._watch(
      (fs, db) => fs.doc(db, 'settings', 'access'),
      (snap) => cb(snap.exists() ? markLoaded(normaliseAccess(snap.data())) : null),
      onError);
  },

  async loadAccess() {
    if (this.mode === 'local') return { managers: ['*'], engineers: [], floor: [], masters: [], testers: [] };
    const { doc } = this._fs;
    const snap = await this._read(doc(this._db, 'settings', 'access'), 'doc');
    if (snap.exists()) return markLoaded(normaliseAccess(snap.data()));
    // Test mode reads from the SDK's cache once it has written, and a document
    // the cache does not hold is not one the server does not have.
    if (snap.metadata?.fromCache) throw Object.assign(new Error('the access lists are not in the cache'), { code: 'unavailable' });
    return { ...normaliseAccess({}), missing: true };
  },

  // ---- parts ---------------------------------------------------------------
  //
  // ONE DOCUMENT FOR THE WHOLE LIST. Search runs in the browser, so every page
  // load needs every part anyway, and ~1,900 documents would be ~1,900 reads
  // for no benefit. The list is a JSON string inside the document rather than
  // an array of maps: it is under the size limit by a wide margin and it keeps
  // Firestore from indexing two thousand entries nobody will ever query.
  //
  // `previous` is a copy of `current` from before the last import — the one
  // step of undo for a wrong file.

  /**
   * The list, or null when none has been loaded yet. A read that fails
   * throws: both were once the same null, and a refused read put "No part
   * list loaded yet" over the copy saved on the device.
   */
  async loadParts() {
    if (this.mode === 'local') return lsGet('parts', null);
    const { doc } = this._fs;
    const snap = await this._read(doc(this._db, 'parts', 'current'), 'doc');
    return snap.exists() ? snap.data() : null;
  },

  async saveParts(record) {
    // The same list again - an import tried a second time, or a file dropped
    // twice - is not a step, and must not take the place of the one before it.
    const stepsFrom = (cur) => cur.partsJson !== record.partsJson;
    if (this.mode === 'local') {
      const cur = lsGet('parts', null);
      if (cur && stepsFrom(cur)) lsSet('partsPrevious', cur);
      lsSet('parts', record);
      return;
    }
    const { doc, getDoc, setDoc } = this._fs;
    const cur = await getDoc(doc(this._db, 'parts', 'current'));
    if (cur.exists() && stepsFrom(cur.data())) await setDoc(doc(this._db, 'parts', 'previous'), cur.data());
    await setDoc(doc(this._db, 'parts', 'current'), record);
  },

  // The materials manifest: which parts are materials, and of what kind.
  // Loaded from the material ordering app's sheet; one document, like the
  // list, under the same rule (everyone reads, the manager writes). Null when
  // there is none; a read that fails throws, as the list's does.
  async loadMaterials() {
    if (this.mode === 'local') return lsGet('materials', null);
    const { doc } = this._fs;
    const snap = await this._read(doc(this._db, 'parts', 'materials'), 'doc');
    return snap.exists() ? snap.data() : null;
  },

  async saveMaterials(record) {
    if (this.mode === 'local') { lsSet('materials', record); return; }
    const { doc, setDoc } = this._fs;
    await setDoc(doc(this._db, 'parts', 'materials'), record);
  },

  async loadPartOverrides() {
    if (this.mode === 'local') return lsGet('partOverrides', {});
    const { collection } = this._fs;
    const snap = await this._read(collection(this._db, 'partOverrides'));
    const out = {};
    snap.forEach((d) => { out[d.id] = d.data(); });
    return out;
  },

  async setPartOverride(key, data) {
    if (this.mode === 'local') {
      const all = lsGet('partOverrides', {});
      all[key] = { ...(all[key] ?? {}), ...data };
      lsSet('partOverrides', all);
      return;
    }
    const { doc, setDoc } = this._fs;
    await setDoc(doc(this._db, 'partOverrides', key), data, { merge: true });
  },

  /**
   * Several at once — an import touches every live correction. Up to
   * BATCH_SIZE go as one request, so they are all saved or none is.
   * @param {(done: number, total: number) => void} [onBatch]  as each request is answered
   */
  async setPartOverrides(map, onBatch) {
    const entries = Object.entries(map ?? {});
    if (this.mode === 'local') {
      for (const [key, data] of entries) await this.setPartOverride(key, data);
      return;
    }
    const { doc, writeBatch } = this._fs;
    let done = 0;
    for (const part of chunk(entries, BATCH_SIZE)) {
      const batch = writeBatch(this._db);
      for (const [key, data] of part) batch.set(doc(this._db, 'partOverrides', key), data, { merge: true });
      await batch.commit();
      done += part.length;
      onBatch?.(done, entries.length);
    }
  },

  async deletePartOverride(key) {
    if (this.mode === 'local') {
      const all = lsGet('partOverrides', {});
      delete all[key];
      lsSet('partOverrides', all);
      return;
    }
    const { doc, deleteDoc } = this._fs;
    await deleteDoc(doc(this._db, 'partOverrides', key));
  },

  /** What each import did. Append-only, like the board's own import history. */
  async logPartImport(summary) {
    if (this.mode === 'local') {
      const all = lsGet('partImports', []);
      all.unshift(summary);
      lsSet('partImports', all.slice(0, 50));
      return;
    }
    const { collection, addDoc } = this._fs;
    await addDoc(collection(this._db, 'partImports'), summary);
  },

  // ---- the activity log -------------------------------------------------
  //
  // Who did what on the board: one document per edit, append-only, like the
  // import logs. Written after the edit it describes and never read back to
  // decide anything, so a failed log write is a warning, not a lost edit.

  async logActivity(entry) {
    if (this.mode === 'local') {
      const all = lsGet('activity', []);
      all.unshift(entry);
      lsSet('activity', all.slice(0, 300));
      return;
    }
    const { collection, addDoc } = this._fs;
    await addDoc(collection(this._db, 'activity'), entry);
  },

  /**
   * Many entries at once. An import can move the dates of hundreds of jobs,
   * and a write per job would be hundreds of round trips after every apply.
   * Firestore takes up to 500 writes in one batch, so the list goes in
   * BATCH_SIZE at a time, each batch one request. Append-only, like
   * logActivity. Resolves to the number written.
   */
  async logActivityBatch(entries) {
    const list = (entries ?? []).filter(Boolean);
    if (!list.length) return 0;
    if (this.mode === 'local') {
      // Newest first, as logActivity keeps the list: the batch is in the order
      // it was made, so it is reversed on the way in.
      lsSet('activity', [...list].reverse().concat(lsGet('activity', [])).slice(0, 300));
      return list.length;
    }
    const { collection, doc, writeBatch } = this._fs;
    const col = collection(this._db, 'activity');
    for (const part of chunk(list, BATCH_SIZE)) {
      const batch = writeBatch(this._db);
      for (const entry of part) batch.set(doc(col), entry);
      await batch.commit();
    }
    return list.length;
  },

  /**
   * Every entry about one job, newest first: what was logged against its
   * production number, and what was logged against its item code for every
   * job on it (a part mark, an item label), which carries no production
   * number.
   *
   * Two equality reads rather than one read with an order clause. A `where`
   * on one field with an `orderBy` on another needs a composite index made
   * in the console, and a job's history is a few dozen lines at most, so it
   * is sorted here instead.
   */
  async listActivityFor(prodNo, inventoryId = null) {
    const mine = aboutJob(prodNo, inventoryId);
    if (this.mode === 'local') return lsGet('activity', []).filter(mine).sort(newestFirst);
    const { collection, getDocs, query, where } = this._fs;
    const col = collection(this._db, 'activity');
    const reads = [getDocs(query(col, where('prodNo', '==', prodNo)))];
    if (inventoryId) {
      reads.push(getDocs(query(col, where('inventoryId', '==', inventoryId), where('prodNo', '==', null))));
    }
    const seen = new Map();
    for (const snap of await Promise.all(reads)) {
      snap.forEach((d) => { seen.set(d.id, { _id: d.id, ...d.data() }); });
    }
    return [...seen.values()].filter(mine).sort(newestFirst);
  },

  /**
   * Which of these production numbers already have an added line. One read
   * per number, after an apply and never holding it up: a handful on a normal
   * import. Two equality filters, the shape listActivityFor already uses, so
   * no composite index.
   * @returns {Promise<Set<string>>}
   */
  async addedAlready(prodNos) {
    const want = [...new Set((prodNos ?? []).filter(Boolean))];
    if (!want.length) return new Set();
    if (this.mode === 'local') {
      return new Set(lsGet('activity', []).filter((e) => e?.added === true && want.includes(e.prodNo))
        .map((e) => e.prodNo));
    }
    const { collection, getDocs, query, where, limit } = this._fs;
    const col = collection(this._db, 'activity');
    const have = new Set();
    for (const part of chunk(want, 20)) {
      const snaps = await Promise.all(part.map((p) =>
        getDocs(query(col, where('prodNo', '==', p), where('added', '==', true), limit(1)))));
      snaps.forEach((snap, i) => { if (!snap.empty) have.add(part[i]); });
    }
    return have;
  },

  /** Newest first. */
  async listActivity(max = 100) {
    if (this.mode === 'local') return lsGet('activity', []).slice(0, max);
    const { collection, getDocs, query, orderBy, limit } = this._fs;
    const snap = await getDocs(query(collection(this._db, 'activity'), orderBy('at', 'desc'), limit(max)));
    return snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
  },

  /**
   * A page of the log, newest first, with the cursor for the page after it -
   * null once nothing older remains. `after` is opaque: hand back what the
   * previous page returned as `next`.
   * @returns {Promise<{rows: Object[], next: any}>}
   */
  async listActivityPage({ max = 50, after = null } = {}) {
    if (this.mode === 'local') {
      const all = lsGet('activity', []);
      const from = Number(after) || 0;
      const rows = all.slice(from, from + max);
      return { rows, next: from + rows.length < all.length ? from + rows.length : null };
    }
    const { collection, getDocs, query, orderBy, limit, startAfter } = this._fs;
    const parts = [collection(this._db, 'activity'), orderBy('at', 'desc')];
    if (after) parts.push(startAfter(after));
    const snap = await getDocs(query(...parts, limit(max)));
    const rows = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    return { rows, next: snap.docs.length === max ? snap.docs[snap.docs.length - 1] : null };
  },

  /**
   * Claim the board: the first manager list, where the server has no lists at
   * all. Asked again here, at the moment of writing, so a claim can only ever
   * make the document and never write over one. The rules decide the rest: they
   * let anybody signed in make it, and nobody but a master change it.
   */
  async saveManagers(emails) {
    if (!emails?.length) throw Object.assign(new Error('an empty manager list'), { code: 'no-manager' });
    if (this.mode === 'local') return;
    if (!(await this.loadAccess()).missing) throw Object.assign(new Error('there is an access list already'), { code: 'permission-denied' });
    const { doc, setDoc } = this._fs;
    await setDoc(doc(this._db, 'settings', 'access'),
      { managers: emails, updatedAt: new Date().toISOString() }, { merge: true });
  },

  /**
   * All five lists, from the Settings cog. The rules let only a master write
   * this. Lists that did not come from the server are not written over what it
   * has (see access.js), and neither are lists with no manager in them: the
   * rules would let that through, and nobody could edit the board after it.
   */
  async saveAccess(lists) {
    if (!isLoaded(lists)) throw Object.assign(new Error('access lists that were not loaded'), { code: 'not-loaded' });
    const { managers, engineers, floor, masters, testers } = lists;
    if (!managers.length) throw Object.assign(new Error('access lists with no manager'), { code: 'no-manager' });
    if (this.mode === 'local') return;
    const { doc, setDoc } = this._fs;
    await setDoc(doc(this._db, 'settings', 'access'),
      { managers, engineers, floor, masters, testers, updatedAt: new Date().toISOString() }, { merge: true });
  },

  /**
   * What is known about each item code — description and hulls — accumulated
   * across imports so the code sheet is a total product list rather than a
   * view of this month's orders. See `mergeItemFacts`.
   */
  async loadItemFacts() {
    if (this.mode === 'local') return lsGet('itemFacts', {});
    try {
      const { doc } = this._fs;
      const snap = await this._read(doc(this._db, 'settings', 'items'), 'doc');
      return snap.exists() ? (snap.data()?.items ?? {}) : {};
    } catch (e) { console.warn('[items]', e.message); return {}; }
  },

  async saveItemFacts(items) {
    if (this.mode === 'local') { lsSet('itemFacts', items); return; }
    const { doc, setDoc } = this._fs;
    await setDoc(doc(this._db, 'settings', 'items'),
      { items, updatedAt: new Date().toISOString() }, { merge: true });
  },

  /** The davit reference list. See davits.js — it accumulates, it is not a view. */
  async loadDavits() {
    if (this.mode === 'local') return lsGet('davits', []);
    try {
      const { doc } = this._fs;
      const snap = await this._read(doc(this._db, 'settings', 'davits'), 'doc');
      const list = snap.exists() ? snap.data()?.boats : null;
      return Array.isArray(list) ? list : [];
    } catch (e) { console.warn('[davits]', e.message); return []; }
  },

  async saveDavits(boats) {
    if (this.mode === 'local') { lsSet('davits', boats); return; }
    const { doc, setDoc } = this._fs;
    await setDoc(doc(this._db, 'settings', 'davits'),
      { boats, updatedAt: new Date().toISOString() }, { merge: true });
  },

  async saveSettings(patch) {
    if (this.mode === 'local') { lsSet('settings', { ...lsGet('settings', {}), ...patch }); return; }
    const { doc, setDoc } = this._fs;
    await setDoc(doc(this._db, 'settings', 'board'), patch, { merge: true });
  },

  // ---- live sync ----------------------------------------------------------
  //
  // Everything shared is watched, so a change made on one device shows on the
  // others without a reload. Local mode has nothing to watch and no second
  // device to tell, so every subscribe is a no-op that returns a no-op.
  //
  // Each callback receives `(value, meta)`. `meta.fromSelf` is true while the
  // snapshot is this client's own write that the server has not acknowledged
  // yet — Firestore fires those immediately for latency compensation. Callers
  // use it to avoid redrawing a control out from under the person using it.
  //
  // THE FIRST ANSWER IS THE LOAD. `meta.confirmed` is true on exactly one
  // call: the first the server has answered (`fromCache` false). The board
  // waits for that on every source instead of reading each one first and then
  // watching it, which downloaded everything twice: the memory cache drops a
  // document as soon as the read that fetched it is done, so the listener
  // opened after it fetched it all again.
  //
  // To see that answer the listener asks for metadata changes: a snapshot
  // the SDK raised from its cache (it gives up on the server after ten
  // seconds and answers from what it has, which with a memory cache is
  // nothing) is followed by the same data confirmed, and only a metadata
  // change says so. Every other metadata-only snapshot - an own write
  // acknowledged, the SDK going offline and back - changes no data and is not
  // passed on, so the callbacks run as often as they always did.

  _watch(build, shape, onError) {
    if (this.mode !== 'firestore') return () => {};
    const { onSnapshot } = this._fs;
    let delivered = false;
    let confirmed = false;
    let last;
    const id = Symbol('listener');
    const stop = onSnapshot(build(this._fs, this._db), { includeMetadataChanges: true }, (snap) => {
      const fromCache = Boolean(snap.metadata?.fromCache);
      const first = !fromCache && !confirmed;
      if (first) confirmed = true;
      // Once it has answered, whether it still does (onLink).
      if (confirmed) this._setLink(id, { lost: fromCache, unsent: Boolean(snap.metadata?.hasPendingWrites) });
      const body = typeof snap.docChanges === 'function' ? null : JSON.stringify(snap.exists?.() ? snap.data() : null);
      const changed = body === null ? snap.docChanges().length > 0 : body !== last;
      last = body;
      if (delivered && !first && !changed) return;
      delivered = true;
      shape(snap, { fromSelf: Boolean(snap.metadata?.hasPendingWrites), fromCache, confirmed: first });
    }, (err) => {
      console.warn('[live]', err.message);
      // The server ended it; the SDK does not open it again.
      if (confirmed) this._setLink(id, { lost: false, unsent: false, stopped: true });
      onError?.(err);
    });
    return () => { this._links.delete(id); stop?.(); };
  },

  // ---- the connection ------------------------------------------------------
  //
  // What the live listeners know of it: `lost` while any is answering from the
  // cache, `unsent` while an edit made here waits to reach the server,
  // `stopped` once the server has ended one. In test mode the network is
  // switched off on purpose, so there is nothing to say.

  _links: new Map(),
  _linkSubs: new Set(),

  _setLink(id, patch) {
    const was = this._links.get(id) ?? { lost: false, unsent: false, stopped: false };
    const now = { ...was, ...patch };
    this._links.set(id, now);
    if (was.lost === now.lost && was.unsent === now.unsent && was.stopped === now.stopped) return;
    const link = this.link();
    for (const cb of this._linkSubs) cb(link);
  },

  link() {
    const all = this._testing ? [] : [...this._links.values()];
    return { lost: all.some((l) => l.lost), unsent: all.some((l) => l.unsent), stopped: all.some((l) => l.stopped) };
  },

  /** Called with the connection now, and each time it changes. */
  onLink(cb) {
    this._linkSubs.add(cb);
    cb(this.link());
    return () => this._linkSubs.delete(cb);
  },

  /**
   * One read, as the server answers it.
   *
   * getDoc and getDocs settle for the SDK's cache once it has decided it is
   * offline - ten seconds without an answer - and with a memory cache that is
   * an empty collection or a refused document: a board with no overrides, an
   * access list that reads as nobody, the floor told nothing is published.
   * So the read is a listener that takes the first snapshot the server
   * answered and stops. A listener already on the same target answers it at
   * once, from the one download.
   *
   * In test mode the wrapped namespace's own reads are kept: they hold their
   * target and fall back to the cache after the first change (test-mode.js),
   * where a server answer would never come.
   */
  _read(target, kind = 'docs') {
    const fs = this._fs;
    if (this._testing || !('onSnapshot' in fs)) return kind === 'doc' ? fs.getDoc(target) : fs.getDocs(target);
    return new Promise((resolve, reject) => {
      let stop = null;
      let done = false;
      stop = fs.onSnapshot(target, { includeMetadataChanges: true }, (snap) => {
        if (done || snap.metadata?.fromCache) return;
        done = true;
        resolve(snap);
        stop?.();
      }, (e) => { done = true; reject(e); });
      if (done) stop();
    });
  },

  watchOverrides(cb, onError) {
    return this._watch(
      (fs, db) => fs.collection(db, 'jobOverrides'),
      (snap, meta) => {
        const out = {};
        snap.forEach((d) => { out[d.id] = d.data(); });
        cb(out, meta);
      }, onError);
  },

  watchItemOverrides(cb, onError) {
    return this._watch(
      (fs, db) => fs.collection(db, 'itemOverrides'),
      (snap, meta) => {
        const out = {};
        snap.forEach((d) => { const v = d.data(); out[v.inventoryId ?? d.id] = v; });
        cb(out, meta);
      }, onError);
  },

  /**
   * Vessel codes, merged over the shipped seed exactly as loadCodes does —
   * otherwise a live update would drop the seed-only fields and a code could
   * lose its `boat` mid-session.
   */
  // WRITES NOBODY ASKED FOR WAIT FOR THE ROLE. The codes listener tidies the
  // stored codes on its first answer (seeding a fresh environment, rewriting
  // the old model key), and the pages ask for it before the access lists have
  // said who this is. Only a manager may write the codes, so that waits until
  // the page has said whether this is a manager's browser: setWriter. Nobody
  // else's browser tries, and so nobody else is refused.
  _writer: null,
  _chores: [],

  /** Whether this browser may make the writes nobody asked for: a manager's (not a tester's). */
  setWriter(yes) {
    this._writer = Boolean(yes);
    const parked = this._chores.splice(0);
    if (this._writer) for (const f of parked) f();
  },

  _chore(f) {
    if (this._writer) f();
    else if (this._writer === null) this._chores.push(f);
  },

  watchCodes(cb, onError) {
    if (this.mode !== 'firestore') return () => {};
    let seed = null;
    const merge = (stored) => {
      const out = { ...(seed ?? {}) };
      for (const [code, entry] of Object.entries(stored)) {
        out[code] = { ...((seed ?? {})[code] ?? {}), ...entry };
      }
      return out;
    };
    // The seed is not deployed, so a bare fetch of it rejects on the live site
    // and every snapshot below would wait on that rejection for ever: live
    // code updates never arrived. _seed() never throws, and reads {} when the
    // file is absent, which is the whole of what a deployed board has.
    const start = this._seed().then((j) => { seed = upgradeCodeMap(j).map; });

    return this._watch(
      (fs, db) => fs.collection(db, 'vesselCodes'),
      async (snap, meta) => {
        await start;
        const stored = {};
        snap.forEach((d) => { stored[codeFromDocId(d.id)] = d.data(); });
        const { map, upgraded } = upgradeCodeMap(stored);
        // The server's first answer is the board's load of the codes, so it
        // does what loadCodes does with one: seed a fresh environment, and
        // rewrite records still on the old model key (see loadCodes).
        // A manager's writes: they wait until the page has said whose browser this is.
        if (meta?.confirmed && !Object.keys(stored).length && Object.keys(seed ?? {}).length) {
          const { doc, setDoc } = this._fs;
          const all = seed;
          this._chore(() => Promise.all(Object.entries(all).map(([code, entry]) =>
            setDoc(doc(this._db, 'vesselCodes', codeDocId(code)), entry))).catch((e) => console.warn('[codes] seed', e.message)));
        } else if (meta?.confirmed && upgraded.length) {
          this._chore(() => this._rewriteLegacyCodes(map, upgraded));
        }
        cb(merge(map), meta);
      }, onError);
  },

  watchSettings(cb, onError) {
    return this._watch(
      (fs, db) => fs.doc(db, 'settings', 'board'),
      (snap, meta) => cb(snap.exists() ? snap.data() : {}, meta), onError);
  },

  /** The newest published board, as it is published. */
  watchLatestImport(cb, onError) {
    return this._watch(
      (fs, db) => fs.query(fs.collection(db, 'imports'),
        fs.orderBy('retrievedAt', 'desc'), fs.limit(1)),
      (snap, meta) => cb(snap.empty ? null : { _id: snap.docs[0].id, ...snap.docs[0].data() }, meta), onError);
  },

  // ---- the floor's board ---------------------------------------------------
  //
  // settings/floor: what a floor screen shows, kept up by the managers' boards
  // (floor-board.js). Read by anyone listed, written by a manager, under the
  // rule the other settings documents have.

  async loadFloorBoard() {
    if (this.mode === 'local') return lsGet('floorBoard', null);
    const { doc } = this._fs;
    const snap = await this._read(doc(this._db, 'settings', 'floor'), 'doc');
    return snap.exists() ? snap.data() : null;
  },

  async saveFloorBoard(rec) {
    const stamped = { ...rec, updatedAt: new Date().toISOString() };
    if (this.mode === 'local') { lsSet('floorBoard', stamped); return; }
    const { doc, setDoc } = this._fs;
    await setDoc(doc(this._db, 'settings', 'floor'), stamped);
  },

  watchFloorBoard(cb, onError) {
    return this._watch(
      (fs, db) => fs.doc(db, 'settings', 'floor'),
      (snap, meta) => cb(snap.exists() ? snap.data() : null, meta), onError);
  },

  // ---- import history -----------------------------------------------------
  // Audit trail and Gantt actuals later. Note: this does NOT buy exclusion of
  // completed jobs — the ERP saved filter drops Completed/Canceled/Closed
  // before the export is written, so they never arrive in the first place.

  async recordImport(rec) {
    if (this.mode === 'local') {
      const all = lsGet('imports', []);
      all.unshift(rec);
      lsSet('imports', all.slice(0, 20));
      return;
    }
    const { collection, addDoc } = this._fs;
    await addDoc(collection(this._db, 'imports'), rec);
  },

  /**
   * The most recent board, for the floor view.
   *
   * Floor devices never upload — they read what the manager last published.
   * That is why the import record carries the full job list and not a summary.
   */
  async latestBoard() {
    if (this.mode === 'local') return lsGet('imports', [])[0] ?? null;
    const { collection, query, orderBy, limit } = this._fs;
    const snap = await this._read(query(collection(this._db, 'imports'), orderBy('retrievedAt', 'desc'), limit(1)));
    return snap.empty ? null : { _id: snap.docs[0].id, ...snap.docs[0].data() };
  },

  async listImports(max = 20) {
    if (this.mode === 'local') return lsGet('imports', []).slice(0, max);
    const { collection, getDocs, query, orderBy, limit } = this._fs;
    const snap = await getDocs(query(collection(this._db, 'imports'), orderBy('retrievedAt', 'desc'), limit(max)));
    return snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
  },

  /** Keep the last board so a reload does not need a re-upload. */
  /**
   * The local copy goes through the SAME serialiser as the Firestore one.
   *
   * It used to go through plain JSON.stringify, which writes a Date as UTC — so
   * a local-midnight 12 Nov was cached as "2026-11-11T14:00:00Z" and read back
   * as the 11th. A fresh upload was right because it still held real Date
   * objects; every reload after it was a day early. Brisbane is UTC+10, the
   * direction that loses a day.
   *
   * One serialiser, one place where dates are handled, both destinations.
   */
  cacheRows(rows, source) { lsSet('lastRows', { rowsJson: packRows(rows), source }); },

  cachedRows() {
    const v = lsGet('lastRows', null);
    if (!v) return null;
    // Entries written before the fix hold `rows` with UTC timestamps. toDateOnly
    // reads those back to the right local day, so they still load correctly and
    // are rewritten in the new shape on the next cacheRows.
    return { rows: v.rowsJson ? unpackRows(v.rowsJson) : v.rows, source: v.source };
  },
  clearCache() { lsSet('lastRows', null); },
};
