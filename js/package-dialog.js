// package-dialog.js — a job's production package: what it is made of, and
// printing it.
//
// The package is kept per item code or per job (packages.js). Folders and
// documents go in by dropping them from File Explorer, or by choosing a
// folder; a folder is searched for its current checklists and drawing set
// each time the dialog opens. Standard items - a lock, say, shared by many
// products - come from the library under Manage library: a category's default,
// or another item of the same group chosen for this package, or none. Which
// documents start ticked is remembered per package. Print puts the ticked
// checklists - from their PDFs, the production number and due date written
// on - and drawing sets into one PDF and opens the print dialog over the
// board. A checklist with no current PDF says so and downloads from Word
// instead, filled in the same way.
//
// WHAT IT STARTS FROM. The packages the board already holds, drawn at once;
// the server's, read behind them, take over (package-changes.js). With neither
// the lists say they are loading and nothing can be changed. A change is on
// screen as it is made and written behind it.
//
// WHERE THINGS ARE SAID. A failure stands where it happened - on the row, in
// the drop zone, beside the button - until that is tried again. The line over
// the bottom buttons is for what belongs to the whole dialog.

import { closeOnBackdrop } from './dialog.js';
import { choose } from './ask.js';
import { busy } from './busy.js';
import { refuse } from './field.js';
import { toast, toastFailed } from './toast.js';
import { failure, count } from './words.js';
import { LIMIT, LOST_FOR, restartStreams } from './boot.js';
import { jobTitle } from './transform.js';
import {
  ROOT_NAME, SCOPE, splitPath, joinPath, parentPath, shortPath, docKind, KIND_LABEL,
  isPdfKind, pickDocuments, packageKey, packageFor, suggestFolders, suggestionBases, filledName,
  printsByDefault, batchTicks, skipFrom, checklistDoc, printsAsPdf, downloadsAsWord, WHY_TEXT,
  ownSources, withSources, skipFor, isEmptyPackage, samePackages, LIBRARY_KEY, NONE, normaliseLibrary, newItemId, groupsOf,
  standardFor, withChoice, withStandardSources, withItem, withoutItem, usesOf, withCategoryDefault,
} from './packages.js';
import {
  packagesKnown, packagesNow, adoptPackages, readPackages, changePackage, unsentFor,
} from './package-changes.js';
import {
  PLINTHS_KEY, isDavit, readCatalogue, sameCatalogue, plinthSources, plinthText, needsDrawing, needsChecklist,
  chosenModel, inheritedModel,
} from './plinths.js';
import {
  supported, rootState, allowRoot, chooseRoot, pathWithin, handleAt, listFiles, listFolders, within,
  droppedHandles,
} from './stella-folder.js';
import {
  fillChecklistDocx, stampChecklistPdf, hasBox, mergePdfs, DOCX_TYPE, jszip, pdflib, pdfjs,
} from './adapters/package-files.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const $ = (sel) => overlay.querySelector(sel);

let overlay = null;
// { id, job, hooks, packages, library, plinths, scope, root, state, load, docs, missing, unread, suggestions, ticks, searching,
//   notes: what failed and where it is said, whole: the same for the dialog, manage: library panel open,
//   pending: dropped items waiting for their name and group }
let ctx = null;
let ids = 0;

/** Documents being prepared to print or download, whichever job they are for. */
let working = false;

/** The packages as the board was last given them. */
let given = null;

/** When the plinth folder was last read on this page; a davit's dialog reads it again after this long. */
let plinthsReadAt = 0;
const PLINTHS_FRESH_MS = 10 * 60 * 1000;

/** The words for where things are waited for or missing. */
const LOADING = 'Loading…';
const SEARCHING = 'Searching…';
const NO_FOLDER = 'Folder not connected';
const NOT_READ = 'Could not be read';
// A source not read in this long is said not to be read, with a Retry, rather
// than searched for good. A real one takes well under a second.
let SOURCE_WITHIN = 20000;
/** For the tests. */
export const _sourceLimit = (ms) => { SOURCE_WITHIN = ms; };

/**
 * @param {Object} job  a board job
 * @param {{packages?: Object, who?: string, onLog?: (desc) => void, onPlinths?: (catalogue) => void,
 *          onPackages?: (packages) => void}} hooks
 *        `packages` is the board's copy of every package, drawn until the server's has been read
 */
export async function openPackageDialog(job, hooks = {}) {
  if (!overlay) build();
  adoptPackages(hooks.packages);
  given = hooks.packages ?? null;
  ctx = { id: ++ids, job, hooks, packages: {}, library: normaliseLibrary(null), plinths: null, scope: SCOPE.item, scopeSet: false,
    root: null, state: supported() ? 'checking' : 'unsupported', load: 'reading', loadWords: '',
    docs: [], missing: new Set(), unread: new Set(), suggestions: [], ticks: new Map(), searching: false, search: 0, searched: '',
    notes: new Map(), whole: null, manage: false, pending: [], saved: false };
  const mine = ctx;
  take();
  $('.lede').textContent = `${job.prod_no} — ${jobTitle(job)}, due ${job.due_display}`;
  $('.pkg-said').textContent = '';
  overlay.classList.add('show');
  render();
  if (mine.state === 'unsupported') return;
  // Fetched now, so the first print does not wait on them.
  jszip().catch(() => {});
  pdflib().catch(() => {});
  pdfjs().catch(() => {});
  const server = load();
  await refreshRoot();
  if (ctx === mine) {
    refreshDocs();
    freshenPlinths();
  }
  await server;
}

/** The packages as they now stand, taken into the dialog: what was loaded, and the changes made here. */
function take() {
  ctx.packages = packagesNow();
  ctx.library = normaliseLibrary(ctx.packages[LIBRARY_KEY]);
  ctx.plinths = ctx.packages[PLINTHS_KEY] ?? null;
  // Where the package is kept, until somebody has said or changed something.
  if (!ctx.scopeSet) ctx.scope = packageFor(ctx.job, ctx.packages).scope;
}

/** Read the packages from the server, behind what is on screen, and draw what it says where that is different. */
async function load() {
  const mine = ctx;
  const known = packagesKnown();
  mine.load = 'reading';
  const late = setTimeout(() => {
    if (mine.load === 'reading') mine.load = 'late';
    render();
  }, LIMIT);
  render();
  try {
    await readPackages();
    mine.load = 'read';
  } catch (e) {
    mine.load = 'failed';
    mine.loadWords = failure(notLoaded(), e);
  } finally {
    clearTimeout(late);
  }
  if (mine.load === 'failed') { render(); return; }
  settled(mine.hooks);
  if (!known) freshenPlinths();
}

/** Draw what the package now is; search again only where its documents come from somewhere else. */
function redo() {
  if (searchKey() !== ctx.searched) { refreshDocs(); return; }
  ctx.docs = ticked(ctx.docs);
  render();
}

/** After the packages changed, here or on the server: the dialog that is open, and the board behind it. */
function settled(hooks) {
  if (ctx) {
    take();
    redo();
  }
  // The board's davit rows read the plinth folder, and any plinth model, from the packages.
  const now = packagesNow();
  if (given && samePackages(given, now)) return;
  const plinthsWere = given?.[PLINTHS_KEY];
  given = now;
  setTimeout(() => {
    if (!samePackages(plinthsWere, now[PLINTHS_KEY])) hooks.onPlinths?.(now[PLINTHS_KEY] ?? null);
    hooks.onPackages?.(now);
  }, 0);
}

/** A davit's dialog reads the plinth folder again now and then, for heights and drawings drafting has added. */
function freshenPlinths() {
  if (ctx && isDavit(ctx.job) && ready() && editable() && Date.now() - plinthsReadAt > PLINTHS_FRESH_MS) readPlinths(ctx.plinths?.path);
}

function close() {
  overlay?.classList.remove('show');
  ctx = null;
}

/** Close, unless something in the library is neither kept nor thrown away. */
async function leave() {
  if (ctx && await mayLose()) close();
}

/**
 * Whether what would go with the dialog, or the library, may go: an item that
 * was dropped and has no name and group yet, or a name that was typed over.
 */
