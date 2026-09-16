// parts-page.js — the part list on screen: search it, correct it, import it.
//
// Three audiences on one page, shown by role:
//   - the floor, on a phone, looking a part up             -> Search
//   - drafting, noticing a description or bin is wrong      -> Corrections
//   - the manager who runs the export and can fix the ERP   -> Import
//
// Everything that decides is in parts.js; this draws and wires.

import { Store } from './store.js';
import { Auth, ROLE, setManagers, setEngineers } from './auth.js';
import { VERSION } from './version.js';
import { wireHelp } from './help.js';
import { readStockExport } from './adapters/stock.js';
import { downloadWorkbook } from './adapters/drafting-xlsx.js';
import {
  transformParts, validateStockExport, diffParts, unknownFamilies,
  buildIndex, search, browse, familyCounts, familyOf, hasBin, effective,
  createOverride, reconcile, resolveReview, overrideKey, isActive, clean,
  fixList, fixListCsv, ageInDays, STALE_DAYS, FAMILIES, META_FIELDS, metaLine,
  draftingSheets, workbookName,
} from './parts.js';

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
let role = ROLE.NONE;
let who = null;
let tab = 'search';
const filters = { family: null, bin: 'all', binFirst: false };
const open = new Set();     // expanded result cards, by id

function booting(what) {
  const box = $('booting');
  if (!box) return;
  if (what === false) { box.remove(); return; }
  $('bootWhat').textContent = what;
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(async function boot() {
  $('pageVersion').textContent = `v${VERSION}`;

  // Same shape as the codes page: the store comes up before the role is read,
  // because the access lists live in Firestore and Firebase reports the user
  // before the store exists.
  booting('Connecting');
  const first = await new Promise((resolve) => {
    let done = false;
    Auth.init((st) => { if (!done) { done = true; resolve(st); } });
  });
  await Store.init();
  booting('Checking your access');
  const access = await Store.loadAccess();
  setManagers(access.managers);
  setEngineers(access.engineers);
  role = Auth.refreshRole();
  who = first.email ?? null;

  document.body.classList.toggle('role-floor', role === ROLE.FLOOR);
  document.body.classList.toggle('role-engineer', role === ROLE.ENGINEER);
  document.body.classList.toggle('role-manager', role === ROLE.MANAGER);
  const whoami = $('whoami');
  whoami.textContent = Auth.mode === 'local' ? 'Local mode' : (who ?? '');
  $('signOut').hidden = Auth.mode === 'local';
  $('signOut').addEventListener('click', () => Auth.signOut().then(() => location.reload()));

  if (role === ROLE.NONE) {
    booting(false);
    const host = $('partsDenied');
    host.hidden = false;
    host.append(el('strong', null, 'Sign in to look up parts'));
    host.append(el('div', null, 'The part list is for signed-in accounts. Sign in on the board, then come back.'));
    const back = el('a', 'backlink', 'Go to the board');
    back.href = './';
    host.append(back);
    return;
  }

  $('storeMode').textContent = Store.mode === 'firestore' ? 'Saved to Firestore' : 'Saved on this device only';
  if (Store.mode !== 'firestore') $('storeMode').style.color = 'var(--red-bright)';

  booting('Loading the part list');
  await loadAll();
  booting(false);

  wireHelp();
  wireTabs();
  wireSearch();
  wireCorrect();
  wireFix();
  wireImport();

  $('partsTabs').hidden = false;
  showTab('search');
  renderAll();
})();

async function loadAll() {
  [record, overrides] = await Promise.all([Store.loadParts(), Store.loadPartOverrides()]);
  parts = record?.partsJson ? JSON.parse(record.partsJson) : [];
  partsById = new Map(parts.map((p) => [p.id, p]));
  index = buildIndex(parts, overrides);
}

function renderAll() {
  renderProvenance();
  $('partsEmpty').hidden = Boolean(parts.length) || role === ROLE.NONE;
  // A list loaded before type, unit and source were kept has none of them.
  // Only the importer can do anything about that, so the note is on their tab.
  $('partsReimport').hidden = !(parts.length && !parts.some((p) => META_FIELDS.some((f) => f in p)));
  renderPills();
  renderResults();
  renderFix();
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
const TABS = { search: 'ptSearch', fix: 'ptFix', import: 'ptImport' };

function wireTabs() {
  $('ptSearchBtn').addEventListener('click', () => showTab('search'));
  $('ptFixBtn').addEventListener('click', () => showTab('fix'));
  $('ptImportBtn').addEventListener('click', () => showTab('import'));
}

function showTab(which) {
  if (which === 'fix' && !Auth.canEditParts) which = 'search';
  if (which === 'import' && !Auth.canImportParts) which = 'search';
  tab = which;
  for (const [key, id] of Object.entries(TABS)) {
    $(id).hidden = key !== which;
    $(`pt${key[0].toUpperCase()}${key.slice(1)}Btn`).setAttribute('aria-current', key === which ? 'page' : 'false');
  }
  if (which === 'search') $('q').focus({ preventScroll: true });
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
let debounce = null;

function wireSearch() {
  $('q').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(renderResults, 150);
  });
  for (const b of document.querySelectorAll('.pills-bin [data-bin]')) {
    b.addEventListener('click', () => {
      filters.bin = b.dataset.bin;
      for (const x of document.querySelectorAll('.pills-bin [data-bin]')) {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      }
      renderResults();
    });
  }
  $('binFirst').addEventListener('click', () => {
    filters.binFirst = !filters.binFirst;
    $('binFirst').classList.toggle('on', filters.binFirst);
    $('binFirst').setAttribute('aria-pressed', String(filters.binFirst));
    renderResults();
  });
  // Tap a card to open it; controls inside are their own thing. Only that
  // card is redrawn: the list may be two thousand rows deep, and rebuilding
  // it would drop the scroll position and every chunk loaded so far.
  $('results').addEventListener('click', (e) => {
    if (e.target.closest('button, a, input')) return;
    // A drag that ends with text highlighted is a highlight, not a tap. The
    // card stays as it is — redrawing it would throw the selection away —
    // and the text can be copied. A plain click collapses any selection
    // before this runs, so it still opens the card.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const card = e.target.closest('.part');
    if (!card) return;
    const id = card.dataset.id;
    if (open.has(id)) open.delete(id); else open.add(id);
    redrawCard(id);
  });
  // The whole list as the old drafting workbook. Not the filtered view: the
  // sheet is the thing people keep, and a filter is the thing of the moment.
  $('xlsxAll').addEventListener('click', async () => {
    const btn = $('xlsxAll');
    if (!parts.length) { toast('Nothing to download yet.'); return; }
    btn.disabled = true;
    btn.textContent = 'Building…';
    try {
      await downloadWorkbook(draftingSheets(parts, overrides, { exportDate: record?.exportDate }), workbookName());
      toast('Workbook downloaded — one tab per family, corrections applied.');
    } catch (e) {
      toast(e.message, 8000);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Download Excel';
    }
  });
}

function renderPills() {
  const host = $('familyPills');
  host.textContent = '';
  const counts = familyCounts(index);
  const all = el('button', `pill${filters.family ? '' : ' on'}`, `All`);
  all.append(el('span', 'pill-n', String(index.length)));
  all.addEventListener('click', () => { filters.family = null; renderPills(); renderResults(); });
  host.append(all);
  for (const f of FAMILIES) {
    if (!counts[f]) continue;
    const b = el('button', `pill${filters.family === f ? ' on' : ''}`, f);
    b.append(el('span', 'pill-n', String(counts[f])));
    b.setAttribute('aria-pressed', String(filters.family === f));
    b.addEventListener('click', () => {
      filters.family = filters.family === f ? null : f;
      renderPills();
      renderResults();
    });
    host.append(b);
  }
}

function renderResults() {
  const host = $('results');
  const meta = $('resultsMeta');
  host.textContent = '';
  listing = { entries: [], shown: 0 };
  if (!parts.length) { meta.textContent = ''; $('resultsHead').hidden = true; return; }

  const q = clean($('q').value);
  let entries;
  if (q) {
    const { hits, total } = search(index, q, { limit: Infinity });
    entries = hits.map((h) => h.entry);
    if (filters.family) entries = entries.filter((e) => e.family === filters.family);
    if (filters.bin === 'with') entries = entries.filter((e) => hasBin(e.eff.bin));
    if (filters.bin === 'without') entries = entries.filter((e) => !hasBin(e.eff.bin));
    meta.textContent = total
      ? `${entries.length} match${entries.length === 1 ? '' : 'es'}`
      : 'Nothing matches — try fewer words, or just the size.';
  } else {
    entries = browse(index, filters);
    meta.textContent = `${entries.length} part${entries.length === 1 ? '' : 's'}`
      + `${filters.family ? ` in ${filters.family}` : ''}${filters.bin !== 'all' ? ` · ${filters.bin === 'with' ? 'with a bin' : 'without a bin'}` : ''}`;
  }

  // The code column fits the longest code in the list: a phone-width column
  // ran twenty-character model codes into their descriptions, and a column
  // wide enough for those wasted the row for the six-character majority.
  // Monospace at 14px is under 8.6px a character in every font the page can
  // land on; the stylesheet clips with an ellipsis if one is wider.
  const longest = entries.reduce((n, e) => Math.max(n, e.part.id.length), 7);
  $('ptSearch').style.setProperty('--code-w', `${Math.round(longest * 8.6 + 6)}px`);
  $('resultsHead').hidden = !entries.length;

  listing = { entries, shown: 0 };
  appendChunk();
}

// ---- the list, in chunks ----------------------------------------------------
//
// The whole list is on offer — scrolling all of it was one of the things the
// spreadsheet was good for — but two thousand cards built in one go is a
// second of nothing on a phone. So the first chunk is built at once and the
// rest as the end of the list comes into view, well before it is reached.
const CHUNK = 200;
let listing = { entries: [], shown: 0 };
const moreObserver = new IntersectionObserver((hits) => {
  if (hits.some((h) => h.isIntersecting)) appendChunk();
}, { rootMargin: '800px 0px' });
// Belt and braces: a scroll that brings the end within reach builds the next
// chunk too, for a webview whose observer is late or missing.
window.addEventListener('scroll', () => {
  const s = $('moreSentinel');
  if (s && s.getBoundingClientRect().top < innerHeight + 800) appendChunk();
}, { passive: true });

function appendChunk() {
  const host = $('results');
  const old = $('moreSentinel');
  if (old) { moreObserver.unobserve(old); old.remove(); }
  const next = listing.entries.slice(listing.shown, listing.shown + CHUNK);
  const frag = document.createDocumentFragment();
  for (const e of next) frag.append(partCard(e));
  listing.shown += next.length;
  host.append(frag);
  const left = listing.entries.length - listing.shown;
  if (left > 0) {
    const s = el('div', 'more-sentinel', `${left} more — keep scrolling`);
    s.id = 'moreSentinel';
    s.addEventListener('click', appendChunk);   // a browser with no observer still gets there
    host.append(s);
    moreObserver.observe(s);
  }
}

/** Redraw one card in place, from the entry the list holds for it. */
function redrawCard(id) {
  const card = $('results').querySelector(`.part[data-id="${CSS.escape(id)}"]`);
  const entry = listing.entries.find((e) => e.part.id === id);
  if (card && entry) card.replaceWith(partCard(entry));
}

/**
 * After a correction the index has been rebuilt, so the list's entries are
 * stale. Swap every entry for its new self — order, scroll position and the
 * chunks on screen all stay — and redraw the cards that actually changed.
 */
function refreshEntries(changedIds) {
  const byId = new Map(index.map((e) => [e.part.id, e]));
  listing.entries = listing.entries.map((e) => byId.get(e.part.id) ?? e);
  for (const id of changedIds) redrawCard(id);
}

function partCard(e) {
  const p = e.part;
  const eff = e.eff;
  const isOpen = open.has(p.id);
  const card = el('div', `part${hasBin(eff.bin) ? '' : ' no-bin'}${isOpen ? ' is-open' : ''}`);
  card.dataset.id = p.id;

  const head = el('div', 'part-head');
  head.append(el('span', 'part-code', p.id));
  const d = el('span', 'part-desc', eff.desc || '(no description)');
  if (eff.descOv) d.append(badge(eff.descOv));
  head.append(d);
  // Type, source, unit: columns of their own on a desktop; on a phone the
  // stylesheet hides these and shows the one-line version in the open card.
  for (const f of ['type', 'source', 'unit']) {
    const m = el('span', 'part-meta', p[f] ?? '');
    m.title = p[f] ?? '';
    head.append(m);
  }
  const binWrap = el('span', 'part-bin');
  binWrap.append(el('span', `bin-chip${hasBin(eff.bin) ? '' : ' none'}`, hasBin(eff.bin) ? eff.bin : 'No bin set'));
  if (eff.binOv) binWrap.append(badge(eff.binOv));
  head.append(binWrap);
  card.append(head);

  if (isOpen) {
    const body = el('div', 'part-body');
    const ml = metaLine(p);
    if (ml) body.append(el('div', 'part-meta-line', ml));
    const acts = el('div', 'part-acts');
    // Code and description on one line, the way it is written into an email
    // or a drawing note. The description is the one on screen — corrected,
    // if it has been.
    const copy = el('button', 'mini', 'Copy');
    copy.title = 'Copy the code and description as one line';
    copy.addEventListener('click', async () => {
      const line = eff.desc ? `${p.id} - ${eff.desc}` : p.id;
      try { await navigator.clipboard.writeText(line); toast(`Copied: ${line}`); }
      catch { toast('Could not copy — highlight it and copy by hand.', 5000); }
    });
    acts.append(copy);
    if (Auth.canEditParts) {
      const cd = el('button', 'mini', 'Correct description');
      cd.addEventListener('click', () => openCorrect(p, 'desc'));
      const cb = el('button', 'mini', 'Correct bin');
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
        + `${ov.importsPending ? ` · unfixed through ${ov.importsPending} export${ov.importsPending === 1 ? '' : 's'}` : ''}`
        + `${ov.status === 'review' ? ' · IN REVIEW' : ''}`));
      body.append(note);
    }
    card.append(body);
  }
  return card;
}

