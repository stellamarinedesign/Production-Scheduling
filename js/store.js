// store.js — persistence for manager edits, vessel codes and import history.
//
// TWO BACKENDS, ONE INTERFACE.
//
// Firestore is the destination, but there is no Firebase project for this app
// yet, and the board has to be usable and testable before one exists. So the
// store falls back to localStorage whenever Firebase is unconfigured or
// unreachable, and the UI says plainly which mode it is in. A board that
// silently stops persisting is worse than one that says it is local-only.
//
// Collections (STELLA_PRODUCTION_BOARD_CONTEXT.md §6, as amended):
//   vesselCodes/{stellaCode}  { riviera[], hull_prefix[], items[], display, _confirmed }
//   jobOverrides/{prodNo}     { hidden, hiddenReason, labelOverride, updatedAt }
//   imports/{importId}        { retrievedAt, sourceId, sourceLabel,
//                               horizonWeeks, maxStock, jobs[] }
//   settings/board            { horizonWeeks, maxStock, autoFit }

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

// ---------------------------------------------------------------------------
// FIREBASE CONFIG — paste from Firebase Console → Project settings → Your apps.
// Leaving this as-is keeps the app in local-only mode, which works fine for one
// manager on one machine. Fill it in when the project exists.
// ---------------------------------------------------------------------------
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

// APP CHECK — reCAPTCHA v3, as per the Material Ordering app. This app has no
// per-user login, so App Check is the real gate in front of Firestore, not the
// rules. Register at Firebase Console → App Check → Apps → reCAPTCHA v3.
export const APPCHECK_SITE_KEY = '';

const LS_PREFIX = 'stella.board.';
const lsGet = (k, fallback) => {
  try { const v = localStorage.getItem(LS_PREFIX + k); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
};
const lsSet = (k, v) => { try { localStorage.setItem(LS_PREFIX + k, JSON.stringify(v)); } catch {} };

export const Store = {
  mode: 'local',          // 'firestore' | 'local'
  reason: '',             // why local, when local
  _db: null,
  _fs: null,              // firestore function namespace

  async init() {
    if (!firebaseConfig.projectId || !firebaseConfig.apiKey) {
      this.mode = 'local';
      this.reason = 'Firebase not configured — edits are saved on this device only.';
      return this.mode;
    }
    try {
      const { initializeApp } = await import(`${SDK}/firebase-app.js`);
      const fs = await import(`${SDK}/firebase-firestore.js`);
      const app = initializeApp(firebaseConfig);

      if (APPCHECK_SITE_KEY) {
        try {
          const ac = await import(`${SDK}/firebase-app-check.js`);
          ac.initializeAppCheck(app, {
            provider: new ac.ReCaptchaV3Provider(APPCHECK_SITE_KEY),
            isTokenAutoRefreshEnabled: true,
          });
        } catch (e) {
          console.warn('[AppCheck] activation failed — continuing without it:', e.message);
        }
      }

      this._db = fs.getFirestore(app);
      this._fs = fs;
      // Prove the connection rather than assume it: an unreachable project
      // should drop to local now, not on the manager's first edit.
      await fs.getDoc(fs.doc(this._db, 'settings', 'board'));
      this.mode = 'firestore';
      this.reason = '';
    } catch (e) {
      this.mode = 'local';
      this.reason = `Firebase unreachable (${e.message}) — edits are saved on this device only.`;
      console.warn('[store]', this.reason);
    }
    return this.mode;
  },

  // ---- vessel codes -------------------------------------------------------

  /** The code map, seeded from the shipped JSON on first run. */
  async loadCodes() {
    const seed = await (await fetch(new URL('../data/vessel-codes.seed.json', import.meta.url))).json();

    if (this.mode === 'local') {
      const stored = lsGet('vesselCodes', null);
      if (!stored) { lsSet('vesselCodes', seed); return seed; }
      return { ...seed, ...stored };
    }

    const { collection, getDocs, doc, setDoc } = this._fs;
    const snap = await getDocs(collection(this._db, 'vesselCodes'));
    if (snap.empty) {
      await Promise.all(Object.entries(seed).map(([code, entry]) =>
        setDoc(doc(this._db, 'vesselCodes', code), entry)));
      return seed;
    }
    const out = {};
    snap.forEach((d) => { out[d.id] = d.data(); });
    return { ...seed, ...out };
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

  async setOverride(prodNo, patch) {
    const stamped = { ...patch, updatedAt: new Date().toISOString() };
    if (this.mode === 'local') {
      const all = lsGet('jobOverrides', {});
      all[prodNo] = { ...(all[prodNo] ?? {}), ...stamped };
      // Drop the record entirely once nothing meaningful is left on it.
      const o = all[prodNo];
      if (!o.hidden && !o.labelOverride) delete all[prodNo];
      lsSet('jobOverrides', all);
      return;
    }
    const { doc, setDoc, deleteDoc, getDoc } = this._fs;
    const ref = doc(this._db, 'jobOverrides', prodNo);
    await setDoc(ref, stamped, { merge: true });
    const after = (await getDoc(ref)).data() ?? {};
    if (!after.hidden && !after.labelOverride) await deleteDoc(ref);
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