async function mayLose() {
  const mine = ctx;
  const items = mine.pending.map((p) => p.name.trim() || lastOf(p.path));
  const typed = mine.manage
    ? [...overlay.querySelectorAll('.pkg-lib-rows input')].filter((i) => i.value.trim() && i.value.trim() !== i.dataset.was) : [];
  if (!items.length && !typed.length) return true;
  const had = document.activeElement;
  const one = items.length === 1;
  const lose = await choose(typed.length
    ? { title: 'Unsaved changes',
      facts: [...items.map((n) => ['Not added', n]), ...typed.map((i) => [i.dataset.field, `${i.dataset.was} → ${i.value.trim()}`])],
      yes: 'Discard changes', no: 'Keep changes', danger: true }
    : { title: one ? 'Standard item not added' : 'Standard items not added', lede: items.join(', '),
      yes: one ? 'Discard item' : 'Discard items', no: one ? 'Keep item' : 'Keep items', danger: true });
  if (ctx !== mine) return false;
  if (!lose) {
    // Back to what was being typed in, not to whichever button was pressed last.
    if (had?.isConnected && overlay.contains(had)) had.focus();
    return false;
  }
  for (const p of mine.pending) p.row.remove();
  mine.pending = [];
  drawn.delete($('.pkg-lib-rows'));
  return true;
}

/**
 * A drop zone: somewhere to drop a folder or a document, and a button, for
 * the mouse and the keyboard, that chooses a folder instead. What went wrong
 * with a drop stands inside it.
 */
function dropZone(place, cls, title, hint, { dropped, pressed }) {
  const zone = el('div', `drop-zone pkg-drop ${cls}`);
  zone.dataset.place = place;
  zone.dataset.hint = hint;
  const press = el('button', 'pkg-press');
  press.type = 'button';
  press.dataset.focus = `zone:${place}`;
  press.append(el('strong', null, title), el('span', 'hint', hint));
  const note = el('div', 'pkg-zone-note');
  zone.append(press, note);
  zone.addEventListener('dragover', (e) => { e.preventDefault(); if (!zoneOff()) zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const handles = droppedHandles(e);          // inside the event, before anything waits
    handles.then(dropped).catch(() => tell(place, `${NOT_READ}. Drop it again.`));
  });
  zone.addEventListener('click', (e) => { if (!note.contains(e.target) && !zoneOff()) pressed(); });
  return zone;
}