function badge(ov) {
  return el('span', `part-badge${ov.status === 'review' ? ' review' : ''}`,
    ov.status === 'review' ? 'Needs review' : 'Corrected · ERP pending');
}

// ---------------------------------------------------------------------------
// correct
// ---------------------------------------------------------------------------
let correcting = null;   // { part, field }

function wireCorrect() {
  $('coDesc').addEventListener('click', () => setCorrectField('desc'));
  $('coBin').addEventListener('click', () => setCorrectField('bin'));
  $('coCancel').addEventListener('click', closeCorrect);
  $('coSave').addEventListener('click', saveCorrect);
  $('correctOverlay').addEventListener('click', (e) => { if (e.target === $('correctOverlay')) closeCorrect(); });
  $('coValue').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCorrect(); });
  $('coReason').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCorrect(); });
}

function openCorrect(part, field) {
  correcting = { part, field };
  $('coTitle').textContent = `Correct ${part.id}`;
  $('coLede').textContent = 'The app shows your value from now on. The ERP is not changed — this goes on the list for the person who can.';
  $('coErr').textContent = '';
  setCorrectField(field);
  $('correctOverlay').classList.add('show');
  setTimeout(() => $('coValue').focus(), 30);
}

function setCorrectField(field) {
  if (!correcting) return;
  correcting.field = field;
  for (const b of [$('coDesc'), $('coBin')]) {
    const on = b.dataset.field === field;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const cur = correcting.part[field] || '';
  $('coCurrent').textContent = field === 'bin' && !hasBin(cur) ? `${cur || '(blank)'} — not a bin location` : (cur || '(blank)');
  const existing = overrides[overrideKey(correcting.part.id, field)];
  $('coValue').value = isActive(existing) ? existing.value : '';
  $('coReason').value = isActive(existing) ? existing.reason : '';
}

function closeCorrect() {
  $('correctOverlay').classList.remove('show');
  correcting = null;
}

async function saveCorrect() {
  if (!correcting) return;
  const { part, field } = correcting;
  $('coErr').textContent = '';
  try {
    const o = createOverride({
      partId: part.id, field, value: $('coValue').value, reason: $('coReason').value, by: who, part,
    });
    const key = overrideKey(part.id, field);
    const existing = overrides[key];
    // Re-correcting keeps the original creation and count; only the answer moves.
    const data = isActive(existing)
      ? { ...existing, value: o.value, reason: o.reason, baseline: o.baseline, status: 'pending',
          reviewReason: null, observed: null, updatedAt: o.updatedAt }
      : o;
    await Store.setPartOverride(key, data);
    overrides = await Store.loadPartOverrides();
    index = buildIndex(parts, overrides);
    closeCorrect();
    refreshEntries([part.id]);
    renderFix();
    toast(`${part.id} corrected here. It is on the list for the ERP.`);
  } catch (e) {
    $('coErr').textContent = e.message;
  }
}

// ---------------------------------------------------------------------------
// corrections tab: the review queue and the fix list
// ---------------------------------------------------------------------------
function wireFix() {
  $('copyFix').addEventListener('click', async () => {
    const list = fixList(overrides, partsById);
    const text = list.map((o) => `${o.partId}  ${o.field === 'desc' ? 'Description' : 'Bin'}\n`
      + `  ERP says:  ${o.current ?? o.baseline}\n  Should be: ${o.value}\n  Why: ${o.reason}`).join('\n\n');
    try { await navigator.clipboard.writeText(text); toast(`${list.length} corrections copied.`); }
    catch { toast('Could not copy.', 5000); }
  });
  $('csvFix').addEventListener('click', () => {
    const list = fixList(overrides, partsById);
    const blob = new Blob([fixListCsv(list)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `part-corrections-${new Date().toISOString().slice(0, 10)}.csv`;
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
    rq.append(el('h3', null, `Needs a decision (${review.length})`));
    rq.append(el('div', 'flag-note',
      'The ERP moved, but not to the corrected value — or the part is gone from the export. '
      + 'Somebody who knows which is right decides; the importer does not.'));
    for (const o of review) {
      const row = el('div', 'fix-row review');
      row.append(el('div', 'fix-key', `${o.partId} · ${o.field === 'desc' ? 'Description' : 'Bin'}`));
      const why = o.reviewReason === 'missing_from_export'
        ? 'This code is no longer in the export.'
        : `ERP now says "${o.observed ?? o.current ?? '—'}" — neither the old value nor your correction.`;
      row.append(el('div', 'fix-why', why));
      row.append(el('div', 'fix-vals', `Correction: "${o.value}"  ·  was: "${o.baseline}"`));
      row.append(el('div', 'fix-reason dim', o.reason));
      const acts = el('div', 'fix-acts');
      const keep = el('button', 'mini', 'Keep correction');
      keep.addEventListener('click', () => decide(o, 'keep'));
      const accept = el('button', 'mini', 'Accept ERP');
      accept.addEventListener('click', () => decide(o, 'accept'));
      const edit = el('button', 'mini', 'Edit');
      edit.addEventListener('click', () => {
        const v = prompt(`New value for ${o.partId} ${o.field}:`, o.value);
        if (v === null) return;
        decide(o, 'edit', v);
      });
      if (o.reviewReason === 'missing_from_export') {
        // Nothing to keep against. The choices are drop it, or leave it here.
        keep.disabled = true;
        keep.title = 'The part is not in the export, so there is nothing to keep this against.';
      }
      acts.append(keep, accept, edit);
      row.append(acts);
      rq.append(row);
    }
  }

  // --- the fix list ---
  const fl = $('fixList');
  fl.textContent = '';
  fl.append(el('h3', null, pending.length ? `Fix these in the ERP (${pending.length})` : 'Nothing waiting on the ERP'));
  if (!pending.length && !review.length) {
    fl.append(el('div', 'flag-note', 'Open a part and use Correct to add one. It appears here until an export shows the ERP agrees.'));
    return;
  }
  const table = el('div', 'fix-table');
  const head = el('div', 'fix-row fix-head');
  for (const h of ['Code', 'Field', 'ERP says', 'Should be', 'Why', 'Since']) head.append(el('span', null, h));
  table.append(head);
  for (const o of pending) {
    const row = el('div', 'fix-row');
    row.append(el('span', 'mono', o.partId));
    row.append(el('span', null, o.field === 'desc' ? 'Description' : 'Bin'));
    row.append(el('span', 'dim', o.current ?? o.baseline ?? '—'));
    row.append(el('span', 'strong', o.value));
    row.append(el('span', 'dim', o.reason));
    const since = el('span', 'dim', fmtDate(o.createdAt));
    if (o.importsPending) since.title = `Still unfixed after ${o.importsPending} export${o.importsPending === 1 ? '' : 's'}`;
    row.append(since);
    table.append(row);
  }
  fl.append(table);
}

async function decide(o, action, value = null) {
  try {
    const next = resolveReview(o, action, { value, by: who, part: partsById.get(o.partId) ?? null });
    await Store.setPartOverride(overrideKey(o.partId, o.field), next);
    overrides = await Store.loadPartOverrides();
    index = buildIndex(parts, overrides);
    refreshEntries([o.partId]);
    renderFix();
    toast(action === 'accept' ? `${o.partId}: ERP accepted.` : `${o.partId}: correction kept.`);
  } catch (e) {
    toast(e.message, 6000);
  }
}

/**
 * Load corrections from a file — how the ones carried over from the old
 * drafting sheet get in, and how a backup comes back. Checked against the
 * current export before anything is written, so a correction the ERP has
 * already caught up with is reported rather than created.
 */
async function reviewFixFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { toast(`Could not read that file — ${e.message}`, 6000); return; }
  const list = Array.isArray(data) ? data : data?.overrides;
  if (!Array.isArray(list)) { toast('That file has no "overrides" list.', 6000); return; }
  if (!parts.length) { toast('Load the part list before loading corrections.', 6000); return; }

  const toWrite = {};
  const outcomes = { pending: [], review: [], fixed: [], unknown: [], bad: [] };
  for (const o of list) {
    const part = partsById.get(o.partId);
    if (!part) { outcomes.unknown.push(o.partId); continue; }
    if (!['desc', 'bin'].includes(o.field) || !clean(o.value) || !clean(o.reason)) { outcomes.bad.push(o.partId); continue; }
    const N = clean(part[o.field]);
    const key = overrideKey(o.partId, o.field);
    const base = {
      partId: o.partId, field: o.field, value: clean(o.value), baseline: clean(o.baseline ?? N),
      reason: clean(o.reason), createdBy: who, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), importsPending: 0, resolution: null,
      lastCheckedExportDate: record?.exportDate ?? null, resolvedAt: null, resolvedBy: null,
      source: o.source ?? file.name,
    };
    if (N === clean(o.value)) { outcomes.fixed.push(o.partId); continue; }
    if (N === clean(o.baseline ?? N)) { toWrite[key] = { ...base, status: 'pending', reviewReason: null }; outcomes.pending.push(o.partId); }
    else { toWrite[key] = { ...base, status: 'review', reviewReason: 'myob_changed', observed: N }; outcomes.review.push(o.partId); }
  }

  const host = $('fixLoad');
  host.hidden = false;
  host.textContent = '';
  host.append(el('h2', null, 'Load these corrections?'));
  host.append(el('div', 'lede', `${file.name} — ${list.length} in the file. Checked against the export dated ${fmtDate(record?.exportDate)}. Nothing is written until you apply.`));
  const grid = el('div', 'import-stats');
  const stat = (n, label, note) => {
    const c = el('div', 'stat');
    c.append(el('b', null, String(n)), el('span', null, label));
    if (note) c.append(el('em', null, note));
    grid.append(c);
  };
  stat(outcomes.pending.length, 'to load as pending');
  stat(outcomes.review.length, 'to load for review', outcomes.review.length ? 'ERP has moved since the file was made' : '');
  stat(outcomes.fixed.length, 'already fixed in the ERP', outcomes.fixed.length ? 'not loaded — nothing to correct' : '');
  stat(outcomes.unknown.length + outcomes.bad.length, 'skipped', outcomes.unknown.length ? 'code not in the export' : '');
  host.append(grid);
  const acts = el('div', 'import-actions');
  const apply = el('button', 'primary', `Load ${Object.keys(toWrite).length}`);
  apply.disabled = !Object.keys(toWrite).length;
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    try {
      await Store.setPartOverrides(toWrite);
      overrides = await Store.loadPartOverrides();
      index = buildIndex(parts, overrides);
      host.hidden = true;
      refreshEntries(Object.values(toWrite).map((o) => o.partId));
      renderFix();
      toast(`${Object.keys(toWrite).length} corrections loaded.`);
    } catch (e) { apply.disabled = false; toast(`Could not save — ${e.message}`, 8000); }
  });
  const cancel = el('button', 'ghost', 'Cancel');
  cancel.addEventListener('click', () => { host.hidden = true; });
  acts.append(apply, cancel);
  host.append(acts);
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------
let staged = null;

function wireImport() {
  const zone = $('dropZone');
  zone.addEventListener('click', () => $('partsFile').click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) stageImport(f);
  });
  $('partsFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) stageImport(f);
  });
}

