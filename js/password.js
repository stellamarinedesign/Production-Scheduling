// password.js - change the signed-in account's password, in the app.
//
// No email in the loop. Firebase's reset mail comes from a sender nobody
// recognises, lands in junk, and takes its time; the account's own holder,
// signed in, needs none of that. They prove the current password and choose
// the next one here. A FORGOTTEN password is the one case this cannot cover,
// and that is a one-minute job in the Firebase console - see the private
// SETUP notes - after which this is how they make the temporary one theirs.

import { Auth, friendlyAuthError } from './auth.js';
import { closeOnBackdrop } from './dialog.js';

const MIN_LENGTH = 8;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let overlay = null;

/** The dialog, built the first time it is wanted. */
function build() {
  overlay = el('div', 'overlay');
  overlay.id = 'pwOverlay';
  const box = el('div', 'box');
  box.append(el('h3', null, 'Change password'));
  box.append(el('div', 'lede'));
  const field = (id, label, auto, hint) => {
    const f = el('div', 'field');
    const l = el('label', null, label);
    l.htmlFor = id;
    const i = document.createElement('input');
    i.type = 'password';
    i.id = id;
    i.autocomplete = auto;
    f.append(l, i);
    if (hint) f.append(el('div', 'hint', hint));
    return f;
  };
  box.append(field('pwCurrent', 'Current password', 'current-password'));
  box.append(field('pwNew', 'New password', 'new-password',
    `At least ${MIN_LENGTH} characters.`));
  box.append(field('pwAgain', 'New password, again', 'new-password'));
  box.append(el('div', 'form-err'));
  const acts = el('div', 'actions');
  const save = el('button', 'primary', 'Change password');
  save.id = 'pwSave';
  const cancel = el('button', 'ghost', 'Cancel');
  cancel.id = 'pwCancel';
  acts.append(save, cancel);
  box.append(acts);
  overlay.append(box);
  document.body.append(overlay);

  save.addEventListener('click', submit);
  cancel.addEventListener('click', close);
  closeOnBackdrop(overlay, close);
  for (const id of ['pwCurrent', 'pwNew', 'pwAgain']) {
    overlay.querySelector(`#${id}`).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('show')) close(); });
}

function open() {
  if (!overlay) build();
  const email = Auth.user?.email ?? '';
  overlay.querySelector('.lede').textContent = email ? `For ${email}.` : '';
  overlay.querySelector('.form-err').textContent = '';
  for (const id of ['pwCurrent', 'pwNew', 'pwAgain']) overlay.querySelector(`#${id}`).value = '';
  overlay.classList.add('show');
  overlay.querySelector('#pwCurrent').focus();
}

function close() {
  overlay?.classList.remove('show');
}

async function submit() {
  const err = overlay.querySelector('.form-err');
  const current = overlay.querySelector('#pwCurrent').value;
  const next = overlay.querySelector('#pwNew').value;
  const again = overlay.querySelector('#pwAgain').value;
  err.textContent = '';
  if (!current) { err.textContent = 'Type the current password first.'; return; }
  if (next.length < MIN_LENGTH) { err.textContent = `The new password needs at least ${MIN_LENGTH} characters.`; return; }
  if (next !== again) { err.textContent = 'The two new passwords are not the same.'; return; }
  if (next === current) { err.textContent = 'That is the current password.'; return; }
  const save = overlay.querySelector('#pwSave');
  save.disabled = true;
  try {
    await Auth.changePassword(current, next);
    close();
    notify('Password changed. Use the new one from now on.');
  } catch (e) {
    err.textContent = friendlyAuthError(e);
  } finally {
    save.disabled = false;
  }
}

/** The page's toast if it has one, else a plain alert. */
function notify(msg) {
  const t = document.getElementById('toast');
  if (!t) { window.alert(msg); return; }
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('show');
  setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, 3200);
}

/** Open the dialog - from the Settings cog. Nothing to do in local mode. */
export function openPasswordDialog() {
  if (Auth.mode !== 'firebase') return;
  open();
}
