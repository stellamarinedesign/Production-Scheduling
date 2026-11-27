// auth.js — sign-in and roles.
//
// Same model as the Drawings app: Firebase email/password, no self-signup,
// one shared login per role. Self-registration must stay disabled in the
// console (Authentication → Settings → User actions → "Enable create
// (sign-up)" unticked).
//
// THIS LIST IS NOT SECURITY. It decides what gets drawn. The Firestore rules
// are the real enforcement — see the private SETUP document.
//
// IT IS ALSO NOT IN THIS FILE ANY MORE. It used to be two staff addresses in
// plain sight, and a static site hands its JavaScript to anyone who asks for
// it, signed in or not — so publishing the app published the addresses. They
// live in Firestore now, at `settings/access`, readable only by a signed-in
// user, and `setManagers` hands them here once loaded.
//
// Empty until then, and empty means nobody is a manager: an unknown account
// gets the floor view rather than the run of the board. That is the same
// fail-closed default as before, now covering the not-yet-loaded case too.
//
// SINCE THE BOARD JOINED THE HUB, a new sign-in goes through Hubinator, one
// login for every Stella app, which signs the board in to its own Firebase
// project as the hub's person (hub-bridge.js), and roles are given there.
// A device signed in before it met the hub carries on exactly as it was, with
// the board's own password dialog. The board's own sign-in form is not drawn
// on the live site any more: with nobody signed in and the hub out of reach,
// a card says so (hub-bridge.js, noUserAction; Pete, 27 Nov 2026). The form,
// still drawn off the live site, the dialog and account-making go in the
// clean-up release.
import { isTestMode, enterTestMode, notAvailable, NOT_AVAILABLE } from './test-mode.js';
import { failure, knowSignedIn } from './words.js';
import { askForHub, joinHub, showSwitcher, noUserAction } from './hub-bridge.js';

let managerEmails = [];
let engineerEmails = [];
let masterEmails = [];
let testerEmails = [];

export const tidyEmail = (e) => String(e ?? '').trim().toLowerCase();
export const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e ?? ''));
const tidy = (emails) => (emails ?? []).map(tidyEmail).filter(Boolean);

/**
 * @param {string[]} emails from Firestore `settings/access`.
 */
export function setManagers(emails) { managerEmails = tidy(emails); }

/**
 * ENGINEERS see the reference pages — vessel codes and parts — and never the
 * board. The board is the production schedule and its audience is the
 * production manager and the floor; drafting needs the codes and the parts
 * and has no business with what is due when. A separate list rather than a
 * flag on the manager one, so adding an engineer can never accidentally add
 * a manager.
 */
export function setEngineers(emails) { engineerEmails = tidy(emails); }

export const managerCount = () => managerEmails.length;

/**
 * MASTERS are not a role. A master is whatever role they are - a manager,
 * today - and additionally the only one who may change the accounts and
 * their roles. The list is set in the console and nowhere else, so nobody
 * can promote themselves to it.
 */
export function setMasters(emails) { masterEmails = tidy(emails); }
export const isMasterEmail = (email) => masterEmails.includes(tidyEmail(email));

/**
 * TESTERS get the manager view and are always in test mode: every change they
 * make stays in their browser, and the rules refuse their writes besides. The
 * list is read first, so an address on it is a tester whatever else it is on.
 */
export function setTesters(emails) { testerEmails = tidy(emails); }

/**
 * Anyone signed in who is not on that list gets the floor view: the board,
 * read-only, no manager chrome. Defaulting unknown-but-authenticated accounts
 * DOWN to floor rather than up to manager means a new account added in the
 * console can never accidentally arrive with edit rights.
 */
export const ROLE = { MANAGER: 'manager', ENGINEER: 'engineer', FLOOR: 'floor', TESTER: 'tester', NONE: 'none' };

export function roleFor(email) {
  if (!email) return ROLE.NONE;
  const e = email.trim().toLowerCase();
  if (testerEmails.includes(e)) return ROLE.TESTER;
  if (managerEmails.includes(e)) return ROLE.MANAGER;
  if (engineerEmails.includes(e)) return ROLE.ENGINEER;
  return ROLE.FLOOR;
}

