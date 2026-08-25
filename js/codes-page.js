// codes-page.js — the vessel code table, one line per boat.
//
// THE DISPLAY CODE IS THE BOAT.
//
// That is the identity everyone actually uses: the floor reads "56SY", not
// "SY23". So it is the key, the first column, and the thing you edit. The ERP
// codes sit beside it as evidence rather than as the heading.
//
// The old page listed one row per Stella code, which put SY20 and 43SY on
// separate lines despite their printing the same thing — it showed the plumbing
// instead of the answer.

import { Store } from './store.js';
import { resolveDisplays, boatRows } from './vessel-codes.js';
import { classify } from './rules.js';
import { Auth, ROLE } from './auth.js';

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

(async function boot() {
  // Floor accounts have no business here; the rules deny the writes anyway.
  await Auth.init((st) => {
    if (st.role === ROLE.FLOOR) { location.replace('./'); }
  });
  await Store.init();
  $('storeMode').textContent = Store.mode === 'firestore' ? 'Saved to Firestore' : 'Saved on this device only';
  if (Store.mode !== 'firestore') $('storeMode').style.color = 'var(--red-bright)';
  codeMap = await Store.loadCodes();

  $('modeBoats').addEventListener('click', () => setMode('boats'));
  $('modeProducts').addEventListener('click', () => setMode('products'));
  render();
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

  const rows = boatRows(codeMap, classify, { mode });
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

  // 3. What Riviera call it, and the hulls it has been fitted to.
  row.append(el('div', 'c-riv', r.riviera.join(', ') || '—'));
  row.append(el('div', 'c-hull', r.hulls.join(', ') || '—'));

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
    for (const { item } of r.items) items.append(el('span', 'c-item', item));
  }
  row.append(items);

  const act = el('div', 'c-act');
  const edit = el('button', 'mini', 'Rename');
  edit.title = 'Change the code the floor reads. Applies to every ERP code on this line.';
  edit.addEventListener('click', () => rename(r));
  act.append(edit);

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
 * which is how SY20 and 43SY ended up on separate rows.
 */
async function rename(r) {
  const next = prompt(
    'What should the floor read for this boat?\n\n'
    + `ERP codes on this line: ${r.codes.join(', ')}\n`
    + `Riviera call it: ${r.riviera.join(', ') || 'not recorded'}\n\n`
    + 'Just the vessel code — the product wording comes from the template, so '
    + '"56SY" becomes "56SY Garage Door".',
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
