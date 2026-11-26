// code-edits.js - what an edit on the vessel codes page changes, as data.
//
// No page and no store in here: the fields a rename, a split or a loaded file
// writes, which boats a display code would put on one line, and the edits made
// here that the store has not answered yet. codes-page.js draws all of it and
// hands over the function that saves.

import { aliasGroups, LEGACY_MODELS_KEY } from './vessel-codes.js';
import { toISO } from './transform.js';
import { failure } from './words.js';

// ---- edits over what the store holds -------------------------------------------

/** A map with some records' fields changed, as the store merges them; a new key is added. */
export function withPatches(map, patches) {
  const out = { ...map };
  for (const [key, patch] of Object.entries(patches ?? {})) out[key] = { ...(out[key] ?? {}), ...patch };
  return out;
}

/**
 * A map with an edit taken out of it again, field by field: what each field
 * was before, where it still reads what the edit made it. One that has moved
 * on since belongs to whoever moved it.
 */
export function withoutPatches(map, patches, before) {
  const out = { ...map };
  for (const [key, patch] of Object.entries(patches ?? {})) {
    if (!out[key]) continue;
    const was = before?.[key];
    const now = { ...out[key] };
    for (const [field, value] of Object.entries(patch)) {
      if (JSON.stringify(now[field]) !== JSON.stringify(value)) continue;
      if (was && Object.hasOwn(was, field)) now[field] = was[field]; else delete now[field];
    }
    if (!was && !Object.keys(now).length) delete out[key]; else out[key] = now;
  }
  return out;
}

/**
 * What the store last said, and the edits made here that it has not answered.
 *
 * THE SCREEN FIRST, THE WRITE BEHIND IT. An edit is drawn over what the store
 * holds from the moment it is made, so nothing on the page waits for a write:
 * offline, one does not resolve until the connection is back. When the store
 * takes it, it is simply true. When the store refuses it, it comes out again -
 * this edit and no other - and stands as a fault, with the words for it, until
 * it is retried, dismissed or made again.
 *
 * An edit is { kind, patches, what, ... }: `patches` is key -> fields, `what`
 * names what was not done if it fails ("XX01 not renamed").
 *
 * @param {object} o
 * @param {(edit, next) => Promise} o.write  saves an edit; `next` is the whole value with it in
 * @param {boolean} [o.inTurn]  one write at a time, each made from what the one
 *        before it left - for a store that takes the whole value, where a
 *        write would otherwise carry along an edit that was refused
 * @param {() => void} [o.drawn]    draw what `now()` says
 * @param {(edit) => void} [o.saved]
 * @param {(edit, words) => void} [o.failed]
 */
export function createLedger({ write, apply = withPatches, revert = withoutPatches, inTurn = false,
  drawn = () => {}, saved = () => {}, failed = () => {} }) {
  let stored = null;
  let told = 0;                // how often the store has said something
  let waiting = [];
  let faults = [];
  let turn = Promise.resolve();

  const same = (a, b) => a.kind === b.kind && Object.keys(a.patches).some((k) => Object.hasOwn(b.patches, k));
  const less = (patches, kept) => Object.fromEntries(Object.entries(patches).filter(([k]) => !Object.hasOwn(kept, k)));

  /** The edit is on screen from here. */
  function begin(edit) {
    faults = faults.filter((f) => !same(f.edit, edit));
    const entry = { edit, before: stored, told };
    waiting = [...waiting, entry];
    return entry;
  }

  /**
   * The store has answered: `kept` is what it took, all of the edit's patches,
   * some or none. Where it has said something since, what it said already has
   * the edit in it - a listener is told of a write as it is made - and it is
   * the newer word.
   */
  function end(entry, kept) {
    waiting = waiting.filter((w) => w !== entry);
    stored = revert(stored, less(entry.edit.patches, kept), entry.before);
    if (told === entry.told) stored = apply(stored, kept);
  }

  async function save(edit) {
    const entry = begin(edit);
    drawn();
    const go = async () => write(edit, apply(stored, edit.patches));
    try {
      const mine = inTurn ? turn.then(go) : go();
      if (inTurn) turn = mine.catch(() => {});
      await mine;
    } catch (e) {
      end(entry, {});
      const words = failure(edit.what, e);
      faults = [...faults, { edit, words }];
      drawn();
      failed(edit, words);
      return false;
    }
    end(entry, edit.patches);
    saved(edit);
    return true;
  }

  return {
    set(value) { stored = value; told += 1; },
    now: () => waiting.reduce((value, w) => apply(value, w.edit.patches), stored),
    waiting: () => waiting.length,
    faults: () => faults,
    dismiss(fault) { faults = faults.filter((f) => f !== fault); drawn(); },
    retry: (fault) => save(fault.edit),
    save, begin, end,
  };
}

// ---- names ---------------------------------------------------------------------

/** Two display codes that are one to the board: aliasGroups reads them trimmed, in any case. */
export const sameName = (a, b) => String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();

// The display and the grouping key move together - keeping them equal is what
// stops a line printing one code while grouping under another, which is how
// XX01 and XX11 ended up on separate rows.
const named = (display) => ({ display, boat: display, _confirmed: true });

/** Every code on a line, under one confirmed display code. */
export const nameCodes = (codes, display) => Object.fromEntries(codes.map((c) => [c, named(display)]));

const groupsWith = (map, codes) => aliasGroups(map).filter((g) => g.codes.some((c) => codes.includes(c)));

