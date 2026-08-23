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
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

// APP CHECK — reCAPTCHA v3. Optional now that sign-in gates the data, but it
// keeps unauthenticated traffic away from the Auth endpoints. Register at
// Firebase Console → App Check → Apps → reCAPTCHA v3.
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
    const { initializeApp } = await import(`${SDK}/firebase-app.js`);
    const fs = await import(`${SDK}/firebase-firestore.js`);
    const fa = await import(`${SDK}/firebase-auth.js`);
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

    _fb = { app, db: fs.getFirestore(app), auth: fa.getAuth(app), fs, fa };
    return _fb;
  } catch (e) {
    _failed = e.message;
    console.warn('[firebase] unreachable —', e.message);
    return null;
  }
}

export const failureReason = () => _failed;
