// adapters/xlsx.js — source adapter #1: manual upload of the ERP export.
//
// The adapter's whole job is to produce RawRow[] and say where they came from.
// Nothing below this line knows about files, and nothing above it knows about
// SheetJS. See DATA_SOURCE_ARCHITECTURE.md §2-§3.

import { REQUIRED_COLUMNS } from '../rules.js';

// SheetJS, no build step. Pinned — a silent major-version bump here would
// change how dates and blank cells arrive.
const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';

export const SHEET_PREFERENCE = ['ALL RECORDS', 'Data'];

let _xlsx = null;
async function sheetjs() {
  if (!_xlsx) _xlsx = await import(/* @vite-ignore */ SHEETJS_URL);
  return _xlsx;
}

/**
 * Check the sheet has the columns the transform needs.
 *
 * Never silently tolerate a missing column: the ERP export has been stable,
 * but if someone edits the underlying inquiry a quiet failure yields a board
 * that looks correct and is wrong.
 *
 * @returns {string[]} warnings, empty when the sheet is complete
 */
export function validateColumns(rows) {
  if (!rows.length) return ['That sheet has no rows.'];
  const present = new Set(Object.keys(rows[0]));
  const missing = REQUIRED_COLUMNS.filter((c) => !present.has(c));
  const warnings = [];
  if (missing.length) {
    warnings.push(
      `Export is missing ${missing.length} required column${missing.length > 1 ? 's' : ''}: ` +
      `${missing.join(' · ')}. The board will be incomplete or wrong — check the ERP inquiry.`,
    );
  }
  // The export carries 'Order Type' twice (columns 2 and 20). SheetJS cannot
  // produce two identical keys, so the second arrives suffixed. Neither is a
  // required column, so this is a note rather than a warning — but "keys are
  // verbatim" has this one exception and it should not be a surprise later.
  if (present.has('Order Type_1')) {
    warnings.push(
      'Note: the export has two "Order Type" columns; the second is read as ' +
      '"Order Type_1". The board uses the first — it is what separates T&M ' +
      'from production and internal work.',
    );
  }
  return warnings;
}

/**
 * Repair a sheet whose cell references are lowercase.
 *
 * The spreadsheet spec says a cell reference is uppercase — A1, not a1 — and
 * Excel tolerates the lowercase form, so a writer can emit it for years without
 * anybody noticing. SheetJS does not tolerate it: `decode_cell('a1')` returns
 * column -1, the sheet's own range record comes out malformed as `1:A1236`
 * instead of `A1:AF1236`, and the first thing to touch it throws
 * "invalid column -1" with nothing to say about which file or why.
 *
 * One real export arrived this way. Every cell was present and readable; only
 * the addresses were the wrong case. So this uppercases the keys and rebuilds
 * the range from the cells that actually exist, rather than trusting a range
 * record that has already proved unreliable.
 *
 * Returns the sheet untouched when there is nothing wrong with it.
 */
export function normaliseRefs(XLSX, sheet) {
  const keys = Object.keys(sheet);
  if (!keys.some((k) => !k.startsWith('!') && k !== k.toUpperCase())) return sheet;

  const out = {};
  let minR = Infinity; let maxR = -1; let minC = Infinity; let maxC = -1;
  for (const k of keys) {
    if (k.startsWith('!')) continue;                 // rebuilt below
    const up = k.toUpperCase();
    out[up] = sheet[k];
    const { r, c } = XLSX.utils.decode_cell(up);
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
  }
  if (maxR < 0 || maxC < 0) return sheet;            // nothing to go on
  out['!ref'] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });
  return out;
}

export const xlsxAdapter = {
  id: 'xlsx',
  label: 'Upload ERP export',

  /**
   * @param {{file: File}} opts
   * @returns {Promise<{rows: Array<Object>, sourceId: string, sourceLabel: string,
   *                    retrievedAt: string, warnings: string[]}>}
   */
  async fetch({ file }) {
    if (!file) throw new Error('No file given.');
    const XLSX = await sheetjs();

    let wb;
    try {
      wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    } catch (e) {
      throw new Error(`Could not read that file as a spreadsheet — ${e.message}`);
    }

    // Which sheet holds the rows, in order of preference.
    //
    // 'ALL RECORDS' is the whole order book — production, T&M and internal in
    // one table — and is what the export is moving to. The office currently
    // also ships REGULAR / TM / INTERNAL sheets split by hand; those are a
    // subset of ALL RECORDS, and the board derives the same split itself from
    // `Order Type` and `Order Nbr.` (see rules.js `laneFor`), so it reads the
    // whole table and never the pre-sorted sheets. 'Data' is the older export.
    const name = SHEET_PREFERENCE.find((n) => wb.Sheets[n]);
    if (!name) {
      throw new Error(
        `No ${SHEET_PREFERENCE.map((n) => `'${n}'`).join(' or ')} sheet — is this the ` +
        `right export? Found: ${wb.SheetNames.join(', ') || 'nothing'}`,
      );
    }
    const sheet = wb.Sheets[name];

    // defval: null so a blank cell arrives as a key with a null value rather
    // than vanishing from the row object entirely.
    let rows;
    try {
      rows = XLSX.utils.sheet_to_json(normaliseRefs(XLSX, sheet), { defval: null });
    } catch (e) {
      throw new Error(
        `Could not read the '${name}' sheet of ${file.name} — ${e.message}. `
        + `The file opens in Excel but is not written the way the spec requires; `
        + `re-saving it from Excel usually fixes it.`,
      );
    }

    return {
      rows,
      sourceId: 'xlsx',
      sourceLabel: file.name,
      sheetName: name,
      // From the adapter, never parsed out of the filename — the export is
      // named ..._YYYYMMDD.xlsx and the temptation is real. That date is when
      // someone ran the export, not when these rows reached the board, and a
      // re-upload of an old file would silently claim to be fresh.
      retrievedAt: new Date().toISOString(),
      warnings: validateColumns(rows),
    };
  },
};
