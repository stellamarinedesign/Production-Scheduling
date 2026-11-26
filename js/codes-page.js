// codes-page.js — the vessel code table, one line per boat.
//
// THE DISPLAY CODE IS THE BOAT.
//
// That is the identity everyone actually uses: the floor reads "XX06", not
// "XX16". So it is the key, the first column, and the thing you edit. The ERP
// codes sit beside it as evidence rather than as the heading.
//
// The old page listed one row per Stella code, which put XX01 and XX11 on
// separate lines despite their printing the same thing — it showed the plumbing
// instead of the answer.
//
// THE SCREEN FIRST, THE WRITE BEHIND IT. An edit is drawn as it is made; one
// the store refuses goes back as it was, and its row says why (code-edits.js).

import { Store, unpackRows } from './store.js';
import { resolveDisplays, boatRows, modelOptions, itemFacts, factsFromStore,
         factsAreStale, setBuilders, upgradeCodeMap } from './vessel-codes.js';
import { classify } from './rules.js';
import { Auth, ROLE, setManagers, setEngineers, setMasters, setTesters } from './auth.js';
import { signInForm, focusSignIn, readAccess, watchRole } from './sign-in.js';
import { showTestMode, carryFlag, prefs } from './test-mode.js';
import { VERSION } from './version.js';
import { fitCodesSheet, TYPE_STEPS } from './codes-print.js';
import { davitsByBoat } from './davits.js';
import { today } from './transform.js';
import { wireHelp } from './help.js';
import { startup, keepWatch, forgetDevice } from './boot.js';
import { watchDialogs, keepFocus } from './dialog.js';
import { toast, toastFailed, unsay } from './toast.js';
import { ask, choose } from './ask.js';
import { busy } from './busy.js';
import { count, failure } from './words.js';
import { createLedger, nameCodes, moveCode, joinedBy, sameName, davitsWith,
         loadReview, fileProblem, downloadName, codeInHash } from './code-edits.js';
import './press.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// The view and the folded groups are remembered on this device and nowhere
// else: they say nothing about the codes.
const VIEW_KEY = 'stella.codes.view';
const FOLDED_KEY = 'stella.codes.folded';
const loadFolded = () => {
  try { return new Set(JSON.parse(prefs.get(FOLDED_KEY) ?? '[]')); }
  catch { return new Set(); }
};

let codeMap = {};                   // as drawn: the store's, with the edits it has not answered
let resolved = null;
let mode = prefs.get(VIEW_KEY) === 'products' ? 'products' : 'boats';
const collapsed = loadFolded();
const visiting = new Set();         // folded on this device, opened for something in them
let facts = null;   // item code -> { description, orders }
let davits = [];    // boat -> davits, straight from the export; as drawn, like the codes

const edits = createLedger({
  write: (e) => Store.saveCodes(e.patches),
  drawn: redraw,
  saved: (e) => toast(e.said),
  failed: (e, words) => { showLine(Object.keys(e.patches)); toastFailed(words); },
});

// The davit list is one document, saved whole, so its edits are saved in turn.
// Nothing listens to it, so it says for itself that one has not been sent.
const davitEdits = createLedger({
  write: (e, list) => Store.saveDavits(list),
  apply: davitsWith,
  revert: (list) => list,
  inTurn: true,
  drawn: () => { redraw(); tellLink(); },
  saved: (e) => { toast(e.said); tellLink(); },
  failed: (e, words) => toastFailed(words),
});
let tellLink = () => {};

/** Forget what this device holds: the saved copies (boot.js) and the board's rows. */
async function forget() {
  await forgetDevice();
  Store.clearCache();
}

