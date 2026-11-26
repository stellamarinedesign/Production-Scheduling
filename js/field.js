// field.js - a value that is refused, said where the eyes are.
//
// The field turns red, gives one short shake, and the reason stands in words
// beneath it until something is typed. A passing message at the foot of the
// page is not where anyone looks when a Save did nothing.

const lines = new WeakMap();

/** The line the reason stands in: the field's own, or a new one after it. */
function lineFor(input) {
  let n = lines.get(input);
  if (n?.isConnected) return n;
  n = document.createElement('div');
  n.className = 'field-err';
  n.setAttribute('role', 'alert');
  // After the row the field shares with its button, not between the two.
  (input.closest('.inline') ?? input).after(n);
  lines.set(input, n);
  return n;
}

/**
 * Refuse what is in a field.
 * @param {HTMLElement} input
 * @param {string} words  why, in words
 * @param {{focus?: boolean}} [opts]
 */
export function refuse(input, words, { focus = true } = {}) {
  const line = lineFor(input);
  line.textContent = words;
  line.hidden = false;
  input.setAttribute('aria-invalid', 'true');
  input.classList.remove('is-refused');
  void input.offsetWidth;                  // so a second refusal shakes again
  input.classList.add('is-refused');
  if (focus) input.focus();
  input.addEventListener('input', () => accept(input), { once: true });
  input.addEventListener('change', () => accept(input), { once: true });
}

/** Take a refusal away. */
export function accept(input) {
  if (!input) return;
  input.removeAttribute('aria-invalid');
  input.classList.remove('is-refused');
  const line = lines.get(input);
  if (line) { line.textContent = ''; line.hidden = true; }
}
