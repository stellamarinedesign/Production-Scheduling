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
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

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
