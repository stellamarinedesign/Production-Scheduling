// settings.js - the cog, top right: who is signed in, their password, sign
// out, and for a master the accounts and their roles.
//
// ACCOUNTS LIVE IN ONE PLACE. Who has which role is the `settings/access`
// document, and the Firestore rules read that same document, so setting a
// role here is the whole of giving it - and since the rules let only a
// LISTED account read anything, an account nobody listed is no account at
// all. That is what lets the app make the Firebase user too: Add here makes
// the user with a temporary password shown once, and lists it, in one go.
// Only a MASTER sees any of this. A master is an ordinary account that is
// also on the masters list; masters hand that on from here, never to
// themselves, and with no list the first manager is the master.

import { Auth, ROLE, setManagers, setEngineers, setMasters, tidyEmail, isEmail, friendlyAuthError } from './auth.js';
import { Store } from './store.js';
import { closeOnBackdrop } from './dialog.js';
import { openPasswordDialog } from './password.js';
import { activityEntry, ACTION } from './activity.js';
import { ROLES, ROLE_LABEL, ROLE_WORDS, normaliseAccess, accountRows, withRole, withoutAccount, withMaster, roleOf, tempPassword } from './access.js';

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
let fresh = null;   // { email, password } of the user just made, shown once

export function wireSettings(btn, options = {}) {
  if (!btn) return;
  opts = options;
  btn.addEventListener('click', open);
}

async function open() {
  if (!overlay) build();
  overlay.classList.add('show');
  renderAccount();
  // The accounts section exists for a master and for nobody else: not
  // hidden, not greyed, simply absent.
  const sec = overlay.querySelector('#stAccounts');
  sec.hidden = !(Auth.mode === 'firebase' && Auth.isMaster);
  if (sec.hidden) return;
  sec.querySelector('.settings-card').textContent = 'Loading…';
  access = normaliseAccess(await Store.loadAccess());
  renderAccounts();
}

