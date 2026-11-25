// parts-page.js — the part list on screen: search it, correct it, import it.
//
// Three audiences on one page, shown by role:
//   - the floor, on a phone, looking a part up             -> Search
//   - drafting, noticing a description or bin is wrong      -> Corrections
//   - the manager who runs the export and can fix the ERP   -> Import
//
// Everything that decides is in parts.js; this draws and wires.

import { Store } from './store.js';
import { Auth, ROLE, setManagers, setEngineers, setMasters, setTesters, tidyEmail } from './auth.js';
import { VERSION } from './version.js';
import { wireHelp } from './help.js';
import { readStockExport } from './adapters/stock.js';
import { downloadWorkbook } from './adapters/drafting-xlsx.js';
import { closeOnBackdrop, keepFocus, watchDialogs } from './dialog.js';
import { toast, toastFailed, unsay } from './toast.js';
import { count, failure, reason } from './words.js';
import { busy } from './busy.js';
import { refuse, accept } from './field.js';
import { choose } from './ask.js';
import { faultOf, setFault, clearFault, faultLine } from './faults.js';
import { writeBehind } from './write-behind.js';
import { wireSettings } from './settings.js';
import { whoShort } from './activity.js';
import { showTestMode, carryFlag, isTestMode, prefs } from './test-mode.js';
import { createReview } from './import-review.js';
import { stockReview, settleAnswers, materialsReview } from './parts-review.js';
import {
  transformParts, validateStockExport, diffParts, unknownFamilies,
  buildIndex, search, browse, familyCounts, hasBin, effective,
  createOverride, reconcile, resolveReview, overrideKey, isActive, clean, tidyValue,
  fixList, fixListCsv, ageInDays, STALE_DAYS, FAMILIES, META_FIELDS, OVERRIDE_FIELDS, FIELD_NAME, STATUS_NAME, metaLine,
  draftingSheets, workbookName, localDate, withdrawOverride,
  parseMaterialsCsv, buildMaterialsIndex, materialGroups, browseMaterials,
  copyApart, partFileName, copyFailure, COPY_FAILED,
} from './parts.js';
import { startup, keepWatch, deviceCache, recallSession, rememberSession, forgetDevice, hold, isHeld, LOST_FOR } from './boot.js';
import { isConfigured } from './firebase.js';
import './press.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---- state ----------------------------------------------------------------
let record = null;          // the stored list document
let parts = [];             // [{id, desc, bin}]
let partsById = new Map();
let overrides = {};         // key -> override
let index = [];
let materials = null;       // the stored manifest document
let manifest = [];          // [{code, desc, category, subcategory, qtyType}]
let mindex = [];            // the materials, joined with the part list
let role = ROLE.NONE;
let who = null;
let tab = 'search';
const filters = { family: null, bin: 'all', binFirst: false, byDesc: false };
const mfilters = { category: null, subcategory: null };
const open = new Set();     // expanded result cards, by id
// What the server did not answer at start-up, and why: { record, overrides, materials }.
let failed = {};
// Windows keeps a clipboard history (Win+V); "Copy for sheet" is for that.
const HAS_CLIPBOARD_HISTORY = /\bWindows\b/.test(navigator.userAgent);

// What this device was left on: the tab, the pills and the two orders.
const VIEW_KEY = 'stella.parts.view';
const rememberView = () => prefs.set(VIEW_KEY, JSON.stringify({ tab, ...filters, ...mfilters }));

/** Put the pills and the orders back as they were left; the tab that was open is returned. */
function recallView() {
  let v = null;
  try { v = JSON.parse(prefs.get(VIEW_KEY) ?? 'null'); } catch { /* nothing kept */ }
  if (FAMILIES.includes(v?.family)) filters.family = v.family;
  if (['with', 'without'].includes(v?.bin)) filters.bin = v.bin;
  filters.binFirst = v?.binFirst === true;
  filters.byDesc = v?.byDesc === true;
  if (typeof v?.category === 'string') mfilters.category = v.category;
  if (typeof v?.subcategory === 'string') mfilters.subcategory = v.subcategory;
  return v?.tab in TABS ? v.tab : 'search';
}

function booting(what) {
  const box = $('booting');
  if (!box) return;
  if (what === false) { box.remove(); $('bootSkeleton')?.remove(); return; }
  $('bootWhat').textContent = what;
}

// Start-up, watched: a time limit on each step, a retry on fresh connections,
// and the offline line. See boot.js.
const watch = startup();

// While the list on screen is the copy saved on the device, or came without
// its corrections, Corrections and Import are held (Pete, 23 Nov 2026) with
// "Latest part list not yet loaded" beside them; Search and Materials work
// throughout.
const PART_EDITS = '#ptFixBtn, #ptImportBtn, .corrects, #partsFile, #matFile';
let releaseHold = null;
// The account and role the saved copy was drawn for, or null when nothing was.
let savedFor = null;

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(async function boot() {
  $('pageVersion').textContent = `v${VERSION}`;
  watchDialogs();

  // THE DEVICE FIRST: the list this device last loaded, drawn while sign-in
  // is restored. Then the same shape as the codes page: the store comes up
  // before the role is read, because the access lists live in Firestore and
  // Firebase reports the user before the store exists.
  const early = drawSaved().catch((e) => { console.warn('[saved]', e.message); return null; });
  booting('Connecting');
  watch.step('sign-in');
  const first = await new Promise((resolve) => {
    let done = false;
    Auth.init((st) => { if (!done) { done = true; resolve(st); } })
      .then((mode) => {
        if (mode !== 'failed') return;
        // Offline is said already, and waited out; else the page reloads, once.
        watch.retry();
        if (navigator.onLine === false) stalled();
        else { watch.done(); stalled({ code: 'unavailable' }); }
      });
  });
  const saved = await early;
  if (first.role === ROLE.NONE || (saved && tidyEmail(first.email) !== saved.email)) {
    // Signed out, or somebody else: nothing saved stays for them.
    await forgetDevice();
    if (saved && window.__boot?.reloadOnce?.()) return;
  }
  watch.step('connect');
  await Store.init();
  // The list is asked for with the access read, not after it: neither needs
  // the other's answer.
  const reading = first.role === ROLE.NONE ? null : readAll();
  booting('Checking your access');
  watch.step('access', 'firestore');
  const access = await Store.loadAccess();
  setManagers(access.managers);
  setEngineers(access.engineers);
  setMasters(access.masters);
  setTesters(access.testers);
  role = Auth.refreshRole();
  who = first.email ?? null;
  // The saved copy was drawn for a role; another answer starts the page again.
  if (saved && saved.role !== role) {
    await forgetDevice();
    if (window.__boot?.reloadOnce?.()) return;
  }
  if (Auth.mode === 'firebase' && role !== ROLE.NONE) rememberSession(who, role);
  // A tester is in test mode from here, flag or no flag; see test-mode.js.
  if (Auth.isTester) Store.enterTestMode();
  showTestMode();
  present();

  if (role === ROLE.NONE) {
    booting(false);
    watch.done();
    // A list drawn from the device for an account that is no longer signed in.
    $('partsTabs').hidden = true;
    for (const id of Object.values(TABS)) $(id).hidden = true;
    const host = $('partsDenied');
    host.hidden = false;
    host.append(el('strong', null, 'Sign in to look up parts'));
    host.append(el('div', null, 'The part list is for signed-in accounts. Sign in on the board, then come back.'));
    const back = el('a', 'backlink', 'Go to the board');
    back.href = carryFlag('./');
    host.append(back);
    return;
  }

  booting('Loading the part list');
  watch.step('parts', 'firestore');
  land(await (reading ?? readAll()));
  watch.done();
  keepWatch({ what: 'Part list', onLink: (cb) => { tellLink = cb; } });
})().catch((e) => {
  console.error('[parts]', e);
  watch.done();
  stalled(e);
});

/**
 * Start-up has ended without a list: the waiting stops, and the way on is to
 * load the page again. A copy saved on the device stays where it is.
 */
function stalled(e = null) {
  booting(false);
  const host = $('partsFault');
  host.textContent = '';
  if (e) host.append(el('span', 'fault-words', failure(record ? 'Latest part list not loaded' : 'Part list not loaded', e)));
  const retry = el('button', 'mini', 'Retry');
  retry.addEventListener('click', () => location.reload());
  host.append(retry);
  host.hidden = false;
}

/**
 * What the server answered, on the page. What it did not answer stays as it
 * was - the saved copy's, or nothing - and says so, with a Retry. A read that
 * failed is not an empty list: it is never drawn as one, and never kept on
 * the device as one.
 */
function land(read) {
  const shownAt = savedFor ? record?.importedAt ?? '' : null;
  const next = { record, overrides, materials, ...read.got };
  const changed = !entered || !sameCopy(copyOf(next), copyOf({ record, overrides, materials }));
  failed = read.failed;
  if (changed) apply(next);
  if (failed.record || failed.overrides) releaseHold = releaseHold ?? hold(PART_EDITS);
  else { releaseHold?.(); releaseHold = null; }
  booting(false);
  renderLoadFault();
  // With no list at all the failure is the page.
  if (failed.record && !record) return;
  enter();
  if (changed) renderAll(); else { renderMaterials(); renderMatReview(); }
  openWaitingTab();
  if (shownAt !== null && (record?.importedAt ?? '') > shownAt) toast('Part list updated from a newer export.', 5000);
  confirmed = !Object.keys(failed).length;
  saveCopy();
}

