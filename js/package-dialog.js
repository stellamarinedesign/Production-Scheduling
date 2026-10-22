// package-dialog.js — a job's production package: what it is made of, and
// printing it.
//
// The package is kept per item code or per job (packages.js). Folders and
// documents go in by dropping them from File Explorer, or by choosing a
// folder; a folder is searched for its current checklists and drawing set
// each time the dialog opens. Standard items - a lock, say, shared by many
// products - come from the library under Manage: a category's default, or
// another item of the same group chosen for this package, or none. Which
// documents start ticked is remembered per package. Print puts the ticked
// checklists - from their PDFs, the production number and due date written
// on - and drawing sets into one PDF and opens the print dialog over the
// board. A checklist with no current PDF says so and downloads from Word
// instead, filled in the same way.

import { Store } from './store.js';
import { closeOnBackdrop } from './dialog.js';
import { jobTitle } from './transform.js';
import {
  ROOT_NAME, SCOPE, splitPath, joinPath, parentPath, shortPath, docKind, KIND_LABEL,
  isPdfKind, pickDocuments, packageKey, packageFor, suggestFolders, filledName,
  printsByDefault, skipFrom, checklistDoc, printsAsPdf, downloadsAsWord, WHY_TEXT,
  ownSources, skipFor, isEmptyPackage, LIBRARY_KEY, NONE, normaliseLibrary, newItemId, groupsOf,
  standardFor, withChoice, withStandardSources, withItem, withoutItem, withCategoryDefault,
} from './packages.js';
import {
  PLINTHS_KEY, isDavit, readCatalogue, sameCatalogue, plinthSources, plinthText, needsDrawing,
} from './plinths.js';
import {
  supported, rootState, allowRoot, chooseRoot, pathWithin, handleAt, listFiles, listFolders,
  droppedHandles,
} from './stella-folder.js';
import {
  fillChecklistDocx, stampChecklistPdf, mergePdfs, DOCX_TYPE, jszip, pdflib, pdfjs,
} from './adapters/package-files.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const $ = (sel) => overlay.querySelector(sel);

let overlay = null;
// { job, hooks, packages, library, plinths, scope, root, state, docs, missing, suggestions, busy,
//   manage: library panel open, pending: a dropped item waiting for its name and group }
let ctx = null;

/** When the plinth folder was last read on this page; a davit's dialog reads it again after this long. */
let plinthsReadAt = 0;
const PLINTHS_FRESH_MS = 10 * 60 * 1000;

/**
 * @param {Object} job  a board job
 * @param {{who?: string, onLog?: (desc) => void, onPlinths?: (catalogue) => void,
 *          toast?: (msg, ms?) => void}} hooks
 */
export async function openPackageDialog(job, hooks = {}) {
  if (!overlay) build();
  ctx = { job, hooks, packages: {}, library: normaliseLibrary(null), plinths: null, scope: SCOPE.item, root: null,
    state: 'none', docs: [], missing: new Set(), suggestions: [], busy: false, manage: false, pending: null };
  $('.lede').textContent = `${job.prod_no} — ${jobTitle(job)}, due ${job.due_display}`;
  $('.form-err').textContent = '';
  overlay.classList.add('show');
  render();
  // Fetched now, so the first print does not wait on them.
  jszip().catch(() => {});
  pdflib().catch(() => {});
  pdfjs().catch(() => {});
  const mine = ctx;
  let packages = {};
  try {
    packages = await Store.loadPackages();
  } catch (e) {
    error(`Could not load packages — ${e.message}`);
  }
  if (ctx !== mine) return;                     // closed, or opened for another job, meanwhile
  ctx.packages = packages;
  ctx.library = normaliseLibrary(packages[LIBRARY_KEY]);
  ctx.plinths = packages[PLINTHS_KEY] ?? null;
  ctx.scope = packageFor(job, packages).scope;
  await refreshRoot();
  await refreshDocs();
  freshenPlinths();
}

/** A davit's dialog reads the plinth folder again now and then, for heights and drawings drafting has added. */
function freshenPlinths() {
  if (ctx && isDavit(ctx.job) && ready() && Date.now() - plinthsReadAt > PLINTHS_FRESH_MS) readPlinths(ctx.plinths?.path);
}

