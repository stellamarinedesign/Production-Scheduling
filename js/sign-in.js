// sign-in.js - the way in: the sign-in form, the access lists as a page starts,
// and what an account that cannot go on is told.
//
// ONE FORM, for every page that shows it. The board has it in a view of its own
// and goes on in the same page; the parts and vessel codes pages used to send
// people to the board and back, and have it where they are. It is a real form,
// so a password manager fills it and hears when it is sent, Enter sends it once,
// and what is wrong is said at the field it is wrong in.
//
// THE FALLBACK, since the board joined the hub: a new sign-in goes through
// Hubinator's own screen, and this form shows only when the hub cannot be
// reached. It has no reset link any more: a reset changes the password the
// hub's key for the board relies on.

import { Auth, tidyEmail, isEmail, isWrongPassword, friendlyAuthError } from './auth.js';
import { NO_ACCESS, askAccess, standing, placeOf } from './access.js';
import { Store } from './store.js';
import { busy } from './busy.js';
import { refuse, accept } from './field.js';
import { failure } from './words.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---- the form -----------------------------------------------------------------

/** How long the server may take before the form says it has not answered: Firebase gives it up to a minute. */
const ANSWER_WITHIN = 8000;

const NOT_AN_EMAIL = 'That does not look like an email address.';

function field(id, label, input) {
  const f = el('div', 'field');
  const l = el('label', null, label);
  l.htmlFor = id;
  input.id = id;
  f.append(l, input);
  return f;
}

/**
 * The form, with the ids the board's sign-in has always had.
 *
 * @param {object} [opts]
 * @param {() => any} [opts.signedIn]  once the password has been taken; the
 *        button stays busy until what this returns is done
 * @param {number} [opts.answerWithin]  for the test suite
 * @returns {HTMLFormElement}
 */
export function signInForm({ signedIn, answerWithin = ANSWER_WITHIN } = {}) {
  const form = el('form', 'sign-in');
  form.id = 'loginForm';
  form.noValidate = true;                  // what is missing is said here, at the field

  const email = Object.assign(el('input'), { type: 'email', name: 'username', autocomplete: 'username', required: true, spellcheck: false });
  email.setAttribute('autocapitalize', 'off');
  const pass = Object.assign(el('input'), { type: 'password', name: 'password', autocomplete: 'current-password', required: true });

  const btn = Object.assign(el('button', 'primary', 'Sign in'), { id: 'loginBtn', type: 'submit' });
  const line = Object.assign(el('div'), { id: 'loginErr' });
  line.setAttribute('role', 'status');
  form.append(field('loginEmail', 'Email', email), field('loginPass', 'Password', pass), btn, line);

  /** The line under the form: a failure, or dimmed when it is only news. */
  const say = (words, { news = false } = {}) => {
    line.textContent = words;
    line.classList.toggle('is-news', news);
  };
  const clear = () => { say(''); accept(email); accept(pass); };

  let sending = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return;
    clear();
    const address = email.value.trim();
    if (!isEmail(address)) { refuse(email, address ? NOT_AN_EMAIL : 'Type the email address.'); return; }
    if (!pass.value) { refuse(pass, 'Type the password.'); return; }
    sending = true;
    const late = setTimeout(() => say('No response from the server yet.', { news: true }), answerWithin);
    try {
      await busy(btn, 'Signing in…', async () => {
        await Auth.signIn(address, pass.value);
        clearTimeout(late);
        say('');
        await signedIn?.();
      });
      pass.value = '';
    } catch (err) {
      const words = friendlyAuthError(err, 'Not signed in');
      say('');
      if (isWrongPassword(err)) { refuse(pass, words); pass.select(); }
      else if (words === NOT_AN_EMAIL) refuse(email, words);
      else say(words);
    } finally {
      clearTimeout(late);
      sending = false;
    }
  });

  return form;
}

/** The focus in the form as it opens, at a desk. On a touch screen it would raise the keyboard over it. */
export function focusSignIn() {
  if (!matchMedia('(pointer: coarse)').matches) document.getElementById('loginEmail')?.focus({ preventScroll: true });
}

// ---- the access lists, as a page starts -----------------------------------------

