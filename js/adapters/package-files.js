// adapters/package-files.js — the bytes of a production package.
//
// A checklist is a .docx, which is a zip; the fill rewrites one file inside
// it (packages.js decides what) and leaves every other part as it was. The
// drawing sets are PDFs, merged into one so a package is one print dialog.
//
// JSZip and pdf-lib are fetched the first time a package is printed, like
// ExcelJS on the parts page, and never on a PC that is only reading the board.

import { fillChecklistXml, styleTabsFrom, stampPlan } from '../packages.js';

// Pinned: a silent major-version change here would change the files written.
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
const PDFLIB_URL = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
// pdf.js reads a checklist PDF's text to find the box. pdf-lib writes but
// cannot read text.
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

const loading = {};

/** A UMD bundle, loaded on first use: a script tag rather than an import. */
function umd(url, global, what) {
  if (window[global]) return Promise.resolve(window[global]);
  loading[url] ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => (window[global] ? resolve(window[global])
      : reject(new Error(`The ${what} loaded but did not register.`)));
    s.onerror = () => {
      delete loading[url];
      reject(new Error(`Could not load the ${what} — check the connection and try again.`));
    };
    document.head.append(s);
  });
  return loading[url];
}

export const jszip = () => umd(JSZIP_URL, 'JSZip', 'Word document reader');
export const pdflib = () => umd(PDFLIB_URL, 'PDFLib', 'PDF merger');

let pdfjsLoading = null;

/**
 * pdf.js, an ES module, loaded on first use. Its worker is on another origin,
 * which a browser will not start as a worker; pdf.js then runs the same code
 * on the page instead, which for a few pages of checklist is quick.
 */
export function pdfjs() {
  pdfjsLoading ??= import(PDFJS_URL)
    .then((m) => { m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL; return m; })
    .catch(() => {
      pdfjsLoading = null;
      throw new Error('Could not load the PDF reader — check the connection and try again.');
    });
  return pdfjsLoading;
}

/**
 * A checklist PDF with the production number and due date written in: the
 * blanks covered, each value in place and underlined (see `stampPlan`).
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {{prodNo: string, due: string}} values
 * @returns {Promise<{bytes: Uint8Array, filled: number}>} `filled` is 0 when no
 *          page has the box, and the bytes are then a plain copy
 */
export async function stampChecklistPdf(bytes, values) {
  const lib = await pdfjs();
  // pdf.js takes the buffer it is given, so it gets a copy.
  const src = await lib.getDocument({ data: new Uint8Array(bytes).slice(), isEvalSupported: false }).promise;
  let plan = null;
  let pageIndex = -1;
  try {
    for (let n = 1; n <= src.numPages && !plan; n++) {
      const text = await (await src.getPage(n)).getTextContent();
      plan = stampPlan(text.items.filter((t) => 'str' in t).map((t) => ({
        str: t.str, x: t.transform[4], y: t.transform[5], w: t.width,
        size: Math.hypot(t.transform[2], t.transform[3]) || t.height,
      })));
      if (plan) pageIndex = n - 1;
    }
  } finally {
    await src.destroy();
  }
  if (!plan) return { bytes: new Uint8Array(bytes), filled: 0 };

  const { PDFDocument, StandardFonts, rgb, ParseSpeeds } = await pdflib();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, parseSpeed: ParseSpeeds.Fastest });
  const page = doc.getPage(pageIndex);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0, 0, 0);
  for (const line of plan.lines) {
    const [x0, y0, x1, y1] = line.cover;
    page.drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, color: rgb(1, 1, 1) });
    page.drawText(String(values?.[line.key] ?? ''), { x: plan.valueX, y: line.baseline, size: plan.size, font, color: ink });
    const under = line.baseline - plan.size * 0.12;
    page.drawLine({ start: { x: plan.valueX, y: under }, end: { x: plan.endX, y: under },
      thickness: Math.max(0.6, plan.size * 0.05), color: ink });
  }
  return { bytes: await doc.save({ objectsPerTick: Infinity }), filled: plan.lines.length };
}

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * A checklist with the production number and due date written in.
 * @param {ArrayBuffer|Uint8Array} bytes  the .docx as drafting saved it
 * @param {{prodNo: string, due: string}} values
 * @returns {Promise<{bytes: Uint8Array, filled: number}>} `filled` is 0 when the
 *          document has no box to fill, and the bytes are then a plain copy
 */
export async function fillChecklistDocx(bytes, values) {
  const JSZip = await jszip();
  const zip = await JSZip.loadAsync(bytes);
  const part = zip.file('word/document.xml');
  if (!part) throw new Error('That is not a Word document.');
  const styles = zip.file('word/styles.xml');
  const { xml, filled } = fillChecklistXml(await part.async('string'), values, {
    styleTabs: styleTabsFrom(styles ? await styles.async('string') : ''),
  });
  if (!filled) return { bytes: new Uint8Array(bytes), filled };
  // createFolders off: JSZip would otherwise add a "word/" folder entry that
  // Word never wrote.
  zip.file('word/document.xml', xml, { createFolders: false });
  return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), filled };
}

/**
 * PDFs, one after another, as one PDF.
 *
 * At full speed. By default pdf-lib pauses on a timer every hundred or so
 * objects to keep the page responsive, and a drawing set is thousands of
 * objects: 48 pauses for three of them. A browser holds a background tab's
 * timers to about one a second, so the merge that takes a twentieth of a
 * second in front took twenty behind a tab that had just opened.
 *
 * @param {Array<ArrayBuffer|Uint8Array>} list
 * @param {{title?: string}} [opts]  shown by the PDF viewer
 * @returns {Promise<Uint8Array>}
 */
export async function mergePdfs(list, { title = '' } = {}) {
  const { PDFDocument, ParseSpeeds } = await pdflib();
  const out = await PDFDocument.create();
  for (const bytes of list) {
    const src = await PDFDocument.load(bytes, {
      ignoreEncryption: true, updateMetadata: false, parseSpeed: ParseSpeeds.Fastest,
    });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  if (title) out.setTitle(title, { showInWindowTitleBar: true });
  return out.save({ objectsPerTick: Infinity });
}
