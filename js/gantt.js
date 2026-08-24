// gantt.js — start/end bars for the jobs on the board.
//
// First pass, deliberately plain: one bar per production order, grouped by
// board category, positioned from `start_date` to `end_date`. Both fields are
// populated on every row of the ERP export, so this needs no new data.
//
// The layout is a pure function so it can be tested without a DOM. Only
// `renderGantt` touches elements.

import { CATEGORY_ORDER } from './rules.js';
import { toDateOnly, toISO, toAU, today as todayDate } from './transform.js';

const DAY = 86400000;
const utc = (d) => Date.UTC(d.y, d.m - 1, d.d);
const fromMs = (ms) => { const d = new Date(ms); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY);
const addDays = (d, n) => fromMs(utc(d) + n * DAY);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Monday of the week containing d. */
function weekStart(d) {
  const dow = new Date(utc(d)).getUTCDay();       // 0 = Sunday
  return addDays(d, -((dow + 6) % 7));
}

/**
 * Work out where every bar sits, as percentages of the chart width.
 *
 * @param {Array} jobs      board jobs (hidden ones should already be gone)
 * @param {{asOf}} opts     defaults to today; drives the "now" marker
 * @returns {{start, end, totalDays, todayPct, groups, months, weeks, overdue}}
 */