(async function boot() {
  $('pageVersion').textContent = `v${VERSION}`;
  watchDialogs();
  showMode();
  // Start-up, watched: a time limit on each step and the offline line. See boot.js.
  const watch = startup();
  watch.step('sign-in');

  // THE STORE COMES UP BEFORE THE ROLE IS READ.
  //
  // The manager list lives in Firestore now, and Firebase reports the signed-in
  // user before the store exists — so the role Auth first hands over is always
  // FLOOR, whoever signed in. This page acted on that immediately and bounced
  // every manager straight back to the board, which made it unreachable.
  //
  // The callback also has to be resolved rather than assumed: onAuthStateChanged
  // fires asynchronously, so reading Auth.role right after init is a race.
  const first = await new Promise((resolve) => {
    let done = false;
    Auth.init((st) => { if (!done) { done = true; resolve(st); } }, { forget })
      .then((mode) => { if (mode === 'failed') watch.retry(); });
  });
  // The hub's full-screen card is up: it is the answer, with nothing drawn behind it.
  if (first.role === ROLE.NONE && Auth.hubCard) {
    await forget();
    for (const n of document.querySelectorAll('body > header, body > main')) n.hidden = true;
    watch.done();
    return;
  }

  watch.step('connect');
  await Store.init();
  // ASKED FOR WITH THE ACCESS LIST, not a round trip after it. Who is answered
  // is the rules' decision, not the page's; what comes back is drawn only once
  // the role is known. Signed out there is nobody to ask for.
  const reads = first.mode === 'local' || first.email ? loadPage() : null;
  reads?.catch(() => {});                     // said where it is waited for
  watch.step('access', 'firestore');
  const access = await readAccess(watch);
  setManagers(access.managers);
  setEngineers(access.engineers);
  setMasters(access.masters);
  setTesters(access.testers);
  const role = Auth.refreshRole();
  // Drawn for this role; drawn again if Hubinator changes it (sign-in.js).
  if (Auth.mode === 'firebase' && first.email) watchRole(first.email, access);
  // A tester is in test mode from here, flag or no flag; see test-mode.js.
  if (Auth.isTester) Store.enterTestMode();
  Store.setWriter(role === ROLE.MANAGER);
  showTestMode();
  document.body.classList.toggle('role-engineer', role === ROLE.ENGINEER);

  // SAY WHY, DO NOT BOUNCE.
  //
  // This used to redirect to the board. A redirect leaves nothing on screen to
  // read — not the reason, not the build — so when it fired wrongly there was
  // no way to tell a broken role check from a cached copy of this file, and no
  // way to tell either of those from "you are not a manager". Whatever the
  // answer is, it is more useful on the page than in the address bar.
  if (!Auth.isStaff) {
    // Nothing about roles or lists: only the admin knows they exist (Pete, 27 Nov 2026).
    const why = role === ROLE.NONE ? 'Not signed in.' : `Signed in as ${first.email ?? 'an account'}.`;
    const host = $('codesDenied');
    host.hidden = false;
    host.textContent = '';
    host.append(el('strong', null, 'Vessel codes not available'));
    host.append(el('div', null, why));
    // Signed in, the page loads again: as that account's, from the start.
    if (role === ROLE.NONE) host.append(signInForm({ signedIn: () => { location.reload(); return new Promise(() => {}); } }));
    const back = el('a', 'backlink', 'Go to the board');
    back.href = carryFlag('./');
    host.append(back);
    for (const n of document.querySelectorAll('main .view-bar, main #rows, main #warnings, main .provenance')) {
      n.hidden = true;
    }
    stopCodes();
    focusSignIn();
    watch.done();
    return;
  }

  $('storeMode').textContent = Store.mode === 'firestore' ? 'Saved for everyone' : 'Saved on this device only';
  if (Store.mode !== 'firestore') $('storeMode').style.color = 'var(--red-bright)';
  watch.step('codes', 'firestore');
  try {
    await reads;
  } catch (e) {
    console.error('[codes]', e);
    watch.fail();
    return;
  }

  $('modeBoats').addEventListener('click', () => setMode('boats'));
  $('modeProducts').addEventListener('click', () => setMode('products'));
  wireHelp({ admin: () => Auth.isMaster, role: () => Auth.role });
  $('saveCodes').addEventListener('click', downloadCodes);
  $('loadCodes').addEventListener('click', () => $('codesFile').click());
  $('codesFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';                      // so the same file can be picked twice
    if (f) stageFile(f);
  });
  $('previewSheet').addEventListener('click', () => togglePreview());
  $('printSheet').addEventListener('click', () => {
    // The sheet is only built while the preview is on, so this printed an empty
    // page and looked broken. Build it first, then print — two frames, because
    // the fit measures the laid-out sheet.
    // `togglePreview` renders synchronously, so the sheet is in the DOM by the
    // time this returns. No frame to wait for — and waiting on one was worse
    // than useless, because requestAnimationFrame is throttled when the tab is
    // not in front, which is exactly when a print dialog would never appear.
    if (!sheetShown) togglePreview();
    window.print();
  });
  render();
  rendered = true;
  watch.done();
  keepWatch({
    what: 'Vessel codes',
    onLink: (cb) => {
      tellLink = () => { const l = Store.link(); cb({ ...l, unsent: l.unsent || davitEdits.waiting() > 0 }); };
      Store.onLink(tellLink);
    },
  });
  window.addEventListener('hashchange', openLinked);
  openLinked();
})();

/**
 * Everything the page shows.
 *
 * ONE READ OF EACH, ALL AT ONCE. The codes come from the listener that keeps
 * them live (its first answer from the server is the load), and the latest
 * import, which the facts and the davits both fall back to, is read once
 * between them. These used to be four reads in a row, with the codes and the
 * import each downloaded twice.
 */
async function loadPage() {
  const [f, d] = await Promise.all([
    loadFacts(),
    // The davit fall-back reads vessel codes off the rows, which needs the builders.
    Store.loadSettings().catch(() => ({})).then((s) => { setBuilders(s.builders); return loadDavits(); }),
    watchCodeMap(),
  ]);
  facts = f;
  davitEdits.set(d);
}

/**
 * The code map, kept live. Resolves once the server has first answered,
 * with that answer in hand; every change after it - a rename made
 * on the board page, or by the other manager - lands here without a reload,
 * debounced because a board edit writes one document per ERP code on the
 * line, and each write fires its own snapshot. In local mode there is nothing
 * to watch and the store's read is the load.
 */
let rendered = false;
let stopCodes = () => {};
async function watchCodeMap() {
  if (Store.mode !== 'firestore') { edits.set(await Store.loadCodes()); return; }
  await new Promise((resolve, reject) => {
    let loaded = false;
    let t = null;
    stopCodes = Store.watchCodes((m, meta) => {
      if (!loaded && !meta.confirmed) return;      // the SDK's cache, before the server answered
      edits.set(m);
      if (!loaded) { loaded = true; resolve(); return; }
      if (!rendered) return;                        // the first render reads it
      clearTimeout(t);
      t = setTimeout(redraw, 150);
    }, (e) => { if (!loaded) reject(e); });
  });
}

// Not `beforeunload`: that one asks first, and a page that stays still listens.
window.addEventListener('pagehide', (e) => {
  if (e.persisted) return;                          // kept, and shown again as it was
  try { stopCodes(); } catch {}
});

// A file chosen and not loaded, or half loaded, or an edit the server does not
// have yet because there is no connection, would go with the page: the browser asks.
window.addEventListener('beforeunload', (e) => {
  const link = Store.link();
  const unsent = (link.unsent || davitEdits.waiting() > 0) && (link.lost || navigator.onLine === false);
  if (staged?.data || unsent) e.preventDefault();
});

// The newest import, read at most once: the facts and the davits both fall
// back to its rows when nothing has been accumulated yet.
let latestRead = null;
const latestBoard = () => (latestRead ??= Store.latestBoard());

