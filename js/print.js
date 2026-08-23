// print.js — the printed board, and the auto-fit that keeps it to one page.
//
// Layout reproduces make_docx.js, which renders correctly at 48 jobs on one
// A4 page: an invisible two-column grid holds the four narrow categories,
// Davits runs full-width underneath because its descriptions are long.

import { PRINT_LAYOUT } from './rules.js';
import { byCategory, toAU, toDateOnly } from './transform.js';

// A4 at 96dpi, less the margins in the @page rule.
const PAGE_H = 1123;
const CONTENT_H = PAGE_H - Math.round(0.625 * 96) - Math.round(0.49 * 96);   // 1016px

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function categoryTable(category, jobs, { full = false } = {}) {
  const table = el('table');
  if (full) table.dataset.full = '1';

  const colgroup = el('colgroup');
  ['c-prod', '', 'c-due'].forEach((c) => { const col = el('col', c); colgroup.append(col); });
  table.append(colgroup);

  const thead = el('thead');
  const banner = el('tr');
  const bcell = el('th', 'banner', category.toUpperCase());
  bcell.colSpan = 3;
  banner.append(bcell);
  const head = el('tr');
  head.append(el('th', null, 'Prod Nbr:'), el('th', null, 'Vessel'), el('th', 'c-due', 'Due date'));
  thead.append(banner, head);
  table.append(thead);

  const tbody = el('tbody');
  for (const j of jobs) {
    const tr = el('tr');
    if (j.on_hold) tr.className = 'on-hold';
    tr.append(el('td', null, j.prod_no));
    tr.append(el('td', 'vessel', j.on_hold ? `${j.label}  [ON HOLD]` : j.label));
    const due = el('td', `due${j.is_stock ? ' stock' : ''}`, j.due_display);
    tr.append(due);
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

/**
 * Render the printed board into a container.
 * @param {HTMLElement} host   the element to fill (cleared first)
 * @param {Object} board       result of buildBoard()
 */
export function renderPrint(host, board) {
  host.textContent = '';

  const asOf = toAU(toDateOnly(board.meta.as_of));
  const end = board.meta.horizon_end ? toAU(toDateOnly(board.meta.horizon_end)) : null;

  host.append(el('div', 'doc-title', 'Current production orders'));
  // The covered range, not just the run date. A board that was trimmed says so
  // on its face — a silently shortened horizon that looks identical to a full
  // one is worse than no auto-fit at all.
  host.append(el('div', 'doc-range', `as of:  ${asOf}${end ? `  —  ${end}` : ''}`));

  const groups = byCategory(board.jobs);
  const grid = el('div', 'grid');

  for (const side of ['left', 'right']) {
    const col = el('div', 'col');
    for (const cat of PRINT_LAYOUT[side]) {
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

  const held = board.jobs.filter((j) => j.on_hold && !j.hidden).length;
  if (held) {
    host.append(el('div', 'hold-note',
      `${held} job(s) marked ON HOLD — confirm before starting.`));
  }
  return host;
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
 * Shrink the horizon until the board fits one page.
 *
 * The browser can measure, so it does — render, compare against the page box,
 * step down if it spills. No row-budget guessing.
 *
 * @param {HTMLElement} host        the print container (must be laid out, not display:none)
 * @param {(weeks:number)=>Object} build   returns a board for a given horizon
 * @param {{startWeeks:number, minWeeks:number}} opts
 * @returns {{board, weeks, fits, pages, trimmedFrom: number|null, steps: Array}}
 */
export function fitToPage(host, build, { startWeeks = 12, minWeeks = 4 } = {}) {
  const steps = [];
  let weeks = startWeeks;
  let board = build(weeks);
  renderPrint(host, board);
  let m = measure(host);
  steps.push({ weeks, jobs: board.meta.job_count, ...m });

  // Nothing to shrink towards if the page could not be measured — shrinking on
  // an unmeasurable render would trim the board for no reason.
  if (!m.measured) return { board, weeks, fits: false, pages: null, measured: false, trimmedFrom: null, steps };

  while (!m.fits && weeks - 1 >= minWeeks) {
    weeks -= 1;
    board = build(weeks);
    renderPrint(host, board);
    m = measure(host);
    steps.push({ weeks, jobs: board.meta.job_count, ...m });
  }

  return {
    board,
    weeks,
    fits: m.fits,
    pages: m.pages,
    measured: true,
    trimmedFrom: weeks === startWeeks ? null : startWeeks,
    steps,
  };
}
