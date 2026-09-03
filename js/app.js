// app.js — the manager view. Upload, review, edit, print.

import { xlsxAdapter } from './adapters/index.js';
import { buildBoard, byCategory, today, toAU, toDateOnly, jobTitle, CUSTOM_PREFIX,
         isEmptyCustomName, snapshotOf, isPrintable, retainedRows } from './transform.js';
import { CATEGORY_ORDER, PRINT_LAYOUT, EXCLUSION_ORDER, EXCLUSION_GROUP_LABEL,
         TM_CATEGORY_ORDER, INTERNAL_CATEGORY_ORDER, LANE_LABEL, WATERMAKER_CATEGORIES,
         SETTABLE_STATUSES } from './rules.js';
import { stellaCode, labelFor, existingBoats, acceptNewCode, applyTemplate } from './vessel-codes.js';
import { Auth, ROLE, friendlyAuthError, setManagers, managerCount } from './auth.js';
import { VERSION } from './version.js';
import { Store, packRows, unpackRows, isNewerImport } from './store.js';
import { renderPrint, measure, fitToPage } from './print.js';
import { renderGantt } from './gantt.js';
import { balanceColumns } from './print.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// The export we last put in front of the other managers. Keyed on the
// adapter's retrievedAt, so a reload does not keep appending records to an
// append-only collection.
const GANTT_KEY = 'stella.board.ganttView';
function loadGanttPrefs() {
  try { return { packed: false, all: false, ...JSON.parse(localStorage.getItem(GANTT_KEY) ?? '{}') }; }
  catch { return { packed: false, all: false }; }
}
const saveGanttPrefs = (v) => { try { localStorage.setItem(GANTT_KEY, JSON.stringify(v)); } catch {} };

const PUBLISHED_KEY = 'stella.board.publishedAt';
const publishedAt = () => { try { return localStorage.getItem(PUBLISHED_KEY) ?? ''; } catch { return ''; } };
const markPublished = (at) => { try { localStorage.setItem(PUBLISHED_KEY, at ?? ''); } catch {} };

const state = {
  rows: null,
  source: null,
  codeMap: {},
  overrides: {},
  itemOverrides: {},
  // Per DEVICE, not shared: how somebody prefers to look at the chart says
  // nothing about the work. Board settings — horizon, stock cap, auto-fit — are
  // the opposite, and live in Firestore so every manager sees the same board.
  gantt: loadGanttPrefs(),
  settings: { horizonWeeks: 12, maxStock: null, autoFit: true },
  board: null,
  fit: null,
};

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

(async function boot() {
  wireAuth();

  await Auth.init(async (st) => {
    if (st.role === ROLE.NONE) { showAuth(); return; }
    await start(st);
  });
})();

function showAuth() {
  $('authView').classList.add('show');
  $('appShell').hidden = true;
}

let started = false;
let storeReady = false;

async function start(st) {
  $('authView').classList.remove('show');
  $('appShell').hidden = false;

  // THE STORE COMES UP BEFORE THE ROLE IS READ. The manager list is in
  // Firestore rather than in the shipped JavaScript, and Firebase reports the
  // signed-in user before the store exists — so the role Auth first hands us is
  // always FLOOR, whoever signed in. Load the list, then ask again.
  if (!storeReady) {
    storeReady = true;
    await Store.init();
    setManagers(await Store.loadManagers());
  }
  st = { ...st, role: Auth.refreshRole() };

  // Role decides what is drawn. The Firestore rules decide what is allowed —
  // hiding a button is not security, it is tidiness.
  document.body.classList.toggle('role-floor', st.role === ROLE.FLOOR);
  document.body.classList.toggle('role-manager', st.role === ROLE.MANAGER);

  const who = $('whoami');
  who.textContent = st.mode === 'local' ? 'Local mode' : (st.email ?? '');
  const chip = el('span', `role ${st.role === ROLE.MANAGER ? 'manager' : ''}`,
    st.role === ROLE.MANAGER ? 'MANAGER' : 'FLOOR');
  who.append(chip);
  $('signOut').hidden = st.mode === 'local';

  if (started) { rebuild(); return; }
  started = true;

  // Floor accounts read the last published board and render the printed sheet.
  // No upload, no controls, no edit affordances — that is the whole point of
  // the role, and the rules deny those writes regardless.
  // An empty list means every signed-in account gets the floor view. That is
  // the right default, and it is also what a missing `settings/access` document
  // looks like — so say which, rather than leaving a manager wondering why
  // their own board has gone read-only.
  if (st.role === ROLE.FLOOR && Auth.mode === 'firebase' && !managerCount()) {
    $('floorEmpty').hidden = false;
    $('floorEmpty').innerHTML =
      '<strong>No manager list configured</strong>'
      + 'Everyone signed in sees the floor view until <code>settings/access</code> '
      + 'exists in Firestore with a <code>managers</code> array of email addresses. '
      + 'See the private SETUP document.';
  }

  if (st.role === ROLE.FLOOR) { await startFloor(); return; }

  state.settings = await Store.loadSettings();
  state.codeMap = await Store.loadCodes();
  state.overrides = await Store.loadOverrides();
  state.itemOverrides = await Store.loadItemOverrides();

  $('horizon').value = state.settings.horizonWeeks;
  $('horizonVal').textContent = `${state.settings.horizonWeeks} weeks`;
  $('maxStock').value = state.settings.maxStock ?? '';
  setAutoFit(state.settings.autoFit, { save: false });

  $('provVersion').textContent = `v${VERSION}`;
  $('provStore').textContent = Store.mode === 'firestore'
    ? 'Edits sync to Firestore'
    : `Local only — ${Store.reason}`;
  $('provStore').style.color = Store.mode === 'firestore' ? '' : 'var(--red-bright)';

  wireUpload();
  wireControls();
  wireOverlays();

  await loadLastBoard();

  // The shell is up whether or not there is a board: the tab bar is how you
  // reach the Import tab, and the Import tab is where you go when there is
  // nothing loaded. It used to be hidden behind the drop zone, which meant the
  // only way to see the app was to already have data in it.
  showImportPage(!state.rows);

  startLiveSync();
}

// ---------------------------------------------------------------------------
// live sync
//
// Everything shared is watched, so an edit on one device appears on the others
// without a reload. Three things make that safe rather than merely live:
//
//   DEBOUNCED. A bulk complete writes one document per job, and each write
//   fires its own snapshot. Thirteen jobs would otherwise mean thirteen
//   rebuilds, each measuring and laying out the print sheet.
//
//   DEFERRED WHILE A DIALOG IS OPEN. The overlays hold a captured job object;
//   rebuilding underneath them would leave the dialog editing a stale row. The
//   change is applied when the dialog closes instead.
//
//   OWN WRITES IGNORED FOR CONTROLS. Firestore replays this client's own writes
//   immediately for latency compensation, which would otherwise reset the
//   horizon slider under the finger that is dragging it.
// ---------------------------------------------------------------------------

const unsubscribes = [];
let rebuildTimer = null;
let rebuildDeferred = false;

const dialogOpen = () => ['labelOverlay', 'hideOverlay', 'completeOverlay', 'newCodeOverlay']
  .some((id) => $(id)?.classList.contains('show'));

function scheduleRebuild() {
  if (dialogOpen()) { rebuildDeferred = true; return; }
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => { if (state.rows) rebuild(); }, 150);
}

/** Called when a dialog closes, so anything that arrived meanwhile lands. */
function flushDeferredRebuild() {
  if (!rebuildDeferred) return;
  rebuildDeferred = false;
  scheduleRebuild();
}

function startLiveSync() {
  if (Store.mode !== 'firestore') return;

  unsubscribes.push(Store.watchOverrides((o) => {
    state.overrides = o;
    scheduleRebuild();
  }));

  unsubscribes.push(Store.watchItemOverrides((o) => {
    state.itemOverrides = o;
    scheduleRebuild();
  }));

  unsubscribes.push(Store.watchCodes((m) => {
    state.codeMap = m;
    scheduleRebuild();
  }));

  unsubscribes.push(Store.watchSettings((v, meta) => {
    // Board settings are shared on purpose: every manager should be looking at
    // the same horizon. Skip the echo of our own write so the slider does not
    // jump while it is being dragged.
    if (meta.fromSelf) return;
    const before = JSON.stringify(state.settings);
    state.settings = { ...state.settings, ...v };
    if (JSON.stringify(state.settings) === before) return;
    $('horizon').value = state.settings.horizonWeeks;
    $('horizonVal').textContent = `${state.settings.horizonWeeks} weeks`;
    $('maxStock').value = state.settings.maxStock ?? '';
    setAutoFit(state.settings.autoFit, { save: false, render: false });
    scheduleRebuild();
  }));

  unsubscribes.push(Store.watchLatestImport((rec, meta) => {
    // NEWER, not merely different — see `isNewerImport`.
    if (meta.fromSelf || !isNewerImport(rec, state.source?.retrievedAt)) return;
    const rows = unpackRows(rec.rowsJson);
    if (!rows?.length) return;
    state.rows = rows;
    state.source = {
      sourceId: rec.sourceId,
      sourceLabel: rec.sourceLabel,
      retrievedAt: rec.retrievedAt,
      uploadedBy: rec.uploadedBy ?? null,
      warnings: [],
    };
    Store.cacheRows(rows, state.source);
    markPublished(rec.retrievedAt);
    scheduleRebuild();
    toast(rec.uploadedBy && rec.uploadedBy !== Auth.user?.email
      ? `New export uploaded by ${rec.uploadedBy} — board updated.`
      : 'Board updated from a newer export.', 5000);
  }));
}

window.addEventListener('beforeunload', () => {
  for (const stop of unsubscribes) { try { stop(); } catch {} }
});

/**
 * Pick up the most recent export, wherever it came from.
 *
 * An upload used to live only in the uploading device's localStorage, so the
 * second manager signed in to an empty drop zone and was asked to upload the
 * same file again. The import record already held the board for the floor; it
 * now holds the raw rows too, so any manager continues from where the last one
 * left off.
 *
 * Local wins only if it is genuinely newer — otherwise a stale cache would hide
 * a colleague's fresh upload, which is the same failure the other way round.
 */
async function loadLastBoard() {
  const cached = Store.cachedRows();
  let published = null;
  try { published = await Store.latestBoard(); } catch (e) { console.warn('[board]', e.message); }

  const publishedRows = published?.rowsJson ? unpackRows(published.rowsJson) : null;
  const localAt = cached?.source?.retrievedAt ?? '';
  const remoteAt = published?.retrievedAt ?? '';

  let pick = null;
  if (cached?.rows?.length && (!publishedRows?.length || localAt >= remoteAt)) {
    pick = { rows: cached.rows, source: cached.source };
  } else if (publishedRows?.length) {
    pick = {
      rows: publishedRows,
      source: {
        sourceId: published.sourceId,
        sourceLabel: published.sourceLabel,
        retrievedAt: published.retrievedAt,
        uploadedBy: published.uploadedBy ?? null,
        warnings: [],
      },
    };
    // Keep it locally too, so a reload is instant and works offline.
    Store.cacheRows(pick.rows, pick.source);
  }

  if (!pick) {
    // Nothing local, and nothing usable published. Say which, because "drop the
    // export here" is wrong advice if a colleague already uploaded it.
    if (published && !publishedRows?.length) {
      $('dropZone').querySelector('strong').textContent =
        'A board was published, but without its source data';
      $('dropZone').querySelector('.hint').innerHTML =
        `<b>${published.sourceLabel ?? 'An export'}</b> was published`
        + `${published.uploadedBy ? ` by ${published.uploadedBy}` : ''}, but before the app `
        + `stored the raw rows alongside it. Whoever has the file need only open `
        + `their board once and it will be shared automatically — or drop it here.`;
    }
    return;
  }

  state.rows = pick.rows;
  state.source = pick.source;
  rebuild();
  // A code added since the last load still needs answering.
  if (Auth.isManager) queueImportQuestions();

  // SELF-HEAL. Records written before the raw rows were stored carry a board
  // but nothing another manager can rebuild from, which is exactly how the
  // second account landed on an empty drop zone. If this manager holds the data
  // and what is published cannot supply it, publish theirs — once per export,
  // so a reload does not keep appending to an append-only collection.
  const needsRows = Auth.isManager && Store.mode === 'firestore'
    && pick.rows.length
    && !publishedRows?.length
    && publishedAt() !== pick.source.retrievedAt;
  if (needsRows) await publish(pick.rows, 'shared with the other managers');
}