function close() {
  overlay?.classList.remove('show');
  ctx = null;
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
  sel.addEventListener('change', () => { ctx.scope = sel.value; refreshDocs(); });
  scope.append(lab, sel);
  box.append(scope);

  const src = el('div', 'pkg-section');
  src.append(el('div', 'settings-label', 'Folders and documents'), el('div', 'pkg-sources'));
  const drop = el('div', 'drop-zone pkg-drop');
  drop.append(el('strong', null, 'Drop folders or documents here'), el('div', 'hint', 'or click to choose a folder'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    const handles = droppedHandles(e);          // inside the event, before anything waits
    handles.then(addHandles).catch((err) => error(err.message));
  });
  drop.addEventListener('click', chooseFolder);
  src.append(drop, el('div', 'pkg-suggest'));
  box.append(src);

  // Standard items: a row per group in effect, the library behind Manage.
  const std = el('div', 'pkg-section');
  const stdHead = el('div', 'pkg-head');
  const manage = el('button', 'mini', 'Manage');
  manage.dataset.act = 'manage';
  manage.addEventListener('click', () => {
    ctx.manage = !ctx.manage;
    if (!ctx.manage) ctx.pending = null;
    render();
  });
  stdHead.append(el('div', 'settings-label', 'Standard items'), manage);
  const lib = el('div', 'pkg-lib');
  const libDrop = el('div', 'drop-zone pkg-drop pkg-lib-drop');
  libDrop.append(el('strong', null, 'Drop a folder or document here'), el('div', 'hint', 'or click to choose a folder'));
  libDrop.addEventListener('dragover', (e) => { e.preventDefault(); libDrop.classList.add('dragover'); });
  libDrop.addEventListener('dragleave', () => libDrop.classList.remove('dragover'));
  libDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    libDrop.classList.remove('dragover');
    droppedHandles(e).then(stageItem).catch((err) => error(err.message));
  });
  libDrop.addEventListener('click', chooseItemFolder);
  const groups = el('datalist');
  groups.id = 'pkgGroups';
  // The plinth folder, for a davit's: read for the heights its row offers.
  const plinths = el('div', 'pkg-lib-plinths');
  const plinthDrop = el('div', 'drop-zone pkg-drop pkg-plinth-drop');
  plinthDrop.append(el('strong', null, 'Drop the plinth folder here'), el('div', 'hint', 'or click to choose it'));
  plinthDrop.addEventListener('dragover', (e) => { e.preventDefault(); plinthDrop.classList.add('dragover'); });
  plinthDrop.addEventListener('dragleave', () => plinthDrop.classList.remove('dragover'));
  plinthDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    plinthDrop.classList.remove('dragover');
    droppedHandles(e).then(setPlinthFolder).catch((err) => error(err.message));
  });
  plinthDrop.addEventListener('click', choosePlinthFolder);
  plinths.append(el('div', 'settings-label', 'Plinth folder'), el('div', 'pkg-plinth-at'), plinthDrop);
  lib.append(el('div', 'pkg-lib-rows'), libDrop, el('div', 'pkg-lib-new'), el('div', 'pkg-lib-cats'), plinths, groups);
  std.append(stdHead, el('div', 'pkg-std-rows'), el('div', 'pkg-std-add'), lib);
  box.append(std);

  const docs = el('div', 'pkg-section');
  const head = el('div', 'pkg-head');
  const keep = el('button', 'mini', 'Save as default');
  keep.dataset.act = 'defaults';
  keep.addEventListener('click', saveDefaults);
  head.append(el('div', 'settings-label', 'Documents'), keep);
  docs.append(head, el('div', 'pkg-docs'));
  box.append(docs);

  box.append(el('div', 'form-err'));
  const acts = el('div', 'actions');
  const button = (cls, text, act) => {
    const b = el('button', cls, text);
    b.dataset.act = act;
    acts.append(b);
    return b;
  };
  button('primary', 'Print', 'print').addEventListener('click', printPackage);
  button('primary', 'Download Word', 'download').addEventListener('click', downloadWord);
  button('ghost', 'Change folder', 'folder').addEventListener('click', () => connect(true));
  button('ghost', 'Close', 'close').addEventListener('click', close);
  box.append(acts);

  overlay.append(box);
  document.body.append(overlay);
  closeOnBackdrop(overlay, close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('show')) close(); });
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const ready = () => ctx?.state === 'granted' && ctx.root;
const currentKey = () => packageKey(ctx.scope, ctx.job);
/** The package's own folders and documents. */
const sources = () => ctx.packages[currentKey()]?.sources ?? [];
/** The ones its documents come from: a job's code's, where the job has none of its own. */
const shownSources = () => ownSources(ctx.job, ctx.packages, ctx.scope);
const standardRows = () => standardFor(ctx.job, ctx.packages, ctx.library, ctx.scope);
const itemById = (id) => ctx.library.items.find((i) => i.id === id);

function error(msg) {
  if (overlay) $('.form-err').textContent = msg ?? '';
}

async function refreshRoot() {
  if (!ctx) return;
  if (!supported()) { ctx.state = 'unsupported'; return; }
  const { handle, state } = await rootState();
  ctx.root = handle;
  ctx.state = state;
}

