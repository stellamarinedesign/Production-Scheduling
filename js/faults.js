// faults.js - an edit that did not save, said where it was made.
//
// The board changes on screen at once and the write follows behind it, so a
// write that is refused has nothing left to say it: the dialog has closed and
// the row has moved on. The row goes back to what it was, and the reason
// stands on it with a Retry until it is dealt with. A passing message alone
// would be missed, and a missed one is an edit somebody believes they made.
//
// "Notify the admin." in the words is an email to the admin once its address
// has been read (admin-contact.js).

import { sayWithNotify } from './admin-contact.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const faults = new Map();     // key -> { words, retry }

export const faultOf = (key) => faults.get(key) ?? null;
export const setFault = (key, words, retry = null) => { faults.set(key, { words, retry }); };
export const clearFault = (key) => faults.delete(key);

/**
 * The line that says it, or null when there is nothing to say.
 * @param {string} key
 * @param {() => void} redraw  called once it has been dismissed
 */
export function faultLine(key, redraw) {
  const f = faults.get(key);
  if (!f) return null;
  const line = el('div', 'fault');
  line.setAttribute('role', 'alert');
  const words = el('span', 'fault-words');
  sayWithNotify(words, f.words);
  line.append(words);
  if (f.retry) {
    const retry = el('button', 'mini', 'Retry');
    retry.addEventListener('click', () => { faults.delete(key); f.retry(); });
    line.append(retry);
  }
  const dismiss = el('button', 'mini quiet', 'Dismiss');
  dismiss.addEventListener('click', () => { faults.delete(key); redraw?.(); });
  line.append(dismiss);
  return line;
}

/** What a job override has not done when its write fails. */
export function notDone(patch) {
  if ('completed' in patch) return patch.completed ? 'Not completed' : 'Not reopened';
  if ('status' in patch) return 'Status not saved';
  if ('hidden' in patch) return patch.hidden ? 'Not hidden' : 'Not shown';
  if ('labelOverride' in patch) return 'Label not saved';
  if ('hullOverride' in patch) return 'Hull not saved';
  if ('plinth' in patch) return 'Plinth not saved';
  return 'Not saved';
}

/** Does this record still carry a patch? Absent and null are the same thing here. */
export const carries = (record, patch) => Object.entries(patch).every(([k, v]) =>
  JSON.stringify(record?.[k] ?? null) === JSON.stringify(v ?? null));
