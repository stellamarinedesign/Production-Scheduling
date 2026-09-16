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
//   2. THREE FIELDS COME THROUGH THE DOOR: code, description, bin. The export
//      carries prices and a dozen other things; none of them is read, stored,
//      cached or sent anywhere. `PART_COLUMNS` is the allow-list.
//   3. SEARCH IS FOR DESCRIPTIONS PEOPLE HALF-REMEMBER. "m12 25 stainless" has
//      to find "M12 x 25mm SHCS 316 S/S". That is a tokeniser that knows what a
//      dimension looks like, plus a synonym table, plus a typo allowance — and
//      it runs in the browser over the whole list, because the list is small.
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
export const PART_COLUMNS = ['Inventory ID', 'Description', 'Default Issue From'];

/** The Parameters sheet's title on a genuine stock export. */
export const REQUIRED_TITLE = 'Stock Items';

/** How old the ERP data can be before the page says so. */
export const STALE_DAYS = 30;

/**
 * The families the filter pills offer, longest match wins. `ST` is split into
 * its sub-families because they are large and the workshop thinks of them
 * separately; the rest are the top-level prefixes.
 */
export const FAMILIES = ['SBL', 'SDC', 'SGD', 'SHC', 'SL', 'SRL', 'SS', 'STA', 'STC', 'STG', 'STL', 'ST', 'SWD'];

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
 * @returns {{parts: Array<{id, desc, bin}>, excluded: Object<string, number>}}
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
      parts.push({ id, desc: clean(r['Description']), bin: clean(r['Default Issue From']) });
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

/** What changed between two lists, by code. */
export function diffParts(prev, next) {
  const before = new Map((prev ?? []).map((p) => [p.id, p]));
  const after = new Map((next ?? []).map((p) => [p.id, p]));
  const added = [], removed = [], descChanged = [], binChanged = [];
  for (const [id, p] of after) {
    const was = before.get(id);
    if (!was) { added.push(id); continue; }
    if (was.desc !== p.desc) descChanged.push({ id, from: was.desc, to: p.desc });
    if (was.bin !== p.bin) binChanged.push({ id, from: was.bin, to: p.bin });
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added: added.sort(), removed: removed.sort(), descChanged, binChanged };
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
  ['shcs', 'socket head cap screw'],
  ['csk', 'countersunk'],
  ['aluminium', 'aluminum', 'alum'],
  ['nyloc', 'nylock'],
  ['sch', 'schd', 'schedule'],
  ['o-ring', 'oring', 'o ring'],
];

/**
 * Lowercase, and take apart the things a person types differently from the
 * way the ERP has them written.
 */
export function normalise(text) {
  let s = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  // A dimension separator becomes a space: 100mmx100mmx3mm, m10x 50, 10x50.
  s = s.replace(/(\d|mm|")\s*x\s*(?=\d)/g, '$1 ');
  // ...and the word-glued form: 1/2tubex1/2bsp, 3/8 tubex1/4 bspt.
  s = s.replace(/([a-z]{3,})x(?=\d)/g, '$1 ');
  // A number's mm is noise ("25mm" and "25" are the same ask). Metres are not:
  // "6m" stays, because "6" alone means something else.
  s = s.replace(/(\d)mm\b/g, '$1');
  // Grade glued to stainless: 316ss, 316s/s.
  s = s.replace(/(\d)(ss|s\/s)\b/g, '$1 $2');
  // A size glued to a word, either way round: 1/2tube, 1/2bsp, sch40, gen4.
  // Two letters or more after a digit, so 6m, 24v and 2.4m are left alone;
  // three or more before one, so m10, m12 and lg2 are.
  s = s.replace(/(\d)([a-z]{2,})\b/g, '$1 $2');
  s = s.replace(/\b([a-z]{3,})(\d)/g, '$1 $2');
  return s;
}

/** Tokens: words, numbers, fractions, decimals. Punctuation between them goes. */
export function tokenise(text) {
  return normalise(text)
    .split(/[\s,;()[\]{}]+/)
    .map((t) => t.replace(/^[^a-z0-9/]+|[^a-z0-9/]+$/g, ''))
    .filter(Boolean);
}

const isNumeric = (t) => /^[\d./]+$/.test(t);

/**
 * The token set a part is found by: its effective description, bin and code,
 * plus every synonym of anything in the description.
 */
function indexTokens(text) {
  const norm = normalise(text);
  const out = new Set(tokenise(text));
  for (const group of SYNONYMS) {
    if (group.some((m) => norm.includes(m))) {
      for (const m of group) for (const t of tokenise(m)) out.add(t);
    }
  }
  return out;
}

/**
 * Build once per list, search many times.
 * @param {Array<{id, desc, bin}>} parts
 * @param {Object} overrides
 */
export function buildIndex(parts, overrides = {}) {
  return (parts ?? []).map((p) => {
    const eff = effective(p, overrides);
    const primary = indexTokens(`${eff.desc} ${eff.bin}`);
    // The ERP's own wording, at a lower weight, so a corrected part is still
    // found by the words someone remembers from before it was corrected.
    const original = (eff.descOv || eff.binOv) ? indexTokens(`${p.desc} ${p.bin}`) : null;
    return {
      part: p, eff, family: familyOf(p.id),
      idLower: p.id.toLowerCase(),
      primary: [...primary], original: original ? [...original] : null,
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

/** Best score for one query token against one token set, or 0. */
function tokenScore(q, tokens) {
  let best = 0;
  const numeric = isNumeric(q);
  const allow = q.length >= 7 ? 2 : q.length >= 4 ? 1 : 0;
  for (const t of tokens) {
    if (t === q) return SCORE.exact;
    if (numeric) continue;                            // 25 must not find 250
    if (q.length >= 2 && t.startsWith(q)) { best = Math.max(best, SCORE.prefix); continue; }
    if (allow && !isNumeric(t) && editDistance(q, t, allow) <= allow) best = Math.max(best, SCORE.fuzzy);
  }
  return best;
}

/**
 * Search the index.
 *
 * Every query token must match (AND, any order). A single token that looks
 * like a code ranks code matches first. Ties go to the shorter description,
 * then the code, so the plainest part of a family surfaces before its
 * variants.
 *
 * @returns {{hits: Array<{entry, score}>, total: number}}
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

  const qTokens = tokenise(query);
  if (!qTokens.length) return { hits: [], total: 0 };

  const scored = [];
  for (const e of index) {
    let score = 0;
    let ok = true;
    let tokenTotal = 0;
    for (const q of qTokens) {
      let s = tokenScore(q, e.primary);
      if (!s && e.original) s = tokenScore(q, e.original) * 0.5;
      if (!s) {
        // A code token can still match the code itself, so "sdc0 bracket" works.
        if (e.idLower.includes(q)) s = SCORE.prefix;
        else { ok = false; break; }
      }
      tokenTotal += s;
    }
    if (!ok) continue;
    scored.push({ entry: e, score: score + tokenTotal });
  }
  // Ties go to the plainest part of a family, then to code order.
  scored.sort((a, b) => b.score - a.score
    || a.entry.descLen - b.entry.descLen
    || a.entry.idLower.localeCompare(b.entry.idLower, undefined, { numeric: true }));
  return { hits: scored.slice(0, limit), total: scored.length };
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
