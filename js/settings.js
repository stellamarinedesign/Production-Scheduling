// settings.js - the cog, top right: who is signed in, their password, sign
// out, and for a master the accounts and their roles.
//
// ACCOUNTS LIVE IN ONE PLACE. Who has which role is the `settings/access`
// document, and the Firestore rules read that same document, so setting a
// role here is the whole of giving it - and since the rules let only a
// LISTED account read anything, an account nobody listed is no account at
// all. That is what lets the app make the Firebase user too: Add account
// makes the user with a temporary password shown once, and lists it, in one go.
// Only a MASTER sees any of this. A master is an ordinary account that is
// also on the masters list; masters hand that on from here, never to
// themselves, and with no list the first manager is the master.
//
// NO LISTS, NO CONTROLS. All five lists are saved together, so the panel is
// drawn from what the server has given or taken and from nothing else: until
// it has, there is a line and no more. One change at a time, every control off
// while it is saved, and one that is refused is put back with why on its row.

import { Auth, ROLE, setManagers, setEngineers, setMasters, setTesters, tidyEmail, isEmail, friendlyAuthError } from './auth.js';
import { Store } from './store.js';
import { closeOnBackdrop, keepFocus } from './dialog.js';
import { openPasswordDialog } from './password.js';
import { activityEntry, ACTION } from './activity.js';
import { ROLES, ROLE_LABEL, ROLE_WORDS, accountRows, withRole, withoutAccount, withMaster, roleOf, tempPassword,
         isLoaded, isMaster, rowLimits } from './access.js';
import { isTestMode, isNotAvailable, NOT_AVAILABLE, openTestMode } from './test-mode.js';
import { toast, toastFailed } from './toast.js';
import { busy } from './busy.js';
import { refuse } from './field.js';
import { choose } from './ask.js';
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

/** How long the server may take before the panel says it has not answered. */
const ANSWER_WITHIN = 6000;
const answerWithin = () => opts.answerWithin ?? ANSWER_WITHIN;

let overlay = null;
let opts = {};
let access = null;      // the lists, as the server gave them or last took them; null until it has
let asked = 0;          // the newest reading of them: an older one's answer is not used
let working = null;     // the change on its way: { email, words, late, next, add }
let said = null;        // why the last one was not made: { email, words, add }
let back = null;        // the control it was made on, which is off meanwhile and has lost the focus
let draft = { email: '', role: 'floor' };     // the Add row, kept through a redraw
let made = [];          // what became of each sign-in: { email, password | exists | failed, shown, copied }

export function wireSettings(btn, options = {}) {
  if (!btn) return;
  opts = options;
  btn.addEventListener('click', open);
}

const showing = () => Boolean(overlay?.classList.contains('show'));

function open() {
  if (!overlay) build();
  overlay.classList.add('show');
  renderAccount();
  // The accounts section exists for a master and for nobody else: not
  // hidden, not greyed, simply absent.
  const sec = overlay.querySelector('#stAccounts');
  sec.hidden = !(Auth.mode === 'firebase' && Auth.isMaster);
  if (sec.hidden) return;
  // With a change still on its way, its lists are newer than any reading.
  if (working) redraw();
  else loadAccounts();
}

function close() {
  overlay?.classList.remove('show');
  asked += 1;                                         // an answer still to come was for a panel now shut
  said = null;
  draft = { email: '', role: 'floor' };
  made = made.filter((m) => m.password && !m.shown);  // one that came after it was shut has not been seen
}

/** Whether the dialog may go: a temporary password is shown once, so one nobody has copied is asked about. */
async function mayLeave() {
  const left = made.filter((m) => m.password && m.shown && !m.copied);
  if (!left.length) return true;
  return choose({
    title: 'Temporary password not copied',
    facts: left.map((m) => ['Account', m.email]),
    yes: 'Discard password',
    no: 'Keep password',
    danger: true,
  });
}

