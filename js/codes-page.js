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

import { Store, unpackRows } from './store.js';
import { resolveDisplays, boatRows, itemFacts } from './vessel-codes.js';
import { classify } from './rules.js';
import { Auth, ROLE, setManagers } from './auth.js';
import { VERSION } from './version.js';
import { fitCodesSheet, TYPE_STEPS } from './codes-print.js';
import { wireHelp } from './help.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let codeMap = {};
let resolved = null;
let mode = 'boats';                 // 'boats' | 'products'
const collapsed = new Set();
let facts = null;   // item code -> { description, orders }

(async function boot() {
  $('pageVersion').textContent = `v${VERSION}`;

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
    Auth.init((st) => { if (!done) { done = true; resolve(st); } });
  });

  await Store.init();
  setManagers(await Store.loadManagers());
  const role = Auth.refreshRole();

  // SAY WHY, DO NOT BOUNCE.
  //
  // This used to redirect to the board. A redirect leaves nothing on screen to
  // read — not the reason, not the build — so when it fired wrongly there was
  // no way to tell a broken role check from a cached copy of this file, and no
  // way to tell either of those from "you are not a manager". Whatever the
  // answer is, it is more useful on the page than in the address bar.
  if (role !== ROLE.MANAGER) {
    const why = role === ROLE.NONE
      ? 'You are not signed in.'
      : `You are signed in as ${first.email ?? 'an account'}, which is not on the manager list.`;
    const host = $('codesDenied');
    host.hidden = false;
    host.textContent = '';
    host.append(el('strong', null, 'Vessel codes are for managers'));
    host.append(el('div', null, `${why} The board itself is read-only for everyone else.`));
    const back = el('a', 'backlink', 'Go to the board');
    back.href = './';
    host.append(back);
    for (const n of document.querySelectorAll('main .view-bar, main #rows, main #warnings, main .provenance')) {
      n.hidden = true;
    }
    return;
  }

  $('storeMode').textContent = Store.mode === 'firestore' ? 'Saved to Firestore' : 'Saved on this device only';
  if (Store.mode !== 'firestore') $('storeMode').style.color = 'var(--red-bright)';
  codeMap = await Store.loadCodes();
  facts = await loadFacts();

  // The seed file is no longer deployed — Firestore is the source of truth. An
  // empty map here means a store that has never been seeded, not a page with
  // nothing to say, so it should not look like an empty table.
  if (!Object.keys(codeMap).length) {
    $('codesEmpty').hidden = false;
  }

  $('modeBoats').addEventListener('click', () => setMode('boats'));
  $('modeProducts').addEventListener('click', () => setMode('products'));
  wireHelp();
  $('saveCodes').addEventListener('click', saveCodesFile);
  $('loadCodes').addEventListener('click', () => $('codesFile').click());
  $('codesFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';                      // so the same file can be picked twice
    if (f) reviewCodesFile(f);
  });
  $('previewSheet').addEventListener('click', () => togglePreview());
  $('printSheet').addEventListener('click', () => window.print());
  render();

  // A rename made on the board page, or by the other manager, lands here
  // without a reload. Debounced because renaming a boat writes one document per
  // ERP code on the line, and each write fires its own snapshot.
  let t = null;
  const stop = Store.watchCodes((m) => {
    codeMap = m;
    clearTimeout(t);
    t = setTimeout(render, 150);
  });
  window.addEventListener('beforeunload', () => { try { stop(); } catch {} });
})();

function setMode(m) {
  mode = m;
  $('modeBoats').setAttribute('aria-current', m === 'boats' ? 'page' : 'false');
  $('modeProducts').setAttribute('aria-current', m === 'products' ? 'page' : 'false');
  render();
}

function render() {
  resolved = resolveDisplays(codeMap);
  renderWarnings();

  const rows = boatRows(codeMap, classify, { mode, facts });
  const host = $('rows');
  host.textContent = '';

  $('modeHint').textContent = mode === 'boats'
    ? `${rows.length} boats, tagged with the product line each is best known by.`
    : `${rows.length} lines — one per boat per product line, so a boat that builds `
      + 'both a lifter and a ladder appears in each.';

  // Grouped by category in priority order: lifters lead, then rotary.
  const counts = new Map();
  for (const r of rows) {
    const c = r.category ?? 'Nothing on the board';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }

  let current = null;
  for (const r of rows) {
    const cat = r.category ?? 'Nothing on the board';
    if (cat !== current) {
      current = cat;
      host.append(categoryHead(cat, counts.get(cat)));
    }
    if (collapsed.has(cat)) continue;
    host.append(boatRow(r));
  }

  renderSheet(rows);
}

