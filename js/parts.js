// parts.js — the part list: what comes in from the ERP, how it is searched,
// and how a correction made here is reconciled against the next export.
//
// Pure functions, no DOM, no store. parts-page.js draws; this decides.
//
// The three ideas that shape everything below:
//
//   1. THE ERP IS THE SOURCE OF TRUTH AND THIS APP CANNOT WRITE TO IT. So a
//      correction here is a note to the one person who can, kept only until
//      the ERP catches up — see `reconcile`. Nothing is ever created here that
//      the ERP does not already know about.
//   2. SIX FIELDS COME THROUGH THE DOOR: code, description, type, unit, source
//      and bin. The export carries prices and a dozen other things; none of
//      them is read, stored, cached or sent anywhere. `PART_COLUMNS` is the
//      allow-list.
//   3. SEARCH IS FOR DESCRIPTIONS PEOPLE HALF-REMEMBER. "m12 25 stainless" has
//      to find "M12 x 25mm SHCS 316 S/S", and 1" has to find 25.4mm. That is a
//      tokeniser that knows what a dimension looks like and what an inch is,
//      plus a synonym table, plus a typo allowance — and it runs in the
//      browser over the whole list, because the list is small.
//
// NO REAL CODES, CUSTOMER NAMES OR PART NAMES IN THIS FILE. It ships to anyone
// who opens the app. Examples use made-up codes.

import { createSearch, DEFAULT_SYNONYMS, MM_PER_INCH, mmOf, editDistance, naturalCompare } from './search-core.js';

// ---------------------------------------------------------------------------
// WHAT COMES IN
// ---------------------------------------------------------------------------

/**
 * Which stock items are parts, by code prefix. The families the workshop
 * builds from; everything else in the export is a finished product, a
 * service or a consumable and has no bin to look up.
 */
export const PART_ID_RE = /^S(BL|DC|GD|HC|L|RL|S|T|WD)/;

/**
 * S-prefixed families known NOT to be parts. Anything else S-prefixed that
 * fails PART_ID_RE is probably a family that did not exist when the rule was
 * written, and the import says so rather than silently dropping it.
 */
export const KNOWN_EXCLUDED_RE = /^S[AE]/;

/** The ONLY columns read from the export. Everything else stops at the adapter. */
export const PART_COLUMNS = ['Inventory ID', 'Description', 'Type', 'Base Unit', 'Default Issue From', 'Source'];

/** The fields beside code, description and bin. Shown on a desktop; never searched. */
export const META_FIELDS = ['type', 'unit', 'source'];

/** The Parameters sheet's title on a genuine stock export. */
export const REQUIRED_TITLE = 'Stock Items';

/** How old the ERP data can be before the page says so. */
export const STALE_DAYS = 30;

/**
 * The families the filter pills offer and the workbook has tabs for: the old
 * drafting sheet's tabs, plus the small top-level prefixes it never got round
 * to. Longest match wins, so STC and STL are their own families, while
 * everything else that starts ST — including the watermaker model codes,
 * which run ST plus a range or a generation plus the size — is plain ST.
 */
export const FAMILIES = ['SBL', 'SDC', 'SGD', 'SHC', 'SL', 'SRL', 'SS', 'STC', 'STL', 'ST', 'SWD'];

export const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The family a part code belongs to, or null if it is not a part. */
export function familyOf(id) {
  const letters = (/^[A-Z]+/.exec(String(id ?? '').toUpperCase()) ?? [''])[0];
  let best = null;
  for (const f of FAMILIES) {
    if (letters.startsWith(f) && (!best || f.length > best.length)) best = f;
  }
  return best;
}

/** A bin is a location. The warehouse default is not one, and blank is not one. */
export const hasBin = (bin) => Boolean(bin) && String(bin).trim().toUpperCase() !== 'MAIN';