/** Escape, or a click outside. Close is the button, and is meant. */
async function giveUp() {
  if (await mayLeave()) close();
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
  closeOnBackdrop(overlay, giveUp);
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
  // A tester has no sentence here; the role line is in the Accounts section.
  const sub = local
    ? 'No accounts on this copy: everything is saved on this device only.'
    : Auth.unlisted ? 'This account is not on the access list yet.' : ROLE_SENTENCE[Auth.role] ?? '';
  if (sub) words.append(el('div', 'settings-row-sub', sub));
  row.append(words);
  card.append(row);
  if (local || !Auth.user) return;

  const acts = el('div', 'settings-acts');
  const err = el('div', 'form-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;
  const pw = el('button', 'mini', 'Change password');
  pw.addEventListener('click', async () => {
    if (isTestMode()) { openPasswordDialog(); return; }        // says it is not available, and opens nothing
    if (!await mayLeave()) return;
    close();
    openPasswordDialog();
  });
  const out = el('button', 'mini', 'Sign out');
  out.addEventListener('click', async () => {
    if (!await mayLeave()) return;
    err.hidden = true;
    try { await busy(out, 'Signing out…', () => Auth.signOut()); } catch (e) {
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
    test.addEventListener('click', async () => {
      if (!await mayLeave()) return;
      close();
      openTestMode();
    });
    acts.append(test);
  }
  row.append(acts);
  card.append(err);
}

// ---- the accounts ---------------------------------------------------------------

const accountsCard = () => overlay.querySelector('#stAccounts .settings-card');

/** The one line there is while there are no lists, with a Retry once there is something to retry. */
function onlyLine(text, retry = null) {
  const card = accountsCard();
  card.textContent = '';
  const line = el('div', retry ? 'acct-line bad' : 'acct-line', text);
  line.setAttribute('role', retry ? 'alert' : 'status');
  card.append(line);
  if (!retry) return;
  const again = el('button', 'mini', 'Retry');
  again.addEventListener('click', () => { overlay.querySelector('.box').focus({ preventScroll: true }); retry(); });
  card.append(again);
}

/**
 * The lists, read afresh each time the panel opens. A read that failed, or that
 * has not answered in a few seconds, is said as that and leaves nothing to
 * press but Retry; an answer that comes late is still drawn.
 */
async function loadAccounts() {
  const mine = ++asked;
  access = null;
  said = null;
  onlyLine('Loading…');
  const notLoaded = (e) => { if (mine === asked && !access) onlyLine(failure('Accounts not loaded', e), loadAccounts); };
  const late = setTimeout(() => notLoaded({ code: 'unavailable', message: 'no answer' }),
    navigator.onLine === false ? 0 : answerWithin());
  try {
    const got = await Store.loadAccess();
    if (mine !== asked) return;
    if (!isLoaded(got)) throw new Error('there is no access document');
    // Taken off the masters since this page was loaded.
    if (!isMaster(got, Auth.user?.email)) { overlay.querySelector('#stAccounts').hidden = true; return; }
    access = got;
    redraw();
  } catch (e) {
    notLoaded(e);
  } finally {
    clearTimeout(late);
  }
}

/** Draw the panel again as things now stand, with the focus where it was. */
function redraw() {
  if (!access) return;
  keepFocus(drawAccounts);
  if (working || !back) return;
  const box = overlay.querySelector('.box');
  if (showing() && [document.body, box].includes(document.activeElement)) {
    (overlay.querySelector(`[data-focus="${CSS.escape(back)}"]:not(:disabled)`) ?? box).focus({ preventScroll: true });
  }
  back = null;
}

/** Every listed address with its role in a dropdown, a master tick, its sign-in and a Remove; and a row to add one. */
function drawAccounts() {
  const card = accountsCard();
  card.textContent = '';
  card.append(el('div', 'settings-row-sub',
    'Who gets which view, live for them on their next page load. '
    + 'Manager: ' + ROLE_WORDS.manager + '. Engineer: ' + ROLE_WORDS.engineer + '. '
    + 'Floor: ' + ROLE_WORDS.floor + '. Testers: ' + ROLE_WORDS.tester + '. An account on no list can sign in and see nothing. '
    + 'Master: may change this list; not a role.'));

  const table = el('div', 'acct-table');
  const head = el('div', 'acct-row acct-head-row');
  head.append(el('span', null, 'Account'), el('span', null, 'Role'), el('span', null, 'Master'), el('span', null, 'Sign-in'), el('span', null, ''));
  table.append(head);
  // As it will be while a change is saved; as it is again if it is not.
  for (const r of accountRows(working?.next ?? access)) table.append(accountRow(r));
  card.append(table, addRow());
  for (const m of made) {
    card.append(madeBox(m));
    if (showing()) m.shown = true;
  }
}

/** A line under a row: a change on its way, why one was not made, or why a control is off. */
function note(words, kind) {
  const n = el('div', kind === 'bad' ? 'acct-note bad' : 'acct-note', words);
  if (kind) n.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  return n;
}

function accountRow(r) {
  const limits = rowLimits(access, r.email, Auth.user?.email);
  const self = r.email === tidyEmail(Auth.user?.email);
  const row = el('div', 'acct-row');
  row.append(el('span', 'acct-email', r.email));
  const control = (n, label, may) => {
    n.disabled = Boolean(working) || !may;
    n.setAttribute('aria-label', label);
    n.dataset.focus = label;
    return n;
  };

  const sel = control(roleSelect(r.role), `Role of ${r.email}`, limits.role);
  sel.addEventListener('change', () => save(withRole(access, r.email, sel.value), {
    email: r.email, done: `${r.email} is now ${ROLE_LABEL[sel.value].toLowerCase()}.`, failed: 'Role not changed',
  }));
  row.append(sel);

  const tick = control(Object.assign(el('input', 'acct-master'), { type: 'checkbox', checked: r.master }), `Master: ${r.email}`, limits.master);
  tick.addEventListener('change', () => save(withMaster(access, r.email, tick.checked), {
    email: r.email, done: tick.checked ? `${r.email} is now a master.` : `${r.email} is no longer a master.`, failed: 'Master not changed',
  }));
  const cell = el('label', 'acct-master-cell');
  cell.append(tick, el('span', null, 'Master'));
  row.append(cell);

  // The Firebase user, separately from the listing: for an address listed
  // before sign-up was on, or by an older build, or whose temporary
  // password went unseen.
  const making = working?.making && working.email === r.email;
  const mk = control(el('button', 'mini acct-make', making ? 'Making…' : 'Make sign-in'), `Make sign-in for ${r.email}`, !self);
  mk.addEventListener('click', () => makeSignIn(r.email));
  row.append(mk);

  const rm = control(el('button', 'mini acct-remove', 'Remove'), `Remove ${r.email}`, limits.remove);
  rm.addEventListener('click', () => removeAccount(r));
  row.append(rm);

  if (working?.email === r.email && working.words) row.append(note(working.words, 'live'));
  if (said?.email === r.email && !said.add) row.append(note(said.words, 'bad'));
  if (limits.why) row.append(note(limits.why));
  return row;
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

function addRow() {
  const form = el('form', 'acct-add-form');
  form.noValidate = true;
  const line = el('div', 'acct-add inline');
  const input = Object.assign(el('input'), {
    type: 'email', value: draft.email, placeholder: 'name@example.com', autocomplete: 'off', spellcheck: false, disabled: Boolean(working),
  });
  input.setAttribute('aria-label', 'Email of the new account');
  input.dataset.focus = 'acct-add-email';
  input.addEventListener('input', () => { draft.email = input.value; });
  const sel = roleSelect(draft.role);
  sel.disabled = Boolean(working);
  sel.setAttribute('aria-label', 'Role of the new account');
  sel.dataset.focus = 'acct-add-role';
  sel.addEventListener('change', () => { draft.role = sel.value; });
  const go = Object.assign(el('button', 'mini', working?.add ? 'Adding…' : 'Add account'), { type: 'submit', disabled: Boolean(working) });
  go.dataset.focus = 'acct-add';
  line.append(input, sel, go);
  form.append(line);
  if (said?.add) form.append(note(said.words, 'bad'));
  form.addEventListener('submit', (e) => { e.preventDefault(); addAccount(input); });
  return form;
}

// ---- the changes ----------------------------------------------------------------

/**
 * One piece of work at a time, with every control off until it is over, so a
 * second change is never built on lists the first is about to replace.
 * @param {object} job   { email, words, late, ... }: whose row, and what it reads meanwhile
 */
async function work(job, run) {
  if (working) return false;
  back = document.activeElement?.dataset?.focus ?? null;
  working = job;
  said = null;
  redraw();
  const late = setTimeout(() => { job.words = job.late; redraw(); }, answerWithin());
  try {
    return await run();
  } finally {
    clearTimeout(late);
    working = null;
    redraw();
  }
}

/**
 * Write the lists, and say so. Not written, the panel goes back to the lists it
 * had, and why stands on the row the change was made on - or under Add, for an
 * address that is on none of them.
 * @returns {Promise<boolean>} whether it saved
 */
function save(next, { email, done, failed, add = false, removing = false }) {
  // A row being removed stays, saying so, until it has been.
  const job = {
    email, add, next: removing ? null : next, words: removing ? 'Removing…' : 'Saving…', late: 'No response from the server – retrying',
  };
  return work(job, async () => {
    try {
      // Offline the write would wait in this page, and be lost with it.
      if (navigator.onLine === false && !isTestMode()) throw Object.assign(new Error('offline'), { code: 'unavailable' });
      await Store.saveAccess(next);
    } catch (e) {
      said = { email, add, words: failure(failed, e) };
      if (!showing()) toastFailed(said.words);
      return false;
    }
    access = next;
    setManagers(next.managers);
    setEngineers(next.engineers);
    setMasters(next.masters);
    setTesters(next.testers);
    log(done);
    toast(done, 4000);
    return true;
  });
}

async function removeAccount(r) {
  const remove = await choose({
    title: 'Account removal',
    facts: [['Account', r.email], ['Role', r.master ? `${ROLE_LABEL[r.role]}, master` : ROLE_LABEL[r.role]]],
    yes: 'Remove account',
    no: 'Keep account',
    danger: true,
  });
  if (!remove || !access) return;
  await save(withoutAccount(access, r.email), { email: r.email, done: `${r.email} removed from the lists.`, failed: 'Account not removed', removing: true });
}

/**
 * List an address with a role and make its Firebase user. The listing comes
 * first: the rules read the list, so a user that exists but is not listed
 * can sign in and read nothing, while a listed address whose user does not
 * exist yet is harmless. The user is made on a second Firebase app so the
 * master stays signed in; its temporary password is shown once, here, for
 * the master to pass on, and the person changes it under the cog.
 */
async function addAccount(input) {
  if (working) return;
  const email = tidyEmail(draft.email);
  const { role } = draft;
  if (!isEmail(email)) { refuse(input, email ? 'That does not look like an email address.' : 'Type the email address.'); return; }
  if (accountRows(access).some((r) => r.email === email)) {
    refuse(input, `${email} is already listed, as ${roleOf(access, email)}; change the role on its row.`);
    return;
  }
  const added = await save(withRole(access, email, role), {
    email, done: `${email} added as ${ROLE_LABEL[role].toLowerCase()}.`, failed: 'Account not added', add: true,
  });
  if (!added) return;                                   // still typed there, with why under it
  draft = { email: '', role: 'floor' };
  await makeSignIn(email);
}

/** The Firebase user for a listed address: made as it is added, or from its row. */
async function makeSignIn(email) {
  const password = tempPassword();
  let outcome = { email, password };
  await work({ email, making: true, words: '', late: 'No response from the server yet.' }, async () => {
    try {
      await Auth.createAccount(email, password);
      log(`${email}: sign-in made.`);
    } catch (e) {
      if (isNotAvailable(e)) { outcome = null; toast(NOT_AVAILABLE); }
      else if (String(e?.code ?? '').includes('email-already-in-use')) outcome = { email, exists: true };
      else outcome = { email, failed: friendlyAuthError(e, 'Sign-in not made') };
    }
  });
  if (!outcome) return;
  // Another answer for the same address replaces the last, unless the last is a
  // password that is still to be copied.
  made = [...made.filter((m) => m.email !== email || (m.password && !m.copied)), outcome];
  if (!showing() && outcome.password) toast(`Sign-in made for ${email}.`);
  if (!showing() && outcome.failed) toastFailed(outcome.failed);
  redraw();
  accountsCard().lastElementChild?.scrollIntoView({ block: 'nearest' });
}

/**
 * What became of the Firebase user: made, with its temporary password shown
 * once and a Copy; already there, with the way round a lost password; or
 * not made, with why.
 */
function madeBox(m) {
  const { email } = m;
  const box = el('div', 'acct-fresh');
  box.setAttribute('role', 'status');
  const line = el('div', 'acct-fresh-line');
  if (m.exists) {
    box.append(el('div', 'acct-fresh-head', `${email} already has a sign-in`));
    box.append(el('div', 'settings-row-sub',
      'Its password is unchanged. If that password is lost, email a reset link, which can land in junk and take its time.'));
    const mail = el('button', 'mini', m.sent ? 'Reset link sent' : 'Email a reset link');
    mail.disabled = Boolean(m.sent);
    const err = el('div', 'form-err');
    err.setAttribute('role', 'alert');
    mail.addEventListener('click', async () => {
      err.textContent = '';
      try {
        await busy(mail, 'Sending…', () => Auth.sendPasswordReset(email));
        m.sent = true;
        mail.textContent = 'Reset link sent';
        mail.disabled = true;
      } catch (e) {
        if (isNotAvailable(e)) toast(NOT_AVAILABLE);
        else err.textContent = friendlyAuthError(e, 'Reset link not sent');
      }
    });
    line.append(mail);
    box.append(line, err);
    return box;
  }
  if (m.failed) {
    box.append(el('div', 'acct-fresh-head', `${email} is listed without a sign-in`));
    box.append(el('div', 'settings-row-sub', m.failed));
    const again = el('button', 'mini', 'Retry');
    again.disabled = Boolean(working);
    again.dataset.focus = `Retry ${email}`;
    again.addEventListener('click', () => makeSignIn(email));
    line.append(again);
    box.append(line);
    return box;
  }
  box.append(el('div', 'acct-fresh-head', `Sign-in made for ${email}`));
  const code = el('code', null, m.password);
  code.addEventListener('copy', () => { m.copied = true; });
  const copy = el('button', 'mini', m.copied ? '✓ Copied' : 'Copy password');
  copy.addEventListener('click', async () => {
    copy.style.minWidth = `${Math.ceil(copy.getBoundingClientRect().width)}px`;
    try {
      await navigator.clipboard.writeText(m.password);
      m.copied = true;
      copy.textContent = '✓ Copied';
    } catch {
      getSelection().selectAllChildren(code);
      copy.textContent = 'Select and copy it';
    }
  });
  line.append(el('span', null, 'Temporary password: '), code, copy);
  box.append(line);
  box.append(el('div', 'settings-row-sub',
    'Shown once - it goes when this closes. Pass it on; they sign in with it and press Change password under the cog to make it theirs.'));
  return box;
}

function log(text) {
  Store.logActivity(activityEntry({ action: ACTION.access, text, by: Auth.user?.email }))
    .catch((e) => console.warn('[activity]', e.message));
}
