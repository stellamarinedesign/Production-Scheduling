// toast.js - the passing message at the foot of the page, one for the app.
//
// There were five, and they undid each other. The parts page's only lifted
// `hidden`, which is not what the stylesheet shows a toast by, so nothing on
// that page was ever seen; Settings' and the password dialog's left `hidden`
// set behind them, so after one of those the board's own never showed again.
//
// A FAILURE IS NOT TALKED OVER. Information replaces information at once. A
// failure stays its whole time and whatever comes after it waits its turn; of
// the information that came meanwhile only the latest is kept. Red is for a
// failure and nothing else.

const SHOWN = 3200;
const SHOWN_FAILED = 8000;

let timer = null;
let showing = null;      // { msg, ms, bad }
let waiting = [];

/** The element: in the page already, or made; at the end of the body, where no dialog makes it inert. */
function node() {
  let n = document.getElementById('toast');
  if (!n) {
    n = document.createElement('div');
    n.id = 'toast';
  }
  if (n.parentElement !== document.body) document.body.append(n);
  n.setAttribute('role', 'status');
  return n;
}

function put(t) {
  showing = t;
  const n = node();
  n.hidden = false;
  n.textContent = t.msg;
  n.classList.toggle('bad', t.bad);
  n.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(next, t.ms);
}

function next() {
  showing = null;
  const t = waiting.shift();
  if (t) put(t);
  else document.getElementById('toast')?.classList.remove('show');
}

/** Say something in passing. Nothing that would cost anyone to miss: that goes beside its control. */
export function toast(msg, ms = SHOWN, { bad = false } = {}) {
  const t = { msg: String(msg), ms, bad };
  if (!showing?.bad) { put(t); return; }
  if (showing.msg === t.msg) return;
  if (!bad) waiting = waiting.filter((w) => w.bad);
  waiting.push(t);
}

/** Say that something failed. */
export const toastFailed = (msg, ms = SHOWN_FAILED) => toast(msg, ms, { bad: true });

/** For the test suite: as a fresh page has it. */
export function _resetToast() {
  clearTimeout(timer);
  showing = null;
  waiting = [];
  document.getElementById('toast')?.classList.remove('show', 'bad');
}