/** Search every source again, and the suggestions with them. */
async function refreshDocs() {
  if (!ctx) return;
  const mine = ctx;
  render();
  const docs = [];
  const missing = new Set();
  let suggestions = [];
  if (ready()) {
    const all = withStandardSources(shownSources(), standardRows(), ctx.library);
    if (isDavit(ctx.job)) {
      for (const s of plinthSources(ctx.plinths, ctx.job.plinth)) if (!all.some((o) => o.path === s.path)) all.push(s);
    }
    for (const s of all) {
      // A standard item's documents say which item they are, the plinth's that they are its; the rest, where they are.
      const item = s.standard ? itemById(s.standard)?.name : s.plinth ? 'Plinth' : null;
      try {
        const h = await handleAt(ctx.root, s.path, s.kind);
        if (s.kind === 'folder') {
          for (const f of pickDocuments(await listFiles(h))) {
            docs.push({ ...f, path: joinPath([...splitPath(s.path), ...f.dirs, f.key ?? f.name]),
              where: item ?? shortPath(joinPath([...splitPath(s.path), ...f.dirs]), 3) });
          }
        } else {
          docs.push({ ...await fileDoc(h, s.path), path: s.path, where: item ?? shortPath(parentPath(s.path), 2) });
        }
      } catch (e) {
        if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') missing.add(s.path);
        else if (e.name === 'NotAllowedError') { mine.state = 'prompt'; break; }
        else { error(`Could not read ${shortPath(s.path, 2)} — ${e.message}`); }
      }
    }
    if (!shownSources().length) suggestions = await findSuggestions().catch(() => []);
  }
  if (ctx !== mine) return;                     // the dialog moved on while this ran
  const seen = new Set();
  const skip = skipFor(ctx.job, ctx.packages, ctx.scope);
  ctx.docs = docs.filter((d) => d.kind && !seen.has(d.path) && seen.add(d.path))
    .sort((a, b) => Number(isPdfKind(a.kind)) - Number(isPdfKind(b.kind)))
    .map((d) => {
      const on = printsByDefault(d.path, d.lastModified, skip);
      return { ...d, checked: on, defaultOn: on };
    });
  ctx.missing = missing;
  ctx.suggestions = suggestions;
  render();
}

/**
 * A document dropped in on its own. A checklist is looked for in both forms
 * beside it - its PDF next to the Word file, or the other way round - so a
 * dropped checklist prints from its PDF the same as one found in a folder.
 */
async function fileDoc(handle, path) {
  const f = await handle.getFile();
  const kind = docKind(f.name);
  const own = { name: f.name, dirs: [], lastModified: f.lastModified, handle };
  if (kind !== 'checklist' && kind !== 'checklistPdf') return { ...own, kind };
  const twin = f.name.replace(/\.(docx|pdf)$/i, kind === 'checklist' ? '.pdf' : '.docx');
  let other = null;
  try {
    const h = await (await handleAt(ctx.root, parentPath(path), 'folder')).getFileHandle(twin);
    const g = await h.getFile();
    other = { name: g.name, dirs: [], lastModified: g.lastModified, handle: h };
  } catch { /* no twin: the one there is */ }
  return kind === 'checklist' ? checklistDoc(own, other) : checklistDoc(other, own);
}

/** Folders beside the ones other packages use, that look like this job's. */
async function findSuggestions() {
  const parents = [...new Set(Object.values(ctx.packages)
    .flatMap((p) => (p.sources ?? []).filter((s) => s.kind === 'folder').map((s) => parentPath(s.path)))
    .filter(Boolean))].slice(0, 8);
  const candidates = [];
  for (const parent of parents) {
    try {
      const h = await handleAt(ctx.root, parent, 'folder');
      for (const name of await listFolders(h)) candidates.push({ name, path: joinPath([...splitPath(parent), name]) });
    } catch { /* a folder that has gone suggests nothing */ }
  }
  return suggestFolders(ctx.job, candidates, { exclude: sources().map((s) => s.path) });
}

// ---------------------------------------------------------------------------
// changing the package
// ---------------------------------------------------------------------------

/**
 * Write the package: its sources, and anything else it keeps (the print
 * defaults, the standard items) as it was. A package left with nothing in it
 * is removed.
 */
async function save(next, note, extra = {}) {
  const key = currentKey();
  const data = {
    ...(ctx.packages[key] ?? {}),
    scope: ctx.scope,
    inventoryId: ctx.job.inventory_id ?? null,
    prodNo: ctx.scope === SCOPE.job ? ctx.job.prod_no : null,
    sources: next,
    updatedBy: ctx.hooks.who ?? null,
    ...extra,
  };
  const empty = isEmptyPackage(data);
  try {
    await Store.savePackage(key, empty ? null : data);
  } catch (e) {
    error(`Could not save — ${e.message}`);
    return;
  }
  if (empty) delete ctx.packages[key]; else ctx.packages[key] = data;
  ctx.hooks.onLog?.({ action: 'package', text: note });
  await refreshDocs();
}

