// print.js — the printed board, and the auto-fit that keeps it to one page.
//
// Layout reproduces make_docx.js, which renders correctly at 48 jobs on one
// A4 page: an invisible two-column grid holds the four narrow categories,
// Davits runs full-width underneath because its descriptions are long.

import { PRINT_LAYOUT, ANCHOR_CATEGORY, CATEGORY_ORDER, WATERMAKER_CATEGORIES } from './rules.js';
import { byCategory, toAU, toDateOnly, jobTitle, printJobs, watermakerJobs } from './transform.js';

// A4 at 96dpi, less the margins in the @page rule.
const PAGE_H = 1123;
const CONTENT_H = PAGE_H - Math.round(0.625 * 96) - Math.round(0.49 * 96);   // 1016px

// ---------------------------------------------------------------------------
// THE PAGE BOX
//
// Every sheet is laid out for A4, which is what the preview shows, and printed
// on an A3 page box with the content zoomed by root two, as a PDF would be:
// every rule, font and box is 41% bigger and nothing reflows. The printer then
// scales it to whatever paper is in the tray - 1:1 on A3, exactly the preview
// on A4. The zoom is in the stylesheet (`#printRoot[data-drawn="a4"]`, print
// media only); the page rule that goes with it is written here, because @page
// cannot be scoped to an element and app.js switches it in with the sheet.
//
// The one sheet drawn at A3 itself is the warehouse copy on A3 paper: one
// portrait page, not zoomed, with the stylesheet's own margins.
//
// The zoom is 1.41 rather than 1.4142 so a sheet measured to the last pixel
// of A4 has a few pixels in hand on A3: the margins, scaled by root two and
// rounded down, leave a printable box 1437px tall against 1016 * 1.41 = 1433.
// ---------------------------------------------------------------------------
export const DRAWN = {
  a4: { margin: '0.88in 0.83in 0.68in' },   // 0.625in 0.59in 0.49in, times root two
  a3: { margin: null },                      // the stylesheet's own, 1:1
};

/**
 * The @page rule a sheet needs over the stylesheet's A4 portrait: the A3 box
 * either way, turned for landscape, with the margins scaled to match an A4
 * drawing. An unknown drawing size is A4.
 */
export function pageRule({ drawn = 'a4', landscape = false } = {}) {
  const d = DRAWN[drawn] ? drawn : 'a4';
  const margin = DRAWN[d].margin ? ` margin: ${DRAWN[d].margin};` : '';
  return `@page { size: A3 ${landscape ? 'landscape' : 'portrait'};${margin} }`;
}

/**
 * The paper the warehouse copy prints on - the one sheet that offers a choice,
 * because its two papers are two different sheets.
 *
 *   a4  landscape pages, as many as it takes: the A4 drawing zoomed onto the
 *       A3 box and scaled back down by the printer, which is how it has always
 *       printed and comes out well.
 *   a3  one portrait sheet drawn at A3, the type stepped down until it fits.
 */
export const WAREHOUSE_PAPER = {
  a4: { label: 'A4', drawn: 'a4', landscape: true, onePage: false },
  a3: { label: 'A3', drawn: 'a3', landscape: false, onePage: true },
};

/**
 * Split the narrow categories across two columns so the page is as short as
 * possible.
 *
 * The old layout pinned them: cylinder lifters + ladders on the left, launchers
 * + rotary on the right. With 19 cylinder-lifter rows against 5 rotary that
 * leaves the right column half empty and the page taller than it needs to be.
 *
 * ANCHOR_CATEGORY is exempt: cylinder lifters are pinned to the top of the left
 * column. It is the biggest category and the one the floor reads first, and a
 * balancer free to move it did — as row counts drifted between exports the
 * board reshuffled, which is exactly what makes a printed sheet hard to read.
 * The remaining three still balance around it, which is where the balancing was
 * earning its keep anyway.
 *
 * Three categories is 8 possible splits, so this takes the genuine optimum
 * rather than a heuristic. Cost is rows plus TABLE_OVERHEAD for the banner and
 * column-header rows each table carries; the taller column sets the height.
 * Ties keep board order, so the layout only moves when it actually gains
 * something.
 */
