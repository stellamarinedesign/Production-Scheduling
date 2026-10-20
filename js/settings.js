// settings.js - the cog, top right: who is signed in, their password, sign
// out, and for a master the accounts and their roles.
//
// ACCOUNTS LIVE IN ONE PLACE. Who has which role is the `settings/access`
// document, and the Firestore rules read that same document (see the
// private SETUP notes), so setting a role here is the whole of giving it.
// Only a MASTER may do so - a master is an ordinary manager who is also on
// the masters list, which is set in the console and nowhere else, so nobody
// can promote themselves to it. The one thing this cannot do is make the
// Firebase user itself: self-signup stays off, so that is a console job.

import { Auth, ROLE, setManagers, setEngineers, setMasters, tidyEmail, isEmail } from './auth.js';
import { Store } from './store.js';
import { closeOnBackdrop } from './dialog.js';
import { openPasswordDialog } from './password.js';
import { activityEntry, ACTION } from './activity.js';
import { ROLES, ROLE_LABEL, ROLE_WORDS, normaliseAccess, accountRows, withRole, withoutAccount, roleOf } from './access.js';

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

let overlay = null;
let opts = {};
let access = normaliseAccess({});

export function wireSettings(btn, options = {}) {
  if (!btn) return;
  opts = options;
  btn.addEventListener('click', open);
}

async function open() {
  if (!overlay) build();
  overlay.classList.add('show');
  renderAccount();
  const sec = overlay.querySelector('#stAccounts');
  sec.hidden = Auth.mode !== 'firebase';
  if (sec.hidden) return;
  sec.querySelector('.settings-card').textContent = 'Loading…';
  access = normaliseAccess(await Store.loadAccess());
  renderAccounts();
}

function close() { overlay?.classList.remove('show'); }

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
  accounts.append(el('div', 'settings-card'));
  box.append(accounts);

  const acts = el('div', 'actions');
  const closeBtn = el('button', 'ghost', 'Close');
  closeBtn.addEventListener('click', close);
  acts.append(closeBtn);
  box.append(acts);

  overlay.append(box);
  document.body.append(overlay);
  closeOnBackdrop(overlay, close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('show')) close(); });
}

function renderAccount() {
  const card = overlay.querySelector('#stAccount');
  card.textContent = '';
  const row = el('div', 'settings-row');
  const words = el('div');
  const local = Auth.mode !== 'firebase';
  const name = el('div', 'settings-row-label', local ? 'Local mode' : (Auth.user?.email ?? ''));
  if (!local && Auth.isMaster) name.append(el('span', 'master-chip', 'MASTER'));
  words.append(name);
  words.append(el('div', 'settings-row-sub', local
    ? 'No accounts on this copy: everything is saved on this device only.'
    : ROLE_SENTENCE[Auth.role] ?? ''));
  row.append(words);
  if (!local) {
    const acts = el('div', 'settings-acts');
    const pw = el('button', 'mini', 'Password');
    pw.title = 'Change the password of this account, here, with no email';
    pw.addEventListener('click', () => { close(); openPasswordDialog(); });
    const out = el('button', 'mini', 'Sign out');
    out.addEventListener('click', async () => { close(); await Auth.signOut(); opts.onSignOut?.(); });
    acts.append(pw, out);
    row.append(acts);
  }
  card.append(row);
}

/**
 * The accounts: for a master, every listed address with its role in a
 * dropdown and a way to add or remove one; for anyone else, who the masters
 * are, so they know whom to ask.
 */