/** Where a dropped folder or document is in Stella Systems; null, and why, if it cannot go in. */
async function placeOf(h) {
  let path;
  try { path = await pathWithin(ctx.root, h); } catch (e) { error(e.message); return null; }
  if (path === null) { error(`"${h.name}" is not inside the ${ROOT_NAME} folder.`); return null; }
  if (path === '') { error(`Drop a folder inside ${ROOT_NAME}, not ${ROOT_NAME} itself.`); return null; }
  const kind = h.kind === 'directory' ? 'folder' : 'file';
  if (kind === 'file' && !docKind(h.name)) { error('Only Word documents and PDFs go in a package.'); return null; }
  return { kind, path };
}

async function addHandles(handles) {
  error('');
  if (!ready()) { error(`Connect the ${ROOT_NAME} folder first.`); return; }
  // A job adding to the folders it has from its code starts its own list from them.
  const next = [...shownSources()];
  const added = [];
  for (const h of handles) {
    if (!h) continue;
    const place = await placeOf(h);
    if (!place || next.some((s) => s.path === place.path)) continue;
    next.push(place);
    added.push(splitPath(place.path).at(-1));
  }
  if (added.length) await save(next, `package: added ${added.join(', ')}`);
}

async function chooseFolder() {
  error('');
  if (!ready()) { await connect(false); if (!ready()) return; }
  try {
    const h = await window.showDirectoryPicker({ id: 'stella-package', startIn: ctx.root, mode: 'read' });
    await addHandles([h]);
  } catch (e) {
    if (e.name !== 'AbortError') error(e.message);
  }
}

async function removeSource(path) {
  await save(sources().filter((s) => s.path !== path), `package: removed ${splitPath(path).at(-1)}`);
}

/** This package's choice for a group: an item id, NONE to leave it out, '' for the default. */
async function setStandard(group, value) {
  if (!ctx || ctx.busy) return;
  error('');
  const standard = withChoice(ctx.packages[currentKey()]?.standard, group, value);
  const what = value === NONE ? 'left out' : value ? `set to ${itemById(value)?.name ?? value}` : 'back to the default';
  await save(sources(), `package: ${group} ${what}`, { standard });
}

// ---------------------------------------------------------------------------
// the standard items library
// ---------------------------------------------------------------------------

/**
 * Change the library. It is read again first and the change made to that, so
 * another manager's change since this dialog opened is kept.
 * @param {(library) => Object} change
 */
async function changeLibrary(change, note) {
  if (!ctx) return false;
  error('');
  const mine = ctx;
  let next;
  try {
    next = { ...change(normaliseLibrary(await Store.loadPackage(LIBRARY_KEY))), updatedBy: ctx.hooks.who ?? null };
    await Store.savePackage(LIBRARY_KEY, next);
  } catch (e) {
    error(`Could not save — ${e.message}`);
    return false;
  }
  if (ctx !== mine) return false;
  ctx.packages[LIBRARY_KEY] = next;
  ctx.library = normaliseLibrary(next);
  ctx.hooks.onLog?.({ action: 'package', text: note });
  await refreshDocs();
  return true;
}

/** A folder or document dropped to become a standard item, named and grouped before it goes in. */
async function stageItem(handles) {
  error('');
  if (!ready()) { error(`Connect the ${ROOT_NAME} folder first.`); return; }
  const h = handles.find(Boolean);
  const place = h ? await placeOf(h) : null;
  if (!place || !ctx) return;
  ctx.pending = { ...place, name: h.name.replace(/\.(docx|pdf)$/i, ''), group: '' };
  render();
  overlay.querySelector('.pkg-lib-new input')?.focus();
}

async function chooseItemFolder() {
  error('');
  if (!ready()) { await connect(false); if (!ready()) return; }
  try {
    const h = await window.showDirectoryPicker({ id: 'stella-standard', startIn: ctx.root, mode: 'read' });
    await stageItem([h]);
  } catch (e) {
    if (e.name !== 'AbortError') error(e.message);
  }
}

