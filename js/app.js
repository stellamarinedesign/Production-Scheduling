// app.js — the manager view. Upload, review, edit, print.

import { xlsxAdapter } from './adapters/index.js';
import { buildBoard, byCategory, today, toAU, toDateOnly, jobTitle, CUSTOM_PREFIX,
         isEmptyCustomName, snapshotOf, isPrintable, printJobs, retainedRows,
         diffBoards } from './transform.js';
import { CATEGORY_ORDER, PRINT_LAYOUT, EXCLUSION_ORDER, EXCLUSION_GROUP_LABEL,
         TM_CATEGORY_ORDER, INTERNAL_CATEGORY_ORDER, LANE_LABEL, WATERMAKER_CATEGORIES,
         SETTABLE_STATUSES, ERP_CLOSER, isPartOrder } from './rules.js';
import { stellaCode, labelFor, existingBoats, acceptNewCode, applyTemplate,
  setBuilders, buildersConfigured } from './vessel-codes.js';
import { Auth, ROLE, setManagers, setEngineers, setMasters, setTesters, tidyEmail } from './auth.js';
import { standing } from './access.js';
import { signInForm, focusSignIn, readAccess, notListed, offerManager, watchRole } from './sign-in.js';
import { savedCopyAllowed, hubNote } from './hub-bridge.js';
import { prefs, showTestMode, isNotAvailable, NOT_AVAILABLE, isTestMode, carryFlag } from './test-mode.js';
import { VERSION } from './version.js';
import { wireHelp } from './help.js';
import { davitsByBoat, mergeDavits } from './davits.js';
import { itemFacts, mergeItemFacts } from './vessel-codes.js';
import { closeOnBackdrop, closeOnEscape, keepFocus, watchDialogs, whenClosed } from './dialog.js';
import { toast, toastFailed, unsay } from './toast.js';
import { count, failure, reason } from './words.js';
import { refuse, accept } from './field.js';
import { faultLine, setFault, clearFault, notDone, carries } from './faults.js';
import { wireSettings } from './settings.js';
import { openPackageDialog } from './package-dialog.js';
import { plinthControl } from './plinth-control.js';
import { isDavit, PLINTHS_KEY } from './plinths.js';
import { describeOverride, describeItemOverride, activityEntry, ACTION, lastChanged } from './activity.js';
import { renderActivityLog, touchedCell, loadedEntries, forgetActivityLog } from './activity-log.js';
import { Store, packRows, unpackRows, isNewerImport } from './store.js';
import { renderPrint, fitWarehouse, renderWatermakers, measure, fitToPage, fitHorizon, pageRule,
         WAREHOUSE_PAPER, renderLanePrint, fitLaneToPage } from './print.js';
import { renderGantt } from './gantt.js';
import { balanceColumns } from './print.js';
import { openItemHistory, logImportChanges, wireChangeRow } from './item-history.js';
import { createReview } from './import-review.js';
import { startup, keepWatch, deviceCache, recallSession, rememberSession, forgetDevice, hold, isHeld } from './boot.js';
import { isConfigured } from './firebase.js';
import './press.js';
import { boardHead, createdCell, createdNote, poNote, erpNote, whenWords, historyColumns, historyHead, historyRowClass } from './board-columns.js';
import { collapseScope, anyShut, toggleAll, historyKey, toggleRow } from './collapse.js';
import { floorBoard, floorSignature } from './floor-board.js';

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
// Every per-device preference goes through `prefs` (test-mode.js): the real
// values at start, and while the board is in test mode changes kept in memory.
const GANTT_KEY = 'stella.board.ganttView';
function loadGanttPrefs() {
  try { return { packed: false, all: false, ...JSON.parse(prefs.get(GANTT_KEY) ?? '{}') }; }
  catch { return { packed: false, all: false }; }
}
const saveGanttPrefs = (v) => prefs.set(GANTT_KEY, JSON.stringify(v));

// Whether part orders - numbered parts on customer orders - are on the board.
// A view of the moment, so per device, like the paper; see rules.js isPartOrder.
const PART_ORDERS_KEY = 'stella.board.partOrders';
const loadShowPartOrders = () => prefs.get(PART_ORDERS_KEY) !== 'hidden';
const saveShowPartOrders = (on) => prefs.set(PART_ORDERS_KEY, on ? 'shown' : 'hidden');

// The paper the warehouse copy prints on, and whether the board takes its
// watermaker page: properties of the printer at hand and of the moment, so
// remembered per device rather than shared with the other managers.
const WAREHOUSE_PAPER_KEY = 'stella.board.warehousePaper';
const loadWarehousePaper = () => {
  // The paper used to apply to every sheet, under its own key. A value from
  // then says nothing about the warehouse copy, so it is dropped, not read.
  prefs.remove('stella.board.paper');
  const p = prefs.get(WAREHOUSE_PAPER_KEY);
  return WAREHOUSE_PAPER[p] ? p : 'a4';
};
const saveWarehousePaper = (p) => prefs.set(WAREHOUSE_PAPER_KEY, p);
const WATER_PAGE_KEY = 'stella.board.watermakerPage';
const loadWaterPage = () => prefs.get(WATER_PAGE_KEY) === 'on';
const saveWaterPage = (on) => prefs.set(WATER_PAGE_KEY, on ? 'on' : 'off');

const PUBLISHED_KEY = 'stella.board.publishedAt';
const publishedAt = () => prefs.get(PUBLISHED_KEY) ?? '';
const markPublished = (at) => prefs.set(PUBLISHED_KEY, at ?? '');

// Jobs an import took off the board whose History record the server has not
// confirmed. Once the export has let a job go this device is the only place it
// is, so they are kept here until it has.
const UNFILED_KEY = 'stella.board.unfiled';
const loadUnfiled = () => {
  try { return JSON.parse(prefs.get(UNFILED_KEY) ?? '{}') ?? {}; } catch { return {}; }
};
const saveUnfiled = (m) => (Object.keys(m).length ? prefs.set(UNFILED_KEY, JSON.stringify(m)) : prefs.remove(UNFILED_KEY));

// The questions an import has asked on this device, so each is asked once; the
// panel on the board is the reminder after that.
const ASKED_KEY = 'stella.board.asked';
const loadAsked = () => {
  try { return new Set(JSON.parse(prefs.get(ASKED_KEY) ?? '[]')); } catch { return new Set(); }
};
const saveAsked = (set) => prefs.set(ASKED_KEY, JSON.stringify([...set]));

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
  // Which list the Print tab is previewing. Follows the tab you came from, so
  // the print button prints what you were just looking at.
  printLane: 'production',
  warehousePaper: loadWarehousePaper(),   // 'a4' | 'a3', see WAREHOUSE_PAPER in print.js
  waterPage: loadWaterPage(),             // the board's second page, watermakers
  showPartOrders: loadShowPartOrders(),
  board: null,
  fit: null,
};

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

/**
 * Say what boot is doing, or take the notice away.
 *
 * Boot is a handful of network round trips and on a slow connection they add
 * up. An empty page during that is indistinguishable from a broken one - which
 * is precisely how it was being read - so the shell always says something.
 *
 * @param {string|false} what  a step to show, or false when the board is up
 */
function booting(what) {
  const box = document.getElementById('booting');
  if (!box) return;
  if (what === false) { box.remove(); document.getElementById('bootSkeleton')?.remove(); return; }
  const line = document.getElementById('bootWhat');
  if (line) line.textContent = what;
}

// Start-up, watched: a time limit on each step, a retry on fresh connections,
// and the offline line. See boot.js.
const watch = startup();

// While the board on screen is the copy saved on the device, nothing on it
// can be changed (Pete, 23 Nov 2026): every control that writes, Print board
// included, with "Latest board not yet loaded" beside them.
const BOARD_EDITS = [
  '#importNav', '#completePastDue', '#horizon', '#maxStock', '#autoFit', '#printBtn',
  '#warnings button', '#warnings select', '#provShare button', '.fault button',
  '.acts button:not(.more)', '.acts select', '.acts input', '.acts-more button', '.acts-more select', '.acts-more input',
].join(', ');
let releaseHold = null;
// The account and role the saved copy was drawn for, or null when nothing was.
let savedFor = null;

(async function boot() {
  wireAuth();
  watchDialogs();
  whenClosed(flushDeferredRebuild);
  showTestMode();

  // THE DEVICE FIRST. The copy this device last loaded is drawn while sign-in
  // is restored, which is a round trip or two at best and a minute at worst.
  const early = drawSaved().catch((e) => { console.warn('[saved]', e.message); return null; });
  watch.step('sign-in');
  const mode = await Auth.init(async (st) => {
    const saved = await early;
    // The hub's full-screen card is up: it is the answer, with nothing behind it.
    if (st.role === ROLE.NONE && Auth.hubCard) { await forget(); watch.done(); $('appShell').hidden = true; return; }
    const other = saved && st.role !== ROLE.NONE && tidyEmail(st.email) !== saved.email;
    if (st.role === ROLE.NONE || other) {
      // Signed out, or somebody else: nothing saved stays for them, and a page
      // drawn for the last account starts again. Should it not (it reloaded
      // itself a moment ago), somebody signed in goes on from here.
      if (await startAgain(saved)) return;
      if (st.role === ROLE.NONE) { watch.done(); showAuth(); return; }
    }
    await start(st);
  }, { forget });
  // A configured board whose SDK did not load: the page starts again on fresh
  // connections, once, and says so after that.
  if (mode === 'failed') watch.retry();
})();

/**
 * The board as this device last had it, drawn before anything has answered.
 *
 * Only for an account this device has seen, and only with everything the
 * board is built from: a manager's needs the rows, settings, codes and
 * overrides; the floor's the published jobs. Local mode has all of it on the
 * device already and skips this.
 *
 * @returns {Promise<{email: string, role: string}|null>} who it was drawn for
 */
async function drawSaved() {
  // Test mode writes nothing to the device, so what it would remember of this
  // session could never replace what is there; it loads from the server.
  if (!isConfigured() || isTestMode()) return null;
  const session = await recallSession();
  if (!session) return null;
  // Signed out of the hub since, or somebody else is signed in to it here.
  if (!savedCopyAllowed(hubNote(), session.email)) { await forget(); return null; }
  const { email, role } = session;
  const manager = role === ROLE.MANAGER || role === ROLE.TESTER;
  let data = null;
  if (manager) {
    const board = await deviceCache.get('board');
    const rows = Store.cachedRows();
    if (!board?.settings || !rows?.rows?.length) return null;
    data = { ...board, rows };
  } else if (role === ROLE.FLOOR) {
    data = await deviceCache.get('floor');
    if (!data?.jobs?.length) return null;
  } else if (role !== ROLE.ENGINEER) {
    return null;
  }

  Auth.assume(email, role);
  if ((await Store.init()) !== 'firestore') return null;
  showTestMode();
  present({ role, email, mode: 'firebase' });
  watch.saved();

  if (manager) {
    enterManager(data);
    releaseHold = hold(BOARD_EDITS);
    state.rows = data.rows.rows;
    state.source = data.rows.source;
    rebuild();
    showImportPage(false);
  } else if (role === ROLE.FLOOR) {
    showFloor(data);
  } else {
    $('engineerHome').hidden = false;
  }
  booting(false);
  savedFor = { email: tidyEmail(email), role };
  return savedFor;
}

/**
 * Forget what this device holds and load the page afresh: the sign-in came
 * back as nobody or as somebody else, or the role is not the one the saved
 * copy was drawn for. False when the tab reloaded itself moments ago, so a
 * device that cannot forget never reloads in a loop; the page goes on as it is.
 */
async function startAgain(saved) {
  await forget();
  return Boolean(saved) && window.__boot?.reloadOnce?.() === true;
}

/** Forget what this device holds: the saved copies (boot.js) and the board's rows. */
async function forget() {
  await forgetDevice();
  Store.clearCache();
}

/** The role on the page: what is drawn, and the account in the header. */
function present(st) {
  document.body.classList.toggle('role-floor', st.role === ROLE.FLOOR);
  document.body.classList.toggle('role-engineer', st.role === ROLE.ENGINEER);
  document.body.classList.toggle('role-manager', Auth.isManager);
  const who = $('whoami');
  who.textContent = st.mode === 'local' ? 'Local mode' : (st.email ?? '');
  // The role chip is for an admin alone: nobody else reads that there are roles
  // (Pete, 26 Nov 2026). Drawn again when the lists arrive (refreshRole).
  if (st.mode === 'local' || !Auth.isMaster) return;
  const chip = el('span', `role ${Auth.isManager ? 'manager' : ''}`,
    Auth.isManager ? 'MANAGER' : st.role === ROLE.ENGINEER ? 'ENGINEER' : 'FLOOR');
  who.append(chip);
}

// Whose page this is: the account it was first started for.
let pageFor = null;

/**
 * A PAGE IS ONE ACCOUNT'S. Its board, its listeners and what is in its memory
 * are whoever's it was started for, so signing out, or in as somebody else,
 * loads it afresh, with nothing left on the device either. It used to be
 * handed on: the next account went on in the last one's board.
 */
async function afresh() {
  $('appShell').hidden = true;
  await forgetDevice();
  Store.clearCache();
  location.reload();
}

function showAuth() {
  if (pageFor !== null) { afresh(); return; }
  $('authView').classList.add('show');
  $('appShell').hidden = true;
  focusSignIn();
}

/** The access lists, as the server gave them, wherever they are asked about. */
function takeAccess(access) {
  setManagers(access.managers);
  setEngineers(access.engineers);
  setMasters(access.masters);
  setTesters(access.testers);
  state.access = access;
}

let started = false;
let roleWatched = false;
/** First run: nobody is a manager yet, so this account may become one. See sign-in.js. */
function offerBootstrap(email) {
  offerManager($('floorEmpty'), email, async (access) => {
    takeAccess(access);
    await start({ role: Auth.refreshRole(), email, mode: 'firebase' });
    toast('You are now a manager on this board.');
  });
}

let storeReady = false;

// ON A REPEAT OPEN THE BOARD IS ASKED FOR BESIDE THE ACCESS LISTS, not after
// them: the role the saved copy was drawn for is the likeliest answer, and the
// rules refuse the reads to anybody it turns out not to be. A different answer
// drops them and starts the page again, as it always has.
let early = null;
function dropEarly() {
  early = null;
  for (const stop of unsubscribes.splice(0)) { try { stop(); } catch { /* gone already */ } }
}

