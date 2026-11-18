// parts-review.js — the Stock Items import review, as import-review.js draws it.
//
// The parts page stages an export and shows it in the same review the board
// uses. This turns what the import found (the diff against the loaded list, the
// corrections it settles or puts in question, the export's warnings) into that
// review's description, and settles the corrections in question with the
// answers given in it. The page reads the file, draws and saves; nothing here
// touches the store.

import { FAMILIES, familyOf, clean, resolveReview } from './parts.js';

// A list longer than this opens with its families shut. On a first load every
// part is new, and two thousand open rows are not something anybody reads.
export const SHUT_OVER = 200;

const FIELD = { desc: 'Description', bin: 'Bin' };

/** The family heading a code sits under; every part has one, a stray code its letters. */
const familyKey = (id) => familyOf(id) ?? ((/^[A-Z]+/.exec(String(id ?? '').toUpperCase()) ?? [''])[0] || '#');

/**
 * One list as groups, a family each, in the order the search pills use.
 * @param {string} key   the list, so each group's open state is its own
 * @param {Array} rows   the review's rows, `key` being the part code
 */
export function byFamily(key, rows) {
  const groups = new Map(FAMILIES.map((f) => [f, []]));
  for (const r of rows) {
    const f = familyKey(r.key);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(r);
  }
  const shut = rows.length > SHUT_OVER;
  return [...groups].filter(([, g]) => g.length).map(([f, g]) => ({
    key: `${key}:${f}`, title: f, rows: g, shutByDefault: shut,
  }));
}

/** The corrections this export puts in question, as [stored key, correction]. */
export const inQuestion = (updated) => Object.entries(updated ?? {}).filter(([, o]) => o.status === 'review');

/**
 * The answer a correction in question has: the one given, or Keep. A part gone
 * from the export has nothing to keep against, so it has none until Accept.
 */
export function answerFor(key, o, answers) {
  const a = answers?.get(key);
  if (a) return a;
  return o.reviewReason === 'missing_from_export' ? null : { action: 'keep', value: o.value };
}

/**
 * The corrections in question, settled with the answers given in the review.
 *
 * Unanswered is Keep: the correction stands against the ERP's new value. A
 * changed value is an edit, unless it is what the ERP now says, which is the
 * same as accepting it. A correction for a part gone from the export is
 * dropped when accepted and otherwise stays in question, for the Corrections
 * tab, as it always has.
 *
 * @param {object} updated    reconcile's `updated`, keyed as stored
 * @param {Map} answers       key -> { action: 'keep' | 'accept', value }
 * @param {Map} partsById     the new export
 * @returns {object} `updated` with every correction in question settled
 */
export function settleAnswers(updated, answers, partsById, { by = null, now = new Date() } = {}) {
  const out = { ...updated };
  for (const [key, o] of inQuestion(updated)) {
    const part = partsById.get(o.partId) ?? null;
    const a = answerFor(key, o, answers);
    if (a?.action === 'accept') { out[key] = resolveReview(o, 'accept', { by, now }); continue; }
    if (!part) continue;
    const v = clean(a?.value ?? o.value);
    if (!v || v === clean(o.value)) out[key] = resolveReview(o, 'keep', { part, now });
    else if (v === clean(part[o.field])) out[key] = resolveReview(o, 'accept', { by, now });
    else out[key] = resolveReview(o, 'edit', { value: v, part, now });
  }
  return out;
}

const mini = (label) => {
  const b = document.createElement('button');
  b.className = 'mini';
  b.textContent = label;
  return b;
};

/**
 * One correction in question: the code, the correction in a box that edits
 * it, which field and what the ERP now says, and Keep / Accept. The answer is
 * kept in `answers` as it is given; nothing is drawn again, so typing keeps
 * its place.
 */
function decisionRow(key, o, answers) {
  const gone = o.reviewReason === 'missing_from_export';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = answerFor(key, o, answers)?.value ?? o.value;
  input.disabled = gone;
  input.setAttribute('aria-label', `${o.partId} ${FIELD[o.field] ?? o.field}`);
  const keep = mini('Keep correction');
  const accept = mini('Accept ERP');
  keep.disabled = gone;
  const show = () => {
    const a = answerFor(key, o, answers)?.action ?? null;
    keep.classList.toggle('on', a === 'keep');
    keep.setAttribute('aria-pressed', String(a === 'keep'));
    accept.classList.toggle('on', a === 'accept');
    accept.setAttribute('aria-pressed', String(a === 'accept'));
  };
  keep.addEventListener('click', () => { answers.set(key, { action: 'keep', value: input.value }); show(); });
  accept.addEventListener('click', () => {
    // Accept on its own is the only answer a gone part has, so it undoes.
    if (gone && answers.get(key)?.action === 'accept') answers.delete(key);
    else answers.set(key, { action: 'accept', value: input.value });
    show();
  });
  input.addEventListener('input', () => { answers.set(key, { action: 'keep', value: input.value }); show(); });
  show();
  return {
    cls: 'is-decision',
    key: o.partId,
    main: input,
    detail: `${FIELD[o.field] ?? o.field} · ${gone ? 'gone from the export' : `ERP now says "${o.observed ?? ''}"`}`,
    control: () => { const f = document.createDocumentFragment(); f.append(keep, accept); return f; },
  };
}

