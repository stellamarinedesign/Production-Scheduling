// codes-side.js - the vessel codes page's sidebar since the redesign (UX
// stage two): its categories down the left, as the board's views are, and on
// a phone a strip of them over the codes; and a boat's card that opens to its
// buttons on a phone.
//
// THE SIDEBAR IS A WAY DOWN THE PAGE, not a filter: every category stays on
// screen, and a name takes you to it. The one marked is the one at the top of
// the page as it scrolls, so the mark never claims a place you have left.
//
// A BOAT ON A PHONE is a card of its facts; its buttons wait behind a tap on
// it (Pete, 27 Nov 2026), so a page of boats is not a page of buttons. A tap
// on a button, a chip or a link inside it is that control's, not the card's.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let spy = null;
let links = [];
let first = null;
let last = null;
// At either end of the page the mark is that end's category: the first starts
// below the toolbar, and the last can be too short to reach the top.
const atEnd = () => scrollY > 0 && innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
const ends = () => (scrollY <= 0 ? first : atEnd() ? last : null);
let endWatch = false;

/**
 * @param {{ id: string, name: string, n: number }[]} groups  the categories on
 *        screen, in order, each the id of its section
 */
export function renderCodesSide(groups) {
  const side = $('codesSide');
  const strip = $('codesStrip');
  if (!side || !strip) return;
  const was = side.querySelector('[aria-current="true"]')?.dataset.group;
  side.replaceChildren();
  strip.replaceChildren();
  links = [];
  first = groups[0]?.id ?? null;
  last = groups.at(-1)?.id ?? null;
  for (const g of groups) {
    for (const [host, cls] of [[side, 'side-item'], [strip, 'strip-item']]) {
      const a = el('a', cls);
      a.href = `#${g.id}`;
      a.dataset.group = g.id;
      a.title = g.name;
      a.append(el('span', 'nm', g.name), el('span', 'n', String(g.n)));
      a.addEventListener('click', (e) => {
        e.preventDefault();
        mark(g.id);
        $(g.id)?.scrollIntoView({ block: 'start' });
      });
      host.append(a);
      links.push(a);
    }
  }
  mark(groups.some((g) => g.id === was) ? was : groups[0]?.id);

  // The mark follows the page: the category whose heading has reached the top.
  spy?.disconnect();
  if (!('IntersectionObserver' in window) || !groups.length) return;
  spy = new IntersectionObserver((entries) => {
    if (ends()) { mark(ends()); return; }
    const top = entries.filter((e) => e.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (top) mark(top.target.id);
  }, { rootMargin: '0px 0px -75% 0px' });
  for (const g of groups) { const s = $(g.id); if (s) spy.observe(s); }
  if (!endWatch) {
    endWatch = true;
    addEventListener('scroll', () => { if (ends()) mark(ends()); }, { passive: true });
  }
}

function mark(id) {
  for (const a of links) {
    if (a.dataset.group === id) a.setAttribute('aria-current', 'true');
    else a.removeAttribute('aria-current');
  }
}

let wiredCards = false;

/** On a phone a boat's card opens to its buttons with a tap; elsewhere this does nothing visible. */
export function wireCodeCards(...hostIds) {
  if (wiredCards) return;
  wiredCards = true;
  for (const id of hostIds) {
    $(id)?.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, select, label, .cx-list')) return;
      const row = e.target.closest('.code-row');
      if (!row) return;
      const open = !row.classList.contains('is-open');
      // A button focused in a card holds that card open (style.css); a tap
      // elsewhere lets it go.
      if (document.activeElement?.closest?.('.code-row')) document.activeElement.blur();
      for (const r of document.querySelectorAll('.code-row.is-open')) r.classList.remove('is-open');
      row.classList.toggle('is-open', open);
    });
  }
}
