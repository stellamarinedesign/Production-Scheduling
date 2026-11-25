// item-history.js — one job's change history, and what an import moved.
//
// Two questions a manager asks of a job: what has been done to it, and when
// the ERP moved it. The first was already answered by the activity log, a line
// per hand edit. The second was worked out for the import review and thrown
// away the moment the import was applied — a due date that slipped three weeks
// was visible for the length of the review and nowhere afterwards.
//
// So an import now writes what it moved to the same log: one entry per changed
// job, carrying each field as it was and as it is, in the shape the review
// already computes (`diffBoards`). It also writes a line for each job it adds,
// so a job's history starts with when it came in and who brought it. This
// dialog reads the log back for one job, newest first. The log stays a record:
// nothing reads it to decide anything, except whether a job already has its
// added line.

import { Store } from './store.js';
import { closeOnBackdrop } from './dialog.js';
import { ACTION, activityEntry, whoShort, whenShort } from './activity.js';
import { jobTitle, toAU, toDateOnly } from './transform.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------------------------------------------------------------------------
// describing a change
// ---------------------------------------------------------------------------

/** A yyyy-mm-dd string, which is how every date in a change record is kept. */
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/**
 * A value as the screen says it: a date as dd/mm/yyyy, a blank as the word,
 * anything else as it is.
 */
export function changeValue(v) {
  if (v === null || v === undefined || v === '') return 'blank';
  if (typeof v === 'string' && DAY_RE.test(v)) return toAU(toDateOnly(v)) ?? v;
  return String(v);
}

/** "end date 21/09/2026 → 05/10/2026, quantity 1 → 2" */
export const describeChanges = (changes) =>
  (changes ?? []).map((c) => `${c.field} ${changeValue(c.from)} → ${changeValue(c.to)}`).join(', ');

/** The line the log shows for an import's entry (`text`). `day` is a date-only value. */
export const importSentence = (changes, day) => `Import ${toAU(day)}: ${describeChanges(changes)}`;

/**
 * The log entries an import writes: one per changed job, each field it moved
 * as it was and as it is.
 *
 * `diff` is the review's own `diffBoards` result, so the history says exactly
 * what the review said. `board` is the board the import produced, which names
 * the jobs. Every value is a string, a number or null — Firestore refuses an
 * undefined, and a Date would come back a day early.
 *
 * @param {{changes: Map<string, Array<{field, from, to}>>, first: boolean}} diff
 * @param {{board: Object, by: string, importAt?: string|null, at?: Date}} o
 */
export function importChangeEntries(diff, { board, by, importAt = null, at = new Date() } = {}) {
  if (!diff || diff.first || !diff.changes?.size) return [];
  const jobs = jobsByNumber(board);
  const day = { y: at.getFullYear(), m: at.getMonth() + 1, d: at.getDate() };
  const out = [];
  for (const [prodNo, moved] of diff.changes) {
    if (!moved?.length) continue;
    const changes = moved.map(({ field, from, to }) => ({ field, from: from ?? null, to: to ?? null }));
    const job = jobs.get(prodNo);
    const text = importSentence(changes, day);
    out.push({
      ...activityEntry({
        action: ACTION.import, text, by, prodNo, at,
        label: job ? jobTitle(job) : null,
        inventoryId: job?.inventory_id ?? null,
      }),
      changes,
      importAt: importAt ?? null,
    });
  }
  return out;
}

/** Every job on a board by its production number, held-back part orders too. */
const jobsByNumber = (board) => new Map(
  [...(board?.jobs ?? []), ...(board?.tm ?? []), ...(board?.internal ?? []), ...(board?.held ?? [])]
    .map((j) => [j.prod_no, j]));

/** The line for a job an import adds. */
export const ADDED_TEXT = 'Added by import';
/**
 * The line for a job already on the board at its first import: open then, but
 * when it was added nobody can say.
 */
export const ADDED_FIRST_TEXT = 'On the board since the first import';

/**
 * The log entries an import writes for the jobs it adds: one per job new
 * against the board it replaces (the review's own `diffBoards`), by whoever
 * applied it, at the apply. On a first import, with no board before it, every
 * job is new and its line says only that it was there from the start.
 *
 * Marked `added: true`, which is how the next import (and the one-off
 * backfill) knows a job already has its line.
 */
export function importAddedEntries(diff, { board, by, importAt = null, at = new Date() } = {}) {
  if (!diff?.state?.size) return [];
  const jobs = jobsByNumber(board);
  const first = Boolean(diff.first);
  const out = [];
  for (const [prodNo, state] of diff.state) {
    if (state !== 'new') continue;
    const job = jobs.get(prodNo);
    out.push({
      ...activityEntry({
        action: ACTION.import, text: first ? ADDED_FIRST_TEXT : ADDED_TEXT, by, prodNo, at,
        label: job ? jobTitle(job) : null,
        inventoryId: job?.inventory_id ?? null,
      }),
      added: true,
      firstImport: first,
      importAt: importAt ?? null,
    });
  }
  return out;
}

/**
 * FIRST APPEARANCE ONLY. A job missing from a partial export is new again in
 * the full one after it, but it was not added twice: any job that already has
 * an added line gets no second one. If the check cannot be read, no added line
 * is written this time (the backfill can supply it); the change lines still go.
 */
