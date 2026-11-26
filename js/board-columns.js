// board-columns.js - which columns a board row has, for whom, and the created
// date's cells.
//
// THE HEADER HAS EXACTLY THE CELLS THE ROWS HAVE. A header cell with no column
// under it walks every heading after it one track off the data it labels, so
// the list of columns is written once, here, and the header is drawn from it.
// The rows (app.js `jobRow`) append the same cells in the same order, and the
// stylesheet gives each view as many tracks as it shows cells.
//
// The created date is a manager's column, never on the printed sheet (print.js
// draws its own columns). Where a screen has no room for it - below a wide
// desk screen, and on a phone - the column gives way and the row's folded
// controls carry it instead, worded so it is never read as the due date.

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Every column a production row can have: key, heading, the cell's class. */
export const BOARD_COLUMNS = [
  { key: 'prod', head: 'Prod Nbr' },
  { key: 'po', head: 'PO', cls: 'po', manager: true },
  { key: 'label', head: 'Vessel' },
  { key: 'hull', head: 'Hull' },
  { key: 'created', head: 'Created', cls: 'created', manager: true },
  { key: 'due', head: 'Due' },
  // Classed so its heading gives way with the column on a narrower screen.
  { key: 'status', head: 'Status', cls: 'status', manager: true, full: true },
  { key: 'acts', head: '', manager: true },
];

/** The columns a row has: the floor's are the printed ones and the hull. */
export const boardColumns = ({ manager = false, full = false } = {}) =>
  BOARD_COLUMNS.filter((c) => (!c.manager || manager) && (!c.full || full));

/** The header row for a category block. */
export function boardHead({ manager = false, full = false } = {}) {
  const hdr = el('div', `job col-head${full ? ' is-full' : ''}`);
  for (const c of boardColumns({ manager, full })) hdr.append(el('span', c.cls ?? null, c.head));
  return hdr;
}

/**
 * History's columns. A production job has the board's PO and hull, in the
 * board's order; the other lanes have neither on the board, so neither here.
 */
const HISTORY_COLUMNS = {
  production: [
    { key: 'prod', head: 'Prod Nbr' },
    { key: 'po', head: 'PO', cls: 'po' },
    { key: 'label', head: 'Vessel' },
    { key: 'hull', head: 'Hull', cls: 'hull' },
    { key: 'due', head: 'Due' },
    { key: 'when', head: 'Completed' },
    { key: 'touched', head: 'Last changed' },
    { key: 'acts', head: '' },
  ],
  other: [
    { key: 'prod', head: 'Prod Nbr' },
    { key: 'label', head: 'Job' },
    { key: 'due', head: 'Opened' },
    { key: 'when', head: 'Completed' },
    { key: 'touched', head: 'Last changed' },
    { key: 'acts', head: '' },
  ],
};

export const historyColumns = (lane) => HISTORY_COLUMNS[lane] ?? HISTORY_COLUMNS.other;

/** The class that gives a History row as many tracks as it has cells. */
export const historyRowClass = (lane) => `hist-row${lane === 'production' ? ' is-prod' : ''}`;

/** The header row of a History category. */
export function historyHead(lane) {
  const hdr = el('div', `${historyRowClass(lane)} hist-head`);
  for (const c of historyColumns(lane)) hdr.append(el('span', c.cls ?? null, c.head));
  return hdr;
}

/**
 * When a job is due, as a dialog says it after its name: `, due 02/11/2026`.
 * A stock build has no date to keep, and a side lane's job has only an age.
 */
export function whenWords(j) {
  if ((j?.lane ?? 'production') !== 'production') return `, open ${j?.age_display || 'since it was raised'}`;
  return j?.is_stock || !j?.due_display ? '' : `, due ${j.due_display}`;
}

/** The created date in its column; blank when the ERP gave none. */
export const createdCell = (j) => el('span', 'created', j?.created_display ?? '');

/**
 * The created date among the folded controls, for a screen that has no room
 * for the column. Null when there is no date to show.
 */
export const createdNote = (j) =>
  (j?.created_display ? el('span', 'created-note', `Created: ${j.created_display}`) : null);

/** The PO among the folded controls, where its column gives way. Null when there is none. */
export const poNote = (j) => (j?.customer_po ? el('span', 'created-note po-note', `PO: ${j.customer_po}`) : null);

/**
 * What the ERP says, among the folded controls, where a person has said
 * otherwise: it was in a tooltip, which a finger cannot open. Null when nobody has.
 */
export function erpNote(j) {
  const said = [
    j?.status_manual && j.erp_status ? `status ${j.erp_status}` : null,
    j?.hull_manual ? `hull ${j.hull_auto || 'none'}` : null,
  ].filter(Boolean);
  return said.length ? el('span', 'erp-note', `ERP: ${said.join(', ')}`) : null;
}
