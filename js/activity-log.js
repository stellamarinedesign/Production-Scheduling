// activity-log.js - the Activity log, behind its button beside History: a box
// that scrolls, the newest entries at the top, older ones fetched a page at a
// time, a filter row above.
//
// The store hands back pages; this keeps what has been fetched so a redraw -
// every edit redraws, and so does a colleague's - refreshes what is on screen
// where it stands, without emptying it or losing the reader's place. A
// Firestore read costs per document, so the first page is fifty, a refresh
// waits for the edits to settle, and nothing is fetched twice unless the
// reader asks for it.

import { Store } from './store.js';
import { FILTERS, PAGE, visibleEntries, entryText, whoShort, whenShort, lastChanged } from './activity.js';
import { failure } from './words.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let filter = 'all';   // outlives a redraw: it is how the reader is reading, not what is shown
let loaded = [];      // fetched this session, newest first
let next = null;      // the store's cursor for the page after `loaded`; null at the end
let seq = 0;          // a load that finishes after a newer one began is dropped
let live = null;      // the block on screen: { block, master, refresh }

/** A burst of edits is one refresh, after the last of them has been logged. */
const SETTLE = 1500;

/** What the log has fetched so far. History's Last changed column falls back on it. */
export const loadedEntries = () => loaded;

/** Forget the pages: the panel closed, and the next open starts at the top. */
export function forgetActivityLog() { loaded = []; next = null; }

/**
 * The log block, appended to `host` and filling itself. Account entries are
 * drawn for a master only; everyone else never sees them.
 */
export function renderActivityLog(host, { master = false } = {}) {
  if (live && live.master === master && live.block.parentElement === host) {
    live.refresh();
    return live.block;
  }
  host.textContent = '';
  const block = el('div', 'hist-cat act-block');
  const head = el('div', 'hist-cat-head is-static');
  head.append(el('h2', null, 'Activity log'));
  const bar = el('span', 'act-filters');
  const buttons = new Map();
  for (const f of FILTERS) {
    if (f.masters && !master) continue;
    const b = el('button', 'mini quiet', f.label);
    b.addEventListener('click', () => { filter = f.key; draw(); });
    buttons.set(f.key, b);
    bar.append(b);
  }
  head.append(bar);
  block.append(head);

  const box = el('div', 'activity');
  const list = el('div', 'act-list');
  const foot = el('div', 'act-foot');
  const older = el('button', 'mini quiet', 'Show older');
  // Why the last read did not arrive, with its Retry; what had arrived stays.
  const trouble = el('span', 'act-trouble');
  trouble.setAttribute('role', 'alert');
  const retry = el('button', 'mini', 'Retry');
  foot.append(trouble, retry, older);
  box.append(list, foot);
  block.append(box);
  host.append(block);

  let retryIt = null;        // what Retry does
  const feet = () => {
    retry.hidden = trouble.hidden = !retryIt;
    older.hidden = !next;
    foot.hidden = !retryIt && !next;
  };
  const draw = () => {
    for (const [key, b] of buttons) b.setAttribute('aria-pressed', String(key === filter));
    // The line being read stays under the eye: what arrives goes in above it.
    const top = box.getBoundingClientRect().top;
    const reading = box.scrollTop > 0
      ? [...list.children].find((n) => n.dataset.key && n.getBoundingClientRect().bottom > top) : null;
    const from = reading ? { key: reading.dataset.key, at: reading.getBoundingClientRect().top } : null;
    list.textContent = '';
    const rows = visibleEntries(loaded, { master, filter });
    if (!rows.length) list.append(el('div', 'state', emptyWords()));
    for (const r of rows) list.append(line(r));
    feet();
    const again = from && [...list.children].find((n) => n.dataset.key === from.key);
    if (again) box.scrollTop += again.getBoundingClientRect().top - from.at;
  };
  // The filters look through what has been fetched, so that is all an empty one can speak for.
  const emptyWords = () => {
    if (!loaded.length) return retryIt ? '' : 'Nothing logged yet.';
    const f = FILTERS.find((x) => x.key === filter);
    return next && f && f.key !== 'all'
      ? `No ${f.label.toLowerCase()} in the newest ${loaded.length} entries.` : 'No entries.';
  };
  const failed = (e, how) => {
    retryIt = how;
    trouble.textContent = failure('Log not loaded', e);
    list.querySelector('.state')?.remove();
    feet();
  };
  const ok = () => { retryIt = null; trouble.textContent = ''; };

  const showOlder = async () => {
    if (!next) return;
    older.disabled = true;
    try {
      const page = await Store.listActivityPage({ max: PAGE, after: next });
      ok();
      loaded = loaded.concat(page.rows);
      next = page.next;
      draw();
      fillLastChanged(document.body, loaded);
    } catch (e) { failed(e, showOlder); } finally { older.disabled = false; }
  };
  older.addEventListener('click', showOlder);
  retry.addEventListener('click', () => retryIt?.());

  // As many as were on screen, so a reader three pages down is not thrown back
  // to the top by somebody else's edit.
  const load = async () => {
    const mine = ++seq;
    try {
      const page = await Store.listActivityPage({ max: Math.max(PAGE, loaded.length) });
      if (mine !== seq) return;
      ok();
      loaded = page.rows;
      next = page.next;
      draw();
      fillLastChanged(document.body, loaded);
    } catch (e) { if (mine === seq) failed(e, load); }
  };
  let timer = null;
  live = {
    block,
    master,
    refresh: () => { clearTimeout(timer); timer = setTimeout(() => { if (block.isConnected) load(); }, SETTLE); },
  };
  if (loaded.length) draw();
  else { list.append(el('div', 'state', 'Loading…')); feet(); }
  load();
  return block;
}

/** One line: when, who, which, what. Any action; the sentence is the entry's own. */
function line(r) {
  const row = el('div', 'act-row');
  row.dataset.key = r._id ?? `${r.at}|${r.prodNo ?? r.inventoryId ?? ''}|${entryText(r)}`;
  row.append(el('span', 'act-when', whenShort(r.at)));
  row.append(el('span', 'act-who', whoShort(r.by)));
  const what = el('span', 'act-text');
  const key = r.prodNo ?? r.inventoryId ?? '';
  if (key) what.append(el('b', null, key), document.createTextNode(' '));
  if (r.label && r.label !== key) what.append(document.createTextNode(`${r.label} — `));
  what.append(document.createTextNode(entryText(r)));
  row.append(what);
  return row;
}

/**
 * History's Last changed cell. With nothing known yet it waits, marked with
 * its production number, for the log to load.
 */
export function touchedCell(hit, prodNo) {
  const cell = el('span', 'touched');
  if (hit) writeTouched(cell, hit); else cell.dataset.pending = prodNo;
  return cell;
}

/** Fill the cells that were drawn before the log had loaded. */
export function fillLastChanged(root, rows) {
  for (const cell of root.querySelectorAll('.touched[data-pending]')) {
    const hit = lastChanged({ job: { prod_no: cell.dataset.pending }, rows });
    if (!hit) continue;
    writeTouched(cell, hit);
    delete cell.dataset.pending;
  }
}

function writeTouched(cell, hit) {
  cell.textContent = '';
  cell.append(el('b', null, whoShort(hit.by)), el('span', null, whenShort(hit.at)));
}