async function stageImport(file) {
  const host = $('partsReview');
  host.hidden = false;
  host.textContent = '';
  host.append(el('div', 'lede', `Reading ${file.name}…`));
  let src;
  try {
    src = await readStockExport(file);
  } catch (e) {
    host.textContent = '';
    host.append(el('div', 'import-clean', `Could not read that file — ${e.message}`));
    return;
  }
  const { parts: fresh, excluded } = transformParts(src.rows);
  const { errors, warnings } = validateStockExport({
    sheetNames: src.sheetNames, title: src.title, headings: src.headings, savedFilter: src.savedFilter,
    exportDate: src.exportDate, count: fresh.length, excluded,
    current: record ? { exportDate: record.exportDate, count: record.count } : null,
  });
  host.textContent = '';
  host.append(el('h2', null, 'Review this import'));
  host.append(el('div', 'lede', `${file.name} — exported ${src.exportDate ? fmtDate(src.exportDate) : 'on an unknown date'}. `
    + `${src.rows.length} rows, ${fresh.length} parts. Nothing changes until you apply it.`));

  if (errors.length) {
    for (const m of errors) host.append(el('div', 'flag flag-bad import-err', m));
    host.append(el('div', 'import-clean', 'This file was not imported.'));
    return;
  }

  const nextById = new Map(fresh.map((p) => [p.id, p]));
  const d = diffParts(parts, fresh);
  const { updated, notices } = reconcile(overrides, nextById, src.exportDate ?? new Date().toISOString());
  staged = { src, fresh, excluded, updated, notices, d };

  const grid = el('div', 'import-stats');
  const stat = (n, label, note) => {
    const c = el('div', 'stat');
    c.append(el('b', null, String(n)), el('span', null, label));
    if (note) c.append(el('em', null, note));
    grid.append(c);
  };
  stat(fresh.length, 'parts', parts.length ? `${parts.length} loaded now` : 'first load');
  stat(d.added.length, 'new codes');
  stat(d.removed.length, 'codes gone');
  stat(d.descChanged.length, 'descriptions changed');
  stat(d.binChanged.length, 'bins changed');
  if (d.metaChanged.length) stat(d.metaChanged.length, 'type, unit or source changed');
  host.append(grid);

  for (const m of warnings) host.append(el('div', 'flag flag-warn import-warn', m));

  if (Object.keys(overrides).length) {
    const box = el('div', 'import-diff');
    box.append(el('b', null, 'Corrections:'));
    const part = (n, label, cls) => { if (!n) return; const x = el('span', `id-part ${cls}`); x.append(el('b', null, String(n)), el('span', null, label)); box.append(x); };
    part(notices.resolved.length, 'fixed in the ERP', 'is-new');
    part(notices.pending.length, 'still waiting', 'is-same');
    part(notices.review.length, 'need a decision', 'is-changed');
    if (!notices.resolved.length && !notices.pending.length && !notices.review.length) box.append(el('span', 'id-part is-same', 'none live'));
    host.append(box);
  }

  const lists = [
    ['New codes', d.added.map((id) => [id, nextById.get(id)?.desc ?? ''])],
    ['Codes gone', d.removed.map((id) => [id, partsById.get(id)?.desc ?? ''])],
    ['Descriptions changed', d.descChanged.map((c) => [c.id, `${c.from}  →  ${c.to}`])],
    ['Bins changed', d.binChanged.map((c) => [c.id, `${c.from || '(blank)'}  →  ${c.to || '(blank)'}`])],
    ['Type, unit or source changed', d.metaChanged.map((c) => [c.id, `${c.from || '(blank)'}  →  ${c.to || '(blank)'}`])],
    ['Fixed in the ERP', notices.resolved.map((o) => [o.partId, `${o.field}: "${o.value}"`])],
    ['Need a decision', notices.review.map((o) => [o.partId, o.reviewReason === 'missing_from_export' ? 'gone from the export' : `ERP now says "${o.observed}"`])],
  ];
  for (const [title, rows] of lists) {
    if (!rows.length) continue;
    const det = el('details', 'import-group');
    det.append(el('summary', null, `${title} (${rows.length})`));
    const t = el('div', 'flag-rows');
    for (const [k, v] of rows.slice(0, 200)) {
      const r = el('div', 'flag-row');
      r.append(el('span', 'fr-key', k), el('span', 'fr-main', v), el('span', 'fr-detail', ''), el('span', 'fr-act', ''));
      t.append(r);
    }
    det.append(t);
    host.append(det);
  }

  const acts = el('div', 'import-actions');
  const apply = el('button', 'primary', warnings.length ? 'Apply anyway' : 'Apply this import');
  apply.addEventListener('click', commitImport);
  const cancel = el('button', 'ghost', 'Cancel');
  cancel.addEventListener('click', () => { staged = null; host.hidden = true; });
  acts.append(apply, cancel);
  if (warnings.length) acts.append(el('span', 'hint', 'Read the warnings above first.'));
  host.append(acts);
}

