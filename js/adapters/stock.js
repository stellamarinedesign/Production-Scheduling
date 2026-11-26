// adapters/stock.js — the ERP's stock items export, read into parts.
//
// Same boundary as the production adapter: this is the only place that
// knows the file is a spreadsheet. It hands back plain rows, already cut down
// to the six columns the app keeps, plus what the Parameters sheet says
// about when and how the export was run.
//
// THE NARROWING HAPPENS HERE, before anything is returned. The export carries
// prices, valuation methods and posting classes. None of that is this app's
// business, and the way to be sure it is never stored is for it never to
// leave this function.

import { sheetjs, normaliseRefs } from './xlsx.js';
import { PART_COLUMNS, parseExportDate, clean } from '../parts.js';

/** An error that carries the plain words for it: what is wrong with the file. */
const unreadable = (words, why) => {
  console.warn('[stock]', why?.message);
  return Object.assign(new Error(words), { words });
};

/**
 * @param {File} file
 * @returns {Promise<{rows: Array<Object>, headings: string[], sheetNames: string[],
 *   title: string, dateText: string, exportDate: string|null, savedFilter: string,
 *   sourceLabel: string}>}
 */
export async function readStockExport(file) {
  if (!file) throw new Error('No file given.');
  const XLSX = await sheetjs();

  let bytes;
  try {
    bytes = await file.arrayBuffer();
  } catch (e) {
    throw unreadable('it could not be opened', e);
  }
  let wb;
  try {
    wb = XLSX.read(bytes, { cellDates: false });
  } catch (e) {
    throw unreadable(/password/i.test(e.message) ? 'protected by a password' : 'not a spreadsheet', e);
  }

  // The Parameters sheet is two columns of label / value, then the saved
  // filter as free text. Read it positionally: it has no header row.
  const params = wb.Sheets['Parameters'];
  const data = wb.Sheets['Data'];
  let pRows;
  let raw;
  try {
    pRows = params ? XLSX.utils.sheet_to_json(normaliseRefs(XLSX, params), { header: 1, defval: '' }) : [];
    raw = data ? XLSX.utils.sheet_to_json(normaliseRefs(XLSX, data), { defval: null }) : [];
  } catch (e) {
    throw unreadable('its sheets are not written as a spreadsheet should be. '
      + 'Re-saving it from Excel usually corrects that', e);
  }
  const cellText = (r, i) => clean(r?.[i]);
  const labelled = (re) => {
    const row = pRows.find((r) => re.test(cellText(r, 0)));
    return row ? cellText(row, 1) : '';
  };
  const title = labelled(/^title/i);
  const dateText = labelled(/^date/i);
  const savedFilter = pRows
    .map((r) => (r ?? []).map((c) => clean(c)).join(' '))
    .filter((line) => /\b(equals|contains|and|or)\b/i.test(line))
    .join(' ');

  const headings = raw.length ? Object.keys(raw[0]) : [];

  // Six columns through the door. Not a copy with things deleted — a new
  // object holding only what is allowed, so nothing can ride along.
  const rows = raw.map((r) => {
    const out = {};
    for (const c of PART_COLUMNS) if (c in r) out[c] = r[c];
    return out;
  });

  return {
    rows, headings, sheetNames: wb.SheetNames,
    title, dateText, exportDate: parseExportDate(dateText), savedFilter,
    sourceLabel: file.name,
  };
}