function renderAccounts() {
  const card = overlay.querySelector('#stAccounts .settings-card');
  card.textContent = '';
  const me = tidyEmail(Auth.user?.email);

  if (!Auth.isMaster) {
    const masters = access.masters.length ? access.masters.join(', ') : 'nobody yet - set in the Firebase console';
    card.append(el('div', 'settings-row-sub',
      `Accounts and roles are set by a master user: ${masters}. Ask them for a change.`));
    return;
  }

  card.append(el('div', 'settings-row-sub',
    'Who gets which view. The Firebase user itself is made in the console; the '
    + 'role is set here and takes effect for them on their next page load. '
    + 'Manager: ' + ROLE_WORDS.manager + '. Engineer: ' + ROLE_WORDS.engineer + '. '
    + 'Floor: ' + ROLE_WORDS.floor + ' - and what anyone signed in but unlisted gets.'));

  const table = el('div', 'acct-table');
  const head = el('div', 'acct-row acct-head-row');
  head.append(el('span', null, 'Account'), el('span', null, 'Role'), el('span', null, ''));
  table.append(head);
  const rows = accountRows(access);
  if (!rows.length) table.append(el('div', 'acct-none', 'nobody listed yet'));
  for (const r of rows) {
    const row = el('div', 'acct-row');
    const who = el('span', 'acct-email', r.email);
    if (r.master) who.append(el('span', 'master-chip', 'MASTER'));
    row.append(who);
    const sel = roleSelect(r.role);
    const self = r.email === me;
    if (self) {
      sel.disabled = true;
      sel.title = 'Your own role; another master can change it.';
    } else {
      sel.addEventListener('change', () => save(withRole(access, r.email, sel.value),
        `${r.email} is now ${ROLE_LABEL[sel.value].toLowerCase()}.`));
    }
    row.append(sel);
    const rm = el('button', 'mini', 'Remove');
    if (self) {
      rm.disabled = true;
      rm.title = 'You cannot remove yourself; another master can.';
    } else {
      rm.title = 'Off every list. The Firebase user stays until it is deleted in the console; signed in, it gets the floor view.';
      rm.addEventListener('click', () => save(withoutAccount(access, r.email), `${r.email} removed from the lists.`));
    }
    row.append(rm);
    table.append(row);
  }
  card.append(table);

  const add = el('div', 'acct-add');
  const input = document.createElement('input');
  input.type = 'email';
  input.placeholder = 'name@stellamarine.com.au';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const sel = roleSelect('floor');
  const go = el('button', 'mini', 'Add');
  const submit = () => {
    const email = tidyEmail(input.value);
    const err = overlay.querySelector('#acctErr');
    err.textContent = '';
    if (!isEmail(email)) { err.textContent = 'That does not look like an email address.'; return; }
    if (accountRows(access).some((r) => r.email === email)) {
      err.textContent = `${email} is already listed, as ${roleOf(access, email)}; change the role on its row.`;
      return;
    }
    save(withRole(access, email, sel.value),
      `${email} added as ${ROLE_LABEL[sel.value].toLowerCase()}. If the Firebase user does not exist yet, make it in the console.`);
    input.value = '';
  };
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  add.append(input, sel, go);
  card.append(add);

  const err = el('div', 'form-err');
  err.id = 'acctErr';
  card.append(err);
}

function roleSelect(current) {
  const sel = document.createElement('select');
  sel.className = 'acct-role';
  for (const r of ROLES) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = ROLE_LABEL[r];
    o.selected = r === current;
    sel.append(o);
  }
  return sel;
}

async function save(next, note) {
  const err = overlay.querySelector('#acctErr');
  err.textContent = 'Saving…';
  try {
    await Store.saveAccess(next);
    Store.logActivity(activityEntry({ action: ACTION.access, text: note, by: Auth.user?.email }))
      .catch((e) => console.warn('[activity]', e.message));
    access = next;
    setManagers(next.managers);
    setEngineers(next.engineers);
    setMasters(next.masters);
    renderAccounts();
    notify(note);
  } catch (e) {
    err.textContent = `Could not save — ${e.message}`;
    renderAccounts();
  }
}

/** The page's toast if it has one, else a plain alert. */
function notify(msg) {
  const t = document.getElementById('toast');
  if (!t) { window.alert(msg); return; }
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('show');
  setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, 4000);
}
