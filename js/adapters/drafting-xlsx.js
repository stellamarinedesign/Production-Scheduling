// adapters/drafting-xlsx.js — the part list as a workbook, laid out like the
// old drafting sheet: a navy header row, a tab per family, filters on, the
// header frozen.
//
// SheetJS reads the export but its free build writes no cell styles, and a
// header the office recognises at a glance is the point. ExcelJS writes them.
// It is a large library, so it is fetched the first time somebody clicks
// Download and never on a phone that is only looking a part up.
//
// What goes in the file is decided in parts.js (`draftingSheets`). This only
// knows how to turn rows into cells.

// Pinned. A silent major-version bump here would change the file format.
const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';

const HEADER_FILL = 'FF000080';           // the old sheet's navy
const HEADER_TEXT = 'FFFFFFFF';
const WIDTHS = [22, 80, 16, 11, 20, 15, 70];   // one per SHEET_COLUMNS entry

let loading = null;

/** ExcelJS, loaded on first use. A UMD bundle, so a script tag rather than an import. */
async function exceljs() {
  if (window.ExcelJS) return window.ExcelJS;
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = EXCELJS_URL;
    s.async = true;
    s.onload = () => (window.ExcelJS
      ? resolve(window.ExcelJS)
      : reject(new Error('The spreadsheet writer loaded but did not register.')));
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load the spreadsheet writer — check the connection and try again.'));
    };
    document.head.append(s);
  });
  return loading;
}

/**
 * Sheets of rows -> a workbook in memory.
 * @param {Array<{name: string, rows: Array<Array>, plain?: boolean}>} sheets
 * @returns {Promise<ArrayBuffer>} the .xlsx bytes
 */
export async function buildWorkbook(sheets) {
  const ExcelJS = await exceljs();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Parts page';
  wb.created = new Date();
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name);
    ws.addRows(sh.rows);
    if (sh.plain) {
      ws.getColumn(1).width = 24;
      ws.getColumn(2).width = 110;
      ws.getColumn(1).font = { bold: true };
      continue;
    }
    WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: HEADER_TEXT } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, sh.rows.length), column: sh.rows[0]?.length ?? 1 },
    };
  }
  return wb.xlsx.writeBuffer();
}

/** Build it and hand it to the browser as a download. */
export async function downloadWorkbook(sheets, fileName) {
  const buf = await buildWorkbook(sheets);
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
