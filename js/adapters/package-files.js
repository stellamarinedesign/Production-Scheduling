// adapters/package-files.js — the bytes of a production package.
//
// A checklist is a .docx, which is a zip; the fill rewrites one file inside
// it (packages.js decides what) and leaves every other part as it was. The
// drawing sets are PDFs, merged into one so a package is one print dialog.
//
// JSZip and pdf-lib are fetched the first time a package is printed, like
// ExcelJS on the parts page, and never on a PC that is only reading the board.

import { fillChecklistXml, styleTabsFrom, stampPlan, widenThinLines } from '../packages.js';

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

/** A stream's bytes as text, one character per byte, and back. */
const byteText = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
const textBytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/**
 * Every line on a PDF's pages at least MIN_LINE_PT wide, the pictures the
 * pages draw included (see `widenThinLines`). Each stream it changes is
 * written anew; one it cannot read is left as it was.
 * @param {object} doc  a pdf-lib PDFDocument
 * @param {object} L    pdf-lib
 * @returns {number} how many lines it widened
 */
function widenLines(doc, L) {
  const { PDFName, PDFArray, PDFDict, PDFNumber, PDFRawStream, decodePDFRawStream } = L;
  const ctx = doc.context;
  const N = (s) => PDFName.of(s);
  const get = (dict, key, type) => {
    const v = dict ? ctx.lookup(dict.get(N(key))) : undefined;
    return v instanceof type ? v : undefined;
  };
  const read = (stream) => {
    try {
      if (stream instanceof PDFRawStream) return byteText(decodePDFRawStream(stream).decode());
      if (typeof stream?.getUnencodedContents === 'function') return byteText(stream.getUnencodedContents());
    } catch { /* a filter pdf-lib cannot undo: left as it is */ }
    return null;
  };
  const widths = (resources) => {
    const out = {};
    for (const [name, ref] of get(resources, 'ExtGState', PDFDict)?.entries() ?? []) {
      const state = ctx.lookup(ref);
      const lw = state instanceof PDFDict ? get(state, 'LW', PDFNumber)?.asNumber() : undefined;
      if (Number.isFinite(lw)) out[name.decodeText()] = lw;
    }
    return out;
  };
  const streamKeys = new Set(['Filter', 'DecodeParms', 'Length', 'DL', 'F', 'FFilter', 'FDecodeParms'].map(N));
  const done = new Set();
  let widened = 0;

  const widenForms = (forms, resources) => {
    const xobjects = get(resources, 'XObject', PDFDict);
    for (const f of forms) {
      const ref = xobjects?.get(N(f.name));
      const form = ctx.lookup(ref);
      if (!(form instanceof PDFRawStream) || form.dict.get(N('Subtype')) !== N('Form')) continue;
      if (done.has(String(ref))) continue;
      done.add(String(ref));
      const m = get(form.dict, 'Matrix', PDFArray)?.asArray().map((x) => ctx.lookup(x)?.asNumber?.());
      const scale = m?.slice(0, 4).every(Number.isFinite) ? Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) : 1;
      const own = get(form.dict, 'Resources', PDFDict) ?? resources;
      const content = read(form);
      if (content === null) continue;
      const out = widenThinLines(content, { scale: f.scale * scale, lw: f.lw, gs: widths(own) });
      if (out.widened) {
        const fresh = ctx.flateStream(textBytes(out.text));
        for (const [k, v] of form.dict.entries()) if (!streamKeys.has(k)) fresh.dict.set(k, v);
        ctx.assign(ref, fresh);
        widened += out.widened;
      }
      widenForms(out.forms, own);
    }
  };

  for (const page of doc.getPages()) {
    const node = page.node;
    const contents = ctx.lookup(node.get(N('Contents')));
    const parts = (contents instanceof PDFArray ? contents.asArray().map((r) => ctx.lookup(r)) : [contents]).map(read);
    if (!parts.length || parts.includes(null)) continue;
    const resources = node.Resources();
    // A page's streams run on from one another, so they are read as one.
    const out = widenThinLines(parts.join(String.fromCharCode(10)), { gs: widths(resources) });
    if (out.widened) {
      node.set(N('Contents'), ctx.obj([ctx.register(ctx.flateStream(textBytes(out.text)))]));
      widened += out.widened;
    }
    widenForms(out.forms, resources);
  }
  return widened;
}

/**
 * A checklist PDF ready to print: every line thick enough to print as a line
 * (see `MIN_LINE_PT`), and the production number and due date written in -
 * the blanks covered, each value in place and underlined (see `stampPlan`).
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {{prodNo: string, due: string}} values
 * @returns {Promise<{bytes: Uint8Array, filled: number, widened: number}>}
 *          `filled` is 0 when no page has the box, and nothing is then written in
 */
export async function stampChecklistPdf(bytes, values) {
  const reader = await pdfjs();
  // pdf.js takes the buffer it is given, so it gets a copy.
  const src = await reader.getDocument({ data: new Uint8Array(bytes).slice(), isEvalSupported: false }).promise;
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
  const L = await pdflib();
  const { PDFDocument, StandardFonts, rgb, ParseSpeeds } = L;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, parseSpeed: ParseSpeeds.Fastest });
  // Before anything is drawn on, so only drafting's own lines are looked at.
  let widened = 0;
  try { widened = widenLines(doc, L); } catch { /* printed as drafting saved it */ }
  if (plan) {
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
  }
  if (!plan && !widened) return { bytes: new Uint8Array(bytes), filled: 0, widened };
  return { bytes: await doc.save({ objectsPerTick: Infinity }), filled: plan?.lines.length ?? 0, widened };
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
