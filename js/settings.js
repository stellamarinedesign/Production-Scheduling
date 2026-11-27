// settings.js - the cog, top right: who is signed in, their password, sign
// out, and for a master the way to the accounts.
//
// ACCOUNTS LIVE IN ONE PLACE. Who has which role is the `settings/access`
// document, and the Firestore rules read that same document. SINCE THE BOARD
// JOINED THE HUB, Hubinator writes it: people and roles are given there, by a
// hub master who is also a board master, and for a master the Accounts section
// here is one line with the way there. Store.saveAccess rewrites all five lists
// at once, so a role editor left here would erase what the hub wrote with one
// stale press: there is none. Auth.createAccount, secondaryAuth,
// Store.saveAccess and the helpers in access.js stay, unused, until the
// clean-up release. The Activity log's account lines are kept as history; new
// ones are in Hubinator's account log.
//
// SIGNED IN THROUGH THE HUB (Auth.viaHub), Password and Sign out are the hub's:
// its password is the one for every Stella app, and its sign-out signs out of
// all of them on this device. A device the hub has left alone keeps the
// board's own. Test mode refuses a password change before the hub is asked,
// since the hub's dialog knows nothing of test mode.

import { Auth, ROLE } from './auth.js';
import { closeOnBackdrop } from './dialog.js';
import { openPasswordDialog } from './password.js';
import { isTestMode, openTestMode } from './test-mode.js';
import { toastFailed } from './toast.js';
import { busy } from './busy.js';
import { failure } from './words.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const ROLE_SENTENCE = {
  [ROLE.MANAGER]: 'Manager: the board, imports, corrections.',
  [ROLE.ENGINEER]: 'Engineer: vessel codes and parts, with corrections.',
  [ROLE.FLOOR]: 'Floor: the current orders and the part list, read-only.',
  [ROLE.NONE]: 'Not signed in.',
};

/** Hubinator's Accounts, on the site root the hub is served from. */
const HUB_ACCOUNTS = '/#/accounts';

let overlay = null;
let opts = {};

export function wireSettings(btn, options = {}) {
  if (!btn) return;
  opts = options;
  btn.addEventListener('click', open);
}

function open() {
  if (!overlay) build();
  overlay.classList.add('show');
  renderAccount();
  // The accounts section exists for a master and for nobody else: not
  // hidden, not greyed, simply absent.
  overlay.querySelector('#stAccounts').hidden = !(Auth.mode === 'firebase' && Auth.isMaster);
}

function close() {
  overlay?.classList.remove('show');
}

function build() {
  overlay = el('div', 'overlay');
  overlay.id = 'settingsOverlay';
  const box = el('div', 'box wide settings');
  box.append(el('h3', null, 'Settings'));

  const account = el('div', 'settings-section');
  account.append(el('div', 'settings-label', 'Account'));
  const card = el('div', 'settings-card');
  card.id = 'stAccount';
  account.append(card);
  box.append(account);

  const accounts = el('div', 'settings-section');
  accounts.id = 'stAccounts';
  accounts.hidden = true;
  accounts.append(el('div', 'settings-label', 'Accounts'));
  const link = Object.assign(el('a', 'textlink', 'Accounts'), { href: HUB_ACCOUNTS, target: '_blank', rel: 'noopener' });
  const line = el('div', 'settings-row-sub');
  line.append('Roles and new people are set in the hub, under ', link, '.');
  const where = el('div', 'settings-card');
  where.append(line);
  accounts.append(where);
  box.append(accounts);

  const acts = el('div', 'actions');
  const closeBtn = el('button', 'ghost', 'Close');
  closeBtn.addEventListener('click', close);
  acts.append(closeBtn);
  box.append(acts);

  overlay.append(box);
  document.body.append(overlay);
  closeOnBackdrop(overlay, close);
}

function renderAccount() {
  const card = overlay.querySelector('#stAccount');
  card.textContent = '';
  const row = el('div', 'settings-row');
  const words = el('div');
  const local = Auth.mode !== 'firebase';
  const name = el('div', 'settings-row-label', local ? 'Local mode' : (Auth.user?.email ?? ''));
  // ROLES ARE THE ADMIN'S BUSINESS. Nobody else reads that there are roles, or
  // which one is theirs (Pete, 26 Nov 2026): the chip and the role sentence are
  // for an admin, the account the code calls a master. A tester has no sentence.
  if (!local && Auth.isMaster) name.append(el('span', 'master-chip', 'ADMIN'));
  words.append(name);
  const sub = local
    ? 'No accounts on this copy: everything is saved on this device only.'
    : Auth.unlisted ? 'No current account assigned.' : Auth.isMaster ? ROLE_SENTENCE[Auth.role] ?? '' : '';
  if (sub) words.append(el('div', 'settings-row-sub', sub));
  row.append(words);
  card.append(row);
  if (local || !Auth.user) return;

  const acts = el('div', 'settings-acts');
  const err = el('div', 'form-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;
  // Not in test mode, where it could only say it is not available: a control
  // that cannot be used is not shown (Pete, 27 Nov 2026).
  const pw = el('button', 'mini', 'Change password');
  pw.hidden = isTestMode();
  pw.addEventListener('click', () => {
    close();
    if (!Auth.viaHub) { openPasswordDialog(); return; }
    // The hub's own dialog. It opens from the hub's file, which can fail to arrive.
    Auth.hub.openPassword().catch((e) => toastFailed(failure('Password not changed', e)));
  });
  const out = el('button', 'mini', 'Sign out');
  out.addEventListener('click', async () => {
    err.hidden = true;
    try { await busy(out, 'Signing out…', () => Auth.signOutEverywhere()); } catch (e) {
      err.textContent = failure('Not signed out', e);
      err.hidden = false;
      return;
    }
    close();
    opts.onSignOut?.();
  });
  acts.append(pw, out);
  // The way in: this page again with the flag, in this tab. A tester is in
  // already, and so is a page that carries the flag.
  if (!Auth.isTester && !isTestMode()) {
    const test = el('button', 'mini', 'Test mode');
    test.addEventListener('click', () => {
      close();
      openTestMode();
    });
    acts.append(test);
  }
  row.append(acts);
  card.append(err);
}