/** The list, or the corrections to it, that did not load: above the tabs, with the way to try again. */
function renderLoadFault() {
  const host = $('partsFault');
  const line = failed.record ? loadFault(record ? 'Latest part list not loaded' : 'Part list not loaded', failed.record)
    : failed.overrides ? loadFault('Corrections not loaded', failed.overrides) : null;
  host.replaceChildren(...(line ?? []));
  host.hidden = !line;
}

/** The words for something that did not load, and its Retry. */
function loadFault(what, e) {
  const retry = el('button', 'mini', 'Retry');
  retry.addEventListener('click', () => busy(retry, 'Loading…', async () => land(await readAll())));
  return [el('span', 'fault-words', failure(what, e)), retry];
}

/**
 * The part list as this device last had it, drawn before anything has
 * answered: for an account this device has seen, with a list saved. Local
 * mode has the list on the device already, and test mode writes nothing to
 * it, so neither draws from here.
 *
 * @returns {Promise<{email: string, role: string}|null>} who it was drawn for
 */
async function drawSaved() {
  if (!isConfigured() || isTestMode()) return null;
  const session = await recallSession();
  if (!session || session.role === ROLE.NONE) return null;
  const copy = await deviceCache.get('parts');
  if (!copy?.record) return null;
  Auth.assume(session.email, session.role);
  if ((await Store.init()) !== 'firestore') return null;
  role = session.role;
  who = session.email;
  showTestMode();
  present();
  watch.saved();
  apply(copy);
  releaseHold = hold(PART_EDITS);
  booting(false);
  enter();
  renderAll();
  savedFor = { email: tidyEmail(session.email), role: session.role };
  return savedFor;
}

/** The role on the page, and the account in the header. Once per role. */
function present() {
  document.body.classList.toggle('role-floor', role === ROLE.FLOOR);
  document.body.classList.toggle('role-engineer', role === ROLE.ENGINEER);
  document.body.classList.toggle('role-manager', Auth.isManager);
  const whoami = $('whoami');
  whoami.textContent = Auth.mode === 'local' ? 'Local mode' : (who ?? '');
  $('storeMode').textContent = Store.mode !== 'firestore' ? 'Saved on this device only'
    : role === ROLE.FLOOR ? 'Read-only' : 'Saved for everyone';
  $('storeMode').style.color = Store.mode === 'firestore' ? '' : 'var(--red-bright)';
  if (presented) return;
  presented = true;
  wireSettings($('settingsBtn'), {
    onSignOut: async () => { await forgetDevice(); location.reload(); },
  });
}
let presented = false;

/** The tabs and everything under them, wired once whichever copy came first. */
let entered = false;
function enter() {
  if (entered) return;
  entered = true;
  wireHelp();
  wireTabs();
  wireSearch();
  wireMaterials();
  wireCorrect();
  wireFix();
  wireImport();
  $('partsTabs').hidden = false;
  const last = recallView();
  showTab(last);
  // Corrections and Import are held until the list is confirmed; see openWaitingTab.
  if (tab !== last) waitingTab = last;
}

/**
 * The list, its corrections and the materials manifest, as the server answers
 * them: `got` what it sent, `failed` the error for what it would not. Never throws.
 */
async function readAll() {
  const reads = { record: Store.loadParts(), overrides: Store.loadPartOverrides(), materials: Store.loadMaterials() };
  const got = {};
  const errors = {};
  for (const [what, answer] of Object.entries(reads)) {
    await answer.then((v) => { got[what] = v; }, (e) => { errors[what] = e; });
  }
  return { got, failed: errors };
}

/** Put a loaded list on the page's state, with its indexes. */
function apply(loaded) {
  record = loaded.record ?? null;
  overrides = loaded.overrides ?? {};
  materials = loaded.materials ?? null;
  parts = record?.partsJson ? JSON.parse(record.partsJson) : [];
  partsById = new Map(parts.map((p) => [p.id, p]));
  manifest = materials?.itemsJson ? JSON.parse(materials.itemsJson) : [];
  rebuildIndexes();
}

/**
 * What the device keeps: the list under its import time, its corrections and
 * the manifest. The import time is what says a fresh list is another one.
 */
const copyOf = ({ record: r, overrides: o, materials: m }) => ({
  importedAt: r?.importedAt ?? r?.exportDate ?? null,
  record: r ?? null,
  overrides: o ?? {},
  materials: m ?? null,
});

/** The same list, corrections and manifest: nothing to redraw. */
const sameCopy = (a, b) => a.importedAt === b.importedAt
  && (a.record?.partsJson ?? null) === (b.record?.partsJson ?? null)
  && JSON.stringify(a.overrides) === JSON.stringify(b.overrides)
  && (a.materials?.importedAt ?? null) === (b.materials?.importedAt ?? null)
  && (a.materials?.itemsJson ?? null) === (b.materials?.itemsJson ?? null);

/** Keep the list on the device once the server has confirmed it, and after each change the server has. */
let confirmed = false;
let copyTimer = null;
function saveCopy() {
  if (!confirmed || Store.mode !== 'firestore') return;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => deviceCache.set('parts',
    copyOf({ record, overrides: corrections.confirmed(overrides), materials })), 1000);
}

/** Both indexes come from the same list and corrections, so they move together. */
function rebuildIndexes() {
  index = buildIndex(parts, overrides);
  mindex = buildMaterialsIndex(parts, manifest, overrides);
  saveCopy();
}

function renderAll() {
  renderProvenance();
  $('partsEmpty').hidden = Boolean(parts.length) || role === ROLE.NONE;
  // A list loaded before type, unit and source were kept has none of them.
  // Only the importer can do anything about that, so the note is on their tab.
  $('partsReimport').hidden = !(parts.length && !parts.some((p) => META_FIELDS.some((f) => f in p)));
  renderPills();
  renderResults();
  renderMaterials();
  renderFix();
  if (!staged) renderPartsReview();
  if (!matStaged) renderMatReview();
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
const TABS = { search: 'ptSearch', materials: 'ptMaterials', fix: 'ptFix', import: 'ptImport' };

function wireTabs() {
  for (const [key, id] of Object.entries(TABS)) {
    $(`${id}Btn`).addEventListener('click', () => openTab(key));
  }
}

/** A tab that was pressed: shown, and remembered. */
function openTab(which) {
  waitingTab = null;
  showTab(which);
  rememberView();
}

// The tab this device was left on, while it is held; and whether anybody has
// started on the page since, who must not have it changed under them.
let waitingTab = null;
let touched = false;
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => { touched = true; }, { capture: true, once: true, passive: true });
}

function openWaitingTab() {
  if (waitingTab && !touched && !isHeld()) showTab(waitingTab);
  if (!isHeld()) waitingTab = null;
}

function showTab(which) {
  if (which === 'fix' && (!Auth.canEditParts || isHeld())) which = 'search';
  if (which === 'import' && (!Auth.canImportParts || isHeld())) which = 'search';
  tab = which;
  for (const [key, id] of Object.entries(TABS)) {
    $(id).hidden = key !== which;
    $(`pt${key[0].toUpperCase()}${key.slice(1)}Btn`).setAttribute('aria-current', key === which ? 'page' : 'false');
  }
  if (which === 'search') $('q').focus({ preventScroll: true });
  if (which === 'materials') $('mq').focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------
function renderProvenance() {
  const when = record?.exportDate ?? null;
  $('partsAsOf').textContent = when ? fmtDate(when) : '—';
  const stale = $('partsStale');
  const days = when ? ageInDays(when) : null;
  if (days !== null && days > STALE_DAYS) {
    stale.hidden = false;
    stale.textContent = `${days} days old — ask for a fresh export`;
  } else {
    stale.hidden = true;
  }
}

const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 10)
    : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
};

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------
/**
 * A search box: the results follow the typing. The Search key on a phone's
 * keyboard puts the keyboard away, which is otherwise over the results; at a
 * desk Enter leaves the box as it is, to be typed in again.
 */
function wireBox(box, draw) {
  let debounce = null;
  box.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(draw, 150);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    clearTimeout(debounce);
    draw();
    if (matchMedia('(pointer: coarse)').matches) box.blur();
  });
}

function wireSearch() {
  wireBox($('q'), renderResults);
  for (const b of document.querySelectorAll('.pills-bin [data-bin]')) {
    b.addEventListener('click', () => { filters.bin = b.dataset.bin; filtersMoved(); });
  }
  $('binFirst').addEventListener('click', () => { filters.binFirst = !filters.binFirst; filtersMoved(); });
  // Browsing in size order by description, the way a rack is walked. Code
  // order is the default because the code is what this list is a list of.
  $('byDesc').addEventListener('click', () => { filters.byDesc = !filters.byDesc; filtersMoved(); });
  $('resultsAll').addEventListener('click', () => {
    const had = document.activeElement === $('resultsAll');
    filters.family = null;
    filters.bin = 'all';
    filtersMoved();
    // It goes once pressed; the focus goes to what it pressed.
    if (had) $('familyPills').firstElementChild?.focus({ preventScroll: true });
  });
  fadeEnd($('familyPills'));
  fadeEnd(document.querySelector('.pills-bin'));
  wireList('search');
  // The whole list as the old drafting workbook. Not the filtered view: the
  // sheet is the thing people keep, and a filter is the thing of the moment.
  $('xlsxAll').addEventListener('click', () => {
    if (!parts.length) { toast('Nothing to download yet.'); return; }
    clearTrouble('xlsxAll');
    busy($('xlsxAll'), 'Building…', async () => {
      try {
        await downloadWorkbook(draftingSheets(parts, overrides, { exportDate: record?.exportDate }), workbookName());
        toast('Workbook downloaded — one tab per family, corrections applied.');
      } catch (e) {
        trouble('xlsxAll', failure('Workbook not built', e));
      }
    });
  });
}