export const Auth = {
  mode: 'local',        // 'firebase' | 'local'
  user: null,
  role: ROLE.NONE,
  unlisted: false,      // the server has said this account is on no list (sign-in.js)
  hub: null,            // the hub (hub-bridge.js), when it loaded
  hubState: null,       // what it answered: in | legacy | none | broken | unreachable
  hubDrawn: false,      // one of its own screens was up as it answered: its card

  /**
   * @param {(state: {role, email, mode}) => void} onChange
   * @param {object} [opts]
   * @param {() => Promise<void>} [opts.forget]  forget what this device holds:
   *        the page's, since this file does not import the store
   * @returns {Promise<'firebase'|'local'|'failed'>}
   */
  async init(onChange, { forget = async () => {} } = {}) {
    const { getFirebase, firebaseConfig, isConfigured } = await import('./firebase.js');
    // The hub's file is asked for now, beside the SDK, and waited for once
    // Firebase has said who is signed in here (joinHub). Local mode never
    // asks for it.
    const hub = isConfigured() ? askForHub() : null;
    // The app switcher beside the cog, as soon as that file is here.
    showSwitcher({ hub, slot: document.getElementById('hubSlot'), projectId: firebaseConfig.projectId });
    const fb = await getFirebase();

    // A CONFIGURED BOARD THAT CANNOT REACH FIREBASE IS NOT LOCAL MODE. That
    // used to fall through to the branch below, which made whoever was holding
    // the phone the manager of a board kept in its localStorage. It is a
    // start-up that failed: nothing is reported, the page stays as it is, and
    // the start-up watch (boot.js) retries it and says so.
    if (!fb && isConfigured()) return 'failed';

    if (!fb) {
      // LOCAL MODE. There is no auth to enforce and no second device to
      // protect against, so the single user on this machine is the manager.
      // The UI says so plainly rather than implying a login happened.
      this.mode = 'local';
      this.role = ROLE.MANAGER;
      this.user = null;
      onChange({ role: this.role, email: null, mode: 'local' });
      return 'local';
    }

    this.mode = 'firebase';
    this._fb = fb;
    // A refused write from nobody is said as that, not as an account without access.
    knowSignedIn(() => Boolean(fb.auth.currentUser));
    // The page starts again, for whoever the hub says it is now: nothing this
    // device holds is kept for them.
    let leaving = false;
    const again = async () => {
      if (leaving) return;
      leaving = true;
      try { await forget(); } catch (e) { console.warn('[hub]', e?.message ?? e); }
      location.reload();
    };
    // THE HUB, before the board's own listener: it may sign the board in, or
    // out, as the hub's person first, and its sign-in screen waits for one.
    // Fails open: with no hub this is as before.
    const joined = await joinHub({ fb, projectId: firebaseConfig.projectId, hub, reload: again });
    this.hub = joined?.Hub ?? null;
    this.hubState = joined?.state ?? null;
    this.hubDrawn = joined?.drawn ?? false;
    let seen = false;
    fb.fa.onAuthStateChanged(fb.auth, (user) => {
      // A SESSION THAT WENT WHILE THE PAGE WAS OPEN, with the hub in charge
      // of it: a login just linked or given a new key, or signed out in
      // another app. The reload asks the hub again. Here rather than in the
      // pages, because the parts and codes pages hear only the first answer.
      if (!user && noUserAction({ seen, hubState: this.hubState }) === 'reload') { again(); return; }
      if (user) seen = true;
      this.user = user;
      // The role remembered on the device holds for the account it was
      // remembered for, until the access list has been read and refreshRole
      // decides; read against lists not yet loaded it would be FLOOR.
      const kept = user && this._assumed && tidyEmail(user.email) === this._assumed.email;
      this._setRole(user ? (kept ? this._assumed.role : roleFor(user.email)) : ROLE.NONE);
      onChange({ role: this.role, email: user?.email ?? null, mode: 'firebase' });
    });
    return 'firebase';
  },

  /**
   * Take the account and role this device last saw, before Firebase has
   * restored the sign-in - a network round trip or two, and on a phone with
   * a dead connection the SDK waits a minute before giving up. The board is
   * drawn from the device for this account meanwhile; the sign-in and the
   * access list confirm it, and a different answer reloads the page.
   */
  assume(email, role) {
    this.mode = 'firebase';
    this._assumed = { email: tidyEmail(email), role };
    this.user = { email: this._assumed.email, assumed: true };
    this._setRole(role);
  },

  /**
   * Re-decide the role now the manager list has loaded.
   *
   * The list lives in Firestore, and Firebase reports the signed-in user before
   * the store is up — so the first decision is always made against an empty
   * list and is always FLOOR. This is the second, real one.
   *
   * Local mode never consults the list: there is no sign-in and no second
   * device, and the single user of a local board is the manager.
   */
  refreshRole() {
    if (this.mode === 'local') return this.role;
    this._assumed = null;
    return this._setRole(this.user ? roleFor(this.user.email) : ROLE.NONE);
  },

  /** Firebase, where there is any yet: the copy saved on the device can be up before it, or without it. */
  _firebase() {
    if (!this._fb) throw Object.assign(new Error('Firebase has not loaded'), { code: 'unavailable' });
    return this._fb;
  },

  /** The role, and with it the mode: a tester is in test mode from the moment the role is known. */
  _setRole(role) {
    this.role = role;
    if (role === ROLE.TESTER) enterTestMode({ forced: true });
    return role;
  },

  async signIn(email, password) {
    if (this.mode === 'local') throw new Error('Local mode — no sign-in required.');
    const { fa, auth } = this._firebase();
    await fa.signInWithEmailAndPassword(auth, email.trim(), password);
  },

  async signOut() {
    if (this.mode === 'local') return;
    const { fa, auth } = this._firebase();
    await fa.signOut(auth);
  },

  /** Signed in as the hub's person: Password and Sign out under the cog are the hub's. */
  get viaHub() { return this.mode === 'firebase' && this.hubState === 'in' && Boolean(this.hub); },

  /** The hub's full-screen card is up (no access here, a key it could not mend, or no connection): it is the answer. */
  get hubCard() { return this.mode === 'firebase' && this._noUser() === 'card'; },

  /** Nobody signed in on the live site, and the hub could draw nothing: the page draws its card (sign-in.js, hubDownCard). */
  get hubDown() { return this.mode === 'firebase' && this._noUser() === 'down'; },

  _noUser() { return noUserAction({ hubState: this.hubState, loaded: Boolean(this.hub), drawn: this.hubDrawn }); },

  /**
   * Sign out of the hub as well, when signed in through it - it leaves a mark,
   * so the other apps on this device sign themselves out when next opened -
   * then out of the board. A hub that does not answer keeps nobody signed in
   * here.
   */
  async signOutEverywhere() {
    if (this.viaHub) {
      try { await this.hub.signOut(); } catch (e) { console.warn('[hub] sign-out failed:', e?.message ?? e); }
    }
    await this.signOut();
  },

  /**
   * Send a set-your-own-password link.
   *
   * This is how somebody gets a password nobody else knows. An account still
   * has to be created in the Firebase console first — self-signup stays off,
   * because anyone who found the URL could otherwise create an account and,
   * although they would only get the floor role, that is enough to read the
   * whole production schedule.
   *
   * Firebase deliberately resolves this the same way whether or not the
   * address exists, so it cannot be used to discover who has an account. That
   * also means a typo looks exactly like success — hence the wording in the UI.
   *
   * UNUSED SINCE THE BOARD JOINED THE HUB: a completed reset changes the
   * password the hub's key relies on, so the links went. It goes in the
   * clean-up release.
   */
  async sendPasswordReset(email) {
    if (isTestMode()) throw notAvailable();
    if (this.mode === 'local') throw new Error('Local mode — there are no accounts.');
    const { fa, auth } = this._firebase();
    await fa.sendPasswordResetEmail(auth, email.trim());
  },

  /**
   * Change the signed-in account's password, here, with no email in the loop.
   *
   * Firebase will not change a password on a stale sign-in, so the current
   * password is proved first by signing in with it again; a wrong one fails
   * there, before anything changes. A forgotten password is the one thing this
   * cannot do - that is a console job, in the private SETUP notes.
   */
  async changePassword(current, next) {
    if (isTestMode()) throw notAvailable();
    if (this.mode === 'local') throw new Error('Local mode \u2014 there are no accounts.');
    const { fa, auth } = this._firebase();
    const user = auth.currentUser;
    if (!user?.email) throw new Error('Not signed in.');
    await fa.reauthenticateWithCredential(user, fa.EmailAuthProvider.credential(user.email, current));
    await fa.updatePassword(user, next);
  },

  /**
   * Make a Firebase user from the app, as a master. Done on a second auth
   * (see firebase.js) so the master stays signed in. Needs "Enable create
   * (sign-up)" ON in the console: with it off Firebase answers
   * auth/operation-not-allowed, and the rules make sign-up harmless anyway,
   * since a user nobody listed reads nothing.
   *
   * UNUSED SINCE THE BOARD JOINED THE HUB: people are added in Hubinator. It
   * goes in the clean-up release.
   */
  async createAccount(email, password) {
    if (isTestMode()) throw notAvailable();
    if (this.mode === 'local') throw new Error('Local mode \u2014 there are no accounts.');
    const { fa } = this._firebase();
    const { secondaryAuth } = await import('./firebase.js');
    const auth2 = await secondaryAuth();
    await fa.createUserWithEmailAndPassword(auth2, tidyEmail(email), password);
    // Made, whatever becomes of this: an error from here would be shown in
    // place of the password.
    try { await fa.signOut(auth2); } catch (e) { console.warn('[accounts]', e.message); }
  },

  /** The manager view: a manager, or a tester, whose board keeps nothing. */
  get isManager() { return this.role === ROLE.MANAGER || this.role === ROLE.TESTER; },
  /** May change the accounts and their roles. Not a role; see setMasters. Never a tester. */
  get isMaster() { return this.mode === 'firebase' && this.role !== ROLE.TESTER && Boolean(this.user?.email) && isMasterEmail(this.user.email); },
  /** The manager view, always in test mode. The few places that differ ask this. */
  get isTester() { return this.role === ROLE.TESTER; },
  get isEngineer() { return this.role === ROLE.ENGINEER; },
  get isFloor() { return this.role === ROLE.FLOOR; },
  /** The reference pages: vessel codes, parts. Managers, testers and engineers. */
  get isStaff() { return this.isManager || this.role === ROLE.ENGINEER; },
  /** Who may make a part correction. Same set: drafting is who notices them. */
  get canEditParts() { return this.isStaff; },
  /** Who may import a stock export. The person who can also fix the ERP. */
  get canImportParts() { return this.isManager; },
};