function showMode() {
  $('modeBoats').setAttribute('aria-current', mode === 'boats' ? 'page' : 'false');
  $('modeProducts').setAttribute('aria-current', mode === 'products' ? 'page' : 'false');
}

function setMode(m) {
  mode = m;
  prefs.set(VIEW_KEY, m);
  showMode();
  redraw();
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

/** The heading a line sits under. */
const groupOf = (r) => r.category ?? 'Nothing on the board';

const isShut = (cat) => collapsed.has(cat) && !visiting.has(cat);
/** Open a group for this visit: folded on this device, it is folded again at the next. True if it was shut. */
function visit(cat) {
  if (!isShut(cat)) return false;
  visiting.add(cat);
  return true;
}

let drawn = [];                     // [{ r, row }], the lines on screen
let faultsDrawn = new Set();        // the faults already on a line, in this drawing

/** The line on screen with this ERP code on it. */
const lineOf = (code) => drawn.find((d) => d.r.codes.includes(code));

/** Nowhere: on the page itself, or in a dialog that has closed. */
const focusLost = () => {
  const n = document.activeElement;
  return !n || n === document.body || Boolean(n.closest('.overlay:not(.show)'));
};

/**
 * Draw everything again. The control that had the focus has it after, or where
 * its line has merged into another, or it is no longer offered, the nearest
 * thing to it on the line.
 */
function redraw() {
  if (!rendered) return;
  const had = document.activeElement?.closest('[data-code] button');
  const code = had?.closest('[data-code]').dataset.code;
  const act = had?.dataset.act;
  keepFocus(render);
  if (!had || !focusLost()) return;
  const row = lineOf(code)?.row;
  (row?.querySelector(`[data-act="${act}"]`) ?? row?.querySelector('.c-act button'))?.focus({ preventScroll: true });
}

function render() {
  codeMap = edits.now();
  davits = davitEdits.now();
  resolved = resolveDisplays(codeMap);
  drawn = [];
  faultsDrawn = new Set();
  // Editing is the manager's; the rules hold whatever is drawn here.
  $('loadCodes').hidden = !Auth.isManager;
  renderEmpty();
  renderWarnings();
  renderStaged();

  const rows = boatRows(codeMap, classify, { mode, facts });
  const host = $('rows');
  host.textContent = '';
  renderDavitRows();

  $('modeHint').textContent = mode === 'boats'
    ? `${count(rows.length, 'boat')}, tagged with the product line each is best known by.`
    : `${count(rows.length, 'line')} — one per boat per product line, so a boat that builds `
      + 'both a lifter and a ladder appears in each.';

  // Grouped by category in priority order: lifters lead, then rotary.
  const counts = new Map();
  for (const r of rows) counts.set(groupOf(r), (counts.get(groupOf(r)) ?? 0) + 1);

  let current = null;
  for (const r of rows) {
    const cat = groupOf(r);
    if (cat !== current) {
      current = cat;
      host.append(categoryHead(cat, counts.get(cat)));
    }
    if (isShut(cat)) continue;
    const row = boatRow(r);
    drawn.push({ r, row });
    host.append(row);
  }

  renderSheet(rows);
}

/** Nothing stored, which is why there is no table, and where codes come from. */
function renderEmpty() {
  const host = $('codesEmpty');
  host.hidden = Object.keys(codeMap).length > 0;
  host.textContent = Auth.isManager
    ? 'No vessel codes yet. They are added as new codes are decided on the board, or from a file with Load codes.'
    : 'No vessel codes yet.';
}

/**
 * Keep the printable sheet in step with whatever the page is showing, so
 * "Print code sheet" never prints a different view from the one on screen.
 *
 * It is rendered whether or not the preview is open, because the print
 * stylesheet reveals it directly — the button only controls what is on screen.
 */
let sheetShown = false;

function renderSheet(rows) {
  const host = $('codesSheet');
  const root = $('codesPrintRoot');

  // Measuring needs layout. While the preview is closed the host is parked
  // off-canvas rather than display:none, or the fit would measure zero and
  // report a comfortable fit at full size — the trap the board's auto-fit hit.
  root.hidden = false;
  root.classList.toggle('offstage', !sheetShown);

  const onSheet = rows.filter((r) => !r.sheetHidden);
  const fit = fitCodesSheet(host, onSheet, { mode, davits: withDavitHulls(davits) });

  const status = $('sheetStatus');
  status.hidden = !sheetShown;
  status.classList.toggle('trimmed', !fit.fits || fit.shrunk);
  const lines = count(onSheet.length + davits.filter((d) => !d.sheetHidden).length, 'line');
  status.textContent = !fit.measured
    ? 'Could not measure the sheet.'
    : fit.fits && !fit.shrunk
      ? `One landscape A4 page at ${fit.pt}pt — ${lines}.`
      : fit.fits
        ? `Type stepped down to ${fit.pt}pt to hold one page (${lines}). `
          + `Split by product adds rows, so the boats view will usually print larger.`
        : `Will not fit one page even at ${TYPE_STEPS[TYPE_STEPS.length - 1]}pt — `
          + `${lines}. It will run to a second page.`;
}

function togglePreview() {
  sheetShown = !sheetShown;
  $('previewSheet').classList.toggle('on', sheetShown);
  $('previewSheet').setAttribute('aria-pressed', String(sheetShown));
  redraw();
}

/**
 * The davit lines: what the sheet reads for each boat, and whether it reaches
 * the sheet at all.
 *
 * They come from the export rather than the code map, so they are stored and
 * edited separately — but they carry the same two decisions as every other
 * line, and the sheet prints them in the same four columns.
 */
/**
 * Hulls for each davit line, from the accumulated item facts.
 *
 * Kept out of davits.js: that module reads the export and nothing else, and
 * hulls are a fact about the item that the store has been collecting.
 */
function withDavitHulls(list) {
  return list.map((d) => ({
    ...d,
    hulls: [...new Set(d.davits.flatMap((x) => facts?.get(x.item)?.hulls ?? []))].sort(),
  }));
}

function renderDavitRows() {
  const section = $('davitSection');
  const host = $('davitRows');
  section.hidden = !davits.length;
  host.textContent = '';
  if (!davits.length) return;

  for (const d of withDavitHulls(davits)) {
    const key = `davit|${d.boat}`;
    const row = el('div', `code-row${d.sheetHidden ? ' is-offsheet' : ''}`);
    row.append(el('div', 'c-display', d.display || d.boat));
    row.append(el('div', 'c-model', d.boat));
    row.append(el('div', 'c-hull', (d.hulls ?? []).join(', ') || '—'));

    const items = el('div', 'c-items');
    const lists = [];
    for (const x of d.davits) {
      if (x.description === x.item) { items.append(el('span', 'c-item', x.item)); continue; }
      const c = codeChip('c-item', x.description, [x.item], `${key}|${x.item}`);
      items.append(c.chip);
      lists.push(c.list);
    }
    row.append(items);

    const act = el('div', 'c-act');
    if (Auth.isManager) {
      act.append(
        rowButton('Rename', 'rename', key, () => renameDavit(d)),
        hideButton(d, key, () => toggleDavitHidden(d)));
    }
    row.append(act, ...lists, ...faultLines(davitEdits, [d.boat]));
    host.append(row);
  }
}

function categoryHead(cat, n) {
  const shut = isShut(cat);
  const head = el('button', `codes-cat${shut ? ' is-collapsed' : ''}`);
  head.type = 'button';
  head.dataset.focus = `group:${cat}`;
  head.setAttribute('aria-expanded', String(!shut));
  head.append(el('span', 'cat-caret', shut ? '▸' : '▾'));
  head.append(el('span', 'name', cat));
  head.append(el('span', 'n', String(n)));
  head.addEventListener('click', () => {
    if (shut) collapsed.delete(cat); else collapsed.add(cat);
    visiting.delete(cat);
    prefs.set(FOLDED_KEY, JSON.stringify([...collapsed]));
    redraw();
  });
  return head;
}

const SHORT = {
  'Cylinder lifters': 'Lifter',
  'Rotary Lifters': 'Rotary',
  'Launchers, Doors & Chocks': 'Launcher/Door',
  'Ladders and Chairs': 'Ladder/Chair',
  Davits: 'Davit',
};
const shortCat = (c) => SHORT[c] ?? c;

/** A control on a row, which a redraw can find again. */
function rowButton(label, act, key, run) {
  const b = el('button', 'mini', label);
  b.type = 'button';
  b.dataset.act = act;
  b.dataset.focus = `${act}:${key}`;
  b.addEventListener('click', run);
  return b;
}

/** On the sheet or off it. The label is the state, so there is no pressed look to read as well. */
function hideButton(line, key, run) {
  return rowButton(line.sheetHidden ? 'Show on sheet' : 'Hide from sheet', 'hide', key, run);
}

// The chips opened to their item codes, by row and chip, so a redraw leaves them open.
const opened = new Set();
let chipSeq = 0;

/**
 * A chip that stands for item codes it does not show. Pressed, it lists them
 * under its row; hovering says them too, but a finger cannot hover.
 *
 * @returns {{chip: HTMLElement, list: HTMLElement}} the list goes at the foot of the row
 */
function codeChip(cls, text, items, key) {
  const chip = el('button', cls, text);
  chip.type = 'button';
  chip.title = items.join('\n');
  chip.dataset.focus = `chip:${key}`;
  const list = el('div', 'cx-list');
  list.id = `itemCodes${chipSeq += 1}`;
  list.append(el('span', 'cx-of', text));
  for (const i of items) list.append(el('span', 'c-item', i));
  chip.setAttribute('aria-controls', list.id);
  const show = (on) => {
    chip.setAttribute('aria-expanded', String(on));
    list.hidden = !on;
    if (on) opened.add(key); else opened.delete(key);
  };
  chip.addEventListener('click', () => show(list.hidden));
  show(opened.has(key));
  return { chip, list };
}

/**
 * What was not saved on this line, each with the way to try it again. Said
 * once: split by product, a code can be on more than one line.
 */
function faultLines(ledger, keys) {
  const out = [];
  for (const f of ledger.faults()) {
    if (faultsDrawn.has(f) || !Object.keys(f.edit.patches).some((k) => keys.includes(k))) continue;
    faultsDrawn.add(f);
    const line = el('div', 'cx-fault');
    line.setAttribute('role', 'alert');
    line.append(el('span', null, f.words),
      rowButton('Retry', 'retry', `${f.edit.kind}|${keys[0]}`, () => { unsay(f.words); ledger.retry(f); }),
      rowButton('Dismiss', 'dismiss', `${f.edit.kind}|${keys[0]}`, () => { unsay(f.words); ledger.dismiss(f); }));
    out.push(line);
  }
  return out;
}

/** Open the group a line is in, where it is folded: what is said on a line has to be on the screen. */
function showLine(codes) {
  const r = boatRows(codeMap, classify, { mode, facts }).find((x) => x.codes.some((c) => codes.includes(c)));
  if (r && visit(groupOf(r))) redraw();
}

function boatRow(r) {
  const key = `${r.codes[0]}|${mode === 'products' ? groupOf(r) : ''}`;
  const row = el('div', `code-row${r.sheetHidden ? ' is-offsheet' : ''}`);
  row.dataset.code = r.codes[0];
  const lists = [];

  // 1. THE DISPLAY. First, largest, and what everything else hangs off.
  const disp = el('div', 'c-display');
  disp.append(el('span', 'c-code', r.display));
  disp.append(el('span', r.confirmed ? 'chip ok' : 'chip no',
    r.confirmed ? 'CONFIRMED' : 'UNCONFIRMED'));
  row.append(disp);

  // 2. The ERP codes that resolve to it — evidence, not identity.
  const codes = el('div', 'c-codes');
  for (const c of r.codes) {
    const tag = el('span', `c-tag${c === r.display ? ' is-same' : ''}`, c);
    if (c !== r.display) tag.title = `ERP code ${c} prints as ${r.display}`;
    codes.append(tag);
  }
  row.append(codes);

  // 3. What the manufacturer calls it, and the hulls it has been fitted to.
  // What the code sheet prints, not every code the data carries — a boat with
  // three manufacturer codes should not put all three on a sheet of paper.
  const modelCell = el('div', `c-model${r.modelSet ? ' is-set' : ''}`, r.model || '—');
  if (r.modelSet) modelCell.title = `Set by hand. Found in the data: ${r.models.join(', ') || 'none'}`;
  row.append(modelCell);
  row.append(el('div', 'c-hull', r.hulls.join(', ') || '—'));

  // 4. Products. In boats mode a boat with several product lines shows them as
  //    chips; in products mode the row is already one category, so list items.
  const items = el('div', 'c-items');
  const chip = (cls, text, stands, id) => {
    const c = codeChip(cls, text, stands, `${key}|${id}`);
    items.append(c.chip);
    lists.push(c.list);
  };
  if (mode === 'boats' && r.categories.length > 1) {
    for (const c of r.categories) chip('c-catchip', shortCat(c), r.byCategory.get(c).map((x) => x.item), c);
  } else {
    for (const { item } of r.items) {
      // A davit's part number says nothing a person can use; its description
      // gives the capacity and the configuration, which is what the product IS.
      // Everywhere else the code is the more useful of the two.
      const desc = r.category === 'Davits' ? facts?.get(item)?.description : null;
      if (desc) chip('c-item', desc, [item], item);
      else items.append(el('span', 'c-item', item));
    }
  }
  row.append(items);

  const act = el('div', 'c-act');
  if (Auth.isManager) {
    if (!r.confirmed) act.append(rowButton('Confirm code', 'confirm', key, () => confirmLine(r)));
    act.append(
      rowButton('Set model', 'model', key, () => setModel(r)),
      rowButton('Rename', 'rename', key, () => rename(r)),
      hideButton(r, key, () => toggleSheetHidden(r)));
    // One code on the line is the line: there is nothing to split.
    if (r.codes.length > 1) act.append(rowButton('Move code', 'split', key, () => split(r)));
  }
  row.append(act, ...lists, ...faultLines(edits, r.codes));
  return row;
}

function renderWarnings() {
  const host = $('warnings');
  const open = new Set([...host.querySelectorAll('details[open]')].map((d) => d.dataset.panel));
  host.textContent = '';
  const panel = (id, cls, title, openAtFirst) => {
    const d = el('details', cls);
    d.dataset.panel = id;
    d.open = openAtFirst || open.has(id);
    const s = el('summary', null, title);
    s.dataset.focus = `panel:${id}`;
    const b = el('div', 'body');
    d.append(s, b);
    host.append(d);
    return b;
  };

  for (const c of resolved.conflicts) {
    const b = panel(`conflict:${c.codes[0]}`, 'panel alert',
      'Vessel code conflict — two confirmed display codes for one boat', true);
    b.append(el('div', null,
      `${c.codes.join(' and ')} are grouped together but confirmed to different `
      + `display codes: ${c.values.map((v) => `${v.code} → ${v.display}`).join(', ')}. `
      + 'Rename the line to settle it.'));
  }

  if (resolved.undecided.length) {
    const b = panel('undecided', 'panel', `Awaiting confirmation (${resolved.undecided.length})`, false);
    for (const u of resolved.undecided) {
      const line = el('div');
      const link = el('a', 'cx-link', u.codes.join(', '));
      link.href = `#${encodeURIComponent(u.codes[0])}`;
      link.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();                  // the same address twice is no change of address
        openCode(u.codes[0]);
      });
      line.append(link, document.createTextNode(` — shown as "${u.provisional}", not confirmed.`));
      b.append(line);
    }
  }
}