/** A pill or an order was pressed: the strips show it, the list follows, the device remembers. */
function filtersMoved() {
  renderPills();
  renderResults();
  rememberView();
}

// ---- strips of pills --------------------------------------------------------

const strips = new WeakMap();    // strip -> what is in it, as drawn

/**
 * A strip of pills, switched in place. It is built again only when what is in
 * it has changed, and then stays where it was scrolled to: built on every tap,
 * a strip somebody had scrolled along jumped back to its start under them.
 *
 * @param {Array<{label, n, on: () => boolean, press: () => void}>} pills
 * @param {string} [of]  what the strip is of; another one starts from its beginning
 */
function pillStrip(host, pills, of = '') {
  const made = JSON.stringify([of, pills.map((p) => [p.label, p.n])]);
  const was = strips.get(host);
  if (was?.made !== made) {
    const at = was?.of === of ? host.scrollLeft : 0;
    host.replaceChildren(...pills.map((p) => {
      const b = el('button', 'pill', p.label);
      b.append(el('span', 'pill-n', String(p.n)));
      b.addEventListener('click', p.press);
      return b;
    }));
    host.scrollLeft = at;
    strips.set(host, { made, of });
  }
  pills.forEach((p, i) => pillOn(host.children[i], p.on()));
  endOf(host);
}

const pillOn = (b, on) => {
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
};

/** The fade the tab strip has, at the right of a strip with more to scroll to. */
const endOf = (strip) => strip.classList.toggle('has-more', strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1);

function fadeEnd(strip) {
  strip.addEventListener('scroll', () => endOf(strip), { passive: true });
  new ResizeObserver(() => endOf(strip)).observe(strip);
}

function renderPills() {
  const counts = familyCounts(index);
  // A family left on from before, and gone from the list since.
  if (filters.family && index.length && !counts[filters.family]) filters.family = null;
  const family = (f) => ({
    label: f ?? 'All', n: f ? counts[f] : index.length,
    on: () => filters.family === f,
    press: () => { filters.family = filters.family === f ? null : f; filtersMoved(); },
  });
  pillStrip($('familyPills'), [null, ...FAMILIES.filter((f) => counts[f])].map(family));
  for (const b of document.querySelectorAll('.pills-bin [data-bin]')) pillOn(b, b.dataset.bin === filters.bin);
}

/**
 * The two orders are for browsing: a search is ranked by how well it matches,
 * so while there is one they are off and say so, and come back as they were.
 */
function renderOrders(searching) {
  for (const [id, on] of [['binFirst', filters.binFirst], ['byDesc', filters.byDesc]]) {
    $(id).disabled = searching;
    pillOn($(id), on && !searching);
  }
}

/**
 * What a search found, in words, and the way to the rest of it: a search that
 * comes to nothing under a pill, with answers elsewhere, says how many, and
 * one press takes the pill off.
 *
 * @param {HTMLElement} meta   the line
 * @param {HTMLElement} all    its button
 * @param {{total: number, relaxed: boolean}} found
 * @param {number} shown       how many are left under the pills
 * @param {string} where       what the pills narrow it to: `in SDC with a bin`
 */
function searchWords(meta, all, { total, relaxed }, shown, where) {
  const elsewhere = total && !shown && where ? total : 0;
  // `relaxed`: no part had a token for every term - two fifties asked for
  // and only one found, say - so these are near misses, and it says so.
  meta.textContent = !total ? 'Nothing matches — try fewer words, or just the size.'
    : elsewhere ? `None ${where}, ${relaxed ? `the ${total} nearest` : total} elsewhere`
      : relaxed ? `Nothing has all of that. The ${shown} nearest:`
        : count(shown, 'match', 'matches');
  all.textContent = relaxed ? `Show the ${total} nearest` : `Show ${count(total, 'match', 'matches')}`;
  all.hidden = !elsewhere;
}

function renderResults() {
  const meta = $('resultsMeta');
  const q = clean($('q').value);
  renderOrders(Boolean(q));
  $('resultsAll').hidden = true;
  if (!parts.length) { meta.textContent = ''; $('resultsHead').hidden = true; showList('search', []); return; }

  const bin = { with: 'with a bin', without: 'without a bin' }[filters.bin];
  let entries;
  if (q) {
    const found = search(index, q, { limit: Infinity });
    entries = found.hits.map((h) => h.entry);
    if (filters.family) entries = entries.filter((e) => e.family === filters.family);
    if (filters.bin === 'with') entries = entries.filter((e) => hasBin(e.eff.bin));
    if (filters.bin === 'without') entries = entries.filter((e) => !hasBin(e.eff.bin));
    searchWords(meta, $('resultsAll'), found, entries.length,
      [filters.family ? `in ${filters.family}` : '', bin].filter(Boolean).join(' '));
  } else {
    entries = browse(index, filters);
    meta.textContent = [`${count(entries.length, 'part')}${filters.family ? ` in ${filters.family}` : ''}`, bin]
      .filter(Boolean).join(' · ');
  }

  // The code column fits the longest code in the list: a phone-width column
  // ran twenty-character model codes into their descriptions, and a column
  // wide enough for those wasted the row for the six-character majority.
  // Monospace at 14px is under 8.6px a character in every font the page can
  // land on; the stylesheet clips with an ellipsis if one is wider.
  const longest = entries.reduce((n, e) => Math.max(n, e.part.id.length), 7);
  $('ptSearch').style.setProperty('--code-w', `${Math.round(longest * 8.6 + 6)}px`);
  $('resultsHead').hidden = !entries.length;
  showList('search', entries);
}

// ---- the list, in chunks ----------------------------------------------------
//
// The whole list is on offer — scrolling all of it was one of the things the
// spreadsheet was good for — but two thousand cards built in one go is a
// second of nothing on a phone. So the first chunk is built at once and the
// rest as the end of the list comes into view, well before it is reached.
const CHUNK = 200;
// Two lists, one per tab, each with its own host and its own place in its
// entries. They are never on screen together, but a correction made on one
// must reach the other, so both are kept rather than rebuilt on arrival.
const LISTS = {
  search: { host: 'results', index: () => index },
  materials: { host: 'mresults', index: () => mindex },
};
const listings = {
  search: { entries: [], shown: 0 },
  materials: { entries: [], shown: 0 },
};
const moreObserver = new IntersectionObserver((hits) => {
  for (const h of hits) if (h.isIntersecting) appendChunk(h.target.dataset.list);
}, { rootMargin: '800px 0px' });
// Belt and braces: a scroll that brings the end within reach builds the next
// chunk too, for a webview whose observer is late or missing.
window.addEventListener('scroll', () => {
  for (const key of Object.keys(LISTS)) {
    const s = $(`moreSentinel-${key}`);
    if (s && s.getBoundingClientRect().top < innerHeight + 800) appendChunk(key);
  }
}, { passive: true });

function appendChunk(key) {
  const listing = listings[key];
  const host = $(LISTS[key].host);
  const old = $(`moreSentinel-${key}`);
  const hadFocus = Boolean(old) && document.activeElement === old;
  if (old) { moreObserver.unobserve(old); old.remove(); }
  const next = listing.entries.slice(listing.shown, listing.shown + CHUNK);
  const cards = next.map((e) => partCard(e, key));
  listing.shown += next.length;
  host.append(...cards);
  const left = listing.entries.length - listing.shown;
  if (left > 0) {
    const s = el('button', 'more-sentinel', `${left} more \u2014 keep scrolling`);
    s.id = `moreSentinel-${key}`;
    s.dataset.list = key;
    s.addEventListener('click', () => appendChunk(key));   // a browser with no observer still gets there
    host.append(s);
    moreObserver.observe(s);
  }
  // Reached with the keyboard: on to the first of the cards it made way for.
  if (hadFocus) cards[0]?.querySelector('.part-head').focus({ preventScroll: true });
}

/** Start a list over with these entries. */
function showList(key, entries) {
  $(LISTS[key].host).textContent = '';
  listings[key] = { entries, shown: 0 };
  appendChunk(key);
}

/** The card on screen for a code in a list, if it is on screen. */
const cardEl = (key, id) => $(LISTS[key].host).querySelector(`.part[data-id="${CSS.escape(id)}"]`);

/** Redraw one card in place, from the entry its list holds for it; what had the focus in it keeps it. */
function redrawCard(key, id) {
  const card = cardEl(key, id);
  const entry = listings[key].entries.find((e) => e.part.id === id);
  if (card && entry) keepFocus(() => card.replaceWith(partCard(entry, key)));
}

/**
 * After a correction the indexes have been rebuilt, so the lists' entries are
 * stale. Swap every entry for its new self - order, scroll position and the
 * chunks on screen all stay - and redraw the cards that actually changed, on
 * both lists.
 */
function refreshEntries(changedIds) {
  for (const key of Object.keys(LISTS)) {
    const byId = new Map(LISTS[key].index().map((e) => [e.part.id, e]));
    listings[key].entries = listings[key].entries.map((e) => byId.get(e.part.id) ?? e);
    for (const id of changedIds) redrawCard(key, id);
  }
}

