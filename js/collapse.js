// collapse.js - what the Collapse all button acts on.
//
// Every fold on the page is one key in one saved set: a board category by its
// name, a History category as `hist:<lane>:<category>`, a Gantt band as
// `gantt:<category>`. The button belongs to whatever is in the board's place.
// With History open that is History's categories and nothing else; otherwise
// it is the board's. It never touches a fold that is not on the screen.

export const historyKey = (lane, cat) => `hist:${lane}:${cat}`;

/**
 * @param {object} view
 * @param {boolean} view.recent    the Activity log is in the board's place
 * @param {boolean} view.history   History is in the board's place
 * @param {string[]} view.order    the categories, in order
 * @param {(cat: string) => number} view.count         the board's jobs in a category
 * @param {(cat: string) => number} view.historyCount  History's
 * @returns {{keys: string[], shown: string[]}} every fold of the view, and those
 *          with something under them
 */
export function collapseScope({ recent, history, order, count, historyCount }) {
  if (recent) return { keys: [], shown: [] };
  const key = history ? (c) => historyKey('production', c) : (c) => c;
  const n = history ? historyCount : count;
  return { keys: order.map(key), shown: order.filter((c) => n(c) > 0).map(key) };
}

/** Is any fold on the screen shut? Then the button opens them all. */
export const anyShut = ({ shown }, collapsed) => shown.some((k) => collapsed.has(k));

/** Shut every fold of the view, or open them all where any is shut. Only its own keys. */
export function toggleAll(scope, collapsed) {
  const open = anyShut(scope, collapsed);
  for (const k of scope.keys) { if (open) collapsed.delete(k); else collapsed.add(k); }
}