// ---------------------------------------------------------------------------
// a link to one code
//
// The board sends somebody here for one line: `vessel-codes#XX01`.
// ---------------------------------------------------------------------------

function openLinked() {
  const code = codeInHash(location.hash);
  if (code) openCode(code);
}

/** Open the group a code is in, bring its line into view, mark it, and go to its first control. */
function openCode(wanted) {
  const is = (x) => sameName(x, wanted);
  const has = (r) => r.codes.some(is);
  const rows = boatRows(codeMap, classify, { mode, facts });
  const r = rows.find(has) ?? rows.find((x) => is(x.display));
  if (!r) { toast(`Vessel code ${wanted} not found.`); return; }
  if (visit(groupOf(r))) redraw();
  const row = (drawn.find((d) => has(d.r)) ?? drawn.find((d) => is(d.r.display)))?.row;
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'auto' });
  row.classList.remove('is-marked');
  void row.offsetWidth;                      // so a second arrival marks it again
  row.classList.add('is-marked');
  row.addEventListener('animationend', () => row.classList.remove('is-marked'), { once: true });
  const to = row.querySelector('.c-act button') ?? row.querySelector('button') ?? row;
  if (to === row) row.tabIndex = -1;
  to.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// edits
// ---------------------------------------------------------------------------

/** Every boat as its line reads, and the one these ERP codes are on. */
const boats = () => boatRows(codeMap, classify, { mode: 'boats', facts });
const boatWith = (codes) => boats().find((b) => b.codes.some((c) => codes.includes(c)));