/**
 * Tap a card to open it, or press Enter or Space on it; controls inside are
 * their own thing. Only that card is redrawn: the list may be two thousand
 * rows deep, and rebuilding it would drop the scroll position and every chunk
 * loaded so far.
 */
function wireList(key) {
  const host = $(LISTS[key].host);
  host.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input')) return;
    // A drag that ends with text highlighted is a highlight, not a tap. The
    // card stays as it is - redrawing it would throw the selection away -
    // and the text can be copied. A plain click collapses any selection
    // before this runs, so it still opens the card.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const card = e.target.closest('.part');
    if (card) toggleCard(key, card);
  });
  host.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.classList.contains('part-head')) return;
    e.preventDefault();
    toggleCard(key, e.target.closest('.part'));
  });
}

function toggleCard(key, card) {
  const id = card.dataset.id;
  if (open.has(id)) {
    open.delete(id);
    redrawCard(key, id);
    return;
  }
  // One open at a time: opening a card closes whichever was open, so the
  // list does not fill with cards that each need closing by hand. When the
  // one closing sits above, the page shrinks by its body and the tapped
  // card would jump up the screen - scroll by the same amount so it stays
  // under the finger.
  const tappedTop = card.getBoundingClientRect().top;
  let shift = 0;
  for (const other of [...open]) {
    open.delete(other);
    const was = cardEl(key, other);
    if (!was) continue;
    const before = was.getBoundingClientRect();
    redrawCard(key, other);
    if (before.top < tappedTop) shift += before.height - (cardEl(key, other)?.getBoundingClientRect().height ?? 0);
  }
  open.add(id);
  redrawCard(key, id);
  if (shift) window.scrollBy(0, -shift);
}

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------
function wireMaterials() {
  wireList('materials');
  wireBox($('mq'), renderMaterials);
  $('mResultsAll').addEventListener('click', () => {
    const had = document.activeElement === $('mResultsAll');
    mfilters.category = null;
    mfilters.subcategory = null;
    materialsMoved();
    if (had) $('matPills').firstElementChild?.focus({ preventScroll: true });
  });
  fadeEnd($('matPills'));
  fadeEnd($('subPills'));
  wireDrop($('matDropZone'), $('matFile'), stageMaterials);
  renderMatReview();
}

/** A material or a form was pressed: the list follows, and the device remembers. */
function materialsMoved() {
  renderMaterials();
  rememberView();
}

/**
 * A drop zone: a file dropped on it, or one picked by pressing it, with a
 * finger or from the keyboard. The picker is emptied each time, so the same
 * file can be picked again after a discard.
 */
function wireDrop(zone, input, take) {
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.target !== zone || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    input.click();
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('dragover');
    const f = e.dataTransfer?.files?.[0];
    // Held while the list is the saved copy, as the file picker is.
    if (f && !isHeld()) take(f);
  });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) take(f);
  });
}

/** The material pills, then the form pills for the chosen material. */
function renderMaterialPills() {
  const groups = materialGroups(mindex);
  let g = groups.find((x) => x.category === mfilters.category);
  // One left on from before, and gone from the sheet since.
  if (!g) mfilters.category = null;
  if (!g?.subs.some((s) => s.subcategory === mfilters.subcategory)) mfilters.subcategory = null;
  pillStrip($('matPills'), [{ category: null, count: mindex.length }, ...groups].map(({ category, count: n }) => ({
    label: category ?? 'All', n,
    on: () => mfilters.category === category,
    press: () => {
      mfilters.category = mfilters.category === category ? null : category;
      mfilters.subcategory = null;
      materialsMoved();
    },
  })));
  $('subPills').hidden = !g;
  if (!g) return;
  pillStrip($('subPills'), [{ subcategory: null, count: g.count }, ...g.subs].map(({ subcategory, count: n }) => ({
    label: subcategory ?? 'All forms', n,
    on: () => mfilters.subcategory === subcategory,
    press: () => {
      mfilters.subcategory = mfilters.subcategory === subcategory ? null : subcategory;
      materialsMoved();
    },
  })), g.category);
}

function renderMaterials() {
  const meta = $('mResultsMeta');
  const bad = failed.materials && loadFault(materials ? 'Latest materials sheet not loaded' : 'Materials sheet not loaded', failed.materials);
  $('matFault').replaceChildren(...(bad || []));
  $('matFault').hidden = !bad;
  $('matEmpty').hidden = Boolean(mindex.length) || role === ROLE.NONE || Boolean(bad);
  $('matAsOf').textContent = materials?.importedAt ? `sheet loaded ${fmtDate(materials.importedAt)}` : '';
  $('mResultsAll').hidden = true;
  if (!mindex.length) {
    meta.textContent = '';
    $('mResultsHead').hidden = true;
    $('matPills').replaceChildren();
    strips.delete($('matPills'));
    $('subPills').hidden = true;
    showList('materials', []);
    return;
  }
  renderMaterialPills();

  const q = clean($('mq').value);
  let entries;
  if (q) {
    const found = search(mindex, q, { limit: Infinity });
    entries = found.hits.map((h) => h.entry);
    if (mfilters.category) entries = entries.filter((e) => e.material.category === mfilters.category);
    if (mfilters.subcategory) entries = entries.filter((e) => e.material.subcategory === mfilters.subcategory);
    searchWords(meta, $('mResultsAll'), found, entries.length, mfilters.category
      ? `in ${mfilters.category}${mfilters.subcategory ? ` \u203a ${mfilters.subcategory}` : ''}` : '');
  } else {
    entries = browseMaterials(mindex, mfilters);
    meta.textContent = count(entries.length, 'material')
      + `${mfilters.category ? ` in ${mfilters.category}` : ''}${mfilters.subcategory ? ` \u203a ${mfilters.subcategory}` : ''}`;
  }
  const longest = entries.reduce((n, e) => Math.max(n, e.part.id.length), 7);
  $('ptMaterials').style.setProperty('--code-w', `${Math.round(longest * 8.6 + 6)}px`);
  $('mResultsHead').hidden = !entries.length;
  showList('materials', entries);
}

let matStaged = null;     // { file, items, index, warnings, lede, trouble } - read, not loaded
// Drawn by import-review.js, like the Stock Items review above it.
const matReview = createReview(() => renderMatReview());

/**
 * Under the materials drop zone: the sheet being reviewed, or the one loaded
 * now. The drop zone hides while a sheet is under review, and while the one
 * loaded now has not been read: nothing could be said of what it replaces.
 */
function renderMatReview() {
  const host = $('matReview');
  host.textContent = '';
  $('matDropZone').hidden = Boolean(matStaged || failed.materials);
  if (!matStaged) {
    host.hidden = !materials && !failed.materials;
    if (failed.materials) {
      const line = el('div', 'fault');
      line.append(...loadFault(materials ? 'Latest materials sheet not loaded' : 'Materials sheet not loaded', failed.materials));
      host.append(line);
    } else if (materials) {
      host.append(el('div', 'import-current',
        `Currently loaded: ${materials.sourceLabel ?? 'a sheet'} \u2014 ${count(materials.count ?? manifest.length, 'material')}, `
        + `loaded ${fmtDate(materials.importedAt)}. Drop a new sheet above to replace it.`));
    }
    return;
  }
  host.hidden = false;
  host.append(matReview.render(materialsReview({
    ...matStaged,
    prev: manifest,
    descOf: (code) => partsById.get(code)?.desc ?? '',
    apply: loadMaterials,
    cancel: () => { matStaged = null; renderMatReview(); discarded(); },
  })));
  if (matStaged.trouble) host.append(faultWords(matStaged.trouble));
}

/** Read a materials sheet and show what loading it would mean. */
async function stageMaterials(file) {
  matStaged = null;
  const host = $('matReview');
  host.hidden = false;
  host.textContent = '';
  host.append(reviewLine('lede', `Reading ${file.name}\u2026`));
  let text;
  try {
    text = await file.text();
  } catch (e) {
    console.warn('[materials]', e.message);
    host.replaceChildren(faultWords(`${file.name} not read: it could not be opened. The materials sheet (.csv) is expected.`));
    return;
  }
  const { items, errors, warnings, skipped } = parseMaterialsCsv(text);
  if (errors.length) {
    host.textContent = '';
    host.append(matReview.render({
      title: 'Review the materials sheet',
      notes: errors.map((m) => ({ cls: 'flag flag-bad import-err', text: m })),
      clean: 'This file was not loaded.',
    }));
    return;
  }
  const index = buildMaterialsIndex(parts, items, overrides);
  const groups = materialGroups(index);
  const lede = `${file.name} \u2014 ${count(items.length, 'material')} in ${count(groups.length, 'category', 'categories')}`
    + `${skipped ? `, ${count(skipped, 'row')} skipped (no code, or retired)` : ''}. `
    + `${manifest.length ? `Replaces the ${manifest.length} loaded now.` : 'First load.'} Nothing changes until you load it.`;
  matStaged = { file, items, index, warnings, lede };
  renderMatReview();
}