/**
 * Rows in, parts out.
 *
 * @param {Array<Object>} rows  keyed by the export's column captions
 * @returns {{parts: Array<{id, desc, bin, type, unit, source}>, excluded: Object<string, number>}}
 *   `excluded` counts S-prefixed codes that failed the filter, by 3-letter
 *   family, so the import can flag one it has never seen.
 */
export function transformParts(rows) {
  const parts = [];
  const excluded = {};
  const seen = new Set();
  for (const r of rows ?? []) {
    const id = clean(r['Inventory ID']);
    if (!id || seen.has(id)) continue;
    if (PART_ID_RE.test(id)) {
      seen.add(id);
      parts.push({
        id, desc: clean(r['Description']), bin: clean(r['Default Issue From']),
        type: clean(r['Type']), unit: clean(r['Base Unit']), source: clean(r['Source']),
      });
    } else if (id.startsWith('S')) {
      const fam = id.slice(0, 3);
      excluded[fam] = (excluded[fam] ?? 0) + 1;
    }
  }
  return { parts, excluded };
}

/** Excluded S-families that are not on the known-not-a-part list. */
export const unknownFamilies = (excluded) =>
  Object.keys(excluded ?? {}).filter((f) => !KNOWN_EXCLUDED_RE.test(f)).sort();

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The export's own timestamp, from its Parameters sheet, as ISO.
 *
 * The ERP writes "27 May 2026 15:56 PM GMT+10:00" — 24-hour time with an AM/PM
 * suffix that is wrong half the day. So the suffix only counts when the hour
 * could actually be ambiguous.
 */
export function parseExportDate(text) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i
    .exec(String(text ?? ''));
  if (!m) return null;
  const mo = MONTHS.indexOf(m[2].toLowerCase());
  if (mo < 0) return null;
  let h = Number(m[4]);
  const ap = (m[6] ?? '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${m[3]}-${p2(mo + 1)}-${p2(Number(m[1]))}T${p2(h)}:${m[5]}:00+10:00`;
}

/** Days between an ISO timestamp and now; null if unparseable. */
export function ageInDays(iso, now = new Date()) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86400000);
}

/**
 * Is this file the right export, and is anything about it worth a second look?
 *
 * Errors stop the import. Warnings ask for a confirm. The distinction is
 * whether the file could be right: a production export dropped here can
 * never be, and a stock export dated before the one already loaded might be.
 */
