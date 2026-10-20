// access.js - the accounts and their roles, as data.
//
// One document, settings/access, holds four lists of addresses: managers,
// engineers, floor, and masters. The first three are the roles, one address
// in at most one of them (an address in none is floor by default, the floor
// list only makes such an account visible in the Accounts panel). The
// Firestore rules read managers and engineers directly, so the lists must
// stay flat arrays. MASTERS is not a role: a master is whichever role they
// are, and additionally the only one who may change the lists. Masters are
// set in the console, not here, so nobody can promote themselves to it.

import { tidyEmail } from './auth.js';

export const ROLES = ['manager', 'engineer', 'floor'];
export const ROLE_LABEL = { manager: 'Manager', engineer: 'Engineer', floor: 'Floor' };
export const ROLE_WORDS = {
  manager: 'the board, imports and corrections',
  engineer: 'vessel codes and parts, with corrections; never the board',
  floor: 'current orders and the part list, read-only',
};

const LISTS = ['managers', 'engineers', 'floor', 'masters'];
const ROLE_LIST = { manager: 'managers', engineer: 'engineers', floor: 'floor' };

const tidyList = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map(tidyEmail).filter(Boolean))];

/** The document as the app holds it: four tidy, de-duplicated lists. */
export function normaliseAccess(d) {
  const out = {};
  for (const k of LISTS) out[k] = tidyList(d?.[k]);
  return out;
}

/** The role an address has: manager, engineer, or floor. */
export function roleOf(access, email) {
  const e = tidyEmail(email);
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
  const all = [...new Set([...a.managers, ...a.engineers, ...a.floor, ...a.masters])];
  const rank = { manager: 0, engineer: 1, floor: 2 };
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

/** The lists without this address on any role list. Masters untouched. */
export function withoutAccount(access, email) {
  const e = tidyEmail(email);
  const a = normaliseAccess(access);
  for (const r of ROLES) a[ROLE_LIST[r]] = a[ROLE_LIST[r]].filter((x) => x !== e);
  return a;
}
