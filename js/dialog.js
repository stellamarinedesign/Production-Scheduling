// dialog.js - what every dialog in this app has in common.
//
// A dialog is an `.overlay` holding a `.box`, and a page shows it by adding
// `show`. `watchDialogs` makes it one to the browser as well, whoever built it
// and however it was opened: the box is named as a dialog, the focus moves in
// when it opens and back to where it came from when it closes, the page behind
// takes neither Tab nor a press, and Escape closes the one on top.

const closers = new WeakMap();

/**
 * Close a dialog when its backdrop is CLICKED: pressed and released there.
 *
 * A drag that starts inside the dialog and ends outside it - highlighting the
 * text in a field and letting go past the edge of the box - is reported by
 * the browser as a click on the backdrop, because the backdrop is the nearest
 * element that contains both ends of the drag. Listening for the click alone
 * closed the dialog in the middle of an edit. So the press is remembered, and
 * a click only counts when it began on the backdrop as well.
 *
 * Escape closes it the same way (watchDialogs).
 *
 * @param {Element|null} overlay  the backdrop, which holds the dialog box
 * @param {() => void} close
 */
export function closeOnBackdrop(overlay, close) {
  if (!overlay) return;
  closers.set(overlay, close);
  let pressedHere = false;
  overlay.addEventListener('pointerdown', (e) => { pressedHere = e.target === overlay; });
  overlay.addEventListener('click', (e) => {
    const genuine = e.target === overlay && pressedHere;
    pressedHere = false;
    if (genuine) close();
  });
}

/** Escape alone, for a dialog a stray click outside must not close. */
export function closeOnEscape(overlay, close) {
  if (overlay) closers.set(overlay, close);
}

// ---- where the focus was, in terms that survive a redraw -----------------------

const CONTROL = 'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

/**
 * Every edit redraws the rows, so a control is remembered by its row and its
 * words; one outside a row by its `data-focus`, or its id.
 */
function placeOf(node) {
  if (!node || node === document.body || !node.isConnected) return null;
  if (node.dataset?.focus) return { focus: node.dataset.focus };
  const row = node.closest('[data-prod]');
  if (!row) return node.id ? { id: node.id } : null;
  return { prod: row.dataset.prod, i: [...row.querySelectorAll(CONTROL)].indexOf(node), text: node.textContent };
}

function atPlace(p) {
  if (!p) return null;
  if (p.id) return document.getElementById(p.id);
  if (p.focus) return document.querySelector(`[data-focus="${CSS.escape(p.focus)}"]`);
  for (const row of document.querySelectorAll(`[data-prod="${CSS.escape(p.prod)}"]`)) {
    if (!row.getClientRects().length) continue;
    const all = [...row.querySelectorAll(CONTROL)].filter((c) => c.getClientRects().length && !c.disabled);
    const same = all.find((c) => c.textContent === p.text) ?? all[p.i] ?? row.querySelector('.more');
    if (same) return same;
  }
  return null;
}

/** Run a redraw; the control that had the focus, or the one that replaced it, has it after. */
export function keepFocus(redraw) {
  const had = document.activeElement;
  const place = placeOf(had);
  redraw();
  if (place && !had.isConnected) atPlace(place)?.focus({ preventScroll: true });
}

// ---- the dialogs on screen -----------------------------------------------------

const open = [];           // { overlay, from, place, shut } - the one on top last
let lastControl = null;    // what was last pressed, for where the focus goes back to
let seq = 0;
let wired = false;

/** Everything but the dialog, and the way down to it, takes no focus and no press. */
function shutOut(overlay) {
  const shut = [];
  for (let n = overlay; n && n !== document.body; n = n.parentElement) {
    for (const s of n.parentElement?.children ?? []) {
      if (s === n || s.inert || s.id === 'toast' || /^(SCRIPT|STYLE|LINK|IFRAME)$/.test(s.tagName)) continue;
      // Hubinator's screens are drawn over the page by the hub, not the board.
      if (/shub/.test(String(s.className))) continue;
      s.inert = true;
      shut.push(s);
    }
  }
  return shut;
}

function opened(overlay) {
  const box = overlay.querySelector('.box') ?? overlay;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const title = box.querySelector('h1, h2, h3');
  if (title) {
    if (!title.id) title.id = `dialogTitle${++seq}`;
    box.setAttribute('aria-labelledby', title.id);
  }
  if (!box.hasAttribute('tabindex')) box.tabIndex = -1;
  const from = lastControl?.isConnected && !overlay.contains(lastControl) ? lastControl : null;
  open.push({ overlay, from, place: placeOf(from), shut: shutOut(overlay) });
  if (!overlay.contains(document.activeElement)) box.focus({ preventScroll: true });
}

const allClosed = new Set();

/** Called each time the last dialog on screen closes. */
export function whenClosed(cb) { allClosed.add(cb); }

function closed(i) {
  const [d] = open.splice(i, 1);
  for (const n of d.shut) n.inert = false;
  // Another dialog still up, or the focus already sent somewhere on purpose.
  const now = document.activeElement;
  if (now && now !== document.body && !d.overlay.contains(now)) return;
  const back = d.from?.isConnected && d.from.getClientRects().length ? d.from : atPlace(d.place);
  back?.focus({ preventScroll: true });
}

function sync() {
  for (let i = open.length - 1; i >= 0; i -= 1) {
    const o = open[i].overlay;
    if (!o.isConnected || !o.classList.contains('show')) closed(i);
  }
  const any = open.length > 0;
  for (const o of document.querySelectorAll('.overlay.show')) {
    if (!open.some((d) => d.overlay === o)) opened(o);
  }
  if (!any && !open.length) for (const cb of allClosed) cb();
}

/** Once per page: every dialog on it now, and every one added to the body later. */
export function watchDialogs() {
  if (wired) return;
  wired = true;
  const classes = new MutationObserver(sync);
  const seen = new WeakSet();
  const take = (o) => {
    if (seen.has(o)) return;
    seen.add(o);
    classes.observe(o, { attributes: true, attributeFilter: ['class'] });
  };
  for (const o of document.querySelectorAll('.overlay')) take(o);
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.classList?.contains('overlay')) take(n);
    sync();
  }).observe(document.body, { childList: true });

  document.addEventListener('click', (e) => {
    const c = e.target.closest?.(CONTROL);
    if (c) lastControl = c;
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const close = closers.get(open[open.length - 1]?.overlay);
    if (!close) return;
    e.preventDefault();
    close();
  });
}