/** Load the sheet under review. Its button is busy meanwhile, and nothing else there can be pressed. */
async function loadMaterials() {
  const s = matStaged;
  if (!s || s.working) return;
  const rec = {
    importedAt: new Date().toISOString(), importedBy: who, sourceLabel: s.file.name, count: s.items.length,
    itemsJson: JSON.stringify(s.items),
  };
  s.working = true;
  if (s.trouble) unsay(s.trouble);
  s.trouble = null;
  $('matReview').inert = true;
  try {
    await Store.saveMaterials(rec);
  } catch (e) {
    s.trouble = failure('Materials sheet not saved', e);
  }
  s.working = false;
  $('matReview').inert = false;
  if (s.trouble) {
    renderMatReview();
    toastFailed(s.trouble);
    return;
  }
  matStaged = null;
  // What was saved is what is drawn: no second read to wait for.
  apply({ record, overrides, materials: rec });
  renderAll();
  toast(`${count(s.items.length, 'material')} loaded.`);
}

function partCard(e, key) {
  const p = e.part;
  const eff = e.eff;
  const isOpen = open.has(p.id);
  const card = el('div', `part${hasBin(eff.bin) ? '' : ' no-bin'}${isOpen ? ' is-open' : ''}`);
  card.dataset.id = p.id;
  // A control in here, remembered through the card being drawn again.
  const place = (what) => `part:${key}:${p.id}:${what}`;

  const head = el('div', 'part-head');
  head.setAttribute('role', 'button');
  head.setAttribute('aria-expanded', String(isOpen));
  head.tabIndex = 0;
  head.dataset.focus = place('head');
  head.append(el('span', 'part-code', p.id));
  const d = el('span', 'part-desc', eff.desc || '(no description)');
  if (eff.descOv) d.append(badge(eff.descOv));
  head.append(d);
  // Type, source, unit: columns of their own on a desktop; on a phone the
  // stylesheet hides these and shows the one-line version in the open card.
  // A material shows its kind instead: material, form, quantity type.
  const cols = e.material
    ? [e.material.category, e.material.subcategory, e.material.qtyType]
    : ['type', 'source', 'unit'].map((f) => p[f] ?? '');
  for (const v of cols) {
    const m = el('span', 'part-meta', v ?? '');
    m.title = v ?? '';
    head.append(m);
  }
  const binWrap = el('span', 'part-bin');
  binWrap.append(el('span', `bin-chip${hasBin(eff.bin) ? '' : ' none'}`, hasBin(eff.bin) ? eff.bin : 'No bin set'));
  if (eff.binOv) binWrap.append(badge(eff.binOv));
  head.append(binWrap);
  card.append(head);

  if (isOpen) {
    const body = el('div', 'part-body');
    const ml = [e.material ? `${e.material.category} \u203a ${e.material.subcategory}${e.material.qtyType ? ` \u00b7 ${e.material.qtyType}` : ''}` : '', metaLine(p)]
      .filter(Boolean).join('   ');
    if (ml) body.append(el('div', 'part-meta-line', ml));
    if (e.missing) {
      body.append(el('div', 'part-missing',
        'Not in the part list: the materials sheet has this code, the last Stock Items export does not. '
        + 'The description is the sheet\'s.'));
    }
    const acts = el('div', 'part-acts');
    // Code and description on one line, the way it is written into an email
    // or a drawing note. The description is the one on screen — corrected,
    // if it has been.
    const copy = el('button', 'mini', 'Copy as one line');
    copy.dataset.focus = place('copy');
    copy.addEventListener('click', async () => {
      const line = eff.desc ? `${p.id} - ${eff.desc}` : p.id;
      try {
        await navigator.clipboard.writeText(line);
        flash(copy, 'Copy as one line', '\u2713 Copied', 'ok');
        toast(`Copied: ${line}`);
      } catch {
        copyFailed(copy, 'Copy as one line');
      }
    });
    acts.append(copy);
    // The same two apart, for a sheet: the description first and the code
    // after it, so the code is what pastes and the description is the entry
    // before it in the clipboard history. Windows is where that history is
    // (Win+V), and a browser elsewhere may refuse a second write so long
    // after the click, so the button is only there.
    if (HAS_CLIPBOARD_HISTORY) {
      const sheet = el('button', 'mini', 'Copy for sheet');
      sheet.dataset.focus = place('sheet');
      sheet.addEventListener('click', async () => {
        // Not pressed twice while the first is between its two writes.
        sheet.disabled = true;
        try {
          await copyApart(navigator.clipboard, p.id, eff.desc);
          flash(sheet, 'Copy for sheet', '✓ Copied', 'ok');
          toast(clean(eff.desc) ? `Copied: ${p.id}, then ${eff.desc}` : `Copied: ${p.id}`);
        } catch {
          copyFailed(sheet, 'Copy for sheet');
        }
      });
      acts.append(sheet);
    }
    // The code and description as one name for saving a file under:
    // AB0001-HatchHinge316SS. One write, so on every system.
    const named = el('button', 'mini', 'Copy as file name');
    named.dataset.focus = place('named');
    named.addEventListener('click', async () => {
      const name = partFileName(p.id, eff.desc);
      try {
        await navigator.clipboard.writeText(name);
        flash(named, 'Copy as file name', '\u2713 Copied', 'ok');
        toast(`Copied: ${name}`);
      } catch {
        copyFailed(named, 'Copy as file name');
      }
    });
    acts.append(named);
    if (Auth.canEditParts) {
      const cd = el('button', 'mini corrects', 'Correct description');
      cd.dataset.focus = place('desc');
      cd.addEventListener('click', () => openCorrect(p, 'desc'));
      const cb = el('button', 'mini corrects', 'Correct bin');
      cb.dataset.focus = place('bin');
      cb.addEventListener('click', () => openCorrect(p, 'bin'));
      acts.append(cd, cb);
    }
    body.append(acts);

    for (const [ov, label] of [[eff.descOv, 'Description'], [eff.binOv, 'Bin']]) {
      if (!ov) continue;
      const note = el('div', 'part-note');
      note.append(el('b', null, `${label} corrected here. `));
      note.append(document.createTextNode(`ERP currently says "${ov.observed ?? (ov.baseline || '—')}". `));
      note.append(el('span', 'dim', `${ov.reason} — ${who === ov.createdBy ? 'you' : (ov.createdBy ?? 'someone')}, ${fmtDate(ov.createdAt)}`
        + `${ov.importsPending ? ` · unfixed through ${count(ov.importsPending, 'export')}` : ''}`
        + `${ov.status === 'review' ? ' · awaiting a decision' : ''}`));
      if (Auth.canEditParts) {
        const rm = armed('Remove correction', 'Confirm removal', () => withdraw(p.id, ov.field));
        rm.classList.add('corrects');
        rm.dataset.focus = place(`remove:${ov.field}`);
        note.append(rm);
      }
      body.append(note);
    }
    card.append(body);
  }
  // Open or shut: a correction that did not save is said where it was made.
  for (const field of OVERRIDE_FIELDS) {
    const line = correctionFault(p.id, field);
    if (line) card.append(line);
  }
  return card;
}

function badge(ov) {
  return el('span', `part-badge${ov.status === 'review' ? ' review' : ''}`,
    ov.status === 'review' ? STATUS_NAME.review : 'Corrected · ERP pending');
}

// ---------------------------------------------------------------------------
// corrections, drawn first and written behind
//
// The page changes from the record just built and the write follows it
// (write-behind.js). One that is refused is put back, and says so on the card
// and on the Corrections row, with a Retry, until it is dealt with.
// ---------------------------------------------------------------------------
let tellLink = null;             // boot.js's connection line, once start-up is over

const corrections = writeBehind({
  get: (key) => overrides[key],
  draw: (key, o) => {
    const { partId } = o ?? overrides[key];
    if (o) overrides[key] = o; else delete overrides[key];
    reindex(partId);
    drawCorrection(partId);
  },
  write: (key, o) => Store.setPartOverride(key, o),
  moved: () => {
    const { n } = corrections.waiting();
    tellLink?.({ lost: n > 0, unsent: n > 0, stopped: false });
    saveCopy();
  },
});

// A correction the server does not have yet, because there is no connection,
// would go with the page: the browser asks.
window.addEventListener('beforeunload', (e) => {
  const { n, since } = corrections.waiting();
  if (n && (navigator.onLine === false || Date.now() - since > LOST_FOR)) e.preventDefault();
});

/** One part's entries in both lists, made again; the rest are as they were. */
function reindex(id) {
  const part = partsById.get(id);
  if (part) {
    const [entry] = buildIndex([part], overrides);
    index = index.map((e) => (e.part.id === id ? entry : e));
  }
  const m = manifest.find((x) => x.code === id);
  if (m) {
    const [entry] = buildMaterialsIndex(part ? [part] : [], [m], overrides);
    mindex = mindex.map((e) => (e.part.id === id ? entry : e));
  }
}

/** Every place a part's corrections show. */
function drawCorrection(partId) {
  refreshEntries([partId]);
  keepFocus(renderFix);
  // What the export under review does to it is told again.
  if (staged && !staged.working) keepFocus(renderPartsReview);
}

const faultKey = (key) => `part:${key}`;
const unsaved = new Map();       // key -> the record that did not save, for a row when it has none

/** The line that says a correction did not save, for a card or a row; null when there is none. */
function correctionFault(partId, field) {
  const key = overrideKey(partId, field);
  return faultLine(faultKey(key), () => { unsaved.delete(key); drawCorrection(partId); });
}

/**
 * Save a correction: on the page at once, to the server behind it.
 * @param {string} what  what a failure did not do: 'Correction not saved'
 * @param {string} said  in passing, once the server has it
 */
