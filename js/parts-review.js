// parts-review.js — the parts page's two import reviews, as import-review.js draws them.
//
// The parts page stages a Stock Items export, or a materials sheet, and shows
// it in the same review the board uses. This turns what the file holds and what
// it changes into that review's description: for the export, the diff against
// the loaded list, the corrections it settles or puts in question and its
// warnings, and it settles the corrections in question with the answers given
// in the review; for the materials sheet, its categories, what it changes
// against the sheet loaded now, and the codes the part list lacks. The page
// reads the file, draws and saves; nothing here touches the store.

import { FAMILIES, FIELD_NAME, familyOf, tidyValue, resolveReview, materialGroups, browseMaterials } from './parts.js';

// A list longer than this opens with its families shut. On a first load every
// part is new, and two thousand open rows are not something anybody reads.
export const SHUT_OVER = 200;

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
    const v = tidyValue(o.field, a?.value ?? o.value);
    if (!v || v === tidyValue(o.field, o.value)) out[key] = resolveReview(o, 'keep', { part, now });
    else if (v === tidyValue(o.field, part[o.field])) out[key] = resolveReview(o, 'accept', { by, now });
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
  input.setAttribute('aria-label', `${o.partId} ${FIELD_NAME[o.field] ?? o.field}`);
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
    detail: `${FIELD_NAME[o.field] ?? o.field} \u00b7 ${gone ? 'gone from the export' : `ERP now says "${o.observed ?? ''}"`}`,
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
 *   apply, cancel the page's own; `apply` is run by the button, with its label
 *                 setter, while the button is busy
 *   retry         this import was applied in part: the rest is what is left to do
 */
export function stockReview(x) {
  const { fresh, d, notices, warnings = [], answers } = x;
  const stat = (key, n, label, title, rows, note) => ({
    key, n, label, note,
    detail: n ? () => ({ title: `${title} (${n})`, groups: byFamily(key, rows()) }) : undefined,
  });
  const arrow = (from, to) => `${from || '(blank)'}  \u2192  ${to || '(blank)'}`;
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
      () => d.descChanged.map((c) => ({ key: c.id, main: `${c.from}  \u2192  ${c.to}` }))),
    stat('bin', d.binChanged.length, 'bins changed', 'Bins changed',
      () => d.binChanged.map((c) => ({ key: c.id, main: arrow(c.from, c.to) }))),
  ];
  if (d.metaChanged.length) {
    stats.push(stat('meta', d.metaChanged.length, 'type, unit or source changed', 'Type, unit or source changed',
      () => d.metaChanged.map((c) => ({ key: c.id, main: arrow(c.from, c.to) }))));
  }
  if (notices.resolved.length) {
    stats.push(stat('fixed', notices.resolved.length, 'fixed in the ERP', 'Fixed in the ERP',
      () => notices.resolved.map((o) => ({ key: o.partId, main: `${FIELD_NAME[o.field] ?? o.field}: "${o.value}"` }))));
  }
  if (questioned.length) {
    stats.push(stat('review', questioned.length, 'awaiting a decision', 'Corrections awaiting a decision',
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
        { n: review.length, label: 'awaiting a decision', cls: 'is-changed' },
      ],
      after: !resolved.length && !pending.length && !review.length ? 'none live' : null,
    } : null,
    concerns: warnings.length ? [{
      id: 'export', level: 'warn',
      title: warnings.length === 1 ? 'Export warning' : 'Export warnings',
      rows: warnings.map((w, i) => ({ key: `#${i + 1}`, main: w })),
    }] : [],
    clean: 'Nothing outstanding.',
    // With warnings, keeping the list that is loaded is the filled choice. An
    // empty list cannot be applied at all: it would blank the page for everyone.
    actions: {
      apply: {
        label: x.retry ? 'Retry import' : warnings.length ? 'Apply import anyway' : 'Apply this import',
        run: x.apply,
        busy: 'Applying…',
        blocked: fresh.length ? null : 'No parts in this file, so there is nothing to apply.',
      },
      cancel: { label: x.retry ? 'Close review' : 'Discard import', run: x.cancel },
      risky: warnings.length > 0 && !x.retry,
      hint: 'Read the warnings above first.',
    },
  };
}

// ---------------------------------------------------------------------------
// the materials sheet
// ---------------------------------------------------------------------------

// What a material can move on the sheet, and the word a row's tag uses for it.
// The description is not here: it stands in only for a code the part list
// lacks, and the part list's own description is the one shown.
const MATERIAL_FIELDS = [['category', 'category'], ['subcategory', 'form'], ['qtyType', 'quantity type']];

/**
 * What a new materials sheet changes against the one loaded, by code.
 * @returns {{ first: boolean, added: Set, changed: Map, same: number, removed: Array }}
 *   `changed` is code -> the words for what moved; `removed` the old rows.
 */
