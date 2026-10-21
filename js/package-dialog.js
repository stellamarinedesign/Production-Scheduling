// package-dialog.js — a job's production package: what it is made of, and
// printing it.
//
// The package is kept per item code or per job (packages.js). Folders and
// documents go in by dropping them from File Explorer, or by choosing a
// folder; a folder is searched for its current checklists and drawing set
// each time the dialog opens. Printing merges the drawing sets into one PDF
// in a new tab, and downloads each checklist with the production number and
// due date written in, to print from Word.

import { Store } from './store.js';
import { closeOnBackdrop } from './dialog.js';
import { jobTitle } from './transform.js';
import {
  ROOT_NAME, SCOPE, splitPath, joinPath, parentPath, shortPath, docKind, KIND_LABEL,
  isWordKind, isPdfKind, pickDocuments, packageKey, packageFor, suggestFolders, filledName,
} from './packages.js';
import {
  supported, rootState, allowRoot, chooseRoot, pathWithin, handleAt, listFiles, listFolders,
  droppedHandles,
} from './stella-folder.js';
import { fillChecklistDocx, mergePdfs, DOCX_TYPE } from './adapters/package-files.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const $ = (sel) => overlay.querySelector(sel);

let overlay = null;
let ctx = null;     // { job, hooks, packages, scope, root, state, docs, missing, suggestions, busy }

/**
 * @param {Object} job  a board job
 * @param {{who?: string, onLog?: (desc) => void, toast?: (msg, ms?) => void}} hooks
 */
export async function openPackageDialog(job, hooks = {}) {
  if (!overlay) build();
  ctx = { job, hooks, packages: {}, scope: SCOPE.item, root: null, state: 'none',
    docs: [], missing: new Set(), suggestions: [], busy: false };
  $('.lede').textContent = `${job.prod_no} — ${jobTitle(job)}, due ${job.due_display}`;
  $('.form-err').textContent = '';
  overlay.classList.add('show');
  render();
  const mine = ctx;
  let packages = {};
  try {
    packages = await Store.loadPackages();
  } catch (e) {
    error(`Could not load packages — ${e.message}`);
  }
  if (ctx !== mine) return;                     // closed, or opened for another job, meanwhile
  ctx.packages = packages;
  ctx.scope = packageFor(job, packages).scope;
  await refreshRoot();
  await refreshDocs();
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

  const docs = el('div', 'pkg-section');
  docs.append(el('div', 'settings-label', 'Documents'), el('div', 'pkg-docs'));
  box.append(docs);

  box.append(el('div', 'form-err'));
  const acts = el('div', 'actions');
  const button = (cls, text, act) => {
    const b = el('button', cls, text);
    b.dataset.act = act;
    acts.append(b);
    return b;
  };
  button('primary', 'Print drawings', 'print').addEventListener('click', printDrawings);
  button('primary', 'Download checklists', 'download').addEventListener('click', downloadChecklists);
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
const sources = () => ctx.packages[currentKey()]?.sources ?? [];

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
    for (const s of sources()) {
      try {
        const h = await handleAt(ctx.root, s.path, s.kind);
        if (s.kind === 'folder') {
          for (const f of pickDocuments(await listFiles(h))) {
            docs.push({ ...f, where: shortPath(joinPath([...splitPath(s.path), ...f.dirs]), 3) });
          }
        } else {
          const f = await h.getFile();
          docs.push({ name: f.name, kind: docKind(f.name), lastModified: f.lastModified, handle: h,
            where: shortPath(parentPath(s.path), 2) });
        }
      } catch (e) {
        if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') missing.add(s.path);
        else if (e.name === 'NotAllowedError') { mine.state = 'prompt'; break; }
        else { error(`Could not read ${shortPath(s.path, 2)} — ${e.message}`); }
      }
    }
    if (!sources().length) suggestions = await findSuggestions().catch(() => []);
  }
  if (ctx !== mine) return;                     // the dialog moved on while this ran
  const seen = new Set();
  ctx.docs = docs.filter((d) => d.kind && !seen.has(`${d.where}/${d.name}`) && seen.add(`${d.where}/${d.name}`))
    .sort((a, b) => Number(isPdfKind(a.kind)) - Number(isPdfKind(b.kind)))
    .map((d) => ({ ...d, checked: true }));
  ctx.missing = missing;
  ctx.suggestions = suggestions;
  render();
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

