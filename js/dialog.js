// dialog.js — the one thing every dialog in this app has in common.

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
 * @param {Element|null} overlay  the backdrop, which holds the dialog box
 * @param {() => void} close
 */
export function closeOnBackdrop(overlay, close) {
  if (!overlay) return;
  let pressedHere = false;
  overlay.addEventListener('pointerdown', (e) => { pressedHere = e.target === overlay; });
  overlay.addEventListener('click', (e) => {
    const genuine = e.target === overlay && pressedHere;
    pressedHere = false;
    if (genuine) close();
  });
}