export function diffMaterials(prev, next) {
  const before = new Map((prev ?? []).map((m) => [m.code, m]));
  const seen = new Set();
  const added = new Set();
  const changed = new Map();
  let same = 0;
  for (const m of next ?? []) {
    seen.add(m.code);
    const was = before.get(m.code);
    if (!was) { added.add(m.code); continue; }
    const moved = MATERIAL_FIELDS.filter(([f]) => (was[f] ?? '') !== (m[f] ?? '')).map(([, word]) => word);
    if (moved.length) changed.set(m.code, moved); else same++;
  }
  const removed = (prev ?? []).filter((m) => !seen.has(m.code));
  return { first: !before.size, added, changed, same, removed };
}

/**
 * The materials review's description.
 *
 * @param {object} x
 *   lede      the line under the heading
 *   items     the sheet's materials
 *   index     buildMaterialsIndex(part list, items, corrections)
 *   prev      the sheet's materials loaded now; empty on a first load
 *   warnings  parseMaterialsCsv's warnings
 *   descOf    code -> its description in the part list, for a material gone
 *   apply, cancel the page's own
 */
export function materialsReview(x) {
  const { index, warnings = [] } = x;
  const diff = diffMaterials(x.prev, x.items);
  const missing = index.filter((e) => e.missing);

  const row = (e) => {
    const code = e.material.code;
    const marks = [];
    let cls = '';
    if (!diff.first) {
      if (diff.added.has(code)) { cls = 'is-new'; marks.push({ cls: 'fr-tag is-new', text: 'new' }); }
      else if (diff.changed.has(code)) marks.push({ cls: 'fr-tag is-changed', text: diff.changed.get(code).join(', ') });
      else cls = 'is-same';
    }
    if (e.missing) marks.push({ cls: 'fr-note', text: 'not in the part list' });
    return { cls, key: code, main: e.eff.desc, detail: e.material.qtyType, marks };
  };

  // In rack order: category, form, then size by description.
  const rack = browseMaterials(index);
  const stats = materialGroups(index).map((g) => ({
    key: `cat:${g.category}`,
    n: g.count,
    label: g.category,
    note: g.subs.map((s) => `${s.subcategory} ${s.count}`).join(' \u00b7 '),
    detail: () => ({
      title: `${g.category} (${g.count})`,
      groups: g.subs.map((s) => ({
        key: `cat:${g.category}:${s.subcategory}`,
        title: s.subcategory,
        rows: rack.filter((e) => e.material.category === g.category && e.material.subcategory === s.subcategory).map(row),
        shutByDefault: g.count > SHUT_OVER,
      })),
    }),
  }));
  if (diff.removed.length) {
    const byCat = new Map();
    for (const m of diff.removed) {
      if (!byCat.has(m.category)) byCat.set(m.category, []);
      byCat.get(m.category).push(m);
    }
    stats.push({
      key: 'gone',
      n: diff.removed.length,
      label: 'gone from the sheet',
      detail: () => ({
        title: `Gone from the sheet (${diff.removed.length})`,
        groups: [...byCat].map(([cat, ms]) => ({
          key: `gone:${cat}`,
          title: cat,
          rows: ms.map((m) => ({ cls: 'is-leaving', key: m.code, main: x.descOf(m.code) || m.desc, detail: m.qtyType })),
          shutByDefault: diff.removed.length > SHUT_OVER,
        })),
      }),
    });
  }

  const concerns = [];
  if (missing.length) {
    concerns.push({
      id: 'missing', level: 'warn',
      title: missing.length === 1 ? 'Code not in the part list' : 'Codes not in the part list',
      rows: missing.map((e) => ({
        key: e.material.code, main: e.material.desc, detail: `${e.material.category} \u203a ${e.material.subcategory}`,
      })),
    });
  }
  if (warnings.length) {
    concerns.push({
      id: 'sheet', level: 'warn',
      title: warnings.length === 1 ? 'Sheet warning' : 'Sheet warnings',
      rows: warnings.map((w, i) => ({ key: `#${i + 1}`, main: w })),
    });
  }

  const moved = diff.added.size + diff.changed.size + diff.removed.length;
  return {
    title: 'Review the materials sheet',
    lede: x.lede,
    stats,
    summary: diff.first ? null : {
      lead: 'Against the sheet you have now:',
      parts: [
        { n: diff.added.size, label: 'new', cls: 'is-new' },
        { n: diff.changed.size, label: 'changed', cls: 'is-changed' },
        { n: diff.same, label: 'unchanged', cls: 'is-same' },
        { n: diff.removed.length, label: 'gone', cls: 'is-leaving' },
      ],
      after: moved ? null : 'nothing has moved since the last sheet',
    },
    concerns,
    clean: 'Nothing outstanding.',
    actions: {
      apply: {
        label: concerns.length ? 'Load sheet anyway' : 'Load this sheet',
        run: x.apply,
        busy: 'Loading…',
        blocked: x.items?.length ? null : 'No materials in this file, so there is nothing to load.',
      },
      cancel: { label: 'Discard import', run: x.cancel },
      risky: concerns.length > 0,
      hint: 'Read the warnings above first.',
    },
  };
}
