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
let managerEmails = [];
let engineerEmails = [];

const tidy = (emails) => (emails ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);

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
 * Anyone signed in who is not on that list gets the floor view: the board,
 * read-only, no manager chrome. Defaulting unknown-but-authenticated accounts
 * DOWN to floor rather than up to manager means a new account added in the
 * console can never accidentally arrive with edit rights.
 */
export const ROLE = { MANAGER: 'manager', ENGINEER: 'engineer', FLOOR: 'floor', NONE: 'none' };

export function roleFor(email) {
  if (!email) return ROLE.NONE;
  const e = email.trim().toLowerCase();
  if (managerEmails.includes(e)) return ROLE.MANAGER;
  if (engineerEmails.includes(e)) return ROLE.ENGINEER;
  return ROLE.FLOOR;
}

export const Auth = {
  mode: 'local',        // 'firebase' | 'local'
  user: null,
  role: ROLE.NONE,

  /**
   * @param {(state: {role, email, mode}) => void} onChange
   * @returns {Promise<'firebase'|'local'>}
   */
  async init(onChange) {
    const { getFirebase } = await import('./firebase.js');
    const fb = await getFirebase();

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
    fb.fa.onAuthStateChanged(fb.auth, (user) => {
      this.user = user;
      this.role = user ? roleFor(user.email) : ROLE.NONE;
      onChange({ role: this.role, email: user?.email ?? null, mode: 'firebase' });
    });
    return 'firebase';
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
    this.role = this.user ? roleFor(this.user.email) : ROLE.NONE;
    return this.role;
  },

  async signIn(email, password) {
    if (this.mode === 'local') throw new Error('Local mode — no sign-in required.');
    const { fa, auth } = this._fb;
    await fa.signInWithEmailAndPassword(auth, email.trim(), password);
  },

  async signOut() {
    if (this.mode === 'local') return;
    const { fa, auth } = this._fb;
    await fa.signOut(auth);
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
   */
  async sendPasswordReset(email) {
    if (this.mode === 'local') throw new Error('Local mode — there are no accounts.');
    const { fa, auth } = this._fb;
    await fa.sendPasswordResetEmail(auth, email.trim());
  },

  get isManager() { return this.role === ROLE.MANAGER; },
  get isEngineer() { return this.role === ROLE.ENGINEER; },
  get isFloor() { return this.role === ROLE.FLOOR; },
  /** The reference pages: vessel codes, parts. Managers and engineers. */
  get isStaff() { return this.role === ROLE.MANAGER || this.role === ROLE.ENGINEER; },
  /** Who may make a part correction. Same set: drafting is who notices them. */
  get canEditParts() { return this.isStaff; },
  /** Who may import a stock export. The person who can also fix the ERP. */
  get canImportParts() { return this.role === ROLE.MANAGER; },
};

/** Firebase's error codes are not sentences. Make them ones. */
export function friendlyAuthError(e) {
  const code = e?.code ?? '';
  if (code.includes('invalid-credential') || code.includes('wrong-password')
      || code.includes('user-not-found')) return 'Wrong email or password.';
  if (code.includes('invalid-email')) return 'That does not look like an email address.';
  if (code.includes('too-many-requests')) return 'Too many attempts — wait a minute and try again.';
  if (code.includes('network-request-failed')) return 'No connection to Firebase. Check the network.';
  if (code.includes('user-disabled')) return 'That account has been disabled.';
  return e?.message ?? 'Sign-in failed.';
}