async function addItem() {
  const p = ctx?.pending;
  const name = p?.name.trim();
  const group = p?.group.trim();
  if (!name || !group) return;
  const item = { id: newItemId(), name, group, kind: p.kind, path: p.path };
  if (await changeLibrary((lib) => withItem(lib, item), `package: standard item ${name} (${group}) added`)) {
    ctx.pending = null;
    render();
  }
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
  let found;
  try {
    found = await readCatalogue(path, {
      folders: async (p) => listFolders(await handleAt(root, p, 'folder')),
      files: async (p) => listFiles(await handleAt(root, p, 'folder'), { maxDepth: 4 }),
    });
  } catch (e) {
    if (asked && ctx === mine) error(`Could not read the plinth folder — ${e.message}`);
    return;
  }
  plinthsReadAt = Date.now();
  if (ctx !== mine) return;
  const heights = found.models.reduce((n, m) => n + m.heights.length, 0);
  if (!heights) {
    if (asked) error(`No plinth heights found in ${splitPath(path).at(-1)}.`);
    return;
  }
  if (!sameCatalogue(found, ctx.plinths)) {
    const data = { ...found, readAt: new Date().toISOString(), updatedBy: ctx.hooks.who ?? null };
    try {
      await Store.savePackage(PLINTHS_KEY, data);
    } catch (e) {
      if (asked) error(`Could not save — ${e.message}`);
      return;
    }
    if (ctx !== mine) return;
    ctx.plinths = data;
    ctx.packages[PLINTHS_KEY] = data;
    ctx.hooks.onPlinths?.(data);
    if (asked) ctx.hooks.onLog?.({ action: 'package', text: `plinth folder read: ${splitPath(path).at(-1)}` });
    await refreshDocs();
  }
  if (asked) ctx?.hooks.toast?.(`Plinth folder read: ${heights} heights.`, 3200);
}

async function setPlinthFolder(handles) {
  error('');
  if (!ready()) { error(`Connect the ${ROOT_NAME} folder first.`); return; }
  const h = handles.find(Boolean);
  const place = h ? await placeOf(h) : null;
  if (!place) return;
  if (place.kind !== 'folder') { error('Drop the plinth folder itself, not a file in it.'); return; }
  await readPlinths(place.path, { asked: true });
}

async function choosePlinthFolder() {
  error('');
  if (!ready()) { await connect(false); if (!ready()) return; }
  try {
    const h = await window.showDirectoryPicker({ id: 'stella-plinths', startIn: ctx.root, mode: 'read' });
    await setPlinthFolder([h]);
  } catch (e) {
    if (e.name !== 'AbortError') error(e.message);
  }
}

/** A library item's name or group, changed where it is listed. */
function renameItem(item, field, value) {
  const v = value.trim();
  if (!v || v === item[field]) { render(); return; }
  changeLibrary((lib) => withItem(lib, { ...(lib.items.find((i) => i.id === item.id) ?? item), [field]: v }),
    `package: standard item ${item.name} ${field === 'name' ? 'renamed' : 'moved to group'} ${v}`);
}

/** The ticks as they stand become the ones every job on this package starts with. */
async function saveDefaults() {
  if (!ctx || ctx.busy) return;
  error('');
  const skip = skipFrom(ctx.docs);
  await save(sources(), skip.length
    ? `package: ${skip.map((s) => splitPath(s.path).at(-1)).join(', ')} unticked by default`
    : 'package: everything ticked by default', { skip });
}

/** Point this PC at Stella Systems, or ask again for the folder it knows. */
async function connect(choose) {
  error('');
  try {
    if (!choose && ctx.root && ctx.state === 'prompt') await allowRoot(ctx.root);
    else await chooseRoot();
  } catch (e) {
    if (e.name !== 'AbortError') error(e.message);
  }
  await refreshRoot();
  await refreshDocs();
  freshenPlinths();
}

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

/** The ticked documents that pass a test. */
const picked = (test) => (ctx?.docs ?? []).filter((d) => d.checked && test(d));

/** Which action is running, if one is: 'print' or 'download'. */
function busy(what) {
  ctx.busy = what;
  render();
}

/**
 * Everything ticked that is a PDF, as one PDF to print: checklists first,
 * each with the production number and due date written on, then drawings.
 */
async function printPackage() {
  const list = picked(printsAsPdf);
  if (!list.length || ctx.busy) return;
  error('');
  busy('print');
  const job = ctx.job;
  const title = `${job.prod_no} package`;
  const plain = [];
  let pdf = null;
  try {
    const parts = [];
    for (const d of list) {
      const bytes = await (await d.handle.getFile()).arrayBuffer();
      if (d.kind !== 'checklist') { parts.push(bytes); continue; }
      const out = await stampChecklistPdf(bytes, { prodNo: job.prod_no, due: job.due_display });
      if (!out.filled) plain.push(d.name);
      parts.push(out.bytes);
    }
    pdf = parts.length === 1 ? new Uint8Array(parts[0]) : await mergePdfs(parts, { title });
    await printPdf(pdf);
    if (plain.length) ctx?.hooks.toast?.(`No Production Number box in: ${plain.join(', ')}.`, 6000);
  } catch (e) {
    if (pdf) {
      // The page could not print it: the PDF itself instead, to print from there.
      const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
      download(url, `${title}.pdf`);
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      ctx?.hooks.toast?.(`Saved as ${title}.pdf to print.`, 5000);
    } else {
      error(`Could not put the package together — ${e.message}`);
    }
  } finally {
    if (ctx) busy(false);
  }
}

