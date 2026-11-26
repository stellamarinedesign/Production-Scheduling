// history-order.js — the order History is read in.
//
// History groups completed work by category, newest completion first within
// each, which answers "what have we finished of these". It does not answer
// "what just happened": a job ticked by mistake five minutes ago sits inside
// its category, under whatever else that category holds. Latest first is one
// list across every category, the most recently changed job at the top, so
// the mistake is the first row and Reopen is beside it.
//
// A device preference, like the Gantt's toggles: it says nothing about the
// work, so it does not belong in Firestore.

import { lastChanged } from './activity.js';

const KEY = 'stella.board.historyLatest';

export const loadLatestFirst = () => {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
};

export const saveLatestFirst = (on) => {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* a preference, not a record */ }
};

/**
 * When a completed job last changed, as the Last changed column reads it:
 * the override's stamp, else the completion, else the log's newest line.
 * '' when nothing is known, which sorts last.
 */
export const changedAt = (job, override = null, rows = []) =>
  String(lastChanged({ override, job, rows })?.at ?? '');

/**
 * Newest change first. `overrides` is the job override map and `rows` the
 * activity entries loaded so far, both optional. Ties keep the completion
 * order, so a list that is already newest-completed-first stays stable.
 */
export const byLatestChange = (overrides = {}, rows = []) => (a, b) =>
  changedAt(b, overrides?.[b.prod_no], rows).localeCompare(changedAt(a, overrides?.[a.prod_no], rows))
  || String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? ''));