async function startFloor() {
  const published = await Store.latestBoard();
  if (!published?.jobs?.length) {
    $('floorEmpty').hidden = false;
    return;
  }
  state.board = { jobs: published.jobs, meta: published.meta, warnings: {}, excluded: [] };
  state.source = {
    sourceLabel: published.sourceLabel,
    sourceId: published.sourceId,
    retrievedAt: published.retrievedAt,
    warnings: [],
  };
  $('provenance').hidden = false;
  $('boardWrap').hidden = false;
  renderProvenance();
  renderPrint($('printPreview'), state.board);
  showTab('print');
}

function wireAuth() {
  const submit = async () => {
    $('loginErr').textContent = '';
    $('loginBtn').disabled = true;
    try {
      await Auth.signIn($('loginEmail').value, $('loginPass').value);
      $('loginPass').value = '';
    } catch (e) {
      $('loginErr').textContent = friendlyAuthError(e);
    } finally {
      $('loginBtn').disabled = false;
    }
  };
  $('loginBtn').addEventListener('click', submit);

  // Lets somebody set a password nobody else has seen — including whoever
  // created their account. The account itself still comes from the console.
  $('resetBtn').addEventListener('click', async () => {
    const email = $('loginEmail').value.trim();
    const err = $('loginErr');
    if (!email) { err.textContent = 'Type your email address above first.'; return; }
    $('resetBtn').disabled = true;
    try {
      await Auth.sendPasswordReset(email);
      err.style.color = 'var(--text-dim)';
      // Firebase answers identically for an address that has no account, so
      // promising "it has been sent" would be a lie for a typo. Say what was
      // actually done, and where to look.
      err.textContent = `If ${email} has an account, a link to set a password is on its `
        + `way. It can take a minute, and it may land in junk mail.`;
    } catch (e) {
      err.style.color = '';
      err.textContent = friendlyAuthError(e);
    } finally {
      $('resetBtn').disabled = false;
    }
  });
  for (const id of ['loginEmail', 'loginPass']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
  $('signOut').addEventListener('click', () => Auth.signOut());
}

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

function wireUpload() {
  const zone = $('dropZone');
  const input = $('fileInput');

  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => input.files[0] && load(input.files[0]));

  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) load(f);
  });

}

async function load(file) {
  let src;
  try {
    toast(`Reading ${file.name}…`);
    src = await xlsxAdapter.fetch({ file });
  } catch (e) {
    toast(`Could not read that file — ${e.message}`, 6000);
    console.error(e);
    return;
  }

  // STAGED, not committed. The rows are built into a board here so the review
  // can describe the real result — counts, exclusions, every ambiguity — but
  // state.rows is untouched and the other managers see nothing until Apply.
  // Built against the CURRENT overrides and codes, which is what makes the
  // review honest: it is the board you will actually get.
  try {
    staged = {
      src,
      board: buildBoard(src.rows, {
        codeMap: state.codeMap,
        asOf: today(),
        overrides: state.overrides,
        itemOverrides: state.itemOverrides,
        maxStock: state.settings.maxStock,
        horizonWeeks: state.settings.horizonWeeks,
      }),
    };
  } catch (e) {
    toast(`Could not build a board from that file — ${e.message}`, 6000);
    console.error(e);
    return;
  }

  showImportPage(true);
  toast(`${src.rows.length} rows read — review and apply.`);
}

/** Commit the staged import: this is the point of no return. */
async function commitImport() {
  if (!staged) return;
  const { src } = staged;

  // The open order book, not the whole file. See `retainedRows`: carrying the
  // 1047 closed rows in the 01/09 export pushed the import record past
  // Firestore's 1 MiB document limit, so the write was refused and the upload
  // reached nobody else. The review above ran against the full file.
  const keep = retainedRows(src.rows);
  state.rows = keep;
  state.source = {
    sourceId: src.sourceId,
    sourceLabel: src.sourceLabel,
    retrievedAt: src.retrievedAt,
    warnings: src.warnings,
    rowsInFile: src.rows.length,
    rowsKept: keep.length,
  };
  staged = null;
  Store.cacheRows(keep, state.source);
  // OFF THE IMPORT PAGE FIRST, then rebuild. `rebuild` measures the print host
  // to fit the page, and a [hidden] ancestor gives it no layout — measured from
  // behind the import page it reported "will not fit one page (null pages)" on
  // a board that fits comfortably.
  showImportPage(false);
  rebuild();
  showTab('edit');
  toast(`${keep.length} open rows in — ${state.board.meta.job_count} production orders.`);
  queueImportQuestions();

  // Publishing is a SEPARATE failure from parsing. Both used to sit in one try,
  // so a save that was refused reported "could not read that file" — which
  // points at the spreadsheet and hides the fact that the board never reached
  // anybody else.
  await publish(keep, 'shared with the other managers');
}

/**
 * Put the current export where every manager and the floor can reach it.
 *
 * `imports` is append-only, so this adds a record rather than editing one.
 */
// Firestore's hard limit on a single document. The import record is one
// document, so this is the real ceiling on how much of an export can be shared.
const FIRESTORE_DOC_LIMIT = 1048576;

const utf8Bytes = (str) => new TextEncoder().encode(String(str ?? '')).length;

async function publish(rows, what) {
  try {
    const packed = packRows(rows);
    // Check before writing rather than letting the server refuse: a size error
    // from Firestore says nothing a manager can act on, and the failure is
    // silent from their side — the board looks fine on the machine that made
    // it and reaches nobody.
    // UTF-8 BYTES, not string length. Firestore counts bytes and a JS string's
    // .length counts UTF-16 units, so `.length` under-reports every non-ASCII
    // character — and this export is full of them, every "—" in a description
    // being three bytes and one unit. Measured wrong, the guard would wave
    // through exactly the payload it exists to catch.
    const size = utf8Bytes(packed) + utf8Bytes(JSON.stringify(state.board.jobs ?? []));
    if (size > FIRESTORE_DOC_LIMIT * 0.9) {
      toast(`This export is too large to share — ${(size / 1048576).toFixed(2)} MB `
        + `against a 1 MB limit. The board is on this device only. `
        + `Narrow the ERP inquiry, or ask for the export to be split.`, 12000);
      console.error('[publish] payload too large', size);
      return false;
    }
    await Store.recordImport({
      retrievedAt: state.source.retrievedAt,
      sourceId: state.source.sourceId,
      sourceLabel: state.source.sourceLabel,
      horizonWeeks: state.fit?.weeks ?? state.settings.horizonWeeks,
      maxStock: state.settings.maxStock ?? null,
      // The full job list, not a summary: floor devices render from this and
      // never see the spreadsheet.
      jobs: state.board.jobs,
      meta: state.board.meta,
      uploadedBy: Auth.user?.email ?? null,
      // The raw export as well, so the OTHER manager picks up the same data
      // rather than being asked to upload the same file again. The jobs array
      // is a rendering of one horizon; the rows are what the transform needs to
      // re-render at another.
      rowsJson: packed,
    });
    markPublished(state.source.retrievedAt);
    if (what) toast(`Board ${what}.`);
    return true;
  } catch (e) {
    console.error('[publish]', e);
    toast(`Board is on this device, but could not be shared — ${e.message}. `
      + `Others will not see it.`, 8000);
    return false;
  }
}


// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

function wireControls() {
  const horizon = $('horizon');
  horizon.addEventListener('input', () => {
    $('horizonVal').textContent = `${horizon.value} week${horizon.value === '1' ? '' : 's'}`;
  });
  horizon.addEventListener('change', async () => {
    state.settings.horizonWeeks = Number(horizon.value);
    await Store.saveSettings({ horizonWeeks: state.settings.horizonWeeks });
    rebuild();
  });

  $('maxStock').addEventListener('change', async (e) => {
    const v = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
    state.settings.maxStock = v;
    await Store.saveSettings({ maxStock: v });
    rebuild();
  });

  $('autoFit').addEventListener('click', () => setAutoFit(!state.settings.autoFit));

  for (const t of TABS) {
    const cap = t[0].toUpperCase() + t.slice(1);
    $(`tab${cap}Btn`).addEventListener('click', () => showTab(t));
  }
  $('importNav').addEventListener('click', () => showImportPage(true));
  $('boardNav').addEventListener('click', () => showImportPage(false));
  for (const b of document.querySelectorAll('[id^=history][data-lane]')) {
    b.addEventListener('click', () => toggleHistory(b.dataset.lane));
  }

  $('completePastDue').addEventListener('click', () =>
    openCompleteDialog(state.board.warnings.pastDue ?? []));

  $('collapseAll').addEventListener('click', () => {
    if (collapsed.size) collapsed.clear();
    else for (const c of CATEGORY_ORDER) collapsed.add(c);
    saveCollapsed(collapsed);
    renderBoard();
  });

  const ganttToggle = (id, key) => {
    const paint = () => {
      $(id).classList.toggle('on', state.gantt[key]);
      $(id).setAttribute('aria-pressed', String(state.gantt[key]));
    };
    paint();
    $(id).addEventListener('click', () => {
      state.gantt[key] = !state.gantt[key];
      saveGanttPrefs(state.gantt);
      paint();
      renderGanttView();
    });
  };
  ganttToggle('ganttPacked', 'packed');
  ganttToggle('ganttAll', 'all');
  $('printBtn').addEventListener('click', () => { showTab('print'); window.print(); });
}

function setAutoFit(on, { save = true, render = true } = {}) {
  state.settings.autoFit = on;
  const b = $('autoFit');
  b.textContent = on ? 'Auto-fit on' : 'Auto-fit off';
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  if (save) Store.saveSettings({ autoFit: on });
  if (save && render) rebuild();
}

const TABS = ['edit', 'gantt', 'internal', 'tm', 'print'];

function showTab(which) {
  state.tab = which;
  for (const t of TABS) {
    const cap = t[0].toUpperCase() + t.slice(1);
    $(`tab${cap}`).classList.toggle('offstage', which !== t);
    $(`tab${cap}Btn`).setAttribute('aria-current', which === t ? 'page' : 'false');
  }
  // The Gantt measures itself to scroll to today, and the print preview
  // measures itself to fit the page. Neither can do that while off-canvas, so
  // both are drawn on arrival rather than on rebuild.
  if (which === 'gantt') renderGanttView();
}

/**
 * Import is a page, not a tab: the whole board goes away while you are in it.
 * Reviewing an import against half a screen of the board it is about to replace
 * was the wrong shape - the board on show is the OLD one, and reading the two
 * together invites exactly the confusion the review exists to prevent.
 */