/**
 * The review's description.
 *
 * @param {object} x
 *   lede          the line under the heading
 *   fresh         the parts in this export
 *   loaded        how many parts are loaded now; 0 on a first load
 *   d             diffParts(loaded list, fresh)
 *   notices       reconcile's notices
 *   updated       reconcile's updated, keyed as stored
 *   warnings      validateStockExport's warnings
 *   hasCorrections  whether there are any corrections at all
 *   descOf        code -> its description in the loaded list, for the codes gone
 *   nextById      code -> part in this export
 *   answers       Map, the answers to the corrections in question; given here
 *   apply, cancel the page's own
 */
export function stockReview(x) {
  const { fresh, d, notices, warnings = [], answers } = x;
  const stat = (key, n, label, title, rows, note) => ({
    key, n, label, note,
    detail: n ? () => ({ title: `${title} (${n})`, groups: byFamily(key, rows()) }) : undefined,
  });
  const arrow = (from, to) => `${from || '(blank)'}  →  ${to || '(blank)'}`;
  const questioned = inQuestion(x.updated);

  const stats = [
    stat('parts', fresh.length, 'parts', 'Every part',
      () => fresh.map((p) => ({ key: p.id, main: p.desc })),
      x.loaded ? `${x.loaded} loaded now` : 'first load'),
    stat('added', d.added.length, 'new codes', 'New codes',
      () => d.added.map((id) => ({ key: id, main: x.nextById.get(id)?.desc ?? '' }))),
    stat('removed', d.removed.length, 'codes gone', 'Codes gone',
      () => d.removed.map((id) => ({ key: id, main: x.descOf(id) }))),
    stat('desc', d.descChanged.length, 'descriptions changed', 'Descriptions changed',
      () => d.descChanged.map((c) => ({ key: c.id, main: `${c.from}  →  ${c.to}` }))),
    stat('bin', d.binChanged.length, 'bins changed', 'Bins changed',
      () => d.binChanged.map((c) => ({ key: c.id, main: arrow(c.from, c.to) }))),
  ];
  if (d.metaChanged.length) {
    stats.push(stat('meta', d.metaChanged.length, 'type, unit or source changed', 'Type, unit or source changed',
      () => d.metaChanged.map((c) => ({ key: c.id, main: arrow(c.from, c.to) }))));
  }
  if (notices.resolved.length) {
    stats.push(stat('fixed', notices.resolved.length, 'fixed in the ERP', 'Fixed in the ERP',
      () => notices.resolved.map((o) => ({ key: o.partId, main: `${o.field}: "${o.value}"` }))));
  }
  if (questioned.length) {
    stats.push(stat('review', questioned.length, 'need a decision', 'Corrections needing a decision',
      () => questioned.map(([key, o]) => decisionRow(key, o, answers))));
  }

  const { resolved, pending, review } = notices;
  return {
    title: 'Review this import',
    lede: x.lede,
    stats,
    summary: x.hasCorrections ? {
      lead: 'Corrections:',
      parts: [
        { n: resolved.length, label: 'fixed in the ERP', cls: 'is-new' },
        { n: pending.length, label: 'still waiting', cls: 'is-same' },
        { n: review.length, label: 'need a decision', cls: 'is-changed' },
      ],
      after: !resolved.length && !pending.length && !review.length ? 'none live' : null,
    } : null,
    concerns: warnings.length ? [{
      id: 'export', level: 'warn',
      title: warnings.length === 1 ? 'Export warning' : 'Export warnings',
      rows: warnings.map((w, i) => ({ key: `#${i + 1}`, main: w })),
    }] : [],
    clean: 'Nothing outstanding.',
    actions: {
      apply: { label: warnings.length ? 'Apply anyway' : 'Apply this import', run: x.apply },
      cancel: { label: 'Cancel', run: x.cancel },
      hint: 'Read the warnings above first.',
    },
  };
}