async function start(st) {
  if (pageFor !== null && pageFor !== tidyEmail(st.email)) { await afresh(); return; }
  pageFor = tidyEmail(st.email);
  $('authView').classList.remove('show');
  $('appShell').hidden = false;

  // THE STORE COMES UP BEFORE THE ROLE IS READ. The manager list is in
  // Firestore rather than in the shipped JavaScript, and Firebase reports the
  // signed-in user before the store exists — so the role Auth first hands us is
  // always FLOOR, whoever signed in. Load the list, then ask again.
  if (!storeReady) {
    storeReady = true;
    booting('Connecting');
    watch.step('connect');
    await Store.init();
    if (Store.mode === 'firestore' && savedFor?.role === ROLE.MANAGER) early = loadBoardData();
    else if (Store.mode === 'firestore' && savedFor?.role === ROLE.FLOOR) early = watchFloor();
    early?.catch(() => {});
    booting('Checking your access');
    watch.step('access', 'firestore');
    takeAccess(await readAccess(watch));
  }
  // Called again while the lists are still being read: that call goes on.
  if (!state.access) return;
  st = { ...st, role: Auth.refreshRole() };
  // Drawn for this role; drawn again if Hubinator changes it (sign-in.js).
  if (Auth.mode === 'firebase' && !roleWatched) { roleWatched = true; watchRole(st.email, state.access); }

  // ON NO LIST, OR NO LISTS. Neither goes any further, and nothing of a board
  // stays on the screen or on the device. The two used to look alike, and so
  // did a read that had failed (see Store.loadAccess): an account nobody had
  // listed was offered the board.
  const stands = Auth.mode === 'firebase' ? standing(state.access, st.email) : 'listed';
  if (stands !== 'listed') {
    dropEarly();
    if (await startAgain(savedFor)) return;
    releaseHold?.();
    releaseHold = null;
    state.rows = null;
    state.source = null;
    hideBoard();
    $('engineerHome').hidden = true;
    present(st);
    $('whoami').textContent = st.email ?? '';      // without the chip: it has no role
    booting(false);
    watch.done();
    if (stands === 'missing') offerBootstrap(st.email);
    else notListed($('floorEmpty'), tidyEmail(st.email));
    return;
  }
  // The saved copy was drawn for a role. Another answer starts the page again
  // rather than rewiring it under the person holding it.
  if (savedFor && savedFor.role !== st.role) {
    dropEarly();
    if (await startAgain(savedFor)) return;
    // It reloaded itself a moment ago: go on in this page, as the role it is,
    // with nothing of the saved role's board left up. The role's own view is
    // drawn below (the floor's, the manager's); an engineer has none.
    releaseHold?.();
    releaseHold = null;
    hideBoard();
    $('engineerHome').hidden = true;
  }
  if (Auth.mode === 'firebase') rememberSession(st.email, st.role);
  // A tester is in test mode from here, flag or no flag; see test-mode.js.
  if (Auth.isTester) Store.enterTestMode();
  showTestMode();
  Store.setWriter(st.role === ROLE.MANAGER);

  // Role decides what is drawn. The Firestore rules decide what is allowed —
  // hiding a button is not security, it is tidiness.
  present(st);

  if (started) { rebuild(); return; }
  started = true;

  // Floor accounts read the last published board and render the printed sheet.
  // No upload, no controls, no edit affordances — that is the whole point of
  // the role, and the rules deny those writes regardless.
  if (st.role === ROLE.FLOOR) { await startFloor(); booting(false); return; }
  if (st.role === ROLE.ENGINEER) {
    $('engineerHome').hidden = false;
    // Help is in the header for an engineer too, and did nothing here.
    if (!engineerWired) { engineerWired = true; wireHelp({ admin: () => Auth.isMaster }); }
    booting(false);
    watch.done();
    return;
  }

  // ONE WAIT, ONE DOWNLOAD. Everything the board is built from arrives
  // together: in Firestore mode as the live listeners' first answers, which
  // is the load (see startLiveSync); in local mode from the store.
  booting('Loading the board');
  watch.step('board', 'firestore');
  let loaded;
  try {
    loaded = await (early ?? loadBoardData());
  } catch (e) {
    console.error('[board]', e);
    watch.fail();
    return;
  }
  // From here until the live sync takes over nothing else runs, so whatever
  // arrived while the packages were being read is in `loaded` already.
  enterManager(boardData(loaded));
  releaseHold?.();
  releaseHold = null;
  const settled = loadLastBoard(loaded.first.latest);
  liveApplied();
  booting(false);

  // The shell is up whether or not there is a board: the tab bar is how you
  // reach the Import tab, and the Import tab is where you go when there is
  // nothing loaded. It used to be hidden behind the drop zone, which meant the
  // only way to see the app was to already have data in it.
  showImportPage(!state.rows);
  watch.done();
  keepWatch({ what: 'Board', onLink: (cb) => Store.onLink(cb) });
  boardConfirmed = true;
  saveBoardCopy();
  await settled;
  checkFloor();
}

/**
 * The manager's board settings and controls, from what was loaded. Wired
 * once: the saved copy and the server's answer both come through here.
 */
let managerWired = false;
let engineerWired = false;
function enterManager({ settings, codeMap, overrides, itemOverrides, packages }) {
  state.settings = settings;
  // Before anything is built: no builders, no vessel codes. See vessel-codes.js.
  if (!setBuilders(settings.builders)) console.error('[codes] no boat builder in the board settings');
  state.codeMap = codeMap;
  state.overrides = overrides;
  state.itemOverrides = itemOverrides;
  // The packages, for the davits' rows: the plinth folder as last read, and
  // any plinth model a package names. A board without them still opens.
  state.packages = packages ?? {};
  state.plinths = state.packages[PLINTHS_KEY] ?? null;

  showSettings();

  $('provVersion').textContent = `v${VERSION}`;
  $('provStore').textContent = Store.mode === 'firestore' ? 'Saved for everyone' : 'Saved on this device only';
  $('provStore').style.color = Store.mode === 'firestore' ? '' : 'var(--red-bright)';

  if (managerWired) return;
  managerWired = true;
  wireHelp({ admin: () => Auth.isMaster });
  wireUpload();
  wireControls();
  wireRowTaps();
  wireOverlays();
}

/**
 * Everything the manager's board is built from, as the server first answers
 * it; in local mode the store's reads, which are the device.
 *
 * @returns {{first: {settings, codes, overrides, itemOverrides, latest}, packages, defaults}}
 *          `first` is the live sync's own object, so it carries anything that
 *          arrives after this resolves and before the board is applied.
 */
async function loadBoardData() {
  if (Store.mode !== 'firestore') {
    const [settings, codes, overrides, itemOverrides, packages, latest] = await Promise.all([
      Store.loadSettings(), Store.loadCodes(), Store.loadOverrides(), Store.loadItemOverrides(),
      Store.loadPackages().catch(() => ({})), Store.latestBoard().catch(() => null),
    ]);
    return { first: { settings, codes, overrides, itemOverrides, latest }, packages, defaults: settings };
  }
  const [first, packages] = await Promise.all([startLiveSync(), Store.loadPackages().catch(() => ({}))]);
  // The defaults, and the builders from the private file when the settings
  // name none (a local scratch copy); see Store.boardSettings.
  const named = first.settings?.builders;
  const defaults = await Store.boardSettings(named?.length ? { builders: named } : {});
  return { first, packages, defaults };
}

/** What loadBoardData read, as enterManager takes it, read at the moment of use. */
function boardData({ first, packages, defaults }) {
  const settings = { ...defaults, ...first.settings };
  if (!settings.builders?.length) settings.builders = defaults.builders;
  return { settings, codeMap: first.codes, overrides: first.overrides, itemOverrides: first.itemOverrides, packages };
}

/**
 * Keep what the board was built from on the device, for the next open to
 * draw at once. Only what the server has confirmed: written once the board
 * has loaded, and again a moment after each change that reached it.
 */
let boardConfirmed = false;
let copyTimer = null;
function saveBoardCopy() {
  if (!boardConfirmed || Store.mode !== 'firestore') return;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    deviceCache.set('board', {
      settings: state.settings,
      codeMap: state.codeMap,
      overrides: state.overrides,
      itemOverrides: state.itemOverrides,
      packages: state.packages ?? {},
    });
  }, 1000);
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

const dialogOpen = () => Boolean(document.querySelector('.overlay.show'));

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

/**
 * Watch everything shared, and resolve with each source's first answer from
 * the server: that answer IS the board's load, so nothing is read twice.
 *
 * Until the board has been built from it (`liveApplied`), an arrival is part
 * of the load and goes into the object this resolves with; after that, the
 * same callbacks apply changes as they always have.
 */
let liveLoaded = false;
let liveApplied = () => {};
function startLiveSync() {
  if (Store.mode !== 'firestore') return Promise.resolve(null);
  const first = {};
  const waiting = new Set(['overrides', 'itemOverrides', 'codes', 'settings', 'latest']);
  let settle;
  let refuse;
  const loaded = new Promise((resolve, reject) => { settle = resolve; refuse = reject; });
  liveApplied = () => { liveLoaded = true; };
  const loading = (name, value, meta) => {
    if (liveLoaded) return false;
    first[name] = value;
    if (meta.confirmed) waiting.delete(name);
    if (!waiting.size) settle(first);
    return true;
  };
  const failed = (e) => { if (!liveLoaded) refuse(e); };

  unsubscribes.push(Store.watchOverrides((o, meta) => {
    if (loading('overrides', o, meta)) return;
    state.overrides = o;
    scheduleRebuild();
  }, failed));

  unsubscribes.push(Store.watchItemOverrides((o, meta) => {
    if (loading('itemOverrides', o, meta)) return;
    state.itemOverrides = o;
    scheduleRebuild();
  }, failed));

  unsubscribes.push(Store.watchCodes((m, meta) => {
    if (loading('codes', m, meta)) return;
    state.codeMap = m;
    scheduleRebuild();
  }, failed));

  unsubscribes.push(Store.watchSettings((v, meta) => {
    if (loading('settings', v, meta)) return;
    // Board settings are shared on purpose: every manager should be looking at
    // the same horizon. Skip the echo of our own write so the slider does not
    // jump while it is being dragged.
    if (meta.fromSelf) return;
    const before = JSON.stringify(state.settings);
    state.settings = { ...state.settings, ...v };
    if (JSON.stringify(state.settings) === before) return;
    setBuilders(state.settings.builders);
    showSettings();
    scheduleRebuild();
  }, failed));

  unsubscribes.push(Store.watchLatestImport((rec, meta) => {
    if (loading('latest', rec, meta)) return;
    // NEWER, not merely different — see `isNewerImport`.
    if (meta.fromSelf || !isNewerImport(rec, state.source?.retrievedAt)) return;
    const rows = unpackRows(rec.rowsJson);
    if (!rows?.length) return;
    state.rows = rows;
    state.source = sourceOf(rec);
    state.share = null;                        // the board in hand is the shared one
    Store.cacheRows(rows, state.source);
    markPublished(rec.retrievedAt);
    scheduleRebuild();
    toastNewer(rec);
  }, failed));

  return loaded;
}

/** Where a published board came from, as `state.source` keeps it. */
const sourceOf = (rec) => ({
  sourceId: rec.sourceId,
  sourceLabel: rec.sourceLabel,
  retrievedAt: rec.retrievedAt,
  uploadedBy: rec.uploadedBy ?? null,
  warnings: [],
});

/** The board on screen was replaced by a newer export. */
function toastNewer(rec) {
  toast(rec.uploadedBy && rec.uploadedBy !== Auth.user?.email
    ? `New export uploaded by ${rec.uploadedBy} — board updated.`
    : 'Board updated from a newer export.', 5000);
}

