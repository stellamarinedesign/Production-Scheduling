// watchdog.js — the start-up watch that runs before any module.
//
// A CLASSIC SCRIPT, WRITTEN INLINE. tools/importmap.py copies this file into
// the <head> of the three pages, between the watchdog markers, so it runs
// before a single module has arrived and costs no request of its own. It is
// never imported. Edit it here and rerun the tool; a test fails when a page's
// copy differs from this file.
//
// WHAT IT WATCHES. The page's modules. A request that goes dead - weak
// signal, a hand-over from Wi-Fi to mobile data - leaves the browser waiting
// on it, and nothing in the page runs until it arrives: the "slow, then a
// refresh is instant" of a phone on the workshop floor. If the page's entry
// module has not started and no response has completed for LIMIT, the page
// reloads once, on fresh connections, with everything that did arrive already
// cached. From the moment the module starts, boot.js watches the steps after
// it with the same two tools: `say` and `reloadOnce`.
//
// WHAT IT SAYS. Only the approved words, in one line at the top of the page,
// and only while true: offline, or no answer after the retry.
(function () {
  var LIMIT = 10000;
  var GUARD = 'stella.boot.reloadedAt';     // one automatic reload per two minutes
  var WORDS = {
    offline: 'Offline – not yet loaded',
    offlineSaved: 'Offline – saved copy shown',
    failing: 'No response from the server – retrying'
  };
  var shown = null;
  var B = window.__boot = {
    started: false,     // the page's entry module is running
    done: false,        // start-up has finished
    saved: false,       // a copy saved on the device is on screen
    say: say,
    reloadOnce: reloadOnce,
    recent: recent
  };

  function line() {
    var n = document.getElementById('netStatus');
    if (n) return n;
    var main = document.querySelector('main');
    if (!main) return null;
    n = document.createElement('div');
    n.id = 'netStatus';
    n.className = 'net-status';
    n.setAttribute('role', 'status');
    n.hidden = true;
    main.insertBefore(n, main.firstChild);
    return n;
  }

  /** 'offline', 'failing', or null to take the line away; after start-up, boot.js's own words. */
  function say(kind, words) {
    shown = kind || null;
    var n = line();
    if (!n) {
      if (shown) document.addEventListener('DOMContentLoaded', function () { say(shown, words); }, { once: true });
      return;
    }
    var text = words ? words : shown === 'offline' ? (B.saved ? WORDS.offlineSaved : WORDS.offline)
      : shown === 'failing' ? WORDS.failing : '';
    n.textContent = text;
    n.hidden = !text;
  }

  /** Did this tab reload itself in the last two minutes? Then the retry has been spent. */
  function recent() {
    try { return Date.now() - (Number(sessionStorage.getItem(GUARD)) || 0) < 120000; } catch (e) { return true; }
  }

  /** Reload, unless this tab already did in the last two minutes. */
  function reloadOnce() {
    if (recent()) return false;
    try { sessionStorage.setItem(GUARD, String(Date.now())); } catch (e) { return false; }
    location.reload();
    return true;
  }

  /** When a response last completed, on the page's own clock. */
  function lastActivity() {
    var t = 0;
    var list = performance.getEntriesByType ? performance.getEntriesByType('resource') : [];
    for (var i = 0; i < list.length; i++) if (list[i].responseEnd > t) t = list[i].responseEnd;
    var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    if (nav && nav.responseEnd > t) t = nav.responseEnd;
    return t;
  }

  var timer = setInterval(function () {
    if (B.started) { clearInterval(timer); return; }
    if (navigator.onLine === false) { say('offline'); return; }
    if (performance.now() - lastActivity() < LIMIT) return;
    if (!reloadOnce()) say('failing');
  }, 2000);

  window.addEventListener('offline', function () { if (!B.done) say('offline'); });
  window.addEventListener('online', function (e) {
    // boot.js raises a synthetic one to restart Firestore's streams; only the
    // browser's own says the device is back.
    if (!e.isTrusted || B.done) return;
    if (shown === 'offline') say(null);
    if (!B.started) reloadOnce();
  });
  if (navigator.onLine === false) say('offline');
})();
