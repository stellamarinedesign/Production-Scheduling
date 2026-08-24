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
//   imports/{importId}        { retrievedAt, sourceId, sourceLabel,
//                               horizonWeeks, maxStock, jobs[] }
//   settings/board            { horizonWeeks, maxStock, autoFit }

import { getFirebase, failureReason, isConfigured } from './firebase.js';

const LS_PREFIX = 'stella.board.';
const lsGet = (k, fallback) => {
  try { const v = localStorage.getItem(LS_PREFIX + k); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
};
/** Firestore doc ids cannot contain '/'; item codes like SRLRIV505/24 can. */
const encodeItemId = (id) => String(id).replace(/\//g, '__');

const lsSet = (k, v) => { try { localStorage.setItem(LS_PREFIX + k, JSON.stringify(v)); } catch {} };

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
  async setCompleted(prodNos, done, who) {
    const patch = done
      ? { completed: true, completedAt: new Date().toISOString(), completedBy: who ?? null }
      : { completed: false, completedAt: null, completedBy: null };
    for (const prodNo of prodNos) await this.setOverride(prodNo, patch);
  },

  async setOverride(prodNo, patch) {
    const stamped = { ...patch, updatedAt: new Date().toISOString() };
    if (this.mode === 'local') {
      const all = lsGet('jobOverrides', {});
      all[prodNo] = { ...(all[prodNo] ?? {}), ...stamped };
      // Drop the record entirely once nothing meaningful is left on it.
      const o = all[prodNo];
      if (!o.hidden && !o.labelOverride && !o.completed) delete all[prodNo];
      lsSet('jobOverrides', all);
      return;
    }
    const { doc, setDoc, deleteDoc, getDoc } = this._fs;
    const ref = doc(this._db, 'jobOverrides', prodNo);
    await setDoc(ref, stamped, { merge: true });
    const after = (await getDoc(ref)).data() ?? {};
    if (!after.hidden && !after.labelOverride && !after.completed) await deleteDoc(ref);
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
  cacheRows(rows, source) { lsSet('lastRows', { rows, source }); },
  cachedRows() { return lsGet('lastRows', null); },
  clearCache() { lsSet('lastRows', null); },
};