// A reviewed import not yet applied, or an edit the server does not have yet
// because there is no connection, would go with the page: the browser asks.
window.addEventListener('beforeunload', (e) => {
  const link = Store.link();
  const unsent = link.unsent && (link.lost || navigator.onLine === false);
  if (staged || unsent) e.preventDefault();
});
window.addEventListener('pagehide', (e) => {
  if (e.persisted) return;                    // kept, and shown again as it was
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
 *
 * @param published  the newest import record, as the server answered (null: none)
 */
async function loadLastBoard(published) {
  const cached = Store.cachedRows();
  // The saved copy on screen, if one was drawn: a newer export replacing it
  // says so, as a newer export arriving later always has.
  const shownAt = savedFor ? (state.source?.retrievedAt ?? null) : null;

  const publishedRows = published?.rowsJson ? unpackRows(published.rowsJson) : null;
  const localAt = cached?.source?.retrievedAt ?? '';
  const remoteAt = published?.retrievedAt ?? '';

  let pick = null;
  if (cached?.rows?.length && (!publishedRows?.length || localAt >= remoteAt)) {
    pick = { rows: cached.rows, source: cached.source };
  } else if (publishedRows?.length) {
    pick = { rows: publishedRows, source: sourceOf(published) };
    // Keep it locally too, so a reload is instant and works offline.
    Store.cacheRows(pick.rows, pick.source);
  }

  if (!pick) {
    // Nothing local, and nothing usable published. Say which, because "drop the
    // export here" is wrong advice if a colleague already uploaded it.
    if (published && !publishedRows?.length) {
      $('dropZone').querySelector('strong').textContent =
        'A board was published, but without its source data';
      // Text, not markup: a file name and an address are not ours to trust.
      $('dropZone').querySelector('.hint').textContent =
        `${published.sourceLabel ?? 'An export'} was published`
        + `${published.uploadedBy ? ` by ${published.uploadedBy}` : ''}, but before the app `
        + `stored the raw rows alongside it. Whoever has the file need only open `
        + `their board once and it will be shared automatically — or drop it here.`;
    }
    return;
  }

  state.rows = pick.rows;
  state.source = pick.source;
  // This device holds an export the others never got: an import that could not
  // be shared. Said until somebody shares it.
  if (Auth.isManager && Store.mode === 'firestore' && localAt > remoteAt && !isTestMode()) {
    state.share = { words: 'Not shared with the other managers.' };
  }
  rebuild();
  if (shownAt && (pick.source.retrievedAt ?? '') > shownAt) toastNewer(pick.source);
  retryUnfiled();
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
  if (needsRows) await shareBoard();
}

async function startFloor() {
  watch.step('board', 'firestore');
  const shownAt = state.source?.retrievedAt ?? '';
  let published;
  try {
    published = await (early ?? watchFloor());
    // Nothing kept up for the floor yet, or less than this device has already
    // shown: the newest import, as it was published.
    if (!published?.jobs?.length || (published.retrievedAt ?? '') < shownAt) published = await Store.latestBoard();
  } catch (e) {
    console.error('[floor]', e);
    watch.fail();
    return;
  }
  if (!published?.jobs?.length) {
    hideBoard();
    $('floorEmpty').hidden = false;
  } else {
    floorChanged(published, { first: true });
  }
  watch.done();
  keepWatch({ what: 'Board', onLink: (cb) => Store.onLink(cb) });
}

/** The floor's board, kept live. Resolves with the server's first answer: null when there is none yet. */
function watchFloor() {
  return new Promise((resolve, reject) => {
    let loaded = false;
    unsubscribes.push(Store.watchFloorBoard((rec, meta) => {
      if (loaded) { if (rec?.jobs?.length) floorChanged(rec); return; }
      if (!meta.confirmed) return;
      loaded = true;
      resolve(rec);
    }, (e) => { if (!loaded) reject(e); }));
  });
}

/**
 * Draw a floor board that differs from the one on screen, and keep it for the
 * next open. The server's first answer is taken as it is; after that nothing
 * goes back to an older export.
 */
function floorChanged(rec, { first = false } = {}) {
  const shown = state.board ? floorSignature({ jobs: floorShown, retrievedAt: state.source?.retrievedAt }) : null;
  const shownAt = state.source?.retrievedAt ?? '';
  if (!first && (rec.retrievedAt ?? '') < shownAt) return;
  if (floorSignature(rec) !== shown) keepFocus(() => showFloor(rec));
  if (shownAt && (rec.retrievedAt ?? '') > shownAt) toast('Board updated from a newer export.', 5000);
  if (Store.mode === 'firestore') deviceCache.set('floor', floorCopy(rec));
}

// ---- and the managers' side of it --------------------------------------------

let floorTimer = null;
let floorSent = null;       // the signature of what the floor was last given
let floorAt = '';           // and the export it was of

/** A moment after an edit the server has taken, so a run of them is one write. */
function shareFloorSoon() {
  if (Store.mode !== 'firestore' || !Auth.isManager || isTestMode()) return;
  clearTimeout(floorTimer);
  floorTimer = setTimeout(shareFloor, 1500);
}

/** Give the floor the board as it stands: every job, whatever this device has put away. */
async function shareFloor() {
  // A board the other managers do not have is not the floor's either.
  if (!state.rows || state.share) return;
  const rec = floorBoard(buildBoard(state.rows, {
    codeMap: state.codeMap, asOf: today(), overrides: state.overrides, itemOverrides: state.itemOverrides,
    maxStock: state.settings.maxStock, horizonWeeks: state.settings.horizonWeeks,
  }), state.source);
  const sig = floorSignature(rec);
  // Nor is an export older than the one the floor has.
  if (sig === floorSent || (rec.retrievedAt ?? '') < floorAt) return;
  try {
    await Store.saveFloorBoard(rec);
    floorSent = sig;
    floorAt = rec.retrievedAt ?? '';
    state.floorFault = null;
  } catch (e) {
    state.floorFault = failure('Floor screens not updated', e);
  }
  renderShare();
}

/** At the open: an edit whose moment never came - a tab shut, a connection lost - is made good. */
async function checkFloor() {
  if (Store.mode !== 'firestore' || !Auth.isManager || isTestMode()) return;
  try {
    const rec = await Store.loadFloorBoard();
    floorSent = floorSignature(rec);
    floorAt = rec?.retrievedAt ?? '';
  } catch (e) { console.warn('[floor]', e.message); return; }
  shareFloor();
}

/** What the floor keeps on the device: the published jobs, not the raw rows it never reads. */
const floorCopy = (p) => ({
  jobs: p.jobs, meta: p.meta ?? null, sourceLabel: p.sourceLabel ?? null, sourceId: p.sourceId ?? null,
  retrievedAt: p.retrievedAt ?? null, uploadedBy: p.uploadedBy ?? null,
});

/** A board drawn from the device that the server says is not there to show. */
function hideBoard() {
  $('boardWrap').hidden = true;
  $('provenance').hidden = true;
}

/** The floor's board: the published jobs, drawn as the manager's table cut to the printed columns. */
let floorWired = false;
let floorShown = [];
function showFloor(published) {
  floorShown = published.jobs;
  state.board = { jobs: published.jobs, meta: published.meta ?? {}, warnings: {}, excluded: [] };
  state.source = {
    sourceLabel: published.sourceLabel,
    sourceId: published.sourceId,
    retrievedAt: published.retrievedAt,
    warnings: [],
  };
  $('floorEmpty').hidden = true;
  $('provenance').hidden = false;
  $('boardWrap').hidden = false;
  renderProvenance();
  // The version stamp is how a stale copy is told apart from a missing fix,
  // and the floor's phones are where stale copies live.
  $('provVersion').textContent = `v${VERSION}`;
  $('provStore').textContent = Store.mode === 'firestore' ? 'Read-only' : 'Saved on this device only';
  // The same table the manager reads, cut to the printed columns: production
  // number, vessel, due date. It used to be the print preview — a picture of
  // an A4 page, which on a phone is a picture of an A4 page. Only the current
  // orders for now; the other lanes stay behind the manager's tabs.
  if (!floorWired) {
    floorWired = true;
    wireHelp({ admin: () => Auth.isMaster });
    wireRowTaps();
    wireCollapseAll();
  }
  renderBoard();
  showTab('edit');
}

function wireAuth() {
  $('signIn').append(signInForm());
  wireSettings($('settingsBtn'));
}

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

function wireUpload() {
  const zone = $('dropZone');
  const input = $('fileInput');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.target !== zone || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    input.click();
  });
  input.addEventListener('change', () => {
    const f = input.files[0];
    input.value = '';                         // so the same file can be picked twice
    if (f) load(f);
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) load(f);
  });

}

/** What the import page has to say of the file: being read, or why it was not. */
function importState(words, { bad = false } = {}) {
  const n = $('importState');
  n.textContent = words ?? '';
  n.classList.toggle('bad', bad);
  n.hidden = !words;
}

async function load(file) {
  // Without the builders every vessel code reads as none, and the review would
  // describe a board with every boat missing. Refused here and in `publish`.
  if (!buildersConfigured()) { importState(`${file.name} not loaded: ${NO_BUILDERS}.`, { bad: true }); return; }

  let src;
  importState(`Reading ${file.name}\u2026`);
  try {
    src = await xlsxAdapter.fetch({ file });
  } catch (e) {
    console.error(e);
    importState(`${file.name} not read: ${e.words ?? reason(e)}. The Production Order Maintenance export (.xlsx) is expected.`,
      { bad: true });
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
    console.error(e);
    importState(`${file.name} not loaded: no board could be built from its rows. Report it, with the file.`, { bad: true });
    return;
  }

  importState(null);
  showImportPage(true);
}

/** Commit the staged import: this is the point of no return. */
async function commitImport() {
  if (!staged) return;
  const { src } = staged;

  // THE ONE MOMENT BOTH LISTS EXIST. `retainedRows` drops closed rows before
  // buildBoard ever sees them, so a job the ERP has finished does not even
  // reach the excluded list - it simply stops being anywhere. Captured here,
  // on the way past, and written to History below.
  // Against nothing on a first import: every job is new, and logged as there
  // from the start.
  const diff = diffBoards(state.source ? state.board : null, staged.board, src.rows);
  const leaving = diff.leaving;

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
  queueImportQuestions({ all: true });

  // What the ERP moved on each job, and the jobs it added, into each job's
  // change history. After the commit and never awaited: see logImportChanges.
  logImportChanges(diff, { board: state.board, by: Auth.user?.email ?? 'local',
    importAt: state.source.retrievedAt, toast: toastFailed });

  // THREE SEPARATE WRITES, EACH WITH ITS OWN FAILURE, all at once: a tab shut
  // while they ran one after another lost whichever had not begun. They used
  // to share a try, so a share that was refused reported "could not read that
  // file", which points at the spreadsheet and hides that the board reached
  // nobody else.
  const orders = state.board.meta.job_count;
  const [shared, filed] = await Promise.all([
    shareBoard({ quiet: true }),
    // Work that came off the board goes to History rather than nowhere.
    //
    // It rides the same completion record a person makes by hand, because it is
    // the same kind of fact and History already knows how to render one. What it
    // carries that a hand-made one does not is WHY: the ERP's own closing status,
    // so a cancelled job is never filed as a finished one. Reopen puts it back.
    fileInHistory(Object.fromEntries(leaving.map((j) => [j.prod_no, {
      ...snapshotOf(j), closed_status: j.leaving_status, closed_why: j.leaving_why,
    }]))),
    learnFrom(src.rows),
  ]);
  // One closing word for the lot. What failed has its own, where it can be retried.
  // Saved on this device only, or in test mode, it reached nobody else.
  if (shared && filed) {
    const reach = Store.mode === 'firestore' && !isTestMode() ? 'imported and shared' : 'imported';
    toast(`Export ${reach}: ${count(orders, 'production order')}`
      + `${leaving.length ? `, ${count(leaving.length, 'job')} moved to History` : ''}.`, 6000);
  }
}

/**
 * Learn the davit fittings from the WHOLE file, the closed rows included: a
 * fitting is a fact about a boat, not about this week's work. The same
 * reasoning for the products themselves: hulls and descriptions accumulate, so
 * the code sheet is a total list rather than a view of what happens to be
 * open. Both come round again with the next import, so a failure is quiet.
 */
async function learnFrom(rows) {
  try {
    const [davits, facts] = await Promise.all([Store.loadDavits(), Store.loadItemFacts()]);
    await Promise.all([
      Store.saveDavits(mergeDavits(davits, davitsByBoat(rows))),
      Store.saveItemFacts(mergeItemFacts(facts, itemFacts(rows))),
    ]);
  } catch (e) {
    console.warn('[reference]', e.message);
  }
}

/**
 * Put jobs an import took off the board into History. On the device until the
 * server has them, and tried again at the next open if it never did.
 * @param {Object<string, Object>} snaps  prodNo -> the job as it was
 */
async function fileInHistory(snaps) {
  const keys = Object.keys(snaps);
  if (!keys.length) return true;
  saveUnfiled({ ...loadUnfiled(), ...snaps });
  const at = new Date().toISOString();
  const before = new Map(keys.map((k) => [k, state.overrides[k]]));
  for (const k of keys) {
    state.overrides[k] = { ...(state.overrides[k] ?? {}), completed: true, completedAt: at,
      completedBy: ERP_CLOSER, snapshot: snaps[k], touchedBy: ERP_CLOSER, touchedAt: at };
  }
  state.unfiled = null;
  rebuild();
  try {
    await Store.setCompleted(keys, true, ERP_CLOSER, snaps);
  } catch (e) {
    for (const k of keys) if (state.overrides[k]?.completedAt === at) putBack(k, before.get(k));
    state.unfiled = failure('Not moved to History', e);
    rebuild();
    toastFailed(`${count(keys.length, 'job')} not moved to History: ${reason(e)}.`);
    return false;
  }
  const left = loadUnfiled();
  for (const k of keys) delete left[k];
  saveUnfiled(left);
  return true;
}

/** At the next open: what an earlier import could not file, tried again. */
function retryUnfiled() {
  if (!Auth.isManager) return;
  const left = loadUnfiled();
  // Filed after all, or back in the export: no longer anything to do.
  const open = new Set([...(state.board?.jobs ?? []), ...(state.board?.internal ?? []), ...(state.board?.tm ?? [])].map((j) => j.prod_no));
  for (const k of Object.keys(left)) if (state.overrides[k]?.completed || open.has(k)) delete left[k];
  saveUnfiled(left);
  fileInHistory(left);
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

const NO_BUILDERS = 'no boat builder is set in the board settings';

/**
 * Share the board in hand with the other managers and the floor, and keep
 * saying so in the strip above the board until it has been: a board nobody
 * else can see looks exactly like one everybody can.
 */
async function shareBoard({ quiet = false } = {}) {
  state.share = { sharing: true };
  renderShare();
  const words = await publish(state.rows);
  state.share = words ? { words } : null;
  renderShare();
  if (words) toastFailed(words);
  else if (!quiet) toast('Board shared with the other managers.');
  return !words;
}

/** The sharing line: in progress, or why not, with the button that tries again. */
function renderShare() {
  const n = $('provShare');
  n.textContent = '';
  const s = state.share ?? (state.floorFault ? { words: state.floorFault, floor: true } : null);
  n.hidden = !s;
  if (!s) return;
  if (s.sharing) { n.append(el('span', null, 'Sharing\u2026')); return; }
  const again = el('button', 'mini', s.floor ? 'Retry' : 'Share board');
  again.addEventListener('click', () => (s.floor ? shareFloor() : shareBoard()));
  n.append(el('span', 'prov-bad', s.words), again);
}

/** @returns {Promise<string|null>} why it was not shared, in words, or null when it was */
async function publish(rows) {
  // The floor renders the published jobs as they are, so a board built without
  // vessel codes must not reach it.
  if (!buildersConfigured()) return `Not shared: ${NO_BUILDERS}.`;
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
    // The whole board: the Part orders toggle is how this device looks at it.
    const whole = state.showPartOrders ? state.board
      : buildBoard(rows, { codeMap: state.codeMap, asOf: today(), overrides: state.overrides,
        itemOverrides: state.itemOverrides, maxStock: state.settings.maxStock,
        horizonWeeks: state.fit?.weeks ?? state.settings.horizonWeeks });
    const size = utf8Bytes(packed) + utf8Bytes(JSON.stringify(whole.jobs ?? []));
    if (size > FIRESTORE_DOC_LIMIT * 0.9) {
      console.error('[publish] payload too large', size);
      return `Not shared: the export is too large, ${(size / 1048576).toFixed(2)} MB of 1 MB. `
        + 'Narrow the ERP inquiry and import it again.';
    }
    await Store.recordImport({
      retrievedAt: state.source.retrievedAt,
      sourceId: state.source.sourceId,
      sourceLabel: state.source.sourceLabel,
      horizonWeeks: state.fit?.weeks ?? state.settings.horizonWeeks,
      maxStock: state.settings.maxStock ?? null,
      // The full job list, not a summary: floor devices render from this and
      // never see the spreadsheet.
      jobs: whole.jobs,
      meta: whole.meta,
      uploadedBy: Auth.user?.email ?? null,
      // The raw export as well, so the OTHER manager picks up the same data
      // rather than being asked to upload the same file again. The jobs array
      // is a rendering of one horizon; the rows are what the transform needs to
      // re-render at another.
      rowsJson: packed,
    });
    markPublished(state.source.retrievedAt);
    shareFloorSoon();
    return null;
  } catch (e) {
    console.error('[publish]', e);
    return failure('Not shared with the other managers', e);
  }
}


// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

/**
 * On a narrow screen a row's controls are folded away; tapping the row opens
 * them.
 *
 * Delegated from the document so it survives every re-render without any
 * wiring in the render paths, and harmless on a desktop: the CSS that hides
 * the controls is behind a media query, so the class it toggles does nothing
 * at a width where they are already visible.
 */
/** Collapse all / expand all. Its own function because the floor path wires it too. */
function wireCollapseAll() {
  // It acts on what is in the board's place: the board's categories, or
  // History's while History is open (collapse.js).
  $('collapseAll').addEventListener('click', () => {
    toggleAll(boardFolds(), collapsed);
    saveCollapsed(collapsed);
    if (historyOpen.has('production')) renderHistory('production'); else renderBoard();
  });
  // Part orders in or out. The board is rebuilt rather than filtered, so the
  // Gantt, the sheet and its auto-fit all follow.
  $('partOrders').addEventListener('click', () => {
    state.showPartOrders = !state.showPartOrders;
    saveShowPartOrders(state.showPartOrders);
    // The floor has no rows to build from: its board is filtered instead.
    if (state.rows) rebuild(); else keepFocus(renderBoard);
  });
}

