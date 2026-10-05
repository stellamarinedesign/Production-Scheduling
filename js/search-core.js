// search-core.js - one search, used by the parts page here and by the material
// ordering app. Pure functions, no DOM, no store, no dependencies.
//
// THE BODY OF THIS FILE IS SHARED VERBATIM between the two apps. Everything
// between the two "SHARED BODY" markers must stay identical in both; only the
// last line differs (an ES-module export here, a window global there). A fix
// made in one is a fix owed to the other.
//
// What it does, in the order it does it:
//
//   1. NORMALISE. A description and a query go through the same pass, so they
//      come out the same however they were typed: 1", 1 inch and 25.4mm are the
//      token "25.4"; 100mmX100mm is "100 100"; 24VDC and 24 volt are "24v";
//      Schd 40 and Schedule 40 are "sch40".
//   2. A NUMBER IS A SIZE unless something says otherwise. Bare numbers are
//      millimetres. A number against a non-length unit is a QUANTITY and is
//      kept with its unit as one token (5kg, 80grit, 100lph), so a size does
//      not find a weight; a bare number still finds a quantity, but weakly.
//      Metres are never found by a bare number: 6 is not 6m.
//   3. EVERY TERM MUST MATCH, each on a token of its own. Two fifties in the
//      query want two in the description.
//   4. ORDER COUNTS. Terms found side by side in the order typed score most.
//   5. NUMBERS ARE EXACT. 25 does not find 250, nor 25.4. Words may be typed
//      short (a prefix), found inside a longer word, or mistyped by a letter or
//      two; anything with a digit in it is never guessed at.
//   6. IF NOTHING HAS ALL OF IT, the parts that have most of it are offered,
//      and the caller is told so (`relaxed`) and can say so.
//
// NO REAL CODES, CUSTOMER NAMES OR PART NAMES IN THIS FILE. It ships to anyone
// who opens either app. Examples use made-up sizes and words.

// ==== SHARED BODY - START ===================================================

const MM_PER_INCH = 25.4;

/**
 * Inches as millimetres, to three places. That is precision, not tolerance:
 * enough to absorb float noise (1/2" is 12.700000000000001 in a computer), not
 * enough to make 25 and 25.4 the same size. Both are stocked.
 */
const mmOf = (inches) => String(Math.round(inches * MM_PER_INCH * 1000) / 1000);

/**
 * Words that mean the same thing on a label. If any member is in a
 * description, the description is found by all of them. Whole words only -
 * "brass" contains "ss" and is not stainless. Each app passes its own list;
 * this is the part of it both share.
 */
const DEFAULT_SYNONYMS = [
  ['s/s', 'ss', 'stainless', 's/steel'],
  ['aluminium', 'aluminum', 'alum', 'ali'],
  ['shcs', 'socket head cap screw', 'socket head'],
  ['csk', 'countersunk'],
  ['nyloc', 'nylock'],
  ['o-ring', 'oring', 'o ring'],
  ['dia', 'diam', 'diameter'],
];

// Vulgar fractions, as suppliers type them. Each becomes " n/d", the space so
// that a glyph straight after a digit reads as a mixed number, not 11/2.
const GLYPHS = {
  '\u00bd': '1/2', '\u00bc': '1/4', '\u00be': '3/4', '\u215b': '1/8', '\u215c': '3/8', '\u215d': '5/8', '\u215e': '7/8',
  '\u2153': '1/3', '\u2154': '2/3', '\u2155': '1/5', '\u2156': '2/5', '\u2157': '3/5', '\u2158': '4/5', '\u2159': '1/6', '\u215a': '5/6',
};
const GLYPH_RE = /[\u00bc-\u00be\u2153-\u215e]/g;

