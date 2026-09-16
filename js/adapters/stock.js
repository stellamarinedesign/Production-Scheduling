// adapters/stock.js — the ERP's stock items export, read into parts.
//
// Same boundary as the production adapter: this is the only place that
// knows the file is a spreadsheet. It hands back plain rows, already cut down
// to the three columns the app keeps, plus what the Parameters sheet says
// about when and how the export was run.
//
// THE NARROWING HAPPENS HERE, before anything is returned. The export carries
// prices, valuation methods and posting classes. None of that is this app's
// business, and the way to be sure it is never stored is for it never to
// leave this function.

import { sheetjs, normaliseRefs } from './xlsx.js';
import { PART_COLUMNS, parseExportDate, clean } from '../parts.js';

/**
 * @param {File} file
 * @returns {Promise<{rows: Array<Object>, headings: string[], sheetNames: string[],
 *   title: string, dateText: string, exportDate: string|null, savedFilter: string,
 *   sourceLabel: string}>}
 */
export async function readStockExport(file) {
  if (!file) throw new Error('No file given.');
  const XLSX = await sheetjs();

  let wb;
  try {
    wb = XLSX.read(await file.arrayBuffer(), { cellDates: false });
  } catch (e) {
    throw new Error(`Could not read that file as a spreadsheet — ${e.message}`);
  }

  // The Parameters sheet is two columns of label / value, then the saved
  // filter as free text. Read it positionally: it has no header row.
  const params = wb.Sheets['Parameters'];
  const pRows = params
    ? XLSX.utils.sheet_to_json(normaliseRefs(XLSX, params), { header: 1, defval: '' })
    : [];
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

  const data = wb.Sheets['Data'];
  const raw = data
    ? XLSX.utils.sheet_to_json(normaliseRefs(XLSX, data), { defval: null })
    : [];
  const headings = raw.length ? Object.keys(raw[0]) : [];

  // Three columns through the door. Not a copy with things deleted — a new
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
