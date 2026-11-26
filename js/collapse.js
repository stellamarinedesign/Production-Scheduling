// collapse.js - what the Collapse all button acts on.
//
// Every fold on the page is one key in one saved set: a board category by its
// name, a History category as `hist:<lane>:<category>`, a Gantt band as
// `gantt:<category>`. The button belongs to whatever is in the board's place.
// With History open that is History's categories and nothing else; otherwise
// it is the board's. It never touches a fold that is not on the screen.
//
// A row opened to its controls is a fold of its own: one is open at a time.

export const historyKey = (lane, cat) => `hist:${lane}:${cat}`;

/**
 * @param {object} view
 * @param {boolean} view.recent    the Activity log is in the board's place
 * @param {boolean} view.history   History is in the board's place
 * @param {string[]} view.order    the categories, in order
 * @param {(cat: string) => number} view.count         the board's jobs in a category
 * @param {(cat: string) => number} view.historyCount  History's
 * @param {string[]} [view.extra]  categories on screen that are not in `order`
 * @returns {{keys: string[], shown: string[]}} every fold of the view, and those
 *          with something under them
 */
export function collapseScope({ recent, history, order, count, historyCount, extra = [] }) {
  if (recent) return { keys: [], shown: [] };
  const key = history ? (c) => historyKey('production', c) : (c) => c;
  const n = history ? historyCount : count;
  const all = [...order, ...extra];
  return { keys: all.map(key), shown: all.filter((c) => n(c) > 0).map(key) };
}

/** Is any fold on the screen shut? Then the button opens them all. */
export const anyShut = ({ shown }, collapsed) => shown.some((k) => collapsed.has(k));

/** Shut every fold of the view, or open them all where any is shut. Only its own keys. */
export function toggleAll(scope, collapsed) {
  const open = anyShut(scope, collapsed);
  for (const k of scope.keys) { if (open) collapsed.delete(k); else collapsed.add(k); }
}

// ---- rows opened to their controls -------------------------------------------

const OPEN_ROWS = '.job.is-open, .lane-row.is-open, .hist-row.is-open';

/**
 * Open a row to its controls, or shut it. One row is open at a time: opening
 * one shuts any other, on the board, in History and in the lanes, and the one
 * opened stays where it was on the screen while the others shut around it.
 * @param {Element} row
 * @param {Set<string>} openRows  the open row's key (its data-prod), so a redraw puts it back
 */
export function toggleRow(row, openRows) {
  const open = !row.classList.contains('is-open');
  const top = row.getBoundingClientRect().top;
  if (open) {
    for (const other of document.querySelectorAll(OPEN_ROWS)) if (other !== row) showRow(other, false);
    openRows.clear();
  }
  showRow(row, open);
  if (row.dataset.prod) { if (open) openRows.add(row.dataset.prod); else openRows.delete(row.dataset.prod); }
  const moved = row.getBoundingClientRect().top - top;
  if (open && moved) window.scrollBy(0, moved);
}

function showRow(row, open) {
  row.classList.toggle('is-open', open);
  // The caret says what the row is doing, whichever of the two was clicked.
  const caret = row.querySelector('.more');
  if (caret) {
    caret.textContent = open ? '\u25be' : '\u25b8';
    caret.setAttribute('aria-expanded', String(open));
  }
}