// An inch, in every way it gets written: 1", 1'', 1', 1in, 1in., 1inch, 1.5",
// 3/8", 1 1/2". A FRACTION IS INCHES WITH OR WITHOUT THE MARK - 3/8 on its own
// is an inch size in a workshop - but a whole or decimal number needs one,
// because a bare number is millimetres. Groups: whole, numerator, denominator,
// the mark on a fraction, decimal. The word units want a letter NOT to follow
// ("inlet" is not an inch). The whole part of a mixed number must start at a
// word boundary, or the 40 of "sch40 1/2" is taken for forty and a half
// inches. No lookbehind anywhere in this file: older iPad Safari refuses to
// parse it.
const INCH_UNIT = '(?:"|\'\'|\'|in\\.?(?![a-z])|inch(?:es)?(?![a-z]))';
const INCH_RE = new RegExp(
  '(?:\\b(\\d+)\\s+)?(\\d+)\\s*/\\s*(\\d+)\\s*(' + INCH_UNIT + ')?|(\\d+(?:\\.\\d+)?)\\s*' + INCH_UNIT, 'g');
const inchesOf = (whole, num, den, dec) =>
  (dec !== undefined ? Number(dec) : (whole ? Number(whole) : 0) + Number(num) / Number(den));
// Without a mark, n/d is only an inch fraction if it looks like one: 450/550
// is two ratings and 68/72 is two boats, not most of an inch.
const INCH_DENOMINATORS = { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 8: 1, 16: 1, 32: 1, 64: 1 };
const plausibleFraction = (num, den) => INCH_DENOMINATORS[Number(den)] === 1 && Number(num) < Number(den);

// Units that make a number a quantity rather than a size, and the one way each
// is written afterwards. These count whether or not there is a space: 5 kg and
// 5kg are both "5kg".
const QTY = {
  kg: 'kg', ml: 'ml', lph: 'lph', lpm: 'lpm', hz: 'hz', hp: 'hp', kw: 'kw', psi: 'psi', mpa: 'mpa', kpa: 'kpa',
  grit: 'grit', micron: 'micron', microns: 'micron', rpm: 'rpm', gauge: 'gauge', swg: 'swg',
  deg: 'deg', degree: 'deg', degrees: 'deg', amp: 'a', amps: 'a', watt: 'w', watts: 'w',
  litre: 'l', litres: 'l', liter: 'l', liters: 'l', ltr: 'l', ltrs: 'l', lt: 'l',
  vdc: 'v', vac: 'v', volt: 'v', volts: 'v',
  mtr: 'm', mtrs: 'm', metre: 'm', metres: 'm', meter: 'm', meters: 'm',
};
const QTY_RE = new RegExp(
  '(\\d)\\s*(' + Object.keys(QTY).sort((a, b) => b.length - a.length).join('|') + ')\\b', 'g');
// ...and units that only count when written hard against the number, because
// with a space they are ordinary words: "100bar" is a pressure, "20 bar" may
// be twenty millimetres of bar stock; "10pcs" is a count, "3 pc" is 3mm
// polycarbonate. Single letters (8l, 6m, 24v, 10a, 8g) are the same and need
// no rule: they are only ever a unit when glued, and glued is how they stay.
const GLUED_ONLY = 'bar|nm|cc|ah|pcs|pct|sqmm';
const SPLIT_DIGIT_WORD_RE = new RegExp('(\\d)(?!(?:' + GLUED_ONLY + ')\\b)([a-z]{2,})\\b', 'g');

const NUMBER_RE = /^\d+(?:\.\d+)?$/;            // 25, 25.4
const QUANTITY_RE = /^(\d+(?:\.\d+)?)([a-z]+)$/; // 5kg, 6m, 100lph
const LETTERS_RE = /^[a-z]+$/;
const DIGIT_FIRST_RE = /^\d/;

