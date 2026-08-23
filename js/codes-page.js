// codes-page.js — the vessel code table.
//
// Pete expects edits here to be very sparse: one or two ever per product line.
// So it is a plain editable table, no versioning.

import { Store } from './store.js';
import { resolveDisplays } from './vessel-codes.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let codeMap = {};
let resolved = null;

(async function boot() {
  await Store.init();
  $('storeMode').textContent = Store.mode === 'firestore' ? 'Saved to Firestore' : 'Saved on this device only';
  if (Store.mode !== 'firestore') $('storeMode').style.color = 'var(--red-bright)';
  codeMap = await Store.loadCodes();
  render();
})();

function render() {
  resolved = resolveDisplays(codeMap);
  renderWarnings();

  const tbody = $('rows');
  tbody.textContent = '';

  // Group members sit next to each other so the shared display is obvious.
  const ordered = resolved.groups.flatMap((g) => g.codes.map((c) => ({ code: c, group: g })));

  for (const { code, group } of ordered) {
    const e = codeMap[code] ?? {};
    const isAlias = group.codes.length > 1;
    const tr = el('tr', isAlias ? 'alias' : '');

    const c = el('td', 'code');
    c.append(document.createTextNode(code));
    if (isAlias) { c.append(document.createTextNode(' ')); c.append(el('span', 'chip alias', 'ALIAS')); }
    tr.append(c);

    tr.append(el('td', null, (e.riviera ?? []).join(', ') || '—'));
    tr.append(el('td', null, (e.hull_prefix ?? []).join(', ') || '—'));

    const d = el('td', 'display');
    d.append(document.createTextNode(resolved.display.get(code) ?? code));
    d.append(document.createTextNode(' '));

    // Confirmation is a property of the boat, not of the row. A code that
    // follows a confirmed sibling is displaying a confirmed value, and marking
    // it UNCONFIRMED would invite someone to "fix" a decision Pete already made.
    const confirmedBy = group.codes.filter((c) => codeMap[c]?._confirmed);
    if (confirmedBy.length) {
      const via = e._confirmed ? 'CONFIRMED' : `CONFIRMED via ${confirmedBy.join(', ')}`;
      d.append(el('span', 'chip ok', via));
    } else {
      d.append(el('span', 'chip no', 'UNCONFIRMED'));
    }

    if (group.corrected?.includes(code)) {
      d.append(document.createTextNode(' '));
      const was = el('span', 'chip alias', `was ${e.display ?? code}`);
      was.title = `Same boat as ${group.codes.filter((x) => x !== code).join(', ')} — `
        + `they must print the same code.`;
      d.append(was);
    }
    tr.append(d);

    tr.append(el('td', 'items', (e.items ?? []).join('  ·  ') || '—'));

    const act = el('td');
    const b = el('button', 'mini', 'Edit');
    b.addEventListener('click', () => edit(code, group));
    act.append(b);
    tr.append(act);

    tbody.append(tr);
  }
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
      `${c.codes.join(' and ')} both resolve to Riviera ${c.models.join(', ')}, ` +
      `but are confirmed to different display codes: ` +
      `${c.values.map((v) => `${v.code} → ${v.display}`).join(', ')}. ` +
      `Edit either row to set one answer for the whole group.`));
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

async function edit(code, group) {
  const current = resolved.display.get(code) ?? code;
  const scope = group.codes.length > 1
    ? `\n\nThis is one boat under ${group.codes.length} Stella codes (${group.codes.join(', ')}). ` +
      `All of them will display the new value.`
    : '';
  const next = prompt(
    `Display code for ${code}${scope}\n\n` +
    `Just the vessel code — the product wording is added by the template ` +
    `("SY22" becomes "SY22 Garage Door").`,
    current,
  );
  if (next === null) return;
  const value = next.trim();
  if (!value) { toast('A display code cannot be empty.'); return; }

  // Confirming one member confirms the boat.
  for (const c of group.codes) {
    codeMap[c] = { ...(codeMap[c] ?? {}), display: value, _confirmed: true };
    await Store.saveCode(c, { display: value, _confirmed: true });
  }
  render();
  toast(`${group.codes.join(' / ')} now display as "${value}".`);
}

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