async function save(next, note) {
  const key = currentKey();
  const data = {
    scope: ctx.scope,
    inventoryId: ctx.job.inventory_id ?? null,
    prodNo: ctx.scope === SCOPE.job ? ctx.job.prod_no : null,
    sources: next,
    updatedBy: ctx.hooks.who ?? null,
  };
  try {
    await Store.savePackage(key, data);
  } catch (e) {
    error(`Could not save — ${e.message}`);
    return;
  }
  if (next.length) ctx.packages[key] = data; else delete ctx.packages[key];
  ctx.hooks.onLog?.({ action: 'package', text: note });
  await refreshDocs();
}

async function addHandles(handles) {
  error('');
  if (!ready()) { error(`Connect the ${ROOT_NAME} folder first.`); return; }
  const next = [...sources()];
  const added = [];
  for (const h of handles) {
    if (!h) continue;
    let path;
    try { path = await pathWithin(ctx.root, h); } catch (e) { error(e.message); continue; }
    if (path === null) { error(`"${h.name}" is not inside the ${ROOT_NAME} folder.`); continue; }
    if (path === '') { error(`Drop a folder inside ${ROOT_NAME}, not ${ROOT_NAME} itself.`); continue; }
    const kind = h.kind === 'directory' ? 'folder' : 'file';
    if (kind === 'file' && !docKind(h.name)) { error('Only Word documents and PDFs go in a package.'); continue; }
    if (next.some((s) => s.path === path)) continue;
    next.push({ kind, path });
    added.push(splitPath(path).at(-1));
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
}

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

const picked = (test) => (ctx?.docs ?? []).filter((d) => d.checked && test(d.kind));

/** Which action is running, if one is: 'print' or 'download'. */
function busy(what) {
  ctx.busy = what;
  render();
}

async function printDrawings() {
  const list = picked(isPdfKind);
  if (!list.length || ctx.busy) return;
  error('');
  // Opened now, while the click still counts, or the browser blocks it.
  const tab = window.open('', '_blank');
  busy('print');
  try {
    const parts = [];
    for (const d of list) parts.push(await (await d.handle.getFile()).arrayBuffer());
    const title = `${ctx.job.prod_no} drawings`;
    const pdf = await mergePdfs(parts, { title });
    const url = URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
    if (tab) tab.location.href = url;
    else download(url, `${title}.pdf`);
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch (e) {
    tab?.close();
    error(`Could not put the drawings together — ${e.message}`);
  } finally {
    if (ctx) busy(false);
  }
}

async function downloadChecklists() {
  const list = picked(isWordKind);
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

function render() {
  if (!overlay || !ctx) return;
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

  const list = $('.pkg-sources');
  list.textContent = '';
  for (const s of sources()) {
    const row = el('div', `pkg-row${ctx.missing.has(s.path) ? ' is-missing' : ''}`);
    row.append(el('span', 'pkg-kind', s.kind === 'folder' ? 'Folder' : 'File'));
    const path = el('span', 'pkg-path', shortPath(s.path, 3));
    path.title = s.path;
    row.append(path);
    if (ctx.missing.has(s.path)) row.append(el('span', 'pkg-note', 'not found'));
    const rm = el('button', 'mini', 'Remove');
    rm.addEventListener('click', () => removeSource(s.path));
    row.append(rm);
    list.append(row);
  }
  $('.pkg-drop').classList.toggle('is-off', !ready());

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

  const docs = $('.pkg-docs');
  docs.textContent = '';
  if (!ctx.docs.length) {
    docs.append(el('div', 'pkg-none', ready() && sources().length ? 'No checklists or drawing sets found.' : '—'));
  }
  for (const d of ctx.docs) {
    const row = el('label', 'pkg-doc');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = d.checked;
    box.addEventListener('change', () => { d.checked = box.checked; render(); });
    row.append(box, el('span', 'pkg-kind', KIND_LABEL[d.kind] ?? ''), el('span', 'pkg-name', d.name),
      el('span', 'pkg-where', d.where), el('span', 'pkg-date', fmtDate(d.lastModified)));
    docs.append(row);
  }

  const act = (name) => overlay.querySelector(`[data-act="${name}"]`);
  act('print').disabled = Boolean(ctx.busy) || !picked(isPdfKind).length;
  act('download').disabled = Boolean(ctx.busy) || !picked(isWordKind).length;
  act('print').textContent = ctx.busy === 'print' ? 'Working…' : 'Print drawings';
  act('download').textContent = ctx.busy === 'download' ? 'Working…' : 'Download checklists';
  act('folder').hidden = !ready();
}