/** Levenshtein with a ceiling - bails as soon as it cannot come in under it. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = [];
  for (let j = 0; j <= b.length; j++) prev.push(j);
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

// What a match is worth.
const SCORE = { exact: 10, prefix: 6, quantity: 5, inside: 3, typo: 3 };
// What the order of a size is worth. A term matched on the token straight
// after the previous term's is the query read off the description. One matched
// further along is the same numbers in the same order with something between:
// "50 x 3" against a 50 x 25 x 3. One matched just BEFORE is the pair swapped,
// which is worth least.
const NEXT_TO = 4;
const IN_ORDER = 2;
const SWAPPED = 1;
// A term with nothing left to match but a token an earlier term already took.
const REUSED = 0.3;
// Positions tried per term. A description rarely has one word four times.
const BRANCH = 4;

/** Compare two natural keys: numbers as numbers, everything else as text. */
function naturalCompare(ka, kb) {
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const xa = ka[i];
    const xb = kb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const na = parseFloat(xa);
    const nb = parseFloat(xb);
    if (!isNaN(na) && !isNaN(nb) && DIGIT_FIRST_RE.test(xa) && DIGIT_FIRST_RE.test(xb)) {
      if (na !== nb) return na - nb;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Make a search.
 *
 * @param {Object}  [options]
 * @param {Array<Array<string>>} [options.synonyms]  groups of equivalent words
 * @param {boolean} [options.inches=true]  read inches as millimetres. Off, an
 *   inch mark is simply dropped and 1" is the number 1.
 * @param {boolean} [options.typos=true]   let a word be a letter or two out
 */
function createSearch(options) {
  const opts = Object.assign({ synonyms: DEFAULT_SYNONYMS, inches: true, typos: true }, options || {});

  /**
   * The first pass: lowercase, one kind of space, and typography turned into
   * the plain characters the rules below look for.
   */
  function prep(text) {
    return String(text === null || text === undefined ? '' : text)
      .toLowerCase()
      .replace(GLYPH_RE, (g) => ' ' + GLYPHS[g])
      .replace(/[\u201c\u201d\u2033]/g, '"')
      .replace(/[\u2018\u2019\u2032]/g, "'")
      .replace(/[\u00d7\u2715]/g, ' x ')
      .replace(/\u00b0/g, ' deg ')
      .replace(/[\u2013\u2014]/g, ' ')
      .replace(/\u00b2/g, ' sq')
      .replace(/(\d)\s*%/g, '$1pct ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Everything a person types differently from the way the catalogue has it
   * written, made one way. The same pass for a description and for a query.
   */
  function normalise(text) {
    let s = prep(text);
    // 25.40 is 25.4 and 1.00 is 1: zeros after the point are noise.
    s = s.replace(/(\d)\.0+(?![\d.])/g, '$1').replace(/(\.\d*[1-9])0+(?!\d)/g, '$1');
    // Pipe schedules are not sizes. One token, however spelt, before anything
    // below can read the number as millimetres.
    s = s.replace(/\bsch(?:d|ed|edule)?\.?\s*(\d+)/g, ' sch$1 ').replace(/\bsch(?:d|ed|edule)\b/g, 'sch');
    // Inches become millimetres - or, with that turned off, lose the mark.
    s = opts.inches
      ? s.replace(INCH_RE, (m, whole, num, den, mark, dec) => (
        num !== undefined && !mark && !plausibleFraction(num, den)
          ? m
          : ' ' + mmOf(inchesOf(whole, num, den, dec)) + ' '))
      : s.replace(/(\d)\s*(?:"|'')/g, '$1 ');
    // A dimension separator is a space: 100mmx100mmx3mm, m10x 50, 25 x25 x3.
    s = s.replace(/(\d|mm|\))\s*x\s*(?=\d)/g, '$1 ');
    // ...and the word-glued form: 1/2tubex1/2bsp.
    s = s.replace(/([a-z]{3,})x\s*(?=\d)/g, '$1 ');
    // Grade glued to stainless (316ss), and dc24v, one word to a catalogue and
    // two to everyone else.
    s = s.replace(/(\d)(ss|s\/s)\b/g, '$1 $2');
    s = s.replace(/\b(ac|dc)(?=\d)/g, '$1 ');
    // A size glued to a word, either way round: 12tube, gen4. Two letters or
    // more after a digit, so 6m, 24v and 8l are left alone; three or more
    // before one, so m10, t5 and lg2 are. Schedules are already one token.
    s = s.replace(SPLIT_DIGIT_WORD_RE, '$1 $2');
    s = s.replace(/\b(?!sch\d)([a-z]{3,})(\d)/g, '$1 $2');
    // A number with a unit that is not a length is a quantity, kept with its
    // unit. BEFORE the millimetres go: "100mm gauge" is a hundred-millimetre
    // gauge, and with the mm already stripped it would read as "100 gauge".
    s = s.replace(QTY_RE, (m, d, unit) => d + QTY[unit]);
    // Millimetres are the default, so the unit is noise: 25mm is 25. Square
    // millimetres are not a length.
    s = s.replace(/(\d)\s*mm\s*sq\b/g, '$1sqmm');
    s = s.replace(/(\d)\s*mm\b/g, '$1');
    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * Tokens: words, numbers and quantities. Punctuation between them goes; a
   * hyphen or a slash separates (6061-t6, 450/550) unless the slash sits
   * between two single letters, which is a word (s/s, m/f), or it is a
   * fraction - which only reaches here with inches switched off, and is then
   * one thing as written rather than a one and a two.
   */
  function tokenise(text) {
    const out = [];
    const rough = normalise(text).split(/[\s,;:()[\]{}"'+=#-]+/);
    for (let i = 0; i < rough.length; i++) {
      const piece = rough[i].replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
      if (!piece) continue;
      const frac = /^(\d+)\/(\d+)$/.exec(piece);
      if (piece.indexOf('/') < 0 || /^[a-z]\/[a-z]$/.test(piece) || (frac && plausibleFraction(frac[1], frac[2]))) {
        out.push(piece);
        continue;
      }
      const parts = piece.split('/');
      for (let j = 0; j < parts.length; j++) if (parts[j]) out.push(parts[j]);
    }
    return out;
  }

  // Each synonym as the tokens it is indexed under. Built once.
  const synTokens = opts.synonyms.map((group) => group.map((m) => tokenise(m)));

  /**
   * A sort key: the description in its normalised form, split into numbers
   * and the text between them, so 8mm comes before 10mm and an inch size
   * falls where its millimetres put it. See `naturalCompare`.
   */
  function naturalKey(text) {
    return normalise(text).replace(/^[^a-z0-9]+/, '').match(/\d+\.?\d*|\D+/g) || [];
  }

  /**
   * One thing to be searched for.
   *
   * @param {Array<{text: string, weight?: number}>} fields  The first is the
   *   description: its tokens keep their order, which is what the ranking
   *   reads. Any others are extra ways to find it - a category, an older
   *   wording - at their own weight, with only the tokens the first lacks and
   *   never next to anything.
   * @param {string} [code]  matched as a code, and by fragments of it
   */
  function entry(fields, code) {
    const seq = [];
    const extra = [];
    const have = {};
    const haveExtra = {};
    let pos = 0;
    for (let f = 0; f < fields.length; f++) {
      const field = fields[f];
      if (!field || !field.text) continue;
      const w = field.weight === undefined ? 1 : field.weight;
      const toks = tokenise(field.text);
      const mine = {};
      if (f === 0) {
        for (let i = 0; i < toks.length; i++) { seq.push({ t: toks[i], pos: pos++, w }); have[toks[i]] = true; }
      } else {
        pos += 1;
        for (let i = 0; i < toks.length; i++) {
          if (have[toks[i]]) continue;
          seq.push({ t: toks[i], pos, w });
          pos += 2;
        }
      }
      for (let i = 0; i < toks.length; i++) mine[toks[i]] = true;
      const joined = ' ' + toks.join(' ') + ' ';
      for (let g = 0; g < synTokens.length; g++) {
        const group = synTokens[g];
        let present = false;
        for (let m = 0; m < group.length && !present; m++) {
          present = group[m].length === 1 ? mine[group[m][0]] === true : joined.indexOf(' ' + group[m].join(' ') + ' ') >= 0;
        }
        if (!present) continue;
        for (let m = 0; m < group.length; m++) {
          for (let k = 0; k < group[m].length; k++) {
            const t = group[m][k];
            if (have[t] || mine[t] || haveExtra[t]) continue;
            extra.push({ t, w });
            haveExtra[t] = true;
          }
        }
      }
    }
    return {
      seq, extra,
      code: String(code === null || code === undefined ? '' : code).toLowerCase(),
      natural: naturalKey(fields[0] && fields[0].text ? fields[0].text : ''),
    };
  }

  /** One query term against one indexed token. */
  function matchScore(q, t) {
    if (t === q) return SCORE.exact;
    if (NUMBER_RE.test(q)) {
      // 25 must not find 250. It may find a quantity of 25 - weakly - but not
      // metres, where the same digits are a thousand times the size.
      const m = QUANTITY_RE.exec(t);
      return m && m[1] === q && m[2] !== 'm' ? SCORE.quantity : 0;
    }
    if (DIGIT_FIRST_RE.test(q)) return 0;             // 24v, 6m, 5kg: exact or nothing
    if (q.length >= 2 && t.indexOf(q) === 0) return SCORE.prefix;
    if (!LETTERS_RE.test(q)) return 0;                // m10, sch40: never guessed at
    if (q.length >= 3 && t.indexOf(q) > 0) return SCORE.inside;
    if (opts.typos && LETTERS_RE.test(t)) {
      const allow = q.length >= 7 ? 2 : q.length >= 4 ? 1 : 0;
      if (allow && editDistance(q, t, allow) <= allow) return SCORE.typo;
    }
    return 0;
  }

  const adjacency = (prev, pos) => {
    if (prev === null) return 0;
    if (pos === prev + 1) return NEXT_TO;
    if (pos > prev) return IN_ORDER;
    return pos === prev - 1 ? SWAPPED : 0;
  };

  /**
   * Score one entry against the terms.
   *
   * Terms are placed in the order typed, each on a token no earlier term has
   * taken, trying the few placements there are and keeping the one that falls
   * short least and then scores most.
   *
   * @returns {{score, missed, reused}|null}  null when nothing matched at all
   */
  function scoreEntry(terms, dupes, e) {
    const cands = [];
    let matchable = 0;
    for (let k = 0; k < terms.length; k++) {
      const q = terms[k];
      const at = [];
      for (let i = 0; i < e.seq.length; i++) {
        const s = matchScore(q, e.seq[i].t) * e.seq[i].w;
        if (s) at.push({ i, s });
      }
      // No position: a synonym of something in the description, or a piece of
      // the code. A short number is not looked for inside codes - every code
      // has a 5 in it somewhere.
      let loose = 0;
      for (let x = 0; x < e.extra.length; x++) loose = Math.max(loose, matchScore(q, e.extra[x].t) * e.extra[x].w);
      if (!loose && e.code && e.code.indexOf(q) >= 0 && !(NUMBER_RE.test(q) && q.length < 3)) loose = SCORE.prefix;
      if (at.length || loose) matchable++;
      cands.push({ at, loose });
    }
    if (!matchable) return null;

    const place = (k, used, prev) => {
      if (k === cands.length) return { score: 0, missed: 0, reused: 0 };
      const at = cands[k].at;
      const loose = cands[k].loose;
      const free = at.filter((c) => !used[c.i]);
      let options;
      if (free.length) {
        options = free
          .map((c) => ({ i: c.i, s: c.s + adjacency(prev, e.seq[c.i].pos), missed: 0, reused: 0 }))
          .sort((a, b) => b.s - a.s)
          .slice(0, BRANCH);
      } else if (loose && !dupes[k]) {
        options = [{ i: -1, s: loose, missed: 0, reused: 0 }];
      } else if (at.length || loose) {
        // The second fifty, and only one in the description.
        let best = loose;
        for (let c = 0; c < at.length; c++) best = Math.max(best, at[c].s);
        options = [{ i: -1, s: best * REUSED, missed: 0, reused: 1 }];
      } else {
        options = [{ i: -1, s: 0, missed: 1, reused: 0 }];
      }
      let best = null;
      for (let o = 0; o < options.length; o++) {
        const opt = options[o];
        let nextUsed = used;
        if (opt.i >= 0) { nextUsed = Object.assign({}, used); nextUsed[opt.i] = true; }
        const rest = place(k + 1, nextUsed, opt.i >= 0 ? e.seq[opt.i].pos : prev);
        const total = { score: opt.s + rest.score, missed: opt.missed + rest.missed, reused: opt.reused + rest.reused };
        const shortBest = best ? best.missed + best.reused : Infinity;
        const shortThis = total.missed + total.reused;
        if (!best || shortThis < shortBest || (shortThis === shortBest && total.score > best.score)) best = total;
      }
      return best;
    };
    return place(0, {}, null);
  }

  /**
   * Search.
   *
   * @param {Array} entries  objects made by `entry` (anything else on them is
   *   the caller's and comes back untouched)
   * @param {string} query
   * @param {Object} [o]
   * @param {number} [o.limit=50]
   * @param {(raw: string) => boolean} [o.isCode]  does this query look like a
   *   code? If so codes are tried first - exact, then prefix, then anywhere -
   *   and only if none has it is it searched as text.
   * @param {(a, b) => number} [o.tieBreak]  for equal scores; natural order of
   *   the description by default
   * @returns {{hits: Array<{entry, score}>, total: number, relaxed: boolean}}
   *   `relaxed` is true when NO entry had every term on a token of its own and
   *   the hits are the nearest there are rather than a real answer.
   */
  function search(entries, query, o) {
    const cfg = Object.assign({ limit: 50, isCode: null, tieBreak: null }, o || {});
    const tie = cfg.tieBreak || ((a, b) => naturalCompare(a.natural, b.natural));
    const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
    const raw = String(query === null || query === undefined ? '' : query).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!raw) return { hits: [], total: 0, relaxed: false };

    if (cfg.isCode && cfg.isCode(raw)) {
      const codes = [];
      for (let i = 0; i < entries.length; i++) {
        const c = entries[i].code;
        if (!c) continue;
        if (c === raw) codes.push({ entry: entries[i], score: 3 });
        else if (c.indexOf(raw) === 0) codes.push({ entry: entries[i], score: 2 });
        else if (c.indexOf(raw) > 0) codes.push({ entry: entries[i], score: 1 });
      }
      if (codes.length) {
        codes.sort((a, b) => b.score - a.score
          || naturalCompare(a.entry.code.match(/\d+|\D+/g) || [], b.entry.code.match(/\d+|\D+/g) || []));
        return { hits: codes.slice(0, cfg.limit), total: codes.length, relaxed: false };
      }
    }

    const terms = tokenise(query);
    if (!terms.length) return { hits: [], total: 0, relaxed: false };
    // Which terms repeat an earlier one. A repeat has to find a second token;
    // a synonym or the code cannot stand in for it.
    const dupes = terms.map((t, i) => terms.indexOf(t) < i);

    const all = [];
    let least = Infinity;
    for (let i = 0; i < entries.length; i++) {
      const r = scoreEntry(terms, dupes, entries[i]);
      if (!r) continue;
      const short = r.missed + r.reused;
      if (short < least) least = short;
      all.push({ entry: entries[i], score: r.score, short, missed: r.missed });
    }
    // The real answers if there are any; otherwise whatever came closest, so
    // long as it has at least half of what was asked for.
    const relaxed = least > 0;
    const kept = all.filter((h) => h.short === least && (!relaxed || h.missed <= Math.floor(terms.length / 2)));
    kept.sort((a, b) => b.score - a.score || tie(a.entry, b.entry) || byCode(a.entry, b.entry));
    return {
      hits: kept.slice(0, cfg.limit).map((h) => ({ entry: h.entry, score: h.score })),
      total: kept.length,
      relaxed: relaxed && kept.length > 0,
    };
  }

  return { prep, normalise, tokenise, naturalKey, entry, search };
}

// ==== SHARED BODY - END =====================================================

export { createSearch, DEFAULT_SYNONYMS, MM_PER_INCH, mmOf, editDistance, naturalCompare };