/** Was it the password, or the address it was given for? Firebase says the same for both. */
export const isWrongPassword = (e) => /invalid-credential|invalid-login-credentials|wrong-password|user-not-found/
  .test(String(e?.code ?? ''));

/**
 * Firebase's error codes are not sentences. Make them ones; a code with none of
 * its own is said as any other failure is (words.js), never in Firebase's words.
 * @param {string} [what]  what was not done: "Not signed in"
 */
export function friendlyAuthError(e, what = 'Not done') {
  const code = String(e?.code ?? '');
  if (code === 'test-mode') return NOT_AVAILABLE;
  if (isWrongPassword(e)) return 'Wrong email or password.';
  if (code.includes('weak-password') || code.includes('password-does-not-meet')) return 'A stronger password is needed.';
  if (code.includes('operation-not-allowed') || code.includes('admin-restricted')) return 'Making sign-ins from the app is switched off.';
  if (code.includes('email-already-in-use')) return 'That address already has a sign-in.';
  if (code.includes('requires-recent-login')) return 'Sign out, sign in again, and then change it.';
  if (code.includes('invalid-email')) return 'That does not look like an email address.';
  if (code.includes('too-many-requests')) return 'Too many attempts — wait a minute and try again.';
  if (code.includes('user-disabled')) return 'That account has been disabled.';
  return failure(what, e);
}
