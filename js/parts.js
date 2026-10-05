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
// ---------------------------------------------------------------------------

/**
 * Words that mean the same thing on a part label. If any member appears, the
 * part is indexed under all of them, so "stainless" finds "S/S" and "csk"
 * finds "Countersunk". One table, so it can be extended without reading the
 * tokeniser.
 */
export const SYNONYMS = [
  ['s/s', 'ss', 'stainless', 's/steel'],
  ['shcs', 'socket head cap screw', 'socket head'],
  ['csk', 'countersunk'],
  ['aluminium', 'aluminum', 'alum'],
  ['nyloc', 'nylock'],
  ['sch', 'schd', 'schedule'],
  ['o-ring', 'oring', 'o ring'],
  ['deg', 'degree', 'degrees'],
  ['dia', 'diam', 'diameter'],
];

/**
 * An inch, in every way the ERP writes one: 1", 1”, 1'', 1', 1in, 1in., 1inch,
 * 3/8", 1 1/2", 1.5", and 1 ¼” once the fraction is spelt out. Groups: whole,
 * numerator, denominator, decimal. Word-based units want a letter NOT to
 * follow, because "inlet" is not an inch; the marks need nothing after them.
 */
const INCH_UNIT = String.raw`(?:"|''|'|in\.?(?![a-z])|inch(?:es)?(?![a-z]))`;
const INCH_RE = new RegExp(
  String.raw`(?:(\d+)\s+)?(\d+)\s*/\s*(\d+)\s*${INCH_UNIT}|(\d+(?:\.\d+)?)\s*${INCH_UNIT}`, 'g');

export const MM_PER_INCH = 25.4;

/**
 * Inches as millimetres, to three places. That is precision, not tolerance:
 * enough to absorb float noise (1/2" is 12.700000000000001 in a computer),
 * not enough to make 25 and 25.4 the same size. They are not — the workshop
 * stocks both.
 */
export const mmOf = (inches) => String(Math.round(inches * MM_PER_INCH * 1000) / 1000);
const inchesOf = (whole, num, den, dec) =>
  dec !== undefined ? Number(dec) : (whole ? Number(whole) : 0) + Number(num) / Number(den);

/**
 * The first pass, shared by everything that reads a description or a query:
 * lowercase, one kind of space, and the ERP's typography turned into the
 * plain characters the rules below look for — curly quotes into straight
 * ones, × into x, ¼ into 1/4, ° into "deg".
 */
export function prep(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u00d7\u2715]/g, ' x ')
    .replace(/\u00b0/g, ' deg ')
    .replace(/[\u2013\u2014]/g, ' ')
    .replace(/\u00bc/g, ' 1/4').replace(/\u00bd/g, ' 1/2').replace(/\u00be/g, ' 3/4')
    .replace(/\u215b/g, ' 1/8').replace(/\u215c/g, ' 3/8').replace(/\u215d/g, ' 5/8').replace(/\u215e/g, ' 7/8')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lowercase, and take apart the things a person types differently from the
 * way the ERP has them written.
 */
