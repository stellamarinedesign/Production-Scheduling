// busy.js - a button while its work is in progress.
//
// The label becomes the action in progress, the width stays where it was so
// nothing beside it moves, and the button is off, so a second press cannot do
// the work twice. Put back as it was when the work ends, however it ends.

const running = new WeakSet();

/**
 * @param {HTMLButtonElement} btn
 * @param {string} label              what the button reads meanwhile: "Saving…"
 * @param {(say: (label: string) => void) => Promise<any>} run
 *        the work; `say` changes the label as it goes ("Saving 3 of 8…")
 * @returns what `run` returns; undefined when the button was already busy
 */
export async function busy(btn, label, run) {
  if (!btn || running.has(btn)) return undefined;
  running.add(btn);
  const was = { text: btn.textContent, disabled: btn.disabled, width: btn.style.minWidth };
  btn.style.minWidth = `${Math.ceil(btn.getBoundingClientRect().width)}px`;
  btn.disabled = true;
  btn.textContent = label;
  btn.setAttribute('aria-busy', 'true');
  try {
    return await run((text) => { btn.textContent = text; });
  } finally {
    running.delete(btn);
    btn.textContent = was.text;
    btn.disabled = was.disabled;
    btn.style.minWidth = was.width;
    btn.removeAttribute('aria-busy');
  }
}