async function putCorrection(key, o, what, said) {
  clearFault(faultKey(key));
  unsaved.delete(key);
  try {
    if (await corrections.put(key, o)) toast(said);
  } catch (e) {
    const words = failure(what, e);
    const passing = `${o.partId} \u2013 ${words}`;
    setFault(faultKey(key), words, () => { unsay(passing); putCorrection(key, o, what, said); });
    unsaved.set(key, o);
    drawCorrection(o.partId);
    toastFailed(passing);
  }
}

// ---------------------------------------------------------------------------
// correct
// ---------------------------------------------------------------------------
// { part, field, from, value, reasonFrom, reasonTyped, leaving }: the part, the
// field shown, and by field what "Should be" and the reason began as, and what
// "Should be" holds now.
let correcting = null;

function wireCorrect() {
  $('coDesc').addEventListener('click', () => setCorrectField('desc'));
  $('coBin').addEventListener('click', () => setCorrectField('bin'));
  $('coCancel').addEventListener('click', closeCorrect);
  $('coSave').addEventListener('click', saveCorrect);
  // Pressed AND released on the backdrop - see dialog.js. Highlighting the
  // text in a field and letting go outside the box used to close this. Escape
  // comes the same way.
  closeOnBackdrop($('correctOverlay'), leaveCorrect);
  $('coReason').addEventListener('input', () => { if (correcting) correcting.reasonTyped = true; });
  $('coValue').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCorrect(); });
  $('coReason').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCorrect(); });
}

/** The correction a part's field has now, if it is live. */
function liveCorrection(partId, field) {
  const o = overrides[overrideKey(partId, field)];
  return isActive(o) ? o : null;
}

function openCorrect(part, field) {
  const live = Object.fromEntries(OVERRIDE_FIELDS.map((f) => [f, liveCorrection(part.id, f)]));
  const each = (fn) => Object.fromEntries(OVERRIDE_FIELDS.map((f) => [f, fn(f)]));
  const from = each((f) => live[f]?.value ?? part[f] ?? '');
  correcting = { part, field: null, from, value: { ...from }, reasonFrom: each((f) => live[f]?.reason ?? ''), reasonTyped: false };
  $('coTitle').textContent = `Correct ${part.id}`;
  $('coLede').textContent = 'The app shows your value from now on. The ERP is not changed — this goes on the list for the person who can.';
  $('coErr').textContent = '';
  setCorrectField(field);
  $('correctOverlay').classList.add('show');
  setTimeout(readyToEdit, 30);
}

/** The value there now, selected: typed over, or edited from where it is clicked. */
function readyToEdit() {
  $('coValue').focus();
  $('coValue').select();
}

