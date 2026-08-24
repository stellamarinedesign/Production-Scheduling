// app.js — the manager view. Upload, review, edit, print.

import { xlsxAdapter } from './adapters/index.js';
import { buildBoard, byCategory, today, toAU, toDateOnly } from './transform.js';
import { CATEGORY_ORDER, PRINT_LAYOUT, EXCLUSION_ORDER, EXCLUSION_GROUP_LABEL } from './rules.js';
import { stellaCode, labelFor, existingBoats, acceptNewCode, applyTemplate } from './vessel-codes.js';
import { Auth, ROLE, friendlyAuthError } from './auth.js';
import { Store } from './store.js';
import { renderPrint, measure, fitToPage } from './print.js';
import { renderGantt } from './gantt.js';
import { balanceColumns } from './print.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  rows: null,
  source: null,
  codeMap: {},
  overrides: {},
  itemOverrides: {},
  gantt: { packed: false, all: false },
  settings: { horizonWeeks: 12, maxStock: null, autoFit: true },
  board: null,
  fit: null,
};

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

(async function boot() {
  wireAuth();

  await Auth.init(async (st) => {
    if (st.role === ROLE.NONE) { showAuth(); return; }
    await start(st);
  });
})();

function showAuth() {
  $('authView').classList.add('show');
  $('appShell').hidden = true;
}

let started = false;
async function start(st) {
  $('authView').classList.remove('show');
  $('appShell').hidden = false;

  // Role decides what is drawn. The Firestore rules decide what is allowed —
  // hiding a button is not security, it is tidiness.
  document.body.classList.toggle('role-floor', st.role === ROLE.FLOOR);
  document.body.classList.toggle('role-manager', st.role === ROLE.MANAGER);

  const who = $('whoami');
  who.textContent = st.mode === 'local' ? 'Local mode' : (st.email ?? '');
  const chip = el('span', `role ${st.role === ROLE.MANAGER ? 'manager' : ''}`,
    st.role === ROLE.MANAGER ? 'MANAGER' : 'FLOOR');
  who.append(chip);
  $('signOut').hidden = st.mode === 'local';

  if (started) { rebuild(); return; }
  started = true;

  await Store.init();

  // Floor accounts read the last published board and render the printed sheet.
  // No upload, no controls, no edit affordances — that is the whole point of
  // the role, and the rules deny those writes regardless.
  if (st.role === ROLE.FLOOR) { await startFloor(); return; }

  state.settings = await Store.loadSettings();
  state.codeMap = await Store.loadCodes();
  state.overrides = await Store.loadOverrides();
  state.itemOverrides = await Store.loadItemOverrides();

  $('horizon').value = state.settings.horizonWeeks;
  $('horizonVal').textContent = `${state.settings.horizonWeeks} weeks`;
  $('maxStock').value = state.settings.maxStock ?? '';
  setAutoFit(state.settings.autoFit, { save: false });

  $('provStore').textContent = Store.mode === 'firestore'
    ? 'Edits sync to Firestore'
    : `Local only — ${Store.reason}`;
  $('provStore').style.color = Store.mode === 'firestore' ? '' : 'var(--red-bright)';

  wireUpload();
  wireControls();
  wireOverlays();

  // A reload should not need a re-upload.
  const cached = Store.cachedRows();
  if (cached?.rows?.length) {
    state.rows = cached.rows;
    state.source = cached.source;
    rebuild();
    // A code added since the last load still needs answering.
    if (Auth.isManager) queueNewCodes();
  }
}

async function startFloor() {
  const published = await Store.latestBoard();
  if (!published?.jobs?.length) {
    $('floorEmpty').hidden = false;
    return;
  }
  state.board = { jobs: published.jobs, meta: published.meta, warnings: {}, excluded: [] };
  state.source = {
    sourceLabel: published.sourceLabel,
    sourceId: published.sourceId,
    retrievedAt: published.retrievedAt,
    warnings: [],
  };
  $('provenance').hidden = false;
  $('dropZone').hidden = true;
  $('boardWrap').hidden = false;
  renderProvenance();
  renderPrint($('printPreview'), state.board);
  showTab('print');
}

function wireAuth() {
  const submit = async () => {
    $('loginErr').textContent = '';
    $('loginBtn').disabled = true;
    try {
      await Auth.signIn($('loginEmail').value, $('loginPass').value);
      $('loginPass').value = '';
    } catch (e) {
      $('loginErr').textContent = friendlyAuthError(e);
    } finally {
      $('loginBtn').disabled = false;
    }
  };
  $('loginBtn').addEventListener('click', submit);

  // Lets somebody set a password nobody else has seen — including whoever
  // created their account. The account itself still comes from the console.
  $('resetBtn').addEventListener('click', async () => {
    const email = $('loginEmail').value.trim();
    const err = $('loginErr');
    if (!email) { err.textContent = 'Type your email address above first.'; return; }
    $('resetBtn').disabled = true;
    try {
      await Auth.sendPasswordReset(email);
      err.style.color = 'var(--text-dim)';
      // Firebase answers identically for an address that has no account, so
      // promising "it has been sent" would be a lie for a typo. Say what was
      // actually done, and where to look.
      err.textContent = `If ${email} has an account, a link to set a password is on its `
        + `way. It can take a minute, and it may land in junk mail.`;
    } catch (e) {
      err.style.color = '';
      err.textContent = friendlyAuthError(e);
    } finally {
      $('resetBtn').disabled = false;
    }
  });
  for (const id of ['loginEmail', 'loginPass']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
  $('signOut').addEventListener('click', () => Auth.signOut());
}

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

function wireUpload() {
  const zone = $('dropZone');
  const input = $('fileInput');

  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => input.files[0] && load(input.files[0]));

  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) load(f);
  });

  $('changeFile').addEventListener('click', () => input.click());
}