// The row opened to its controls, by production number, so a redraw after an
// edit - every edit redraws - puts it back the way it was (collapse.js).
const openRows = new Set();

// Once per page. Both boot paths call this, and a second listener would undo
// the first on every click - the row would open and shut in the same tap.
let rowTapsWired = false;
function wireRowTaps() {
  if (rowTapsWired) return;
  rowTapsWired = true;
  document.addEventListener('click', (e) => {
    const row = e.target.closest('.job, .lane-row, .hist-row');
    if (!row || row.classList.contains('col-head')) return;
    // A control inside the row is the thing being used, not the row itself -
    // otherwise opening the status select would also collapse what it sits in.
    if (e.target.closest('button, select, input, textarea, a, label')) return;
    // A drag to copy a number ends in a click too; that one is not a tap.
    if (window.getSelection?.()?.toString()) return;
    if (!row.querySelector('.acts button')) return;
    toggleRow(row, openRows);
  });
}

function wireControls() {
  const horizon = $('horizon');
  horizon.addEventListener('input', () => { $('horizonVal').textContent = count(Number(horizon.value), 'week'); });
  horizon.addEventListener('change', () => setBoardSetting('horizon', { horizonWeeks: Number(horizon.value) }));
  $('maxStock').addEventListener('change', (e) =>
    setBoardSetting('maxStock', { maxStock: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) }));
  $('autoFit').addEventListener('click', () => setBoardSetting('autoFit', { autoFit: !state.settings.autoFit }));

  for (const t of TABS) {
    const cap = t[0].toUpperCase() + t.slice(1);
    $(`tab${cap}Btn`).addEventListener('click', () => showTab(t));
  }
  $('importNav').addEventListener('click', () => showImportPage(true));
  $('boardNav').addEventListener('click', () => showImportPage(false));
  for (const b of document.querySelectorAll('[id^=history][data-lane]')) {
    b.addEventListener('click', () => toggleHistory(b.dataset.lane));
  }
  $('recentChanges').addEventListener('click', toggleRecent);

  $('completePastDue').addEventListener('click', () =>
    openCompleteDialog(state.board.warnings.pastDue ?? []));

  wireCollapseAll();

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
      renderGanttView({ arriving: true });
    });
  };
  ganttToggle('ganttPacked', 'packed');
  ganttToggle('ganttAll', 'all');
  $('printBtn').addEventListener('click', () => { showTab('print'); window.print(); });
  // Ctrl+P from another tab prints the sheet of the list being read, drawn for
  // the paper, as the Print tab would have: the preview otherwise holds whatever
  // it was last given.
  window.addEventListener('beforeprint', () => {
    if (state.tab !== 'print' && state.board && !state.importPage) renderPrintSheet();
  });
  for (const [key, cfg] of Object.entries(SHEET)) {
    $(cfg.btn).addEventListener('click', () => setPrintLane(key));
  }
  $('paperA4').addEventListener('click', () => setWarehousePaper('a4'));
  $('paperA3').addEventListener('click', () => setWarehousePaper('a3'));
  $('waterSheet').addEventListener('click', () => setWaterPage(!state.waterPage));
}

function setWarehousePaper(paper) {
  state.warehousePaper = WAREHOUSE_PAPER[paper] ? paper : 'a4';
  saveWarehousePaper(state.warehousePaper);
  if (state.tab === 'print') renderPrintSheet();
}

function setWaterPage(on) {
  state.waterPage = on;
  saveWaterPage(on);
  if (state.tab === 'print') renderPrintSheet();
}

/** The board's settings on their controls. */
function showSettings() {
  const { horizonWeeks, maxStock, autoFit } = state.settings;
  $('horizon').value = horizonWeeks;
  $('horizonVal').textContent = count(horizonWeeks, 'week');
  $('maxStock').value = maxStock ?? '';
  const b = $('autoFit');
  b.textContent = autoFit ? 'Auto-fit on' : 'Auto-fit off';
  b.classList.toggle('on', autoFit);
  b.setAttribute('aria-pressed', String(autoFit));
}

/**
 * A setting every manager shares: the sheet redraws at once and the write
 * follows. Refused, the control goes back and says why under itself.
 */
async function setBoardSetting(id, patch) {
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, state.settings[k]]));
  const line = $(id).closest('.ctrl').querySelector('.ctrl-err');
  line.hidden = true;
  Object.assign(state.settings, patch);
  showSettings();
  rebuild();
  try {
    await Store.saveSettings(patch);
  } catch (e) {
    if (carries(state.settings, patch)) Object.assign(state.settings, before);
    showSettings();
    rebuild();
    line.textContent = failure('Not saved', e);
    line.hidden = false;
  }
}

const TABS = ['edit', 'gantt', 'internal', 'tm', 'print'];

/** The print sheet each content tab corresponds to. Gantt has no sheet. */
const SHEET_FOR_TAB = { edit: 'production', internal: 'internal', tm: 'tm' };

const SHEET = {
  production: { btn: 'sheetBoard', label: 'Print board' },
  // The board again, with tick boxes: same jobs, same horizon, smaller type.
  warehouse: { btn: 'sheetWarehouse', label: 'Print warehouse board' },
  internal: { btn: 'sheetInternal', label: 'Print internal jobs',
    title: 'Internal factory jobs', itemLabel: 'Item',
    order: INTERNAL_CATEGORY_ORDER },
  tm: { btn: 'sheetTm', label: 'Print T&M jobs',
    title: 'Time & Materials jobs', itemLabel: 'For',
    order: TM_CATEGORY_ORDER },
};

function showTab(which) {
  // ARRIVING AT PRINT SHOULD PRINT WHAT YOU WERE READING. Print is its own tab,
  // so by the time you are in it the lane you cared about is behind you unless
  // something remembers it.
  if (SHEET_FOR_TAB[which]) setPrintLane(SHEET_FOR_TAB[which], { render: false });
  state.tab = which;
  for (const t of TABS) {
    const cap = t[0].toUpperCase() + t.slice(1);
    $(`tab${cap}`).classList.toggle('offstage', which !== t);
    $(`tab${cap}Btn`).setAttribute('aria-current', which === t ? 'page' : 'false');
  }
  // The Gantt measures itself to scroll to today, and the print preview
  // measures itself to fit the page. Neither can do that while off-canvas, so
  // both are drawn on arrival rather than on rebuild.
  if (which === 'gantt') renderGanttView({ arriving: true });
  // The print host cannot be measured while it is off-canvas, so the sheet is
  // drawn on arrival rather than on rebuild.
  if (which === 'print') renderPrintSheet();
}

/**
 * Draw whichever sheet is selected into the print host.
 *
 * The board's own fit is computed in `rebuild` regardless, because the HORIZON
 * changes the board on screen as well as on paper. This only decides what the
 * preview shows and what the button will send to the printer.
 */
function renderPrintSheet() {
  if (!state.rows || state.importPage) return;
  const host = $('printPreview');
  const lane = state.printLane;

  for (const [key, cfg] of Object.entries(SHEET)) {
    const b = $(cfg.btn);
    b.classList.toggle('on', key === lane);
    b.setAttribute('aria-pressed', String(key === lane));
  }
  // The paper is the warehouse copy's choice alone: every other sheet is drawn
  // for the A3 box and scaled by the printer to the paper it holds. The second
  // page is the board's alone. Each control shows with its sheet.
  const isWarehouse = lane === 'warehouse';
  const page = isWarehouse ? WAREHOUSE_PAPER[state.warehousePaper] : { drawn: 'a4', landscape: false };
  $('printBtn').textContent = SHEET[lane].label + (isWarehouse ? ` on ${page.label}` : '');
  $('paperPick').closest('.ctrl').hidden = !isWarehouse;
  for (const p of Object.keys(WAREHOUSE_PAPER)) {
    const b = $(`paper${p.toUpperCase()}`);
    b.classList.toggle('on', p === state.warehousePaper);
    b.setAttribute('aria-pressed', String(p === state.warehousePaper));
  }
  const wp = $('waterSheet');
  wp.closest('.ctrl').hidden = !(lane === 'production' || isWarehouse);
  wp.textContent = state.waterPage ? 'Watermakers on' : 'Watermakers off';
  wp.classList.toggle('on', state.waterPage);
  wp.setAttribute('aria-pressed', String(state.waterPage));
  // The horizon is a property of the board; these lists have no future to
  // narrow, so the control would be answering a question they do not ask.
  const isBoard = lane === 'production' || isWarehouse;
  $('horizon').closest('.ctrl').hidden = !isBoard;
  // The page box, and whether the drawing is zoomed to fill it (THE PAGE BOX
  // in print.js). @page cannot be scoped to an element, so the rule is a
  // one-line stylesheet switched with the sheet; the zoom keys off data-drawn
  // on the print root, which takes the board's second page with it.
  $('pageRule').textContent = pageRule(page);
  $('printRoot').dataset.drawn = page.drawn;

  if (lane === 'production') {
    renderPrint(host, state.board);
    state.laneFit = null;
    state.variantFit = null;
  } else if (lane === 'warehouse') {
    // On A4 the fitted board again, with tick boxes, on as many landscape pages
    // as it takes - never refitted on its own, which would move the horizon
    // under the board on screen. On A3 one sheet with a horizon of its own,
    // trimmed from the setting to hold it. Its watermaker page likewise.
    state.variantFit = fitWarehouse(host, {
      board: state.board, build: state.buildAt, onePage: page.onePage,
      startWeeks: state.settings.horizonWeeks, minWeeks: 4,
      autoFit: state.settings.autoFit, water: state.waterPage,
    });
    state.laneFit = null;
  } else {
    state.variantFit = null;
    const jobs = (state.board[lane] ?? []).filter((j) => !j.completed && !j.hidden);
    state.laneFit = fitLaneToPage(host, jobs, {
      title: SHEET[lane].title,
      asOf: toAU(toDateOnly(state.board.meta.as_of)),
      itemLabel: SHEET[lane].itemLabel,
      // The same categories the tab groups by, in the same order.
      order: SHEET[lane].order,
    });
  }
  renderWaterPage();
  renderFitStatus();
}

/**
 * The board's second page: watermakers, when the Print tab asks for one and
 * the board is the sheet on its way to the printer (the warehouse copy draws
 * its own, inside its pages). A horizon of its own, trimmed from the setting
 * until the page holds. Nothing to list means no page - a blank second sheet
 * is worse than none - and the status line says.
 */
function renderWaterPage() {
  const host = $('printSecond');
  const on = state.waterPage && state.printLane === 'production';
  if (!on) { host.hidden = true; state.waterFit = null; return; }
  host.hidden = false;                  // laid out before it is measured
  state.waterFit = fitHorizon(state.buildAt, (b) => {
    const jobs = renderWatermakers(host, b, { horizon: true });
    return { jobs, ...measure(host) };
  }, { startWeeks: state.settings.horizonWeeks, minWeeks: 4, autoFit: state.settings.autoFit });
  host.hidden = !state.waterFit.jobs;
}

function setPrintLane(lane, { render = true } = {}) {
  state.printLane = lane;
  if (render && state.tab === 'print') renderPrintSheet();
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

/** Build the board and draw it all; whatever had the focus keeps it. */
function rebuild() { keepFocus(redraw); }

function redraw() {
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
    hidePartOrders: !state.showPartOrders,
  };
  const build = (weeks) => buildBoard(state.rows, { ...opts, horizonWeeks: weeks });
  state.buildAt = build;      // the sheets with a horizon of their own refit from it

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
  // The board's fit is always computed above; this replaces the preview with a
  // follow-up list when that is what is selected.
  if (state.tab === 'print' && state.printLane !== 'production') renderPrintSheet();
  else renderWaterPage();
  renderFitStatus();
  renderGanttView();
  renderLane('internal');
  renderLane('tm');
  for (const lane of Object.keys(HISTORY_HOST)) renderHistory(lane);
  renderRecent();
  saveBoardCopy();
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
  age.textContent = days <= 0 ? 'today' : `${count(days, 'day')} old`;
  age.classList.toggle('stale', days >= 7);
  // The floor has no export to upload.
  if (days >= 7 && Auth.isManager) age.textContent += ' — upload a fresh export';
  renderShare();
}

function panel({ cls = '', title, count: n, open = false, build }) {
  const d = el('details', `panel ${cls}`);
  d.dataset.panel = title;
  d.open = open;
  const s = el('summary');
  s.dataset.focus = `panel:${title}`;
  s.append(el('span', null, title));
  if (n !== undefined) s.append(el('span', 'count', String(n)));
  d.append(s);
  const body = el('div', 'body');
  build(body);
  d.append(body);
  return d;
}

/** To one code on the vessel codes page. */
function codeLink(code) {
  const a = el('a', 'textlink', 'Open on vessel codes');
  a.href = carryFlag(`vessel-codes#${encodeURIComponent(code)}`);
  return a;
}