let printFrame = null;

/**
 * Print a PDF from a hidden frame in this page, so the print dialog opens
 * over the board. A new tab for it put the board in the background, where
 * the browser slows it down, and showed a blank page meanwhile.
 */
function printPdf(bytes) {
  if (printFrame) { URL.revokeObjectURL(printFrame.src); printFrame.remove(); }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const frame = el('iframe', 'print-frame');
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
  if (!list.length || ctx.busy) return;
  error('');
  busy('download');
  const job = ctx.job;
  const plain = [];
  try {
    for (const d of list) {
      const bytes = await (await d.handle.getFile()).arrayBuffer();
      const out = await fillChecklistDocx(bytes, { prodNo: job.prod_no, due: job.due_display });
      if (!out.filled) plain.push(d.name);
      const url = URL.createObjectURL(new Blob([out.bytes], { type: DOCX_TYPE }));
      download(url, filledName(job.prod_no, d.name));
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      await new Promise((r) => setTimeout(r, 400));     // one at a time, or the browser drops some
    }
    ctx.hooks.toast?.(plain.length
      ? `Downloaded. No Production Number box in: ${plain.join(', ')}.`
      : `${list.length} checklist${list.length === 1 ? '' : 's'} downloaded.`, plain.length ? 6000 : 3200);
  } catch (e) {
    error(`Could not fill the checklists — ${e.message}`);
  } finally {
    if (ctx) busy(false);
  }
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
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

const option = (parent, value, text) => {
  const o = el('option', null, text);
  o.value = value;
  parent.append(o);
  return o;
};

const textInput = (key, value, placeholder) => {
  const i = el('input');
  i.type = 'text';
  i.value = value;
  i.placeholder = placeholder;
  i.dataset.key = key;
  return i;
};

/** Draw the dialog again, without losing the field being typed in. */
function render() {
  if (!overlay || !ctx) return;
  const f = document.activeElement;
  const key = overlay.contains(f) ? f.dataset.key : null;
  const typed = key && f.tagName === 'INPUT' ? { value: f.value, start: f.selectionStart, end: f.selectionEnd } : null;
  draw();
  const g = key ? overlay.querySelector(`[data-key="${CSS.escape(key)}"]`) : null;
  if (!g) return;
  if (typed) {
    g.value = typed.value;
    g.setSelectionRange(typed.start, typed.end);
  }
  g.focus();
}

function draw() {
  const { job } = ctx;

  // The folder: nothing to show once it is ready.
  const folder = $('.pkg-folder');
  folder.textContent = '';
  if (ctx.state === 'unsupported') {
    folder.append(el('div', 'form-err', 'Packages need Edge or Chrome.'));
  } else if (!ready()) {
    const b = el('button', 'primary', ctx.state === 'prompt' ? `Allow ${ROOT_NAME} folder` : `Connect ${ROOT_NAME} folder`);
    b.addEventListener('click', () => connect(ctx.state !== 'prompt'));
    folder.append(b);
  }

  const sel = $('.pkg-scope');
  sel.textContent = '';
  for (const [value, text] of [[SCOPE.item, `Every job on ${job.inventory_id}`], [SCOPE.job, `This job only (${job.prod_no})`]]) {
    const o = el('option', null, text);
    o.value = value;
    o.selected = value === ctx.scope;
    sel.append(o);
  }

  // A job with none of its own lists its code's, which are removed from there.
  const list = $('.pkg-sources');
  list.textContent = '';
  const own = sources().length > 0;
  for (const s of shownSources()) {
    const row = el('div', `pkg-row${ctx.missing.has(s.path) ? ' is-missing' : ''}`);
    row.append(el('span', 'pkg-kind', s.kind === 'folder' ? 'Folder' : 'File'));
    const path = el('span', 'pkg-path', shortPath(s.path, 3));
    path.title = s.path;
    row.append(path);
    if (ctx.missing.has(s.path)) row.append(el('span', 'pkg-note', 'not found'));
    if (own) {
      const rm = el('button', 'mini', 'Remove');
      rm.addEventListener('click', () => removeSource(s.path));
      row.append(rm);
    } else {
      row.append(el('span', 'pkg-from', `from ${job.inventory_id}`));
    }
    list.append(row);
  }
  for (const d of overlay.querySelectorAll('.pkg-drop')) d.classList.toggle('is-off', !ready());

  const sug = $('.pkg-suggest');
  sug.textContent = '';
  if (ctx.suggestions.length) {
    sug.append(el('div', 'settings-label', 'Suggested'));
    for (const s of ctx.suggestions) {
      const row = el('div', 'pkg-row');
      row.append(el('span', 'pkg-kind', 'Folder'));
      const path = el('span', 'pkg-path', shortPath(s.path, 3));
      path.title = s.path;
      row.append(path);
      const add = el('button', 'mini', 'Add');
      add.addEventListener('click', () => save([...sources(), { kind: 'folder', path: s.path }],
        `package: added ${s.name}`));
      row.append(add);
      sug.append(row);
    }
  }

  drawStandard();
  drawLibrary();

  const docs = $('.pkg-docs');
  docs.textContent = '';
  if (!ctx.docs.length) {
    const any = shownSources().length || standardRows().some((r) => r.id);
    docs.append(el('div', 'pkg-none', ready() && any ? 'No checklists or drawing sets found.' : '—'));
  }
  for (const d of ctx.docs) {
    const row = el('label', 'pkg-doc');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = d.checked;
    box.addEventListener('change', () => { d.checked = box.checked; render(); });
    const name = el('span', 'pkg-name', d.name);
    // A checklist that will not print from a PDF says why, on its row.
    if (d.kind === 'checklist' && d.use === 'word') name.append(el('span', 'pkg-why', WHY_TEXT[d.why] ?? ''));
    row.append(box, el('span', 'pkg-kind', KIND_LABEL[d.kind] ?? ''), name,
      el('span', 'pkg-where', d.where), el('span', 'pkg-date', fmtDate(d.lastModified)));
    docs.append(row);
  }

  const act = (name) => overlay.querySelector(`[data-act="${name}"]`);
  act('defaults').hidden = !ctx.docs.some((d) => d.checked !== d.defaultOn);
  act('defaults').disabled = Boolean(ctx.busy);
  act('print').disabled = Boolean(ctx.busy) || !picked(printsAsPdf).length;
  act('print').textContent = ctx.busy === 'print' ? 'Working…' : 'Print';
  act('download').hidden = !picked(downloadsAsWord).length;
  act('download').disabled = Boolean(ctx.busy);
  act('download').textContent = ctx.busy === 'download' ? 'Working…' : 'Download Word';
  act('folder').hidden = !ready();
  act('manage').textContent = ctx.manage ? 'Done' : 'Manage';
}

/**
 * A row per group the package has a standard item for: its own choice, or
 * the default it inherits, named in the first option. Then the library's
 * other items, to add one.
 */
function drawStandard() {
  const rows = standardRows();
  const list = $('.pkg-std-rows');
  list.textContent = '';
  // A davit's plinth, as chosen in its row: shown, not set, here.
  const davit = isDavit(ctx.job);
  if (davit) {
    const p = ctx.job.plinth;
    const text = plinthText(p);
    const row = el('div', 'pkg-row pkg-std');
    row.append(el('span', 'pkg-kind pkg-group', 'Plinth'),
      el('span', `pkg-plinth${p ? '' : ' is-blank'}`, text[0].toUpperCase() + text.slice(1)));
    if (needsDrawing(ctx.plinths, p)) row.append(el('span', 'pkg-note', 'Drawing needed'));
    list.append(row);
  }
  for (const r of rows) {
    const it = itemById(r.id);
    const gone = it && ctx.missing.has(it.path);
    const row = el('div', `pkg-row pkg-std${gone ? ' is-missing' : ''}`);
    row.append(el('span', 'pkg-kind pkg-group', r.group));
    const pick = el('select', 'pkg-pick');
    pick.dataset.key = `std:${r.group}`;
    option(pick, '', `Default (${itemById(r.inherited)?.name ?? 'none'})`);
    for (const i of ctx.library.items.filter((x) => x.group === r.group)) option(pick, i.id, i.name);
    option(pick, NONE, 'None');
    pick.value = r.own ?? '';
    pick.addEventListener('change', () => setStandard(r.group, pick.value));
    row.append(pick);
    if (gone) row.append(el('span', 'pkg-note', 'not found'));
    list.append(row);
  }

  const add = $('.pkg-std-add');
  add.textContent = '';
  const shown = new Set(rows.map((r) => r.group));
  const spare = ctx.library.items.filter((i) => !shown.has(i.group));
  if (spare.length) {
    const pick = el('select', 'pkg-pick');
    pick.dataset.key = 'std:add';
    option(pick, '', 'Add…');
    for (const g of groupsOf({ items: spare })) {
      const set = el('optgroup');
      set.label = g;
      for (const i of spare.filter((x) => x.group === g)) option(set, i.id, i.name);
      pick.append(set);
    }
    pick.addEventListener('change', () => {
      const i = itemById(pick.value);
      if (i) setStandard(i.group, i.id);
    });
    add.append(pick);
  }
  if (!davit && !rows.length && !spare.length && !ctx.manage) list.append(el('div', 'pkg-none', '—'));
}

/** The library, under Manage: its items, adding one, and the job's category's defaults. */
function drawLibrary() {
  const { job, library } = ctx;
  const lib = $('.pkg-lib');
  lib.hidden = !ctx.manage;
  if (!ctx.manage) return;
  const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });

  const rows = $('.pkg-lib-rows');
  rows.textContent = '';
  for (const it of [...library.items].sort((a, b) => byName(a.group, b.group) || byName(a.name, b.name))) {
    const row = el('div', 'pkg-row pkg-item');
    const name = textInput(`lib:${it.id}:name`, it.name, 'Name');
    name.addEventListener('change', () => renameItem(it, 'name', name.value));
    const group = textInput(`lib:${it.id}:group`, it.group, 'Group');
    group.setAttribute('list', 'pkgGroups');
    group.addEventListener('change', () => renameItem(it, 'group', group.value));
    const path = el('span', 'pkg-path', shortPath(it.path, 3));
    path.title = it.path;
    const rm = el('button', 'mini', 'Remove');
    rm.addEventListener('click', () => changeLibrary((l) => withoutItem(l, it.id), `package: standard item ${it.name} removed`));
    row.append(name, group, path, rm);
    rows.append(row);
  }

  const fresh = $('.pkg-lib-new');
  fresh.textContent = '';
  const p = ctx.pending;
  if (p) {
    const row = el('div', 'pkg-row pkg-item');
    const name = textInput('new:name', p.name, 'Name');
    const group = textInput('new:group', p.group, 'Group');
    group.setAttribute('list', 'pkgGroups');
    const path = el('span', 'pkg-path', shortPath(p.path, 3));
    path.title = p.path;
    const btns = el('span', 'pkg-btns');
    const ok = el('button', 'mini', 'Add');
    const sync = () => {
      p.name = name.value;
      p.group = group.value;
      ok.disabled = !p.name.trim() || !p.group.trim();
    };
    for (const i of [name, group]) {
      i.addEventListener('input', sync);
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') addItem(); });
    }
    sync();
    ok.addEventListener('click', addItem);
    const cancel = el('button', 'mini', 'Cancel');
    cancel.addEventListener('click', () => { ctx.pending = null; render(); });
    btns.append(ok, cancel);
    row.append(name, group, path, btns);
    fresh.append(row);
  }

  const cats = $('.pkg-lib-cats');
  cats.textContent = '';
  const groups = groupsOf(library);
  if (groups.length && job.category) {
    cats.append(el('div', 'settings-label', `Defaults for ${job.category}`));
    for (const g of groups) {
      const row = el('div', 'pkg-row pkg-std');
      row.append(el('span', 'pkg-kind pkg-group', g));
      const pick = el('select', 'pkg-pick');
      pick.dataset.key = `cat:${g}`;
      option(pick, '', 'None');
      for (const i of library.items.filter((x) => x.group === g)) option(pick, i.id, i.name);
      pick.value = library.categories[job.category]?.[g] ?? '';
      pick.addEventListener('change', () => {
        const id = pick.value || null;
        changeLibrary((l) => withCategoryDefault(l, job.category, g, id),
          `package: ${job.category} ${g} default ${id ? `set to ${itemById(id)?.name ?? id}` : 'cleared'}`);
      });
      row.append(pick);
      cats.append(row);
    }
  }

  const list = overlay.querySelector('#pkgGroups');
  list.textContent = '';
  for (const g of groups) option(list, g, g);

  // The plinth folder, in a davit's dialog: where it is, and reading it again.
  const plinths = $('.pkg-lib-plinths');
  plinths.hidden = !isDavit(job);
  const at = $('.pkg-plinth-at');
  at.textContent = '';
  const path = ctx.plinths?.path;
  if (path) {
    const row = el('div', 'pkg-row');
    row.append(el('span', 'pkg-kind', 'Folder'));
    const p = el('span', 'pkg-path', shortPath(path, 3));
    p.title = path;
    const btns = el('span', 'pkg-btns');
    const again = el('button', 'mini', 'Read again');
    again.addEventListener('click', () => readPlinths(path, { asked: true }));
    const change = el('button', 'mini', 'Change');
    change.addEventListener('click', choosePlinthFolder);
    btns.append(again, change);
    row.append(p, btns);
    at.append(row);
  }
  $('.pkg-plinth-drop').hidden = Boolean(path);
}