/** After a dialog: the focus where the edit was made, on the line its code is on now. */
function backTo(code, act) {
  if (!focusLost()) return;
  const row = lineOf(code)?.row;
  (row?.querySelector(`[data-act="${act}"]`) ?? row?.querySelector('.c-act button'))?.focus({ preventScroll: true });
}

const NAME_REQUIRED = 'A display code is required.';

/**
 * Ask before a display code puts two lines together: the display is the boat,
 * so two lines that read the same are one (see aliasGroups). True when there
 * is nothing to ask.
 */
async function mayMerge(value, joined, line) {
  if (!joined.length) return true;
  return choose({
    title: 'Display code in use',
    lede: `${spelled(value, joined)} is in use by another boat.`,
    facts: [line, ...joined.map((b) => [b.display, `ERP codes ${b.codes.join(', ')}`])],
    yes: `Merge with ${joined.map((b) => b.display).join(' and ')}`,
    no: 'Keep separate',
  });
}

/** A display code as the boat it belongs to already spells it. */
const spelled = (value, joined) => joined.find((b) => sameName(b.display, value))?.display ?? value;

/** Put a line's codes under one confirmed display code, as one save. */
async function nameLine(r, value, act, words) {
  const joined = joinedBy(codeMap, nameCodes(r.codes, value)).map(boatWith);
  if (await mayMerge(value, joined, [r.display, `ERP codes ${r.codes.join(', ')}`])) {
    const display = spelled(value, joined);
    edits.save({ kind: 'name', patches: nameCodes(r.codes, display), ...words(display) });
  }
  backTo(r.codes[0], act);
}