export function normalise(text) {
  let s = prep(text);
  // A dimension separator becomes a space: 100mmx100mmx3mm, m10x 50, 10x50,
  // 1"(25.4mm) x 1.6mm.
  s = s.replace(/(\d|mm|"|\))\s*x\s*(?=\d)/g, '$1 ');
  // ...and the word-glued form: 1/2tubex1/2bsp, 3/8 tubex1/4 bspt.
  s = s.replace(/([a-z]{3,})x(?=\d)/g, '$1 ');
  // Units the ERP spells several ways, made one way, so a search in any of
  // them finds all of them. Volts: 24v, 24vdc, 24 volt -> 24v. Metres: 3mtr,
  // 10 metres, 30m -> 3m, 10m, 30m. Cable: 20mmsq, 32mm sq -> 20 sqmm. And
  // dc24v, which is one word to the ERP and two to everyone else.
  s = s.replace(/(\d)\s*(?:vdc|vac|volts?)\b/g, '$1v');
  s = s.replace(/(\d)\s*(?:mtrs?|metres?|meters?)\b/g, '$1m');
  s = s.replace(/(\d)\s*mm\s*(?:sq\b|\u00b2)/g, '$1 sqmm');
  s = s.replace(/\b(ac|dc)(?=\d)/g, '$1 ');
  // A number's mm is noise ("25mm", "25 mm" and "25" are the same ask).
  // Metres are not: "6m" stays, because "6" alone means something else.
  s = s.replace(/(\d)\s*mm\b/g, '$1');
  // Grade glued to stainless: 316ss, 316s/s.
  s = s.replace(/(\d)(ss|s\/s)\b/g, '$1 $2');
  // A size glued to a word, either way round: 1/2tube, 1/2bsp, sch40, gen4.
  // Two letters or more after a digit, so 6m, 24v and 2.4m are left alone;
  // three or more before one, so m10, m12 and lg2 are.
  s = s.replace(/(\d)([a-z]{2,})\b/g, '$1 $2');
  s = s.replace(/\b([a-z]{3,})(\d)/g, '$1 $2');
  // 25.40 is 25.4 and 1.00 is 1: zeros after the point are noise, and the
  // ERP writes both.
  s = s.replace(/(\d)\.0+\b/g, '$1').replace(/(\.\d*[1-9])0+\b/g, '$1');
  return s;
}

/**
 * Tokens: words, numbers, fractions, decimals. Punctuation between them goes,
 * and an inch mark is a separator too — the ERP writes 21''Membranes with no
 * space, and the membranes are not part of the twenty-one.
 */
export function tokenise(text) {
  return normalise(text)
    .split(/[\s,;()[\]{}"']+/)
    .map((t) => t.replace(/^[^a-z0-9/]+|[^a-z0-9/]+$/g, ''))
    .filter(Boolean);
}

const isNumeric = (t) => /^[\d./]+$/.test(t);
const isFraction = (t) => /^\d+\/\d+$/.test(t);
const fractionMm = (t) => { const [n, d] = t.split('/'); return mmOf(Number(n) / Number(d)); };

/**
 * The query as terms, each a list of alternatives, any one of which counts.
 *
 * A measurement in inches becomes its millimetre value, so 1", 1 inch and
 * 25.4mm are the same ask — the index holds the millimetre value for every
 * inch it was written in (see `indexText`), and mm are already bare numbers
 * after `normalise`. A fraction keeps its written form beside the value,
 * marked or not: 3/8 on its own is an inch size in this workshop, and the
 * description may say "3/8 tube" or "9.525mm" or "3/8"" and mean the same
 * thing. A decimal with the mark does not keep its written form, because 1.5
 * on its own is a thread pitch as often as a size.
 *
 * @returns {string[][]}
 */
export function queryTerms(query) {
  const withMm = prep(query).replace(INCH_RE, (m, whole, num, den, dec) => {
    const val = mmOf(inchesOf(whole, num, den, dec));
    return num !== undefined && !whole ? ` ${num}/${den}|${val} ` : ` ${val} `;
  });
  return tokenise(withMm).map((t) => {
    const alts = t.split('|').filter(Boolean);
    if (alts.length === 1 && isFraction(alts[0])) alts.push(fractionMm(alts[0]));
    return alts;
  });
}

/**
 * A description as the search sees it: its tokens IN ORDER, each a short list
 * of alternatives (an inch measurement is itself and its millimetres), plus
 * the synonyms of anything in it, which have no position.
 *
 * ORDER AND REPETITION ARE KEPT, because a size is a sequence. "50 x 50 x 3"
 * is two fifties and a three, in that order. The first version of this kept
 * a bare set of tokens: the second fifty matched the same token as the first,
 * so "50 x 50 x 3" and "50 x 3" were the same search, and a pump that happened
 * to be 3 phase and 50Hz ranked level with the box section being looked for.
 *
 * Synonyms match WHOLE WORDS. "Brass" contains "ss" and is not stainless;
 * the first version of this used a substring test and indexed every brass
 * and glass part under "stainless".
 */
function indexText(text) {
  const p = prep(text);
  // Each inch measurement carries its millimetres with it, attached to the
  // last number it was written with, so the value stays in its place in the
  // sequence: 1 1/2" is the tokens "1" and "1/2|38.1".
  const marked = p.replace(INCH_RE, (m, whole, num, den, dec) => {
    const written = dec !== undefined ? dec : `${whole ? `${whole} ` : ''}${num}/${den}`;
    return ` ${written}|${mmOf(inchesOf(whole, num, den, dec))} `;
  });
  const seq = tokenise(marked).map((t) => t.split('|').filter(Boolean));
  const have = new Set(seq.flat());
  const joined = ` ${seq.map((alts) => alts[0]).join(' ')} `;
  const extra = new Set();
  for (const group of SYN_TOKENS) {
    const present = group.some((mt) => (mt.length === 1 ? have.has(mt[0]) : joined.includes(` ${mt.join(' ')} `)));
    if (present) for (const mt of group) for (const t of mt) if (!have.has(t)) extra.add(t);
  }
  return { seq, extra, have };
}
/** Each synonym as the tokens it would be indexed under. Built once. */
const SYN_TOKENS = SYNONYMS.map((group) => group.map((m) => tokenise(m)));

/**
 * Build once per list, search many times.
 *
 * Each entry holds its description as `seq`: the tokens in order, each with
 * its alternatives, a position and a weight. The ERP's own wording, where a
 * correction has replaced it, is appended at half weight and out of reach of
 * the adjacency bonus, so a corrected part is still found by the words
 * someone remembers from before - but only the words the correction took
 * away, or a part corrected from 5mm to 3mm would count its fifties twice.
 *
 * @param {Array<{id, desc, bin}>} parts
 * @param {Object} overrides
 */
export function buildIndex(parts, overrides = {}) {
  return (parts ?? []).map((p) => {
    const eff = effective(p, overrides);
    const main = indexText(`${eff.desc} ${eff.bin}`);
    const seq = main.seq.map((alts, i) => ({ alts, pos: i, w: 1 }));
    const extra = [...main.extra].map((t) => ({ t, w: 1 }));
    if (eff.descOv || eff.binOv) {
      const orig = indexText(`${p.desc} ${p.bin}`);
      let pos = main.seq.length + 1;
      for (const alts of orig.seq) {
        if (alts.some((a) => main.have.has(a))) continue;
        seq.push({ alts, pos, w: 0.5 });
        pos += 2;                                   // never next to anything
      }
      for (const t of orig.extra) if (!main.extra.has(t) && !main.have.has(t)) extra.push({ t, w: 0.5 });
    }
    return {
      part: p, eff, family: familyOf(p.id),
      idLower: p.id.toLowerCase(),
      seq, extra,
      descLen: eff.desc.length,
    };
  });
}

/** Levenshtein with a ceiling — bails as soon as it cannot come in under it. */
export function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const SCORE = { exact: 10, prefix: 6, fuzzy: 3 };

/** One query word against one indexed token: exact, prefix, a typo, or 0. */
function matchScore(q, t) {
  if (t === q) return SCORE.exact;
  if (isNumeric(q)) return 0;                         // 25 must not find 250
  if (q.length >= 2 && t.startsWith(q)) return SCORE.prefix;
  const allow = q.length >= 7 ? 2 : q.length >= 4 ? 1 : 0;
  if (allow && !isNumeric(t) && editDistance(q, t, allow) <= allow) return SCORE.fuzzy;
  return 0;
}

/** A term is alternatives and so is a token; the best pairing is the score. */
function termScore(term, alts) {
  let best = 0;
  for (const q of term) for (const t of alts) best = Math.max(best, matchScore(q, t));
  return best;
}

// What the order of a size is worth. A term matched on the token straight
// after the previous term's is the query read off the description. One matched
// further along is the same numbers in the same order with something between:
// "50 x 3" against a 50 x 25 x 3. One matched just BEFORE is the pair swapped,
// which is worth least - 3" 50mm is not a fifty by three.
const NEXT_TO = 4;
const IN_ORDER = 2;
const SWAPPED = 1;
// A term with nothing left to match but a token an earlier term already took.
// It still counts - the query is not thrown out - but as a poor answer, and
// `search` drops such answers altogether when a proper one exists.
const REUSED = 0.3;
// Positions tried per term. A description rarely has one word four times.
const BRANCH = 4;

const adjacency = (prev, pos) => {
  if (prev === null) return 0;
  if (pos === prev + 1) return NEXT_TO;
  if (pos > prev) return IN_ORDER;
  return pos === prev - 1 ? SWAPPED : 0;
};

/**
 * Score one part against the query, or null if a term matches nothing.
 *
 * Every term needs a token OF ITS OWN: two fifties in the query want two in
 * the description. Terms are placed in the order they were typed, each on a
 * token no earlier term has taken, trying the few placements there are and
 * keeping the one that reuses least and then scores most.
 *
 * @returns {{score: number, reused: number}|null}
 */
function scoreEntry(terms, dupes, e) {
  const cands = terms.map((term) => {
    const at = [];
    for (let i = 0; i < e.seq.length; i++) {
      const s = termScore(term, e.seq[i].alts) * e.seq[i].w;
      if (s) at.push({ i, s });
    }
    // No position: a synonym of something in the description, or the code
    // itself, so "sdc0 bracket" still works.
    let loose = 0;
    for (const x of e.extra) loose = Math.max(loose, termScore(term, [x.t]) * x.w);
    if (!loose && term.some((q) => e.idLower.includes(q))) loose = SCORE.prefix;
    return { at, loose };
  });
  if (cands.some((c) => !c.at.length && !c.loose)) return null;

  const place = (k, used, prev) => {
    if (k === cands.length) return { score: 0, reused: 0 };
    const { at, loose } = cands[k];
    const free = at.filter((c) => !used.has(c.i));
    let options;
    if (free.length) {
      options = free
        .map((c) => ({ i: c.i, s: c.s + adjacency(prev, e.seq[c.i].pos), reused: 0 }))
        .sort((a, b) => b.s - a.s)
        .slice(0, BRANCH);
    } else if (loose && !dupes[k]) {
      options = [{ i: -1, s: loose, reused: 0 }];
    } else {
      // The second fifty, and only one in the description.
      const best = at.length ? Math.max(...at.map((c) => c.s)) : loose;
      options = [{ i: -1, s: best * REUSED, reused: 1 }];
    }
    let best = null;
    for (const o of options) {
      const rest = place(k + 1, o.i >= 0 ? new Set(used).add(o.i) : used, o.i >= 0 ? e.seq[o.i].pos : prev);
      const reused = o.reused + rest.reused;
      const score = o.s + rest.score;
      if (!best || reused < best.reused || (reused === best.reused && score > best.score)) best = { score, reused };
    }
    return best;
  };
  return place(0, new Set(), null);
}

/**
 * Search the index.
 *
 * Every query term must match, each on a token of its own, and sizes typed
 * together are worth more found together and in that order. A single word
 * that looks like a code ranks code matches first. Ties go to the shorter
 * description, then the code, so the plainest part of a family surfaces
 * before its variants.
 *
 * `relaxed` is true when NO part gave every term a token of its own - two
 * fifties asked for, one found - and the list is the nearest there is rather
 * than a real answer. When some part does, the near misses are left out.
 *
 * @returns {{hits: Array<{entry, score}>, total: number, relaxed: boolean}}
 */
export function search(index, query, { limit = 50 } = {}) {
  const raw = clean(query).toLowerCase();
  if (!raw) return { hits: [], total: 0 };

  // A CODE IS MATCHED AS A CODE, before the tokeniser gets near it. The
  // tokeniser takes "sch40" apart into "sch" and "40" because that is what a
  // description needs - and would do the same to "szz0123", which is not a
  // description. One word, starting with s, with a digit or bracket in it: try
  // it against the codes first, exact then prefix then anywhere, in code order.
  // If nothing has that code, it was a word after all and the search below
  // gets it.
  const codeLike = !raw.includes(' ') && /^s[a-z]/.test(raw) && /[0-9(]/.test(raw);
  if (codeLike) {
    const byCode = [];
    for (const e of index) {
      if (e.idLower === raw) byCode.push({ entry: e, score: 3 });
      else if (e.idLower.startsWith(raw)) byCode.push({ entry: e, score: 2 });
      else if (e.idLower.includes(raw)) byCode.push({ entry: e, score: 1 });
    }
    if (byCode.length) {
      byCode.sort((a, b) => b.score - a.score
        || a.entry.idLower.localeCompare(b.entry.idLower, undefined, { numeric: true }));
      return { hits: byCode.slice(0, limit), total: byCode.length };
    }
  }

  const terms = queryTerms(query);
  if (!terms.length) return { hits: [], total: 0, relaxed: false };
  // Which terms repeat an earlier one. A repeat has to find a second token;
  // a synonym or the code cannot stand in for it.
  const keys = terms.map((t) => t.join('|'));
  const dupes = keys.map((k, i) => keys.indexOf(k) < i);

  const all = [];
  for (const e of index) {
    const r = scoreEntry(terms, dupes, e);
    if (r) all.push({ entry: e, score: r.score, full: r.reused === 0 });
  }
  const anyFull = all.some((h) => h.full);
  const scored = anyFull ? all.filter((h) => h.full) : all;
  // Ties go to the plainest part of a family, then to code order.
  scored.sort((a, b) => b.score - a.score
    || a.entry.descLen - b.entry.descLen
    || a.entry.idLower.localeCompare(b.entry.idLower, undefined, { numeric: true }));
  return { hits: scored.slice(0, limit), total: scored.length, relaxed: !anyFull && scored.length > 0 };
}

/**
 * A list with no query: filtered and ordered rather than searched.
 * @param {{family?: string|null, bin?: 'all'|'with'|'without', binFirst?: boolean}} f
 */
export function browse(index, { family = null, bin = 'all', binFirst = false } = {}) {
  let out = index;
  if (family) out = out.filter((e) => e.family === family);
  if (bin === 'with') out = out.filter((e) => hasBin(e.eff.bin));
  if (bin === 'without') out = out.filter((e) => !hasBin(e.eff.bin));
  out = [...out].sort((a, b) => {
    if (binFirst) {
      const d = Number(hasBin(b.eff.bin)) - Number(hasBin(a.eff.bin));
      if (d) return d;
    }
    return a.idLower.localeCompare(b.idLower, undefined, { numeric: true });
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