function close() {
  overlay?.classList.remove('show');
  fresh = null;
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

/** Every listed address with its role in a dropdown, a master tick, a Remove; and a row to add one. */
function renderAccounts() {
  const card = overlay.querySelector('#stAccounts .settings-card');
  card.textContent = '';
  const me = tidyEmail(Auth.user?.email);

  card.append(el('div', 'settings-row-sub',
    'Who gets which view, live for them on their next page load. '
    + 'Manager: ' + ROLE_WORDS.manager + '. Engineer: ' + ROLE_WORDS.engineer + '. '
    + 'Floor: ' + ROLE_WORDS.floor + '. An account on no list can sign in and see nothing. '
    + 'Master: may change this list; not a role.'));

  const table = el('div', 'acct-table');
  const head = el('div', 'acct-row acct-head-row');
  head.append(el('span', null, 'Account'), el('span', null, 'Role'), el('span', null, 'Master'), el('span', null, 'Firebase user'), el('span', null, ''));
  table.append(head);
  const rows = accountRows(access);
  if (!rows.length) table.append(el('div', 'acct-none', 'nobody listed yet'));
  for (const r of rows) {
    const row = el('div', 'acct-row');
    row.append(el('span', 'acct-email', r.email));
    const self = r.email === me;

    const sel = roleSelect(r.role);
    if (self) { sel.disabled = true; sel.title = 'Your own role; another master can change it.'; }
    else sel.addEventListener('change', () => save(withRole(access, r.email, sel.value), `${r.email} is now ${ROLE_LABEL[sel.value].toLowerCase()}.`));
    row.append(sel);

    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.className = 'acct-master';
    tick.checked = r.master;
    if (self) { tick.disabled = true; tick.title = 'Your own; another master can change it.'; }
    else {
      tick.title = r.master ? 'A master: may change this list. Untick to take that away.' : 'Tick to let this account change this list.';
      tick.addEventListener('change', () => save(withMaster(access, r.email, tick.checked),
        tick.checked ? `${r.email} is now a master.` : `${r.email} is no longer a master.`));
    }
    row.append(tick);

    // The Firebase user, separately from the listing: for an address listed
    // before sign-up was on, or by an older build, or whose temporary
    // password went unseen.
    const mk = el('button', 'mini', 'Make user');
    mk.title = 'Make the Firebase user for this address, temporary password shown once. If it already exists, says so and offers the ways round.';
    if (self) { mk.disabled = true; mk.title = 'Your own account exists: you are signed in with it.'; }
    else mk.addEventListener('click', () => makeUser(r.email, mk));
    row.append(mk);

    const rm = el('button', 'mini', 'Remove');
    if (self) { rm.disabled = true; rm.title = 'You cannot remove yourself; another master can.'; }
    else {
      rm.title = 'Off every list: signed in, this account then sees nothing. The Firebase user itself stays until it is deleted in the console.';
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
  go.title = 'Lists the address with this role, and makes the Firebase user for it with a temporary password shown once';
  const submit = () => addAccount(tidyEmail(input.value), sel.value, go).then((ok) => { if (ok) input.value = ''; });
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  add.append(input, sel, go);
  card.append(add);

  const err = el('div', 'form-err');
  err.id = 'acctErr';
  card.append(err);

  if (fresh) { const fb = freshBox(fresh); card.append(fb); fb.scrollIntoView({ block: 'nearest' }); }
}

/**
 * List an address with a role and make its Firebase user. The listing comes
 * first: the rules read the list, so a user that exists but is not listed
 * can sign in and read nothing, while a listed address whose user does not
 * exist yet is harmless. The user is made on a second Firebase app so the
 * master stays signed in; its temporary password is shown once, here, for
 * the master to pass on, and the person changes it under the cog.
 */
async function addAccount(email, role, btn) {
  const err = overlay.querySelector('#acctErr');
  err.textContent = '';
  if (!isEmail(email)) { err.textContent = 'That does not look like an email address.'; return false; }
  if (accountRows(access).some((r) => r.email === email)) {
    err.textContent = `${email} is already listed, as ${roleOf(access, email)}; change the role on its row.`;
    return false;
  }
  btn.disabled = true;
  try {
    if (!await save(withRole(access, email, role), `${email} added as ${ROLE_LABEL[role].toLowerCase()}.`)) return false;
    const password = tempPassword();
    try {
      await Auth.createAccount(email, password);
      fresh = { email, password };
      log(`${email}: Firebase user made.`);
      renderAccounts();
    } catch (e) {
      const code = e?.code ?? '';
      if (code.includes('email-already-in-use')) {
        fresh = { email, exists: true };
      } else {
        fresh = { email, failed: friendlyAuthError(e) };
      }
      renderAccounts();
    }
    return true;
  } finally {
    btn.disabled = false;
  }
}

/** The Firebase user for a listed address, from its row. */
async function makeUser(email, btn) {
  btn.disabled = true;
  const password = tempPassword();
  try {
    await Auth.createAccount(email, password);
    fresh = { email, password };
    log(`${email}: Firebase user made.`);
  } catch (e) {
    const code = e?.code ?? '';
    fresh = code.includes('email-already-in-use') ? { email, exists: true } : { email, failed: friendlyAuthError(e) };
  } finally {
    btn.disabled = false;
    renderAccounts();
  }
}

/**
 * What became of the Firebase user: made, with its temporary password shown
 * once and a Copy; already there, with the ways round a lost password; or
 * not made, with why and what to press.
 */
function freshBox({ email, password, exists, failed }) {
  const box = el('div', 'acct-fresh');
  if (exists) {
    box.append(el('div', 'acct-fresh-head', `${email} already has a Firebase user`));
    box.append(el('div', 'settings-row-sub',
      'Its password is unchanged. If that password is lost: delete the user in the Firebase console '
      + '(Authentication, Users) and press Make user here again for a fresh temporary one - or email a reset link, '
      + 'which can land in junk and take its time.'));
    const line = el('div', 'acct-fresh-line');
    const mail = el('button', 'mini', 'Email a reset link');
    mail.addEventListener('click', async () => {
      mail.disabled = true;
      try { await Auth.sendPasswordReset(email); mail.textContent = 'Sent, if the user exists'; }
      catch (e) { mail.textContent = friendlyAuthError(e); }
    });
    line.append(mail);
    box.append(line);
    return box;
  }
  if (failed) {
    box.append(el('div', 'acct-fresh-head', `${email} is listed, but its Firebase user was not made`));
    box.append(el('div', 'settings-row-sub', `${failed} Press Make user on its row to try again.`));
    return box;
  }
  box.append(el('div', 'acct-fresh-head', `Account made for ${email}`));
  const line = el('div', 'acct-fresh-line');
  line.append(el('span', null, 'Temporary password: '), el('code', null, password));
  const copy = el('button', 'mini', 'Copy');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(password); copy.textContent = '✓ Copied'; }
    catch { copy.textContent = 'Select and copy it'; }
  });
  line.append(copy);
  box.append(line);
  box.append(el('div', 'settings-row-sub',
    'Shown once - it goes when this closes. Pass it on; they sign in with it and press Password under the cog to make it theirs.'));
  return box;
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

/** Write the lists; say so; redraw. Returns whether it saved. */
async function save(next, note) {
  const err = overlay.querySelector('#acctErr');
  err.textContent = 'Saving…';
  try {
    await Store.saveAccess(next);
    log(note);
    access = next;
    setManagers(next.managers);
    setEngineers(next.engineers);
    setMasters(next.masters);
    renderAccounts();
    notify(note);
    return true;
  } catch (e) {
    err.textContent = `Could not save — ${e.message}`;
    return false;
  }
}

function log(text) {
  Store.logActivity(activityEntry({ action: ACTION.access, text, by: Auth.user?.email }))
    .catch((e) => console.warn('[activity]', e.message));
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