/** What the floor reads for a boat. */
async function rename(r) {
  const got = await ask({
    title: 'Display code',
    facts: [['ERP codes', r.codes.join(', ')], ['Model codes', r.models.join(', ')]],
    fields: [{ key: 'display', label: 'Display code', value: r.display, check: (v) => (v ? null : NAME_REQUIRED) }],
    actions: [{ value: 'save', label: 'Save display code', kind: 'primary' }, { label: 'Cancel', close: true }],
  });
  if (!got) return;
  await nameLine(r, got.values.display, 'rename', (display) => ({
    what: `${r.display} not renamed`,
    said: `${r.codes.join(' / ')} now ${r.codes.length === 1 ? 'prints' : 'print'} as "${display}".`,
  }));
}

/** The display code a line already shows is the right one. */
const confirmLine = (r) => nameLine(r, r.display, 'confirm', (display) => ({
  what: `${r.display} not confirmed`, said: `${display} confirmed.`,
}));

/** Move one ERP code off this boat, onto its own line or onto another boat. */
async function split(r) {
  const line = boatWith(r.codes) ?? r;
  const others = boats().filter((b) => b.codes[0] !== line.codes[0]);
  const OWN = 'own';
  const got = await ask({
    title: 'Line split',
    facts: [['Display code', line.display]],
    fields: [
      { key: 'code', label: 'ERP code', value: r.codes[r.codes.length - 1], options: r.codes.map((c) => ({ value: c })) },
      { key: 'to', label: 'Moves to', value: OWN,
        options: [{ value: OWN, label: 'A line of its own' },
          ...others.map((b, i) => ({ value: `boat${i}`, label: `${b.display}  (${b.codes.join(', ')})` }))] },
      { key: 'display', label: 'Display code', value: (v) => v.code, when: (v) => v.to === OWN,
        check: (value, v) => {
          if (!value) return NAME_REQUIRED;
          const left = line.codes.filter((c) => c !== v.code);
          return sameName(value, line.display) || left.some((c) => sameName(codeMap[c]?.display, value))
            ? 'Already the display code of this line.' : null;
        } },
    ],
    actions: [{ value: 'move', label: 'Move code', kind: 'primary' }, { label: 'Cancel', close: true }],
  });
  if (!got) return;

  const { code, to } = got.values;
  const onto = others.find((b, i) => to === `boat${i}`) ?? null;
  const value = onto?.display ?? got.values.display;
  const move = (display) => moveCode(codeMap, line.codes, code, display, line.display);
  // Joining the boat picked is what was asked for; any other is asked about.
  const joined = joinedBy(codeMap, move(value)).map(boatWith).filter((b) => b.codes[0] !== onto?.codes[0]);
  if (await mayMerge(value, joined, ['ERP code', code])) {
    const display = spelled(value, joined);
    edits.save({ kind: 'name', patches: move(display), what: `${code} not moved`, said: `${code} now reads "${display}".` });
  }
  backTo(r.codes.find((c) => c !== code), 'split');
}

/**
 * Keep a line off the printed code sheet, or put it back.
 *
 * For a boat nobody builds any more. It stays on this page — hiding is a
 * decision about a sheet of paper, not a deletion — and the sheet is what runs
 * out of room, not the screen.
 *
 * Stored on every code of the boat, so it survives a rename or a split; and
 * read off any one of them, so it has to come off them all.
 */
function toggleSheetHidden(r) {
  const next = !r.sheetHidden;
  edits.save({
    kind: 'hide',
    patches: Object.fromEntries((boatWith(r.codes) ?? r).codes.map((c) => [c, { sheetHidden: next || null }])),
    ...hideWords(r.display, next),
  });
}

const hideWords = (name, hidden) => ({
  what: hidden ? `${name} not hidden from the sheet` : `${name} not shown on the sheet`,
  said: hidden ? `${name} hidden from the sheet.` : `${name} shown on the sheet.`,
});

/**
 * Choose what the code sheet prints in the Model column.
 *
 * A boat can carry several manufacturer codes — a plain one, the same with a
 * voltage, one with a note appended — and the sheet has room for one. Sometimes
 * the right answer is none of them, so this takes free text as well as the
 * codes found in the data.
 *
 * Stored on the boat, affects the code sheet only. Written to every code on
 * the line so it survives a split or a rename of any one of them.
 */