function renderWarnings() {
  const host = $('warnings');
  // What was opened or shut stays so through a redraw: every edit draws this again.
  const was = new Map([...host.querySelectorAll('details.panel')].map((d) => [d.dataset.panel, d.open]));
  host.textContent = '';
  const w = state.board.warnings;

  // Jobs an import took off the board that did not reach History. They are on
  // this device and nowhere else, so this comes before everything.
  const unfiled = Object.entries(loadUnfiled());
  if (state.unfiled && unfiled.length) {
    host.append(panel({
      cls: 'alert', title: 'Jobs not yet in History', count: unfiled.length, open: true,
      build: (b) => {
        b.append(el('div', null, state.unfiled));
        for (const [prodNo, snap] of unfiled) {
          const r = el('div', 'xrow');
          r.append(el('span', 'id', prodNo), el('span', null, snap?.label ?? ''), el('span', 'why', snap?.closed_why ?? ''));
          b.append(r);
        }
        const again = el('button', 'mini', 'Retry');
        again.addEventListener('click', () => fileInHistory(loadUnfiled()));
        b.append(again);
      },
    }));
  }

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
          'These rows match no category, so they are off the board until a rule is added. '
          + 'Report them to the design office.'));
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
          const r = el('div', 'xrow has-act');
          r.append(el('span', 'id', n.code),
            el('span', null, `${count(n.count, 'job')} · ${n.items.join(', ')}`), el('span', 'why', ''));
          const a = el('button', 'mini', 'Resolve');
          a.dataset.focus = `panel:code:${n.code}`;
          a.addEventListener('click', () => startCodeRun([n]));
          r.append(a);
          const fault = faultLine(`code:${n.code}`, rebuild);
          if (fault) r.append(fault);
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
          const r = el('div', 'xrow has-act');
          r.append(el('span', 'id', j.prod_no),
            el('span', null, jobTitle(j)),
            el('span', 'why', j.name_options.description.raw || 'no description'));
          const a = el('button', 'mini', 'Resolve');
          a.dataset.focus = `panel:name:${j.prod_no}`;
          a.addEventListener('click', () => startNameRun([j]));
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
          const line = el('div', null,
            `${c.codes.join(' and ')} are the same boat (model ${c.models.join(', ')}) ` +
            `but are confirmed to different display codes: ` +
            `${c.values.map((v) => `${v.code}→${v.display}`).join(', ')}. `);
          line.append(codeLink(c.codes[0]));
          b.append(line);
        }
      },
    }));
  }

  if (w.codeUndecided.length) {
    host.append(panel({
      title: 'Vessel codes awaiting confirmation', count: w.codeUndecided.length,
      build: (b) => {
        for (const u of w.codeUndecided) {
          const line = el('div', null, `${u.codes.join(', ')} — showing ${u.provisional}, not confirmed. `);
          line.append(codeLink(u.codes[0]));
          b.append(line);
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
          const r = el('div', 'xrow has-act');
          r.append(el('span', 'id', j.prod_no), el('span', null, jobTitle(j)),
            el('span', 'why', j.status_manual ? 'put on hold here' : `due ${j.due_display}`));
          const acts = el('span', 'xacts');
          const hide = el('button', 'mini', 'Hide');
          hide.dataset.focus = `panel:hold:${j.prod_no}`;
          hide.addEventListener('click', () => openHideDialog(j));
          acts.append(statusControl(j), hide);
          r.append(acts);
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
          const r = el('div', 'xrow has-act');
          r.append(el('span', 'id', j.prod_no), el('span', null, jobTitle(j)),
            el('span', 'why', j.hidden_reason || 'no reason given'));
          const show = el('button', 'mini', 'Show');
          show.dataset.focus = `panel:hidden:${j.prod_no}`;
          show.addEventListener('click', () => unhide(j));
          r.append(show);
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
  for (const d of host.querySelectorAll('details.panel')) {
    if (was.has(d.dataset.panel)) d.open = was.get(d.dataset.panel);
  }
}

/** What the floor sees: what the printed sheet shows, less the part orders it has put away. */
const floorJobs = () => state.board.jobs.filter((j) => !j.hidden && !j.completed
  && (state.showPartOrders || !j.part_order));

function renderBoard() {
  const host = $('board');
  host.textContent = '';
  // The manager sees hidden jobs greyed, so they can be brought back. The
  // floor sees what the printed sheet shows — not hidden, not finished.
  const jobs = Auth.isManager ? state.board.jobs : floorJobs();
  const groups = byCategory(jobs, { includeHidden: Auth.isManager });

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
  $('completePastDue').hidden = !pastDue;
  showCollapseAll();
  // The toggle says what it holds: how many part orders are on the board, or
  // how many it is keeping off it.
  const po = $('partOrders');
  const n = Auth.isManager ? (state.board.meta.part_orders ?? 0) : state.board.jobs.filter((j) => j.part_order).length;
  const on = state.showPartOrders;
  po.textContent = !n ? 'Part orders: none' : on ? `Part orders: ${n} shown` : `Part orders: ${n} hidden`;
  po.classList.toggle('on', on);
  po.setAttribute('aria-pressed', String(on));
  po.disabled = !n && on;
}

/** The folds the Collapse all button acts on now. */
function boardFolds() {
  const jobs = Auth.isManager ? state.board.jobs : floorJobs();
  const groups = byCategory(jobs, { includeHidden: Auth.isManager });
  const done = (state.board.completed ?? []).filter((j) => (j.lane ?? 'production') === 'production');
  return collapseScope({
    recent: recentOpen,
    history: historyOpen.has('production'),
    order: CATEGORY_ORDER,
    count: (c) => (groups.get(c) ?? []).length,
    historyCount: (c) => done.filter((j) => j.category === c).length,
    extra: historyOpen.has('production')
      ? [...new Set(done.map((j) => j.category))].filter((c) => !CATEGORY_ORDER.includes(c)) : [],
  });
}

/** The button reads what it would do; with nothing to fold it is off. */
function showCollapseAll() {
  if (!state.board) return;
  const folds = boardFolds();
  const btn = $('collapseAll');
  btn.textContent = anyShut(folds, collapsed) ? 'Expand all' : 'Collapse all';
  btn.disabled = !folds.shown.length;
}

function categoryBlock(cat, jobs, { full = false } = {}) {
  if (!jobs.length) return null;
  const isShut = collapsed.has(cat);
  const block = el('div', `cat-block${isShut ? ' is-collapsed' : ''}`);

  const head = el('button', 'cat-head');
  head.dataset.focus = `cat:${cat}`;
  head.setAttribute('aria-expanded', String(!isShut));
  head.append(el('span', 'cat-caret', isShut ? '\u25b8' : '\u25be'));
  head.append(el('h2', null, cat));
  const shown = jobs.filter((j) => !j.hidden).length;
  head.append(el('span', 'n', shown === jobs.length ? `${shown}` : `${shown} of ${jobs.length}`));
  head.addEventListener('click', () => {
    if (collapsed.has(cat)) collapsed.delete(cat); else collapsed.add(cat);
    saveCollapsed(collapsed);
    keepFocus(renderBoard);
  });
  block.append(head);

  if (isShut) return block;

  const body = el('div', 'cat-body');
  // The header has exactly the cells the rows have (board-columns.js).
  body.append(boardHead({ manager: Auth.isManager, full }));
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
  sel.setAttribute('aria-label', `Status of ${j.prod_no}`);
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

function setStatus(j, value) {
  if (value === j.erp_status) {
    setOverride(j.prod_no, { status: null, statusFrom: null }, `${j.prod_no}: hand-set status removed \u2014 ${value}.`);
    return;
  }
  // `statusFrom` is what makes this expire: it records the ERP value being
  // corrected, so the override drops itself once the export disagrees.
  setOverride(j.prod_no, { status: value, statusFrom: j.erp_status }, `${j.prod_no} set to ${value}.`);
}

function jobRow(j, { full = false } = {}) {
  const row = el('div', `job${j.on_hold ? ' on-hold' : ''}${j.hidden ? ' is-hidden' : ''}`
    + `${full ? ' is-full' : ''}${openRows.has(j.prod_no) ? ' is-open' : ''}`);
  row.dataset.prod = j.prod_no;

  // THE FLOOR'S ROW IS THE PRINTED ROW: production number, vessel, due date.
  // The PO, the status, the edit markers and the actions are the manager's
  // working notes, left out of the markup rather than hidden \u2014 a hidden grid
  // item is removed from flow and everything after it shifts a column left.
  const manager = Auth.isManager;

  const prod = el('span', 'prod', j.prod_no);
  if (manager && j.customer_po) prod.title = `PO ${j.customer_po}`;   // the PO column gives way on a narrow screen
  row.append(prod);

  // the manufacturer's PO sits next to the production number because that is the pair
  // the manager reads together when checking an order against the manufacturer. It is
  // manager-view only and never reaches the printed board.
  if (manager) row.append(el('span', 'po', j.customer_po ?? ''));

  const label = el('span', 'label', jobTitle(j));
  if (manager && j.label !== j.base_label) label.append(el('span', 'edited', 'EDITED'));
  else if (manager && j.item_override) label.append(el('span', 'pinned', 'ITEM'));
  // A part order is marked so the manager can see what the Part orders toggle
  // will hold back, and whether that was the code's shape or their own call.
  if (manager && j.part_order) {
    const chip = el('span', 'part-chip', 'PART');
    chip.title = j.part_order_manual ? 'Marked a part order by hand, for every job on this code'
      : 'A part order by the shape of its code: a family prefix and four digits';
    label.append(chip);
  }
  row.append(label);

  // The hull the unit is for: on the page, never on the printed sheet. Read
  // from the ERP where the admin wrote it in; the manager types it where not.
  const hull = manager ? el('button', 'hull') : el('span', 'hull');
  hull.textContent = j.hull ?? '';
  hull.classList.toggle('is-manual', Boolean(j.hull_manual));
  hull.classList.toggle('is-empty', !j.hull);
  if (manager) {
    hull.title = j.hull_manual ? `Typed in by hand${j.hull_auto ? ` \u2014 the ERP says ${j.hull_auto}` : ''}. Click to change.`
      : j.hull ? 'From the ERP\'s order text. Click to override.' : 'No hull in the ERP\'s order text. Click to type one.';
    hull.addEventListener('click', () => openHullDialog(j));
  }
  row.append(hull);
  // When the order was entered in the ERP: the manager's, never printed.
  if (manager) row.append(createdCell(j));

  row.append(el('span', `due${j.is_stock ? ' stock' : ''}`, j.due_display));
  // Status only in the full-width block, and only for the manager.
  if (full && manager) {
    const st = el('span', `status${j.status_manual ? ' is-manual' : ''}`, j.status);
    if (j.status_manual) st.title = `Set by hand \u2014 the ERP says ${j.erp_status}`;
    row.append(st);
  }
  if (!manager) return row;

  // ON THE ROW: Hide, the one control used in passing, and a caret. Everything
  // that edits the job - Label, Part, the status, Done - is folded beneath and
  // comes out when the row (or the caret) is clicked. Six controls across
  // every row crowded the columns off the page; one and a caret do not.
  const acts = el('span', 'acts');
  const hide = el('button', `mini${j.hidden ? ' on' : ''}`, j.hidden ? 'Show' : 'Hide');
  hide.addEventListener('click', () => (j.hidden ? unhide(j) : openHideDialog(j)));
  acts.append(hide);
  const more = el('button', 'mini more', openRows.has(j.prod_no) ? '\u25be' : '\u25b8');
  more.setAttribute('aria-label', `Controls for ${j.prod_no}`);
  more.setAttribute('aria-expanded', String(openRows.has(j.prod_no)));
  more.addEventListener('click', () => toggleRow(row, openRows));
  acts.append(more);
  row.append(acts);

  const fold = el('span', 'acts-more');
  // The PO and the created date, where the screen has no room for their columns.
  const po = poNote(j);
  if (po) fold.append(po);
  const created = createdNote(j);
  if (created) fold.append(created);
  // What the ERP says where a person has said otherwise.
  const erp = erpNote(j);
  if (erp) fold.append(erp);
  const pkg = el('button', 'mini', 'Package');
  pkg.addEventListener('click', () => openPackageDialog(j, {
    packages: state.packages,
    who: Auth.user?.email ?? null,
    onLog: (d) => logChange(d, j.prod_no, j.inventory_id, jobTitle(j)),
    onPlinths: (catalogue) => { state.plinths = catalogue; rebuild(); },
    onPackages: (packages) => { state.packages = packages; rebuild(); },
    toast,
  }));
  fold.append(pkg);
  const edit = el('button', 'mini', 'Label');
  edit.addEventListener('click', () => openLabelEditor(j));
  fold.append(edit);

  // Part or not, for every job on this code. The code's shape decides by
  // default; this is the manager's say for a lettered kit that is a part, or
  // a numbered code that is a unit.
  const part = el('button', `mini${j.part_order ? ' on' : ''}`, 'Part order');
  part.setAttribute('aria-pressed', String(Boolean(j.part_order)));
  part.title = j.part_order ? 'A part order: the Part orders toggle holds it back. Click to make it a unit.'
    : 'A unit. Click to mark it a part order, for every job on this code.';
  part.addEventListener('click', () => togglePartOrder(j));
  fold.append(part);

  fold.append(statusControl(j));

  // On a phone the hull is a line of the row, too small to press: changed here.
  const hullEdit = el('button', 'mini hull-edit', j.hull ? 'Edit hull' : 'Add hull');
  hullEdit.addEventListener('click', () => openHullDialog(j));
  fold.append(hullEdit);

  const done = el('button', 'mini', 'Complete');
  done.title = 'Mark completed \u2014 off the board for good, reversible from History';
  done.addEventListener('click', () => openCompleteDialog([j]));
  fold.append(done);

  const changes = el('button', 'mini', 'Change history');
  changes.addEventListener('click', () => openItemHistory(j));
  fold.append(changes);

  // A davit's plinth: its height and compression post, blank until chosen.
  if (isDavit(j)) fold.append(plinthControl(j, state.plinths, (p) => setOverride(j.prod_no, { plinth: p }), state.packages));

  row.append(fold);
  const fault = faultLine(j.prod_no, rebuild);
  if (fault) row.append(fault);
  return row;
}

function renderGanttView({ arriving = false } = {}) {
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
    // Today is where it opens; after that it stays where it was scrolled to.
    toToday: arriving,
    // Held while the board is the saved copy, like every other control that writes.
    onBarClick: Auth.isManager && !isHeld() ? (r) => openCompleteDialog([r]) : null,
    isCollapsed: (cat) => collapsed.has(`gantt:${cat}`),
    onToggleCategory: (cat) => {
      const key = `gantt:${cat}`;
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      saveCollapsed(collapsed);
      keepFocus(renderGanttView);
    },
  });

  $('ganttHint').textContent = all
    ? `Completed work included \u2014 ${count(g.rowCount, 'bar')}, scroll sideways.`
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
  // One panel in the board's place at a time.
  if (lane === 'production' && historyOpen.has(lane) && recentOpen) { recentOpen = false; renderRecent(); }
  renderHistory(lane);
}

// Recent changes: the activity log, a panel of its own beside History and in
// the board's place like it. History keeps to the completed lists.
let recentOpen = false;

function toggleRecent() {
  recentOpen = !recentOpen;
  if (recentOpen && historyOpen.has('production')) { historyOpen.delete('production'); renderHistory('production'); }
  if (!recentOpen) forgetActivityLog();
  renderRecent();
}

function renderRecent() {
  const host = $('recentChangesPanel');
  $('recentChanges').setAttribute('aria-pressed', String(recentOpen));
  $(HISTORY_BODY.production).hidden = recentOpen || historyOpen.has('production');
  host.hidden = !recentOpen;
  showCollapseAll();
  if (recentOpen) renderActivityLog(host, { master: Auth.isMaster });
  else host.textContent = '';
}

function renderHistory(lane = 'production') {
  const host = $(HISTORY_HOST[lane]);
  const open = historyOpen.has(lane);
  const done = (state.board.completed ?? []).filter((j) => (j.lane ?? 'production') === lane);

  const btn = $(HISTORY_BTN[lane]);
  btn.textContent = done.length ? `History (${done.length})` : 'History';
  btn.setAttribute('aria-pressed', String(open));
  $(HISTORY_BODY[lane]).hidden = open || (lane === 'production' && recentOpen);
  host.hidden = !open;
  if (lane === 'production') showCollapseAll();
  if (!open) return;

  host.textContent = '';
  if (!done.length) {
    host.append(el('div', 'state', 'Nothing completed yet.'));
    return;
  }

  // Grouped by board category, same order as everywhere else, so History reads
  // like the orders view rather than as one long undifferentiated list.
  const cats = [...HISTORY_CATS[lane]];
  const byCat = new Map(cats.map((c) => [c, []]));
  // One completed before records were kept has no category: last, not left out.
  for (const j of done) {
    if (!byCat.has(j.category)) { cats.push(j.category); byCat.set(j.category, []); }
    byCat.get(j.category).push(j);
  }

  for (const cat of cats) {
    const rows = byCat.get(cat) ?? [];
    if (!rows.length) continue;

    const key = historyKey(lane, cat);
    const shut = collapsed.has(key);
    const block = el('div', `hist-cat${shut ? ' is-collapsed' : ''}`);

    const head = el('button', 'hist-cat-head');
    head.dataset.focus = key;
    head.setAttribute('aria-expanded', String(!shut));
    head.append(el('span', 'cat-caret', shut ? '\u25b8' : '\u25be'));
    head.append(el('h2', null, cat));
    head.append(el('span', 'n', String(rows.length)));
    head.addEventListener('click', () => {
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      saveCollapsed(collapsed);
      keepFocus(() => renderHistory(lane));
    });
    block.append(head);

    if (!shut) {
      const table = el('div', 'hist');
      table.append(historyHead(lane));

      // Most recently completed first within a category.
      rows.sort((a, b) => String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? '')));

      for (const j of rows) {
        // Its own key among the opened rows: a job reopened from here must not
        // come back to the board with its controls out.
        const foldKey = `hist:${j.prod_no}`;
        const row = el('div', `${historyRowClass(lane)}${openRows.has(foldKey) ? ' is-open' : ''}`);
        row.dataset.prod = foldKey;
        // On a phone the headings go, and three dates would be left unnamed:
        // each cell that needs one carries its own column's heading.
        const heads = Object.fromEntries(historyColumns(lane).map((c) => [c.key, c.head]));
        const prod = el('span', 'prod', j.prod_no);
        row.append(prod);
        // The PO and the hull, as the board shows them.
        if (lane === 'production') {
          if (j.customer_po) prod.title = `PO ${j.customer_po}`;   // the PO column gives way on a narrow screen
          row.append(el('span', 'po', j.customer_po ?? ''));
        }
        const label = el('span', 'label', jobTitle(j));
        // A job the ERP closed reads differently from one somebody ticked, and
        // History is the wrong place to blur the two.
        if (j.closed_why) label.append(el('span', 'hist-why', j.closed_why));
        row.append(label);
        if (lane === 'production') row.append(el('span', 'hull', j.hull ?? ''));
        const due = el('span', 'due', lane === 'production' ? j.due_display : (j.opened_display ?? ''));
        due.dataset.head = heads.due;
        row.append(due);
        const when = j.completed_at ? new Date(j.completed_at) : null;
        const stamp = el('span', 'when', when
          ? when.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })
          : '\u2014');
        if (j.completed_by) stamp.title = `Marked by ${j.completed_by === ERP_CLOSER ? 'ERP import' : j.completed_by}`;
        stamp.dataset.head = heads.when;
        row.append(stamp);
        // Who last touched it: the override's stamp, else the completion, else
        // the log's newest line for it once the log has loaded.
        const touched = touchedCell(lastChanged({ override: state.overrides[j.prod_no], job: j, rows: loadedEntries() }), j.prod_no);
        touched.dataset.head = heads.touched;
        row.append(touched);

        const acts = el('span', 'acts');
        const reopen = el('button', 'mini', 'Reopen');
        reopen.title = 'Put it back on the board';
        reopen.addEventListener('click', () => reopenJob(j));
        acts.append(reopen);
        row.append(acts);
        const fault = faultLine(foldKey, rebuild);
        if (fault) row.append(fault);
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
  // In a sweep, stock is listed but starts unticked. Its ERP dates are written
  // once and never revised, so "past its end date" says nothing about whether
  // the work is done — every stock build on the 21/08 export is months past a
  // date that was never meant to hold. Ticking it by default would sweep live
  // work off the board. Customer orders are the opposite: a passed date usually
  // does mean finished. A single job was chosen by name, stock or not.
  const single = jobs.length === 1;
  completing = jobs.map((j) => ({ job: j, ticked: single || !j.is_stock }));
  $('completeList').hidden = single;
  $('completeOverlay').querySelector('.c-actions-top').hidden = single;

  // A side-lane job has no due date worth the name - the ERP stamps start and
  // end to the day it was raised - so say how long it has been open instead.
  const one = jobs[0];
  // From a Gantt bar, the bar's own dates: on a touch screen this is where they are read.
  const when = one?.startDisplay && one?.endDisplay ? `, ${one.startDisplay} \u2013 ${one.endDisplay}` : whenWords(one);
  $('completeLede').textContent = jobs.length === 1
    ? `${one.prod_no} — ${jobTitle(one)}${when}.`
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
  $('completeConfirm').textContent = completing.length === 1 ? 'Complete job' : `Complete ${count(n, 'job')}`;
  $('completeConfirm').disabled = n === 0;
}

function confirmComplete() {
  const jobs = completing.filter((e) => e.ticked).map((e) => e.job);
  if (!jobs.length) return;
  $('completeOverlay').classList.remove('show');
  completeJobs(jobs);
  flushDeferredRebuild();
}

/**
 * Mark jobs complete: one write for all of them, so it happens or it does not.
 * The snapshot travels with the completion so History can render the job long
 * after the ERP stops exporting it.
 */
function completeJobs(jobs) {
  const who = Auth.user?.email ?? null;
  const at = new Date().toISOString();
  const keys = jobs.map((j) => j.prod_no);
  const snaps = Object.fromEntries(jobs.map((j) => [j.prod_no, snapshotOf(j)]));
  const before = new Map();
  return edit({
    rows: keys,
    what: 'Not completed',
    said: keys.length === 1 ? `${keys[0]} completed. In History.` : `${count(keys.length, 'job')} completed. In History.`,
    apply: () => {
      for (const j of jobs) {
        before.set(j.prod_no, state.overrides[j.prod_no]);
        state.overrides[j.prod_no] = { ...(state.overrides[j.prod_no] ?? {}), completed: true, completedAt: at,
          completedBy: who, snapshot: snaps[j.prod_no], touchedBy: who, touchedAt: at };
      }
    },
    undo: () => { for (const k of keys) if (state.overrides[k]?.completed) putBack(k, before.get(k)); },
    write: () => Store.setCompleted(keys, true, who, snaps),
    saved: () => { for (const j of jobs) logChange({ action: ACTION.done, text: 'completed' }, j.prod_no, j.inventory_id, jobTitle(j)); },
  });
}

/** Put a completed job back on the board. Its failure is said on both rows: it may be on either. */
function reopenJob(j) {
  let before;
  return edit({
    rows: [j.prod_no, `hist:${j.prod_no}`],
    what: 'Not reopened',
    said: `${j.prod_no} reopened.`,
    apply: () => {
      before = state.overrides[j.prod_no];
      const { completed, completedAt, completedBy, snapshot, ...rest } = before ?? {};
      putBack(j.prod_no, rest);
    },
    undo: () => { if (!state.overrides[j.prod_no]?.completed) putBack(j.prod_no, before); },
    write: () => Store.setCompleted([j.prod_no], false, Auth.user?.email),
    saved: () => logChange({ action: ACTION.reopen, text: 'reopened from History' }, j.prod_no, j.inventory_id, jobTitle(j)),
  });
}

/** Why jobs on the board are not on the sheet, each reason with its number. */
function offSheetWords(b, heldBack) {
  const onSheet = new Set(printJobs(b).map((j) => j.prod_no));
  const off = (b.jobs ?? []).filter((j) => !j.hidden && !j.completed && !onSheet.has(j.prod_no));
  const water = off.filter((j) => WATERMAKER_CATEGORIES.includes(j.category)).length;
  const stock = off.filter((j) => j.is_stock && !WATERMAKER_CATEGORIES.includes(j.category)).length;
  const later = off.length - water - stock;
  const parts = [
    water && count(water, 'watermaker'),
    later && `${later} past the horizon`,
    stock && `${stock} stock over the cap`,
    heldBack && `${count(heldBack, 'part order')} held back`,
  ].filter(Boolean);
  return parts.length ? `(not on it: ${parts.join(', ')})` : '';
}

function renderFitStatus() {
  const box = $('fitStatus');
  box.textContent = '';

  // A follow-up list is measured by rows, not by weeks, so it gets its own
  // line rather than one phrased around a horizon it does not have.
  if (state.laneFit) {
    const l = state.laneFit;
    box.classList.toggle('trimmed', Boolean(l.trimmedFrom));
    box.append(el('b', null, `${l.rows} of ${count(l.total, 'job')}`));
    box.append(el('span', null, '\u00b7'));
    if (!l.measured) box.append(el('span', null, 'sheet not measured; reload the page'));
    else if (l.trimmedFrom) {
      box.append(el('span', null, 'trimmed to hold one page \u2014 the '));
      box.append(el('b', null, `${l.total - l.rows} newest`));
      box.append(el('span', null, ' are off the sheet, longest-open first'));
    } else if (l.fits) box.append(el('span', null, 'all of them, on one page'));
    else box.append(el('span', null, `${l.pages} pages`));
    return;
  }

  // The A3 warehouse copy has a horizon of its own, so its line describes its
  // own board; every other sheet describes the board as fitted.
  const v = state.variantFit;
  const f = v?.onePage ? v : state.fit;
  const shown = v?.onePage ? v.board : state.board;
  box.classList.toggle('trimmed', Boolean(f.trimmedFrom));

  const range = shown.meta.horizon_end
    ? `${toAU(toDateOnly(shown.meta.as_of))} — ${toAU(toDateOnly(shown.meta.horizon_end))}`
    : 'no horizon';

  box.append(el('span', null, `Covering `), el('b', null, range));
  box.append(el('span', null, `·`));
  const printed = shown.meta.print_count;
  const total = shown.meta.job_count;
  box.append(el('b', null, `${printed} of ${count(total, 'job')}`));
  const heldBack = shown.meta.part_orders_hidden ?? 0;
  const off = offSheetWords(shown, heldBack);
  if (off) box.append(el('span', null, off));
  box.append(el('span', null, `·`));

  // The warehouse copy: on A4 the same board, paged rather than fitted; on A3
  // one sheet with a horizon of its own, and the type stepped down only when
  // the floor of the horizon would not hold it.
  if (v) {
    if (!v.measured) box.append(el('span', null, 'warehouse copy not measured; reload the page'));
    else if (v.onePage) {
      const type = v.shrunk ? ` with the type at ${v.pt}pt` : '';
      if (!state.settings.autoFit) {
        box.append(el('span', null, v.fits
          ? `the warehouse copy fits one A3 page at ${v.weeks} weeks`
          : 'the warehouse copy will not fit one A3 page — auto-fit is off'));
      } else if (!v.fits) {
        box.append(el('span', null, `the warehouse copy will not fit one A3 page even at ${v.weeks} weeks and ${v.pt}pt type`));
      } else if (v.trimmedFrom) {
        box.append(el('span', null, 'Auto-fit reduced the horizon from '));
        box.append(el('b', null, `${v.trimmedFrom} weeks to ${v.weeks}`));
        box.append(el('span', null, ` to hold one A3 page${type}.`));
      } else box.append(el('span', null, `the warehouse copy fits one A3 page at ${v.weeks} weeks${type}`));
    }
    else if (v.pages === 1) box.append(el('span', null, 'the warehouse copy fits one landscape page'));
    else {
      box.append(el('span', null, 'the warehouse copy runs to '), el('b', null, `${v.pages} landscape pages`));
      box.append(el('span', null, v.split.length
        ? `, and ${v.split.join(', ')} had to be split \u2014 too tall for a page on its own`
        : ', no category split across two'));
    }
    waterStatus(box, v.water, { second: false });
    return;
  }

  if (!state.settings.autoFit) {
    box.append(el('span', null, f.fits ? 'fits one page' : `${f.pages} pages — auto-fit is off`));
  } else if (f.trimmedFrom) {
    box.append(el('span', null, 'Auto-fit reduced the horizon from '));
    box.append(el('b', null, `${f.trimmedFrom} weeks to ${f.weeks}`));
    box.append(el('span', null, ' to hold one page.'));
  } else if (f.fits) {
    box.append(el('span', null, `fits one page at ${f.weeks} weeks`));
  } else {
    box.append(el('span', null,
      `will not fit one page even at ${f.weeks} weeks (${f.pages} pages). ` +
      `Lower the stock cap, or hide some jobs.`));
  }

  waterStatus(box, state.waterFit, { second: true });
}

/**
 * The watermaker page's line, after its sheet's own: the board's second page,
 * or the warehouse copy's last. It has a horizon of its own, so it says when
 * that was trimmed, and when even the floor would not hold it.
 */
function waterStatus(box, w, { second }) {
  if (!w) return;
  box.append(el('span', null, `·`));
  if (!w.jobs) {
    box.append(el('span', null, second ? 'no watermaker jobs for a second page' : 'no watermaker jobs for a page of their own'));
    return;
  }
  box.append(el('span', null, second ? 'plus a second page of ' : 'plus a watermaker page of '));
  box.append(el('b', null, `${w.jobs} ${second ? 'watermaker ' : ''}job${w.jobs === 1 ? '' : 's'}`));
  if (!w.measured) return;
  if (w.trimmedFrom) box.append(el('span', null, `, its horizon trimmed from ${w.trimmedFrom} weeks to ${w.weeks} to hold one page`));
  else if (!w.fits) {
    box.append(el('span', null, state.settings.autoFit
      ? `, which will not fit one page even at ${w.weeks} weeks`
      : ', which runs past one page — auto-fit is off'));
  }
}

// ---------------------------------------------------------------------------
// new vessel codes
//
// Upstream does not manage these consistently — `06` was an office shorthand
// for XX06, and the manufacturer call the same boat both XX06 and XX15. So a code the
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
function queueImportQuestions({ all = false } = {}) {
  if (!Auth.isManager) return;
  const { codes, names } = unasked(all);
  if (codes.length) { startCodeRun(codes, { names }); return; }
  if (names.length) startNameRun(names);
}

/**
 * What an import still needs answered: all of it once the import has been
 * applied, and afterwards only what this device has not asked before. Being
 * asked the same ten questions at every open taught people to dismiss them;
 * the panel on the board goes on listing them.
 */
function unasked(all) {
  const pending = {
    codes: state.board?.warnings?.newCodes ?? [],
    names: state.board?.warnings?.customNames ?? [],
  };
  const asked = all ? new Set() : loadAsked();
  const keyOf = { codes: (n) => `code:${n.code}`, names: (j) => `name:${j.prod_no}` };
  const out = {};
  for (const k of ['codes', 'names']) out[k] = pending[k].filter((x) => !asked.has(keyOf[k](x)));
  // Only what is still pending is worth remembering.
  saveAsked(new Set(['codes', 'names'].flatMap((k) => pending[k].map(keyOf[k]))));
  return out;
}

/**
 * Begin a resolve run over `items` — one of them, or all of them. `names` are
 * the custom jobs to ask about after it.
 */
let ncNames = [];
function startCodeRun(items, { names = [] } = {}) {
  ncQueue = items;
  ncIndex = 0;
  ncUndo = [];
  ncNames = names;
  showNewCode();
}

function endCodeRun({ chain = true } = {}) {
  const names = chain ? ncNames : [];
  ncQueue = [];
  ncUndo = [];
  ncNames = [];
  $('newCodeOverlay').classList.remove('show');
  rebuild();                   // a new code can rename jobs, so ask from the rebuilt board
  flushDeferredRebuild();
  if (!names.length) return;
  const ask = new Set(names.map((j) => j.prod_no));
  const still = (state.board?.warnings?.customNames ?? []).filter((j) => ask.has(j.prod_no));
  if (still.length) startNameRun(still);
}

/** Put back every code accepted during this run, newest first. */
function cancelCodeRun() {
  const undone = [...ncUndo].reverse();
  endCodeRun({ chain: false });
  if (!undone.length) return;
  const after = new Map(undone.map(({ code }) => [code, state.codeMap[code]]));
  edit({
    rows: undone.map(({ code }) => `code:${code}`),
    what: 'Codes not put back',
    said: `${count(undone.length, 'code')} put back.`,
    apply: () => {
      for (const { code, before } of undone) {
        if (before) state.codeMap[code] = before; else delete state.codeMap[code];
      }
    },
    undo: () => { for (const [code, entry] of after) state.codeMap[code] = entry; },
    write: () => Promise.all(undone.map(({ code, before }) =>
      (before ? Store.saveCode(code, before) : Store.deleteCode(code)))),
  });
}

function showNewCode() {
  const item = ncQueue[ncIndex];
  if (!item) { endCodeRun(); return; }

  // Only meaningful mid-run. Resolving a single row has nothing to skip and
  // nothing to abandon — Decide later already closes it.
  const rest = ncQueue.length - ncIndex - 1;
  $('ncSkipRest').hidden = rest < 1;
  $('ncSkipRest').textContent = `Skip the remaining ${rest}`;
  // Only while there is something to undo: before that it is Skip by another name.
  $('ncCancelRun').hidden = !ncUndo.length;
  $('ncCancelRun').textContent = `Cancel & undo ${ncUndo.length}`;

  $('ncProgress').textContent = ncQueue.length > 1 ? `${ncIndex + 1} of ${ncQueue.length}` : '';
  $('ncLede').textContent =
    `This export carries ${count(item.count, 'job')} under a vessel code the board has `
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
  row('Model', item.models.join(', '));
  row('Hull prefix', item.hull_prefix.join(', '));
  row('Description', item.descriptions[0] ?? '');

  // What each choice would actually print, using the real template for the
  // first item — a preview beats a description of a preview.
  const preview = (display) => {
    const fake = { [item.code]: { display, _confirmed: true, models: item.models } };
    return labelFor(item.items[0], null, fake) ?? display;
  };

  $('ncStella').textContent = item.code;
  $('ncStellaPreview').textContent = preview(item.code);

  const model = item.suggestion.model;
  $('ncModelOpt').hidden = !model;
  if (model) {
    $('ncModel').textContent = model;
    $('ncModelPreview').textContent = preview(model);
  }

  const sel = $('ncExisting');
  sel.textContent = '';
  for (const b of existingBoats(state.codeMap)) {
    const o = document.createElement('option');
    o.value = b.boat;
    o.textContent = `${b.display}  (${b.codes.join(', ')})`;
    sel.append(o);
  }
  // No boat on file yet: nothing to add it to.
  sel.closest('.scope-opt').hidden = !sel.options.length;

  $('ncCustom').value = '';
  accept($('ncCustom'));
  accept(sel);
  $('newCodeOverlay').classList.add('show');
}

function chooseNewCode(mode) {
  const item = ncQueue[ncIndex];
  const choice = { mode };
  if (mode === 'existing') {
    choice.boat = $('ncExisting').value;
    if (!choice.boat) { refuse($('ncExisting'), 'No boat chosen.'); return; }
  }
  if (mode === 'custom') {
    choice.value = $('ncCustom').value.trim();
    if (!choice.value) { refuse($('ncCustom'), 'A code is required.'); return; }
  }

  const entry = acceptNewCode(item.code, choice, item);
  const before = state.codeMap[item.code] ?? null;
  ncUndo.push({ code: item.code, before });
  edit({
    rows: [`code:${item.code}`],
    what: `${item.code} not saved`,
    said: mode === 'existing'
      ? `${item.code} joined ${$('ncExisting').selectedOptions[0].textContent.trim()}`
      : `${item.code} will print as "${entry.display}"`,
    apply: () => { state.codeMap[item.code] = entry; },
    undo: () => { if (before) state.codeMap[item.code] = before; else delete state.codeMap[item.code]; },
    write: () => Store.saveCode(item.code, entry),
    // Restage per answer, not only when the queue empties: the import review is
    // sitting behind this dialog and a resolved code should leave its list as
    // soon as it is resolved. The board itself waits for the run to end.
    draw: () => { if (dialogOpen()) { restage(); rebuildDeferred = true; } else rebuild(); },
  });

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
    head.dataset.focus = key;
    head.setAttribute('aria-expanded', String(!shut));
    head.append(el('span', 'cat-caret', shut ? '\u25b8' : '\u25be'));
    head.append(el('h2', null, cat));
    head.append(el('span', 'n', String(list.length)));
    head.addEventListener('click', () => {
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      saveCollapsed(collapsed);
      keepFocus(() => renderLane(lane));
    });
    blk.append(head);

    if (!shut) {
      const table = el('div', 'lane-table');
      const hdr = el('div', 'lane-row lane-head');
      hdr.append(el('span', null, 'Prod Nbr'), el('span', null, 'Job'),
        el('span', null, lane === 'tm' ? 'For' : 'Item'),
        el('span', 'created', 'Created'), el('span', null, 'Open'), el('span', null, ''));
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
  row.append(createdCell(j), age);

  const acts = el('span', 'acts');
  // On a phone the column gives way and the opened row carries the date.
  const created = createdNote(j);
  if (created) acts.append(created);
  const lbl = el('button', 'mini', 'Label');
  lbl.addEventListener('click', () => openLabelEditor(j));
  const hide = el('button', 'mini', j.hidden ? 'Show' : 'Hide');
  hide.addEventListener('click', () => (j.hidden ? unhide(j) : openHideDialog(j)));
  const done = el('button', 'mini', 'Complete');
  done.title = 'Mark completed \u2014 reversible from History';
  done.addEventListener('click', () => openCompleteDialog([j]));
  acts.append(lbl, hide, statusControl(j), done);
  row.append(acts);
  const fault = faultLine(j.prod_no, rebuild);
  if (fault) row.append(fault);
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
// The review is drawn by import-review.js, which also keeps which count,
// concerns and groups are open. Every click there draws the page again.
const review = createReview(() => renderImport());

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
  // What this import actually changes, against the board already loaded.
  const diff = diffBoards(state.source ? state.board : null, b, staged.src.rows);
  // Counts, each one openable to its full contents.
  const stat = (key, n, note) => ({
    key, n, note, label: IMPORT_DETAIL[key].label, detail: () => importDetail(b, key, diff),
  });

  const problems = exportProblems(staged.src);
  const empty = !(b.meta.job_count + b.meta.internal_count + b.meta.tm_count);
  host.append(review.render({
    title: 'Review this import',
    lede: `${staged.src.sourceLabel} \u2014 ${staged.src.rows.length} rows from the `
      + `"${staged.src.sheetName}" sheet. Nothing changes until you apply it.`,
    // What an import does and does not touch. Worth saying on the page rather
    // than only in the README: the word "import" reads like "replace".
    notes: [{
      cls: 'import-scope',
      text: 'An import replaces the ERP rows only. Everything decided here \u2014 labels, '
        + 'vessel codes, hidden jobs, hand-set statuses and completed work \u2014 is '
        + 'keyed on the production number and survives it. Completed jobs stay in '
        + 'History even once the ERP stops exporting them.',
    }],
    stats: [
      stat('production', b.meta.job_count, `${b.meta.print_count} on the printed sheet`),
      stat('internal', b.meta.internal_count),
      stat('tm', b.meta.tm_count),
      stat('excluded', b.excluded.length, 'by status or category'),
    ],
    summary: importSummary(diff),
    concerns: importConcerns(b, staged.src),
    clean: 'Nothing outstanding \u2014 every row classified cleanly.',
    actions: {
      apply: {
        label: 'Apply this import',
        run: commitImport,
        blocked: empty ? 'No open jobs in this file, so there is nothing to apply.' : null,
      },
      cancel: {
        label: 'Discard import',
        run: () => { staged = null; renderImport(); toast('Import discarded. Nothing changed.'); },
      },
      risky: problems.length > 0,
      hint: problems.length ? null : 'You can apply with these outstanding \u2014 they will still be waiting on the board.',
    },
  }));
}

/** What is wrong with the file itself: columns missing, no rows. */
const exportProblems = (src) => (src.warnings ?? []).filter((w) => !w.startsWith('Note:'));

/**
 * One line on what changes, above the detail that proves it.
 *
 * The counts are the point: "152 unchanged" is what makes the other three
 * numbers worth reading, and it is the number a flat list hides.
 */
function importSummary(diff) {
  if (diff.first) {
    return { first: 'First import — nothing to compare against, so every row is new.' };
  }
  const { added, changed, same, leaving } = diff.counts;
  return {
    lead: 'Against the board you have now:',
    parts: [
      { n: added, label: 'new', cls: 'is-new' },
      { n: changed, label: 'changed', cls: 'is-changed' },
      { n: same, label: 'unchanged', cls: 'is-same' },
      { n: leaving, label: 'leaving the board', cls: 'is-leaving' },
    ],
    after: !added && !changed && !leaving ? 'nothing has moved since the last export' : null,
  };
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

  const problems = exportProblems(src);
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
      note: 'Off the board until a category rule is added. Report them to the design office.',
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
  // lane rule keys on Type. SDC0000, the davit rope kit, is the standing
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
        action: { label: j.hidden ? 'Show' : 'Hide', run: () => (j.hidden ? unhide(j) : openHideDialog(j)) },
      })),
    });
  }

  // "Will not print" is deliberately NOT here. A watermaker has no column on
  // the sheet and a job past the horizon is not yet due — both by construction,
  // neither a thing to decide. The count strip already says how many print, and
  // the production detail marks each one.
  return out;
}

