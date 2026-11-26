// password.js - change the signed-in account's password, in the app.
//
// No email in the loop. Firebase's reset mail comes from a sender nobody
// recognises, lands in junk, and takes its time; the account's own holder,
// signed in, needs none of that. They prove the current password and choose
// the next one here. A FORGOTTEN password is the one case this cannot cover,
// and that is a one-minute job in the Firebase console - see the private
// SETUP notes - after which this is how they make the temporary one theirs.
//
// A real form, with the account's address in it unseen: that is what a password
// manager files the new password under.

import { Auth, isWrongPassword, friendlyAuthError } from './auth.js';
import { closeOnBackdrop } from './dialog.js';
import { busy } from './busy.js';
import { refuse, accept } from './field.js';
import { isTestMode, isNotAvailable, NOT_AVAILABLE } from './test-mode.js';
import { toast, toastFailed } from './toast.js';

const MIN_LENGTH = 8;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let overlay = null;
const $ = (id) => overlay.querySelector(`#${id}`);
const FIELDS = ['pwCurrent', 'pwNew', 'pwAgain'];

/** The dialog, built the first time it is wanted. */
function build() {
  overlay = el('div', 'overlay');
  overlay.id = 'pwOverlay';
  const box = el('div', 'box');
  box.append(el('h3', null, 'Change password'));
  box.append(el('div', 'lede'));

  const form = el('form');
  form.id = 'pwForm';
  form.noValidate = true;                  // what is missing is said here, at the field
  const whose = Object.assign(el('input'), { id: 'pwUser', type: 'text', name: 'username', autocomplete: 'username', readOnly: true, hidden: true });
  form.append(whose);
  const field = (id, label, name, autocomplete, hint) => {
    const f = el('div', 'field');
    const l = el('label', null, label);
    l.htmlFor = id;
    const i = Object.assign(el('input'), { id, type: 'password', name, autocomplete, required: true });
    f.append(l, i);
    if (hint) f.append(el('div', 'hint', hint));
    return f;
  };
  form.append(field('pwCurrent', 'Current password', 'current-password', 'current-password'));
  form.append(field('pwNew', 'New password', 'new-password', 'new-password',
    `At least ${MIN_LENGTH} characters.`));
  form.append(field('pwAgain', 'New password, again', 'new-password-again', 'new-password'));
  const err = el('div', 'form-err');
  err.setAttribute('role', 'alert');
  form.append(err);
  const acts = el('div', 'actions');
  const save = Object.assign(el('button', 'primary', 'Change password'), { id: 'pwSave', type: 'submit' });
  const cancel = Object.assign(el('button', 'ghost', 'Cancel'), { id: 'pwCancel', type: 'button' });
  acts.append(save, cancel);
  form.append(acts);
  box.append(form);
  overlay.append(box);
  document.body.append(overlay);

  form.addEventListener('submit', submit);
  cancel.addEventListener('click', close);
  closeOnBackdrop(overlay, close);
}

/** Nothing typed, nothing said. */
function clear() {
  overlay.querySelector('.form-err').textContent = '';
  for (const id of FIELDS) { $(id).value = ''; accept($(id)); }
}

function open() {
  if (!overlay) build();
  const email = Auth.user?.email ?? '';
  overlay.querySelector('.lede').textContent = email ? `For ${email}.` : '';
  $('pwUser').value = email;
  clear();
  overlay.classList.add('show');
  $('pwCurrent').focus();
}

function close() {
  overlay?.classList.remove('show');
  clear();
}

let sending = false;
async function submit(e) {
  e.preventDefault();
  if (sending) return;
  const err = overlay.querySelector('.form-err');
  err.textContent = '';
  const [current, next, again] = FIELDS.map((id) => $(id).value);
  for (const id of FIELDS) accept($(id));
  if (!current) { refuse($('pwCurrent'), 'Type the current password first.'); return; }
  if (next.length < MIN_LENGTH) { refuse($('pwNew'), `The new password needs at least ${MIN_LENGTH} characters.`); return; }
  if (next !== again) { refuse($('pwAgain'), 'The two new passwords are not the same.'); return; }
  if (next === current) { refuse($('pwNew'), 'That is the current password.'); return; }
  sending = true;
  try {
    await busy($('pwSave'), 'Changing…', () => Auth.changePassword(current, next));
    close();
    toast('Password changed. Use the new one from now on.');
  } catch (x) {
    const words = friendlyAuthError(x, 'Password not changed');
    if (isNotAvailable(x)) { close(); toast(NOT_AVAILABLE); }
    else if (!overlay.classList.contains('show')) toastFailed(words);       // shut meanwhile
    else if (isWrongPassword(x)) { refuse($('pwCurrent'), 'The current password is wrong.'); $('pwCurrent').select(); }
    else err.textContent = words;
  } finally {
    sending = false;
  }
}

/** Open the dialog - from the Settings cog. Nothing to do in local mode, and refused in test mode before anything is typed. */
export function openPasswordDialog() {
  if (Auth.mode !== 'firebase') return;
  if (isTestMode()) { toast(NOT_AVAILABLE); return; }
  open();
}