async function setModel(r) {
  const found = modelOptions(r, codeMap);
  const now = r.modelSet ? r.model : '';
  const at = found.indexOf(now);
  const got = await ask({
    title: 'Model on the sheet',
    facts: [['Display code', r.display], ['Model codes', found.join(', ')], ...(now ? [['Set by hand', now]] : [])],
    fields: [
      { key: 'pick', label: 'Model', value: !now ? 'every' : at >= 0 ? `model${at}` : 'other',
        options: [...found.map((m, i) => ({ value: `model${i}`, label: m })),
          { value: 'every', label: 'Every model code' }, { value: 'other', label: 'Other' }] },
      { key: 'other', label: 'Other model', value: at >= 0 ? '' : now, when: (v) => v.pick === 'other',
        check: (v) => (v ? null : 'A model is required.') },
    ],
    actions: [{ value: 'save', label: 'Save model', kind: 'primary' }, { label: 'Cancel', close: true }],
  });
  if (!got) return;
  const { pick, other } = got.values;
  const value = pick === 'every' ? '' : pick === 'other' ? other : found.find((m, i) => pick === `model${i}`);
  if (value !== now) {
    edits.save({
      kind: 'model',
      patches: Object.fromEntries(r.codes.map((c) => [c, { sheetModel: value || null }])),
      what: `Model for ${r.display} not saved`,
      said: value ? `${r.display} prints "${value}".` : `${r.display} shows every model code.`,
    });
  }
  backTo(r.codes[0], 'model');
}

async function renameDavit(d) {
  const got = await ask({
    title: 'Display code',
    facts: [['In the item codes', d.boat]],
    fields: [{ key: 'display', label: 'Display code', value: d.display || d.boat, check: (v) => (v ? null : NAME_REQUIRED) }],
    actions: [
      { value: 'save', label: 'Save display code', kind: 'primary' },
      ...(d.display ? [{ value: 'own', label: `Use ${d.boat}` }] : []),
      { label: 'Cancel', close: true },
    ],
  });
  if (!got) return;
  // The item codes' own name for the boat needs no display code to say it.
  const value = got.action === 'own' || got.values.display === d.boat ? null : got.values.display;
  davitEdits.save({
    kind: 'name',
    patches: { [d.boat]: { display: value } },
    what: `${d.display || d.boat} not renamed`,
    said: `Davit line reads "${value ?? d.boat}".`,
  });
}

function toggleDavitHidden(d) {
  const next = !d.sheetHidden;
  davitEdits.save({
    kind: 'hide', patches: { [d.boat]: { sheetHidden: next || null } }, ...hideWords(d.display || d.boat, next),
  });
}

// ---------------------------------------------------------------------------
// the code map as a file
//
// The map used to ship as data/vessel-codes.seed.json, which put the product
// structure of every boat one URL away from anybody — a static site hands its
// files to whoever asks, signed in or not. It moves on a file from the
// manager's own machine now, and never touches the repository or the web
// server.
//
// Download is also the backup. Firestore is the source of truth and there is no
// other copy of a decision somebody made by hand.
// ---------------------------------------------------------------------------

/**
 * What the latest export knows about each item code: its description, and the
 * customer's order number.
 *
 * Best effort. This page is about the code map and works without any of it, so
 * a missing or unreadable import is an empty map rather than an error.
 */
/**
 * The davit reference list, as learned at import from whole export files.
 *
 * Not derived here from the rows to hand: those are the OPEN ones, so a boat
 * would drop off the sheet the moment its last order closed.
 */
async function loadDavits() {
  try {
    const stored = await Store.loadDavits();
    if (stored.length) return stored;
    // NOTHING STORED YET. The list is learned at import, so a board imported
    // before that existed has none — and the section then does not appear at
    // all, which reads as broken rather than empty. Fall back to the rows to
    // hand: less complete, since those are the open ones, but present.
    const cached = Store.cachedRows?.();
    if (cached?.rows?.length) return davitsByBoat(cached.rows);
    const published = await latestBoard();
    return davitsByBoat(published?.rowsJson ? unpackRows(published.rowsJson) : []);
  } catch (e) { console.warn('[davits]', e.message); return []; }
}

async function loadFacts() {
  try {
    // THE ACCUMULATED LIST, not a reading of the rows to hand. Those are the
    // open ones, so a product would drop off the sheet when its last order
    // closed — see `mergeItemFacts`. Falls back to the rows only when nothing
    // has been accumulated yet, so a board imported before this existed still
    // shows something.
    const raw = await Store.loadItemFacts();
    const stored = factsFromStore(raw);
    if (stored.size && !factsAreStale(raw)) return stored;

    const cached = Store.cachedRows?.();
    const published = cached?.rows?.length ? null : await latestBoard();
    const fresh = itemFacts(cached?.rows?.length ? cached.rows
      : (published?.rowsJson ? unpackRows(published.rowsJson) : []));
    if (!stored.size) return fresh;

    // STALE. The accumulated descriptions are still good — they were never in
    // doubt — but hulls read by a rule we have replaced are not shown at all.
    // They come from the rows to hand until the next import rebuilds the list;
    // a product not among those rows falls back to its boat's hull family.
    for (const [inv, f] of stored) f.hulls = fresh.get(inv)?.hulls ?? [];
    for (const [inv, f] of fresh) if (!stored.has(inv)) stored.set(inv, f);
    return stored;
  } catch (e) {
    console.warn('[facts]', e.message);
    return new Map();
  }
}