/** The full contents of one count, so "69 production orders" can be checked. */
function importDetail(b, key, diff = null) {
  const cfg = IMPORT_DETAIL[key];

  if (key === 'excluded') {
    // Grouped by reason so like sits with like, commonest first. Each group
    // starts shut: the list runs to four figures, and scrolling past 730
    // completed rows to reach the next heading is not a sanity check, it is an
    // obstacle.
    const byReason = new Map();
    for (const e of b.excluded) {
      if (!byReason.has(e.reason)) byReason.set(e.reason, []);
      byReason.get(e.reason).push(e);
    }
    return {
      title: `Every excluded row (${b.excluded.length})`,
      note: 'Not on any tab. A sanity check on what the rules are throwing away.',
      groups: [...byReason].sort((a, b2) => b2[1].length - a[1].length).map(([reason, rows]) => ({
        key: `excl:${reason}`,
        title: reason,
        shutByDefault: true,
        rows: rows.map((e) => ({
          key: e.prod_no, main: e.inventory_id, detail: e.description || e.item_description || '',
        })),
      })),
    };
  }

  const all = key === 'production'
    ? (b.jobs ?? []).filter((j) => !j.completed)
    : (b[cfg.lane] ?? []).filter((j) => !j.completed);
  const stateOf = (j) => (diff && !diff.first ? diff.state.get(j.prod_no) : null);
  const movers = diff && !diff.first ? all.filter((j) => stateOf(j) !== 'same') : all;
  // Most rows in an export are unchanged, so the list can be narrowed to the
  // ones that are not. Off by default: the full list is still the sanity check.
  const changedOnly = review.isOn('changedOnly');
  const jobs = changedOnly ? movers : all;

  const order = key === 'production' ? CATEGORY_ORDER
    : key === 'tm' ? TM_CATEGORY_ORDER : INTERNAL_CATEGORY_ORDER;
  const byCat = new Map(order.map((c) => [c, []]));
  for (const j of jobs) {
    if (!byCat.has(j.category)) byCat.set(j.category, []);
    byCat.get(j.category).push(j);
  }

  const groups = [...byCat].map(([cat, rows]) => ({
    key: `${key}:${cat}`,
    title: cat,
    rows: rows.map((j) => {
      const st = stateOf(j);
      // The tag says WHAT moved, not merely that something did: a status and a
      // due date want different reactions from whoever is reading this.
      const marks = [];
      if (st === 'new') marks.push({ cls: 'fr-tag is-new', text: 'new' });
      else if (st === 'changed') {
        marks.push({ cls: 'fr-tag is-changed', text: diff.changes.get(j.prod_no).map((c) => c.field).join(', ') });
      }
      if (key === 'production' && !isPrintable(j)) marks.push({ cls: 'fr-note', text: 'no print' });
      return {
        cls: [key === 'production' && !isPrintable(j) ? 'is-offpaper' : '', st ? `is-${st}` : '']
          .filter(Boolean).join(' '),
        key: j.prod_no,
        main: jobTitle(j),
        detail: key === 'production'
          ? j.due_display
          : `${j.customer_display ?? ''}${j.age_display ? ` \u00b7 open ${j.age_display}` : ''}`,
        marks,
        // A changed row opens to each field as it was and as it is.
        wire: st === 'changed'
          ? (row) => wireChangeRow(row, j.prod_no, diff.changes.get(j.prod_no), staged.src.retrievedAt)
          : undefined,
      };
    }),
  }));

  // On the board now and not in this export: closed upstream since the last
  // one. Staging is the only moment the two lists exist side by side, so it is
  // the only place this can be shown at all.
  const going = (diff?.leaving ?? []).filter((j) => (j.lane ?? 'production') === cfg.lane);
  if (going.length) {
    groups.push({
      key: `${key}:leaving`,
      title: 'Leaving the board',
      rows: going.map((j) => ({
        cls: 'is-leaving',
        key: j.prod_no,
        main: jobTitle(j),
        // WHY, not just that. "Completed" and "cancelled" are the same event to
        // the board and very different events to a person reading this.
        detail: j.leaving_why ?? '',
        marks: [{ cls: 'fr-tag is-leaving', text: 'leaving' }],
      })),
    });
  }

  return {
    title: `Every ${cfg.label.replace(/s$/, '')} (${jobs.length})`,
    // Offered only when it would actually narrow something.
    toggle: diff && !diff.first && movers.length < all.length
      ? { id: 'changedOnly', label: changedOnly ? `Showing the ${movers.length} that moved` : 'Only what changed' }
      : null,
    groups,
  };
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
function cancelNameRun() {
  const undone = [...cnUndo].reverse();
  endNameRun();
  for (const { prodNo, before } of undone) setOverride(prodNo, { labelOverride: before ?? null });
  if (undone.length) toast(`${count(undone.length, 'name')} put back.`);
}

function showCustomName() {
  const job = cnQueue[cnIndex];
  if (!job) { endNameRun(); return; }
  const o = job.name_options;

  const rest = cnQueue.length - cnIndex - 1;
  $('cnSkipRest').hidden = rest < 1;
  $('cnSkipRest').textContent = `Skip the remaining ${rest}`;
  $('cnCancelRun').hidden = !cnUndo.length;
  $('cnCancelRun').textContent = `Cancel & undo ${cnUndo.length}`;

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
  accept($('cnCustom'));
  $('customNameOverlay').classList.add('show');
}

function chooseCustomName(mode) {
  const job = cnQueue[cnIndex];
  const o = job.name_options;
  const label = mode === 'description' ? o.description.label
    : mode === 'customer' ? o.customer.label
      : $('cnCustom').value.trim();
  if (isEmptyCustomName(label)) { refuse($('cnCustom'), 'A name is required.'); return; }

  cnUndo.push({ prodNo: job.prod_no, before: state.overrides[job.prod_no]?.labelOverride ?? null });
  setOverride(job.prod_no, { labelOverride: label }, `${job.prod_no} will read "${label}"`);

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

  // Scope 3 — every product on this boat.
  $('scopeCode').hidden = !onABoat;
  if (onABoat) {
    const group = state.board.resolved.groups.find((g) => g.codes.includes(code));
    const n = state.board.jobs.filter((j) => group.codes.includes(stellaCode(j.inventory_id) ?? '')).length;
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
    $('lblSave').textContent = 'Save label';
    $('lblInput').value = job.label;
    $('lblHint').textContent = `Replaces the label on ${job.prod_no} only.`;
    $('lblReset').hidden = job.label === job.base_label;

  } else if (scope === 'item') {
    // A vessel-coded item gets a code (the template still supplies the wording);
    // anything else — davits, chocks — has no code, so it gets a whole label.
    if (code) {
      $('lblFieldLabel').textContent = `Display code for ${job.inventory_id}`;
      $('lblSave').textContent = 'Save display code';
      $('lblInput').value = pinned?.displayCode
        ?? state.board.resolved.display.get(code) ?? code;
      // The example is built from THIS item, so it is never a code from
      // somebody's real order book.
      const sample = applyTemplate(job.inventory_id, 'XX00');
      $('lblHint').textContent = `Code only — wording comes from the template ("XX00" → "${sample}").`;
    } else {
      $('lblFieldLabel').textContent = `Label for ${job.inventory_id}`;
      $('lblSave').textContent = 'Save label';
      $('lblInput').value = pinned?.label ?? job.base_label;
      $('lblHint').textContent = 'No vessel code on this item, so this is the whole label.';
    }
    $('lblReset').hidden = !pinned;

  } else {
    const group = state.board.resolved.groups.find((g) => g.codes.includes(code));
    $('lblFieldLabel').textContent = `Display code for boat ${group.boat ?? group.codes[0]}`;
    $('lblSave').textContent = 'Save display code';
    $('lblInput').value = state.board.resolved.display.get(code) ?? code;
    $('lblHint').textContent = `Applies to ${group.codes.join(', ')} — every product on this boat.`;
  }
  accept($('lblInput'));
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
  $('lblReset').addEventListener('click', () => {
    const scope = $('lblForm').dataset.scope;
    const job = editing;
    closeLabel();
    if (scope === 'item') {
      setItemOverride(job, { label: null, displayCode: null }, 'Label not reset',
        `${job.inventory_id} back to the ${stellaCode(job.inventory_id) ? 'code of its boat' : 'ERP description'}.`);
    } else {
      setOverride(job.prod_no, { labelOverride: null }, `${job.prod_no} label reset.`);
    }
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
  $('hideReason').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveHide(); });
  $('hullCancel').addEventListener('click', () => {
    $('hullOverlay').classList.remove('show');
    flushDeferredRebuild();
  });
  $('hullSave').addEventListener('click', () => saveHull($('hullInput').value));
  $('hullClear').addEventListener('click', () => saveHull(''));
  $('hullInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveHull($('hullInput').value); });

  // Pressed AND released on the backdrop, or Escape - see dialog.js.
  // Highlighting the text in a field and letting go outside the box used to
  // close these.
  for (const id of ['labelOverlay', 'hideOverlay', 'hullOverlay', 'completeOverlay']) {
    closeOnBackdrop($(id), () => { $(id).classList.remove('show'); flushDeferredRebuild(); });
  }
  // The two questions an import asks: Escape leaves the rest for later, and a
  // stray click outside does nothing.
  closeOnEscape($('newCodeOverlay'), () => endCodeRun({ chain: false }));
  closeOnEscape($('customNameOverlay'), () => endNameRun());
}

function saveLabel() {
  const value = $('lblInput').value.trim();
  if (!value) {
    refuse($('lblInput'), $('lblForm').dataset.scope === 'code' || $('lblSave').textContent === 'Save display code'
      ? 'A display code is required.' : 'A label is required.');
    return;
  }
  const scope = $('lblForm').dataset.scope;
  const job = editing;
  closeLabel();

  if (scope === 'job') {
    setOverride(job.prod_no, { labelOverride: value }, `${job.prod_no} relabelled.`);

  } else if (scope === 'item') {
    const code = stellaCode(job.inventory_id);
    const patch = code ? { displayCode: value, label: null } : { label: value, displayCode: null };
    setItemOverride(job, patch, 'Label not saved', code
      ? `${job.inventory_id} now prints "${applyTemplate(job.inventory_id, value)}".`
      : `${job.inventory_id} now prints "${value}".`);

  } else {
    const code = stellaCode(job.inventory_id);
    const group = state.board.resolved.groups.find((g) => g.codes.includes(code));
    const before = new Map(group.codes.map((c) => [c, state.codeMap[c]]));
    edit({
      rows: [job.prod_no],
      what: 'Display code not saved',
      said: `Boat ${group.boat ?? group.codes[0]} (${group.codes.join(', ')}) now displays "${value}".`,
      // Confirming one member confirms the boat — the group displays as one.
      apply: () => {
        for (const c of group.codes) state.codeMap[c] = { ...(state.codeMap[c] ?? {}), display: value, _confirmed: true };
      },
      undo: () => {
        for (const [c, entry] of before) { if (entry) state.codeMap[c] = entry; else delete state.codeMap[c]; }
      },
      write: () => Promise.all(group.codes.map((c) => Store.saveCode(c, { display: value, _confirmed: true }))),
    });
  }
}

/** A decision on an item code, for every job on it; a failure is said on the row it was made from. */
function setItemOverride(job, patch, what, said = null) {
  const id = job.inventory_id;
  let before;
  return edit({
    rows: [job.prod_no],
    what,
    said,
    apply: () => {
      before = state.itemOverrides[id];
      const next = { ...(before ?? {}), ...patch };
      for (const k of ['label', 'displayCode', 'partOrder']) if (next[k] === null) delete next[k];
      if (next.label || next.displayCode || next.partOrder != null) state.itemOverrides[id] = next;
      else delete state.itemOverrides[id];
    },
    undo: () => {
      if (!carries(state.itemOverrides[id], patch)) return;
      if (before) state.itemOverrides[id] = before; else delete state.itemOverrides[id];
    },
    write: () => Store.setItemOverride(id, patch),
    saved: () => logChange(describeItemOverride(patch), null, id),
  });
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
let hulling = null;

/**
 * The hull for a job, typed in. For the units whose order text the admin never
 * wrote a hull into, and for the odd one where what they wrote is wrong.
 */
function openHullDialog(job) {
  hulling = job;
  accept($('hullInput'));
  $('hullLede').textContent = `${job.prod_no} \u2014 ${jobTitle(job)}${whenWords(job)}.`;
  $('hullInput').value = job.hull ?? '';
  $('hullHint').textContent = job.hull_auto
    ? `The ERP's order text says ${job.hull_auto}. What is typed here shows instead, for this job only, and survives the next upload.`
    : 'The ERP\'s order text has no hull for this job. What is typed here shows on the page for this job only, never on the printed sheet, and survives the next upload.';
  $('hullClear').hidden = !job.hull_manual;
  $('hullOverlay').classList.add('show');
  $('hullInput').focus();
  $('hullInput').select();
}

function saveHull(raw) {
  if (!hulling) return;
  const value = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const job = hulling;
  hulling = null;
  $('hullOverlay').classList.remove('show');
  // Typing the ERP's own hull, or nothing, is a return to the ERP's.
  if (!value || value === job.hull_auto) {
    if (job.hull_manual) {
      setOverride(job.prod_no, { hullOverride: null },
        `${job.prod_no}: hand-set hull removed${job.hull_auto ? ` \u2014 ${job.hull_auto}` : ''}.`);
    }
    flushDeferredRebuild();
    return;
  }
  setOverride(job.prod_no, { hullOverride: value }, `${job.prod_no}: hull ${value}.`);
  flushDeferredRebuild();
}

/**
 * Part order or unit, for every job on this item code. The shape of the code
 * decides unless the manager has said otherwise; saying what the shape already
 * says clears the override rather than pinning it.
 */
function togglePartOrder(job) {
  const auto = isPartOrder(job.inventory_id);
  const next = !job.part_order;
  setItemOverride(job, { partOrder: next === auto ? null : next }, 'Part mark not saved', next
    ? `${job.inventory_id} is a part order: every job on it follows the Part orders toggle.`
    : `${job.inventory_id} is a unit: the Part orders toggle leaves it alone.`);
}

function openHideDialog(job) {
  hiding = job;
  $('hideLede').textContent = `${job.prod_no} — ${jobTitle(job)}${whenWords(job)}.`;
  $('hideReason').value = '';
  $('hideOverlay').classList.add('show');
  $('hideReason').focus();
}

function saveHide() {
  const job = hiding;
  if (!job) return;
  hiding = null;
  $('hideOverlay').classList.remove('show');
  setOverride(job.prod_no, { hidden: true, hiddenReason: $('hideReason').value.trim() || null },
    `${job.prod_no} hidden from the printed board.`);
  flushDeferredRebuild();
}

function unhide(job) {
  setOverride(job.prod_no, { hidden: false, hiddenReason: null }, `${job.prod_no} back on the board.`);
}

// ---------------------------------------------------------------------------
// saving
//
// THE SCREEN FIRST, THE WRITE BEHIND IT. A Firestore write resolves when the
// server has it, which offline is when the connection returns, so nothing on
// screen waits for one: no dialog stays up, no row stays as it was. A write
// the server refuses puts the row back as it was and says why on it, with a
// Retry (faults.js). The log line follows the write it describes.
// ---------------------------------------------------------------------------

/**
 * @param {object} e
 * @param {string[]} e.rows   the rows it is about, where a failure is said
 * @param {string} e.what     what has not been done if it fails: "Hull not saved"
 * @param {string} [e.said]   in passing, once the screen has changed
 * @param {() => void} e.apply
 * @param {() => void} e.undo
 * @param {() => Promise} e.write
 * @param {() => void} [e.saved]
 * @param {() => void} [e.draw]   how the change is drawn; the whole board unless said
 * @returns {Promise<boolean>} whether it saved
 */
async function edit(e) {
  const { rows, what, said, apply, undo, write, saved, draw = rebuild } = e;
  for (const k of rows) clearFault(k);
  if (e.failed) unsay(e.failed);                // this is its Retry
  apply();
  draw();
  if (said) toast(said);
  try {
    await write();
  } catch (err) {
    undo();
    const words = failure(what, err);
    for (const k of rows) setFault(k, words, () => edit(e));
    if (dialogOpen()) rebuildDeferred = true; else rebuild();
    e.failed = /^(hist|code):/.test(rows[0]) || rows.length > 1 ? words : `${rows[0]} \u2013 ${words}`;
    toastFailed(e.failed);
    return false;
  }
  saved?.();
  shareFloorSoon();
  return true;
}

/** A job's record as it was; nothing left in it is no record. */
function putBack(prodNo, record) {
  if (record && Object.keys(record).length) state.overrides[prodNo] = record;
  else delete state.overrides[prodNo];
}

function setOverride(prodNo, patch, said = null) {
  let before;
  return edit({
    rows: [prodNo],
    what: notDone(patch),
    said,
    apply: () => {
      before = state.overrides[prodNo];
      const next = { ...(before ?? {}), ...patch };
      if (patch.labelOverride === null) delete next.labelOverride;
      if (patch.hullOverride === null) delete next.hullOverride;
      if (patch.plinth === null) delete next.plinth;
      if (patch.status === null) { delete next.status; delete next.statusFrom; }
      if (next.hidden === false) { delete next.hidden; delete next.hiddenReason; }
      putBack(prodNo, next);
    },
    // The live listener may have put the server's own value back already.
    undo: () => { if (carries(state.overrides[prodNo], patch)) putBack(prodNo, before); },
    write: () => Store.setOverride(prodNo, patch, Auth.user?.email ?? 'local'),
    saved: () => logChange(describeOverride(patch), prodNo),
  });
}

/**
 * A line in the activity log for the edit just made: who, when, which job,
 * what. Fire and forget - a log write that fails must not undo or delay the
 * edit it describes, so it is warned about and nothing more.
 */
function logChange(desc, prodNo = null, inventoryId = null, label = null) {
  if (!desc) return;
  const b = state.board ?? {};
  const job = prodNo
    ? [...(b.jobs ?? []), ...(b.internal ?? []), ...(b.tm ?? []), ...(b.completed ?? [])].find((j) => j.prod_no === prodNo)
    : null;
  const entry = activityEntry({
    ...desc,
    by: Auth.user?.email ?? 'local',
    prodNo,
    inventoryId: inventoryId ?? job?.inventory_id ?? null,
    label: label ?? (job ? jobTitle(job) : null),
  });
  Store.logActivity(entry).catch((e) => console.warn('[activity]', e.message));
}

// ---------------------------------------------------------------------------

// Which categories are rolled up. A device preference, not a shared setting —
// it says nothing about the work, so it does not belong in Firestore, and a
// write per toggle would be needlessly chatty.
const COLLAPSE_KEY = 'stella.board.collapsed';
const loadCollapsed = () => {
  try { return new Set(JSON.parse(prefs.get(COLLAPSE_KEY) ?? '[]')); }
  catch { return new Set(); }
};
const saveCollapsed = (set) => prefs.set(COLLAPSE_KEY, JSON.stringify([...set]));
let collapsed = loadCollapsed();
