// admin-contact.js - "Notify the admin" as an email to the admin.
//
// THE ADDRESS IS NOT IN THIS FILE. The repository is public, and an address
// written here is published (auth.js). It lives in Firestore at
// `contact/admin` ({ email }), readable by any signed-in account, listed or
// not: an account on no list is the one that needs it (Pete, 27 Nov 2026).
// It is written with the service-account key only, never from the app.
//
// READ WHEN WORDS NEED IT, not at start-up: one small read, once a page, and
// only on a page that has something to tell the admin. Until it answers, and
// without it (local mode, no document, a read that failed), the words stay
// plain, as they were.
//
// THE SAME SHAPE AS THE HUB'S: its "Notify the admin" mails its admin with
// the subject "Hub login: <address>"; the board's says "Production board:".

import { Store } from './store.js';
import { Auth, isEmail } from './auth.js';

/** The words that become the link. Where they are said: words.js and sign-in.js. */
export const NOTIFY = 'Notify the admin';

let asked = null;

/**
 * The admin's address, read once a page; null when there is none to be had.
 * Never rejects.
 * @param {() => Promise<{email?: string}|null>} [read]  the tests' seam
 */
export function adminAddress(read = () => Store.loadContact()) {
  asked ??= Promise.resolve().then(read).then(
    (c) => { const e = String(c?.email ?? '').trim(); return isEmail(e) ? e : null; },
    (e) => { console.warn('[contact]', e?.code ?? '', e?.message ?? e); return null; });
  return asked;
}

/** For the test suite: forget the address, or take this one as read. */
export function _resetAddress(email) { asked = email === undefined ? null : Promise.resolve(email); }

/** The email: to the admin, its subject naming the board and the account. */
export function notifyHref(to, who) {
  const subject = who ? `Production board: ${who}` : 'Production board';
  return `mailto:${to}?subject=${encodeURIComponent(subject)}`;
}

/**
 * Words into `host`, as text. Where they end "Notify the admin.", those three
 * words become the email once the address has been read, unless the words
 * have been replaced meanwhile. Nothing is read for words without them.
 * @param {HTMLElement} host
 * @param {string} words
 * @param {object} [opts]  `who` is the account the email names; `address` is the tests' seam
 * @returns {Promise<boolean>} whether the link was made
 */
export function sayWithNotify(host, words, { who = Auth.user?.email ?? null, address = adminAddress } = {}) {
  host.textContent = words;
  const at = words.lastIndexOf(`${NOTIFY}.`);
  if (at < 0) return Promise.resolve(false);
  return address().then((to) => {
    if (!to || host.textContent !== words) return false;
    const a = document.createElement('a');
    a.className = 'textlink';
    a.href = notifyHref(to, who);
    a.textContent = NOTIFY;
    host.textContent = '';
    host.append(words.slice(0, at), a, words.slice(at + NOTIFY.length));
    return true;
  });
}