export function ganttLayout(jobs, { asOf = todayDate() } = {}) {
  const dated = jobs
    .map((j) => ({ job: j, s: toDateOnly(j.start_date), e: toDateOnly(j.end_date ?? j.due_date) }))
    .filter((r) => r.s && r.e);

  const undated = jobs.length - dated.length;
  if (!dated.length) {
    return { start: null, end: null, totalDays: 0, todayPct: null, groups: [], months: [], weeks: [], overdue: 0, undated };
  }

  // THE WINDOW IS SET BY COMMITTED WORK, NOT BY EVERY BAR.
  //
  // Stock builds ignore the horizon and carry no promised date, so their start
  // dates drift: on the 21/08 export the six earliest starts are all stock, the
  // oldest from 13 March. Letting them set the left edge stretches the chart
  // from 16 weeks to 35 and halves the width of every bar — five months of
  // empty grid so that two stale stock rows can begin on screen.
  //
  // So the scale comes from non-stock jobs, and a stock bar starting before the
  // window is clamped to the edge and marked as continuing off-chart. Nothing
  // is hidden; the scale just stops being dictated by rows with no commitment.
  const committed = dated.filter((r) => !r.job.is_stock);
  const scaleFrom = committed.length ? committed : dated;

  let min = scaleFrom[0].s, max = scaleFrom[0].e;
  for (const r of scaleFrom) {
    if (utc(r.s) < utc(min)) min = r.s;
    if (utc(r.e) > utc(max)) max = r.e;
  }
  // Always include today, even if no job spans it — a chart whose "now" marker
  // sits off the edge is disorienting.
  if (utc(asOf) < utc(min)) min = asOf;
  if (utc(asOf) > utc(max)) max = asOf;

  // Snap out to whole weeks so the gridlines land on Mondays.
  const start = weekStart(min);
  const end = addDays(weekStart(max), 7);
  const totalDays = daysBetween(start, end) || 1;
  const pct = (d) => (daysBetween(start, d) / totalDays) * 100;

  let overdue = 0;
  const byCat = new Map(CATEGORY_ORDER.map((c) => [c, []]));
  for (const { job, s, e } of dated) {
    // A bar that ends before today is a job whose promised date has passed and
    // which is still open. Worth its own colour: nothing else in the app shows
    // this, because the board sorts by due date and an overdue job just looks
    // like the top row.
    const isOverdue = utc(e) < utc(asOf) && !job.is_stock;
    if (isOverdue) overdue += 1;

    // +1 so a same-day job still has width; every bar covers whole days.
    const rawLeft = pct(s);
    const rawWidth = ((daysBetween(s, e) + 1) / totalDays) * 100;

    // Clamp to the window rather than letting a bar overhang the chart.
    const clippedStart = rawLeft < -0.001;
    const clippedEnd = rawLeft + rawWidth > 100.001;
    const left = Math.max(0, rawLeft);
    const width = Math.max(0.4, Math.min(100, rawLeft + rawWidth) - left);

    const row = {
      ...job,
      startDisplay: toAU(s),
      endDisplay: toAU(e),
      days: daysBetween(s, e) + 1,
      leftPct: left,
      widthPct: width,
      clippedStart,
      clippedEnd,
      overdue: isOverdue,
      startsBeforeToday: utc(s) < utc(asOf),
    };
    if (byCat.has(job.category)) byCat.get(job.category).push(row);
  }

  // A row whose whole span falls outside the window gets no useful bar — it
  // would be a sliver pinned to an edge, which reads as noise rather than as
  // information.
  //
  // On the 21/08 export that is every one of the seven stock builds: the latest
  // of them ended 16 June, two months before today. Stock sits on the board
  // indefinitely because it ignores the horizon, and its ERP dates are set when
  // the order is raised and never revised. The work may well be live in the
  // shop; the dates are simply not describing it.
  //
  // So they are listed separately, with their dates, rather than drawn. The
  // test is "outside the window", not "is stock" — a non-stock job with wild
  // dates would land here too, which is the behaviour worth having.
  const outside = (r) => utc(toDateOnly(r.end_date)) < utc(start) || utc(toDateOnly(r.start_date)) >= utc(end);

  const byStart = (a, b) =>
    String(a.start_date).localeCompare(String(b.start_date))
    || String(a.end_date).localeCompare(String(b.end_date));

  const groups = CATEGORY_ORDER
    .map((category) => ({
      category,
      rows: (byCat.get(category) ?? []).filter((r) => !outside(r)).sort(byStart),
    }))
    .filter((g) => g.rows.length);

  const unscheduled = CATEGORY_ORDER
    .flatMap((category) => (byCat.get(category) ?? []).filter(outside).map((r) => ({ ...r, category })))
    .sort(byStart);

  // Month bands for the header, clipped to the window.
  const months = [];
  let cursor = { y: start.y, m: start.m, d: 1 };
  if (utc(cursor) < utc(start)) cursor = start;
  while (utc(cursor) < utc(end)) {
    const nextMonth = cursor.m === 12 ? { y: cursor.y + 1, m: 1, d: 1 } : { y: cursor.y, m: cursor.m + 1, d: 1 };
    const stop = utc(nextMonth) < utc(end) ? nextMonth : end;
    months.push({
      label: `${MONTHS[cursor.m - 1]} ${String(cursor.y).slice(2)}`,
      leftPct: pct(cursor),
      widthPct: ((daysBetween(cursor, stop)) / totalDays) * 100,
    });
    cursor = nextMonth;
  }

  // Weekly gridlines.
  const weeks = [];
  for (let d = start; utc(d) < utc(end); d = addDays(d, 7)) weeks.push({ leftPct: pct(d), date: toISO(d) });

  const clipped = groups.flatMap((g) => g.rows).filter((r) => r.clippedStart || r.clippedEnd).length;

  return {
    start, end, totalDays, clipped, unscheduled,
    startDisplay: toAU(start), endDisplay: toAU(end),
    todayPct: pct(asOf),
    todayDisplay: toAU(asOf),
    groups, months, weeks, overdue, undated,
    rowCount: dated.length,
  };
}