/**
 * The boats a change would bring onto the same line as the codes it changes,
 * as groups of ERP codes: those that share a line with them after it and did
 * not before. Found by making the change on a copy and grouping that, so it is
 * never a second opinion on what merges (see aliasGroups).
 */
export function joinedBy(map, patches) {
  const codes = Object.keys(patches);
  const before = new Set(groupsWith(map, codes).flatMap((g) => g.codes));
  const joined = groupsWith(withPatches(map, patches), codes).flatMap((g) => g.codes).filter((c) => !before.has(c));
  return aliasGroups(map).filter((g) => g.codes.some((c) => joined.includes(c))).map((g) => g.codes);
}

/**
 * One code off its line, under `display`. The codes it leaves keep what they
 * print. Where something other than the display code holds them together - a
 * model they share that nobody has decided on, a grouping key from before the
 * two were kept equal - they are also given the boat they print, or the code
 * would not have left.
 *
 * @param {string[]} line     the codes on the line it leaves
 * @param {string} lineReads  what that line prints
 */
export function moveCode(map, line, code, display, lineReads) {
  const patches = nameCodes([code], display);
  const left = line.filter((c) => c !== code);
  const still = groupsWith(withPatches(map, patches), [code]).flatMap((g) => g.codes);
  if (left.some((c) => still.includes(c))) for (const c of left) patches[c] = { boat: lineReads };
  return patches;
}

// ---- a file of codes -------------------------------------------------------------

/** The file's name: the calendar day it was made on, here (a UTC date is yesterday's until ten). */
export const downloadName = (dt) => `vessel-codes-${toISO(dt).replace(/-/g, '')}.json`;

const LISTS = ['models', LEGACY_MODELS_KEY, 'hull_prefix', 'items'];

/** A record under its code: an object, its lists lists and its display code text. */
const isRecord = (code, v) => Boolean(code.trim()) && Boolean(v) && typeof v === 'object' && !Array.isArray(v)
  && LISTS.every((f) => v[f] === undefined || v[f] === null || Array.isArray(v[f]))
  && (v.display === undefined || v.display === null || typeof v.display === 'string');

/** Why this is not a file of codes and what to do about it, or null. One entry that is not a code refuses the file. */
export function fileProblem(data) {
  const next = 'Choose a file made with Download codes.';
  if (!data || typeof data !== 'object' || Array.isArray(data)) return `not a file of vessel codes. ${next}`;
  const codes = Object.keys(data);
  if (!codes.length) return `no codes in it. ${next}`;
  const bad = codes.filter((c) => !isRecord(c, data[c]));
  if (!bad.length) return null;
  const named = bad.filter((c) => c.trim()).slice(0, 3).join(', ');
  const what = bad.length === 1 ? '1 entry is not a vessel code' : `${bad.length} entries are not vessel codes`;
  return `${what}${named ? ` (${named}${bad.length > 3 ? ', …' : ''})` : ''}. ${next}`;
}

// What a record's fields are called on the page.
const FIELD = {
  display: 'Display code',
  boat: 'Boat',
  _confirmed: 'Confirmed',
  models: 'Model codes',
  hull_prefix: 'Hull',
  items: 'Item codes',
  sheetModel: 'Model on the sheet',
  sheetHidden: 'Hidden from sheet',
};
const YES_NO = ['_confirmed', 'sheetHidden'];

// Absent, empty and off are one thing to the page.
const plain = (v) => (v === undefined || v === null || v === false || v === '' || (Array.isArray(v) && !v.length) ? null : v);

const inWords = (field, v) => {
  const p = plain(v);
  if (YES_NO.includes(field)) return p ? 'yes' : 'no';
  if (p === null) return 'none';
  return Array.isArray(p) ? p.join(', ') : String(p);
};

/** What an entry from a file would change on a record: [{ field, from, to }], in words. */
export function fieldChanges(now, entry) {
  const out = [];
  let other = false;
  for (const [field, to] of Object.entries(entry)) {
    if (JSON.stringify(plain(now[field])) === JSON.stringify(plain(to))) continue;
    // Moves with the display code, so beside one it says nothing more.
    if (field === 'boat' && sameName(to, entry.display) && !sameName(now.display, entry.display)) continue;
    if (!FIELD[field]) { other = true; continue; }
    out.push({ field: FIELD[field], from: inWords(field, now[field]), to: inWords(field, to) });
  }
  if (other) out.push({ field: 'Other details', from: '', to: 'changed' });
  return out;
}

/**
 * What loading a file would do: the codes the map does not have, those it
 * would change and how, and those it would leave as they are.
 */
export function loadReview(data, map) {
  const fresh = [];
  const changed = [];
  const same = [];
  for (const [code, entry] of Object.entries(data)) {
    if (!map[code]) { fresh.push({ code, entry }); continue; }
    const changes = fieldChanges(map[code], entry);
    if (changes.length) changed.push({ code, entry, changes }); else same.push(code);
  }
  return { fresh, changed, same };
}

// ---- the davit list ----------------------------------------------------------------

/** The davit list with some boats' fields changed, in the order it prints. */
export const davitsWith = (list, patches) => (list ?? []).map((d) => (patches[d.boat] ? { ...d, ...patches[d.boat] } : d));

// ---- a link to one code --------------------------------------------------------------

/** The code in an address: `#XX01`, or `#XX01%2FXX02` for one with a slash. Null when there is none. */
export function codeInHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  try { return decodeURIComponent(raw).trim() || null; } catch { return null; }
}
