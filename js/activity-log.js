// activity-log.js - the Activity log, behind Recent changes: a box that
// scrolls, the newest entries at the top, older ones fetched a page at a
// time, a filter row above.
//
// The store hands back pages; this keeps what has been fetched so a redraw -
// every edit redraws, and so does a colleague's - refreshes what is on screen
// without throwing away the pages a reader scrolled down to. A Firestore read
// costs per document, so the first page is fifty and nothing is fetched twice
// unless the reader asks for it.

import { Store } from './store.js';
import { FILTERS, PAGE, visibleEntries, entryText, whoShort, whenShort, lastChanged } from './activity.js';

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

/** What the log has fetched so far. History's Last changed column falls back on it. */
export const loadedEntries = () => loaded;

/** Forget the pages: the panel closed, and the next open starts at the top. */
export function forgetActivityLog() { loaded = []; next = null; }

/**
 * The log block, appended to `host` and filling itself. Account entries are
 * drawn for a master only; everyone else never sees them.
 */
export function renderActivityLog(host, { master = false } = {}) {
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
  foot.append(older);
  box.append(list, foot);
  block.append(box);
  host.append(block);

  const draw = () => {
    for (const [key, b] of buttons) b.setAttribute('aria-pressed', String(key === filter));
    list.textContent = '';
    const rows = visibleEntries(loaded, { master, filter });
    if (!rows.length) {
      list.append(el('div', 'state', loaded.length ? 'No entries.'
        : 'Nothing logged yet. A status change, Done, Hide, a label, a hull or a part mark lands here with a name and a time.'));
    }
    for (const r of rows) list.append(line(r));
    foot.hidden = !next;
  };
  const fail = (e) => {
    list.textContent = '';
    list.append(el('div', 'state', `Could not load the log — ${e.message}`));
    foot.hidden = true;
  };

  older.addEventListener('click', async () => {
    if (!next) return;
    older.disabled = true;
    try {
      const page = await Store.listActivityPage({ max: PAGE, after: next });
      loaded = loaded.concat(page.rows);
      next = page.next;
      draw();
      fillLastChanged(document.body, loaded);
    } catch (e) { fail(e); } finally { older.disabled = false; }
  });

  // Refresh as many as were on screen, so a reader three pages down is not
  // thrown back to the top by somebody else's edit.
  const mine = ++seq;
  list.append(el('div', 'state', 'Loading…'));
  foot.hidden = true;
  Store.listActivityPage({ max: Math.max(PAGE, loaded.length) }).then((page) => {
    if (mine !== seq) return;
    loaded = page.rows;
    next = page.next;
    draw();
    fillLastChanged(document.body, loaded);
  }).catch((e) => { if (mine === seq) fail(e); });
  return block;
}

/** One line: when, who, which, what. Any action; the sentence is the entry's own. */
function line(r) {
  const row = el('div', 'act-row');
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