const TABLE_OVERHEAD = 2;

export function balanceColumns(counts, categories = PRINT_LAYOUT.narrow) {
  const present = categories.filter((c) => (counts[c] ?? 0) > 0);
  const anchored = present.filter((c) => c === ANCHOR_CATEGORY);
  const free = present.filter((c) => c !== ANCHOR_CATEGORY);
  const cost = (set) => set.reduce((n, c) => n + counts[c] + TABLE_OVERHEAD, 0);

  let best = null;
  for (let mask = 0; mask < (1 << free.length); mask++) {
    // The anchor is always first in the left column, so it is prepended rather
    // than being one of the things the mask decides.
    const left = [...anchored, ...free.filter((_, i) => mask & (1 << i))];
    const right = free.filter((_, i) => !(mask & (1 << i)));
    const height = Math.max(cost(left), cost(right));
    // Prefer the shorter page; then the more even split; then board order.
    const skew = Math.abs(cost(left) - cost(right));
    const score = [height, skew, mask];
    if (!best || score[0] < best.score[0]
        || (score[0] === best.score[0] && score[1] < best.score[1])) {
      best = { left, right, score };
    }
  }
  return { left: best.left, right: best.right };
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * One category's table.
 *
 * `ticks` is the warehouse copy's tick columns (WAREHOUSE_TICKS), drawn down
 * the left of every row; without them this is the regular sheet's table.
 * `title` overrides the banner, for the continuation of a category the
 * warehouse copy had to split.
 */
function categoryTable(category, jobs, { full = false, ticks = [], title = null } = {}) {
  const table = el('table');
  if (full) table.dataset.full = '1';

  const colgroup = el('colgroup');
  const cols = [...ticks.map(() => 'c-tick'), 'c-prod', '', 'c-due'];
  cols.forEach((c) => colgroup.append(el('col', c)));
  table.append(colgroup);

  const thead = el('thead');
  const banner = el('tr');
  const bcell = el('th', 'banner', (title ?? category).toUpperCase());
  bcell.colSpan = cols.length;
  banner.append(bcell);
  const head = el('tr');
  // A tick heading is two short lines, LIFTER over STARTED: side by side it
  // would take the width the vessel needs. The stylesheet keeps the break.
  for (const [top, bottom] of ticks) head.append(el('th', 'c-tick', `${top}\n${bottom}`));
  head.append(el('th', null, ticks.length ? 'Prod #' : 'Prod Nbr'),
    el('th', null, 'Vessel'), el('th', 'c-due', 'Due date'));
  thead.append(banner, head);
  table.append(thead);

  const tbody = el('tbody');
  for (const j of jobs) {
    const tr = el('tr');
    if (j.on_hold) tr.className = 'on-hold';
    for (let i = 0; i < ticks.length; i++) {
      const cell = el('td', 'tick');
      cell.append(el('span', 'tickbox'));   // not .box - that is the dialog
      tr.append(cell);
    }
    tr.append(el('td', null, j.prod_no));
    tr.append(el('td', 'vessel', j.on_hold ? `${jobTitle(j)}  [ON HOLD]` : jobTitle(j)));
    tr.append(el('td', `due${j.is_stock ? ' stock' : ''}`,
      ticks.length ? shortDate(j.due_display) : j.due_display));
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}


// ---------------------------------------------------------------------------
// THE WAREHOUSE COPY
//
// The board again, for the people picking it. Tick boxes down the left of
// every row - one to tick as a pick starts, one as it completes - then the
// same number, vessel and date, a size smaller with the dates shortened,
// printed landscape so the boxes have room. A lifter or a davit is picked
// twice over, the unit itself and its power pack, so those categories carry
// four.
//
// It paginates itself. The regular sheet shrinks its horizon to hold one
// page; this one is allowed to run on, but a category must not be cut in two
// by a page break, and a browser cannot be trusted with that inside a
// two-column grid. So the pages are built here, by measuring: each table goes
// into the shorter column of the page it fits on, and only a category too
// tall for a whole page on its own is split, with its banner saying so.
// ---------------------------------------------------------------------------

/** The tick columns a category carries, each heading as its two lines. */
export const WAREHOUSE_TICKS = {
  general: [['Pick', 'started'], ['Pick', 'completed']],
  lifters: [['Lifter', 'started'], ['Lifter', 'completed'], ['PP', 'started'], ['PP', 'completed']],
};

/** Four for the categories named lifter, cylinder and rotary, and for davits. */
export const ticksFor = (category) =>
  (/lifter|davit/i.test(category) ? WAREHOUSE_TICKS.lifters : WAREHOUSE_TICKS.general);

/** Short dates, 31/12/26, where the boxes have taken the year's width. STOCK stays STOCK. */
const shortDate = (display) => String(display ?? '').replace(/^(\d{2}\/\d{2}\/)\d{2}(\d{2})$/, '$1$2');

/**
 * Type sizes the A3 copy can fall back to, largest first. 10pt is the warehouse
 * copy's size, the same on A3 as on the A4 landscape pages: the two papers are
 * the same width, so the type and the columns come out the same size on
 * either. Below 8pt a wall sheet stops being worth printing. The stylesheet
 * reads the one chosen from `--wh-pt` on the host.
 */
export const WAREHOUSE_TYPE = [10, 9.5, 9, 8.5, 8];

/** A page of the warehouse copy: landscape A4, or portrait A3 for the one-sheet copy. */
function warehousePage(host, { onePage, asOf, tags, cls = '' }) {
  const page = el('section', `page${onePage ? ' a3' : ''}${cls ? ` ${cls}` : ''}`);
  const sheet = el('div', 'sheet');
  const head = el('div', 'doc-head');
  head.append(el('div', 'doc-title', 'Current production orders'));
  for (const t of tags) head.append(el('div', 'doc-tag', t));
  head.append(el('div', 'doc-range', `as of:  ${asOf}`));
  sheet.append(head);
  page.append(sheet);
  host.append(page);
  return { page, sheet, head };
}

/** "page 1 of 3" on every page once there is more than one; nothing on a lone page. */
function numberPages(host) {
  const pages = [...host.querySelectorAll('.page')];
  for (const p of pages) p.querySelector('.doc-page')?.remove();
  if (pages.length < 2) return;
  pages.forEach((pg, i) => pg.querySelector('.doc-range')
    .append(el('span', 'doc-page', `  \u00b7  page ${i + 1} of ${pages.length}`)));
}

/**
 * Draw the warehouse copy into the host, once, at the type size given.
 *
 * On A4 it is landscape pages. The page box is the stylesheet's (`#printRoot
 * .page`): landscape A4 with the @page margins as padding, and a sheet inside
 * it that clips. Content past the sheet's foot is what would be a second piece
 * of paper, so that is the test every placement makes.
 *
 * On A3 (`onePage`) it is one portrait sheet drawn at A3 (`.page.a3`). The
 * test is the same, but there is no second page to go to: everything is
 * placed, the foot overrun if it must be, and `fits` says which - for
 * fitWarehouse to trim the horizon and then the type, and for the status line
 * to repeat rather than paper to hide.
 *
 * @returns {{pages:number, measured:boolean, split:string[], fits:boolean,
 *   pt:number, onePage:boolean, shrunk:boolean}}  how many pages; whether the
 *   host could be measured (off-canvas it cannot, and then the whole board
 *   lands on one page as a stand-in until it is drawn again); the categories
 *   that had to be split because one alone outran a page; whether it all fits
 *   (always, where it may run on); and the type size it is drawn at.
 */
export function renderWarehouse(host, board, { onePage = false, pt = WAREHOUSE_TYPE[0] } = {}) {
  host.dataset.variant = 'warehouse';
  host.style.setProperty('--wh-pt', `${pt}pt`);
  return { ...packWarehouse(host, board, { onePage }), pt, onePage, shrunk: pt !== WAREHOUSE_TYPE[0] };
}

/** One draw of the warehouse copy at the type size set: paged, or on the one sheet. */
function packWarehouse(host, board, { onePage }) {
  host.textContent = '';

  const asOf = toAU(toDateOnly(board.meta.as_of));
  const all = printJobs(board);
  const groups = byCategory(all);
  const measurable = host.getClientRects().length > 0;
  const pages = [];

  const newPage = () => {
    const { page, sheet, head } = warehousePage(host, { onePage, asOf, tags: ['WAREHOUSE'] });
    const grid = el('div', 'grid');
    const cols = [el('div', 'col'), el('div', 'col')];
    grid.append(...cols);
    sheet.append(grid);
    const p = { page, sheet, head, cols, fullWrap: null };
    pages.push(p);
    return p;
  };
  const spills = measurable ? (p) => p.sheet.scrollHeight > p.sheet.clientHeight : () => false;
  const empty = (p) => !p.page.querySelector('table');
  // The shorter column, which balances the two as the regular sheet does and
  // leaves the most room beneath for Davits. Ties go to the emptier, then the
  // left, so an unmeasurable draw still alternates.
  const shorter = (p) => {
    const [a, b] = p.cols;
    const ha = a.offsetHeight, hb = b.offsetHeight;
    return ha < hb || (ha === hb && a.children.length <= b.children.length) ? a : b;
  };
  const fullWrap = (p) => {
    if (!p.fullWrap) { p.fullWrap = el('div', 'full'); p.sheet.append(p.fullWrap); }
    return p.fullWrap;
  };
  // Put a table on a page if it fits there, and say whether it did. A narrow
  // table tries the shorter column, then the other; a full-width one the strip
  // under the grid. `anyway` keeps it in the first slot whether it fits or not,
  // for the one sheet that has nowhere else to send it.
  const tryPage = (p, table, full, anyway = false) => {
    const slots = full ? [fullWrap(p)] : [shorter(p)];
    if (!full) slots.push(p.cols.find((c) => c !== slots[0]));
    for (const slot of slots) {
      slot.append(table);
      if (anyway || !spills(p)) return true;
      table.remove();
    }
    if (full && !p.fullWrap.children.length) { p.fullWrap.remove(); p.fullWrap = null; }
    return false;
  };
  // The most rows of a category that fit on this (empty) page, by halving.
  // At least one, so a split always advances.
  const rowsThatFit = (p, category, jobs, opts) => {
    let lo = 1, hi = jobs.length - 1;     // all of them did not fit
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const t = categoryTable(category, jobs.slice(0, mid), opts);
      if (tryPage(p, t, opts.full)) { t.remove(); lo = mid; } else hi = mid - 1;
    }
    return lo;
  };

  let p = newPage();
  let overrun = false;      // the one sheet, past its foot
  const split = [];
  const items = [
    ...PRINT_LAYOUT.narrow.map((c) => [c, false]),
    ...PRINT_LAYOUT.full.map((c) => [c, true]),
  ];
  for (const [category, full] of items) {
    const ticks = ticksFor(category);
    let rest = groups.get(category) ?? [];
    let title = category;
    while (rest.length) {
      const opts = { full, ticks, title };
      const table = categoryTable(category, rest, opts);
      if (tryPage(p, table, full)) break;
      // The one sheet: on it goes, past the foot, and the caller is told.
      if (onePage) { tryPage(p, table, full, true); overrun = true; break; }
      if (!empty(p)) { p = newPage(); if (tryPage(p, table, full)) break; }
      // Alone on an empty page and still too tall: as many rows as fit here,
      // and the rest carries on under a banner that says so.
      const n = rowsThatFit(p, category, rest, opts);
      tryPage(p, categoryTable(category, rest.slice(0, n), opts), full);
      if (!split.includes(category)) split.push(category);
      rest = rest.slice(n);
      title = `${category} (continued)`;
    }
  }

  const held = all.filter((j) => j.on_hold).length;
  if (held) {
    const note = el('div', 'hold-note', `${held} job(s) marked ON HOLD \u2014 confirm before starting.`);
    p.sheet.append(note);
    if (spills(p)) {
      if (onePage) overrun = true;
      else { note.remove(); p = newPage(); p.sheet.append(note); }
    }
  }

  numberPages(host);
  return { pages: pages.length, measured: measurable, split, fits: !overrun };
}

/**
 * The warehouse copy's watermaker page, after the board's pages: the two
 * watermaker categories with the standard pair of pick boxes, full width, on a
 * page of their own - the next landscape page on A4, a second portrait sheet
 * on A3. One page only, so fitWarehouse can trim its horizon to hold it; past
 * the foot is reported, not paged. Drawing it again replaces the last one.
 *
 * @returns {{jobs:number, fits:boolean, measured:boolean}}
 */
export function appendWarehouseWater(host, board, { onePage = false } = {}) {
  for (const old of host.querySelectorAll('.page.water')) old.remove();
  const asOf = toAU(toDateOnly(board.meta.as_of));
  const { sheet } = warehousePage(host, { onePage, asOf, tags: ['WAREHOUSE', 'WATERMAKERS'], cls: 'water' });

  const jobs = watermakerJobs(board, { horizon: true });
  const groups = byCategory(jobs);
  for (const cat of WATERMAKER_CATEGORIES) {
    const list = groups.get(cat) ?? [];
    if (!list.length) continue;
    const wrap = el('div', 'full');
    wrap.append(categoryTable(cat, list, { full: true, ticks: WAREHOUSE_TICKS.general }));
    sheet.append(wrap);
  }
  const held = jobs.filter((j) => j.on_hold).length;
  if (held) sheet.append(el('div', 'hold-note', `${held} job(s) marked ON HOLD — confirm before starting.`));

  numberPages(host);
  const measured = host.getClientRects().length > 0;
  return { jobs: jobs.length, fits: !measured || sheet.scrollHeight <= sheet.clientHeight, measured };
}

/**
 * The warehouse copy, fitted, with its watermaker page when asked for.
 *
 * On A4 the board part is the board as fitted - the same jobs as the board's
 * own page, on as many landscape pages as it takes. On A3 it has a horizon of
 * its own: from the setting down, as the board's auto-fit goes, until the one
 * sheet holds it at the A4 copy's type size; only when the floor of the
 * horizon will not fit does the type step down, WAREHOUSE_TYPE at that
 * horizon. The watermaker page has a horizon of its own the same way. With
 * auto-fit off nothing is trimmed, and the status line says what spilled.
 *
 * @param {HTMLElement} host
 * @param {{board?:Object, build:(weeks:number)=>Object, onePage?:boolean,
 *   startWeeks?:number, minWeeks?:number, autoFit?:boolean, water?:boolean}} opts
 *   `board` for the A4 copy, `build` for everything with a horizon of its own
 */
export function fitWarehouse(host, { board = null, build, onePage = false, startWeeks = 12, minWeeks = 4,
                                     autoFit = true, water = false }) {
  const fit = { startWeeks, minWeeks, autoFit };
  let out;
  if (!onePage) {
    out = { ...renderWarehouse(host, board), board, weeks: null, trimmedFrom: null };
  } else {
    out = fitHorizon(build, (b) => renderWarehouse(host, b, { onePage: true }), fit);
    if (!out.fits && out.measured && autoFit) {
      for (const pt of WAREHOUSE_TYPE.slice(1)) {
        out = { ...out, ...renderWarehouse(host, out.board, { onePage: true, pt }) };
        if (out.fits) break;
      }
    }
  }
  out.water = water ? fitHorizon(build, (b) => appendWarehouseWater(host, b, { onePage }), fit) : null;
  return out;
}

// ---------------------------------------------------------------------------
// THE FOLLOW-UP SHEETS
//
// Internal factory jobs and T&M, printed as a plain full-width list. They are
// not the board and should not pretend to be: the board is a schedule, laid
// out in two columns by category because the floor reads it category-first.
// These are a list to walk down and chase, so one column, one row per job.
//
// NO DUE DATES, DELIBERATELY. The end dates on these rows are ERP defaults
// that mean nothing - the same reason they are kept off the Gantt. What they
// do have is an OPEN date, which is real, so the sheet leads on how long each
// job has been sitting and orders by it. That is what a follow-up list is for.
// ---------------------------------------------------------------------------

/**
 * Longest-open first.
 *
 * It decides which rows survive the trim as well as the reading order: when
 * the sheet has to lose rows to fit a page, the ones it drops are the newest,
 * which are the least in need of chasing.
 */
export const followUpOrder = (jobs) => [...(jobs ?? [])]
  .sort((a, b) => (b.age_days ?? -1) - (a.age_days ?? -1));

/**
 * Group into the same categories the tab shows, in the same order.
 *
 * A category the order does not name still gets a group rather than being
 * dropped - the same rule the on-screen list follows, and the reason a new
 * category appearing in an export is visible instead of silently missing.
 */
function laneGroups(jobs, order) {
  const byCat = new Map((order ?? []).map((c) => [c, []]));
  for (const j of jobs) {
    if (!byCat.has(j.category)) byCat.set(j.category, []);
    byCat.get(j.category).push(j);
  }
  return [...byCat.entries()].filter(([, list]) => list.length);
}

/** One category's table: the lane columns, under a banner naming the category. */
function laneTable(category, jobs, itemLabel) {
  const table = el('table');
  table.dataset.full = '1';

  const colgroup = el('colgroup');
  ['c-prod', '', 'c-for', 'c-open', 'c-status']
    .forEach((c) => colgroup.append(el('col', c)));
  table.append(colgroup);

  const thead = el('thead');
  const banner = el('tr');
  const bcell = el('th', 'banner', String(category).toUpperCase());
  bcell.colSpan = 5;
  banner.append(bcell);
  const hr = el('tr');
  hr.append(el('th', null, 'Prod Nbr'), el('th', null, 'Job'),
    el('th', null, itemLabel), el('th', 'c-open', 'Open'),
    el('th', 'c-status', 'Status'));
  thead.append(banner, hr);
  table.append(thead);

  const tbody = el('tbody');
  for (const j of jobs) {
    const tr = el('tr');
    if (j.on_hold) tr.className = 'on-hold';
    tr.append(el('td', null, j.prod_no));
    tr.append(el('td', 'vessel', j.on_hold ? `${jobTitle(j)}  [ON HOLD]` : jobTitle(j)));
    tr.append(el('td', null, j.customer_display ?? ''));
    tr.append(el('td', 'c-open', j.age_display ?? ''));
    tr.append(el('td', 'c-status', j.status ?? ''));
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

/**
 * @param {HTMLElement} host
 * @param {{jobs: Array, title: string, asOf: string, itemLabel: string,
 *          order?: string[], total?: number}} opts
 */
export function renderLanePrint(host, { jobs, title, asOf, itemLabel, order = null, total = null }) {
  host.textContent = '';
  host.dataset.variant = '';            // never the warehouse styling, whatever was drawn before

  const head = el('div', 'doc-head');
  head.append(el('div', 'doc-title', title));
  const shown = total && total > jobs.length ? `${jobs.length} of ${total}  \u00b7  ` : '';
  head.append(el('div', 'doc-range', `${shown}as of:  ${asOf}`));
  host.append(head);

  for (const [category, list] of laneGroups(jobs, order)) {
    const wrap = el('div', 'full');
    wrap.append(laneTable(category, list, itemLabel));
    host.append(wrap);
  }

  if (total && total > jobs.length) {
    host.append(el('div', 'hold-note',
      `${total - jobs.length} more not shown - trimmed to fit one page, newest first.`));
  }
  return host;
}

/**
 * Trim a follow-up list until it fits one page.
 *
 * The board shrinks by HORIZON because a board is a window on the near future.
 * These lists have no meaningful future to narrow, so they shrink by row count
 * instead, dropping from the newest end - see `followUpOrder`.
 *
 * The first guess comes from the measured overflow rather than stepping
 * blindly: height is near enough linear in row count, so one proportional jump
 * lands close and the walk afterwards is a row or two.
 */
export function fitLaneToPage(host, allJobs, { title, asOf, itemLabel, order = null, minRows = 5 } = {}) {
  // Longest-open first decides WHICH rows survive a trim; the grouping decides
  // where they sit once they have. Sorting inside each category falls out of
  // it, because the groups are built from an already-sorted list.
  const ordered = followUpOrder(allJobs);
  const total = ordered.length;
  const draw = (n) => {
    renderLanePrint(host, { jobs: ordered.slice(0, n), title, asOf, itemLabel, order, total });
    return measure(host);
  };

  let rows = total;
  let m = draw(rows);
  // Unmeasurable means off-canvas. Trimming on that would cut the sheet for a
  // reason that says more about the layout than the page - same trap as the
  // board's auto-fit.
  if (!m.measured) return { jobs: ordered, rows, total, ...m, trimmedFrom: null };

  if (!m.fits && m.height > 0) {
    rows = Math.max(minRows, Math.floor(rows * (m.limit / m.height)));
    m = draw(rows);
  }
  while (!m.fits && rows > minRows) { rows -= 1; m = draw(rows); }
  // A jump that overshot leaves room back; take it while it still fits.
  while (m.fits && rows < total) {
    const next = draw(rows + 1);
    if (!next.fits) { m = draw(rows); break; }
    rows += 1; m = next;
  }

  return { jobs: ordered.slice(0, rows), rows, total, ...m,
           trimmedFrom: rows < total ? total : null };
}

/**
 * Render the printed board into a container.
 * @param {HTMLElement} host   the element to fill (cleared first)
 * @param {Object} board       result of buildBoard()
 */
export function renderPrint(host, board) {
  host.textContent = '';
  host.dataset.variant = '';           // the regular sheet, whatever was drawn before

  const asOf = toAU(toDateOnly(board.meta.as_of));

  const head = el('div', 'doc-head');
  head.append(el('div', 'doc-title', 'Current production orders'));
  head.append(el('div', 'doc-range', `as of:  ${asOf}`));
  host.append(head);

  // What reaches the paper is a narrower question than what is on the board:
  // watermakers have no column, the horizon trims by due date and the stock cap
  // trims by count. All three are page-fitting decisions — see transform.js.
  const groups = byCategory(printJobs(board));

  // Which category sits in which column is decided by row count, not pinned.
  const counts = Object.fromEntries(
    CATEGORY_ORDER.map((c) => [c, (groups.get(c) ?? []).length]));
  const { left, right } = balanceColumns(counts);

  const grid = el('div', 'grid');
  for (const side of [left, right]) {
    const col = el('div', 'col');
    for (const cat of side) {
      const jobs = groups.get(cat) ?? [];
      if (jobs.length) col.append(categoryTable(cat, jobs));
    }
    grid.append(col);
  }
  host.append(grid);

  for (const cat of PRINT_LAYOUT.full) {
    const jobs = groups.get(cat) ?? [];
    if (jobs.length) {
      const wrap = el('div', 'full');
      wrap.append(categoryTable(cat, jobs, { full: true }));
      host.append(wrap);
    }
  }

  const held = printJobs(board).filter((j) => j.on_hold).length;
  if (held) {
    host.append(el('div', 'hold-note',
      `${held} job(s) marked ON HOLD — confirm before starting.`));
  }
  return host;
}

// ---------------------------------------------------------------------------
// THE WATERMAKER PAGE
//
// Watermakers have no column on the board: PRINT_LAYOUT lists what prints and
// they are not on it, so on screen they sit at the foot of Current orders
// under "Not on the printed sheet". This is the one way they reach paper - a
// second page after the board, when the Print tab asks for one, in the
// board's own style under a header of its own. The board's page is untouched
// either way, and the auto-fit never measures this one, so the horizon does
// not move for it.
// ---------------------------------------------------------------------------

/**
 * Draw the watermaker page into its host.
 *
 * `horizon` applies the board's own trim - past the horizon, or stock beyond
 * the cap, stays off - and without it every open watermaker job is listed.
 *
 * @returns {number}  how many jobs it lists; none means nothing to print
 */
export function renderWatermakers(host, board, { horizon = true } = {}) {
  host.textContent = '';
  host.dataset.variant = '';

  const asOf = toAU(toDateOnly(board.meta.as_of));
  const head = el('div', 'doc-head');
  head.append(el('div', 'doc-title', 'Current production orders'));
  head.append(el('div', 'doc-tag', 'WATERMAKERS'));
  head.append(el('div', 'doc-range', `as of:  ${asOf}`));
  host.append(head);

  const jobs = watermakerJobs(board, { horizon });
  const groups = byCategory(jobs);
  for (const cat of WATERMAKER_CATEGORIES) {
    const list = groups.get(cat) ?? [];
    if (!list.length) continue;
    const wrap = el('div', 'full');
    wrap.append(categoryTable(cat, list, { full: true }));
    host.append(wrap);
  }

  const held = jobs.filter((j) => j.on_hold).length;
  if (held) {
    host.append(el('div', 'hold-note',
      `${held} job(s) marked ON HOLD — confirm before starting.`));
  }
  return jobs.length;
}

/**
 * Measured height of the rendered board against the A4 content box.
 *
 * The preview's padding IS the page margin, so it must come off before the
 * comparison — CONTENT_H already has the margins subtracted, and counting them
 * twice makes a board that fits look like it spills.
 *
 * An element that is not laid out (display:none, or inside a [hidden] parent)
 * reports a height of zero, which reads as a comfortable fit. That is the worst
 * possible failure here: it silently blesses a board that runs to three pages.
 * Say "unmeasurable" instead.
 */
export function measure(host) {
  if (!host.getClientRects().length) {
    return { height: null, limit: CONTENT_H, fits: false, pages: null, measured: false };
  }
  const cs = getComputedStyle(host);
  const padding = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const h = Math.max(0, host.scrollHeight - padding);
  return { height: h, limit: CONTENT_H, fits: h <= CONTENT_H, pages: Math.max(1, Math.ceil(h / CONTENT_H)), measured: true };
}

/**
 * Shrink a horizon until a drawing fits one page.
 *
 * The browser can measure, so it does: `draw(board)` draws the board at that
 * horizon and says whether it fits and whether it could be measured, and the
 * horizon steps down while it spills. No row-budget guessing. The board's own
 * page, the warehouse copy on A3 and the watermaker pages all fit this way.
 *
 * Nothing is shrunk towards if the page could not be measured - trimming on an
 * unmeasurable render would cut the board for a reason that says more about
 * the layout than the page. With auto-fit off it draws once at the start and
 * reports.
 *
 * @param {(weeks:number)=>Object} build   returns a board for a given horizon
 * @param {(board:Object)=>{fits:boolean, measured:boolean}} draw
 * @param {{startWeeks?:number, minWeeks?:number, autoFit?:boolean}} opts
 * @returns {{board, weeks, fits, measured, trimmedFrom: number|null, steps: Array}}
 *   plus whatever else the last draw reported
 */
export function fitHorizon(build, draw, { startWeeks = 12, minWeeks = 4, autoFit = true } = {}) {
  const steps = [];
  let weeks = startWeeks;
  let board = build(weeks);
  let m = draw(board);
  steps.push({ weeks, jobs: board.meta.job_count, ...m });
  if (!m.measured || !autoFit) return { board, weeks, ...m, trimmedFrom: null, steps };

  while (!m.fits && weeks - 1 >= minWeeks) {
    weeks -= 1;
    board = build(weeks);
    m = draw(board);
    steps.push({ weeks, jobs: board.meta.job_count, ...m });
  }
  return { board, weeks, ...m, trimmedFrom: weeks === startWeeks ? null : startWeeks, steps };
}

/**
 * Shrink the horizon until the board fits one page: fitHorizon over the
 * regular sheet, measured against the A4 content box.
 *
 * @param {HTMLElement} host        the print container (must be laid out, not display:none)
 * @param {(weeks:number)=>Object} build   returns a board for a given horizon
 * @param {{startWeeks?:number, minWeeks?:number, autoFit?:boolean}} opts
 * @returns {{board, weeks, fits, pages, measured, trimmedFrom: number|null, steps: Array}}
 */
export function fitToPage(host, build, opts = {}) {
  return fitHorizon(build, (board) => { renderPrint(host, board); return measure(host); }, opts);
}
