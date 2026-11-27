// board-shell.js - the board's frame since the redesign (UX stage two): the
// sidebar of views, the two records it carries, the same panel as a menu on a
// phone, and the one fold that moves.
//
// THE SIDEBAR IS THE OLD TAB STRIP. The buttons keep their ids (tabEditBtn and
// the rest), so app.js's showTab drives them exactly as it drove the tabs; this
// only gives each its words and its count, and keeps the view's name over the
// board on a phone, where the sidebar is out of sight.
//
// THE RECORDS. What is hidden from print and the rows the import left out used
// to be panels among the warnings. They are lists to look something up in, not
// something to deal with, so each is a view of its own under the sidebar, its
// count beside its name, and gone from the sidebar when there is nothing in it.
//
// THE FOLD THAT MOVES. A category is drawn again whole when it is opened, so
// nothing could animate it in place. The one whose heading was just pressed is
// found again after the redraw, by the data-focus key keepFocus uses, and its
// rows grow open (style.css, .fold-in). Every other redraw draws plainly.

const $ = (id) => document.getElementById(id);

/** A sidebar item's words, and its count when there is one. */
export function sideLabel(btn, words, n) {
  if (!btn) return;
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = words;
  const parts = [nm];
  if (n) {
    const c = document.createElement('span');
    c.className = 'n';
    c.textContent = String(n);
    parts.push(c);
  }
  // The print icon, where there is one, stays.
  const icon = btn.querySelector('svg');
  btn.replaceChildren(...(icon ? [icon] : []), ...parts);
  btn.title = words;
}

/**
 * Fill one record's view and its sidebar item. With nothing in it the item
 * goes, and if it was the view on screen the board comes back in its place.
 */
export function fillRecord(hostId, btnId, words, n, build) {
  const btn = $(btnId);
  sideLabel(btn, words, n);
  if (btn) btn.hidden = !n;
  const host = $(hostId);
  if (!host) return;
  host.replaceChildren();
  if (n) build(host);
  else if (btn?.getAttribute('aria-current') === 'page') $('tabEditBtn')?.click();
}

let wired = false;

/** Once: the phone's menu, the view's name, the fold that moves. */
export function wireBoardShell() {
  if (wired) return;
  wired = true;
  const side = $('bdSide');
  const menu = $('bdMenu');
  const scrim = $('bdScrim');
  if (!side || !menu) return;

  // The view's name over the board on a phone: whatever the sidebar marks.
  const name = () => {
    const cur = side.querySelector('.side-item[aria-current="page"]');
    $('viewTitle').textContent = cur?.querySelector('.nm')?.textContent ?? cur?.textContent ?? '';
  };
  new MutationObserver(name).observe(side, { attributes: true, subtree: true, attributeFilter: ['aria-current'] });
  name();

  const open = () => {
    side.classList.add('is-open');
    scrim.classList.add('is-open');
    menu.setAttribute('aria-expanded', 'true');
    // The panel is hidden until its slide has begun, and a hidden button takes
    // no focus: ask a moment later.
    setTimeout(() => (side.querySelector('.side-item[aria-current="page"]')
      ?? side.querySelector('.side-item:not([hidden])'))?.focus(), 40);
  };
  const close = ({ back = true } = {}) => {
    if (!side.classList.contains('is-open')) return;
    side.classList.remove('is-open');
    scrim.classList.remove('is-open');
    menu.setAttribute('aria-expanded', 'false');
    if (back) menu.focus();
  };
  menu.addEventListener('click', open);
  scrim.addEventListener('click', () => close());
  $('bdSideClose')?.addEventListener('click', () => close());
  // A view chosen from the menu closes it: the board is what was asked for.
  side.addEventListener('click', (e) => { if (e.target.closest('.side-item')) close({ back: false }); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // The fold that moves: only the category whose heading was just pressed.
  document.addEventListener('click', (e) => {
    const head = e.target.closest('.cat-head, .hist-cat-head');
    const key = head?.dataset.focus;
    if (!key || head.getAttribute('aria-expanded') === 'true') return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const again = document.querySelector(`[data-focus="${CSS.escape(key)}"]`);
      const block = again?.parentElement;
      if (!block || block.classList.contains('is-collapsed')) return;
      const body = again.nextElementSibling;
      if (!body) return;
      body.classList.add('fold-in');
      body.addEventListener('animationend', () => body.classList.remove('fold-in'), { once: true });
    }));
  }, true);
}