// ---------------------------------------------------------------------------

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Draw the chart into a host element. */
export function renderGantt(host, jobs, opts = {}) {
  host.textContent = '';
  const g = ganttLayout(jobs, opts);

  if (!g.groups.length) {
    host.append(el('div', 'state', 'Nothing to chart — no job on the board has both a start and an end date.'));
    return g;
  }

  const summary = el('div', 'g-summary');
  summary.append(el('span', null, `${g.rowCount} jobs`));
  summary.append(el('span', 'sep', '·'));
  summary.append(el('span', null, `${g.startDisplay} — ${g.endDisplay}`));
  if (g.overdue) {
    summary.append(el('span', 'sep', '·'));
    const od = el('span', 'g-overdue-count', `${g.overdue} past its end date`);
    summary.append(od);
  }
  if (g.undated) {
    summary.append(el('span', 'sep', '·'));
    summary.append(el('span', null, `${g.undated} without dates, not shown`));
  }
  if (g.clipped) {
    summary.append(el('span', 'sep', '\u00b7'));
    summary.append(el('span', 'g-clip-note',
      `${g.clipped} run past the chart edge (\u2039 \u203a)`));
  }
  if (g.unscheduled.length) {
    summary.append(el('span', 'sep', '\u00b7'));
    summary.append(el('span', 'g-clip-note',
      `${g.unscheduled.length} with dates outside this window, listed below`));
  }
  host.append(summary);

  const chart = el('div', 'gantt');

  // --- header: months over the timeline ---
  const head = el('div', 'g-row g-head');
  head.append(el('div', 'g-label'));
  const scale = el('div', 'g-scale');
  for (const m of g.months) {
    const band = el('div', 'g-month', m.label);
    band.style.left = `${m.leftPct}%`;
    band.style.width = `${m.widthPct}%`;
    scale.append(band);
  }
  head.append(scale);
  chart.append(head);

  const gridlines = (into) => {
    for (const w of g.weeks) {
      const line = el('div', 'g-week');
      line.style.left = `${w.leftPct}%`;
      into.append(line);
    }
    if (g.todayPct >= 0 && g.todayPct <= 100) {
      const now = el('div', 'g-today');
      now.style.left = `${g.todayPct}%`;
      now.title = `Today — ${g.todayDisplay}`;
      into.append(now);
    }
  };

  for (const group of g.groups) {
    const banner = el('div', 'g-row g-banner');
    banner.append(el('div', 'g-label', group.category));
    const bscale = el('div', 'g-scale');
    gridlines(bscale);
    bscale.append(el('span', 'g-banner-n', `${group.rows.length}`));
    banner.append(bscale);
    chart.append(banner);

    for (const r of group.rows) {
      const row = el('div', `g-row${r.overdue ? ' is-overdue' : ''}${r.is_stock ? ' is-stock' : ''}`
        + `${r.clippedStart ? ' clip-start' : ''}${r.clippedEnd ? ' clip-end' : ''}`);

      const label = el('div', 'g-label');
      label.append(el('span', 'g-prod', r.prod_no));
      label.append(el('span', 'g-name', r.label));
      label.title = `${r.prod_no} — ${r.label}`;
      row.append(label);

      const track = el('div', 'g-scale');
      gridlines(track);

      const bar = el('div', 'g-bar');
      bar.style.left = `${r.leftPct}%`;
      bar.style.width = `${r.widthPct}%`;
      bar.title = `${r.label}\n${r.startDisplay} → ${r.endDisplay}  (${r.days} days)`
        + `${r.is_stock ? '\nStock build — no committed date' : ''}`
        + `${r.overdue ? '\nEnd date has passed' : ''}`
        + `${r.clippedStart ? '\nStarts before this chart begins' : ''}`
        + `${r.clippedEnd ? '\nRuns past the end of this chart' : ''}`;
      bar.append(el('span', 'g-bar-text', r.days >= 8 ? r.label : ''));
      track.append(bar);

      // The dates sit outside the bar so a short job is still readable.
      const tag = el('div', 'g-dates', `${r.startDisplay} – ${r.endDisplay}`);
      tag.style.left = `calc(${r.leftPct + r.widthPct}% + 8px)`;
      track.append(tag);

      row.append(track);
      chart.append(row);
    }
  }

  host.append(chart);

  if (g.unscheduled.length) {
    const box = el('div', 'g-unscheduled');
    const h = el('div', 'g-unsched-head');
    h.append(el('strong', null, `${g.unscheduled.length} jobs are not on the chart`));
    h.append(el('span', null,
      'Their start and end dates fall entirely outside it, so a bar would say nothing. '
      + 'Stock builds sit on the board indefinitely and their ERP dates are set once and '
      + 'not revised \u2014 the work can be live even when the dates are months old.'));
    box.append(h);

    for (const r of g.unscheduled) {
      const row = el('div', 'g-unsched-row');
      row.append(el('span', 'g-prod', r.prod_no));
      row.append(el('span', 'g-name', r.label));
      row.append(el('span', 'g-cat', r.category));
      row.append(el('span', 'g-when', `${r.startDisplay} \u2013 ${r.endDisplay}`));
      box.append(row);
    }
    host.append(box);
  }

  return g;
}