async function commitImport() {
  if (!staged) return;
  const { src, fresh, updated, notices, d, excluded } = staged;
  const now = new Date().toISOString();
  const rec = {
    exportDate: src.exportDate ?? now,
    dateText: src.dateText,
    importedAt: now,
    importedBy: who,
    sourceLabel: src.sourceLabel,
    savedFilter: src.savedFilter,
    count: fresh.length,
    partsJson: JSON.stringify(fresh),
  };
  const btn = $('partsReview').querySelector('.primary');
  if (btn) btn.disabled = true;
  try {
    await Store.saveParts(rec);
    await Store.setPartOverrides(updated);
    await Store.logPartImport({
      exportDate: rec.exportDate, importedAt: now, importedBy: who, sourceLabel: rec.sourceLabel,
      count: fresh.length, added: d.added.length, removed: d.removed.length,
      descChanged: d.descChanged.length, binChanged: d.binChanged.length,
      fixed: notices.resolved.length, pending: notices.pending.length, review: notices.review.length,
      addedIds: d.added.slice(0, 100), removedIds: d.removed.slice(0, 100),
      unknownFamilies: unknownFamilies(excluded),
    });
  } catch (e) {
    if (btn) btn.disabled = false;
    toast(`Could not save — ${e.message}`, 8000);
    return;
  }
  staged = null;
  $('partsReview').hidden = true;
  await loadAll();
  renderAll();

  // What the importer does next: the list for the ERP.
  const after = $('partsAfter');
  after.hidden = false;
  after.textContent = '';
  after.append(el('h3', null, `Imported — ${fresh.length} parts as of ${fmtDate(rec.exportDate)}`));
  const live = fixList(overrides, partsById);
  if (live.length) {
    after.append(el('div', 'flag-note', `${live.length} correction${live.length === 1 ? '' : 's'} still waiting on the ERP. `
      + 'They are on the Corrections tab, with Copy and CSV.'));
    const go = el('button', 'mini', 'Open the list');
    go.addEventListener('click', () => showTab('fix'));
    after.append(go);
  } else {
    after.append(el('div', 'flag-note', 'Nothing is waiting on the ERP.'));
  }
  toast(`${fresh.length} parts loaded.`);
}

// ---------------------------------------------------------------------------
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
