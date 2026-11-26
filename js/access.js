// access.js - the accounts and their roles, as data.
//
// One document, settings/access, holds five lists of addresses: managers,
// engineers, floor, testers, and masters. The first four are the roles, one
// address in at most one of them (an address in none reads nothing: the rules
// see to that; a tester has the manager view and is always in test mode). The
// Firestore rules read the lists directly, so they must stay flat arrays.
// MASTERS is not a role: a master is whichever role they are, and additionally
// the only one who may change the lists, never for their own account.
//
// What a page does with an answer about the lists is decided here as well,
// apart from the pages, because it decides who gets in: askAccess, standing.

import { tidyEmail } from './auth.js';

export const ROLES = ['manager', 'engineer', 'floor', 'tester'];
export const ROLE_LABEL = { manager: 'Manager', engineer: 'Engineer', floor: 'Floor', tester: 'Tester' };
export const ROLE_WORDS = {
  manager: 'the board, imports and corrections',
  engineer: 'vessel codes and parts, with corrections; never the board',
  floor: 'current orders and the part list, read-only',
  tester: 'the manager view, always in test mode',
};

const LISTS = ['managers', 'engineers', 'floor', 'testers', 'masters'];
const ROLE_LIST = { manager: 'managers', engineer: 'engineers', floor: 'floor', tester: 'testers' };

const tidyList = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map(tidyEmail).filter(Boolean))];

// NOTHING IS SAVED FROM LISTS THAT WERE NOT LOADED. The five are written
// together, so a save built on lists that failed to load would take everybody
// off, masters included. The lists the server gave carry a mark, the functions
// here hand it on to the lists they make from them, and Store.saveAccess
// writes nothing without it. A copy made in any other way does not carry it.
const LOADED = Symbol('from the server');
export const markLoaded = (lists) => Object.defineProperty(lists, LOADED, { value: true });
export const isLoaded = (lists) => lists?.[LOADED] === true;

/**
 * The document as the app holds it: five tidy, de-duplicated lists. With no
 * masters, the first manager listed is the master - the same default the
 * rules apply - so the document can be claimed and then handed on from the
 * app without anyone touching the console.
 */
export function normaliseAccess(d) {
  const out = {};
  for (const k of LISTS) out[k] = tidyList(d?.[k]);
  if (!out.masters.length && out.managers.length) out.masters = [out.managers[0]];
  return isLoaded(d) ? markLoaded(out) : out;
}

// ---- what a page does with the answer ----------------------------------------

/** Nobody is anything: what a page goes by when it was refused the lists, or is signed out. */
export const NO_ACCESS = Object.freeze({ ...normaliseAccess({}), refused: true });

/**
 * The lists, for a page that is starting, asked for until the server answers.
 *
 * A REFUSAL IS AN ANSWER. The rules give the lists to a listed account and to
 * nobody else, so an account refused them is on none, and waiting would not
 * change it. Any other failure says nothing about anybody: `failed` is told, so
 * the page can say so, and it is asked again. A failure never resolves to lists.
 *
 * @param {() => Promise<Object>} load  Store.loadAccess
 * @param {object} [opts]
 * @param {(e: Error) => void} [opts.failed]
 * @param {(tries: number) => Promise<void>} [opts.pause]  between one try and the next
 */
export async function askAccess(load, { failed = () => {}, pause = pauseAfter } = {}) {
  for (let tries = 1; ; tries += 1) {
    try { return await load(); } catch (e) {
      if (String(e?.code ?? '').includes('permission-denied')) return NO_ACCESS;
      failed(e);
      await pause(tries);
    }
  }
}

/** Two seconds, then four, eight, sixteen, and every half minute after that. */
const pauseAfter = (tries) => new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** tries)));

/**
 * Where an account stands, by what the server said of the lists:
 *
 *   'listed'    on a role list, so the page goes on
 *   'unlisted'  on none of them, or refused them, which is the same thing
 *   'missing'   there is no document: the one case in which it may be claimed
 *   'unknown'   nothing has been said. Not to be taken for any of the others
 */