/**
 * The access lists, for a page that is starting. Until the server has answered
 * the page waits where it is: on what the device kept, held, or on nothing.
 *
 * @param {{fail: () => void}} watch  the page's start-up watch (boot.js)
 */
export async function readAccess(watch) {
  if (Auth.mode === 'firebase' && !Auth.user) return NO_ACCESS;        // signed out: there is nobody to ask about
  let said = false;
  const access = await askAccess(() => Store.loadAccess(), {
    failed: (e) => {
      console.error('[access]', e.message);
      said = true;
      watch.fail();
      // The watch is over once the sign-in form has been up; the line is not.
      window.__boot?.say?.('failing');
    },
  });
  if (said) window.__boot?.say?.(null);
  return access;
}

/**
 * A ROLE CHANGED UNDER AN OPEN PAGE. The page is drawn for the role the
 * account had when it loaded: shown what that role may do and nothing else,
 * so nobody is offered a control the rules will refuse. Hubinator changes the
 * lists at any time, so the page watches them, and starts again when this
 * account's place on them changes - its role, admin or not, listed or not -
 * once no dialog is open, so nothing being typed is lost. Taken off every
 * list, the lists can no longer be read at all: that refusal is the change.
 * @param {string} email
 * @param {object} access  the lists the page was drawn from
 * @param {object} [opts]  `again` starts the page again; `watch` and `open` are the tests' seams
 * @returns {() => void} stop watching
 */
export function watchRole(email, access, {
  again = () => location.reload(),
  watch = (cb, err) => Store.watchAccess(cb, err),
  open = () => Boolean(document.querySelector('.overlay.show, dialog[open]')),
  wait = 2000,
} = {}) {
  const was = placeOf(access, email);
  let going = false;
  const go = () => {
    if (open()) { setTimeout(go, wait); return; }
    again();
  };
  const changed = () => { if (going) return; going = true; go(); };
  return watch((now) => {
    if (now && placeOf(now, email) !== was) changed();
  }, (e) => {
    if (/permission-denied/.test(String(e?.code ?? '')) && standing(access, email) === 'listed') changed();
  });
}

/** For an account on no list: it can read nothing, and that is what it is told. */
export function notListed(host, email) {
  Auth.unlisted = true;
  host.textContent = '';
  // Nothing about roles or lists: only the admin knows they exist (Pete, 26 Nov 2026).
  host.append(el('strong', null, 'No current account assigned'));
  host.append(el('div', null, `Signed in as ${email}. Notify the admin.`));
  host.hidden = false;
}

/**
 * First run: there are no lists, so whoever is setting the board up may claim it.
 *
 * The lists decide what is DRAWN. The Firestore rules decide what is ALLOWED,
 * and let the document be made only while there is none, so this is not
 * self-service access: where there is one, the write is refused.
 *
 * Offered only when the server has said the document is MISSING. One that exists
 * and is empty is somebody's deliberate decision and is left alone, and a read
 * that failed has said nothing.
 *
 * @param {(lists: Object) => any} claimed  with the lists as they are now
 */
export function offerManager(host, email, claimed) {
  host.textContent = '';
  host.append(el('strong', null, 'No manager list yet'));
  host.append(el('div', null,
    'Nobody has been given the manager view, so every signed-in account sees '
    + 'the read-only board. Whoever is setting this up can claim it here.'));
  const act = el('div', 'boot-actions');
  const btn = Object.assign(el('button', 'primary', `Make ${email} a manager`), { type: 'button' });
  const err = el('div', 'form-err');
  err.setAttribute('role', 'alert');
  act.append(btn, err);
  host.append(act);
  host.hidden = false;

  btn.addEventListener('click', async () => {
    err.textContent = '';
    let lists;
    try {
      await busy(btn, 'Saving…', async () => {
        await Store.saveManagers([tidyEmail(email)]);
        lists = await Store.loadAccess();
        if (standing(lists, email) !== 'listed') throw new Error('saved, and came back without this account');
      });
    } catch (e) {
      err.textContent = failure('Manager not added', e);
      return;
    }
    host.hidden = true;
    await claimed(lists);
  });
}