function setCorrectField(field) {
  const c = correcting;
  if (!c) return;
  // What was typed stays typed: the value under its own field, the reason under either.
  if (c.field) c.value[c.field] = $('coValue').value;
  c.field = field;
  for (const b of [$('coDesc'), $('coBin')]) {
    const on = b.dataset.field === field;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const cur = c.part[field] || '';
  $('coCurrent').textContent = field === 'bin' && !hasBin(cur) ? `${cur || '(blank)'} — not a bin location` : (cur || '(blank)');
  $('coValue').value = c.value[field];
  if (!c.reasonTyped) $('coReason').value = c.reasonFrom[field];
  accept($('coValue'));
  accept($('coReason'));
  // A correction that exists can be taken back from here as well. Built
  // fresh each time so a half-pressed "Confirm removal" never carries over.
  const slot = $('coRemoveSlot');
  slot.textContent = '';
  if (liveCorrection(c.part.id, field)) {
    slot.append(armed('Remove correction', 'Confirm removal', () => {
      closeCorrect();
      withdraw(c.part.id, field);
    }));
  }
  if ($('correctOverlay').classList.contains('show')) readyToEdit();
}

/**
 * A button that asks once. The first press turns it into the second, named; a
 * second press within a few seconds is the answer. No native dialog, and a
 * slip of the thumb costs nothing.
 */
function armed(label, sure, fn) {
  const b = el('button', 'mini', label);
  let timer = null;
  const disarm = () => {
    clearTimeout(timer);
    timer = null;
    b.textContent = label;
    b.classList.remove('bad');
    b.style.minWidth = '';
  };
  b.addEventListener('click', () => {
    if (timer) { disarm(); fn(); return; }
    // The width stays, so nothing beside it moves under the second press.
    b.style.minWidth = `${Math.ceil(b.getBoundingClientRect().width)}px`;
    b.textContent = sure;
    b.classList.add('bad');
    timer = setTimeout(disarm, 3500);
  });
  return b;
}

/**
 * Take a correction back: the part shows what the ERP says again and the
 * correction leaves the list. Kept as history, marked withdrawn - it was not
 * fixed in the ERP and the record should not say it was.
 */
function withdraw(partId, field) {
  const o = liveCorrection(partId, field);
  if (!o) return;
  putCorrection(overrideKey(partId, field), withdrawOverride(o, { by: who }),
    'Correction not removed', `${partId}: correction removed. It shows what the ERP says again.`);
}

/** Has anything been typed here that closing would lose? */
function correctTyped() {
  const c = correcting;
  if (!c) return false;
  c.value[c.field] = $('coValue').value;
  return OVERRIDE_FIELDS.some((f) => c.value[f] !== c.from[f])
    || (c.reasonTyped && $('coReason').value !== c.reasonFrom[c.field]);
}

/** Escape, or a click outside: closed, unless that would lose what has been typed. */
async function leaveCorrect() {
  const c = correcting;
  if (!c || c.leaving) return;
  if (correctTyped()) {
    c.leaving = true;
    const discard = await choose({ title: 'Unsaved correction', yes: 'Discard correction', no: 'Keep editing', danger: true });
    c.leaving = false;
    if (!discard || correcting !== c) return;
  }
  closeCorrect();
}

function closeCorrect() {
  $('correctOverlay').classList.remove('show');
  correcting = null;
}

function saveCorrect() {
  const c = correcting;
  if (!c) return;
  const { part, field } = c;
  const existing = liveCorrection(part.id, field);
  $('coErr').textContent = '';
  accept($('coValue'));
  accept($('coReason'));
  let o;
  try {
    o = createOverride({
      partId: part.id, field, value: $('coValue').value, reason: $('coReason').value, by: who, part, existing,
    });
  } catch (e) {
    const box = { value: $('coValue'), reason: $('coReason') }[e.on];
    if (box) refuse(box, e.words); else $('coErr').textContent = e.words ?? failure('Correction not saved', e);
    return;
  }
  // Re-correcting keeps the original creation and count; only the answer moves.
  const data = existing
    ? { ...existing, value: o.value, reason: o.reason, baseline: o.baseline, status: 'pending',
        reviewReason: null, observed: null, updatedAt: o.updatedAt }
    : o;
  // What was typed under the other field has not been saved, so it stays up.
  const other = OVERRIDE_FIELDS.find((f) => f !== field);
  if (c.value[other] !== c.from[other]) {
    c.value[field] = $('coValue').value;
    c.from[field] = c.value[field];
    setCorrectField(other);
  } else closeCorrect();
  putCorrection(overrideKey(part.id, field), data,
    'Correction not saved', `${part.id} corrected here. It is on the list for the ERP.`);
}

// ---------------------------------------------------------------------------
// corrections tab: the review queue and the fix list
// ---------------------------------------------------------------------------
function wireFix() {
  $('copyFix').addEventListener('click', async () => {
    const list = fixList(overrides, partsById);
    const text = list.map((o) => `${o.partId}  ${FIELD_NAME[o.field]}\n`
      + `  ERP says:  ${o.current ?? o.baseline}\n  Should be: ${o.value}\n  Why: ${o.reason}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      flash($('copyFix'), 'Copy list', '\u2713 Copied', 'ok');
      toast(`${count(list.length, 'correction')} copied.`);
    } catch {
      copyFailed($('copyFix'), 'Copy list');
    }
  });
  $('csvFix').addEventListener('click', () => {
    const list = fixList(overrides, partsById);
    const blob = new Blob([fixListCsv(list)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `part-corrections-${localDate()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('loadFix').addEventListener('click', () => $('fixFile').click());
  $('fixFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) reviewFixFile(f);
  });
}

/** A button that copies one thing from a row: it says so on itself, or why it could not. */
function copyMini(label, text, place, said = text) {
  const b = el('button', 'mini', label);
  b.dataset.focus = place;
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      flash(b, label, '\u2713 Copied', 'ok');
      toast(`Copied: ${said}`);
    } catch {
      copyFailed(b, label);
    }
  });
  return b;
}

/** The description a part shows, for the code that names it on a row. */
const descOf = (partId) => {
  const part = partsById.get(partId);
  return part ? effective(part, overrides).desc : '';
};

/** Who made a correction and when; and, in words, how many exports it has been through since. */
const madeBy = (o) => `${o.createdBy && o.createdBy === who ? 'you' : whoShort(o.createdBy ?? (who ? null : 'you'))}, ${fmtDate(o.createdAt)}`;
const survived = (o) => (o.importsPending ? `Still unfixed after ${count(o.importsPending, 'export')}` : '');

function renderFix() {
  if (!Auth.canEditParts) return;
  const list = fixList(overrides, partsById);
  const review = list.filter((o) => o.status === 'review');
  const pending = list.filter((o) => o.status === 'pending');
  $('ptFixBtn').textContent = list.length ? `Corrections (${list.length})` : 'Corrections';

  // --- review queue ---
  const rq = $('reviewQueue');
  rq.textContent = '';
  if (review.length) {
    rq.append(el('h3', null, `Corrections awaiting a decision (${review.length})`));
    rq.append(el('div', 'flag-note',
      'The ERP moved, but not to the corrected value — or the part is gone from the export.'));
    for (const o of review) {
      const key = overrideKey(o.partId, o.field);
      const row = el('div', 'fix-row review');
      const head = el('div', 'fix-key');
      head.append(el('span', null, `${o.partId} · ${FIELD_NAME[o.field]}`), copyMini('Copy code', o.partId, `fix:${key}:code`));
      row.append(head);
      const desc = descOf(o.partId);
      if (desc) row.append(el('div', 'fix-desc dim', desc));
      const gone = o.reviewReason === 'missing_from_export';
      const why = gone
        ? 'This code is no longer in the export.'
        : `ERP now says "${o.observed ?? o.current ?? '—'}" — neither the old value nor your correction.`;
      row.append(el('div', 'fix-why', why));
      const vals = el('div', 'fix-vals');
      vals.append(el('span', null, `Correction: "${o.value}"  ·  was: "${o.baseline}"`), copyMini('Copy value', o.value, `fix:${key}:value`));
      row.append(vals);
      row.append(el('div', 'fix-reason dim', [o.reason, madeBy(o), survived(o)].filter(Boolean).join(' — ')));
      const acts = el('div', 'fix-acts');
      const keep = el('button', 'mini', 'Keep correction');
      keep.dataset.focus = `fix:${key}:keep`;
      keep.addEventListener('click', () => decide(o, 'keep'));
      const take = el('button', 'mini', 'Accept ERP');
      take.dataset.focus = `fix:${key}:accept`;
      take.addEventListener('click', () => decide(o, 'accept'));
      const edit = el('button', 'mini', 'Edit');
      edit.dataset.focus = `fix:${key}:edit`;
      edit.addEventListener('click', () => openCorrect(partsById.get(o.partId), o.field));
      // Nothing to keep against, or to edit: the choices are drop it, or leave it here.
      keep.disabled = gone;
      edit.disabled = gone;
      acts.append(keep, take, edit);
      row.append(acts);
      const fault = correctionFault(o.partId, o.field);
      if (fault) row.append(fault);
      rq.append(row);
    }
  }

  // --- the fix list ---
  const fl = $('fixList');
  fl.textContent = '';
  fl.append(el('h3', null, pending.length ? `Corrections for the ERP (${pending.length})` : 'Nothing waiting on the ERP'));
  // Not saved, and so on no list of its own: said here, where it would be.
  const shown = new Set(list.map((o) => overrideKey(o.partId, o.field)));
  const lost = [...unsaved].filter(([key]) => !shown.has(key) && faultOf(faultKey(key)));
  if (!pending.length && !review.length && !lost.length) {
    fl.append(el('div', 'flag-note', 'Open a part and use Correct to add one. It appears here until an export shows the ERP agrees.'));
    return;
  }
  const table = el('div', 'fix-table');
  const head = el('div', 'fix-row fix-head');
  for (const h of ['Code', 'Field', 'ERP says', 'Should be', 'Why', 'Since', '']) head.append(el('span', null, h));
  table.append(head);
  for (const o of [...pending, ...lost.map(([, x]) => x)]) table.append(fixRow(o, shown.has(overrideKey(o.partId, o.field))));
  fl.append(table);
}

/**
 * A correction for the ERP: the code and its description, the field, what the
 * ERP says and what it should be, why, who and when, and Remove. The code and
 * the value are what get typed into the ERP, so each has its Copy. One that
 * did not save has no Remove: it is not there to remove.
 */
function fixRow(o, saved) {
  const key = overrideKey(o.partId, o.field);
  const row = el('div', 'fix-row');
  const code = el('span', 'fx-code');
  code.append(el('span', 'mono', o.partId), copyMini('Copy code', o.partId, `fix:${key}:code`));
  row.append(code);
  row.append(el('span', null, FIELD_NAME[o.field]));
  row.append(el('span', 'dim', o.current ?? o.baseline ?? '—'));
  const should = el('span', 'fx-should');
  should.append(el('span', 'strong', o.value), copyMini('Copy value', o.value, `fix:${key}:value`));
  row.append(should);
  row.append(el('span', 'dim', o.reason));
  row.append(el('span', 'dim', madeBy(o)));
  // Made by mistake, or no longer wanted: off the list without waiting for
  // an export to agree with it.
  const rm = el('span', 'fix-rm');
  if (saved) {
    const b = armed('Remove correction', 'Confirm removal', () => withdraw(o.partId, o.field));
    b.dataset.focus = `fix:${key}:remove`;
    rm.append(b);
  }
  row.append(rm);
  row.append(el('span', 'fx-desc dim', descOf(o.partId)));
  row.append(el('span', 'fx-live dim', survived(o)));
  const fault = correctionFault(o.partId, o.field);
  if (fault) row.append(fault);
  return row;
}

/** Keep a correction in question, or take the ERP's word: on the page at once, saved behind. */
function decide(o, action) {
  const key = overrideKey(o.partId, o.field);
  const now = overrides[key];
  if (!isActive(now)) return;
  const next = resolveReview(now, action, { by: who, part: partsById.get(o.partId) ?? null });
  putCorrection(key, next, 'Decision not saved',
    action === 'accept' ? `${o.partId}: ERP accepted.` : `${o.partId}: correction kept.`);
}

/**
 * Load corrections from a file — how the ones carried over from the old
 * drafting sheet get in, and how a backup comes back. Checked against the
 * current export before anything is written, so a correction the ERP has
 * already caught up with is reported rather than created.
 */
async function reviewFixFile(file) {
  const host = $('fixLoad');
  const say = (words) => { host.replaceChildren(faultWords(words)); host.hidden = false; };
  // What the file should have been, said once, whatever was wrong with it.
  const notRead = (why) => say(`${file.name} not read: ${why}. A corrections file (.json) is expected.`);
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { console.warn('[corrections]', e.message); notRead('it is not a corrections file'); return; }
  const list = Array.isArray(data) ? data : data?.overrides;
  if (!Array.isArray(list)) { notRead('it has no corrections in it'); return; }
  if (!parts.length) { say('Load the part list before loading corrections.'); return; }

  const toWrite = {};
  const outcomes = { pending: [], review: [], fixed: [], unknown: [], bad: [] };
  for (const o of list) {
    const part = partsById.get(o.partId);
    if (!part) { outcomes.unknown.push(o.partId); continue; }
    if (!OVERRIDE_FIELDS.includes(o.field) || !clean(o.value) || !clean(o.reason)) { outcomes.bad.push(o.partId); continue; }
    const N = tidyValue(o.field, part[o.field]);
    const key = overrideKey(o.partId, o.field);
    const value = tidyValue(o.field, o.value);
    const baseline = o.baseline == null ? N : tidyValue(o.field, o.baseline);
    const base = {
      partId: o.partId, field: o.field, value, baseline,
      reason: clean(o.reason), createdBy: who, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), importsPending: 0, resolution: null,
      lastCheckedExportDate: record?.exportDate ?? null, resolvedAt: null, resolvedBy: null,
      source: o.source ?? file.name,
    };
    if (N === value) { outcomes.fixed.push(o.partId); continue; }
    if (N === baseline) { toWrite[key] = { ...base, status: 'pending', reviewReason: null }; outcomes.pending.push(o.partId); }
    else { toWrite[key] = { ...base, status: 'review', reviewReason: 'myob_changed', observed: N }; outcomes.review.push(o.partId); }
  }

  host.hidden = false;
  host.textContent = '';
  host.append(el('h2', null, 'Corrections to load'));
  host.append(el('div', 'lede', `${file.name} — ${list.length} in the file. Checked against the export dated ${fmtDate(record?.exportDate)}. Nothing changes until you load them.`));
  const grid = el('div', 'import-stats');
  const stat = (n, label, note) => {
    const c = el('div', 'stat');
    c.append(el('b', null, String(n)), el('span', null, label));
    if (note) c.append(el('em', null, note));
    grid.append(c);
  };
  stat(outcomes.pending.length, 'to load as pending');
  stat(outcomes.review.length, 'to load, awaiting a decision', outcomes.review.length ? 'ERP has moved since the file was made' : '');
  stat(outcomes.fixed.length, 'already fixed in the ERP', outcomes.fixed.length ? 'not loaded — nothing to correct' : '');
  stat(outcomes.unknown.length + outcomes.bad.length, 'skipped', outcomes.unknown.length ? 'code not in the export' : '');
  host.append(grid);
  const acts = el('div', 'import-actions');
  const n = Object.keys(toWrite).length;
  const apply = el('button', 'primary', `Load ${count(n, 'correction')}`);
  apply.disabled = !n;
  const cancel = el('button', 'ghost', 'Discard import');
  cancel.addEventListener('click', () => { host.hidden = true; discarded(); });
  let said = null;
  apply.addEventListener('click', () => {
    host.querySelector('.fault')?.remove();
    if (said) unsay(said);
    cancel.disabled = true;
    busy(apply, 'Loading\u2026', async (say) => {
      try {
        await Store.setPartOverrides(toWrite, (done) => { if (done < n) say(`Loading ${done} of ${n}\u2026`); });
      } catch (e) {
        said = failure('Corrections not loaded', e);
        acts.after(faultWords(said));
        toastFailed(said);
        return;
      } finally {
        cancel.disabled = false;
      }
      // What was saved is what is drawn: no second read to wait for.
      host.hidden = true;
      Object.assign(overrides, toWrite);
      rebuildIndexes();
      refreshEntries(Object.values(toWrite).map((o) => o.partId));
      renderFix();
      toast(`${count(n, 'correction')} loaded.`);
    });
  });
  acts.append(apply, cancel);
  host.append(acts);
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------
let staged = null;
// Drawn by import-review.js, as the board's review is. It keeps which count and
// groups are open, and every click there draws the review again from `staged`.
const importReview = createReview(() => renderPartsReview());

/** A line of its own while a file is read. */
function reviewLine(cls, text) {
  const box = el('div', 'import-review');
  box.append(el('div', cls, text));
  return box;
}

/** A failure in words, where it happened. */
function faultWords(words) {
  const line = el('div', 'fault');
  line.setAttribute('role', 'alert');
  line.append(el('span', 'fault-words', words));
  return line;
}

/** A staged import let go: the closing word for it. */
const discarded = () => toast('Import discarded. Nothing changed.');

/** A failure beside the control it is about, and in passing, until the control is used again. */
function trouble(id, words) {
  clearTrouble(id);
  const line = faultWords(words);
  line.id = `${id}Fault`;
  $(id).closest('.results-bar, .view-bar, .import-actions')?.after(line);
  toastFailed(words);
}
const clearTrouble = (id) => $(`${id}Fault`)?.remove();

function wireImport() {
  wireDrop($('dropZone'), $('partsFile'), stageImport);
  renderPartsReview();
}

/**
 * Under the drop zone: the export being reviewed, or the list loaded now. The
 * drop zone hides while one is under review, as on the board, so a second
 * file cannot land on top of the first.
 */
function renderPartsReview() {
  const host = $('partsReview');
  host.textContent = '';
  $('dropZone').hidden = Boolean(staged);
  if (!staged) {
    host.hidden = !record;
    if (record) {
      host.append(el('div', 'import-current',
        `Currently loaded: ${record.sourceLabel ?? 'an export'} — ${record.count ?? parts.length} parts, `
        + `exported ${fmtDate(record.exportDate)}. Drop a new export above to replace it.`));
    }
    return;
  }
  host.hidden = false;
  host.append(importReview.render(stockReview({
    ...staged,
    ...settlement(),
    loaded: parts.length,
    hasCorrections: Object.keys(overrides).length > 0,
    descOf: (id) => partsById.get(id)?.desc ?? '',
    retry: staged.saved,
    apply: commitImport,
    cancel: () => {
      const s = staged;
      staged = null;
      // The list went in before the corrections failed: it is the list now.
      if (s.saved) showImported(s); else { renderPartsReview(); discarded(); }
    },
  })));
  if (staged.trouble) host.append(faultWords(staged.trouble));
}

/**
 * What the export under review does to the corrections as they are now. Not
 * as they were when it was read: one made or changed since then would be
 * written over with what it was.
 */
const settlement = () => reconcile(overrides, staged.nextById, staged.src.exportDate ?? staged.at);

async function stageImport(file) {
  staged = null;
  // What the last import left to do belongs to that import.
  $('partsAfter').hidden = true;
  const host = $('partsReview');
  host.hidden = false;
  host.textContent = '';
  host.append(reviewLine('lede', `Reading ${file.name}…`));
  let src;
  try {
    src = await readStockExport(file);
  } catch (e) {
    host.replaceChildren(faultWords(`${file.name} not read: ${e.words ?? reason(e)}. The Stock Items export (.xlsx) is expected.`));
    return;
  }
  const { parts: fresh, excluded } = transformParts(src.rows);
  const { errors, warnings } = validateStockExport({
    sheetNames: src.sheetNames, title: src.title, headings: src.headings, savedFilter: src.savedFilter,
    exportDate: src.exportDate, count: fresh.length, excluded,
    current: record ? { exportDate: record.exportDate, count: record.count } : null,
  });
  const facts = `${file.name} — exported ${src.exportDate ? fmtDate(src.exportDate) : 'on an unknown date'}. `
    + `${count(src.rows.length, 'row')}, ${count(fresh.length, 'part')}.`;

  if (errors.length) {
    host.textContent = '';
    host.append(importReview.render({
      title: 'Review this import',
      lede: facts,
      notes: errors.map((m) => ({ cls: 'flag flag-bad import-err', text: m })),
      clean: 'This file was not imported.',
    }));
    return;
  }

  const nextById = new Map(fresh.map((p) => [p.id, p]));
  const d = diffParts(parts, fresh);
  // `answers`: what was said in the review to each correction this export puts
  // in question. Nothing is written until Apply.
  staged = {
    src, fresh, excluded, d, warnings, nextById, answers: new Map(), at: new Date().toISOString(),
    lede: fresh.length ? `${facts} Nothing changes until you apply it.` : facts,
  };
  renderPartsReview();
}

/**
 * Apply the export under review, its button busy meanwhile and nothing else
 * in the review pressable. Two steps, each done once: the list (with the copy
 * of the one before it, the one step of undo), then the corrections. A step
 * that fails leaves the review up, says which, and the button does what is
 * left; it never saves the list a second time, which would make the undo copy
 * the new list. What was saved is then what is drawn.
 */
async function commitImport(say) {
  const s = staged;
  if (!s || s.working) return;
  const { fresh, d, excluded, nextById, answers } = s;
  s.rec ??= {
    exportDate: s.src.exportDate ?? s.at,
    dateText: s.src.dateText,
    importedAt: s.at,
    importedBy: who,
    sourceLabel: s.src.sourceLabel,
    savedFilter: s.src.savedFilter,
    count: fresh.length,
    partsJson: JSON.stringify(fresh),
  };
  const { updated, notices } = settlement();
  const settled = settleAnswers(updated, answers, nextById, { by: who });
  const total = Object.keys(settled).length;
  s.working = true;
  // This is its Retry: the failure it said has been dealt with.
  if (s.trouble) unsay(s.trouble);
  s.trouble = null;
  $('partsReview').inert = true;
  try {
    if (!s.saved) {
      await Store.saveParts(s.rec);
      s.saved = true;
    }
    await Store.setPartOverrides(settled, (done) => { if (done < total) say?.(`Applying ${done} of ${total}\u2026`); });
  } catch (e) {
    s.trouble = failure(s.saved ? 'Part list saved, corrections not saved' : 'Import not applied', e);
  }
  s.working = false;
  $('partsReview').inert = false;
  if (s.trouble) {
    keepFocus(renderPartsReview);
    toastFailed(s.trouble);
    return;
  }
  // What each import did, behind it: a log line that does not land costs
  // nobody their import, and is said in passing.
  Store.logPartImport({
    exportDate: s.rec.exportDate, importedAt: s.rec.importedAt, importedBy: who, sourceLabel: s.rec.sourceLabel,
    count: fresh.length, added: d.added.length, removed: d.removed.length,
    descChanged: d.descChanged.length, binChanged: d.binChanged.length,
    fixed: notices.resolved.length, pending: notices.pending.length, review: notices.review.length,
    addedIds: d.added.slice(0, 100), removedIds: d.removed.slice(0, 100),
    unknownFamilies: unknownFamilies(excluded),
  }).catch((e) => toastFailed(failure('Import not logged', e)));
  staged = null;
  showImported(s, settled);
}

/** The export as saved, on the page; and what the importer does next: the list for the ERP. */
function showImported(s, settled = {}) {
  apply({ record: s.rec, overrides: { ...overrides, ...settled }, materials });
  renderAll();
  const after = $('partsAfter');
  after.hidden = false;
  after.textContent = '';
  after.append(el('h3', null, `Imported — ${count(s.fresh.length, 'part')} as of ${fmtDate(s.rec.exportDate)}`));
  const live = fixList(overrides, partsById);
  if (live.length) {
    after.append(el('div', 'flag-note', `${count(live.length, 'correction')} still waiting on the ERP. `
      + 'They are on the Corrections tab, with Copy list and Download CSV.'));
    const go = el('button', 'mini', 'Open the list');
    go.addEventListener('click', () => openTab('fix'));
    after.append(go);
  } else {
    after.append(el('div', 'flag-note', 'Nothing is waiting on the ERP.'));
  }
  toast(`${count(s.fresh.length, 'part')} loaded.`);
}

// ---------------------------------------------------------------------------
/**
 * A copy button whose write was refused: the button says so, and the toast
 * says why, as near as the page can tell. The focus is read first, before
 * anything else can move it.
 */
async function copyFailed(btn, label) {
  const focused = document.hasFocus();
  flash(btn, label, '\u2717 Not copied', 'bad');
  let permission = null;
  try {
    permission = (await navigator.permissions?.query({ name: 'clipboard-write' }))?.state ?? null;
  } catch { /* a browser that does not name this permission */ }
  const why = copyFailure({ clipboard: Boolean(navigator.clipboard?.writeText), focused, permission });
  toastFailed(COPY_FAILED[why]);
}

/**
 * Say it on the button. A toast at the foot of the page is easy to miss, and
 * a copy that says nothing where the finger is looks like a copy that
 * failed. The button reads "✓ Copied" for a moment and goes back to itself.
 */
function flash(btn, label, text, cls, ms = 1600) {
  btn.textContent = text;
  btn.classList.add(cls);
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = label;
    btn.classList.remove(cls);
    btn.disabled = false;
  }, ms);
}

