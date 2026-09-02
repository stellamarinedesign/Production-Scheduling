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
//   vesselCodes/{stellaCode}  { boat, riviera[], hull_prefix[], items[],
//                               display, _confirmed }
//   jobOverrides/{prodNo}     { hidden, hiddenReason, labelOverride, updatedAt,
//                               completed, completedAt, completedBy, progress }
//   itemOverrides/{itemId}    { inventoryId, label, displayCode, updatedAt }
//   imports/{importId}        { retrievedAt, sourceId, sourceLabel, uploadedBy,
//                               horizonWeeks, maxStock, jobs[], rowsJson }
//   settings/board            { horizonWeeks, maxStock, autoFit }

import { getFirebase, failureReason, isConfigured } from './firebase.js';
import { toDateOnly, toISO } from './transform.js';

const LS_PREFIX = 'stella.board.';
const lsGet = (k, fallback) => {
  try { const v = localStorage.getItem(LS_PREFIX + k); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
};
/** Firestore doc ids cannot contain '/'; item codes like SRLRIV505/24 can. */
const encodeItemId = (id) => String(id).replace(/\//g, '__');

const lsSet = (k, v) => { try { localStorage.setItem(LS_PREFIX + k, JSON.stringify(v)); } catch {} };

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
export const OVERRIDE_FIELDS = ['hidden', 'labelOverride', 'completed', 'status', 'progress'];

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

export const Store = {
  mode: 'local',          // 'firestore' | 'local'
  reason: '',             // why local, when local
  _db: null,
  _fs: null,              // firestore function namespace

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
    return this.mode;
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
    const seed = await (await fetch(new URL('../data/vessel-codes.seed.json', import.meta.url))).json();
    const merge = (stored) => {
      const out = { ...seed };
      for (const [code, entry] of Object.entries(stored ?? {})) {
        out[code] = { ...(seed[code] ?? {}), ...entry };
      }
      return out;
    };

    if (this.mode === 'local') {
      const stored = lsGet('vesselCodes', null);
      if (!stored) { lsSet('vesselCodes', seed); return seed; }
      return merge(stored);
    }

    const { collection, getDocs, doc, setDoc } = this._fs;
    const snap = await getDocs(collection(this._db, 'vesselCodes'));
    if (snap.empty) {
      await Promise.all(Object.entries(seed).map(([code, entry]) =>
        setDoc(doc(this._db, 'vesselCodes', code), entry)));
      return seed;
    }
    const stored = {};
    snap.forEach((d) => { stored[d.id] = d.data(); });
    return merge(stored);
  },

  async saveCode(code, patch) {
    if (this.mode === 'local') {
      const all = lsGet('vesselCodes', {});
      all[code] = { ...(all[code] ?? {}), ...patch };
      lsSet('vesselCodes', all);
      return;
    }
    const { doc, setDoc } = this._fs;
    await setDoc(doc(this._db, 'vesselCodes', code), patch, { merge: true });
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
    await deleteDoc(doc(this._db, 'vesselCodes', code));
  },

  /** Merge newly-derived codes in without ever overwriting a `display`. */
  async mergeCodes(map, addedCodes) {
    if (!addedCodes.length) return;
    if (this.mode === 'local') { lsSet('vesselCodes', map); return; }
    const { doc, setDoc } = this._fs;
    await Promise.all(addedCodes.map((c) => setDoc(doc(this._db, 'vesselCodes', c), map[c], { merge: true })));
  },

  // ---- per-job overrides --------------------------------------------------
  // Keyed on production number, which is stable and never reused, so a manual
  // decision survives the next export upload.

  async loadOverrides() {
    if (this.mode === 'local') return lsGet('jobOverrides', {});
    const { collection, getDocs } = this._fs;
    const snap = await getDocs(collection(this._db, 'jobOverrides'));
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
    for (const prodNo of prodNos) {
      const patch = done
        ? {
          completed: true,
          completedAt: new Date().toISOString(),
          completedBy: who ?? null,
          snapshot: snapshots[prodNo] ?? null,
        }
        : { completed: false, completedAt: null, completedBy: null, snapshot: null };
      await this.setOverride(prodNo, patch);
    }
  },

  async setOverride(prodNo, patch) {
    const stamped = { ...patch, updatedAt: new Date().toISOString() };
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
    const { collection, getDocs } = this._fs;
    const snap = await getDocs(collection(this._db, 'itemOverrides'));
    const out = {};
    snap.forEach((d) => { const v = d.data(); out[v.inventoryId ?? d.id] = v; });
    return out;
  },

  async setItemOverride(inventoryId, patch) {
    // Firestore doc ids cannot contain '/', and item codes do (SRLRIV505/24).
    const id = encodeItemId(inventoryId);
    const stamped = { ...patch, inventoryId, updatedAt: new Date().toISOString() };
    if (this.mode === 'local') {
      const all = lsGet('itemOverrides', {});
      all[inventoryId] = { ...(all[inventoryId] ?? {}), ...stamped };
      const o = all[inventoryId];
      if (!o.label && !o.displayCode) delete all[inventoryId];
      lsSet('itemOverrides', all);
      return;
    }
    const { doc, setDoc, deleteDoc, getDoc } = this._fs;
    const ref = doc(this._db, 'itemOverrides', id);
    await setDoc(ref, stamped, { merge: true });
    const after = (await getDoc(ref)).data() ?? {};
    if (!after.label && !after.displayCode) await deleteDoc(ref);
  },

  // ---- settings -----------------------------------------------------------

  async loadSettings() {
    const defaults = { horizonWeeks: 12, maxStock: null, autoFit: true };
    if (this.mode === 'local') return { ...defaults, ...lsGet('settings', {}) };
    const { doc, getDoc } = this._fs;
    const snap = await getDoc(doc(this._db, 'settings', 'board'));
    return { ...defaults, ...(snap.exists() ? snap.data() : {}) };
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

  _watch(build, shape) {
    if (this.mode !== 'firestore') return () => {};
    const { onSnapshot } = this._fs;
    return onSnapshot(build(this._fs, this._db), (snap) => {
      shape(snap, { fromSelf: snap.metadata.hasPendingWrites });
    }, (err) => console.warn('[live]', err.message));
  },

  watchOverrides(cb) {
    return this._watch(
      (fs, db) => fs.collection(db, 'jobOverrides'),
      (snap, meta) => {
        const out = {};
        snap.forEach((d) => { out[d.id] = d.data(); });
        cb(out, meta);
      });
  },

  watchItemOverrides(cb) {
    return this._watch(
      (fs, db) => fs.collection(db, 'itemOverrides'),
      (snap, meta) => {
        const out = {};
        snap.forEach((d) => { const v = d.data(); out[v.inventoryId ?? d.id] = v; });
        cb(out, meta);
      });
  },

  /**
   * Vessel codes, merged over the shipped seed exactly as loadCodes does —
   * otherwise a live update would drop the seed-only fields and a code could
   * lose its `boat` mid-session.
   */
  watchCodes(cb) {
    if (this.mode !== 'firestore') return () => {};
    let seed = null;
    const merge = (stored) => {
      const out = { ...(seed ?? {}) };
      for (const [code, entry] of Object.entries(stored)) {
        out[code] = { ...((seed ?? {})[code] ?? {}), ...entry };
      }
      return out;
    };
    const start = fetch(new URL('../data/vessel-codes.seed.json', import.meta.url))
      .then((r) => r.json()).then((j) => { seed = j; });

    return this._watch(
      (fs, db) => fs.collection(db, 'vesselCodes'),
      async (snap, meta) => {
        await start;
        const stored = {};
        snap.forEach((d) => { stored[d.id] = d.data(); });
        cb(merge(stored), meta);
      });
  },

  watchSettings(cb) {
    return this._watch(
      (fs, db) => fs.doc(db, 'settings', 'board'),
      (snap, meta) => cb(snap.exists() ? snap.data() : {}, meta));
  },

  /** The newest published board, as it is published. */
  watchLatestImport(cb) {
    return this._watch(
      (fs, db) => fs.query(fs.collection(db, 'imports'),
        fs.orderBy('retrievedAt', 'desc'), fs.limit(1)),
      (snap, meta) => cb(snap.empty ? null : { _id: snap.docs[0].id, ...snap.docs[0].data() }, meta));
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
    const { collection, getDocs, query, orderBy, limit } = this._fs;
    const snap = await getDocs(query(collection(this._db, 'imports'), orderBy('retrievedAt', 'desc'), limit(1)));
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
