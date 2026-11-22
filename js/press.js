// press.js — lets a touch screen show the pressed state.
//
// iOS Safari applies :active only once a touch listener is registered on the
// page; without one a tapped button gives no sign it was touched until its
// work is done. An empty, passive listener on the document is enough, and it
// never delays a scroll. Imported for this side effect by each page's entry.
document.addEventListener('touchstart', () => {}, { passive: true });