async function firstTimeOnly(entries) {
  if (!entries.length) return entries;
  try {
    const have = await Store.addedAlready(entries.map((e) => e.prodNo));
    return entries.filter((e) => !have.has(e.prodNo));
  } catch (e) {
    console.warn('[activity] added lines not written:', e.message);
    return [];
  }
}

/**
 * Write an import's changes, and the jobs it added, to the log, once the
 * import is applied.
 *
 * NOT AWAITED BY THE APPLY. The import is committed whether or not its history
 * is: a log that fails must not undo or delay the board it describes, so a
 * failure is said in a toast and nothing more. Resolves to the number written.
 */
export async function logImportChanges(diff, { board, by, importAt = null, toast, at = new Date() } = {}) {
  const changed = importChangeEntries(diff, { board, by, importAt, at });
  const added = await firstTimeOnly(importAddedEntries(diff, { board, by, importAt, at }));
  const entries = [...changed, ...added];
  if (!entries.length) return 0;
  return Store.logActivityBatch(entries).catch((e) => {
    console.warn('[activity]', e.message);
    toast?.(`The import's changes could not be logged — ${e.message}`, 8000);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// on screen
// ---------------------------------------------------------------------------

/**
 * One line per field: what it was, what it is. The same element in the
 * dialog and in the review's opened row, so the two never read differently.
 */
export function renderChangeList(changes) {
  const list = el('div', 'change-list');
  for (const c of changes ?? []) {
    list.append(el('span', 'ch-field', c.field));
    const v = el('span', 'ch-value');
    v.append(el('span', 'ch-from', changeValue(c.from)));
    v.append(el('span', 'ch-arrow', '→'));
    v.append(el('span', 'ch-to', changeValue(c.to)));
    list.append(v);
  }
  return list;
}

// Which changed rows of the review are open, by production number. The review
// rebuilds every row whenever a count or a concern is toggled, so what was
// opened has to be remembered outside the rows. A new file staged starts shut.
const openRows = new Set();
let openGeneration = null;

/**
 * A changed row of the import review opens on a click to show each field that
 * moved. The detail sits after the row in the same list, so call this once the
 * row is in it. `generation` names the staged file; a different one forgets
 * what was open.
 */
export function wireChangeRow(row, prodNo, changes, generation = null) {
  if (!changes?.length) return;
  if (generation !== openGeneration) { openRows.clear(); openGeneration = generation; }
  let detail = null;
  const show = (on) => {
    row.classList.toggle('is-open', on);
    if (on && !detail) {
      detail = el('div', 'flag-row-changes');
      detail.append(renderChangeList(changes));
      row.after(detail);
    }
    if (detail) detail.hidden = !on;
    if (on) openRows.add(prodNo); else openRows.delete(prodNo);
  };
  row.addEventListener('click', () => show(!row.classList.contains('is-open')));
  if (openRows.has(prodNo)) show(true);
}

let overlay = null;
let showing = null;     // the job the dialog is open for; a slow read for an earlier one is dropped

const lede = (job) => ((job.lane ?? 'production') === 'production'
  ? `${job.prod_no} — ${jobTitle(job)}, due ${job.due_display}`
  : `${job.prod_no} — ${jobTitle(job)}, open ${job.age_display || 'since it was raised'}`);

/** The dialog: every change to one job, newest first. */
export async function openItemHistory(job) {
  if (!overlay) build();
  showing = job;
  overlay.querySelector('.lede').textContent = lede(job);
  const list = overlay.querySelector('.ih-list');
  list.textContent = '';
  list.append(el('div', 'ih-none', 'Loading…'));
  overlay.classList.add('show');

  let rows;
  try {
    rows = await Store.listActivityFor(job.prod_no, job.inventory_id ?? null);
  } catch (e) {
    if (showing !== job) return;
    list.textContent = '';
    list.append(el('div', 'ih-none', `Could not load the history — ${e.message}`));
    return;
  }
  if (showing !== job) return;
  list.textContent = '';
  if (!rows.length) { list.append(el('div', 'ih-none', 'No changes logged.')); return; }
  for (const r of rows) list.append(historyRow(r));
}

/** When, who, what — an import's entry as its fields, anything else as its line. */
function historyRow(r) {
  const row = el('div', 'ih-row');
  row.append(el('span', 'ih-when', whenShort(r.at)));
  row.append(el('span', 'ih-who', whoShort(r.by)));
  const what = el('div', 'ih-text');
  if (r.changes?.length) {
    what.append(el('div', 'ih-import', 'Import'));
    what.append(renderChangeList(r.changes));
  } else {
    what.textContent = r.text ?? '';
  }
  row.append(what);
  return row;
}

function hide() {
  overlay?.classList.remove('show');
  showing = null;
}

function build() {
  overlay = el('div', 'overlay');
  overlay.id = 'historyOverlay';
  const box = el('div', 'box wide history');
  box.append(el('h3', null, 'Change history'), el('div', 'lede'), el('div', 'ih-list'));
  const acts = el('div', 'actions');
  const close = el('button', 'ghost', 'Close');
  close.addEventListener('click', hide);
  acts.append(close);
  box.append(acts);
  overlay.append(box);
  document.body.append(overlay);
  closeOnBackdrop(overlay, hide);
}
