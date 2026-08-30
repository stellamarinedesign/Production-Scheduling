// codes-print.js — the vessel code cheat sheet, one landscape A4 page.
//
// Same visual language as the production board: red category banners, zebra
// rows, a title and an "as of" line. Landscape because the useful thing here is
// the width — a boat's display code, the ERP codes that resolve to it, what
// Riviera call it and which hulls it has been fitted to, all readable on one
// line at arm's length.
//
// The board fits by shortening its horizon. This sheet has no horizon to
// shorten, so it fits by stepping the type down instead, and says so when it
// does rather than quietly serving a smaller sheet than the one you approved.

import { toAU, today as todayDate } from './transform.js';

// A4 landscape at 96dpi, less the margins in the @page rule.
const PAGE_W = 1123;
const PAGE_H = 794;
const MARGIN = 48;                                  // 0.5in
export const CONTENT_H = PAGE_H - MARGIN * 2;       // 698
export const CONTENT_W = PAGE_W - MARGIN * 2;       // 1027

// Type sizes to try, largest first. 11pt is the board's size and the one that
// reads at arm's length; below 8pt a wall sheet stops being worth printing.
export const TYPE_STEPS = [11, 10, 9, 8];

const SHORT = {
  'Cylinder lifters': 'Lifter',
  'Rotary Lifters': 'Rotary',
  'Launchers, Doors & Chocks': 'Launcher/Door',
  'Ladders and Chairs': 'Ladder/Chair',
  Davits: 'Davit',
};
export const shortCat = (c) => SHORT[c] ?? c ?? '';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * Build the sheet into a host element.
 *
 * @param {HTMLElement} host
 * @param {Array} rows   from boatRows()
 * @param {{mode:'boats'|'products', asOf}} opts
 */
export function renderCodesSheet(host, rows, { mode = 'boats', asOf = todayDate() } = {}) {
  host.textContent = '';

  const head = el('div', 'cs-head');
  head.append(el('div', 'cs-title', 'Vessel codes'));
  head.append(el('div', 'cs-sub', mode === 'boats'
    ? 'What the floor reads for each boat'
    : 'What the floor reads, by product line'));
  head.append(el('div', 'cs-range', `as of:  ${toAU(asOf)}`));
  host.append(head);

  const table = el('table', 'cs-table');
  const colgroup = el('colgroup');
  for (const c of ['c-disp', 'c-erp', 'c-riv', 'c-hull', 'c-prod']) colgroup.append(el('col', c));
  table.append(colgroup);

  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', null, 'Reads as'), el('th', null, 'ERP codes'),
    el('th', null, 'Riviera'), el('th', null, 'Hull'), el('th', null, 'Products'));
  thead.append(hr);
  table.append(thead);

  const tbody = el('tbody');
  let current = null;
  for (const r of rows) {
    const cat = r.category ?? 'Other';
    if (cat !== current) {
      current = cat;
      const banner = el('tr', 'cs-banner');
      const cell = el('th', null, cat.toUpperCase());
      cell.colSpan = 5;
      banner.append(cell);
      tbody.append(banner);
    }

    const tr = el('tr');
    tr.append(el('td', 'cs-disp', r.display));
    // The ERP codes are the point of the sheet: it is the lookup somebody
    // reaches for when a job card says SY23 and the drawing says 56SY.
    tr.append(el('td', 'cs-erp', r.codes.join('  ·  ')));
    tr.append(el('td', 'cs-riv', r.riviera.join(', ') || '—'));
    tr.append(el('td', 'cs-hull', r.hulls.join(', ') || '—'));
    tr.append(el('td', 'cs-prod', mode === 'products'
      ? r.items.map((x) => x.item).join('  ·  ')
      : r.categories.map(shortCat).join('  ·  ')));
    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);

  return host;
}

/**
 * Measured height of the sheet's CONTENT against the landscape A4 content box.
 *
 * Not scrollHeight: the on-screen preview carries `min-height: 794px` so it
 * looks like a whole page, which pins scrollHeight to the page height and makes
 * every sheet report as exactly filling it however little is on it. Measuring
 * first child top to last child bottom gives the real extent, and still grows
 * correctly once the content is genuinely taller than the page.
 */
export function measureSheet(host) {
  const first = host.firstElementChild;
  const last = host.lastElementChild;
  if (!first || !host.getClientRects().length) {
    return { height: null, limit: CONTENT_H, fits: false, measured: false };
  }
  const h = Math.max(0, Math.round(
    last.getBoundingClientRect().bottom - first.getBoundingClientRect().top));
  return { height: h, limit: CONTENT_H, fits: h <= CONTENT_H, measured: true };
}

/**
 * Render, and step the type down until it fits one page.
 *
 * @returns {{pt:number, fits:boolean, height:number|null, shrunk:boolean, steps:Array}}
 */
export function fitCodesSheet(host, rows, opts = {}) {
  const steps = [];
  for (const pt of TYPE_STEPS) {
    host.style.setProperty('--cs-pt', `${pt}pt`);
    renderCodesSheet(host, rows, opts);
    const m = measureSheet(host);
    steps.push({ pt, ...m });
    // An unmeasurable host reports zero height, which reads as a comfortable
    // fit — the same trap the board's auto-fit had. Stop rather than claim one.
    if (!m.measured) return { pt, fits: false, height: null, shrunk: false, measured: false, steps };
    if (m.fits) {
      return { pt, fits: true, height: m.height, limit: m.limit,
        shrunk: pt !== TYPE_STEPS[0], measured: true, steps };
    }
  }
  const last = steps[steps.length - 1];
  return { pt: TYPE_STEPS[TYPE_STEPS.length - 1], fits: false, height: last.height,
    limit: CONTENT_H, shrunk: true, measured: true, steps };
}
