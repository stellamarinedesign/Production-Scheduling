// adapters/package-files.js — the bytes of a production package.
//
// A checklist is a .docx, which is a zip; the fill rewrites one file inside
// it (packages.js decides what) and leaves every other part as it was. The
// drawing sets are PDFs, merged into one so a package is one print dialog.
//
// JSZip and pdf-lib are fetched the first time a package is printed, like
// ExcelJS on the parts page, and never on a PC that is only reading the board.

import { fillChecklistXml, styleTabsFrom } from '../packages.js';

// Pinned: a silent major-version change here would change the files written.
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
const PDFLIB_URL = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';

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
 * @param {Array<ArrayBuffer|Uint8Array>} list
 * @param {{title?: string}} [opts]  shown by the PDF viewer
 * @returns {Promise<Uint8Array>}
 */
export async function mergePdfs(list, { title = '' } = {}) {
  const { PDFDocument } = await pdflib();
  const out = await PDFDocument.create();
  for (const bytes of list) {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  if (title) out.setTitle(title, { showInWindowTitleBar: true });
  return out.save();
}
