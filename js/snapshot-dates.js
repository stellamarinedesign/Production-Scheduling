// snapshot-dates.js — the dates of completed work the export no longer carries.
//
// A job marked done keeps a snapshot of itself so History can show it after
// the ERP stops exporting it. The snapshot now carries the start and end
// dates too (`snapshotOf`), so the Gantt's everything-view can draw finished
// work beside the open work. Snapshots written before that have no dates,
// and nothing on the board can supply them: the job is not in the current
// export, by definition.
//
// The import records can. Every applied export is kept whole in `imports`
// (`rowsJson`), newest first, and a job completed by hand was in the exports
// up to the day the ERP closed it. So the dates are looked up there, once,
// and written into the snapshot, and from then on the job draws like any
// other. A read of the import records is not cheap - each is the whole open
// order book - so it runs only when asked, from a button under the chart.

import { Store, unpackRows } from './store.js';
import { toDateOnly, toISO } from './transform.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Completed production jobs rebuilt from a snapshot that has no dates to draw. */
export const undatedSnapshots = (board) => (board?.completed ?? [])
  .filter((j) => j.from_snapshot && (j.lane ?? 'production') === 'production'
    && !(j.start_date && j.end_date));

/**
 * The dates each production number had in the most recent export that
 * carried it. `imports` are import records newest first, each with `rowsJson`
 * (or `rows`); a cell is whatever the record kept, so it goes through
 * toDateOnly like any other date.
 *
 * @returns {Map<string, {start_date: string, end_date: string}>}
 */
export function datesFromImports(imports, prodNos) {
  const want = new Set(prodNos);
  const found = new Map();
  for (const rec of imports ?? []) {
    if (!want.size) break;
    let rows;
    try { rows = rec?.rowsJson ? unpackRows(rec.rowsJson) : (rec?.rows ?? []); } catch { continue; }
    for (const r of rows ?? []) {
      const p = String(r?.['Production Nbr.'] ?? '').trim();
      if (!want.has(p)) continue;
      const start = toISO(toDateOnly(r['Start Date']));
      const end = toISO(toDateOnly(r['End Date']));
      if (!start || !end) continue;
      found.set(p, { start_date: start, end_date: end });
      want.delete(p);
    }
  }
  return found;
}

/**
 * Look the dates up and write them into each snapshot. The nearest imports
 * first, the rest only if something is still missing: most of these jobs were
 * in the export until recently. No author stamp - this is not a decision.
 *
 * @returns {Promise<{found: number, missing: number, searched: number}>}
 */
export async function backfillSnapshotDates(jobs, overrides) {
  const prodNos = jobs.map((j) => j.prod_no);
  let imports = await Store.listImports(5);
  let dates = datesFromImports(imports, prodNos);
  if (dates.size < prodNos.length && imports.length === 5) {
    imports = await Store.listImports(20);
    dates = datesFromImports(imports, prodNos);
  }
  for (const [prodNo, d] of dates) {
    const snap = overrides?.[prodNo]?.snapshot ?? {};
    const isStock = Boolean(snap.is_stock);
    await Store.setOverride(prodNo, {
      snapshot: { ...snap, ...d, due_date: isStock ? null : d.end_date },
    });
  }
  return { found: dates.size, missing: prodNos.length - dates.size, searched: imports.length };
}

/**
 * The line under the chart when finished work cannot be drawn, and the button
 * that fetches its dates. `onDone` runs after the snapshots are written, with
 * the result, so the caller can reload and redraw.
 */
export function renderUndatedNotice(jobs, { overrides, toast, onDone }) {
  const box = el('div', 'g-undated');
  box.append(el('span', null,
    `${jobs.length} completed job${jobs.length === 1 ? ' has' : 's have'} no dates on record.`));
  const btn = el('button', 'mini', 'Find their dates');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await backfillSnapshotDates(jobs, overrides);
      toast?.(r.found
        ? `Dates found for ${r.found} of ${jobs.length} completed jobs.`
        : `No dates found in the last ${r.searched} imports.`, 6000);
      await onDone?.(r);
    } catch (e) {
      toast?.(`Could not read the import records — ${e.message}`, 8000);
    } finally {
      btn.disabled = false;
    }
  });
  box.append(btn);
  return box;
}