export function validateStockExport({
  sheetNames = [], title = '', headings = [], savedFilter = '', exportDate = null,
  count = 0, excluded = {}, current = null,
} = {}) {
  const errors = [];
  const warnings = [];

  if (!sheetNames.includes('Data')) errors.push("No 'Data' sheet — this is not a stock items export.");
  if (clean(title) !== REQUIRED_TITLE) {
    errors.push(`The Parameters sheet says "${clean(title) || 'nothing'}", not "${REQUIRED_TITLE}" `
      + '— this looks like a different export. The production orders file goes on the board, not here.');
  }
  const missing = PART_COLUMNS.filter((c) => !headings.includes(c));
  if (missing.length) errors.push(`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  if (errors.length) return { errors, warnings };

  if (!exportDate) warnings.push('Could not read the export date from the Parameters sheet.');
  if (current?.exportDate && exportDate && exportDate < current.exportDate) {
    warnings.push(`This export is dated ${exportDate.slice(0, 10)}, older than the one already loaded `
      + `(${current.exportDate.slice(0, 10)}). Importing it would move the list backwards.`);
  }
  // \bactive\b, not /active/: "Equals Inactive" contains the word and is the
  // exact case this warning exists for.
  if (savedFilter && !/\bactive\b/i.test(savedFilter)) {
    warnings.push("The saved filter does not mention 'Active' — the file may include retired items.");
  }
  if (current?.count) {
    const delta = count - current.count;
    if (Math.abs(delta) > 50 || Math.abs(delta) > current.count * 0.05) {
      warnings.push(`Part count moves from ${current.count} to ${count} (${delta > 0 ? '+' : ''}${delta}) `
        + '— a big jump for one export.');
    }
  }
  const unknown = unknownFamilies(excluded);
  if (unknown.length) {
    warnings.push(`Codes starting ${unknown.join(', ')} were excluded but are not a known non-part family `
      + '— possibly a new product line the filter needs to learn.');
  }
  return { errors, warnings };
}

/** Type, unit and source on one line, for a diff or a card. */
export const metaLine = (p) => META_FIELDS.map((f) => p?.[f]).filter(Boolean).join(' · ');

/**
 * What changed between two lists, by code.
 *
 * `metaChanged` is type, unit or source moving. A list loaded before those
 * were kept has none of them, and every part would count as changed on the
 * first import after — which is true and useless, so that case is skipped.
 */
export function diffParts(prev, next) {
  const before = new Map((prev ?? []).map((p) => [p.id, p]));
  const after = new Map((next ?? []).map((p) => [p.id, p]));
  const added = [], removed = [], descChanged = [], binChanged = [], metaChanged = [];
  const hasMeta = (p) => META_FIELDS.some((f) => f in p);
  for (const [id, p] of after) {
    const was = before.get(id);
    if (!was) { added.push(id); continue; }
    if (was.desc !== p.desc) descChanged.push({ id, from: was.desc, to: p.desc });
    if (was.bin !== p.bin) binChanged.push({ id, from: was.bin, to: p.bin });
    if (hasMeta(was) && META_FIELDS.some((f) => (was[f] ?? '') !== (p[f] ?? ''))) {
      metaChanged.push({ id, from: metaLine(was), to: metaLine(p) });
    }
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added: added.sort(), removed: removed.sort(), descChanged, binChanged, metaChanged };
}

// ---------------------------------------------------------------------------
// CORRECTIONS
//
// A correction is a note to the person who can edit the ERP, dressed up as
// data so the app can show the right value meanwhile and can tell, on the
// next export, whether they got to it.
// ---------------------------------------------------------------------------

export const OVERRIDE_FIELDS = ['desc', 'bin'];
export const OVERRIDE_SEP = '~';

/** Firestore ids cannot hold '/', and part codes can. Same fix as itemOverrides. */
export const encodePartId = (id) => String(id).replace(/\//g, '__');
export const overrideKey = (id, field) => `${encodePartId(id)}${OVERRIDE_SEP}${field}`;

/** Status pending or review shows in the app; resolved is history. */
export const isActive = (o) => o && (o.status === 'pending' || o.status === 'review');

/**
 * What a part shows, once corrections are applied.
 * @returns {{desc, bin, descOv, binOv}} the override objects where active
 */
export function effective(part, overrides) {
  const d = overrides?.[overrideKey(part.id, 'desc')];
  const b = overrides?.[overrideKey(part.id, 'bin')];
  return {
    desc: isActive(d) ? d.value : part.desc,
    bin: isActive(b) ? b.value : part.bin,
    descOv: isActive(d) ? d : null,
    binOv: isActive(b) ? b : null,
  };
}

/**
 * Make a correction. Throws with a plain reason rather than making a bad one.
 *
 * @param {{partId, field, value, reason, by, part}} args
 *   `part` is the current ERP record — the baseline is what the ERP says NOW,
 *   which is what makes reconciliation possible later.
 */
export function createOverride({ partId, field, value, reason, by, part, now = new Date() }) {
  if (!OVERRIDE_FIELDS.includes(field)) throw new Error(`Unknown field '${field}'.`);
  if (!part) throw new Error('That code is not in the current export.');
  const v = clean(value);
  const baseline = clean(part[field]);
  if (!clean(reason)) throw new Error('A reason is required — it is what the person fixing the ERP will read.');
  if (v === baseline) throw new Error('The ERP already says exactly that.');
  return {
    partId, field, value: v, baseline, reason: clean(reason),
    status: 'pending', reviewReason: null, resolution: null,
    createdBy: by ?? null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    importsPending: 0, lastCheckedExportDate: null, resolvedAt: null, resolvedBy: null,
  };
}

/**
 * Check every live correction against a fresh export.
 *
 * WHY THE BASELINE IS MANDATORY. Without recording what the ERP said when the
 * correction was made, "not fixed yet" and "changed to something else" look
 * identical — both are "the ERP disagrees with the correction". The baseline
 * is what tells them apart, and the two need different people: the first is
 * a reminder for the ERP editor, the second is a question for whoever knows
 * which value is right.
 *
 * Pure. Returns new objects; the caller writes them and shows the notices.
 *
 * @param {Object} overrides   key -> override
 * @param {Map<string, {id, desc, bin}>} partsById  the NEW export
 * @param {string} exportDate  ISO, stamped on each checked override
 * @param {Date} [now]
 */
export function reconcile(overrides, partsById, exportDate, now = new Date()) {
  const stamp = now.toISOString();
  const updated = {};
  const notices = { resolved: [], pending: [], review: [] };

  for (const [key, o] of Object.entries(overrides ?? {})) {
    if (!isActive(o)) continue;
    const part = partsById.get(o.partId);
    const next = { ...o, updatedAt: stamp, lastCheckedExportDate: exportDate };

    if (!part) {
      next.status = 'review';
      next.reviewReason = 'missing_from_export';
      notices.review.push(next);
    } else {
      const N = clean(part[o.field]);
      if (N === clean(o.value)) {
        next.status = 'resolved';
        next.resolution = 'myob_fixed';
        next.resolvedAt = stamp;
        next.resolvedBy = 'export';
        notices.resolved.push(next);
      } else if (N === clean(o.baseline)) {
        next.status = 'pending';
        next.reviewReason = null;
        next.importsPending = (o.importsPending ?? 0) + 1;
        notices.pending.push(next);
      } else {
        next.status = 'review';
        next.reviewReason = 'myob_changed';
        next.observed = N;
        notices.review.push(next);
      }
    }
    updated[key] = next;
  }
  return { updated, notices };
}

/**
 * The three answers to a correction in review.
 *   keep    — the correction stands; the ERP's new value becomes the baseline
 *   accept  — the ERP is right after all
 *   edit    — neither was right; here is the value, against the ERP's current one
 */
export function resolveReview(o, action, { value = null, by = null, part = null, now = new Date() } = {}) {
  const stamp = now.toISOString();
  const N = part ? clean(part[o.field]) : (o.observed ?? o.baseline);
  if (action === 'keep') {
    return { ...o, baseline: N, status: 'pending', reviewReason: null, observed: null, updatedAt: stamp };
  }
  if (action === 'accept') {
    return { ...o, status: 'resolved', resolution: 'accepted_myob', reviewReason: null,
      resolvedAt: stamp, resolvedBy: by ?? null, updatedAt: stamp };
  }
  if (action === 'edit') {
    const v = clean(value);
    if (!v) throw new Error('A value is required.');
    if (v === N) throw new Error('The ERP already says exactly that — accept it instead.');
    return { ...o, value: v, baseline: N, status: 'pending', reviewReason: null, observed: null, updatedAt: stamp };
  }
  throw new Error(`Unknown action '${action}'.`);
}

/**
 * Take a correction back.
 *
 * Not the same as the ERP catching up: nothing was fixed, somebody decided
 * the correction was wrong or no longer wanted. It ends like every other
 * correction - resolved, kept as history, no longer shown - and says which
 * kind of ending it was, so the record does not read as an ERP fix that
 * never happened.
 */
export function withdrawOverride(o, { by = null, now = new Date() } = {}) {
  const stamp = now.toISOString();
  return { ...o, status: 'resolved', resolution: 'withdrawn', reviewReason: null, observed: null,
    resolvedAt: stamp, resolvedBy: by, updatedAt: stamp };
}

// ---------------------------------------------------------------------------
// SEARCH
//
// The engine is search-core.js, shared verbatim with the material ordering
// app so the two behave the same: what a size is, what counts as a match, how
// answers are ranked. What is here is only what is particular to parts - the
// vocabulary, what a part code looks like, and the fact that a corrected part
// should still be found by the wording the ERP has.
// ---------------------------------------------------------------------------

/**
 * Words that mean the same thing on a part label. If any member appears, the
 * part is found by all of them, so "stainless" finds "S/S" and "csk" finds
 * "Countersunk". Whole words only. One table, so it can be extended without
 * reading the engine; spellings of a UNIT (volts, litres, schedule, degrees)
 * do not belong here - the engine makes those one way already.
 */
export const SYNONYMS = [
  ...DEFAULT_SYNONYMS,
];

const engine = createSearch({ synonyms: SYNONYMS });

export { MM_PER_INCH, mmOf, editDistance };
/** The first pass: lowercase, one kind of space, typography made plain. */
export const prep = engine.prep;
/** A description or a query, made one way. See search-core.js. */
export const normalise = engine.normalise;
/** Tokens: words, numbers and quantities. */
export const tokenise = engine.tokenise;
/** The query as the terms that each have to be found. */
export const queryTerms = engine.tokenise;

/**
 * Does this look like a part code rather than a description? One word,
 * starting with s and a letter, with a digit or bracket in it. Tried against
 * the codes first; if no part has it, it was a word after all and is searched
 * as one.
 */
const looksLikeCode = (raw) => !raw.includes(' ') && /^s[a-z]/.test(raw) && /[0-9(]/.test(raw);

/**
 * Build once per list, search many times.
 *
 * A corrected part carries the ERP's own wording as a second field at half
 * weight, so it is still found by the words someone remembers from before it
 * was corrected. The engine keeps only the words the correction took away -
 * or a part corrected from 5mm to 3mm would count its fifties twice.
 *
 * @param {Array<{id, desc, bin}>} parts
 * @param {Object} overrides
 */
export function buildIndex(parts, overrides = {}) {
  return (parts ?? []).map((p) => {
    const eff = effective(p, overrides);
    const fields = [{ text: `${eff.desc} ${eff.bin}`, weight: 1 }];
    if (eff.descOv || eff.binOv) fields.push({ text: `${p.desc} ${p.bin}`, weight: 0.5 });
    return {
      ...engine.entry(fields, p.id),
      part: p, eff, family: familyOf(p.id),
      idLower: p.id.toLowerCase(),
      descLen: eff.desc.length,
    };
  });
}

/**
 * Search the index.
 *
 * Every term must match, each on a token of its own, and sizes typed together
 * are worth more found together and in that order. Equal answers come in
 * size order - 8mm before 10mm, an inch where its millimetres put it - and
 * then by code.
 *
 * `relaxed` is true when NO part had everything asked for and the list is the
 * nearest there is rather than a real answer.
 *
 * @returns {{hits: Array<{entry, score}>, total: number, relaxed: boolean}}
 */
export function search(index, query, { limit = 50 } = {}) {
  return engine.search(index, query, { limit, isCode: looksLikeCode });
}

/**
 * A list with no query: filtered and ordered rather than searched.
 *
 * By code unless `byDesc`, which puts it in size order by description - the
 * order a rack is walked in, where the code order is the order things were
 * added to the ERP.
 *
 * @param {{family?: string|null, bin?: 'all'|'with'|'without', binFirst?: boolean, byDesc?: boolean}} f
 */
export function browse(index, { family = null, bin = 'all', binFirst = false, byDesc = false } = {}) {
  let out = index;
  if (family) out = out.filter((e) => e.family === family);
  if (bin === 'with') out = out.filter((e) => hasBin(e.eff.bin));
  if (bin === 'without') out = out.filter((e) => !hasBin(e.eff.bin));
  const byCode = (a, b) => a.idLower.localeCompare(b.idLower, undefined, { numeric: true });
  out = [...out].sort((a, b) => {
    if (binFirst) {
      const d = Number(hasBin(b.eff.bin)) - Number(hasBin(a.eff.bin));
      if (d) return d;
    }
    return (byDesc ? naturalCompare(a.natural, b.natural) : 0) || byCode(a, b);
  });
  return out;
}

/** Family -> count, for the pills. */
export function familyCounts(index) {
  const out = {};
  for (const e of index) if (e.family) out[e.family] = (out[e.family] ?? 0) + 1;
  return out;
}

/** The "fix these in the ERP" list: every live correction, oldest first. */
export function fixList(overrides, partsById) {
  return Object.values(overrides ?? {})
    .filter(isActive)
    .map((o) => ({
      ...o,
      current: partsById?.get(o.partId)?.[o.field] ?? null,
      inExport: partsById ? partsById.has(o.partId) : null,
    }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** The fix list as CSV, for the person who works from a spreadsheet. */
export function fixListCsv(list) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Code', 'Field', 'ERP currently says', 'Should be', 'Reason', 'Status', 'Since', 'Exports survived'];
  const rows = list.map((o) => [o.partId, o.field === 'desc' ? 'Description' : 'Bin',
    o.current ?? o.baseline, o.value, o.reason, o.status, String(o.createdAt ?? '').slice(0, 10),
    o.importsPending ?? 0]);
  return [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
}

// ---------------------------------------------------------------------------
// THE WORKBOOK
//
// The old drafting sheet, regenerated: every part on one tab, then a tab per
// family, the ERP's column captions, corrections applied and explained.
// ---------------------------------------------------------------------------

/** The workbook's columns, in the old sheet's order, minus what is not kept. */
export const SHEET_COLUMNS = ['Inventory ID', 'Description', 'Type', 'Base Unit', 'Default Issue From', 'Source', 'Notes'];

/** A calendar date from LOCAL parts. toISOString is UTC and Brisbane loses a day. */
export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** What the old sheet was called, dated the way it was dated. */
export const workbookName = (d = new Date()) => {
  const [y, m, day] = localDate(d).split('-');
  return `Drafting Part Codes - ${day}-${m}-${y.slice(2)}.xlsx`;
};

/**
 * The list as sheets of rows — pure data, for whichever writer turns it into
 * a file. Descriptions and bins are the EFFECTIVE values, because the sheet is
 * for the people who use the parts, and the Notes column says where a value
 * is a correction and what the ERP has instead, because the sheet will be
 * read next to the ERP.
 *
 * @returns {Array<{name: string, rows: Array<Array<string|number>>, plain?: boolean}>}
 */
export function draftingSheets(parts, overrides = {}, { exportDate = null, now = new Date() } = {}) {
  const row = (p) => {
    const eff = effective(p, overrides);
    const notes = [];
    for (const [ov, label] of [[eff.descOv, 'Description'], [eff.binOv, 'Bin']]) {
      if (!ov) continue;
      notes.push(`${label} corrected here${ov.status === 'review' ? ' (needs review)' : ''} — `
        + `ERP says "${ov.observed ?? ov.baseline ?? ''}". ${ov.reason}`);
    }
    return [p.id, eff.desc, p.type ?? '', p.unit ?? '', eff.bin, p.source ?? '', notes.join(' | ')];
  };
  const sorted = [...(parts ?? [])].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const sheets = [{ name: 'All Parts', rows: [SHEET_COLUMNS, ...sorted.map(row)] }];
  for (const f of FAMILIES) {
    const fam = sorted.filter((p) => familyOf(p.id) === f);
    if (fam.length) sheets.push({ name: `${f} parts`, rows: [SHEET_COLUMNS, ...fam.map(row)] });
  }
  const live = Object.values(overrides ?? {}).filter(isActive).length;
  sheets.push({
    name: 'About',
    plain: true,
    rows: [
      ['ERP data exported', exportDate ? String(exportDate).slice(0, 10) : 'unknown'],
      ['Downloaded', localDate(now)],
      ['Parts', sorted.length],
      ['Corrections applied', live],
      ['Note', 'Descriptions and bins include corrections made on the parts page; the Notes column '
        + 'says which, and what the ERP has instead. Prices are not exported and are never stored.'],
    ],
  });
  return sheets;
}
