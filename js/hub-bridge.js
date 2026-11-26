// hub-bridge.js - the hub (Hubinator), when it can be reached.
//
// Hubinator is one login for every Stella app. The board keeps its own
// Firebase project, rules, data and roles; joining adds one question at
// start-up: is the person signed in here the person signed in to the hub?
// The hub's shared file, /core/v1/hub.js, answers it, and signs the board in
// to its OWN project as that person, with a key the hub holds. The contract
// is the comment at the top of that file, in the Stella-Hubinator repo. It is
// never copied here: the board loads it from the site root.
//
// FAIL OPEN. That address only resolves on the live site. Anywhere else (a
// worktree on localhost, the tests page), or when the file is slow or broken,
// loadHub is null and the board signs in exactly as it did before the hub.
// Local mode never asks for it (auth.js).
//
// THE COPY SAVED ON THE DEVICE (boot.js) is drawn before Firebase or the hub
// has said who this is. With the hub a person can be signed out, or be
// somebody else, without the board having been open, so the hub's note on
// the device is read first: savedCopyAllowed.
//
// The decisions are small pure functions, so the tests reach them with a
// stand-in Hub and a stand-in Firebase auth. Nothing here imports the store,
// Firebase or a page.

export const HUB_URL = '/core/v1/hub.js';
/** The hub's note on this device. Its three states are in the contract comment. */
export const HUB_NOTE = 'stella.hub.session';
/** The board's name on the hub's own screens: "No access to Production board". */
export const HUB_TITLE = 'Production board';
const WAIT_MS = 4000;

const tidy = (e) => String(e ?? '').trim().toLowerCase();

/**
 * The hub's file, or null on any failure: not found, an error in it, or
 * slower than four seconds. Never rejects. `load` is the tests' seam, and
 * what askForHub hands over.
 * @returns {Promise<object|null>} the Hub
 */