function showImportPage(on) {
  state.importPage = on;
  $('importPage').hidden = !on;
  $('boardWrap').hidden = on || !state.rows;
  $('provenance').hidden = on || !state.source;
  $('importNav').setAttribute('aria-current', on ? 'page' : 'false');
  $('boardNav').setAttribute('aria-current', on ? 'false' : 'page');
  if (on) renderImport();
}

// ---------------------------------------------------------------------------
// build + render
// ---------------------------------------------------------------------------

function rebuild() {
  // A vessel code resolved or a job named from the import review changes what
  // that import would produce, so the staged board is rebuilt from the same
  // rows. Ahead of the early return: staging works with no board loaded at all.
  restage();
  if (!state.rows) return;

  const opts = {
    codeMap: state.codeMap,
    asOf: today(),
    overrides: state.overrides,
    itemOverrides: state.itemOverrides,
    maxStock: state.settings.maxStock,
  };
  const build = (weeks) => buildBoard(state.rows, { ...opts, horizonWeeks: weeks });

  // Reveal BEFORE measuring: a [hidden] ancestor gives the print host no
  // layout, and an unmeasured board would claim to fit at any horizon. Not
  // while the import page is up, though - a live edit from another manager
  // must not shove the board back on screen mid-review.
  $('boardWrap').hidden = Boolean(state.importPage);
  $('provenance').hidden = false;

  const host = $('printPreview');
  // A rebuild can happen while the board is off screen — a live edit from
  // another manager arriving mid-import-review. Nothing can be measured then,
  // so build the board and leave the last known fit alone rather than replacing
  // it with a failure that says more about the layout than the page.
  if (state.importPage) {
    state.board = build(state.fit?.weeks ?? state.settings.horizonWeeks);
  } else if (state.settings.autoFit) {
    state.fit = fitToPage(host, build, { startWeeks: state.settings.horizonWeeks, minWeeks: 4 });
    state.board = state.fit.board;
  } else {
    state.board = build(state.settings.horizonWeeks);
    renderPrint(host, state.board);
    const m = measure(host);
    state.fit = { board: state.board, weeks: state.settings.horizonWeeks, ...m, trimmedFrom: null };
  }

  renderProvenance();
  renderWarnings();
  renderBoard();
  renderFitStatus();
  renderGanttView();
  renderLane('internal');
  renderLane('tm');
  for (const lane of Object.keys(HISTORY_HOST)) renderHistory(lane);
}