async function load(file) {
  try {
    toast(`Reading ${file.name}…`);
    const src = await xlsxAdapter.fetch({ file });

    state.rows = src.rows;
    state.source = {
      sourceId: src.sourceId,
      sourceLabel: src.sourceLabel,
      retrievedAt: src.retrievedAt,
      warnings: src.warnings,
    };
    Store.cacheRows(src.rows, state.source);

    rebuild();

    await Store.recordImport({
      retrievedAt: src.retrievedAt,
      sourceId: src.sourceId,
      sourceLabel: src.sourceLabel,
      horizonWeeks: state.fit?.weeks ?? state.settings.horizonWeeks,
      maxStock: state.settings.maxStock ?? null,
      // The full job list, not a summary: floor devices render from this and
      // never see the spreadsheet.
      jobs: state.board.jobs,
      meta: state.board.meta,
    });

    toast(`${src.rows.length} rows in — ${state.board.meta.job_count} on the board.`);
    queueNewCodes();
  } catch (e) {
    toast(`Could not read that file — ${e.message}`, 6000);
    console.error(e);
  }
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

function wireControls() {
  const horizon = $('horizon');
  horizon.addEventListener('input', () => {
    $('horizonVal').textContent = `${horizon.value} week${horizon.value === '1' ? '' : 's'}`;
  });
  horizon.addEventListener('change', async () => {
    state.settings.horizonWeeks = Number(horizon.value);
    await Store.saveSettings({ horizonWeeks: state.settings.horizonWeeks });
    rebuild();
  });

  $('maxStock').addEventListener('change', async (e) => {
    const v = e.target.value === '' ? null : Math.max(0, Number(e.target.value));
    state.settings.maxStock = v;
    await Store.saveSettings({ maxStock: v });
    rebuild();
  });

  $('autoFit').addEventListener('click', () => setAutoFit(!state.settings.autoFit));

  $('tabEditBtn').addEventListener('click', () => showTab('edit'));
  $('tabGanttBtn').addEventListener('click', () => showTab('gantt'));
  $('tabHistoryBtn').addEventListener('click', () => showTab('history'));
  $('tabPrintBtn').addEventListener('click', () => showTab('print'));

  $('completePastDue').addEventListener('click', () =>
    openCompleteDialog(state.board.warnings.pastDue ?? []));

  $('collapseAll').addEventListener('click', () => {
    if (collapsed.size) collapsed.clear();
    else for (const c of CATEGORY_ORDER) collapsed.add(c);
    saveCollapsed(collapsed);
    renderBoard();
  });

  const ganttToggle = (id, key) => $(id).addEventListener('click', () => {
    state.gantt[key] = !state.gantt[key];
    $(id).classList.toggle('on', state.gantt[key]);
    $(id).setAttribute('aria-pressed', String(state.gantt[key]));
    renderGanttView();
  });
  ganttToggle('ganttPacked', 'packed');
  ganttToggle('ganttAll', 'all');
  $('printBtn').addEventListener('click', () => { showTab('print'); window.print(); });
}

function setAutoFit(on, { save = true } = {}) {
  state.settings.autoFit = on;
  const b = $('autoFit');
  b.textContent = on ? 'Auto-fit on' : 'Auto-fit off';
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  if (save) { Store.saveSettings({ autoFit: on }); rebuild(); }
}

const TABS = ['edit', 'gantt', 'history', 'print'];

function showTab(which) {
  for (const t of TABS) {
    const cap = t[0].toUpperCase() + t.slice(1);
    $(`tab${cap}`).classList.toggle('offstage', which !== t);
    $(`tab${cap}Btn`).setAttribute('aria-current', which === t ? 'page' : 'false');
  }
}

// ---------------------------------------------------------------------------
// build + render
// ---------------------------------------------------------------------------

function rebuild() {
  if (!state.rows) return;

  const opts = {
    codeMap: state.codeMap,
    asOf: today(),
    overrides: state.overrides,
    itemOverrides: state.itemOverrides,
    maxStock: state.settings.maxStock,
  };
  const build = (weeks) => buildBoard(state.rows, { ...opts, horizonWeeks: weeks });

  // Reveal BEFORE measuring: a [hidden] ancestor gives the print host no
  // layout, and an unmeasured board would claim to fit at any horizon.
  $('dropZone').hidden = true;
  $('boardWrap').hidden = false;
  $('provenance').hidden = false;

  const host = $('printPreview');
  if (state.settings.autoFit) {
    state.fit = fitToPage(host, build, { startWeeks: state.settings.horizonWeeks, minWeeks: 4 });
    state.board = state.fit.board;
  } else {
    state.board = build(state.settings.horizonWeeks);
    renderPrint(host, state.board);
    const m = measure(host);
    state.fit = { board: state.board, weeks: state.settings.horizonWeeks, ...m, trimmedFrom: null };
  }

  renderProvenance();
  renderWarnings();
  renderBoard();
  renderFitStatus();
  renderGanttView();
  renderHistory();
}

function renderProvenance() {
  const s = state.source;
  if (!s) return;
  $('provSource').textContent = s.sourceLabel;
  const when = new Date(s.retrievedAt);
  $('provWhen').textContent = when.toLocaleString('en-AU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  // The board is exactly as fresh as the last upload, and nothing else in the
  // system knows that. Say it out loud once it starts to matter.
  const days = Math.floor((Date.now() - when.getTime()) / 86400000);
  const age = $('provAge');
  age.textContent = days <= 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} old`;
  age.classList.toggle('stale', days >= 7);
  if (days >= 7) age.textContent += ' — upload a fresh export';
}

function panel({ cls = '', title, count, open = false, build }) {
  const d = el('details', `panel ${cls}`);
  d.open = open;
  const s = el('summary');
  s.append(el('span', null, title));
  if (count !== undefined) s.append(el('span', 'count', String(count)));
  d.append(s);
  const body = el('div', 'body');
  build(body);
  d.append(body);
  return d;
}

function renderWarnings() {
  const host = $('warnings');
  host.textContent = '';
  const w = state.board.warnings;

  // Column problems from the adapter come first — they invalidate everything.
  for (const msg of state.source?.warnings ?? []) {
    const isHard = msg.startsWith('Export is missing');
    host.append(panel({
      cls: isHard ? 'alert' : '', title: isHard ? 'Export problem' : 'Note', open: isHard,
      build: (b) => b.append(el('div', null, msg)),
    }));
  }

  // Unmapped inventory prefixes — a new product line with no rule. Loud,
  // because the alternative is a job quietly missing from the floor's list.
  if (w.unmapped.length) {
    host.append(panel({
      cls: 'alert', title: 'Unmapped inventory codes — these need a category rule',
      count: w.unmapped.length, open: true,
      build: (b) => {
        b.append(el('div', null,
          'These rows matched no prefix in the category map, so they are off the board. ' +
          'Add a rule in js/rules.js — do not leave them excluded.'));
        for (const e of w.unmapped) {
          const r = el('div', 'xrow');
          r.append(el('span', 'id', e.prod_no), el('span', null, e.inventory_id), el('span', 'why', e.description));
          b.append(r);
        }
      },
    }));
  }

  // Codes still waiting on a decision — skipped in the import dialog, or added
  // since. The board falls back to raw ERP text for these, so it is not cosmetic.
  if (w.newCodes?.length) {
    host.append(panel({
      cls: 'alert', title: 'Vessel codes awaiting a decision', count: w.newCodes.length, open: true,
      build: (b) => {
        b.append(el('div', null,
          'These jobs are on the board but have no agreed code, so they print '
          + 'their raw ERP description. Upstream does not manage these '
          + 'consistently — they need answering by hand.'));
        for (const n of w.newCodes) {
          const r = el('div', 'xrow');
          r.append(el('span', 'id', n.code),
            el('span', null, `${n.count} job(s) · ${n.items.join(', ')}`));
          const a = el('button', 'mini', 'Decide now');
          a.addEventListener('click', () => { ncQueue = w.newCodes; ncIndex = w.newCodes.indexOf(n); showNewCode(); });
          r.append(a);
          b.append(r);
        }
      },
    }));
  }

  // Two hand-confirmed answers for one boat. Never resolved silently.
  if (w.codeConflicts.length) {
    host.append(panel({
      cls: 'alert', title: 'Vessel code conflict', count: w.codeConflicts.length, open: true,
      build: (b) => {
        for (const c of w.codeConflicts) {
          b.append(el('div', null,
            `${c.codes.join(' and ')} are the same boat (Riviera ${c.models.join(', ')}) ` +
            `but are confirmed to different display codes: ` +
            `${c.values.map((v) => `${v.code}→${v.display}`).join(', ')}. ` +
            `Fix it on the vessel codes page.`));
        }
      },
    }));
  }

  if (w.codeUndecided.length) {
    host.append(panel({
      title: 'Vessel codes awaiting confirmation', count: w.codeUndecided.length,
      build: (b) => {
        for (const u of w.codeUndecided) {
          b.append(el('div', null,
            `${u.codes.join(', ')} — showing ${u.provisional}, nobody has confirmed it.`));
        }
      },
    }));
  }

  // On Hold jobs are flagged, never auto-hidden. Only warn for ones that would
  // actually appear — an On Hold job outside the horizon is already gone.
  if (w.onHold.length) {
    host.append(panel({
      cls: 'alert', title: 'On hold, but showing on the board', count: w.onHold.length, open: true,
      build: (b) => {
        b.append(el('div', null, 'Confirm these before the floor starts them, or hide them.'));
        for (const j of w.onHold) {
          const r = el('div', 'xrow');
          r.append(el('span', 'id', j.prod_no), el('span', null, j.label), el('span', 'why', `due ${j.due_display}`));
          b.append(r);
        }
      },
    }));
  }

  if (w.hidden.length) {
    host.append(panel({
      title: 'Hidden from the printed board', count: w.hidden.length,
      build: (b) => {
        for (const j of w.hidden) {
          const r = el('div', 'xrow');
          r.append(el('span', 'id', j.prod_no), el('span', null, j.label),
            el('span', 'why', j.hidden_reason || 'no reason given'));
          b.append(r);
        }
      },
    }));
  }

  // Nothing disappears silently: if a job is missing, this says why. Grouped so
  // the horizon cut — the one the manager acts on, by widening it — is first.
  host.append(panel({
    title: 'Excluded rows', count: state.board.excluded.length,
    build: (b) => {
      b.append(el('div', null,
        `${state.board.meta.row_count} rows in the export, ${state.board.meta.job_count} on the board.`));

      const byKind = new Map();
      for (const e of state.board.excluded) {
        const k = e.kind ?? 'category';
        if (!byKind.has(k)) byKind.set(k, []);
        byKind.get(k).push(e);
      }

      for (const kind of EXCLUSION_ORDER) {
        const rows = byKind.get(kind);
        if (!rows?.length) continue;
        const h = el('div', `xgroup ${kind}`);
        h.append(el('span', null, EXCLUSION_GROUP_LABEL[kind] ?? kind));
        h.append(el('span', 'count', String(rows.length)));
        b.append(h);
        for (const e of rows) {
          const r = el('div', 'xrow');
          r.append(el('span', 'id', e.prod_no));
          r.append(el('span', null, e.inventory_id));
          // The item's own description, which is often the clearer of the two.
          r.append(el('span', 'desc', e.item_description || e.description || ''));
          r.append(el('span', 'why', e.reason));
          b.append(r);
        }
      }
    },
  }));
}

function renderBoard() {
  const host = $('board');
  host.textContent = '';
  const groups = byCategory(state.board.jobs, { includeHidden: true });

  const counts = Object.fromEntries(
    CATEGORY_ORDER.map((c) => [c, (groups.get(c) ?? []).length]));

  // Same shape as the printed sheet: the four narrow categories side by side,
  // davits full width underneath. Same balancer too, so the two views agree
  // about which category sits where instead of drifting apart.
  const { left, right } = balanceColumns(counts);

  const grid = el('div', 'board-grid');
  for (const side of [left, right]) {
    const col = el('div', 'board-col');
    for (const cat of side) {
      const block = categoryBlock(cat, groups.get(cat) ?? []);
      if (block) col.append(block);
    }
    grid.append(col);
  }
  host.append(grid);

  for (const cat of PRINT_LAYOUT.full) {
    const block = categoryBlock(cat, groups.get(cat) ?? [], { full: true });
    if (block) { block.classList.add('is-full'); host.append(block); }
  }

  const any = CATEGORY_ORDER.some((c) => (groups.get(c) ?? []).length);
  $('emptyState').hidden = any;
  $('stockNote').textContent = `${state.board.jobs.filter((j) => j.is_stock).length} stock`;

  const pastDue = state.board.warnings.pastDue?.length ?? 0;
  $('boardCount').textContent = `${state.board.meta.job_count} on the board`
    + (pastDue ? ` · ${pastDue} past due` : '');
  $('completePastDue').disabled = !pastDue;
  $('collapseAll').textContent = collapsed.size ? 'Expand all' : 'Collapse all';
}

function categoryBlock(cat, jobs, { full = false } = {}) {
  if (!jobs.length) return null;
  const isShut = collapsed.has(cat);
  const block = el('div', `cat-block${isShut ? ' is-collapsed' : ''}`);

  const head = el('button', 'cat-head');
  head.setAttribute('aria-expanded', String(!isShut));
  head.append(el('span', 'cat-caret', isShut ? '\u25b8' : '\u25be'));
  head.append(el('h2', null, cat));
  const shown = jobs.filter((j) => !j.hidden).length;
  head.append(el('span', 'n', shown === jobs.length ? `${shown}` : `${shown} of ${jobs.length}`));
  head.addEventListener('click', () => {
    if (collapsed.has(cat)) collapsed.delete(cat); else collapsed.add(cat);
    saveCollapsed(collapsed);
    renderBoard();
  });
  block.append(head);

  if (isShut) return block;

  const body = el('div', 'cat-body');
  const hdr = el('div', `job col-head${full ? ' is-full' : ''}`);
  hdr.append(el('span', null, 'Prod Nbr'), el('span', null, 'PO'),
    el('span', null, 'Vessel'), el('span', null, 'Due'),
    el('span', null, 'Status'), el('span', null, ''));
  body.append(hdr);
  for (const j of jobs) body.append(jobRow(j, { full }));
  block.append(body);
  return block;
}

function jobRow(j, { full = false } = {}) {
  const row = el('div', `job${j.on_hold ? ' on-hold' : ''}${j.hidden ? ' is-hidden' : ''}`
    + `${full ? ' is-full' : ''}`);

  row.append(el('span', 'prod', j.prod_no));

  // Riviera's PO sits next to the production number because that is the pair
  // the manager reads together when checking an order against Riviera. It is
  // manager-view only and never reaches the printed board.
  row.append(el('span', 'po', j.customer_po ?? ''));

  const label = el('span', 'label', j.label);
  if (j.label !== j.base_label) label.append(el('span', 'edited', 'EDITED'));
  else if (j.item_override) label.append(el('span', 'pinned', 'ITEM'));
  row.append(label);

  row.append(el('span', `due${j.is_stock ? ' stock' : ''}`, j.due_display));
  row.append(el('span', 'status', j.status));

  const acts = el('span', 'acts');
  const edit = el('button', 'mini', 'Label');
  edit.addEventListener('click', () => openLabelEditor(j));
  acts.append(edit);

  const hide = el('button', `mini${j.hidden ? ' on' : ''}`, j.hidden ? 'Show' : 'Hide');
  hide.addEventListener('click', () => (j.hidden ? unhide(j) : openHideDialog(j)));
  acts.append(hide);

  const done = el('button', 'mini', 'Done');
  done.title = 'Mark completed — off the board for good, reversible from History';
  done.addEventListener('click', () => openCompleteDialog([j]));
  acts.append(done);

  row.append(acts);
  return row;
}

function renderGanttView() {
  const { packed, all } = state.gantt;

  // "Everything" drops the horizon and puts completed work back, so the chart
  // can show the whole span rather than the printable slice. It scrolls at a
  // fixed day width instead of compressing — two years squeezed onto one screen
  // is a smear, not a chart.
  const jobs = all
    ? buildBoard(state.rows, {
        codeMap: state.codeMap, asOf: today(), overrides: state.overrides,
        itemOverrides: state.itemOverrides, horizonWeeks: null, includeCompleted: true,
      }).jobs.filter((j) => !j.hidden)
    : state.board.jobs.filter((j) => !j.hidden);

  const g = renderGantt($('gantt'), jobs, {
    asOf: today(),
    mode: packed ? 'packed' : 'rows',
    pxPerDay: all ? 8 : null,
    onBarClick: Auth.isManager ? (r) => openCompleteDialog([r]) : null,
  });

  $('ganttHint').textContent = all
    ? `Every order, horizon and completion ignored \u2014 ${g.rowCount} bars, scroll sideways.`
    : 'Click a bar to mark it complete.';
}

function renderHistory() {
  const host = $('history');
  host.textContent = '';
  const done = state.board.completed ?? [];

  $('tabHistoryBtn').textContent = done.length ? `History (${done.length})` : 'History';

  if (!done.length) {
    host.append(el('div', 'state', 'Nothing completed yet. Jobs marked done from the '
      + 'orders view or the Gantt land here.'));
    return;
  }

  const table = el('div', 'hist');
  const hdr = el('div', 'hist-row hist-head');
  hdr.append(el('span', null, 'Prod Nbr'), el('span', null, 'Vessel'),
    el('span', null, 'Category'), el('span', null, 'Due'),
    el('span', null, 'Completed'), el('span', null, ''));
  table.append(hdr);

  for (const j of done) {
    const row = el('div', 'hist-row');
    row.append(el('span', 'prod', j.prod_no));
    row.append(el('span', 'label', j.label));
    row.append(el('span', 'cat', j.category));
    row.append(el('span', 'due', j.due_display));
    const when = j.completed_at ? new Date(j.completed_at) : null;
    const stamp = el('span', 'when', when
      ? when.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '\u2014');
    if (j.completed_by) stamp.title = `Marked by ${j.completed_by}`;
    row.append(stamp);

    const acts = el('span', 'acts');
    const reopen = el('button', 'mini', 'Reopen');
    reopen.title = 'Put it back on the board';
    reopen.addEventListener('click', async () => {
      await Store.setCompleted([j.prod_no], false, Auth.user?.email);
      delete state.overrides[j.prod_no]?.completed;
      state.overrides = await Store.loadOverrides();
      rebuild();
      toast(`${j.prod_no} reopened.`);
    });
    acts.append(reopen);
    row.append(acts);
    table.append(row);
  }
  host.append(table);
}

// ---------------------------------------------------------------------------
// completion
//
// The ERP saved filter drops Completed/Canceled/Closed, so the handoff assumed
// finished work never arrives. That holds only while the ERP status actually
// flips. A job finished on the floor and never closed in the system stays
// `In Process` in every export after it — which is what the past-due rows and
// the stale stock builds are. Marking it here is the missing half.
// ---------------------------------------------------------------------------

let completing = [];

function openCompleteDialog(jobs) {
  completing = jobs.map((j) => ({ job: j, ticked: true }));

  $('completeLede').textContent = jobs.length === 1
    ? `${jobs[0].prod_no} — ${jobs[0].label}, due ${jobs[0].due_display}.`
    : `${jobs.length} jobs are past their end date and still open. Untick anything `
      + `still in the shop.`;

  renderCompleteList();
  $('completeOverlay').classList.add('show');
}

function renderCompleteList() {
  const host = $('completeList');
  host.textContent = '';
  for (const entry of completing) {
    const { job } = entry;
    const row = el('label', 'c-row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = entry.ticked;
    box.addEventListener('change', () => { entry.ticked = box.checked; updateCompleteCount(); });
    row.append(box);
    row.append(el('span', 'c-prod', job.prod_no));
    row.append(el('span', 'c-name', job.label));
    row.append(el('span', 'c-cat', job.category));
    row.append(el('span', 'c-due', job.due_display));
    host.append(row);
  }
  updateCompleteCount();
}

function updateCompleteCount() {
  const n = completing.filter((e) => e.ticked).length;
  $('completeCount').textContent = `${n} of ${completing.length} ticked`;
  $('completeConfirm').disabled = n === 0;
}

async function confirmComplete() {
  const picked = completing.filter((e) => e.ticked).map((e) => e.job.prod_no);
  if (!picked.length) return;
  $('completeConfirm').disabled = true;
  try {
    await Store.setCompleted(picked, true, Auth.user?.email);
    state.overrides = await Store.loadOverrides();
    $('completeOverlay').classList.remove('show');
    rebuild();
    toast(`${picked.length} marked complete. Reopen from History if that was wrong.`);
  } catch (e) {
    toast(`Could not save — ${e.message}`, 6000);
  } finally {
    $('completeConfirm').disabled = false;
  }
}

function renderFitStatus() {
  const f = state.fit;
  const box = $('fitStatus');
  box.textContent = '';
  box.classList.toggle('trimmed', Boolean(f.trimmedFrom));

  const range = state.board.meta.horizon_end
    ? `${toAU(toDateOnly(state.board.meta.as_of))} — ${toAU(toDateOnly(state.board.meta.horizon_end))}`
    : 'no horizon';

  box.append(el('span', null, `Covering `), el('b', null, range));
  box.append(el('span', null, `·`));
  box.append(el('b', null, `${state.board.meta.job_count} jobs`));
  box.append(el('span', null, `·`));

  if (!state.settings.autoFit) {
    box.append(el('span', null, f.fits ? 'fits one page' : `${f.pages} pages — auto-fit is off`));
  } else if (f.trimmedFrom) {
    box.append(el('span', null, 'Auto-fit reduced the horizon from '));
    box.append(el('b', null, `${f.trimmedFrom} weeks to ${f.weeks}`));
    box.append(el('span', null, ' to hold one page. The printed header shows the covered range.'));
  } else if (f.fits) {
    box.append(el('span', null, `fits one page at ${f.weeks} weeks`));
  } else {
    box.append(el('span', null,
      `will not fit one page even at ${f.weeks} weeks (${f.pages} pages). ` +
      `Lower the stock cap, or hide some jobs.`));
  }
}

// ---------------------------------------------------------------------------
// new vessel codes
//
// Upstream does not manage these consistently — `56` was an office shorthand
// for 56SY, and Riviera call the same boat both 56SY and 5000SY. So a code the
// map has never seen is never auto-accepted: the board would print a guess and
// nobody would know it was one. Each is queued and answered on import.
// ---------------------------------------------------------------------------

let ncQueue = [];
let ncIndex = 0;

function queueNewCodes() {
  if (!Auth.isManager) return;
  const pending = state.board?.warnings?.newCodes ?? [];
  if (!pending.length) return;
  ncQueue = pending;
  ncIndex = 0;
  showNewCode();
}

function showNewCode() {
  const item = ncQueue[ncIndex];
  if (!item) { $('newCodeOverlay').classList.remove('show'); rebuild(); return; }

  $('ncProgress').textContent = ncQueue.length > 1 ? `${ncIndex + 1} of ${ncQueue.length}` : '';
  $('ncLede').textContent =
    `This export carries ${item.count} job(s) under a vessel code the board has `
    + `never seen. Choose what the floor should read.`;

  const d = $('ncDerived');
  d.textContent = '';
  const row = (k, v) => {
    const r = el('div', 'row');
    r.append(el('span', null, k), el('span', null, v || '—'));
    d.append(r);
  };
  row('Item codes', item.items.join('  ·  '));
  row('Stella code', item.code);
  row('Riviera model', item.riviera.join(', '));
  row('Hull prefix', item.hull_prefix.join(', '));
  row('Description', item.descriptions[0] ?? '');

  // What each choice would actually print, using the real template for the
  // first item — a preview beats a description of a preview.
  const preview = (display) => {
    const fake = { [item.code]: { display, _confirmed: true, riviera: item.riviera } };
    return labelFor(item.items[0], null, fake) ?? display;
  };

  $('ncStella').textContent = item.code;
  $('ncStellaPreview').textContent = preview(item.code);

  const riv = item.suggestion.riviera;
  $('ncRivOpt').hidden = !riv;
  if (riv) {
    $('ncRiv').textContent = riv;
    $('ncRivPreview').textContent = preview(riv);
  }

  const sel = $('ncExisting');
  sel.textContent = '';
  for (const b of existingBoats(state.codeMap)) {
    const o = document.createElement('option');
    o.value = b.boat;
    o.textContent = `${b.display}  (${b.codes.join(', ')})`;
    sel.append(o);
  }

  $('ncCustom').value = '';
  $('newCodeOverlay').classList.add('show');
}

async function chooseNewCode(mode) {
  const item = ncQueue[ncIndex];
  const choice = { mode };
  if (mode === 'existing') choice.boat = $('ncExisting').value;
  if (mode === 'custom') {
    choice.value = $('ncCustom').value.trim();
    if (!choice.value) { toast('Enter a code, or choose another option.'); return; }
  }

  const entry = acceptNewCode(item.code, choice, item);
  state.codeMap[item.code] = entry;
  await Store.saveCode(item.code, entry);

  const shown = mode === 'existing'
    ? `${item.code} joined ${$('ncExisting').selectedOptions[0].textContent.trim()}`
    : `${item.code} will print as "${entry.display}"`;
  toast(shown);

  ncIndex += 1;
  showNewCode();
}

function wireNewCode() {
  for (const b of document.querySelectorAll('#newCodeOverlay [data-mode]')) {
    b.addEventListener('click', () => chooseNewCode(b.dataset.mode));
  }
  $('ncCustom').addEventListener('keydown', (e) => { if (e.key === 'Enter') chooseNewCode('custom'); });
  $('ncSkip').addEventListener('click', () => { ncIndex += 1; showNewCode(); });
}

// ---------------------------------------------------------------------------
// label editing — scope first
//
// Editing a label and editing a vessel code are different things and the UI
// must not conflate them. "Just this job" replaces the whole label on one
// production order. "Every job for this vessel" edits the display code alone,
// which then flows through the product wording template, and applies across
// the whole alias group.
// ---------------------------------------------------------------------------

let editing = null;

function openLabelEditor(job) {
  editing = job;
  const code = /CUSTOM/i.test(job.inventory_id) ? null : stellaCode(job.inventory_id);
  const onABoat = Boolean(code && state.codeMap[code]);

  $('lblTitle').textContent = `Edit label — ${job.prod_no}`;
  $('lblLede').textContent = `Currently "${job.label}" · ${job.inventory_id}`;

  $('lblScope').hidden = false;
  $('lblScopeActions').hidden = false;
  $('lblForm').hidden = true;

  // Scope 2 — this product, forever. Always available: even a davit or a chock
  // with no vessel code can need its label pinned.
  const sameItem = state.board.jobs.filter((j) => j.inventory_id === job.inventory_id).length;
  $('scopeItemHint').textContent =
    `Pins the label to ${job.inventory_id} — ${sameItem} job(s) on this board, and `
    + `every future order for it. Use this when the item code names one boat but `
    + `the part is built to the drawings of another.`;

  // Scope 3 — every product on this boat.
  $('scopeCode').hidden = !onABoat;
  if (onABoat) {
    const group = state.board.resolved.groups.find((g) => g.codes.includes(code));
    const n = state.board.jobs.filter((j) => group.codes.includes(stellaCode(j.inventory_id) ?? '')).length;
    $('scopeCodeHint').textContent =
      `Changes the display code for boat ${group.boat ?? group.codes[0]} `
      + `(${group.codes.join(' / ')}) — ${n} job(s) here, and every future one. `
      + `The product wording ("Garage Door", "Launcher") is kept.`;
  }

  $('labelOverlay').classList.add('show');
}

function showLabelForm(scope) {
  const job = editing;
  const code = stellaCode(job.inventory_id);
  const pinned = state.itemOverrides[job.inventory_id];

  $('lblScope').hidden = true;
  $('lblScopeActions').hidden = true;
  $('lblForm').hidden = false;
  $('lblForm').dataset.scope = scope;
  $('lblReset').hidden = true;

  if (scope === 'job') {
    $('lblFieldLabel').textContent = 'Label for this job';
    $('lblInput').value = job.label;
    $('lblHint').textContent =
      `Replaces the whole label on ${job.prod_no} only. Saved against the `
      + `production number, so it survives the next upload.`;
    $('lblReset').hidden = job.label === job.base_label;

  } else if (scope === 'item') {
    // A vessel-coded item gets a code (the template still supplies the wording);
    // anything else — davits, chocks — has no code, so it gets a whole label.
    if (code) {
      $('lblFieldLabel').textContent = `Display code for ${job.inventory_id}`;
      $('lblInput').value = pinned?.displayCode
        ?? state.board.resolved.display.get(code) ?? code;
      $('lblHint').textContent =
        `Just the vessel code — the product wording is added by the template, so `
        + `"56SY" becomes "${applyTemplate(job.inventory_id, '56SY')}". Applies to `
        + `this item code only, on every future order.`;
    } else {
      $('lblFieldLabel').textContent = `Label for ${job.inventory_id}`;
      $('lblInput').value = pinned?.label ?? job.base_label;
      $('lblHint').textContent =
        `This item has no vessel code, so this is the whole label. Applies to `
        + `${job.inventory_id} on every future order.`;
    }
    $('lblReset').hidden = !pinned;

  } else {
    const group = state.board.resolved.groups.find((g) => g.codes.includes(code));
    $('lblFieldLabel').textContent = `Display code for boat ${group.boat ?? group.codes[0]}`;
    $('lblInput').value = state.board.resolved.display.get(code) ?? code;
    $('lblHint').textContent =
      `Applies to ${group.codes.join(', ')} — every product on this boat. `
      + `An item that needs to differ from its boat should use the item scope `
      + `instead.`;
  }
  $('lblInput').focus();
  $('lblInput').select();
}

function wireOverlays() {
  wireNewCode();
  $('scopeJob').addEventListener('click', () => showLabelForm('job'));
  $('scopeItem').addEventListener('click', () => showLabelForm('item'));
  $('scopeCode').addEventListener('click', () => showLabelForm('code'));
  $('lblScopeCancel').addEventListener('click', closeLabel);
  $('lblCancel').addEventListener('click', closeLabel);
  $('lblSave').addEventListener('click', saveLabel);
  $('lblInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveLabel(); });
  $('lblReset').addEventListener('click', async () => {
    const scope = $('lblForm').dataset.scope;
    const job = editing;
    if (scope === 'item') {
      await setItemOverride(job.inventory_id, { label: null, displayCode: null });
      toast(`${job.inventory_id} back to the code of its boat.`);
    } else {
      await setOverride(job.prod_no, { labelOverride: null });
      toast(`${job.prod_no} label reset.`);
    }
    closeLabel();
  });

  $('completeCancel').addEventListener('click', () => $('completeOverlay').classList.remove('show'));
  $('completeConfirm').addEventListener('click', confirmComplete);
  $('completeAll').addEventListener('click', () => { completing.forEach((e) => { e.ticked = true; }); renderCompleteList(); });
  $('completeNone').addEventListener('click', () => { completing.forEach((e) => { e.ticked = false; }); renderCompleteList(); });

  $('hideCancel').addEventListener('click', () => $('hideOverlay').classList.remove('show'));
  $('hideSave').addEventListener('click', saveHide);

  for (const id of ['labelOverlay', 'hideOverlay', 'completeOverlay']) {
    $(id).addEventListener('click', (e) => { if (e.target.id === id) $(id).classList.remove('show'); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $('labelOverlay').classList.remove('show');
    $('hideOverlay').classList.remove('show');
    $('completeOverlay').classList.remove('show');
  });
}

async function saveLabel() {
  const value = $('lblInput').value.trim();
  if (!value) { toast('That cannot be empty.'); return; }
  const scope = $('lblForm').dataset.scope;
  const job = editing;

  if (scope === 'job') {
    await setOverride(job.prod_no, { labelOverride: value });
    toast(`${job.prod_no} relabelled.`);

  } else if (scope === 'item') {
    const code = stellaCode(job.inventory_id);
    const patch = code ? { displayCode: value, label: null } : { label: value, displayCode: null };
    await setItemOverride(job.inventory_id, patch);
    toast(code
      ? `${job.inventory_id} now prints "${applyTemplate(job.inventory_id, value)}".`
      : `${job.inventory_id} now prints "${value}".`);

  } else {
    const code = stellaCode(job.inventory_id);
    const group = state.board.resolved.groups.find((g) => g.codes.includes(code));
    // Confirming one member confirms the boat — the group displays as one.
    for (const c of group.codes) {
      state.codeMap[c] = { ...(state.codeMap[c] ?? {}), display: value, _confirmed: true };
      await Store.saveCode(c, { display: value, _confirmed: true });
    }
    rebuild();
    toast(`Boat ${group.boat ?? group.codes[0]} (${group.codes.join(', ')}) now displays "${value}".`);
  }
  closeLabel();
}

async function setItemOverride(inventoryId, patch) {
  const next = { ...(state.itemOverrides[inventoryId] ?? {}), ...patch };
  for (const k of ['label', 'displayCode']) if (next[k] === null) delete next[k];
  if (next.label || next.displayCode) state.itemOverrides[inventoryId] = next;
  else delete state.itemOverrides[inventoryId];

  await Store.setItemOverride(inventoryId, patch);
  rebuild();
}

function closeLabel() { $('labelOverlay').classList.remove('show'); editing = null; }

// ---------------------------------------------------------------------------
// hide / show
// ---------------------------------------------------------------------------

let hiding = null;

function openHideDialog(job) {
  hiding = job;
  $('hideLede').textContent = `${job.prod_no} — ${job.label}, due ${job.due_display}.`;
  $('hideReason').value = '';
  $('hideOverlay').classList.add('show');
  $('hideReason').focus();
}

async function saveHide() {
  await setOverride(hiding.prod_no, { hidden: true, hiddenReason: $('hideReason').value.trim() || null });
  $('hideOverlay').classList.remove('show');
  toast(`${hiding.prod_no} hidden from the printed board.`);
  hiding = null;
}

async function unhide(job) {
  await setOverride(job.prod_no, { hidden: false, hiddenReason: null });
  toast(`${job.prod_no} back on the board.`);
}

async function setOverride(prodNo, patch) {
  const next = { ...(state.overrides[prodNo] ?? {}), ...patch };
  if (patch.labelOverride === null) delete next.labelOverride;
  if (next.hidden === false) { delete next.hidden; delete next.hiddenReason; }
  if (Object.keys(next).length) state.overrides[prodNo] = next;
  else delete state.overrides[prodNo];

  await Store.setOverride(prodNo, patch);
  rebuild();
}

// ---------------------------------------------------------------------------

// Which categories are rolled up. A device preference, not a shared setting —
// it says nothing about the work, so it does not belong in Firestore, and a
// write per toggle would be needlessly chatty.
const COLLAPSE_KEY = 'stella.board.collapsed';
const loadCollapsed = () => {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')); }
  catch { return new Set(); }
};
const saveCollapsed = (set) => {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch {}
};
let collapsed = loadCollapsed();

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
