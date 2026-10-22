// undo.js — Ctrl+Z and Ctrl+Y for the board's edits.
//
// Every manager edit on the board is a small record keyed on a production
// number or an item code, written through a handful of choke points. Each of
// those knows what it is about to overwrite, so each edit can be reversed by
// writing the previous values back, and reversed again. That is the whole
// mechanism: a list of steps, each with a way back and a way forward, kept in
// memory for this page and this person. Nothing reads the list to decide
// anything, and a reversal goes through the same choke point as the edit it
// reverses, so the activity log records it as what it is.
//
// Not covered, deliberately: an import (hundreds of records, and the review
// before Apply is its check), the vessel code map (a shared table, not an
// edit to a job), and another manager's edits, which were never in this list.

const LIMIT = 50;

export const Undo = {
  past: [],
  future: [],
  /** True while a step runs, so the edit it makes is not recorded as a new step. */
  applying: false,

  /**
   * Remember an edit just made.
   * @param {{label: string, undo: () => Promise, redo: () => Promise}} step
   *   `label` is what the toast says; `undo` puts the previous values back and
   *   `redo` makes the edit again, each through the ordinary edit path.
   */
  record(step) {
    if (this.applying || typeof step?.undo !== 'function' || typeof step?.redo !== 'function') return;
    this.past.push(step);
    if (this.past.length > LIMIT) this.past.shift();
    // A new edit after an undo is a fork: what was undone is no longer ahead.
    this.future.length = 0;
  },

  canUndo() { return this.past.length > 0; },
  canRedo() { return this.future.length > 0; },

  /** Reverse the newest step. Resolves to it, or null when there is none. */
  async undo() { return this._move(this.past, this.future, 'undo'); },
  /** Make the last undone step again. Resolves to it, or null when there is none. */
  async redo() { return this._move(this.future, this.past, 'redo'); },

  async _move(from, to, way) {
    const step = from.pop();
    if (!step) return null;
    this.applying = true;
    try {
      await step[way]();
    } catch (e) {
      from.push(step);          // it did not happen, so it is still where it was
      throw e;
    } finally {
      this.applying = false;
    }
    to.push(step);
    return step;
  },

  clear() { this.past.length = 0; this.future.length = 0; },
};

/**
 * The patch that puts back what `patch` is about to change: for each key the
 * previous value, or null where there was none, which every choke point
 * treats as "remove". `hidden` is the one boolean: absent, it was false, and
 * the hide path keys its tidy-up on exactly that value.
 */
export function inverseOf(before, patch) {
  const out = {};
  for (const k of Object.keys(patch ?? {})) {
    const v = before?.[k];
    out[k] = v === undefined ? (k === 'hidden' ? false : null) : v;
  }
  return out;
}

/** Is the key press in a place where Ctrl+Z is the browser's own undo? */
export function isTyping(target) {
  const tag = String(target?.tagName ?? '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable === true;
}

/**
 * What a keydown asks for: 'undo' for Ctrl+Z or Cmd+Z, 'redo' for Ctrl+Y,
 * Ctrl+Shift+Z or Cmd+Shift+Z, null for anything else.
 */
export function undoKey(e) {
  if (!e || !(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = String(e.key ?? '').toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y' && !e.shiftKey) return 'redo';
  return null;
}

/**
 * Bind the keys for the page. `blocked()` says when the board is not what is
 * being edited (a dialog open, no manager signed in); `say` is the toast.
 */
export function bindUndoKeys({ blocked = () => false, say = () => {} } = {}) {
  document.addEventListener('keydown', async (e) => {
    const way = undoKey(e);
    if (!way || isTyping(e.target) || blocked()) return;
    e.preventDefault();
    if (Undo.applying) return;
    try {
      const step = way === 'undo' ? await Undo.undo() : await Undo.redo();
      if (!step) { say(way === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.'); return; }
      say(`${way === 'undo' ? 'Undone' : 'Redone'}: ${step.label}`);
    } catch (err) {
      say(`Could not ${way} — ${err.message}`, 6000);
    }
  });
}
