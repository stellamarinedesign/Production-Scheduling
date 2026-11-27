// theme.js - the Workshop theme (UX stage two, G1): the family's light look,
// for bright offices and the workshop floor, beside the Stella dark that is
// the default.
//
// PER DEVICE. The choice is kept on this device, as design scheduling and
// material ordering keep theirs. A line in each page's <head> wears it before
// the first paint, so a Workshop device never flashes dark; this module only
// switches it, from the cog (settings.js).
//
// VALUES ONLY. A theme is the block of tokens in style.css keyed on
// <html data-theme="workshop">; nothing else changes. The hub's screens read
// the same attribute when they draw, so its sign-in and cards follow.
//
// THE WORDS are the family's: design scheduling's switch says the same.

export const THEME_KEY = 'stella.board.theme';

/** The themes, in the switch's order: the value kept, and the words on it. */
export const THEMES = [
  ['stella', 'Stella (dark)'],
  ['workshop', 'Workshop (light)'],
];

/** The theme the page is wearing now. */
export function themeNow() {
  return document.documentElement.dataset.theme === 'workshop' ? 'workshop' : 'stella';
}

/** Wear a theme, and keep it for this device. */
export function setTheme(value) {
  const root = document.documentElement;
  // Every colour changes at once, none fading on its own: the new values are
  // worked out with transitions off (style.css, .theme-switching), and they
  // come back on the next frame.
  root.classList.add('theme-switching');
  if (value === 'workshop') root.dataset.theme = 'workshop';
  else delete root.dataset.theme;
  void root.offsetWidth;
  requestAnimationFrame(() => root.classList.remove('theme-switching'));
  try { localStorage.setItem(THEME_KEY, value === 'workshop' ? 'workshop' : 'stella'); } catch { /* this visit only */ }
}