/**
 * Keep the printable sheet in step with whatever the page is showing, so
 * "Print cheat sheet" never prints a different view from the one on screen.
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

  const fit = fitCodesSheet(host, rows, { mode });

  const status = $('sheetStatus');
  status.hidden = !sheetShown;
  status.classList.toggle('trimmed', !fit.fits || fit.shrunk);
  status.textContent = !fit.measured
    ? 'Could not measure the sheet.'
    : fit.fits && !fit.shrunk
      ? `One landscape A4 page at ${fit.pt}pt — ${rows.length} lines, `
        + `${fit.height} of ${fit.limit}px used.`
      : fit.fits
        ? `Type stepped down to ${fit.pt}pt to hold one page (${rows.length} lines). `
          + `Split by product adds rows, so the boats view will usually print larger.`
        : `Will not fit one page even at ${TYPE_STEPS[TYPE_STEPS.length - 1]}pt — `
          + `${rows.length} lines. It will run to a second page.`;
}

function togglePreview() {
  sheetShown = !sheetShown;
  $('previewSheet').classList.toggle('on', sheetShown);
  $('previewSheet').setAttribute('aria-pressed', String(sheetShown));
  render();
}

function categoryHead(cat, n) {
  const shut = collapsed.has(cat);
  const head = el('button', `codes-cat${shut ? ' is-collapsed' : ''}`);
  head.append(el('span', 'cat-caret', shut ? '▸' : '▾'));
  head.append(el('span', 'name', cat));
  head.append(el('span', 'n', String(n)));
  head.addEventListener('click', () => {
    if (collapsed.has(cat)) collapsed.delete(cat); else collapsed.add(cat);
    render();
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

function boatRow(r) {
  const row = el('div', 'code-row');

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

  // 3. What the manufacturer call it, and the hulls it has been fitted to.
  // What the cheat sheet prints, not every code the data carries — a boat with
  // three manufacturer codes should not put all three on a sheet of paper.
  const riv = el('div', `c-riv${r.modelSet ? ' is-set' : ''}`, r.model || '—');
  if (r.modelSet) riv.title = `Set by hand. Found in the data: ${r.riviera.join(', ') || 'none'}`;
  row.append(riv);
  row.append(el('div', 'c-hull', r.hulls.join(', ') || '—'));

  // The customer's own order number, from the latest export. Empty until one
  // has been imported — the code map is a map of boats, not an order book.
  const ord = el('div', 'c-order', r.orders.length ? r.orders.join(', ') : '—');
  if (r.orders.length > 2) ord.title = r.orders.join('\n');
  row.append(ord);

  // 4. Products. In boats mode a boat with several product lines shows them as
  //    chips; in products mode the row is already one category, so list items.
  const items = el('div', 'c-items');
  if (mode === 'boats' && r.categories.length > 1) {
    for (const c of r.categories) {
      const chip = el('span', 'c-catchip', shortCat(c));
      chip.title = r.byCategory.get(c).map((x) => x.item).join('\n');
      items.append(chip);
    }
  } else {
    for (const { item } of r.items) {
      // A davit's part number says nothing a person can use; its description
      // gives the capacity and the configuration, which is what the product IS.
      // Everywhere else the code is the more useful of the two.
      const desc = r.category === 'Davits' ? facts?.get(item)?.description : null;
      const chip = el('span', 'c-item', desc || item);
      if (desc) chip.title = item;
      items.append(chip);
    }
  }
  row.append(items);

  const act = el('div', 'c-act');
  const model = el('button', 'mini', 'Model');
  model.title = 'What the cheat sheet prints in the Model column';
  model.addEventListener('click', () => setModel(r));

  const edit = el('button', 'mini', 'Rename');
  edit.title = 'Change the code the floor reads. Applies to every ERP code on this line.';
  edit.addEventListener('click', () => rename(r));
  act.append(model, edit);

  const move = el('button', 'mini', 'Split');
  move.title = 'Move one ERP code onto a different boat';
  move.disabled = r.codes.length < 2;
  move.addEventListener('click', () => split(r));
  act.append(move);
  row.append(act);

  return row;
}

function renderWarnings() {
  const host = $('warnings');
  host.textContent = '';

  for (const c of resolved.conflicts) {
    const d = el('details', 'panel alert');
    d.open = true;
    d.append(el('summary', null, 'Vessel code conflict — two confirmed answers for one boat'));
    const b = el('div', 'body');
    b.append(el('div', null,
      `${c.codes.join(' and ')} are grouped together but confirmed to different `
      + `display codes: ${c.values.map((v) => `${v.code} → ${v.display}`).join(', ')}. `
      + 'Rename the line to settle it.'));
    d.append(b);
    host.append(d);
  }

  if (resolved.undecided.length) {
    const d = el('details', 'panel');
    d.append(el('summary', null, `Awaiting confirmation (${resolved.undecided.length})`));
    const b = el('div', 'body');
    for (const u of resolved.undecided) {
      b.append(el('div', null,
        `${u.codes.join(', ')} — showing "${u.provisional}", auto-seeded and never checked.`));
    }
    d.append(b);
    host.append(d);
  }
}

/**
 * Rename a boat. The display and the grouping key move together — keeping them
 * equal is what stops a line printing one code while grouping under another,
 * which is how XX01 and XX11 ended up on separate rows.
 */