export function standing(access, email) {
  if (!access) return 'unknown';
  if (access.refused) return 'unlisted';
  if (access.missing) return 'missing';
  const e = tidyEmail(email);
  return e && ROLES.some((r) => access[ROLE_LIST[r]]?.includes(e)) ? 'listed' : 'unlisted';
}

/** The role an address has: tester, manager, engineer, or floor. Testers first, as auth.js reads it. */
export function roleOf(access, email) {
  const e = tidyEmail(email);
  if (access?.testers?.includes(e)) return 'tester';
  if (access?.managers?.includes(e)) return 'manager';
  if (access?.engineers?.includes(e)) return 'engineer';
  return 'floor';
}

export const isMaster = (access, email) => Boolean(access?.masters?.includes(tidyEmail(email)));

/**
 * Every listed account as a row, masters first, then by role, then by
 * address. An address on no role list but on the masters list is still
 * shown, as floor.
 */
export function accountRows(access) {
  const a = normaliseAccess(access);
  const all = [...new Set([...a.managers, ...a.engineers, ...a.floor, ...a.testers, ...a.masters])];
  const rank = { manager: 0, engineer: 1, floor: 2, tester: 3 };
  return all
    .map((email) => ({ email, role: roleOf(a, email), master: a.masters.includes(email) }))
    .sort((x, y) => Number(y.master) - Number(x.master) || rank[x.role] - rank[y.role] || x.email.localeCompare(y.email));
}

/** The lists with this address in exactly the one role. Masters untouched. */
export function withRole(access, email, role) {
  if (!ROLES.includes(role)) throw new Error(`Not a role: ${role}`);
  const e = tidyEmail(email);
  const a = normaliseAccess(access);
  for (const r of ROLES) a[ROLE_LIST[r]] = a[ROLE_LIST[r]].filter((x) => x !== e);
  a[ROLE_LIST[role]] = [...a[ROLE_LIST[role]], e];
  return a;
}

/** The lists with this address on, or off, the masters list. */
export function withMaster(access, email, on) {
  const e = tidyEmail(email);
  const a = normaliseAccess(access);
  a.masters = on ? [...new Set([...a.masters, e])] : a.masters.filter((x) => x !== e);
  return a;
}

/**
 * A temporary password for an account just made: four words' worth of
 * letters and digits, readable aloud, no lookalikes. Changed by its owner
 * under the cog on first sign-in.
 */
export function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const pick = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alphabet[b % alphabet.length]).join('');
  return `${pick(4)}-${pick(4)}-${pick(4)}`;
}

/**
 * The lists without this address on any of them, the masters list included: a
 * master left on that one alone stayed in the panel as a row nobody could
 * take off, and could still change everybody else's role.
 */
export function withoutAccount(access, email) {
  const e = tidyEmail(email);
  const a = normaliseAccess(access);
  for (const k of LISTS) a[k] = a[k].filter((x) => x !== e);
  return a;
}

/**
 * What may be changed on an account's row, and why the rest may not be. Not
 * one's own, which is how nobody locks themselves out; and never the last
 * manager or the last master, which is how nobody locks everybody out.
 * @returns {{role: boolean, master: boolean, remove: boolean, why: string|null}}
 */
export function rowLimits(access, email, me) {
  const e = tidyEmail(email);
  const a = normaliseAccess(access);
  const only = (list) => list.length === 1 && list[0] === e;
  if (e === tidyEmail(me)) return { role: false, master: false, remove: false, why: 'Your own account: another master can change it.' };
  const manager = only(a.managers);
  const master = only(a.masters);
  return {
    role: !manager,
    master: !master,
    remove: !manager && !master,
    why: manager ? 'The only manager: another account has to be a manager first.'
      : master ? 'The only master: another account has to be a master first.' : null,
  };
}
