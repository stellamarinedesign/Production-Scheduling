// auth.js — sign-in and roles.
//
// Same model as the Drawings app: Firebase email/password, no self-signup,
// one shared login per role. Self-registration must stay disabled in the
// console (Authentication → Settings → User actions → "Enable create
// (sign-up)" unticked).
//
// THE LISTS BELOW ARE NOT SECURITY. They decide what gets drawn. The Firestore
// rules are the real enforcement and carry the same addresses — keep the two in
// sync, and see the private SETUP document for the rules themselves.

/** Full manager view: upload, edit, hide, relabel, print. */
export const MANAGER_EMAILS = [
  'design@stellamarine.com.au',
  'production@stellamarine.com.au',
];

/**
 * Anyone else who is signed in gets the floor view: the board, read-only,
 * no manager chrome. `workshop@stellamarine.com.au` is the intended account.
 * Defaulting unknown-but-authenticated accounts DOWN to floor rather than up
 * to manager means a new account added in the console can never accidentally
 * arrive with edit rights.
 */
export const ROLE = { MANAGER: 'manager', FLOOR: 'floor', NONE: 'none' };

export function roleFor(email) {
  if (!email) return ROLE.NONE;
  return MANAGER_EMAILS.includes(email.trim().toLowerCase()) ? ROLE.MANAGER : ROLE.FLOOR;
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

  get isManager() { return this.role === ROLE.MANAGER; },
  get isFloor() { return this.role === ROLE.FLOOR; },
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