async function rename(r) {
  const next = prompt(
    'What should the floor read for this boat?\n\n'
    + `ERP codes on this line: ${r.codes.join(', ')}\n`
    + `Model: ${r.riviera.join(', ') || 'not recorded'}\n\n`
    + 'Code only — the product wording comes from the template.',
    r.display,
  );
  if (next === null) return;
  const value = next.trim();
  if (!value) { toast('A display code cannot be empty.'); return; }

  for (const c of r.codes) {
    codeMap[c] = { ...(codeMap[c] ?? {}), display: value, boat: value, _confirmed: true };
    await Store.saveCode(c, { display: value, boat: value, _confirmed: true });
  }
  render();
  toast(`${r.codes.join(' / ')} now print as "${value}".`);
}

/** Move one ERP code off this boat, onto its own line or onto another boat. */
async function split(r) {
  const which = prompt(
    `Which ERP code should move off "${r.display}"?\n\n${r.codes.join('\n')}`,
    r.codes[r.codes.length - 1],
  );
  if (which === null) return;
  const code = which.trim().toUpperCase();
  if (!r.codes.includes(code)) { toast(`${code} is not on this line.`); return; }

  const to = prompt(
    `What should ${code} read instead?\n\n`
    + 'Type an existing boat’s code to merge it there, or something new to give '
    + 'it a line of its own.',
    code,
  );
  if (to === null) return;
  const value = to.trim();
  if (!value) { toast('A display code cannot be empty.'); return; }

  codeMap[code] = { ...(codeMap[code] ?? {}), display: value, boat: value, _confirmed: true };
  await Store.saveCode(code, { display: value, boat: value, _confirmed: true });
  render();
  toast(`${code} now reads "${value}".`);
}

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
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
// Save is also the backup. Firestore is the source of truth and there is no
// other copy of a decision somebody made by hand.
// ---------------------------------------------------------------------------

/**
 * What the latest export knows about each item code: its description, and the
 * customer's order number.
 *
 * Best effort. This page is about the code map and works without any of it, so
 * a missing or unreadable import is an empty map rather than an error.
 */
async function loadFacts() {
  try {
    const cached = Store.cachedRows?.();
    if (cached?.rows?.length) return itemFacts(cached.rows);
    const published = await Store.latestBoard();
    const rows = published?.rowsJson ? unpackRows(published.rowsJson) : null;
    return itemFacts(rows ?? []);
  } catch (e) {
    console.warn('[facts]', e.message);
    return new Map();
  }
}