export async function loadHub({ url = HUB_URL, wait = WAIT_MS, load = (u) => import(u) } = {}) {
  let timer = null;
  try {
    const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('timed out')), wait); });
    const mod = await Promise.race([load(url), late]);
    return mod?.Hub ?? null;
  } catch (e) {
    console.warn('[hub] not loaded:', e?.message ?? e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask for the hub's file now, beside the Firebase SDK, and use it later:
 * what comes back is loadHub's `load`. The four-second limit starts when it
 * is waited for, once Firebase has said who is signed in here, so a slow
 * first load has the whole of that to arrive in.
 */
export function askForHub(url = HUB_URL, load = (u) => import(u)) {
  const asked = Promise.resolve().then(() => load(url));
  asked.catch(() => {});       // loadHub says so when it is waited for
  return () => asked;
}

/**
 * The board's own session as Firebase first reports it. Once: the hub is not
 * asked anything until the board knows whether it is already signed in, and
 * a one-shot listener works on every SDK version.
 */
export function firstUser(fa, auth) {
  return new Promise((resolve) => {
    let done = false;
    const stop = fa.onAuthStateChanged(auth, (user) => {
      if (done) return;
      done = true;
      resolve(user);
      queueMicrotask(() => stop());
    });
  });
}

/**
 * What Hub.connect is asked. `session` is Firebase's own user, never
 * Auth.user: Auth.assume puts the person this device last saw there before
 * Firebase has answered. `signIn` takes a token as well as a password:
 * nothing sends one today, it is the seam a token service could use later
 * with no release here. `legacy` does nothing: with no user, the page's own
 * form is drawn as before.
 */
export function connectOptions({ fb, projectId, title = HUB_TITLE }) {
  return {
    project: projectId,
    title,
    session: () => fb.auth.currentUser?.email ?? null,
    signIn: ({ email, password, token } = {}) => (token
      ? fb.fa.signInWithCustomToken(fb.auth, token)
      : fb.fa.signInWithEmailAndPassword(fb.auth, email, password)),
    signOut: () => fb.fa.signOut(fb.auth),
    legacy: () => {},
  };
}

/** The hub's note as stored, or null where there is none or it cannot be read. */
export function hubNote() {
  try { return localStorage.getItem(HUB_NOTE); } catch { return null; }
}

/**
 * May the copy saved on this device for `email` be drawn before anything has
 * answered? Read from the note's text alone, as the hub reads it:
 *   no note, or unreadable   yes: this device has never used the hub
 *   signed out               no: the board is about to be signed out too
 *   somebody signed in       only if it is the same address, in any case
 */
export function savedCopyAllowed(raw, email) {
  let v = null;
  try { v = JSON.parse(raw ?? 'null'); } catch { v = null; }
  if (!v || typeof v !== 'object') return true;
  if (typeof v.out === 'string') return false;
  if (typeof v.uid === 'string' && v.uid && typeof v.email === 'string' && v.email) return tidy(v.email) === tidy(email);
  return true;
}

/**
 * Firebase reports no user: what the page does.
 *   reload  a user had been seen on this page and the hub had answered
 *           (anything but `legacy`): the session went while the page was
 *           open - a login just linked or given a new key, or signed out in
 *           another app. Forget the device and reload; the reload asks the
 *           hub again.
 *   card    the hub has drawn its full-screen card (no access here, or a key
 *           it could not mend). The page draws nothing behind it, and stops.
 *   own     the page's own way, as before the hub: its sign-in form, or what
 *           it does after a sign-out.
 */
export function noUserAction({ seen = false, hubState = null } = {}) {
  if (seen && hubState && hubState !== 'legacy') return 'reload';
  if (hubState === 'none' || hubState === 'broken') return 'card';
  return 'own';
}

/**
 * The hub's person changed in another tab (signed out, or somebody else):
 * reload when they are no longer the board's own signed-in address. A device
 * the hub left alone (`legacy`) is never troubled.
 */
export function shouldReload({ state, hubEmail, appEmail }) {
  if (state === 'legacy') return false;
  return tidy(hubEmail) !== tidy(appEmail);
}

/**
 * The app switcher, drawn into `slot` as soon as the hub's file is here (`hub`,
 * from askForHub). The hub draws it from its note alone - nothing for a login
 * with fewer than two apps, or inside a per-app iPad icon - so it need not
 * wait for the sign-in: a page drawn from the copy saved on the device has it
 * beside the cog from the start, instead of the header moving a moment later.
 * @returns {Promise<boolean>} whether the hub was asked to draw it
 */
export function showSwitcher({ hub = null, slot = null, projectId } = {}) {
  if (!hub || !slot) return Promise.resolve(false);
  return Promise.resolve().then(() => hub()).then((mod) => {
    if (!mod?.Hub) return false;
    mod.Hub.switcher(slot, { current: projectId });
    return true;
  }, () => false)                // no file: loadHub says so where it is waited for
    .catch((e) => { console.warn('[hub] switcher:', e?.message ?? e); return false; });
}

/**
 * The whole of the board's sign-in side, run once at start-up before its own
 * auth listener: wait for the first auth state, wait for the hub's file
 * (asked for earlier: `hub`, from askForHub), connect, and watch for the
 * hub's person changing.
 * @returns {Promise<{Hub: object, state: string}|null>} null with no hub
 */
export async function joinHub({ fb, projectId, hub = null, reload = () => location.reload() } = {}) {
  await firstUser(fb.fa, fb.auth);
  const Hub = await loadHub(hub ? { load: hub } : {});
  if (!Hub) return null;
  let state;
  try {
    const r = await Hub.connect(connectOptions({ fb, projectId }));
    state = r?.state ?? 'unreachable';
  } catch (e) {
    // A fault in the hub's own code is no reason to lock anyone out.
    console.warn('[hub] connect failed:', e?.message ?? e);
    return null;
  }
  try {
    Hub.onChange((me) => {
      if (shouldReload({ state, hubEmail: me?.email ?? null, appEmail: fb.auth.currentUser?.email ?? null })) reload();
    });
  } catch (e) { console.warn('[hub] onChange:', e?.message ?? e); }
  return { Hub, state };
}
