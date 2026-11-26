// hub-card.js - the board's card on the Hubinator page: the next orders due.
//
// The hub page imports this file from the site and calls `card` as the person
// looking, with a Firestore LITE handle on this project (the recipe is in the
// Stella-Hubinator repo, "The overview card"). It returns data only; the hub
// draws it. It must import nothing that loads Firebase or the store: what it
// takes from the board is plain functions (floor-board.js, transform.js).
//
// ONE READ, THE FLOOR'S. `settings/floor` is what a floor screen shows, about
// 13 KB, kept by the managers' browsers after every edit, with hidden and
// completed jobs already out (floor-board.js). Only while there is none, as
// on the floor, is the newest import read instead: one document, up to a few
// hundred KB, cut down the same way. Every load of the hub page by every
// person reads it, against this project's daily quota.
//
// FOR THE PEOPLE WHO HAVE THE BOARD: managers, testers and the floor. An
// engineer's account has no board, so no card (null).
//
// NEXT DUE is by the board's own due date, soonest first. Stock builds have
// none (they print STOCK) and are not orders anybody is waiting on. One past
// its date is drawn late and counted: that is the number that needs attention.

import { floorBoard } from './floor-board.js';
import { toDateOnly, toISO, today } from './transform.js';

const BOARD = '/Production-Scheduling/';
const SHOWN = 3;                                     // what the hub draws
const FOR = ['manager', 'tester', 'floor'];

/** A job's due date as yyyy-mm-dd, from the floor's dd/mm/yyyy; null for stock. */
const dueOf = (j) => (j?.is_stock ? null : toISO(toDateOnly(j?.due_display)));

/**
 * The card, from a floor board ({ jobs }). Pure.
 * @param {{jobs?: Array}} board
 * @param {{y: number, m: number, d: number}} [asOf]  today, a calendar day
 */
export function cardFrom(board, asOf = today()) {
  const now = toISO(asOf);
  const due = (board?.jobs ?? [])
    .map((j) => ({ j, at: dueOf(j) }))
    .filter((x) => x.at)
    .sort((a, b) => a.at.localeCompare(b.at) || String(a.j.prod_no).localeCompare(String(b.j.prod_no)));
  return {
    title: 'Next orders due',
    count: due.filter((x) => x.at < now).length,
    href: BOARD,
    empty: 'No orders due.',
    items: due.slice(0, SHOWN).map(({ j, at }) => ({
      title: j.label || j.prod_no,
      sub: [j.prod_no, j.hull, j.on_hold ? 'On hold' : null].filter(Boolean).join(' · '),
      when: j.due_display,
      href: BOARD,
      late: at < now,
    })),
  };
}

/** Read by the hub page. Throws on failure: the hub says "not available" and carries on. */
export async function card({ db, fs, role }) {
  if (!FOR.includes(role)) return null;
  const floor = await fs.getDoc(fs.doc(db, 'settings', 'floor'));
  let board = floor.exists() ? floor.data() : null;
  if (!board?.jobs?.length) {
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'imports'), fs.orderBy('retrievedAt', 'desc'), fs.limit(1)));
    const rec = snap.docs[0]?.data() ?? null;
    board = rec ? floorBoard({ jobs: rec.jobs ?? [] }, rec) : null;
  }
  return cardFrom(board);
}