function saveCodesFile() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const blob = new Blob([JSON.stringify(codeMap, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vessel-codes-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`${Object.keys(codeMap).length} codes saved. Keep it out of the repository.`);
}

/** A code entry is an object; everything else in the file is refused. */
function validCodeMap(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'That is not a code map.';
  const codes = Object.keys(data);
  if (!codes.length) return 'That file has no codes in it.';
  const bad = codes.filter((c) => {
    const v = data[c];
    return !v || typeof v !== 'object' || Array.isArray(v);
  });
  if (bad.length) return `${bad.length} entries are not code records: ${bad.slice(0, 3).join(', ')}`;
  return null;
}

async function reviewCodesFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    toast(`Could not read that file — ${e.message}`, 6000);
    return;
  }
  const problem = validCodeMap(data);
  if (problem) { toast(problem, 6000); return; }

  // NOTHING IS WRITTEN UNTIL IT IS CONFIRMED, and what changes is spelled out
  // first: this overwrites hand-made decisions, which is the whole point and
  // also the reason to look before doing it.
  const fresh = [], changed = [], same = [];
  for (const [code, entry] of Object.entries(data)) {
    const now = codeMap[code];
    if (!now) fresh.push(code);
    else if (JSON.stringify({ ...now, ...entry }) !== JSON.stringify(now)) {
      changed.push({ code, from: now.display ?? '—', to: entry.display ?? now.display ?? '—' });
    } else same.push(code);
  }

  const host = $('codesLoad');
  host.hidden = false;
  host.textContent = '';
  host.append(el('h2', null, 'Load these codes?'));
  host.append(el('div', 'lede',
    `${file.name} — ${Object.keys(data).length} codes. Nothing is written until you apply it.`));

  const grid = el('div', 'import-stats');
  const stat = (n, label, note) => {
    const c = el('div', 'stat');
    c.append(el('b', null, String(n)), el('span', null, label));
    if (note) c.append(el('em', null, note));
    grid.append(c);
  };
  stat(fresh.length, 'new codes');
  stat(changed.length, 'changed', changed.length ? 'existing decisions overwritten' : '');
  stat(same.length, 'unchanged');
  host.append(grid);

  if (changed.length) {
    const list = el('div', 'flag-rows');
    for (const c of changed.slice(0, 40)) {
      const r = el('div', 'flag-row');
      r.append(el('span', 'fr-key', c.code), el('span', 'fr-main', `${c.from} → ${c.to}`),
        el('span', 'fr-detail', ''), el('span', 'fr-act', ''));
      list.append(r);
    }
    host.append(el('div', 'detail-group', `Changing (${changed.length})`));
    host.append(list);
  }

  const acts = el('div', 'import-actions');
  const apply = el('button', 'primary', `Load ${Object.keys(data).length} codes`);
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    try {
      const n = await Store.putCodes(data);
      codeMap = await Store.loadCodes();
      host.hidden = true;
      $('codesEmpty').hidden = true;
      render();
      toast(`${n} codes loaded.`);
    } catch (e) {
      apply.disabled = false;
      toast(`Could not save — ${e.message}`, 8000);
    }
  });
  const cancel = el('button', 'ghost', 'Cancel');
  cancel.addEventListener('click', () => { host.hidden = true; });
  acts.append(apply, cancel);
  host.append(acts);
  host.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/**
 * Choose what the cheat sheet prints in the Model column.
 *
 * A boat can carry several manufacturer codes — a plain one, the same with a
 * voltage, one with a note appended — and the sheet has room for one. Sometimes
 * the right answer is none of them, so this takes free text as well as the
 * codes found in the data.
 *
 * Stored on the boat, affects the cheat sheet only.
 */
async function setModel(r) {
  const found = r.riviera;
  const current = r.modelSet ? r.model : '';
  const next = prompt(
    `Model column on the cheat sheet for ${r.display}.\n\n`
    + `Found in the data: ${found.join(', ') || 'none'}\n\n`
    + 'Type one of those, or anything else. Leave empty to show them all.',
    current,
  );
  if (next === null) return;
  const value = next.trim();
  try {
    // Written to every code on the line so it survives a split or a rename of
    // any one of them.
    for (const code of r.codes) await Store.saveCode(code, { sheetModel: value || null });
    codeMap = await Store.loadCodes();
    render();
    toast(value ? `${r.display} prints "${value}".` : `${r.display} shows every model code.`);
  } catch (e) {
    toast(`Could not save — ${e.message}`, 6000);
  }
}