function build() {
  overlay = el('div', 'overlay');
  overlay.id = 'pkgOverlay';
  const box = el('div', 'box wide package');
  box.append(el('h3', null, 'Package'), el('div', 'lede'));

  box.append(el('div', 'pkg-folder'));

  const scope = el('div', 'pkg-section');
  const lab = el('label', 'settings-label', 'For');
  lab.htmlFor = 'pkgScope';
  const sel = el('select', 'pkg-scope');
  sel.id = 'pkgScope';
  sel.addEventListener('change', () => {
    ctx.scope = sel.value;
    ctx.scopeSet = true;
    redo();
  });
  scope.append(lab, sel);
  box.append(scope);

  const src = el('div', 'pkg-section');
  const list = el('div', 'pkg-sources');
  list.dataset.home = 'zone:drop';
  const sug = el('div', 'pkg-suggest');
  sug.dataset.home = 'zone:drop';
  src.append(el('div', 'settings-label', 'Folders and documents'), list);
  src.append(dropZone('drop', 'pkg-src-drop', 'Drop folders or documents here', 'or click to choose a folder',
    { dropped: addHandles, pressed: chooseFolder }), sug);
  box.append(src);

  // Standard items: a row per group in effect, the library behind Manage library.
  const std = el('div', 'pkg-section');
  const stdHead = el('div', 'pkg-head');
  const manage = el('button', 'mini', 'Manage library');
  manage.dataset.act = 'manage';
  manage.dataset.focus = 'manage';
  manage.setAttribute('aria-controls', 'pkgLibrary');
  manage.addEventListener('click', async () => {
    const mine = ctx;
    if (mine.manage && !(await mayLose())) return;
    if (ctx !== mine) return;
    mine.manage = !mine.manage;
    render();
  });
  stdHead.append(el('div', 'settings-label', 'Standard items'), manage);
  const lib = el('div', 'pkg-lib');
  lib.id = 'pkgLibrary';
  const libDrop = dropZone('lib', 'pkg-lib-drop', 'Drop a folder or document here', 'or click to choose a folder',
    { dropped: stageItem, pressed: chooseItemFolder });
  const groups = el('datalist');
  groups.id = 'pkgGroups';
  // The plinth folder, for a davit's: read for the heights its row offers.
  const plinths = el('div', 'pkg-lib-plinths');
  const plinthDrop = dropZone('plinth', 'pkg-plinth-drop', 'Drop the plinth folder here', 'or click to choose it',
    { dropped: setPlinthFolder, pressed: choosePlinthFolder });
  plinths.append(el('div', 'settings-label', 'Plinth folder'), el('div', 'pkg-plinth-at'), plinthDrop);
  const libRows = el('div', 'pkg-lib-rows');
  const fresh = el('div', 'pkg-lib-new');
  for (const n of [libRows, fresh]) n.dataset.home = 'zone:lib';
  lib.append(libRows, libDrop, fresh, el('div', 'pkg-lib-cats'), plinths, groups);
  const stdRows = el('div', 'pkg-std-rows');
  const stdAdd = el('div', 'pkg-std-add');
  for (const n of [stdRows, stdAdd]) n.dataset.home = 'manage';
  std.append(stdHead, stdRows, stdAdd, lib);
  box.append(std);

  const docs = el('div', 'pkg-section');
  const head = el('div', 'pkg-head');
  const keep = el('button', 'mini', 'Save as default');
  keep.dataset.act = 'defaults';
  keep.dataset.focus = 'defaults';
  keep.addEventListener('click', saveDefaults);
  head.append(el('div', 'settings-label', 'Documents'), keep, el('div', 'pkg-defaults-note'));
  const found = el('div', 'pkg-docs');
  for (const n of [head, found]) n.dataset.home = 'print';
  docs.append(head, found);
  box.append(docs);

  const whole = el('div', 'form-err pkg-whole');
  whole.setAttribute('role', 'alert');
  box.append(whole);
  // What has just gone wrong on a row or in a drop zone, for a screen reader: the row itself is drawn again and again.
  const said = el('div', 'sr-only pkg-said');
  said.setAttribute('role', 'status');
  box.append(said);
  const acts = el('div', 'actions');
  const button = (cls, text, act) => {
    const b = el('button', cls, text);
    b.dataset.act = act;
    acts.append(b);
    return b;
  };
  const print = button('ghost', 'Print package', 'print');
  print.dataset.focus = 'print';
  print.setAttribute('aria-describedby', 'pkgReason');
  print.addEventListener('click', printPackage);
  const reason = el('span', 'pkg-reason');
  reason.id = 'pkgReason';
  acts.append(reason);
  button('ghost', 'Download Word', 'download').addEventListener('click', downloadWord);
  button('ghost', 'Change folder', 'folder').addEventListener('click', () => connect(true, 'whole'));
  button('ghost', 'Close', 'close').addEventListener('click', leave);
  box.append(acts);

  overlay.append(box);
  // A drop that misses its zone is refused: the browser would leave the board to open it.
  overlay.addEventListener('dragover', (e) => {
    if (e.target.closest('.pkg-drop')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  });
  overlay.addEventListener('drop', (e) => e.preventDefault());
  document.body.append(overlay);
  closeOnBackdrop(overlay, leave);
  // What is said while nothing has been loaded depends on the connection.
  for (const type of ['online', 'offline']) window.addEventListener(type, render);
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const ready = () => ctx?.state === 'granted' && ctx.root;
/** Loaded, and the server has not refused to say what it has. */
const editable = () => packagesKnown() && ctx.load !== 'failed';
const notLoaded = () => (packagesKnown() ? 'Latest packages not loaded' : 'Packages not loaded');
const currentKey = () => packageKey(ctx.scope, ctx.job);
/** The package's own folders and documents. */
const sources = () => ctx.packages[currentKey()]?.sources ?? [];
/** The ones its documents come from: a job's code's, where the job has none of its own. */
const shownSources = () => ownSources(ctx.job, ctx.packages, ctx.scope);
const standardRows = () => standardFor(ctx.job, ctx.packages, ctx.library, ctx.scope);
const itemById = (id) => ctx.library.items.find((i) => i.id === id);
const lastOf = (path) => splitPath(path).at(-1);

/** Everything the documents come from: the package's own, its standard items, a davit's plinth. */
function wantedSources() {
  const all = withStandardSources(shownSources(), standardRows(), ctx.library);
  if (isDavit(ctx.job)) {
    for (const s of plinthSources(ctx.plinths, ctx.job.plinth)) if (!all.some((o) => o.path === s.path)) all.push(s);
  }
  return all;
}

/** What a search is for: searched again only when it changes. */
const searchKey = () => JSON.stringify(wantedSources()
  .map((s) => [s.kind, s.path, s.standard ?? '', itemById(s.standard)?.name ?? '', s.plinth ?? false]));

/**
 * Say something where it happened. It stands there until that is tried again.
 * @param {string} place  a drop zone, or a row: 'src:<path>', 'std:<group>', 'lib:<id>'...
 * @param {() => void} [retry]
 */
function tell(place, words, retry = null) {
  if (!ctx) return;
  if (place === 'whole') ctx.whole = { words, retry };
  else {
    ctx.notes.set(place, { words, retry });
    $('.pkg-said').textContent = words;
  }
  render();
}

function quiet(place) {
  if (place === 'whole') ctx.whole = null; else ctx.notes.delete(place);
}

/** What stands at a place, as words; and as a line, with its Retry. */
const noteOf = (place) => ctx.notes.get(place)?.words ?? '';
function noteAt(place) {
  const n = ctx.notes.get(place);
  return n ? errLine(n.words, `retry:${place}`, n.retry ? () => ctx?.notes.get(place)?.retry?.() : null) : null;
}

function errLine(words, key, retry) {
  const line = el('div', 'pkg-err');
  line.append(el('span', null, words));
  if (retry) line.append(mini('Retry', key, retry));
  return line;
}

/** Why nothing can be changed just now, said where it was tried; false when it can. */
function barred(place, done) {
  const why = !editable() ? notLoaded() : working ? 'Documents being prepared' : '';
  if (why) tell(place, `Not ${done}: ${why[0].toLowerCase()}${why.slice(1)}.`);
  return Boolean(why);
}

async function refreshRoot() {
  const mine = ctx;
  if (!mine || mine.state === 'unsupported') return;
  const { handle, state } = await rootState();
  mine.root = handle;
  mine.state = state;
}

/** Search every source again, and the suggestions with them. */
async function refreshDocs() {
  if (!ctx) return;
  const mine = ctx;
  const run = ++mine.search;
  mine.searching = false;
  if (!packagesKnown() || !ready()) {
    mine.searched = '';
    if (mine.state !== 'checking') mine.docs = [];
    render();
    return;
  }
  const wanted = wantedSources();
  mine.searched = searchKey();
  // What is not asked for any more goes at once; the rest stays up until the search replaces it.
  mine.docs = ticked(mine.docs.filter((d) => wanted.some((s) => s.path === d.from)));
  mine.searching = wanted.length > 0;
  render();
  if (!shownSources().length) {
    findSuggestions(mine.root).catch(() => []).then((found) => {
      if (ctx !== mine || mine.search !== run) return;
      mine.suggestions = found;
      render();
    });
  }
  const results = await Promise.all(wanted.map((s) => readSource(mine.root, s)));
  if (ctx !== mine || mine.search !== run) return;         // the dialog moved on while this ran
  mine.searching = false;
  if (results.some((r) => r.denied)) mine.state = 'prompt';
  mine.missing = new Set(wanted.filter((s, i) => results[i].missing).map((s) => s.path));
  mine.unread = new Set(wanted.filter((s, i) => results[i].unread).map((s) => s.path));
  mine.docs = ticked(results.flatMap((r) => r.docs));
  render();
  lookForBoxes();
}

/** One source's documents; or that it has gone, could not be read, or that the browser wants to ask about the folder again. */
function readSource(root, s) {
  return within(readSourceNow(root, s), SOURCE_WITHIN, { docs: [], unread: true }, `reading ${s.path}`);
}

async function readSourceNow(root, s) {
  // A standard item's documents say which item they are, the plinth's that they are its; the rest, where they are.
  const item = s.standard ? itemById(s.standard)?.name : s.plinth ? 'Plinth' : null;
  try {
    const h = await handleAt(root, s.path, s.kind);
    if (s.kind !== 'folder') {
      return { docs: [{ ...await fileDoc(root, h, s.path), path: s.path, from: s.path, where: item ?? shortPath(parentPath(s.path), 2) }] };
    }
    return { docs: pickDocuments(await listFiles(h)).map((f) => ({
      ...f, path: joinPath([...splitPath(s.path), ...f.dirs, f.key ?? f.name]), from: s.path,
      where: item ?? shortPath(joinPath([...splitPath(s.path), ...f.dirs]), 3) })) };
  } catch (e) {
    if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return { docs: [], missing: true };
    if (e.name === 'NotAllowedError') return { docs: [], denied: true };
    console.warn('[package] a folder or document could not be read', e);
    return { docs: [], unread: true };
  }
}

/** The documents found, each once, checklists first, ticked as the package starts them - or as they have been ticked since. */
function ticked(docs) {
  const seen = new Set();
  const skip = skipFor(ctx.job, ctx.packages, ctx.scope);
  const found = docs.filter((d) => d.kind && !seen.has(d.path) && seen.add(d.path))
    .sort((a, b) => Number(isPdfKind(a.kind)) - Number(isPdfKind(b.kind)));
  // A checklist that comes plain and for a batch: the job's quantity picks.
  const batch = batchTicks(found, ctx.job.qty);
  return found.map((d) => {
    const on = batch.has(d.path) ? batch.get(d.path) : printsByDefault(d.path, d.lastModified, skip);
    return { ...d, checked: ctx.ticks.get(d.path) ?? on, defaultOn: on, byQty: batch.has(d.path) };
  });
}

/**
 * A document dropped in on its own. A checklist is looked for in both forms
 * beside it - its PDF next to the Word file, or the other way round - so a
 * dropped checklist prints from its PDF the same as one found in a folder.
 */
async function fileDoc(root, handle, path) {
  const f = await handle.getFile();
  const kind = docKind(f.name);
  const own = { name: f.name, dirs: [], lastModified: f.lastModified, handle };
  if (kind !== 'checklist' && kind !== 'checklistPdf') return { ...own, kind };
  const twin = f.name.replace(/\.(docx|pdf)$/i, kind === 'checklist' ? '.pdf' : '.docx');
  let other = null;
  try {
    const h = await (await handleAt(root, parentPath(path), 'folder')).getFileHandle(twin);
    const g = await h.getFile();
    other = { name: g.name, dirs: [], lastModified: g.lastModified, handle: h };
  } catch { /* no twin: the one there is */ }
  return kind === 'checklist' ? checklistDoc(own, other) : checklistDoc(other, own);
}

/** Folders beside the ones other packages of this job's product line use, that look like this job's. */
async function findSuggestions(root) {
  const { job } = ctx;
  const exclude = sources().map((s) => s.path);
  const parents = suggestionBases(job, ctx.packages).slice(0, 12);
  const candidates = await Promise.all(parents.map(async (parent) => {
    try {
      const h = await handleAt(root, parent, 'folder');
      return (await listFolders(h)).map((name) => ({ name, path: joinPath([...splitPath(parent), name]) }));
    } catch { return []; /* a folder that has gone suggests nothing */ }
  }));
  return suggestFolders(job, candidates.flat(), { exclude });
}

// Whether a checklist has the box for the production number, per file as it
// was saved. Looked for once everything else is on screen, one at a time, so
// the row says so before it is printed rather than after.
const boxes = new Map();
const boxKey = (d) => `${d.path}|${d.lastModified}`;
let looking = false;

async function lookForBoxes() {
  if (looking) return;
  looking = true;
  try {
    for (;;) {
      const d = ctx && !working && !ctx.searching
        ? ctx.docs.find((x) => x.kind === 'checklist' && x.checked && !boxes.has(boxKey(x))) : null;
      if (!d) return;
      let has = null;
      try {
        has = await hasBox(await (await d.handle.getFile()).arrayBuffer(), d.use);
      } catch (e) {
        if (e.library) return;                  // the reader did not load; printing says so
      }
      boxes.set(boxKey(d), has);                // null when it could not be read: printing says that too
      if (has === false) render();
    }
  } finally {
    looking = false;
  }
}

// ---------------------------------------------------------------------------
// changing the package
// ---------------------------------------------------------------------------

/**
 * Make a change: on screen at once, written behind it. A refused one is taken
 * back, and says why at `place`, with a Retry - or in passing, when the dialog
 * it was made in has gone.
 * @param {{key: string, apply: Function, place: string, failed: string, note?: string|null,
 *          back?: () => void, again?: () => void, silent?: boolean}} c
 *        `failed` is what was then not done, `note` the activity log's line, `back` what
 *        else to put back, `again` what Retry does if not the same change; `silent` for a
 *        change nobody asked for
 * @returns {true}  it is made: nothing waits for the server
 */
function edit(c) {
  const mine = ctx;
  const { hooks } = mine;
  if (!c.silent) {
    quiet(c.place);
    mine.scopeSet = true;
  }
  const written = changePackage(c.key, c.apply);
  // Not inside the event: a field that is being left hands the focus on first.
  setTimeout(() => settled(hooks), 0);
  setTimeout(render, LOST_FOR + 100);           // by when it should have been taken
  written.then(() => {
    if (c.note) hooks.onLog?.({ action: 'package', text: c.note });
  }, (e) => {
    drawn = new WeakMap();                      // whatever is on screen ahead of it goes back
    if (c.silent) { console.warn('[package] not saved', e); return; }
    const words = failure(c.failed, e);
    if (ctx !== mine) { toastFailed(words); return; }
    c.back?.();
    mine.notes.set(c.place, { words, retry: c.again ?? (() => edit(c)) });
    $('.pkg-said').textContent = words;
  }).then(() => settled(hooks));
  return true;
}

/**
 * A change to the package: its sources and anything else it keeps (the print
 * defaults, the standard items) as they are, but for what `fn` gives. A
 * package left with nothing in it is removed.
 */
function editPackage(fn, rest) {
  const { job, scope, hooks } = ctx;
  return edit({ ...rest, key: packageKey(scope, job), apply: (cur, all) => {
    const data = {
      ...(cur ?? {}),
      scope,
      inventoryId: job.inventory_id ?? null,
      prodNo: scope === SCOPE.job ? job.prod_no : null,
      sources: cur?.sources ?? [],
      updatedBy: hooks.who ?? null,
      ...fn(cur, all),
    };
    return isEmptyPackage(data) ? null : data;
  } });
}

/** Where a dropped folder or document is in Stella Systems, or in words why it cannot go in. */
async function placeOf(root, h) {
  let path;
  try { path = await pathWithin(root, h); } catch { return { words: `"${h.name}" could not be read.` }; }
  if (path === null) return { words: `"${h.name}" is not inside the ${ROOT_NAME} folder.` };
  if (path === '') return { words: `Drop a folder inside ${ROOT_NAME}, not ${ROOT_NAME} itself.` };
  const kind = h.kind === 'directory' ? 'folder' : 'file';
  if (kind === 'file' && !docKind(h.name)) return { words: 'Only Word documents and PDFs go in a package.' };
  return { kind, path };
}

/**
 * What was dropped, as places in Stella Systems, and in words what was not
 * taken. `has` says, in words, that a path is there already.
 */
async function placesOf(handles, has) {
  const { root } = ctx;
  const places = [];
  const words = [];
  for (const h of handles) {
    const place = h ? await placeOf(root, h) : { words: 'Only Word documents and PDFs go in a package.' };
    const there = place.words ?? has(place.path, h.name) ?? (places.some((p) => p.path === place.path) ? '' : null);
    if (there === null) places.push({ ...place, name: h.name });
    else if (there && !words.includes(there)) words.push(there);
  }
  if (!handles.length) words.push('Only Word documents and PDFs go in a package.');
  return { places, words: words.join(' ') };
}

/** Whether something cannot be added here just now, said where it was dropped. */
function cannotAdd(place) {
  quiet(place);
  if (barred(place, 'added')) return true;
  if (ready()) return false;
  tell(place, `Connect the ${ROOT_NAME} folder first.`);
  return true;
}

async function addHandles(handles) {
  if (!ctx || cannotAdd('drop')) return;
  const mine = ctx;
  const { places, words } = await placesOf(handles,
    (path, name) => (shownSources().some((s) => s.path === path) ? `"${name}" is already in this package.` : null));
  if (ctx !== mine) return;
  if (places.length) addSources(places, 'drop');
  if (words) tell('drop', words);
}

/** Put folders and documents in. A job adding to the folders it has from its code starts its own list from them. */
function addSources(places, place) {
  const { job, scope } = ctx;
  const names = places.map((p) => lastOf(p.path)).join(', ');
  const add = places.map(({ kind, path }) => ({ kind, path }));
  editPackage((cur, all) => ({ sources: withSources(ownSources(job, all, scope), add) }),
    { place, failed: `${names} not added`, note: `package: added ${names}` });
}

/** The browser's own folder picker. Null when it was closed without a choice, or did not open, which is then said. */
async function pickFolder(id, place) {
  try {
    return await window.showDirectoryPicker({ id, startIn: ctx.root, mode: 'read' });
  } catch (e) {
    if (e.name !== 'AbortError') tell(place, 'The folder picker did not open. Retry.');
    return null;
  }
}

async function chooseFolder() {
  if (cannotAdd('drop')) return;
  const h = await pickFolder('stella-package', 'drop');
  if (h) await addHandles([h]);
}

function removeSource(path) {
  const place = `src:${path}`;
  if (barred(place, 'removed')) return;
  editPackage((cur) => ({ sources: (cur?.sources ?? []).filter((s) => s.path !== path) }),
    { place, failed: `${lastOf(path)} not removed`, note: `package: removed ${lastOf(path)}` });
}

/** This package's plinth model: a model folder's name, or '' for the default. */
function setPlinthModel(value) {
  if (!ctx || barred('plinth:model', 'changed')) return false;
  return editPackage(() => ({ plinthModel: value || null }), { place: 'plinth:model', failed: 'Plinth model not changed',
    note: `package: plinth model ${value ? `set to ${value}` : 'back to the default'}` });
}

/** This package's choice for a group: an item id, NONE to leave it out, '' for the default. */
function setStandard(group, value, { place = `std:${group}`, failed = `${group} not changed` } = {}) {
  if (!ctx || barred(place, 'changed')) return false;
  const what = value === NONE ? 'left out' : value ? `set to ${itemById(value)?.name ?? value}` : 'back to the default';
  return editPackage((cur) => ({ standard: withChoice(cur?.standard, group, value) }),
    { place, failed, note: `package: ${group} ${what}` });
}

// ---------------------------------------------------------------------------
// the standard items library
// ---------------------------------------------------------------------------

/** @param {(library) => Object} change  a change to the library, whichever copy of it */
function editLibrary(change, rest) {
  const { hooks } = ctx;
  return edit({ ...rest, key: LIBRARY_KEY,
    apply: (cur) => ({ ...change(normaliseLibrary(cur)), updatedBy: hooks.who ?? null }) });
}

/** Folders and documents dropped to become standard items, each named and grouped before it goes in. */
async function stageItem(handles) {
  if (!ctx || cannotAdd('lib')) return;
  const mine = ctx;
  const { places, words } = await placesOf(handles, (path, name) => {
    const it = ctx.library.items.find((i) => i.path === path);
    if (it) return `"${name}" is already in the library, as ${it.name} (${it.group}).`;
    return ctx.pending.some((p) => p.path === path) ? `"${name}" is already waiting to be added.` : null;
  });
  if (ctx !== mine) return;
  for (const p of places) {
    mine.pending.push(pendingItem({ id: newItemId(), kind: p.kind, path: p.path, name: p.name.replace(/\.(docx|pdf)$/i, ''), group: '' }));
  }
  if (words) tell('lib', words); else render();
  if (places.length) mine.pending.at(-places.length).nameInput.focus();
}

async function chooseItemFolder() {
  if (cannotAdd('lib')) return;
  const h = await pickFolder('stella-standard', 'lib');
  if (h) await stageItem([h]);
}

function addItem(p) {
  if (!ctx || !ctx.pending.includes(p)) return;
  const place = `new:${p.id}`;
  for (const [input, words] of [[p.nameInput, 'Name required'], [p.groupInput, 'Group required']]) {
    if (!input.value.trim()) { refuse(input, words); return; }
  }
  if (barred(place, 'added')) return;
  const mine = ctx;
  const item = { id: p.id, name: p.nameInput.value.trim(), group: p.groupInput.value.trim(), kind: p.kind, path: p.path };
  mine.pending = mine.pending.filter((x) => x !== p);
  editLibrary((lib) => withItem(lib, item), { place, failed: `${item.name} not added`,
    note: `package: standard item ${item.name} (${item.group}) added`,
    // Back as it was, its name and group still on it, and Add to library to try again.
    back: () => { if (!mine.pending.includes(p)) mine.pending = [...mine.pending, p]; } });
}

/** A library item taken out of it, for every package; asked first, with where it is used. */
async function removeItem(id) {
  const it = itemById(id);
  const place = `lib:${id}`;
  if (!it || barred(place, 'removed')) return;
  const mine = ctx;
  const uses = usesOf(id, ctx.packages, ctx.library);
  const facts = [['Chosen in', count(uses.packages, 'package')]];
  if (uses.categories.length) facts.push(['Default for', uses.categories.join(', ')]);
  const sure = await choose({ title: 'Standard item removal', lede: `${it.name} (${it.group})`, facts,
    yes: 'Remove from library', no: 'Keep item', danger: true });
  if (!sure || ctx !== mine || barred(place, 'removed')) return;
  editLibrary((lib) => withoutItem(lib, id), { place, failed: `${it.name} not removed`, note: `package: standard item ${it.name} removed` });
}

// ---------------------------------------------------------------------------
// the plinth folder
// ---------------------------------------------------------------------------

/**
 * Read the plinth folder at `path`, and keep what it holds if that has
 * changed: a new height or drawing shows in the davits' rows. Quiet when it
 * runs by itself; `asked` when a manager dropped the folder or pressed Read again.
 */
async function readPlinths(path, { asked = false } = {}) {
  if (!ctx || !path || !ready()) return;
  const mine = ctx;
  const root = ctx.root;
  if (asked) quiet('plinth');
  let found;
  try {
    found = await readCatalogue(path, {
      folders: async (p) => listFolders(await handleAt(root, p, 'folder')),
      files: async (p) => listFiles(await handleAt(root, p, 'folder'), { maxDepth: 4 }),
    });
  } catch (e) {
    console.warn('[package] the plinth folder could not be read', e);
    if (asked && ctx === mine) tell('plinth', `${lastOf(path)} could not be read.`, () => readPlinths(path, { asked }));
    return;
  }
  plinthsReadAt = Date.now();
  if (ctx !== mine) return;
  const heights = found.models.reduce((n, m) => n + m.heights.length, 0);
  if (!heights) {
    if (asked) tell('plinth', `No plinth heights found in ${lastOf(path)}.`);
    return;
  }
  if (!sameCatalogue(found, ctx.plinths) && editable()) {
    const data = { ...found, readAt: new Date().toISOString(), updatedBy: ctx.hooks.who ?? null };
    edit({ key: PLINTHS_KEY, apply: () => data, place: 'plinth', failed: 'Plinth folder not saved', silent: !asked,
      note: asked ? `plinth folder read: ${lastOf(path)}` : null });
  }
  if (asked) toast(`Plinth folder read: ${count(heights, 'height')}.`);
}

async function setPlinthFolder(handles) {
  if (!ctx || cannotAdd('plinth')) return;
  const mine = ctx;
  const { places, words } = await placesOf(handles, () => null);
  if (ctx !== mine) return;
  const place = places[0];
  if (!place) { tell('plinth', words); return; }
  if (place.kind !== 'folder') { tell('plinth', 'Drop the plinth folder itself, not a file in it.'); return; }
  await readPlinths(place.path, { asked: true });
}

async function choosePlinthFolder() {
  if (cannotAdd('plinth')) return;
  const h = await pickFolder('stella-plinths', 'plinth');
  if (h) await setPlinthFolder([h]);
}

/** A library item's name or group, changed where it is listed. */
function renameItem(id, field, input) {
  const it = itemById(id);
  if (!it) return;
  const label = field === 'name' ? 'Name' : 'Group';
  const place = `lib:${id}`;
  const v = input.value.trim();
  if (v === it[field]) { input.value = v; return; }
  if (!v) {
    input.value = it[field];
    refuse(input, `${label} required`, { focus: false });
    return;
  }
  if (barred(place, 'changed')) { input.value = it[field]; return; }
  editLibrary((lib) => withItem(lib, { ...(lib.items.find((i) => i.id === id) ?? it), [field]: v }),
    { place, failed: `${label} of ${it.name} not changed`,
      note: `package: standard item ${it.name} ${field === 'name' ? 'renamed' : 'moved to group'} ${v}` });
}

/** The ticks as they stand become the ones every job on this package starts with. */
function saveDefaults() {
  if (!ctx || ctx.saved || barred('defaults', 'saved')) return;
  const mine = ctx;
  const { docs } = mine;
  const skip = skipFrom(docs);
  // A folder that could not be searched this time keeps what it was told before.
  const unseen = [...mine.missing, ...mine.unread];
  const kept = (cur) => (cur?.skip ?? []).filter((s) => unseen.some((p) => s.path === p || s.path.startsWith(`${p}/`)));
  const btn = overlay.querySelector('[data-act="defaults"]');
  btn.style.minWidth = `${Math.ceil(btn.getBoundingClientRect().width)}px`;
  const shown = (on) => {
    clearTimeout(mine.savedTimer);
    mine.saved = on;
    if (on) mine.savedTimer = setTimeout(() => { mine.saved = false; render(); }, 1600);
  };
  shown(true);
  $('.pkg-said').textContent = 'Saved';
  editPackage((cur) => ({ skip: [...skip, ...kept(cur)] }), { place: 'defaults', failed: 'Default not saved',
    note: skip.length
      ? `package: ${skip.map((s) => lastOf(s.path)).join(', ')} unticked by default`
      : 'package: everything ticked by default',
    back: () => shown(false), again: saveDefaults });
}

/** Point this PC at Stella Systems, or ask again for the folder it knows. */
async function connect(fresh, place) {
  const mine = ctx;
  quiet(place);
  try {
    if (!fresh && mine.root && mine.state === 'prompt') {
      if (!(await allowRoot(mine.root))) tell(place, `${NO_FOLDER}: permission not given.`);
    } else await chooseRoot();
  } catch (e) {
    if (e.name !== 'AbortError') tell(place, e.words ?? `${NO_FOLDER}: the folder picker did not open. Retry.`);
  }
  if (ctx !== mine) return;
  await refreshRoot();
  if (ctx !== mine) return;
  refreshDocs();
  freshenPlinths();
}

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

/** The ticked documents that pass a test. */
const picked = (test) => (ctx?.docs ?? []).filter((d) => d.checked && test(d));

const preparing = (n, of) => `Preparing ${n} of ${of}…`;

/**
 * Prepare documents one after another behind a button that counts them. One
 * that cannot be read is named on its row and left out; a reader that did not
 * load stops the lot.
 * @param {(d) => Promise<any>} each  what one document becomes
 * @param {(made: Array<{d, out}>, leaveOut: (d, e) => void, any: () => boolean) => Promise<void>} finish
 *        all of them; `any`: whether one is left to go on with
 * @returns {Promise<{done: number, left: number}|null>}  null when it stopped
 */
async function prepare(act, list, failed, again, each, finish) {
  const mine = ctx;
  const left = new Set();
  quiet('whole');
  for (const d of list) quiet(`doc:${d.path}`);
  const leaveOut = (d, e) => {
    if (e?.library) throw e;
    console.warn('[package] a document could not be read', e);
    left.add(d);
    if (e?.name === 'NotAllowedError') refreshRoot().then(render);
    if (ctx !== mine) return;
    tell(`doc:${d.path}`, e?.name === 'NotFoundError' ? 'No longer in its folder' : NOT_READ);
  };
  working = true;
  render();
  try {
    await busy(overlay.querySelector(`[data-act="${act}"]`), preparing(1, list.length), async (say) => {
      const made = [];
      for (const [i, d] of list.entries()) {
        say(preparing(i + 1, list.length));
        try { made.push({ d, out: await each(d) }); } catch (e) { leaveOut(d, e); }
      }
      await finish(made, leaveOut, () => left.size < list.length);
    });
  } catch (e) {
    const words = e?.words ? `${failed}: ${e.words}` : failure(failed, e);
    if (ctx === mine) tell('whole', words, again); else toastFailed(words);
    return null;
  } finally {
    working = false;
    render();
    lookForBoxes();
  }
  return { done: list.length - left.size, left: left.size };
}

/**
 * Everything ticked that is a PDF, as one PDF to print: checklists first,
 * each with the production number and due date written on, then drawings.
 */
async function printPackage() {
  const list = picked(printsAsPdf);
  if (!list.length || working) return;
  const mine = ctx;
  const { job } = mine;
  const title = `${job.prod_no} package`;
  const got = await prepare('print', list, 'Package not printed', printPackage, async (d) => {
    const bytes = await (await d.handle.getFile()).arrayBuffer();
    if (d.kind !== 'checklist') return bytes;
    const out = await stampChecklistPdf(bytes, { prodNo: job.prod_no, due: job.due_display });
    boxes.set(boxKey(d), out.filled > 0);
    return out.bytes;
  }, async (made, leaveOut, any) => {
    let pdf = null;
    if (made.length === 1) pdf = new Uint8Array(made[0].out);
    else if (made.length) pdf = await mergePdfs(made.map((m) => m.out), { title, leftOut: (i, e) => leaveOut(made[i].d, e) });
    if (!any()) return;
    try { await printPdf(pdf); } catch (e) {
      // The page could not print it: the PDF itself instead, to print from there.
      console.warn('[package] the print dialog did not open', e);
      const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
      download(url, `${title}.pdf`);
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      const words = `The print dialog did not open. Saved as ${title}.pdf to print.`;
      if (ctx === mine) tell('whole', words); else toast(words, 5000);
    }
  });
  if (got && !got.done) {
    if (ctx === mine) tell('whole', 'Package not printed: no document could be read.', printPackage);
    else toastFailed('Package not printed: no document could be read.');
  } else if (got?.left) toastFailed(`${got.done} of ${list.length} prepared; ${got.left} could not be read.`);
}

let printFrame = null;

/**
 * Print a PDF from an unseen frame in this page, so the print dialog opens
 * over the board. A new tab for it put the board in the background, where
 * the browser slows it down, and showed a blank page meanwhile.
 */
function printPdf(bytes) {
  if (printFrame) { URL.revokeObjectURL(printFrame.src); printFrame.remove(); }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const frame = el('iframe', 'print-frame');
  // Drawn but never seen, so out of reach of the keyboard and screen readers.
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  printFrame = frame;
  return new Promise((resolve, reject) => {
    const late = setTimeout(() => reject(new Error('The PDF did not load to print.')), 20000);
    frame.addEventListener('load', () => {
      // A moment for the PDF viewer inside the frame to take the document.
      setTimeout(() => {
        clearTimeout(late);
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
          resolve();
        } catch (e) { reject(e); }
      }, 250);
    }, { once: true });
    frame.src = url;
    document.body.append(frame);
  });
}

/** The ticked checklists that fall back to Word, filled in, to print from Word. */
async function downloadWord() {
  const list = picked(downloadsAsWord);
  if (!list.length || working) return;
  const mine = ctx;
  const { job } = mine;
  const got = await prepare('download', list, 'Word documents not downloaded', downloadWord, async (d) => {
    const bytes = await (await d.handle.getFile()).arrayBuffer();
    const out = await fillChecklistDocx(bytes, { prodNo: job.prod_no, due: job.due_display });
    boxes.set(boxKey(d), out.filled > 0);
    const url = URL.createObjectURL(new Blob([out.bytes], { type: DOCX_TYPE }));
    download(url, filledName(job.prod_no, d.name));
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    await new Promise((r) => setTimeout(r, 400));     // one at a time, or the browser drops some
  }, async () => {});
  if (!got) return;
  if (!got.left) toast(`${count(got.done, 'Word document')} downloaded.`);
  else toastFailed(`${got.done} of ${list.length} downloaded; ${got.left} could not be read.`);
}

function download(url, name) {
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

const fmtDate = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

const option = (parent, value, text) => {
  const o = el('option', null, text);
  o.value = value;
  parent.append(o);
  return o;
};

/** A field of the library, wrapped so a refusal's words stand under it. */
const textInput = (key, value, label, name) => {
  const i = el('input');
  i.type = 'text';
  i.value = value;
  i.placeholder = label;
  i.dataset.focus = key;
  i.dataset.was = value;
  i.dataset.field = label;
  i.setAttribute('aria-label', name ? `${label} of ${name}` : label);
  return i;
};
const field = (input) => {
  const wrap = el('span', 'pkg-field');
  wrap.append(input);
  return wrap;
};

function mini(text, key, run, label) {
  const b = el('button', 'mini', text);
  b.type = 'button';
  b.dataset.focus = key;
  if (label) b.setAttribute('aria-label', label);
  b.addEventListener('click', run);
  return b;
}

/** A path's end, which is the part anybody recognises; all of it where there is no pointer to rest on it. */
function pathCell(path) {
  const n = el('span', 'pkg-path');
  n.title = path;
  n.append(el('span', 'is-short', shortPath(path, 3)), el('span', 'is-full', splitPath(path).join(' › ')));
  return n;
}

/** Draw the dialog again, without losing the field being typed in or the control that has the focus. */
function render() {
  if (!overlay || !ctx) return;
  const f = document.activeElement;
  const key = overlay.contains(f) ? f.dataset.focus : null;
  const home = key ? f.closest('[data-home]')?.dataset.home : null;
  const typed = key && f.matches('input[type=text]') ? { value: f.value, start: f.selectionStart, end: f.selectionEnd } : null;
  draw();
  if (!key || (f.isConnected && f.getClientRects().length)) return;
  const at = (k) => [...overlay.querySelectorAll(`[data-focus="${CSS.escape(k)}"]`)].find((n) => n.getClientRects().length && !n.disabled);
  const g = at(key) ?? (home ? at(home) : null);
  if (!g) return;
  if (typed && g.dataset.focus === key) {
    g.value = typed.value;
    g.setSelectionRange(typed.start, typed.end);
  }
  g.focus({ preventScroll: true });
}

// What each part of the dialog was last drawn from. It is drawn again only
// when that has changed, so a list that is open and a field being typed in
// stay as they are while a search or the server finishes behind them.
let drawn = new WeakMap();

function part(node, from, make) {
  const now = JSON.stringify([ctx.id, from]);
  if (drawn.get(node) === now) return;
  drawn.set(node, now);
  node.replaceChildren(...make().filter(Boolean));
}

/** What a list says while there is nothing yet to list from. */
const notYet = () => (packagesKnown() ? null : ctx.load === 'failed' ? 'Not loaded' : LOADING);

/** Why nothing can be dropped in, in words; null when something can. */
function zoneOff() {
  if (!ctx) return NO_FOLDER;
  return notYet() ?? (!editable() ? notLoaded() : ctx.state !== 'checking' && !ready() ? NO_FOLDER : null);
}

function draw() {
  const { job } = ctx;
  const off = !editable();

  // Where there is no folder to connect, that and nothing else.
  const unsupported = ctx.state === 'unsupported';
  for (const n of overlay.querySelectorAll('.pkg-section, .pkg-whole, .pkg-reason')) n.hidden = unsupported;

  // The folder: nothing to show once it is ready.
  part($('.pkg-folder'), [ctx.state, noteOf('folder')], () => {
    if (unsupported) return [el('div', 'form-err', 'Packages need Edge or Chrome.')];
    if (ctx.state === 'checking' || ready()) return [noteAt('folder')];
    const b = el('button', 'primary', ctx.state === 'prompt' ? `Allow ${ROOT_NAME} folder` : `Connect ${ROOT_NAME} folder`);
    b.dataset.focus = 'connect';
    b.addEventListener('click', () => connect(ctx.state !== 'prompt', 'folder'));
    return [b, noteAt('folder')];
  });

  const sel = $('.pkg-scope');
  part(sel, ctx.scope, () => [[SCOPE.item, `Every job on ${job.inventory_id}`], [SCOPE.job, `This job only (${job.prod_no})`]]
    .map(([value, text]) => {
      const o = el('option', null, text);
      o.value = value;
      o.selected = value === ctx.scope;
      return o;
    }));
  sel.value = ctx.scope;
  sel.disabled = !packagesKnown();

  // A job with none of its own lists its code's, which are removed from there.
  const own = sources().length > 0;
  const shown = shownSources();
  part($('.pkg-sources'), [notYet(), own, off, shown.map((s) => [s, ctx.missing.has(s.path), ctx.unread.has(s.path), noteOf(`src:${s.path}`)])], () => {
    if (notYet()) return [el('div', 'pkg-none', notYet())];
    return shown.map((s) => {
      const gone = ctx.missing.has(s.path);
      const row = el('div', `pkg-row${gone ? ' is-missing' : ''}`);
      row.append(el('span', 'pkg-kind', s.kind === 'folder' ? 'Folder' : 'File'), pathCell(s.path));
      if (gone) row.append(el('span', 'pkg-note', 'not found'));
      if (own) {
        const rm = mini('Remove', `src:${s.path}`, () => removeSource(s.path), `Remove ${lastOf(s.path)}`);
        rm.disabled = off;
        row.append(rm);
      } else {
        row.append(el('span', 'pkg-from', `from ${job.inventory_id}`));
      }
      row.append(...said(s.path, `src:${s.path}`));
      return row;
    });
  });

  for (const z of overlay.querySelectorAll('.pkg-drop')) {
    const why = zoneOff();
    const press = z.querySelector('.pkg-press');
    z.classList.toggle('is-off', Boolean(why));
    press.setAttribute('aria-disabled', String(Boolean(why)));
    press.querySelector('.hint').textContent = why ?? z.dataset.hint;
    part(z.querySelector('.pkg-zone-note'), noteOf(z.dataset.place), () => [noteAt(z.dataset.place)]);
  }

  const suggested = shown.length ? [] : ctx.suggestions;
  part($('.pkg-suggest'), [off, suggested.map((s) => [s.path, noteOf(`sug:${s.path}`)])], () => (suggested.length
    ? [el('div', 'settings-label', 'Suggested'), ...suggested.map((s) => {
      const row = el('div', 'pkg-row');
      row.append(el('span', 'pkg-kind', 'Folder'), pathCell(s.path));
      const add = mini('Add folder', `sug:${s.path}`, () => {
        if (!barred(`sug:${s.path}`, 'added')) addSources([{ kind: 'folder', path: s.path }], `sug:${s.path}`);
      }, `Add folder ${s.name}`);
      add.disabled = off;
      row.append(add, ...said(null, `sug:${s.path}`));
      return row;
    })] : []));

  drawStandard();
  drawLibrary();
  drawDocs();
  drawActions();
}

/** What stands under a row: that its folder could not be read, and what failed there. */
function said(path, place) {
  const lines = [];
  if (path && ctx.unread.has(path)) lines.push(errLine(NOT_READ, `unread:${path}`, refreshDocs));
  const note = noteAt(place);
  if (note) lines.push(note);
  return lines;
}

/** Why there are no documents to list. */
function noDocs() {
  if (notYet()) return notYet();
  if (!wantedSources().length) return 'No folders or documents added.';
  if (ctx.state === 'checking' || ctx.searching) return SEARCHING;
  return ready() ? 'No checklists or drawing sets found.' : NO_FOLDER;
}

/** What a document's row says under its name: why it does not print from a PDF, that it has no box, that it could not be read. */
function docSays(d) {
  return [d.kind === 'checklist' && d.use === 'word' ? WHY_TEXT[d.why] : '',
    boxes.get(boxKey(d)) === false && (d.kind === 'checklist' || d.kind === 'word') ? 'No production number box' : '',
    noteOf(`doc:${d.path}`)].filter(Boolean);
}

function drawDocs() {
  const host = $('.pkg-docs');
  host.setAttribute('aria-busy', String(ctx.searching));
  const none = ctx.docs.length ? '' : noDocs();
  part(host, [none, ctx.searching, ctx.docs.map((d) => [d.path, d.name, d.kind, d.checked, d.where, d.lastModified, docSays(d)])], () => {
    if (none) return [el('div', 'pkg-none', none)];
    const rows = ctx.docs.map((d) => {
      const row = el('label', 'pkg-doc');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = d.checked;
      box.dataset.focus = `doc:${d.path}`;
      box.addEventListener('change', () => tick(d.path, box.checked));
      row.append(box, el('span', 'pkg-kind', KIND_LABEL[d.kind] ?? ''), el('span', 'pkg-name', d.name),
        el('span', 'pkg-where', d.where), el('span', 'pkg-date', fmtDate(d.lastModified)));
      const says = docSays(d);
      if (says.length) {
        const line = el('span', 'pkg-says');
        line.append(...says.map((words) => el('span', 'pkg-why', words)));
        row.append(line);
      }
      return row;
    });
    return ctx.searching ? [...rows, el('div', 'pkg-none', SEARCHING)] : rows;
  });
}

function tick(path, on) {
  const d = ctx.docs.find((x) => x.path === path);
  if (!d) return;
  d.checked = on;
  ctx.ticks.set(path, on);
  ctx.saved = false;
  quiet('defaults');
  render();
  lookForBoxes();
}

/** Why Print is off, where nothing above it says so. */
function printOff() {
  if (working || notYet() || ctx.state === 'checking') return '';
  if (!ready()) return NO_FOLDER;
  if (ctx.searching || !ctx.docs.length) return '';
  if (!ctx.docs.some((d) => d.checked)) return 'No documents ticked';
  return picked(printsAsPdf).length ? '' : 'No PDF documents ticked';
}

/** Why the packages have not loaded, and what can be done about it; null once they have, or while they may. */
function loadLine() {
  if (ctx.load === 'failed') return { words: ctx.loadWords, retry: load };
  if (packagesKnown()) return null;
  if (navigator.onLine === false) return { words: 'Offline – not yet loaded' };
  return ctx.load === 'late'
    ? { words: 'No response from the server – retrying', retry: () => { restartStreams(); load(); } } : null;
}

function drawActions() {
  const act = (name) => overlay.querySelector(`[data-act="${name}"]`);
  const unsupported = ctx.state === 'unsupported';
  // What belongs to the whole dialog: the packages, the print or download that stopped, what is not sent yet.
  const line = loadLine();
  const unsent = unsentFor(LOST_FOR);
  part($('.pkg-whole'), [line?.words, Boolean(line?.retry), ctx.whole?.words, Boolean(ctx.whole?.retry), unsent], () => [
    line ? errLine(line.words, 'retry:load', line.retry ? () => loadLine()?.retry?.() : null) : null,
    ctx.whole ? errLine(ctx.whole.words, 'retry:whole', ctx.whole.retry ? () => ctx.whole?.retry?.() : null) : null,
    unsent ? el('div', 'pkg-info', 'Changes not yet sent') : null]);

  // Something to keep, and for a moment that it was.
  const keep = act('defaults');
  const differ = ctx.docs.some((d) => d.checked !== d.defaultOn && !d.byQty);
  keep.hidden = !ctx.saved && !differ;
  keep.disabled = !ctx.saved && (ctx.searching || !editable());
  keep.classList.toggle('ok', ctx.saved);
  keep.textContent = ctx.saved ? 'Saved' : 'Save as default';
  if (!ctx.saved) keep.style.minWidth = '';
  part($('.pkg-defaults-note'), noteOf('defaults'), () => [noteAt('defaults')]);

  // One filled button: Connect until there is a folder, then Print. One that is busy keeps its own words (busy.js).
  const print = act('print');
  print.hidden = unsupported;
  print.className = ready() ? 'primary' : 'ghost';
  if (!print.hasAttribute('aria-busy')) print.disabled = working || ctx.searching || !ready() || !picked(printsAsPdf).length;
  $('.pkg-reason').textContent = printOff();
  const word = act('download');
  const busyWord = word.hasAttribute('aria-busy');
  word.hidden = unsupported || (!busyWord && !picked(downloadsAsWord).length);
  if (!busyWord) word.disabled = working || ctx.searching;
  act('folder').hidden = unsupported || !ready();
  act('folder').disabled = working;
  const manage = act('manage');
  manage.textContent = ctx.manage ? 'Close library' : 'Manage library';
  manage.setAttribute('aria-expanded', String(ctx.manage));
  manage.disabled = !packagesKnown();
}

/** A select whose choice is kept: put back when it cannot be changed, and when the change is refused. */
function keptSelect(key, label, value, options, set) {
  const pick = el('select', 'pkg-pick');
  pick.dataset.focus = key;
  pick.setAttribute('aria-label', label);
  for (const [v, text] of options) option(pick, v, text);
  pick.value = value;
  pick.disabled = !editable();
  pick.addEventListener('change', () => { if (!set(pick.value)) pick.value = value; });
  return pick;
}

/**
 * A row per group the package has a standard item for: its own choice, or
 * the default it inherits, named in the first option. Then the library's
 * other items, to add one.
 */
function drawStandard() {
  const off = !editable();
  const rows = packagesKnown() ? standardRows() : [];
  // A davit's plinth: the model its heights come from, set here; the plinth
  // itself as chosen in its row, shown.
  const davit = packagesKnown() && isDavit(ctx.job);
  const p = davit ? ctx.job.plinth : null;
  const own = davit ? chosenModel(ctx.job, ctx.packages, ctx.scope) : null;
  const names = davit ? (ctx.plinths?.models ?? []).map((m) => m.name) : [];
  const models = own && !names.includes(own) ? [...names, own] : names;
  const inherited = davit ? inheritedModel(ctx.job, ctx.plinths, ctx.packages, ctx.scope)?.name ?? 'none' : '';
  const needs = davit ? [needsDrawing(ctx.plinths, p) && 'Drawing needed', needsChecklist(ctx.plinths, p) && 'Checklist needed'].filter(Boolean) : [];
  const unreadPlinth = davit ? plinthSources(ctx.plinths, p).find((s) => ctx.unread.has(s.path))?.path ?? null : null;
  const items = (group) => ctx.library.items.filter((x) => x.group === group).map((i) => [i.id, i.name]);
  const shown = new Set(rows.map((r) => r.group));
  const spare = ctx.library.items.filter((i) => !shown.has(i.group));
  const none = notYet() ?? (!davit && !rows.length && !spare.length && !ctx.manage ? 'No standard items in the library.' : null);

  part($('.pkg-std-rows'), [none, off, davit, p, own, models, inherited, needs, unreadPlinth, noteOf('plinth:model'),
    rows.map((r) => {
      const it = itemById(r.id);
      return [r, itemById(r.inherited)?.name, items(r.group), it?.path, ctx.missing.has(it?.path), ctx.unread.has(it?.path), noteOf(`std:${r.group}`)];
    })], () => {
    if (none) return [el('div', 'pkg-none', none)];
    const out = [];
    if (davit) {
      const row = el('div', 'pkg-row pkg-std');
      const text = plinthText(p);
      const now = el('span', 'pkg-plinth-now');
      now.append(el('span', `pkg-plinth${p ? '' : ' is-blank'}`, text[0].toUpperCase() + text.slice(1)),
        ...needs.map((words) => el('span', 'pkg-note', words)));
      row.append(el('span', 'pkg-kind pkg-group', 'Plinth'),
        keptSelect('plinth:model', 'Plinth model', own ?? '', [['', `Default (${inherited})`], ...models.map((m) => [m, m])], setPlinthModel), now);
      row.append(...said(unreadPlinth, 'plinth:model'));
      out.push(row);
    }
    for (const r of rows) {
      const it = itemById(r.id);
      const gone = it && ctx.missing.has(it.path);
      const row = el('div', `pkg-row pkg-std${gone ? ' is-missing' : ''}`);
      row.append(el('span', 'pkg-kind pkg-group', r.group),
        keptSelect(`std:${r.group}`, r.group, r.own ?? '',
          [['', `Default (${itemById(r.inherited)?.name ?? 'none'})`], ...items(r.group), [NONE, 'None']], (v) => setStandard(r.group, v)));
      if (gone) row.append(el('span', 'pkg-note', 'not found'));
      row.append(...said(it?.path, `std:${r.group}`));
      out.push(row);
    }
    return out;
  });

  part($('.pkg-std-add'), [off, spare.map((i) => [i.id, i.name, i.group]), noteOf('std:add')], () => {
    if (!spare.length) return [noteAt('std:add')];
    const pick = keptSelect('std:add', 'Add standard item', '', [['', 'Add…']], (id) => {
      const i = itemById(id);
      return Boolean(i) && setStandard(i.group, i.id, { place: 'std:add', failed: `${i.name} not added` });
    });
    for (const g of groupsOf({ items: spare })) {
      const set = el('optgroup');
      set.label = g;
      for (const i of spare.filter((x) => x.group === g)) option(set, i.id, i.name);
      pick.append(set);
    }
    return [pick, noteAt('std:add')];
  });
}

/** A dropped item's row: its name and group, typed before it goes into the library. The one row throughout, whatever is redrawn. */
function pendingItem(p) {
  p.nameInput = textInput(`new:${p.id}:name`, p.name, 'Name');
  p.groupInput = textInput(`new:${p.id}:group`, p.group, 'Group');
  p.groupInput.setAttribute('list', 'pkgGroups');
  for (const i of [p.nameInput, p.groupInput]) {
    i.addEventListener('input', () => {
      p.name = p.nameInput.value;
      p.group = p.groupInput.value;
    });
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') addItem(p); });
  }
  p.add = mini('Add to library', `new:${p.id}:add`, () => addItem(p));
  const btns = el('span', 'pkg-btns');
  btns.append(p.add, mini('Discard item', `new:${p.id}:discard`, () => {
    ctx.pending = ctx.pending.filter((x) => x !== p);
    quiet(`new:${p.id}`);
    render();
  }));
  p.line = el('div', 'pkg-row-note');
  p.row = el('div', 'pkg-row pkg-item');
  p.row.append(field(p.nameInput), field(p.groupInput), pathCell(p.path), btns, p.line);
  return p;
}

/** The library, under Manage library: its items, adding one, and the job's category's defaults. */
function drawLibrary() {
  const { job, library } = ctx;
  const off = !editable();
  const lib = $('.pkg-lib');
  lib.hidden = !ctx.manage;
  if (!ctx.manage) return;
  const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });

  const items = [...library.items].sort((a, b) => byName(a.group, b.group) || byName(a.name, b.name));
  part($('.pkg-lib-rows'), [off, items.map((it) => [it, noteOf(`lib:${it.id}`)])], () => items.map((it) => {
    const row = el('div', 'pkg-row pkg-item');
    const name = textInput(`lib:${it.id}:name`, it.name, 'Name', it.name);
    name.addEventListener('change', () => renameItem(it.id, 'name', name));
    const group = textInput(`lib:${it.id}:group`, it.group, 'Group', it.name);
    group.setAttribute('list', 'pkgGroups');
    group.addEventListener('change', () => renameItem(it.id, 'group', group));
    const rm = mini('Remove', `lib:${it.id}:remove`, () => removeItem(it.id), `Remove ${it.name} from library`);
    for (const n of [name, group, rm]) n.disabled = off;
    row.append(field(name), field(group), pathCell(it.path), rm, ...said(null, `lib:${it.id}`));
    return row;
  }));

  const fresh = $('.pkg-lib-new');
  for (const n of [...fresh.children]) if (!ctx.pending.some((p) => p.row === n)) n.remove();
  for (const p of ctx.pending) {
    if (p.row.parentElement !== fresh) fresh.append(p.row);
    p.add.disabled = off;
    part(p.line, noteOf(`new:${p.id}`), () => [noteAt(`new:${p.id}`)]);
  }

  const groups = groupsOf(library);
  const chosen = library.categories[job.category] ?? {};
  part($('.pkg-lib-cats'), [off, job.category ?? '', items.map((i) => [i.id, i.name, i.group]), chosen, groups.map((g) => noteOf(`cat:${g}`))], () => {
    if (!groups.length || !job.category) return [];
    return [el('div', 'settings-label', `Defaults for ${job.category}`), ...groups.map((g) => {
      const row = el('div', 'pkg-row pkg-std');
      row.append(el('span', 'pkg-kind pkg-group', g),
        keptSelect(`cat:${g}`, `${g} default for ${job.category}`, chosen[g] ?? '',
          [['', 'None'], ...library.items.filter((x) => x.group === g).map((i) => [i.id, i.name])], (v) => setDefault(g, v)),
        ...said(null, `cat:${g}`));
      return row;
    })];
  });

  part(overlay.querySelector('#pkgGroups'), groups, () => groups.map((g) => {
    const o = el('option', null, g);
    o.value = g;
    return o;
  }));

  // The plinth folder, in a davit's dialog: where it is, and reading it again.
  const plinths = $('.pkg-lib-plinths');
  plinths.hidden = !isDavit(job);
  const path = ctx.plinths?.path ?? null;
  part($('.pkg-plinth-at'), [path, noteOf('plinth')], () => {
    if (!path) return [];
    const row = el('div', 'pkg-row');
    const btns = el('span', 'pkg-btns');
    btns.append(readAgain, changePlinths);
    row.append(el('span', 'pkg-kind', 'Folder'), pathCell(path), btns, ...said(null, 'plinth'));
    return [row];
  });
  if (!readAgain.hasAttribute('aria-busy')) readAgain.disabled = off || !ready();
  changePlinths.disabled = off || !ready();
  $('.pkg-plinth-drop').hidden = Boolean(path);
}

// Made once: one that is busy reading is not replaced by a redraw.
const readAgain = mini('Read again', 'plinth:again', () => busy(readAgain, 'Reading…', () => readPlinths(ctx.plinths?.path, { asked: true })));
const changePlinths = mini('Change', 'plinth:change', () => choosePlinthFolder(), 'Change plinth folder');

/** What a category's jobs have of a group unless their package says otherwise. */
function setDefault(group, value) {
  const { job } = ctx;
  const place = `cat:${group}`;
  if (barred(place, 'changed')) return false;
  const id = value || null;
  return editLibrary((l) => withCategoryDefault(l, job.category, group, id), { place, failed: `${group} default not changed`,
    note: `package: ${job.category} ${group} default ${id ? `set to ${itemById(id)?.name ?? id}` : 'cleared'}` });
}