function downloadCodes() {
  const blob = new Blob([JSON.stringify(codeMap, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = downloadName(today());
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`${count(Object.keys(codeMap).length, 'code')} downloaded.`);
}

// A file that has been chosen: { name, data, fault, loading }, or where it
// could not be read { name, problem }.
let staged = null;

async function stageFile(file) {
  let data = null;
  let problem = null;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    console.warn('[codes file]', e);
    if (!(e instanceof SyntaxError)) problem = 'the file could not be opened. Choose it again.';
  }
  problem ??= fileProblem(data);
  staged = problem
    ? { name: file.name, problem }
    // A backup saved before the model list was renamed loads like a new one.
    : { name: file.name, data: upgradeCodeMap(data).map };
  renderStaged();
  const host = $('codesLoad');
  host.scrollIntoView({ block: 'start', behavior: 'auto' });
  host.querySelector('[tabindex]')?.focus({ preventScroll: true });
}

/** Put the chosen file away, and go back to where it was chosen. */
function unstage() {
  staged = null;
  renderStaged();
  $('loadCodes').focus({ preventScroll: true });
}

/**
 * What loading the chosen file would change, against the codes as they are on
 * the page now.
 *
 * NOTHING IS WRITTEN UNTIL IT IS LOADED, and what changes is spelled out
 * first: this overwrites hand-made decisions, which is the whole point and
 * also the reason to look before doing it.
 */
function renderStaged() {
  const host = $('codesLoad');
  if (staged?.loading) return;               // the button is counting; drawn again when it has finished
  host.hidden = !staged;
  host.textContent = '';
  if (!staged) return;

  const button = (cls, label, act, run) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.dataset.focus = `load:${act}`;
    b.addEventListener('click', run);
    return b;
  };

  if (staged.problem) {
    const line = el('div', 'cx-fault');
    line.setAttribute('role', 'alert');
    line.tabIndex = -1;
    line.append(el('span', null, `${staged.name} not read: ${staged.problem}`),
      button('mini', 'Dismiss', 'dismiss', unstage));
    host.append(line);
    return;
  }

  const { fresh, changed, same } = loadReview(staged.data, codeMap);
  const title = el('h2', null, 'Codes to load');
  title.tabIndex = -1;
  host.append(title);
  host.append(el('div', 'lede', `${staged.name} — ${count(Object.keys(staged.data).length, 'code')}`));

  const grid = el('div', 'import-stats');
  const stat = (n, label, note) => {
    const c = el('div', 'stat');
    c.append(el('b', null, String(n)), el('span', null, label));
    if (note) c.append(el('em', null, note));
    grid.append(c);
  };
  stat(fresh.length, fresh.length === 1 ? 'new code' : 'new codes');
  stat(changed.length, 'changed', changed.length ? 'existing decisions overwritten' : '');
  stat(same.length, 'unchanged');
  host.append(grid);

  const list = (heading, rows) => {
    if (!rows.length) return;
    const table = el('div', 'flag-rows');
    for (const [code, main, detail] of rows) {
      const r = el('div', 'flag-row');
      const cell = el('span', 'fr-main');
      cell.append(main);
      r.append(el('span', 'fr-key', code), cell, el('span', 'fr-detail', detail ?? ''), el('span', 'fr-act', ''));
      table.append(r);
    }
    host.append(el('div', 'detail-group', `${heading} (${rows.length})`), table);
  };
  list('New', fresh.map(({ code, entry }) => [code, entry.display || '—', (entry.items ?? []).join(', ')]));
  list('Changed', changed.map(({ code, changes }) => [code, changeList(changes)]));

  if (staged.fault) {
    const line = el('div', 'cx-fault');
    line.setAttribute('role', 'alert');
    line.append(el('span', null, staged.fault));
    host.append(line);
  }
  const load = [...fresh, ...changed];
  const acts = el('div', 'import-actions');
  const discard = button('ghost', 'Discard file', 'discard', unstage);
  if (load.length) {
    const apply = button('primary', `Load ${count(load.length, 'code')}`, 'apply', () => loadStaged(apply, discard, load));
    acts.append(apply);
  } else host.append(el('div', 'import-clean', 'No changes in this file.'));
  acts.append(discard);
  host.append(acts);
}

/** One line per field: what it was, what it would be. */
function changeList(changes) {
  const list = el('div', 'change-list');
  for (const c of changes) {
    const v = el('span', 'ch-value');
    if (c.from) v.append(el('span', 'ch-from', c.from), el('span', 'ch-arrow', '→'));
    v.append(el('span', 'ch-to', c.to));
    list.append(el('span', 'ch-field', c.field), v);
  }
  return list;
}

/**
 * Save the new and changed codes of the chosen file, a batch at a time (one,
 * for any map this size). What a failure leaves unsaved goes back as it was
 * and stays in the review, to be loaded again.
 */
async function loadStaged(apply, discard, load) {
  if (staged?.loading) return;
  const patches = Object.fromEntries(load.map(({ code, entry }) => [code, entry]));
  const total = load.length;
  staged.loading = true;
  staged.fault = null;
  discard.disabled = true;                   // it cannot be half undone
  $('loadCodes').disabled = true;
  const entry = edits.begin({ kind: 'load', patches });
  redraw();
  let error = null;
  try {
    await busy(apply, `Loading ${count(total, 'code')}…`, (say) => Store.putCodes(patches,
      (saved) => { if (saved < total) say(`Loading ${saved} of ${count(total, 'code')}…`); }));
  } catch (e) { error = e; }
  const saved = error ? error.saved ?? 0 : total;
  edits.end(entry, Object.fromEntries(Object.entries(patches).slice(0, saved)));
  $('loadCodes').disabled = false;
  staged.loading = false;
  if (error) {
    staged.fault = failure(saved
      ? `${saved} of ${count(total, 'code')} loaded, ${total - saved} not loaded` : `${count(total, 'code')} not loaded`, error);
  } else staged = null;
  redraw();
  if (error) document.querySelector('[data-focus="load:apply"]')?.focus();
  else { $('loadCodes').focus({ preventScroll: true }); toast(`${count(total, 'code')} loaded.`); }
}
