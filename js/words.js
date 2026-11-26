// words.js - counts with the right plural, and why something failed in plain words.
//
// NO BACKEND TEXT ON SCREEN. A FirebaseError's message is written for whoever
// wrote the program, so what a person reads is made here: what was not done,
// why, and what to do about it. The error itself goes to the console.

import { isNotAvailable, NOT_AVAILABLE } from './test-mode.js';

/** `3 jobs`, `1 job`. The second form only where an s does not make it. */
export const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const WHY = {
  offline: { why: 'no connection', next: 'Retry when the connection returns.' },
  // Nothing about roles: a person never reads that roles exist (Pete, 26 Nov 2026).
  refused: { why: 'access for this account not set up', next: 'Notify the admin.' },
  // Signed out in another app, or the sign-in ran out: the rules refuse a
  // write from nobody as they refuse one from an account without access, and
  // the two are told apart here (Pete, 27 Nov 2026).
  signedOut: { why: 'no longer signed in', next: 'Reload the page to sign in.' },
  full: { why: 'the database has reached its daily limit', next: 'Retry tomorrow.' },
  other: { why: 'not accepted by the server', next: 'Retry; report it if it fails again.' },
};

let signedIn = () => true;
/** How to tell whether anybody is signed in: auth.js says, since this file cannot import it. */
export function knowSignedIn(fn) { signedIn = fn; }

/** Which of the few reasons a person can do anything about this error is. */
export function cause(e, online = navigator.onLine !== false) {
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? '');
  if (/unauthenticated/.test(code)) return 'signedOut';
  if (/permission-denied/.test(code) || /insufficient permissions/i.test(msg)) return signedIn() ? 'refused' : 'signedOut';
  if (/resource-exhausted/.test(code)) return 'full';
  if (!online || /unavailable|deadline-exceeded|network-request-failed|cancelled/.test(code)
      || /failed to fetch|load failed|networkerror/i.test(msg)) return 'offline';
  return 'other';
}

/** The plain reason alone: `no connection`. */
export const reason = (e) => (isNotAvailable(e) ? NOT_AVAILABLE.replace(/\.$/, '').toLowerCase() : WHY[cause(e)].why);

/** A whole message: `Hull not saved: no connection. Retry when the connection returns.` */
export function failure(what, e) {
  if (isNotAvailable(e)) return NOT_AVAILABLE;
  console.warn(`[${what}]`, e?.code ?? '', e?.message ?? e);
  const w = WHY[cause(e)];
  return `${what}: ${w.why}. ${w.next}`;
}