function renderProvenance() {
  const s = state.source;
  if (!s) return;
  $('provSource').textContent = s.sourceLabel;
  const when = new Date(s.retrievedAt);
  $('provWhen').textContent = when.toLocaleString('en-AU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  // The board is exactly as fresh as the last upload, and nothing else in the
  // system knows that. Say it out loud once it starts to matter.
  const by = $('provWhen').parentElement;
  const existing = by.parentElement.querySelector('.by');
  if (existing) existing.remove();
  if (s.uploadedBy && s.uploadedBy !== Auth.user?.email) {
    const tag = el('span', 'by');
    tag.append(document.createTextNode('Uploaded by '));
    tag.append(el('b', null, s.uploadedBy));
    by.after(tag);
  }

  const days = Math.floor((Date.now() - when.getTime()) / 86400000);
  const age = $('provAge');
  age.textContent = days <= 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} old`;
  age.classList.toggle('stale', days >= 7);
  if (days >= 7) age.textContent += ' — upload a fresh export';
}

function panel({ cls = '', title, count, open = false, build }) {
  const d = el('details', `panel ${cls}`);
  d.open = open;
  const s = el('summary');
  s.append(el('span', null, title));
  if (count !== undefined) s.append(el('span', 'count', String(count)));
  d.append(s);
  const body = el('div', 'body');
  build(body);
  d.append(body);
  return d;
}

function renderWarnings() {
  const host = $('warnings');
  host.textContent = '';
  const w = state.board.warnings;

  // Column problems from the adapter come first — they invalidate everything.
  for (const msg of state.source?.warnings ?? []) {
    const isHard = msg.startsWith('Export is missing');
    host.append(panel({
      cls: isHard ? 'alert' : '', title: isHard ? 'Export problem' : 'Note', open: isHard,
      build: (b) => b.append(el('div', null, msg)),
    }));
  }

  // Unmapped inventory prefixes — a new product line with no rule. Loud,
  // because the alternative is a job quietly missing from the floor's list.
  if (w.unmapped.length) {
    host.append(panel({
      cls: 'alert', title: 'Unmapped inventory codes — these need a category rule',
      count: w.unmapped.length, open: true,
      build: (b) => {
        b.append(el('div', null,
          'These rows matched no prefix in the category map, so they are off the board. ' +
          'Add a rule in js/rules.js — do not leave them excluded.'));
        for (const e of w.unmapped) {
          const r = el('div', 'xrow');
          r.append(el('span', 'id', e.prod_no), el('span', null, e.inventory_id), el('span', 'why', e.description));
          b.append(r);
        }
      },
    }));
  }

  // Codes still waiting on a decision — skipped in the import dialog, or added
  // since. The board falls back to raw ERP text for these, so it is not cosmetic.
  if (w.newCodes?.length) {
    host.append(panel({
      cls: 'alert', title: 'Vessel codes awaiting a decision', count: w.newCodes.length, open: true,
      build: (b) => {
        b.append(el('div', null,
          'These jobs are on the board but have no agreed code, so they print '
          + 'their raw ERP description. Upstream does not manage these '
          + 'consistently — they need answering by hand.'));
        for (const n of w.newCodes) {
          const r = el('div', 'xrow');
          r.append(el('span', 'id', n.code),
            el('span', null, `${n.count} job(s) · ${n.items.join(', ')}`));
          const a = el('button', 'mini', 'Decide now');
          a.addEventListener('click', () => startCodeRun([n]));
          r.append(a);
          b.append(r);
        }
      },
    }));
  }

  // Custom jobs still printing a guessed name — skipped in the import dialog,
  // or arrived since. Not cosmetic: the floor reads this off the board.
  if (w.customNames?.length) {
    host.append(panel({
      cls: 'alert', title: 'Custom jobs awaiting a name', count: w.customNames.length, open: true,
      build: (b) => {
        b.append(el('div', null,
          'These are one-offs with no model code, and the Description column '
          + 'does not read as a boat. They print the customer name until '
          + 'somebody says otherwise.'));
        for (const j of w.customNames) {
          const r = el('div', 'xrow');
          r.append(el('span', 'id', j.prod_no),
            el('span', null, jobTitle(j)),
            el('span', 'why', j.name_options.description.raw || 'no description'));
          const a = el('button', 'mini', 'Decide now');
          a.addEventListener('click', () => {
            startNameRun([j]);
          });
          r.append(a);
          b.append(r);
        }
      },
    }));
  }

  // Two hand-confirmed answers for one boat. Never resolved silently.
  if (w.codeConflicts.length) {
    host.append(panel({
      cls: 'alert', title: 'Vessel code conflict', count: w.codeConflicts.length, open: true,
      build: (b) => {
        for (const c of w.codeConflicts) {
          b.append(el('div', null,
            `${c.codes.join(' and ')} are the same boat (Riviera ${c.models.join(', ')}) ` +
            `but are confirmed to different display codes: ` +
            `${c.values.map((v) => `${v.code}→${v.display}`).join(', ')}. ` +
            `Fix it on the vessel codes page.`));
        }
      },
    }));
  }

  if (w.codeUndecided.length) {
    host.append(panel({
      title: 'Vessel codes awaiting confirmation', count: w.codeUndecided.length,
      build: (b) => {
        for (const u of w.codeUndecided) {
          b.append(el('div', null,
            `${u.codes.join(', ')} — showing ${u.provisional}, nobody has confirmed it.`));
        }
      },
    }));
  }

  // On Hold jobs are flagged, never auto-hidden. Only warn for ones that would
  // actually appear — an On Hold job outside the horizon is already gone.
  if (w.onHold.length) {
    host.append(panel({
      cls: 'alert', title: 'On hold, but showing on the board', count: w.onHold.length, open: true,
      build: (b) => {
        b.append(el('div', null, 'Confirm these before the floor starts them, or hide them.'));
        for (const j of w.onHold) {
          const r = el('div', 'xrow');
          r.append(el('span', 'id', j.prod_no), el('span', null, jobTitle(j)),
            el('span', 'why', j.status_manual ? 'put on hold here' : `due ${j.due_display}`));
          b.append(r);
        }
      },
    }));
  }

  if (w.hidden.length) {
    host.append(panel({
      title: 'Hidden from the printed board', count: w.hidden.length,
      build: (b) => {
        for (const j of w.hidden) {
          const r = el('div', 'xrow');
          r.append(el('span', 'id', j.prod_no), el('span', null, jobTitle(j)),
            el('span', 'why', j.hidden_reason || 'no reason given'));
          b.append(r);
        }
      },
    }));
  }

  // Nothing disappears silently: if a job is missing, this says why. Grouped so
  // the horizon cut — the one the manager acts on, by widening it — is first.
  host.append(panel({
    title: 'Excluded rows', count: state.board.excluded.length,
    build: (b) => {
      b.append(el('div', null,
        `${state.board.meta.row_count} rows in the export, ${state.board.meta.job_count} on the board.`));

      const byKind = new Map();
      for (const e of state.board.excluded) {
        const k = e.kind ?? 'category';
        if (!byKind.has(k)) byKind.set(k, []);
        byKind.get(k).push(e);
      }

      for (const kind of EXCLUSION_ORDER) {
        const rows = byKind.get(kind);
        if (!rows?.length) continue;
        const h = el('div', `xgroup ${kind}`);
        h.append(el('span', null, EXCLUSION_GROUP_LABEL[kind] ?? kind));
        h.append(el('span', 'count', String(rows.length)));
        b.append(h);
        for (const e of rows) {
          const r = el('div', 'xrow');
          r.append(el('span', 'id', e.prod_no));
          r.append(el('span', null, e.inventory_id));
          // The item's own description, which is often the clearer of the two.
          r.append(el('span', 'desc', e.item_description || e.description || ''));
          r.append(el('span', 'why', e.reason));
          b.append(r);
        }
      }
    },
  }));
}

function renderBoard() {
  const host = $('board');
  host.textContent = '';
  const groups = byCategory(state.board.jobs, { includeHidden: true });

  const counts = Object.fromEntries(
    CATEGORY_ORDER.map((c) => [c, (groups.get(c) ?? []).length]));

  // Same shape as the printed sheet: the four narrow categories side by side,
  // davits full width underneath. Same balancer too, so the two views agree
  // about which category sits where instead of drifting apart.
  const { left, right } = balanceColumns(counts);

  const grid = el('div', 'board-grid');
  for (const side of [left, right]) {
    const col = el('div', 'board-col');
    for (const cat of side) {
      const block = categoryBlock(cat, groups.get(cat) ?? []);
      if (block) col.append(block);
    }
    grid.append(col);
  }
  host.append(grid);

  for (const cat of PRINT_LAYOUT.full) {
    const block = categoryBlock(cat, groups.get(cat) ?? [], { full: true });
    if (block) { block.classList.add('is-full'); host.append(block); }
  }

  // Watermakers, at the bottom and below a rule. The grid above mirrors the
  // printed sheet, which these are deliberately not on — so they sit outside
  // it rather than being balanced into a column that has no paper equivalent.
  // Same rows, same actions, same completion; just no column on the print.
  const water = WATERMAKER_CATEGORIES.filter((c) => (groups.get(c) ?? []).length);
  if (water.length) {
    const sec = el('div', 'board-offsheet');
    sec.append(el('div', 'offsheet-note', 'Not on the printed sheet'));
    for (const cat of water) {
      const block = categoryBlock(cat, groups.get(cat) ?? [], { full: true });
      if (block) { block.classList.add('is-full'); sec.append(block); }
    }
    host.append(sec);
  }

  const any = CATEGORY_ORDER.some((c) => (groups.get(c) ?? []).length);
  $('emptyState').hidden = any;
  $('stockNote').textContent = `${state.board.jobs.filter((j) => j.is_stock).length} stock`;

  $('tabInternalBtn').textContent = state.board.meta.internal_count
    ? `Internal Factory Jobs (${state.board.meta.internal_count})`
    : 'Internal Factory Jobs';
  $('tabTmBtn').textContent = state.board.meta.tm_count
    ? `Time & Materials Jobs (${state.board.meta.tm_count})`
    : 'Time & Materials Jobs';

  const pastDue = state.board.warnings.pastDue?.length ?? 0;
  $('boardCount').textContent = `${state.board.meta.job_count} on the board`
    + (pastDue ? ` · ${pastDue} past due` : '');
  $('completePastDue').disabled = !pastDue;
  $('collapseAll').textContent = collapsed.size ? 'Expand all' : 'Collapse all';
}

function categoryBlock(cat, jobs, { full = false } = {}) {
  if (!jobs.length) return null;
  const isShut = collapsed.has(cat);
  const block = el('div', `cat-block${isShut ? ' is-collapsed' : ''}`);

  const head = el('button', 'cat-head');
  head.setAttribute('aria-expanded', String(!isShut));
  head.append(el('span', 'cat-caret', isShut ? '\u25b8' : '\u25be'));
  head.append(el('h2', null, cat));
  const shown = jobs.filter((j) => !j.hidden).length;
  head.append(el('span', 'n', shown === jobs.length ? `${shown}` : `${shown} of ${jobs.length}`));
  head.addEventListener('click', () => {
    if (collapsed.has(cat)) collapsed.delete(cat); else collapsed.add(cat);
    saveCollapsed(collapsed);
    renderBoard();
  });
  block.append(head);

  if (isShut) return block;

  const body = el('div', 'cat-body');
  const hdr = el('div', `job col-head${full ? ' is-full' : ''}`);
  hdr.append(el('span', null, 'Prod Nbr'), el('span', null, 'PO'),
    el('span', null, 'Vessel'), el('span', null, 'Due'));
  if (full) hdr.append(el('span', null, 'Status'));
  hdr.append(el('span', null, ''));
  body.append(hdr);
  for (const j of jobs) body.append(jobRow(j, { full }));
  block.append(body);
  return block;
}

/**
 * The status control that sits before Done.
 *
 * A select rather than a dialog: this is the one edit on a row that has a
 * closed set of answers and no consequences to explain, so making somebody
 * confirm it would be ceremony. Setting it back to what the ERP says clears the
 * override rather than pinning the same value, so the job goes back to
 * following the export.
 */
function statusControl(j) {
  const wrap = el('span', `st${j.status_manual ? ' is-manual' : ''}`);
  const sel = document.createElement('select');
  sel.className = 'st-select';
  for (const opt of SETTABLE_STATUSES) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    o.selected = opt === j.status;
    sel.append(o);
  }
  sel.title = j.status_manual
    ? `Set by hand. The ERP says ${j.erp_status} \u2014 this reverts on its own if `
      + 'the ERP changes to anything else.'
    : `From the ERP. Change it here if the floor has moved on.`;
  sel.addEventListener('change', () => setStatus(j, sel.value));
  wrap.append(sel);
  return wrap;
}

async function setStatus(j, value) {
  if (value === j.erp_status) {
    await setOverride(j.prod_no, { status: null, statusFrom: null });
    toast(`${j.prod_no} follows the ERP again \u2014 ${value}.`);
    return;
  }
  // `statusFrom` is what makes this expire: it records the ERP value being
  // corrected, so the override drops itself once the export disagrees.
  await setOverride(j.prod_no, { status: value, statusFrom: j.erp_status });
  toast(`${j.prod_no} set to ${value}.`);
}

function jobRow(j, { full = false } = {}) {
  const row = el('div', `job${j.on_hold ? ' on-hold' : ''}${j.hidden ? ' is-hidden' : ''}`
    + `${full ? ' is-full' : ''}`);

  row.append(el('span', 'prod', j.prod_no));

  // Riviera's PO sits next to the production number because that is the pair
  // the manager reads together when checking an order against Riviera. It is
  // manager-view only and never reaches the printed board.
  row.append(el('span', 'po', j.customer_po ?? ''));

  const label = el('span', 'label', jobTitle(j));
  if (j.label !== j.base_label) label.append(el('span', 'edited', 'EDITED'));
  else if (j.item_override) label.append(el('span', 'pinned', 'ITEM'));
  row.append(label);

  row.append(el('span', `due${j.is_stock ? ' stock' : ''}`, j.due_display));
  // Status only in the full-width block. Left out of the markup rather than
  // hidden: a hidden grid item is removed from flow and everything after it
  // shifts a column left.
  if (full) {
    const st = el('span', `status${j.status_manual ? ' is-manual' : ''}`, j.status);
    if (j.status_manual) st.title = `Set by hand \u2014 the ERP says ${j.erp_status}`;
    row.append(st);
  }

  const acts = el('span', 'acts');
  const edit = el('button', 'mini', 'Label');
  edit.addEventListener('click', () => openLabelEditor(j));
  acts.append(edit);

  const hide = el('button', `mini${j.hidden ? ' on' : ''}`, j.hidden ? 'Show' : 'Hide');
  hide.addEventListener('click', () => (j.hidden ? unhide(j) : openHideDialog(j)));
  acts.append(hide);

  acts.append(statusControl(j));

  const done = el('button', 'mini', 'Done');
  done.title = 'Mark completed — off the board for good, reversible from History';
  done.addEventListener('click', () => openCompleteDialog([j]));
  acts.append(done);

  row.append(acts);
  return row;
}

function renderGanttView() {
  const { packed, all } = state.gantt;

  // "Everything" drops the horizon and puts completed work back, so the chart
  // can show the whole span rather than the printable slice. It scrolls at a
  // fixed day width instead of compressing — two years squeezed onto one screen
  // is a smear, not a chart.
  // The chart shows every open production order, watermakers included. The
  // horizon does not apply here any more — it trims the printed sheet, not the
  // schedule — so "everything" now means completed work as well.
  //
  // T&M and internal jobs are deliberately absent. The ERP stamps their start
  // and end to the day the order was raised and never revises it, so every bar
  // would be a zero-width mark at an arbitrary date. Their tabs show age.
  const jobs = all
    ? buildBoard(state.rows, {
        codeMap: state.codeMap, asOf: today(), overrides: state.overrides,
        itemOverrides: state.itemOverrides, horizonWeeks: null, includeCompleted: true,
      }).jobs.filter((j) => !j.hidden)
    : state.board.jobs.filter((j) => !j.hidden);

  // Collapsed bands persist, in the same localStorage set as the orders view
  // and History. Keyed per view so shutting Davits on the chart does not shut
  // it on the orders list — the two are read for different reasons.
  const g = renderGantt($('gantt'), jobs, {
    asOf: today(),
    mode: packed ? 'packed' : 'rows',
    pxPerDay: all ? 8 : null,
    onBarClick: Auth.isManager ? (r) => openCompleteDialog([r]) : null,
    isCollapsed: (cat) => collapsed.has(`gantt:${cat}`),
    onToggleCategory: (cat) => {
      const key = `gantt:${cat}`;
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      saveCollapsed(collapsed);
      renderGanttView();
    },
  });

  $('ganttHint').textContent = all
    ? `Completed work included \u2014 ${g.rowCount} bars, scroll sideways.`
    : 'Every open production order. Click a bar to mark it complete.';
}

// History is per lane. Completed production work, finished T&M jobs and
// finished internal builds are three different questions, and one merged list
// answered none of them well. It is also no longer a tab: it is a button beside
// each lane's own controls, because it is something you go and look up rather
// than something you keep open.
const HISTORY_HOST = {
  production: 'historyProduction',
  internal: 'historyInternalPanel',
  tm: 'historyTmPanel',
};
const HISTORY_BTN = { production: 'historyEdit', internal: 'historyInternal', tm: 'historyTm' };
const HISTORY_BODY = { production: 'board', internal: 'internalList', tm: 'tmList' };
const HISTORY_CATS = {
  production: CATEGORY_ORDER,
  internal: INTERNAL_CATEGORY_ORDER,
  tm: TM_CATEGORY_ORDER,
};
const historyOpen = new Set();

function toggleHistory(lane) {
  if (historyOpen.has(lane)) historyOpen.delete(lane); else historyOpen.add(lane);
  renderHistory(lane);
}

function renderHistory(lane = 'production') {
  const host = $(HISTORY_HOST[lane]);
  const open = historyOpen.has(lane);
  const done = (state.board.completed ?? []).filter((j) => (j.lane ?? 'production') === lane);

  const btn = $(HISTORY_BTN[lane]);
  btn.textContent = done.length ? `History (${done.length})` : 'History';
  btn.setAttribute('aria-pressed', String(open));
  $(HISTORY_BODY[lane]).hidden = open;
  host.hidden = !open;
  if (!open) return;

  host.textContent = '';
  if (!done.length) {
    host.append(el('div', 'state', 'Nothing completed yet. Jobs marked done here '
      + 'or on the Gantt land in this list.'));
    return;
  }

  // Grouped by board category, same order as everywhere else, so History reads
  // like the orders view rather than as one long undifferentiated list.
  const cats = HISTORY_CATS[lane];
  const byCat = new Map(cats.map((c) => [c, []]));
  for (const j of done) byCat.get(j.category)?.push(j);

  for (const cat of cats) {
    const rows = byCat.get(cat) ?? [];
    if (!rows.length) continue;

    const key = `hist:${lane}:${cat}`;
    const shut = collapsed.has(key);
    const block = el('div', `hist-cat${shut ? ' is-collapsed' : ''}`);

    const head = el('button', 'hist-cat-head');
    head.setAttribute('aria-expanded', String(!shut));
    head.append(el('span', 'cat-caret', shut ? '\u25b8' : '\u25be'));
    head.append(el('h2', null, cat));
    head.append(el('span', 'n', String(rows.length)));
    head.addEventListener('click', () => {
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      saveCollapsed(collapsed);
      renderHistory(lane);
    });
    block.append(head);

    if (!shut) {
      const table = el('div', 'hist');
      const hdr = el('div', 'hist-row hist-head');
      hdr.append(el('span', null, 'Prod Nbr'), el('span', null, lane === 'production' ? 'Vessel' : 'Job'),
        el('span', null, lane === 'production' ? 'Due' : 'Opened'),
        el('span', null, 'Completed'), el('span', null, ''));
      table.append(hdr);

      // Most recently completed first within a category.
      rows.sort((a, b) => String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? '')));

      for (const j of rows) {
        const row = el('div', 'hist-row');
        row.append(el('span', 'prod', j.prod_no));
        row.append(el('span', 'label', jobTitle(j)));
        row.append(el('span', 'due', lane === 'production' ? j.due_display : (j.opened_display ?? '')));
        const when = j.completed_at ? new Date(j.completed_at) : null;
        const stamp = el('span', 'when', when
          ? when.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })
          : '\u2014');
        if (j.completed_by) stamp.title = `Marked by ${j.completed_by}`;
        row.append(stamp);

        const acts = el('span', 'acts');
        const reopen = el('button', 'mini', 'Reopen');
        reopen.title = 'Put it back on the board';
        reopen.addEventListener('click', async () => {
          await Store.setCompleted([j.prod_no], false, Auth.user?.email);
          state.overrides = await Store.loadOverrides();
          rebuild();
          toast(`${j.prod_no} reopened.`);
        });
        acts.append(reopen);
        row.append(acts);
        table.append(row);
      }
      block.append(table);
    }
    host.append(block);
  }
}

// ---------------------------------------------------------------------------
// completion
//
// The ERP saved filter drops Completed/Canceled/Closed, so the handoff assumed
// finished work never arrives. That holds only while the ERP status actually
// flips. A job finished on the floor and never closed in the system stays
// `In Process` in every export after it — which is what the past-due rows and
// the stale stock builds are. Marking it here is the missing half.
// ---------------------------------------------------------------------------

let completing = [];

/**
 * What to show where a production job shows its due date. T&M and internal jobs
 * have no schedule in the ERP - start and end are stamped the day the order is
 * raised - so their age is the only true thing to put in that column.
 */
const dueOrAge = (j) =>
  ((j.lane ?? 'production') === 'production' ? j.due_display : (j.age_display || '—'));

function openCompleteDialog(jobs) {
  // Stock is listed but starts unticked. Its ERP dates are written once and
  // never revised, so "past its end date" says nothing about whether the work
  // is done — every stock build on the 21/08 export is months past a date that
  // was never meant to hold. Ticking it by default would sweep live work off
  // the board. Customer orders are the opposite: a passed date usually does
  // mean finished.
  completing = jobs.map((j) => ({ job: j, ticked: !j.is_stock }));

  // A side-lane job has no due date worth the name - the ERP stamps start and
  // end to the day it was raised - so say how long it has been open instead.
  const one = jobs[0];
  const when = one && (one.lane ?? 'production') === 'production'
    ? `due ${one.due_display}`
    : `open ${one?.age_display || 'since it was raised'}`;
  $('completeLede').textContent = jobs.length === 1
    ? `${one.prod_no} — ${jobTitle(one)}, ${when}.`
    : `${jobs.length} jobs are past their end date and still open. Untick anything `
      + `still in the shop. Stock builds start unticked — their dates are set once `
      + `and never revised, so a passed date says nothing about them.`;

  renderCompleteList();
  $('completeOverlay').classList.add('show');
}

function renderCompleteList() {
  const host = $('completeList');
  host.textContent = '';
  for (const entry of completing) {
    const { job } = entry;
    const row = el('label', 'c-row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = entry.ticked;
    box.addEventListener('change', () => { entry.ticked = box.checked; updateCompleteCount(); });
    row.append(box);
    row.append(el('span', 'c-prod', job.prod_no));
    row.append(el('span', 'c-name', jobTitle(job)));
    row.append(el('span', 'c-cat', job.category));
    row.append(el('span', 'c-due', dueOrAge(job)));
    host.append(row);
  }
  updateCompleteCount();
}

function updateCompleteCount() {
  const n = completing.filter((e) => e.ticked).length;
  $('completeCount').textContent = `${n} of ${completing.length} ticked`;
  $('completeConfirm').disabled = n === 0;
}

async function confirmComplete() {
  const picked = completing.filter((e) => e.ticked).map((e) => e.job.prod_no);
  if (!picked.length) return;
  $('completeConfirm').disabled = true;
  try {
    // The snapshot travels with the completion so History can render this job
    // long after the ERP stops exporting it.
    const snaps = Object.fromEntries(
      completing.filter((e) => e.ticked).map((e) => [e.job.prod_no, snapshotOf(e.job)]));
    await Store.setCompleted(picked, true, Auth.user?.email, snaps);
    state.overrides = await Store.loadOverrides();
    $('completeOverlay').classList.remove('show');
    rebuild();
    toast(`${picked.length} marked complete. Reopen from History if that was wrong.`);
  } catch (e) {
    toast(`Could not save — ${e.message}`, 6000);
  } finally {
    $('completeConfirm').disabled = false;
  }
}

function renderFitStatus() {
  const f = state.fit;
  const box = $('fitStatus');
  box.textContent = '';
  box.classList.toggle('trimmed', Boolean(f.trimmedFrom));

  const range = state.board.meta.horizon_end
    ? `${toAU(toDateOnly(state.board.meta.as_of))} — ${toAU(toDateOnly(state.board.meta.horizon_end))}`
    : 'no horizon';

  box.append(el('span', null, `Covering `), el('b', null, range));
  box.append(el('span', null, `·`));
  const printed = state.board.meta.print_count;
  const total = state.board.meta.job_count;
  const rows = el('b', null, `${printed} of ${total} jobs`);
  rows.title = total === printed ? ''
    : `${total - printed} on the board but off the sheet — watermakers, `
      + 'work past the horizon, or stock beyond the cap';
  box.append(rows);
  box.append(el('span', null, `·`));

  if (!state.settings.autoFit) {
    box.append(el('span', null, f.fits ? 'fits one page' : `${f.pages} pages — auto-fit is off`));
  } else if (f.trimmedFrom) {
    box.append(el('span', null, 'Auto-fit reduced the horizon from '));
    box.append(el('b', null, `${f.trimmedFrom} weeks to ${f.weeks}`));
    box.append(el('span', null, ' to hold one page. The printed header shows the covered range.'));
  } else if (f.fits) {
    box.append(el('span', null, `fits one page at ${f.weeks} weeks`));
  } else {
    box.append(el('span', null,
      `will not fit one page even at ${f.weeks} weeks (${f.pages} pages). ` +
      `Lower the stock cap, or hide some jobs.`));
  }
}

// ---------------------------------------------------------------------------
// new vessel codes
//
// Upstream does not manage these consistently — `56` was an office shorthand
// for 56SY, and Riviera call the same boat both 56SY and 5000SY. So a code the
// map has never seen is never auto-accepted: the board would print a guess and
// nobody would know it was one. Each is queued and answered on import.
// ---------------------------------------------------------------------------

let ncQueue = [];
let ncIndex = 0;
// What this run has changed, newest last, so Cancel can put it all back.
// Answering one item from its own row is a run of one; "Resolve all" is a run
// of many. Same machinery either way.
let ncUndo = [];

/**
 * Everything an import needs answered, in order. Vessel codes first: accepting
 * one changes labels, and a custom job asked about beforehand could be asked
 * again about a different name.
 */
function queueImportQuestions() {
  if (!Auth.isManager) return;
  const codes = state.board?.warnings?.newCodes ?? [];
  if (codes.length) { startCodeRun(codes); return; }
  queueCustomNames();
}

/** Begin a resolve run over `items` — one of them, or all of them. */
function startCodeRun(items) {
  ncQueue = items;
  ncIndex = 0;
  ncUndo = [];
  showNewCode();
}

function endCodeRun({ chain = true } = {}) {
  ncQueue = [];
  ncUndo = [];
  $('newCodeOverlay').classList.remove('show');
  rebuild();                   // a new code can rename jobs, so ask from the rebuilt board
  flushDeferredRebuild();
  if (chain) queueCustomNames();
}

/** Put back every code accepted during this run, newest first. */
async function cancelCodeRun() {
  const undone = ncUndo.length;
  for (const { code, before } of [...ncUndo].reverse()) {
    if (before) { state.codeMap[code] = before; await Store.saveCode(code, before); }
    else { delete state.codeMap[code]; await Store.deleteCode(code); }
  }
  endCodeRun({ chain: false });
  toast(undone ? `Undone — ${undone} code${undone > 1 ? 's' : ''} put back.` : 'Nothing to undo.');
}

function showNewCode() {
  const item = ncQueue[ncIndex];
  if (!item) { endCodeRun(); return; }

  // Only meaningful mid-run. Resolving a single row has nothing to skip and
  // nothing to abandon — Decide later already closes it.
  const more = ncQueue.length > 1;
  $('ncSkipRest').hidden = !more;
  $('ncCancelRun').hidden = !more;
  $('ncSkipRest').textContent = `Skip the remaining ${ncQueue.length - ncIndex - 1}`;
  $('ncCancelRun').textContent = ncUndo.length
    ? `Cancel & undo ${ncUndo.length}` : 'Cancel';

  $('ncProgress').textContent = ncQueue.length > 1 ? `${ncIndex + 1} of ${ncQueue.length}` : '';
  $('ncLede').textContent =
    `This export carries ${item.count} job(s) under a vessel code the board has `
    + `never seen. Choose what the floor should read.`;

  const d = $('ncDerived');
  d.textContent = '';
  const row = (k, v) => {
    const r = el('div', 'row');
    r.append(el('span', null, k), el('span', null, v || '—'));
    d.append(r);
  };
  row('Item codes', item.items.join('  ·  '));
  row('Stella code', item.code);
  row('Riviera model', item.riviera.join(', '));
  row('Hull prefix', item.hull_prefix.join(', '));
  row('Description', item.descriptions[0] ?? '');

  // What each choice would actually print, using the real template for the
  // first item — a preview beats a description of a preview.
  const preview = (display) => {
    const fake = { [item.code]: { display, _confirmed: true, riviera: item.riviera } };
    return labelFor(item.items[0], null, fake) ?? display;
  };

  $('ncStella').textContent = item.code;
  $('ncStellaPreview').textContent = preview(item.code);

  const riv = item.suggestion.riviera;
  $('ncRivOpt').hidden = !riv;
  if (riv) {
    $('ncRiv').textContent = riv;
    $('ncRivPreview').textContent = preview(riv);
  }

  const sel = $('ncExisting');
  sel.textContent = '';
  for (const b of existingBoats(state.codeMap)) {
    const o = document.createElement('option');
    o.value = b.boat;
    o.textContent = `${b.display}  (${b.codes.join(', ')})`;
    sel.append(o);
  }

  $('ncCustom').value = '';
  $('newCodeOverlay').classList.add('show');
}

async function chooseNewCode(mode) {
  const item = ncQueue[ncIndex];
  const choice = { mode };
  if (mode === 'existing') choice.boat = $('ncExisting').value;
  if (mode === 'custom') {
    choice.value = $('ncCustom').value.trim();
    if (!choice.value) { toast('Enter a code, or choose another option.'); return; }
  }

  const entry = acceptNewCode(item.code, choice, item);
  ncUndo.push({ code: item.code, before: state.codeMap[item.code] ?? null });
  state.codeMap[item.code] = entry;
  await Store.saveCode(item.code, entry);
  // Restage per answer, not only when the queue empties: the import review is
  // sitting behind this dialog and a resolved code should leave its list as
  // soon as it is resolved.
  restage();

  const shown = mode === 'existing'
    ? `${item.code} joined ${$('ncExisting').selectedOptions[0].textContent.trim()}`
    : `${item.code} will print as "${entry.display}"`;
  toast(shown);

  ncIndex += 1;
  showNewCode();
}

function wireNewCode() {
  for (const b of document.querySelectorAll('#newCodeOverlay [data-mode]')) {
    b.addEventListener('click', () => chooseNewCode(b.dataset.mode));
  }
  $('ncCustom').addEventListener('keydown', (e) => { if (e.key === 'Enter') chooseNewCode('custom'); });
  $('ncSkip').addEventListener('click', () => { ncIndex += 1; showNewCode(); });
  $('ncSkipRest').addEventListener('click', () => endCodeRun({ chain: false }));
  $('ncCancelRun').addEventListener('click', cancelCodeRun);
}

// ---------------------------------------------------------------------------
// the side lanes - internal factory jobs and T&M
//
// Deliberately NOT the board view with a different filter. These jobs have no
// vessel, no meaningful due date and no place on the printed sheet, so a row
// built around "vessel / due / print" would be three empty columns and a lie.
//
// What they do have is an age. The ERP stamps start and end to the day the
// order is raised and nobody revises it, so the honest question is how long a
// job has been open - and the answer runs to nearly a year on two of them.
// ---------------------------------------------------------------------------

const LANE_VIEW = {
  internal: {
    list: 'internalList', count: 'internalCount', order: INTERNAL_CATEGORY_ORDER,
    empty: 'No internal factory jobs open. Sub-assemblies built for stock appear here.',
  },
  tm: {
    list: 'tmList', count: 'tmCount', order: TM_CATEGORY_ORDER,
    empty: 'No time & materials jobs open.',
  },
};

function renderLane(lane) {
  const cfg = LANE_VIEW[lane];
  const host = $(cfg.list);
  host.textContent = '';
  const rows = (state.board?.[lane] ?? []).filter((j) => !j.completed);
  const shown = rows.filter((j) => !j.hidden);

  $(cfg.count).textContent = shown.length
    ? `${shown.length} open${rows.length !== shown.length ? ` \u00b7 ${rows.length - shown.length} hidden` : ''}`
    : '';

  if (!rows.length) { host.append(el('div', 'state', cfg.empty)); return; }

  const byCat = new Map(cfg.order.map((c) => [c, []]));
  for (const j of rows) {
    if (!byCat.has(j.category)) byCat.set(j.category, []);
    byCat.get(j.category).push(j);
  }

  for (const cat of byCat.keys()) {
    const list = byCat.get(cat) ?? [];
    if (!list.length) continue;

    const key = `lane:${lane}:${cat}`;
    const shut = collapsed.has(key);
    const blk = el('div', `cat${shut ? ' is-collapsed' : ''}`);

    const head = el('button', 'cat-head');
    head.setAttribute('aria-expanded', String(!shut));
    head.append(el('span', 'cat-caret', shut ? '\u25b8' : '\u25be'));
    head.append(el('h2', null, cat));
    head.append(el('span', 'n', String(list.length)));
    head.addEventListener('click', () => {
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      saveCollapsed(collapsed);
      renderLane(lane);
    });
    blk.append(head);

    if (!shut) {
      const table = el('div', 'lane-table');
      const hdr = el('div', 'lane-row lane-head');
      hdr.append(el('span', null, 'Prod Nbr'), el('span', null, 'Job'),
        el('span', null, lane === 'tm' ? 'For' : 'Item'),
        el('span', null, 'Open'), el('span', null, ''));
      table.append(hdr);
      for (const j of list) table.append(laneRow(j, lane));
      blk.append(table);
    }
    host.append(blk);
  }
}

function laneRow(j, lane) {
  const row = el('div', `lane-row${j.hidden ? ' is-hidden' : ''}${j.on_hold ? ' is-held' : ''}`);
  row.append(el('span', 'prod', j.prod_no));

  const name = el('span', 'label');
  name.append(document.createTextNode(jobTitle(j)));
  if (j.on_hold) name.append(el('span', 'flag', 'ON HOLD'));
  if (j.label !== j.base_label) name.append(el('span', 'edited', 'EDITED'));
  row.append(name);

  row.append(el('span', 'who', lane === 'tm'
    ? (j.customer_display + (j.project ? ` \u00b7 ${j.project}` : ''))
    : j.inventory_id));

  // Age, not a due date. `unscheduled` means the ERP stamped start and end the
  // same day, which is every T&M row in the export - "9 months" is true,
  // "due 07/11/2025" would not be.
  const age = el('span', 'age', j.age_display || '\u2014');
  age.title = j.opened_display
    ? `Raised ${j.opened_display}${j.unscheduled ? ' \u2014 the ERP has no schedule for this job' : ''}`
    : '';
  if ((j.age_days ?? 0) > 180) age.classList.add('is-stale');
  row.append(age);

  const acts = el('span', 'acts');
  const lbl = el('button', 'mini', 'Label');
  lbl.addEventListener('click', () => openLabelEditor(j));
  const hide = el('button', 'mini', j.hidden ? 'Unhide' : 'Hide');
  hide.addEventListener('click', () => (j.hidden ? unhide(j) : openHideDialog(j)));
  const done = el('button', 'mini', 'Done');
  done.title = 'Mark completed \u2014 reversible from History';
  done.addEventListener('click', () => openCompleteDialog([j]));
  acts.append(lbl, hide, statusControl(j), done);
  row.append(acts);
  return row;
}

// ---------------------------------------------------------------------------
// the import tab
//
// An upload used to be a single irreversible act: drop the file and the board
// changed under whoever else was looking at it. This stages it instead - the
// rows are parsed, the result is described, and nothing is committed until the
// manager applies it. It is also where everything the import is unsure about is
// gathered, rather than scattered across warning panels after the fact.
// ---------------------------------------------------------------------------

let staged = null;      // { src, board } - parsed, not committed

const IMPORT_DETAIL = {
  production: { label: 'production orders', lane: 'production' },
  internal:   { label: 'internal factory jobs', lane: 'internal' },
  tm:         { label: 'time & materials jobs', lane: 'tm' },
  excluded:   { label: 'rows excluded', lane: null },
};
let importOpenDetail = null;
const importOpenConcerns = new Set();
// Groups inside an opened count. Shut by default on the excluded list, which
// runs to four figures — scrolling past 730 completed rows to reach the next
// heading is not a sanity check, it is an obstacle.
const importShutGroups = new Set();

/**
 * Rebuild the staged board in place.
 *
 * Resolving a vessel code or naming a custom job while staged changes what the
 * import WOULD produce, so the review has to be rebuilt from the same rows
 * before it is read again. Called from `rebuild`, so every existing edit path
 * feeds it without having to know the import page exists.
 */
function restage() {
  if (!staged) return;
  staged.board = buildBoard(staged.src.rows, {
    codeMap: state.codeMap,
    asOf: today(),
    overrides: state.overrides,
    itemOverrides: state.itemOverrides,
    maxStock: state.settings.maxStock,
    horizonWeeks: state.settings.horizonWeeks,
  });
  if (state.importPage) renderImport();
}

function renderImport() {
  const host = $('importHost');
  host.textContent = '';
  $('dropZone').hidden = Boolean(staged);

  if (!staged) {
    if (state.source) {
      host.append(el('div', 'import-current',
        `Currently loaded: ${state.source.sourceLabel ?? 'an export'} \u2014 `
        + `${state.board?.meta?.row_count ?? 0} rows, `
        + `${state.board?.meta?.job_count ?? 0} production orders. `
        + 'Drop a new export above to replace it.'));
    }
    return;
  }

  const b = staged.board;
  const box = el('div', 'import-review');
  box.append(el('h2', null, 'Review this import'));
  box.append(el('div', 'lede',
    `${staged.src.sourceLabel} \u2014 ${staged.src.rows.length} rows from the `
    + `"${staged.src.sheetName}" sheet. Nothing changes until you apply it.`));

  // What an import does and does not touch. Worth saying on the page rather
  // than only in the README: the word "import" reads like "replace".
  box.append(el('div', 'import-scope',
    'An import replaces the ERP rows only. Everything decided here \u2014 labels, '
    + 'vessel codes, hidden jobs, hand-set statuses and completed work \u2014 is '
    + 'keyed on the production number and survives it. Completed jobs stay in '
    + 'History even once the ERP stops exporting them.'));

  // --- counts, each one openable ---
  const grid = el('div', 'import-stats');
  const stat = (key, n, note) => {
    const c = el('button', `stat${importOpenDetail === key ? ' is-open' : ''}`);
    c.append(el('b', null, String(n)), el('span', null, IMPORT_DETAIL[key].label));
    if (note) c.append(el('em', null, note));
    c.append(el('span', 'stat-more', importOpenDetail === key ? 'Hide' : 'Show all'));
    c.addEventListener('click', () => {
      importOpenDetail = importOpenDetail === key ? null : key;
      renderImport();
    });
    grid.append(c);
  };
  stat('production', b.meta.job_count, `${b.meta.print_count} on the printed sheet`);
  stat('internal', b.meta.internal_count);
  stat('tm', b.meta.tm_count);
  stat('excluded', b.excluded.length, 'by status or category');
  box.append(grid);

  if (importOpenDetail) box.append(importDetail(b, importOpenDetail));

  // --- concerns, itemised ---
  const concerns = importConcerns(b, staged.src);
  const total = concerns.reduce((n, c) => n + c.rows.length, 0);
  if (total) {
    const list = el('div', 'import-flags');
    list.append(el('h3', null, `Items of concern (${total})`));
    for (const c of concerns) list.append(concernBlock(c));
    box.append(list);
  } else {
    box.append(el('div', 'import-clean',
      'Nothing outstanding \u2014 every row classified cleanly.'));
  }

  const acts = el('div', 'import-actions');
  const apply = el('button', 'primary', 'Apply this import');
  apply.addEventListener('click', commitImport);
  const cancel = el('button', 'ghost', 'Cancel');
  cancel.addEventListener('click', () => {
    staged = null; renderImport(); toast('Import cancelled \u2014 nothing changed.');
  });
  acts.append(apply, cancel);
  if (total) {
    acts.append(el('span', 'hint',
      'You can apply with these outstanding \u2014 they will still be waiting on the board.'));
  }
  box.append(acts);
  host.append(box);
}

/** One collapsible concern: a heading, and every item under it with its fix. */
function concernBlock(c) {
  const open = importOpenConcerns.has(c.id) || c.rows.length <= 3;
  const wrap = el('div', `flag flag-${c.level}${open ? ' is-open' : ''}`);

  const bar = el('div', 'flag-bar');

  const head = el('button', 'flag-head');
  head.setAttribute('aria-expanded', String(open));
  head.append(el('span', 'flag-caret', open ? '\u25be' : '\u25b8'));
  // The count leads. On the right it was the last thing read on a line whose
  // whole point is "how many of these are there".
  head.append(el('span', 'flag-n', `${c.rows.length}\u00d7`));
  head.append(el('b', null, c.title));
  head.addEventListener('click', () => {
    if (importOpenConcerns.has(c.id)) importOpenConcerns.delete(c.id);
    else importOpenConcerns.add(c.id);
    renderImport();
  });
  bar.append(head);

  // One button for the whole list, where a row's own button does only that row.
  if (c.resolveAll && c.rows.length > 1) {
    const all = el('button', 'mini', `Resolve all ${c.rows.length}`);
    all.addEventListener('click', c.resolveAll);
    bar.append(all);
  }
  wrap.append(bar);

  if (c.note) wrap.append(el('div', 'flag-note', c.note));
  if (!open) return wrap;

  const table = el('div', 'flag-rows');
  for (const r of c.rows) {
    const row = el('div', 'flag-row');
    row.append(el('span', 'fr-key', r.key));
    row.append(el('span', 'fr-main', r.main));
    row.append(el('span', 'fr-detail', r.detail ?? ''));
    const act = el('span', 'fr-act');
    if (r.control) act.append(r.control());
    else if (r.action) {
      const btn = el('button', 'mini', r.action.label);
      btn.addEventListener('click', r.action.run);
      act.append(btn);
    }
    row.append(act);
    table.append(row);
  }
  wrap.append(table);
  return wrap;
}

/**
 * Everything the import cannot settle on its own, one row per thing, each with
 * the control that settles it.
 *
 * These all write to records keyed on a vessel code or a production number, not
 * to the export, so they can be answered BEFORE the import is applied and are
 * still right afterwards. That is the whole reason the review can be useful
 * rather than merely informative.
 */
function importConcerns(b, src) {
  const out = [];
  const many = (n, one, more) => (n === 1 ? one : more);

  const problems = (src.warnings ?? []).filter((w) => !w.startsWith('Note:'));
  if (problems.length) {
    out.push({
      id: 'export', level: 'bad',
      title: `Export ${many(problems.length, 'problem', 'problems')}`,
      note: 'The board will be incomplete or wrong until the ERP inquiry is fixed.',
      rows: problems.map((w, i) => ({ key: `#${i + 1}`, main: w })),
    });
  }

  const nc = b.warnings.newCodes ?? [];
  if (nc.length) {
    out.push({
      id: 'codes', level: 'bad',
      title: `Unknown vessel ${many(nc.length, 'code', 'codes')}`,
      note: 'These print their raw ERP description until somebody says what the floor should read.',
      rows: nc.map((n) => ({
        key: n.code,
        main: `${n.count} ${many(n.count, 'job', 'jobs')}`,
        detail: n.items.join(', '),
        // One row, one code. Marching through the whole queue from a single
        // row's button was the wrong promise for a button that names one thing.
        action: { label: 'Resolve', run: () => startCodeRun([n]) },
      })),
      resolveAll: () => startCodeRun(nc),
    });
  }

  const cn = b.warnings.customNames ?? [];
  if (cn.length) {
    out.push({
      id: 'custom', level: 'warn',
      title: `Custom ${many(cn.length, 'job', 'jobs')} with no clear name`,
      note: 'Neither the Description nor the Customer column reads as a boat.',
      rows: cn.map((j) => ({
        key: j.prod_no,
        main: jobTitle(j),
        detail: j.name_options?.description.raw || 'no description',
        action: { label: 'Resolve', run: () => startNameRun([j]) },
      })),
      resolveAll: () => startNameRun(cn),
    });
  }

  const un = b.warnings.unmapped ?? [];
  if (un.length) {
    // The only concern here with no in-app fix: a category rule is code.
    const byCode = new Map();
    for (const e of un) {
      if (!byCode.has(e.inventory_id)) byCode.set(e.inventory_id, []);
      byCode.get(e.inventory_id).push(e);
    }
    out.push({
      id: 'unmapped', level: 'bad',
      title: `Unmapped item ${many(byCode.size, 'code', 'codes')}`,
      note: 'Off the board entirely until a prefix rule exists in js/rules.js. '
        + 'This one needs a developer, not a decision.',
      rows: [...byCode].map(([code, rows]) => ({
        key: code,
        main: `${rows.length} ${many(rows.length, 'row', 'rows')}`,
        detail: rows[0].description,
      })),
    });
  }

  const held = b.warnings.onHold ?? [];
  if (held.length) {
    out.push({
      id: 'hold', level: 'warn',
      title: `On hold, but showing on the board`,
      note: 'Confirm these before the floor starts them, or set them straight here.',
      rows: held.map((j) => ({
        key: j.prod_no,
        main: jobTitle(j),
        detail: j.status_manual ? 'put on hold here' : `ERP says On Hold \u00b7 due ${j.due_display}`,
        control: () => statusControl(j),
      })),
    });
  }

  // A stock build booked as a component part reads as production, because the
  // lane rule keys on Type. SDC0287, the davit rope kit, is the standing
  // example. The rule cannot tell; a person can.
  const oddStock = (b.jobs ?? []).filter((j) => j.is_stock && j.is_component);
  if (oddStock.length) {
    out.push({
      id: 'oddstock', level: 'warn',
      title: `Stock ${many(oddStock.length, 'build', 'builds')} booked as a component part`,
      note: 'On the production board because the ERP calls them Finished Good. '
        + 'Check whether they are really internal work \u2014 hide one here if it should not be on the board.',
      rows: oddStock.map((j) => ({
        key: j.prod_no,
        main: jobTitle(j),
        detail: j.inventory_id,
        action: { label: j.hidden ? 'Unhide' : 'Hide', run: () => (j.hidden ? unhide(j) : openHideDialog(j)) },
      })),
    });
  }

  // "Will not print" is deliberately NOT here. A watermaker has no column on
  // the sheet and a job past the horizon is not yet due — both by construction,
  // neither a thing to decide. The count strip already says how many print, and
  // the production detail marks each one.
  return out;
}

