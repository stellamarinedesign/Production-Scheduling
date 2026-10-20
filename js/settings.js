// settings.js - the cog, top right: who is signed in, their password, sign
// out, and for a manager the access lists.
//
// ACCOUNTS LIVE IN ONE PLACE. Who is a manager and who is an engineer is the
// `settings/access` document, and the Firestore rules read that same
// document (see the private SETUP notes), so putting an address on a list
// here is the whole of giving it a role. The one thing this cannot do is make
// the Firebase user itself - self-signup stays off, so that is a console job -
// and the one thing it will not do is let a manager remove themselves.

import { Auth, ROLE, setManagers, setEngineers, tidyEmail, isEmail } from './auth.js';
import { Store } from './store.js';
import { closeOnBackdrop } from './dialog.js';
import { openPasswordDialog } from './password.js';
import { activityEntry, ACTION } from './activity.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const ROLE_WORDS = {
  [ROLE.MANAGER]: 'Manager: the board, imports, the lists here.',
  [ROLE.ENGINEER]: 'Engineer: vessel codes and parts, with corrections.',
  [ROLE.FLOOR]: 'Floor: the current orders and the part list, read-only.',
  [ROLE.NONE]: 'Not signed in.',
};

let overlay = null;
let opts = {};
let lists = { managers: [], engineers: [] };

export function wireSettings(btn, options = {}) {
  if (!btn) return;
  opts = options;
  btn.addEventListener('click', open);
}

async function open() {
  if (!overlay) build();
  overlay.classList.add('show');
  renderAccount();
  const acct = overlay.querySelector('#stAccounts');
  acct.hidden = !(Auth.isManager && Auth.mode === 'firebase');
  if (!acct.hidden) {
    acct.querySelector('.settings-card').textContent = 'Loading…';
    lists = await Store.loadAccess();
    renderAccounts();
  }
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
  words.append(el('div', 'settings-row-label', local ? 'Local mode' : (Auth.user?.email ?? '')));
  words.append(el('div', 'settings-row-sub', local
    ? 'No accounts on this copy: everything is saved on this device only.'
    : ROLE_WORDS[Auth.role] ?? ''));
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

/** The two lists, each with its addresses and a way to add one. */
function renderAccounts() {
  const card = overlay.querySelector('#stAccounts .settings-card');
  card.textContent = '';
  card.append(el('div', 'settings-row-sub',
    'Who gets which view. The Firebase user itself is made in the console; a '
    + 'role is given here, and takes effect for them on their next page load. '
    + 'Anyone signed in and on neither list is floor.'));
  const me = tidyEmail(Auth.user?.email);
  for (const [key, label, word] of [['managers', 'Managers', 'manager'], ['engineers', 'Engineers', 'engineer']]) {
    const sec = el('div', 'acct-list');
    sec.append(el('div', 'acct-head', label));
    const emails = lists[key] ?? [];
    if (!emails.length) sec.append(el('div', 'acct-none', 'nobody yet'));
    for (const email of emails) {
      const r = el('div', 'acct-row');
      r.append(el('span', 'acct-email', email));
      const rm = el('button', 'mini', 'Remove');
      if (key === 'managers' && email === me) {
        rm.disabled = true;
        rm.title = 'You cannot remove yourself; another manager can.';
      } else {
        rm.addEventListener('click', () => save({ ...lists, [key]: emails.filter((e) => e !== email) },
          `${email} is no longer ${word === 'engineer' ? 'an' : 'a'} ${word}.`));
      }
      r.append(rm);
      sec.append(r);
    }
    const add = el('div', 'acct-add');
    const input = document.createElement('input');
    input.type = 'email';
    input.placeholder = 'name@stellamarine.com.au';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const go = el('button', 'mini', `Add as ${word}`);
    const submit = () => {
      const email = tidyEmail(input.value);
      const err = overlay.querySelector('#acctErr');
      err.textContent = '';
      if (!isEmail(email)) { err.textContent = 'That does not look like an email address.'; return; }
      const other = key === 'managers' ? 'engineers' : 'managers';
      if ((lists[key] ?? []).includes(email)) { err.textContent = `${email} is already ${word === 'engineer' ? 'an' : 'a'} ${word}.`; return; }
      if ((lists[other] ?? []).includes(email)) { err.textContent = `${email} is on the ${other} list; remove it there first.`; return; }
      save({ ...lists, [key]: [...(lists[key] ?? []), email] },
        `${email} is now ${word === 'engineer' ? 'an' : 'a'} ${word}. If the Firebase user does not exist yet, make it in the console.`);
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    add.append(input, go);
    sec.append(add);
    card.append(sec);
  }
  const err = el('div', 'form-err');
  err.id = 'acctErr';
  card.append(err);
}

async function save(next, note) {
  const err = overlay.querySelector('#acctErr');
  err.textContent = 'Saving…';
  try {
    await Store.saveAccess(next);
    Store.logActivity(activityEntry({ action: ACTION.access, text: note, by: Auth.user?.email }))
      .catch((e) => console.warn('[activity]', e.message));
    lists = next;
    setManagers(next.managers);
    setEngineers(next.engineers);
    renderAccounts();
    notify(note);
  } catch (e) {
    err.textContent = `Could not save — ${e.message}`;
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
