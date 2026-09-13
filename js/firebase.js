// firebase.js — one Firebase app, shared by the store and the auth gate.
//
// The config block below is a set of PUBLIC identifiers, not secrets. Every
// visitor's browser needs it to talk to Firebase, so it cannot be hidden.
// All protection comes from Auth plus the Firestore rules. Do not try to
// obscure it, and do not rotate the key if GitHub secret scanning flags the
// `AIzaSy…` string — a Firebase web key is public by design. See the private
// SETUP document for the key-restriction steps and how to close that alert.

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

// ---------------------------------------------------------------------------
// Paste from Firebase Console → Project settings → Your apps.
// Leaving this empty keeps the whole app in LOCAL MODE: no sign-in, edits in
// localStorage, one machine. That is a working configuration for a single
// production manager, and it is what runs until the project exists.
// ---------------------------------------------------------------------------
export const firebaseConfig = {
  apiKey: 'AIzaSyCzSwY2Pxet1bHZUPtEj93GzpytGhISwKg',
  authDomain: 'production-scheduling-stella.firebaseapp.com',
  projectId: 'production-scheduling-stella',
  storageBucket: 'production-scheduling-stella.firebasestorage.app',
  messagingSenderId: '397159853236',
  appId: '1:397159853236:web:23133f8085d3a17f2e3be1',
  measurementId: 'G-C5P6GWPVM5',
};

// APP CHECK — deliberately off. Sign-in plus the Firestore rules are the gate:
// every collection requires an authenticated user, and writes require a manager
// address. App Check would only add a bot-deterrent in front of the Auth
// endpoints. Paste a reCAPTCHA v3 SITE key here to turn it on; the secret key
// stays in the Firebase console and never leaves it.
export const APPCHECK_SITE_KEY = '';

export const isConfigured = () => Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let _fb = null;
let _failed = null;

/**
 * @returns {Promise<{app, db, auth, fs, fa}|null>} null when unconfigured or
 *          unreachable — callers fall back to local mode.
 */
export async function getFirebase() {
  if (_fb) return _fb;
  if (_failed) return null;
  if (!isConfigured()) { _failed = 'Firebase not configured'; return null; }

  try {
    // THREE FETCHES, NOT THREE ROUND TRIPS. These were awaited one after the
    // other, so a phone on a slow connection paid the latency three times over
    // before the first line of application code ran.
    const [{ initializeApp }, fs, fa] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-firestore.js`),
      import(`${SDK}/firebase-auth.js`),
    ]);
    const app = initializeApp(firebaseConfig);

    if (APPCHECK_SITE_KEY) {
      try {
        const ac = await import(`${SDK}/firebase-app-check.js`);
        ac.initializeAppCheck(app, {
          provider: new ac.ReCaptchaV3Provider(APPCHECK_SITE_KEY),
          isTokenAutoRefreshEnabled: true,
        });
      } catch (e) {
        console.warn('[AppCheck] activation failed — continuing without it:', e.message);
      }
    }

    // LONG-POLLING DETECTION, ON PURPOSE.
    //
    // Firestore's default transport is a streaming WebChannel. Plenty of mobile
    // carriers, captive portals and corporate proxies mangle or block it, and
    // the SDK's response is to wait for its own timeout before falling back to
    // long-polling. That wait is tens of seconds, during which every read is
    // simply pending — which is exactly the "blank screen for about a minute,
    // then everything appears at once" that the workshop sees on a phone.
    //
    // `experimentalAutoDetectLongPolling` makes the SDK probe up front and pick
    // the transport that works, rather than discovering the hard way. It costs
    // nothing on a network where the stream is fine.
    _fb = {
      app,
      db: fs.initializeFirestore(app, { experimentalAutoDetectLongPolling: true }),
      auth: fa.getAuth(app),
      fs,
      fa,
    };
    return _fb;
  } catch (e) {
    _failed = e.message;
    console.warn('[firebase] unreachable —', e.message);
    return null;
  }
}

export const failureReason = () => _failed;