/**
 * One collapsible group inside an opened count. Shut state is per session, not
 * saved: which part of a one-off import listing you were reading says nothing
 * worth remembering.
 */
function appendGroup(wrap, key, title, n, body, { shutByDefault = false } = {}) {
  const shut = importShutGroups.has(key)
    || (shutByDefault && !importShutGroups.has(`open:${key}`));

  const head = el('button', `detail-group${shut ? ' is-shut' : ''}`);
  head.setAttribute('aria-expanded', String(!shut));
  head.append(el('span', 'dg-caret', shut ? '\u25b8' : '\u25be'));
  head.append(el('span', 'dg-name', title));
  head.append(el('span', 'dg-n', String(n)));
  head.addEventListener('click', () => {
    if (shut) { importShutGroups.delete(key); importShutGroups.add(`open:${key}`); }
    else { importShutGroups.add(key); importShutGroups.delete(`open:${key}`); }
    renderImport();
  });
  wrap.append(head);
  if (!shut) wrap.append(body);
}

/** The full contents of one count, so "69 production orders" can be checked. */
function importDetail(b, key) {
  const wrap = el('div', 'import-detail');
  const cfg = IMPORT_DETAIL[key];

  if (key === 'excluded') {
    wrap.append(el('h3', null, `Every excluded row (${b.excluded.length})`));
    wrap.append(el('div', 'flag-note',
      'Not on any tab. A sanity check on what the rules are throwing away.'));
    const table = el('div', 'flag-rows');
    // Grouped by reason so like sits with like, commonest first.
    const byReason = new Map();
    for (const e of b.excluded) {
      if (!byReason.has(e.reason)) byReason.set(e.reason, []);
      byReason.get(e.reason).push(e);
    }
    for (const [reason, rows] of [...byReason].sort((a, b2) => b2[1].length - a[1].length)) {
      const t = el('div', 'flag-rows');
      for (const e of rows) {
        const row = el('div', 'flag-row');
        row.append(el('span', 'fr-key', e.prod_no));
        row.append(el('span', 'fr-main', e.inventory_id));
        row.append(el('span', 'fr-detail', e.description || e.item_description || ''));
        row.append(el('span', 'fr-act', ''));
        t.append(row);
      }
      appendGroup(wrap, `excl:${reason}`, reason, rows.length, t, { shutByDefault: true });
    }
    return wrap;
  }

  const jobs = key === 'production'
    ? (b.jobs ?? []).filter((j) => !j.completed)
    : (b[cfg.lane] ?? []).filter((j) => !j.completed);
  wrap.append(el('h3', null, `Every ${cfg.label.replace(/s$/, '')} (${jobs.length})`));

  const order = key === 'production' ? CATEGORY_ORDER
    : key === 'tm' ? TM_CATEGORY_ORDER : INTERNAL_CATEGORY_ORDER;
  const byCat = new Map(order.map((c) => [c, []]));
  for (const j of jobs) {
    if (!byCat.has(j.category)) byCat.set(j.category, []);
    byCat.get(j.category).push(j);
  }

  for (const [cat, rows] of byCat) {
    if (!rows.length) continue;
    const t = el('div', 'flag-rows');
    for (const j of rows) {
      const row = el('div', `flag-row${isPrintable(j) || key !== 'production' ? '' : ' is-offpaper'}`);
      row.append(el('span', 'fr-key', j.prod_no));
      row.append(el('span', 'fr-main', jobTitle(j)));
      row.append(el('span', 'fr-detail', key === 'production'
        ? j.due_display
        : `${j.customer_display ?? ''}${j.age_display ? ` \u00b7 open ${j.age_display}` : ''}`));
      row.append(el('span', 'fr-act', key === 'production' && !isPrintable(j) ? 'no print' : ''));
      t.append(row);
    }
    appendGroup(wrap, `${key}:${cat}`, cat, rows.length, t);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// naming a custom one-off
//
// `Description` carries the boat on most custom rows and something else
// entirely on the rest — "5% drawing fee", where the real answer is the
// customer. The transform reads both columns and says when it is guessing; this
// puts the guess to the manager instead of printing it. The answer is a plain
// job label override, keyed on the production number, so it syncs and survives
// the next upload like any other relabel.
// ---------------------------------------------------------------------------

let cnQueue = [];
let cnIndex = 0;
let cnUndo = [];

function queueCustomNames() {
  if (!Auth.isManager) return;
  const pending = state.board?.warnings?.customNames ?? [];
  if (!pending.length) return;
  startNameRun(pending);
}

function startNameRun(items) {
  cnQueue = items;
  cnIndex = 0;
  cnUndo = [];
  showCustomName();
}

function endNameRun() {
  cnQueue = [];
  cnUndo = [];
  $('customNameOverlay').classList.remove('show');
  flushDeferredRebuild();
}

/** Put back every name set during this run. */
async function cancelNameRun() {
  const undone = cnUndo.length;
  for (const { prodNo, before } of [...cnUndo].reverse()) {
    await setOverride(prodNo, { labelOverride: before ?? null });
  }
  endNameRun();
  toast(undone ? `Undone — ${undone} name${undone > 1 ? 's' : ''} put back.` : 'Nothing to undo.');
}

function showCustomName() {
  const job = cnQueue[cnIndex];
  if (!job) { endNameRun(); return; }
  const o = job.name_options;

  const more = cnQueue.length > 1;
  $('cnSkipRest').hidden = !more;
  $('cnCancelRun').hidden = !more;
  $('cnSkipRest').textContent = `Skip the remaining ${cnQueue.length - cnIndex - 1}`;
  $('cnCancelRun').textContent = cnUndo.length ? `Cancel & undo ${cnUndo.length}` : 'Cancel';

  $('cnProgress').textContent = cnQueue.length > 1 ? `${cnIndex + 1} of ${cnQueue.length}` : '';
  $('cnLede').textContent =
    `${job.prod_no} is a custom one-off, and neither column reads as a boat. `
    + `Choose what the floor should see.`;

  const d = $('cnDerived');
  d.textContent = '';
  const row = (k, v) => {
    const r = el('div', 'row');
    r.append(el('span', null, k), el('span', null, v || '—'));
    d.append(r);
  };
  row('Production number', job.prod_no);
  row('Item code', job.inventory_id);
  row('Production description', job.description);
  row((job.lane ?? 'production') === 'production' ? 'Due' : 'Open', dueOrAge(job));

  // An empty column is not an option. Offering "Use the Description" on a blank
  // cell would print "Custom Lifter - " and look like a bug.
  $('cnDescOpt').hidden = !o.description.label;
  if (o.description.label) {
    $('cnDescRaw').textContent = `"${o.description.raw}"`;
    $('cnDescPreview').textContent = o.description.label;
  }
  $('cnCustRaw').textContent = o.customer.raw ? `"${o.customer.raw}"` : '—';
  $('cnCustPreview').textContent = o.customer.label;

  // Prefilled with the prefix rather than the guess: the convention stays
  // visible and editable, and "Use this" is never a silent duplicate of the
  // customer option.
  $('cnCustom').value = CUSTOM_PREFIX;
  $('customNameOverlay').classList.add('show');
}

async function chooseCustomName(mode) {
  const job = cnQueue[cnIndex];
  const o = job.name_options;
  const label = mode === 'description' ? o.description.label
    : mode === 'customer' ? o.customer.label
      : $('cnCustom').value.trim();
  if (isEmptyCustomName(label)) { toast('Type a name, or choose a column.'); return; }

  cnUndo.push({ prodNo: job.prod_no, before: state.overrides[job.prod_no]?.labelOverride ?? null });
  await setOverride(job.prod_no, { labelOverride: label });
  toast(`${job.prod_no} will read "${label}"`);

  cnIndex += 1;
  showCustomName();
}

function wireCustomName() {
  for (const b of document.querySelectorAll('#customNameOverlay [data-mode]')) {
    b.addEventListener('click', () => chooseCustomName(b.dataset.mode));
  }
  $('cnCustom').addEventListener('keydown', (e) => { if (e.key === 'Enter') chooseCustomName('custom'); });
  $('cnSkip').addEventListener('click', () => { cnIndex += 1; showCustomName(); });
  $('cnSkipRest').addEventListener('click', endNameRun);
  $('cnCancelRun').addEventListener('click', cancelNameRun);
}

// ---------------------------------------------------------------------------
// label editing — scope first
//
// Editing a label and editing a vessel code are different things and the UI
// must not conflate them. "Just this job" replaces the whole label on one
// production order. "Every job for this vessel" edits the display code alone,
// which then flows through the product wording template, and applies across
// the whole alias group.
// ---------------------------------------------------------------------------

let editing = null;

function openLabelEditor(job) {
  editing = job;
  const code = /CUSTOM/i.test(job.inventory_id) ? null : stellaCode(job.inventory_id);
  const onABoat = Boolean(code && state.codeMap[code]);

  $('lblTitle').textContent = `Edit label — ${job.prod_no}`;
  $('lblLede').textContent = `Currently "${job.label}" · ${job.inventory_id}`;

  $('lblScope').hidden = false;
  $('lblScopeActions').hidden = false;
  $('lblForm').hidden = true;

  // Scope 2 — this product, forever. Always available: even a davit or a chock
  // with no vessel code can need its label pinned.
  const sameItem = state.board.jobs.filter((j) => j.inventory_id === job.inventory_id).length;
  $('scopeItemHint').textContent =
    `Pins the label to ${job.inventory_id} — ${sameItem} job(s) on this board, and `
    + `every future order for it. Use this when the item code names one boat but `
    + `the part is built to the drawings of another.`;

  // Scope 3 — every product on this boat.
  $('scopeCode').hidden = !onABoat;
  if (onABoat) {
    const group = state.board.resolved.groups.find((g) => g.codes.includes(code));
    const n = state.board.jobs.filter((j) => group.codes.includes(stellaCode(j.inventory_id) ?? '')).length;
    $('scopeCodeHint').textContent =
      `Changes the display code for boat ${group.boat ?? group.codes[0]} `
      + `(${group.codes.join(' / ')}) — ${n} job(s) here, and every future one. `
      + `The product wording ("Garage Door", "Launcher") is kept.`;
  }

  $('labelOverlay').classList.add('show');
}

function showLabelForm(scope) {
  const job = editing;
  const code = stellaCode(job.inventory_id);
  const pinned = state.itemOverrides[job.inventory_id];

  $('lblScope').hidden = true;
  $('lblScopeActions').hidden = true;
  $('lblForm').hidden = false;
  $('lblForm').dataset.scope = scope;
  $('lblReset').hidden = true;

  if (scope === 'job') {
    $('lblFieldLabel').textContent = 'Label for this job';
    $('lblInput').value = job.label;
    $('lblHint').textContent =
      `Replaces the whole label on ${job.prod_no} only. Saved against the `
      + `production number, so it survives the next upload.`;
    $('lblReset').hidden = job.label === job.base_label;

  } else if (scope === 'item') {
    // A vessel-coded item gets a code (the template still supplies the wording);
    // anything else — davits, chocks — has no code, so it gets a whole label.
    if (code) {
      $('lblFieldLabel').textContent = `Display code for ${job.inventory_id}`;
      $('lblInput').value = pinned?.displayCode
        ?? state.board.resolved.display.get(code) ?? code;
      $('lblHint').textContent =
        `Just the vessel code — the product wording is added by the template, so `
        + `"56SY" becomes "${applyTemplate(job.inventory_id, '56SY')}". Applies to `
        + `this item code only, on every future order.`;
    } else {
      $('lblFieldLabel').textContent = `Label for ${job.inventory_id}`;
      $('lblInput').value = pinned?.label ?? job.base_label;
      $('lblHint').textContent =
        `This item has no vessel code, so this is the whole label. Applies to `
        + `${job.inventory_id} on every future order.`;
    }
    $('lblReset').hidden = !pinned;

  } else {
    const group = state.board.resolved.groups.find((g) => g.codes.includes(code));
    $('lblFieldLabel').textContent = `Display code for boat ${group.boat ?? group.codes[0]}`;
    $('lblInput').value = state.board.resolved.display.get(code) ?? code;
    $('lblHint').textContent =
      `Applies to ${group.codes.join(', ')} — every product on this boat. `
      + `An item that needs to differ from its boat should use the item scope `
      + `instead.`;
  }
  $('lblInput').focus();
  $('lblInput').select();
}

function wireOverlays() {
  wireNewCode();
  wireCustomName();
  $('scopeJob').addEventListener('click', () => showLabelForm('job'));
  $('scopeItem').addEventListener('click', () => showLabelForm('item'));
  $('scopeCode').addEventListener('click', () => showLabelForm('code'));
  $('lblScopeCancel').addEventListener('click', closeLabel);
  $('lblCancel').addEventListener('click', closeLabel);
  $('lblSave').addEventListener('click', saveLabel);
  $('lblInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveLabel(); });
  $('lblReset').addEventListener('click', async () => {
    const scope = $('lblForm').dataset.scope;
    const job = editing;
    if (scope === 'item') {
      await setItemOverride(job.inventory_id, { label: null, displayCode: null });
      toast(`${job.inventory_id} back to the code of its boat.`);
    } else {
      await setOverride(job.prod_no, { labelOverride: null });
      toast(`${job.prod_no} label reset.`);
    }
    closeLabel();
  });

  $('completeCancel').addEventListener('click', () => {
    $('completeOverlay').classList.remove('show');
    flushDeferredRebuild();
  });
  $('completeConfirm').addEventListener('click', confirmComplete);
  $('completeAll').addEventListener('click', () => { completing.forEach((e) => { e.ticked = true; }); renderCompleteList(); });
  $('completeNone').addEventListener('click', () => { completing.forEach((e) => { e.ticked = false; }); renderCompleteList(); });

  $('hideCancel').addEventListener('click', () => {
    $('hideOverlay').classList.remove('show');
    flushDeferredRebuild();
  });
  $('hideSave').addEventListener('click', saveHide);

  for (const id of ['labelOverlay', 'hideOverlay', 'completeOverlay']) {
    $(id).addEventListener('click', (e) => {
      if (e.target.id === id) { $(id).classList.remove('show'); flushDeferredRebuild(); }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $('labelOverlay').classList.remove('show');
    $('hideOverlay').classList.remove('show');
    $('completeOverlay').classList.remove('show');
    flushDeferredRebuild();
  });
}

async function saveLabel() {
  const value = $('lblInput').value.trim();
  if (!value) { toast('That cannot be empty.'); return; }
  const scope = $('lblForm').dataset.scope;
  const job = editing;

  if (scope === 'job') {
    await setOverride(job.prod_no, { labelOverride: value });
    toast(`${job.prod_no} relabelled.`);

  } else if (scope === 'item') {
    const code = stellaCode(job.inventory_id);
    const patch = code ? { displayCode: value, label: null } : { label: value, displayCode: null };
    await setItemOverride(job.inventory_id, patch);
    toast(code
      ? `${job.inventory_id} now prints "${applyTemplate(job.inventory_id, value)}".`
      : `${job.inventory_id} now prints "${value}".`);

  } else {
    const code = stellaCode(job.inventory_id);
    const group = state.board.resolved.groups.find((g) => g.codes.includes(code));
    // Confirming one member confirms the boat — the group displays as one.
    for (const c of group.codes) {
      state.codeMap[c] = { ...(state.codeMap[c] ?? {}), display: value, _confirmed: true };
      await Store.saveCode(c, { display: value, _confirmed: true });
    }
    rebuild();
    toast(`Boat ${group.boat ?? group.codes[0]} (${group.codes.join(', ')}) now displays "${value}".`);
  }
  closeLabel();
}

async function setItemOverride(inventoryId, patch) {
  const next = { ...(state.itemOverrides[inventoryId] ?? {}), ...patch };
  for (const k of ['label', 'displayCode']) if (next[k] === null) delete next[k];
  if (next.label || next.displayCode) state.itemOverrides[inventoryId] = next;
  else delete state.itemOverrides[inventoryId];

  await Store.setItemOverride(inventoryId, patch);
  rebuild();
}

function closeLabel() {
  $('labelOverlay').classList.remove('show');
  editing = null;
  flushDeferredRebuild();
}

// ---------------------------------------------------------------------------
// hide / show
// ---------------------------------------------------------------------------

let hiding = null;

function openHideDialog(job) {
  hiding = job;
  $('hideLede').textContent = (job.lane ?? 'production') === 'production'
    ? `${job.prod_no} — ${jobTitle(job)}, due ${job.due_display}.`
    : `${job.prod_no} — ${jobTitle(job)}, open ${job.age_display || 'since it was raised'}.`;
  $('hideReason').value = '';
  $('hideOverlay').classList.add('show');
  $('hideReason').focus();
}

async function saveHide() {
  await setOverride(hiding.prod_no, { hidden: true, hiddenReason: $('hideReason').value.trim() || null });
  $('hideOverlay').classList.remove('show');
  toast(`${hiding.prod_no} hidden from the printed board.`);
  hiding = null;
}

async function unhide(job) {
  await setOverride(job.prod_no, { hidden: false, hiddenReason: null });
  toast(`${job.prod_no} back on the board.`);
}

async function setOverride(prodNo, patch) {
  const next = { ...(state.overrides[prodNo] ?? {}), ...patch };
  if (patch.labelOverride === null) delete next.labelOverride;
  if (patch.status === null) { delete next.status; delete next.statusFrom; }
  if (next.hidden === false) { delete next.hidden; delete next.hiddenReason; }
  if (Object.keys(next).length) state.overrides[prodNo] = next;
  else delete state.overrides[prodNo];

  await Store.setOverride(prodNo, patch);
  rebuild();
}

// ---------------------------------------------------------------------------

// Which categories are rolled up. A device preference, not a shared setting —
// it says nothing about the work, so it does not belong in Firestore, and a
// write per toggle would be needlessly chatty.
const COLLAPSE_KEY = 'stella.board.collapsed';
const loadCollapsed = () => {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')); }
  catch { return new Set(); }
};
const saveCollapsed = (set) => {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch {}
};
let collapsed = loadCollapsed();

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
