// packages.js — what a job's production package is made of, and the fill.
//
// A PACKAGE is the paperwork a job goes to the floor with: its laser
// checklists and its combined drawing set. Which folders and documents make
// one up is a manager's decision, kept per item code (every job on that code)
// or per job (a one-off), as paths under the Stella Systems folder that
// OneDrive syncs to every PC. The paths are relative to that folder, so one
// package works on every PC whatever the Windows profile is called.
//
// A FOLDER in a package is searched each time, not remembered file by file:
// drafting's folders keep the current checklist in "Build Forms" and the
// drawing set as a "...Combined.pdf", and old revisions in an Archive folder,
// so a new revision is picked up without anyone touching the package. A
// single FILE in a package is that file and nothing else.
//
// Nothing here touches the disk or the network: stella-folder.js reads the
// folder and adapters/package-files.js does the bytes.

export const ROOT_NAME = 'Stella Systems';
export const SCOPE = { item: 'item', job: 'job' };

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/** Paths are kept as 'A/B/C' under the Stella Systems folder. */
export const splitPath = (p) => String(p ?? '').split('/').filter(Boolean);
export const joinPath = (parts) => parts.filter(Boolean).join('/');
export const parentPath = (p) => joinPath(splitPath(p).slice(0, -1));

/** The end of a path, which is the part anybody recognises. */
export function shortPath(p, keep = 2) {
  const parts = splitPath(p);
  const tail = parts.slice(-keep).join(' › ');
  return parts.length > keep ? `… › ${tail}` : tail;
}

// ---------------------------------------------------------------------------
// what a file is
// ---------------------------------------------------------------------------

/** A folder of old revisions, never the current paperwork. */
export const isArchiveName = (name) => /archiv|supersed/i.test(String(name ?? ''));

/**
 * What a file is to a package. A folder search takes checklists and drawing
 * sets only; a file dropped in on its own may be any Word document or PDF.
 * A checklist saved as a PDF beside its Word file is `checklistPdf`.
 * @returns {'checklist'|'checklistPdf'|'word'|'drawings'|'pdf'|null}
 */
export function docKind(name) {
  const n = String(name ?? '');
  if (/^~\$/.test(n)) return null;                    // Word's lock file for an open document
  const checklist = /check\s*-?\s*list/i.test(n);
  if (/\.docx$/i.test(n)) return checklist ? 'checklist' : 'word';
  if (/\.pdf$/i.test(n)) {
    if (isArchiveName(n)) return null;
    if (checklist) return 'checklistPdf';
    return /combined/i.test(n) ? 'drawings' : 'pdf';
  }
  return null;
}

export const KIND_LABEL = { checklist: 'Checklist', checklistPdf: 'Checklist', word: 'Word', drawings: 'Drawings', pdf: 'PDF' };
export const isPdfKind = (k) => k === 'drawings' || k === 'pdf';

// ---------------------------------------------------------------------------
// checklists: the PDF if there is a current one, the Word file if not
//
// Drafting saves each checklist as a PDF beside its Word file when it is made.
// The PDF prints with the drawings, the production number and due date
// written onto it; the Word file is the fallback - when there is no PDF, or
// when the Word file was saved after it, so the PDF may be out of date - and
// downloads filled in, to print from Word.
// ---------------------------------------------------------------------------

/** A PDF saved within this long before its Word file still counts as current. */
export const PDF_SLACK_MS = 60000;
export const WHY_TEXT = { nopdf: 'Word: no PDF', newer: 'Word: newer than its PDF' };

/**
 * Which file a checklist prints from.
 * @returns {{use: 'pdf'|'word'|null, why: 'nopdf'|'newer'|null}}
 */
export function checklistSource(word, pdf) {
  if (pdf && (!word || (word.lastModified ?? 0) <= (pdf.lastModified ?? 0) + PDF_SLACK_MS)) return { use: 'pdf', why: null };
  if (word) return { use: 'word', why: pdf ? 'newer' : 'nopdf' };
  return { use: null, why: null };
}

/** Does this document go into the printed PDF? (A Word checklist downloads instead.) */
export const printsAsPdf = (d) => isPdfKind(d?.kind) || (d?.kind === 'checklist' && d.use === 'pdf');
/** Does this document download as Word? */
export const downloadsAsWord = (d) => d?.kind === 'word' || (d?.kind === 'checklist' && d.use === 'word');

const baseOf = (name) => String(name ?? '').replace(/\.(docx|pdf)$/i, '').toLowerCase();

/**
 * A checklist's Word file and PDF, as one document: the file it prints from
 * carries the name, the date and the handle; `word` and `pdf` keep both.
 */
export function checklistDoc(word, pdf) {
  const src = checklistSource(word, pdf);
  const used = src.use === 'pdf' ? pdf : word;
  const named = word ?? pdf;
  return { kind: 'checklist', name: used.name, dirs: named.dirs ?? [], key: named.name,
    lastModified: used.lastModified, handle: used.handle, word, pdf, ...src };
}

/**
 * The documents a folder holds, from a listing of it.
 *
 * Archive folders are skipped. A checklist kept in "Build Forms" wins over a
 * copy elsewhere (drafting keeps a working copy beside the laser files), and
 * where the same file name turns up twice the newer copy wins.
 *
 * @param {Array<{dirs: string[], name: string, lastModified: number}>} entries
 *        every file under the folder, `dirs` being its folders below it
 */
export function pickDocuments(entries) {
  const live = (entries ?? []).filter((e) => !(e.dirs ?? []).some(isArchiveName));
  const found = live.map((e) => ({ ...e, kind: docKind(e.name) }));
  const isBuildForms = (e) => (e.dirs ?? []).some((d) => /^build\s*forms?$/i.test(d));
  const lists = found.filter((e) => e.kind === 'checklist' || e.kind === 'checklistPdf');
  const inForms = lists.some(isBuildForms) ? lists.filter(isBuildForms) : lists;
  const drawings = found.filter((e) => e.kind === 'drawings');
  const newer = (a, b) => (!a || (b.lastModified ?? 0) > (a.lastModified ?? 0) ? b : a);
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

  // One checklist per name, Word and PDF taken together: the newest Word
  // file, and its PDF from the same folder where there is one.
  const groups = new Map();
  for (const e of inForms) {
    const g = groups.get(baseOf(e.name)) ?? [];
    g.push(e);
    groups.set(baseOf(e.name), g);
  }
  const checklists = [...groups.values()].map((g) => {
    const word = g.filter((e) => e.kind === 'checklist').reduce(newer, null);
    const pdfs = g.filter((e) => e.kind === 'checklistPdf');
    const beside = word ? pdfs.filter((p) => (p.dirs ?? []).join('/') === (word.dirs ?? []).join('/')) : pdfs;
    return checklistDoc(word, (beside.length ? beside : pdfs).reduce(newer, null));
  }).sort(byName);

  const sets = new Map();
  for (const e of drawings) sets.set(e.name.toLowerCase(), newer(sets.get(e.name.toLowerCase()), e));
  return [...checklists, ...[...sets.values()].sort(byName)];
}

// ---------------------------------------------------------------------------
// which package a job uses
// ---------------------------------------------------------------------------

/** A one-off: a custom code, or a standard code built as a one-off. */
export const isOneOff = (job) => /CUSTOM/i.test(job?.inventory_id ?? '') || Boolean(job?.is_custom);

/** Firestore cannot have '/' in a document id, and item codes do. */
export function packageKey(scope, job) {
  return scope === SCOPE.job
    ? `job~${job?.prod_no ?? ''}`
    : `item~${String(job?.inventory_id ?? '').replace(/\//g, '__')}`;
}

/**
 * The package a job uses: its own if it has one, else its item code's, else
 * an empty one at the scope it would be kept at - a one-off's own, anything
 * else its code's.
 * @param {Object} packages  key -> {sources: [{kind, path}]}
 */
export function packageFor(job, packages) {
  for (const scope of [SCOPE.job, SCOPE.item]) {
    const p = packages?.[packageKey(scope, job)];
    if (p?.sources?.length) return { ...p, scope, sources: p.sources };
  }
  return { scope: isOneOff(job) ? SCOPE.job : SCOPE.item, sources: [] };
}

// ---------------------------------------------------------------------------
// suggestions
// ---------------------------------------------------------------------------

// Words that say what the product is rather than which boat it is for.
const GENERIC = new Set(('stella lifter lifters custom single double arm stepped davit davits '
  + 'launcher launch tender system hydraulic garage door doors ladder boarding folding chair '
  + 'helm seat box plinth power pack powerpack rotary cylinder and the for with used by stock '
  + 'manual luff slew extension stage').split(' '));

export const nameTokens = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The words of a job that could name its folder: a vessel code, a boat name. */
export function matchTokens(job) {
  const words = [...nameTokens(job?.label), ...nameTokens(job?.description)];
  return [...new Set(words.filter((w) => !GENERIC.has(w) && !/^\d+$/.test(w)
    && (w.length >= 4 || /\d/.test(w))))];
}

/**
 * Folders that look like this job's, from folders beside ones already used
 * in packages: a vessel folder is suggested from the folder its neighbours
 * were dropped from. A word common to several folders (a builder's name)
 * says nothing about which one, so only a word found in at most two counts.
 *
 * @param {Array<{name: string, path: string}>} candidates
 * @returns {Array<{name, path, hits: string[]}>} best first, at most five
 */
export function suggestFolders(job, candidates, { exclude = [] } = {}) {
  const tokens = matchTokens(job);
  if (!tokens.length || !candidates?.length) return [];
  const sets = candidates.map((c) => new Set(nameTokens(c.name)));
  const spread = new Map(tokens.map((t) => [t, sets.filter((s) => s.has(t)).length]));
  // Equal matches go plainest first: a folder named just "Zulu" before
  // "Yankee - Zulu Marine".
  return candidates
    .map((c, i) => {
      const hits = tokens.filter((t) => sets[i].has(t) && spread.get(t) <= 2);
      return { ...c, hits, score: hits.reduce((n, t) => n + 1 / spread.get(t), 0), words: sets[i].size };
    })
    .filter((c) => c.score > 0 && !exclude.includes(c.path))
    .sort((a, b) => b.score - a.score || a.words - b.words || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map(({ score, words, ...c }) => c);
}

// ---------------------------------------------------------------------------
// the fill
//
// Every laser checklist carries the same box: a borderless table in a text
// box, "Production Number: ____" over a centred "Due Date: __/__/____". It is
// in the file twice, as a drawing and as the older fallback copy, and both
// are filled. Each line is rebuilt so its label ends on one right-aligned tab
// stop - the colons line up whatever is written after them - then a tab to
// where the value starts, the value underlined, and an underlined tab that
// runs the line on to an end both lines share.
//
// The stops are measured for the template's 14pt Calibri bold and scale with
// the label's size: "Production Number:" is 2377 twips wide at 14pt.
// ---------------------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const FILL_LINES = [['Production Number:', 'prodNo'], ['Due Date:', 'due']];
export const FILL_STOPS = { colon: 2430, value: 2560, end: 4300, atSize: 28 };

// Schema order inside w:pPr and w:rPr: a child has to go before the first of
// these that is present.
const AFTER_TABS = ['suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct',
  'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind',
  'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment',
  'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
const AFTER_JC = ['textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId',
  'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
const AFTER_U = ['effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang',
  'eastAsianLayout', 'specVanish', 'oMath'];

const kids = (node, local) => [...node.childNodes].filter((n) => n.nodeType === 1 && n.namespaceURI === W
  && (!local || n.localName === local));
const textOf = (node) => [...node.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join('');

function insertInOrder(parent, child, before) {
  const next = kids(parent).find((n) => before.includes(n.localName));
  parent.insertBefore(child, next ?? null);
}

/**
 * Tab stops each paragraph style sets, following basedOn, so a filled line
 * can clear them: the template's Header style has stops of its own that
 * would otherwise catch the value's tab.
 * @returns {Object<string, number[]>} style id -> positions
 */
export function styleTabsFrom(stylesXml) {
  if (!stylesXml) return {};
  const doc = new DOMParser().parseFromString(stylesXml, 'application/xml');
  const styles = new Map();
  for (const s of doc.getElementsByTagNameNS(W, 'style')) {
    const id = s.getAttributeNS(W, 'styleId');
    const ppr = kids(s, 'pPr')[0];
    const tabs = ppr ? kids(ppr, 'tabs')[0] : null;
    const own = tabs ? kids(tabs, 'tab')
      .filter((t) => t.getAttributeNS(W, 'val') !== 'clear')
      .map((t) => Number(t.getAttributeNS(W, 'pos'))) : [];
    styles.set(id, { own, basedOn: kids(s, 'basedOn')[0]?.getAttributeNS(W, 'val') ?? null });
  }
  const out = {};
  for (const id of styles.keys()) {
    const seen = new Set(); const all = [];
    for (let cur = id; cur && styles.has(cur) && !seen.has(cur); cur = styles.get(cur).basedOn) {
      seen.add(cur); all.push(...styles.get(cur).own);
    }
    if (all.length) out[id] = [...new Set(all)].sort((a, b) => a - b);
  }
  return out;
}

/**
 * Fill the production number and due date in a checklist's document.xml.
 * @param {string} xml   word/document.xml
 * @param {{prodNo: string, due: string}} values
 * @param {{styleTabs?: Object<string, number[]>}} [opts]
 * @returns {{xml: string, filled: number}}  `filled` counts lines rebuilt;
 *          a checklist with the box gives 4 (two lines, two copies)
 */
export function fillChecklistXml(xml, values, { styleTabs = {} } = {}) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The checklist could not be read.');
  let filled = 0;
  for (const box of [...doc.getElementsByTagNameNS(W, 'txbxContent')]) {
    for (const p of [...box.getElementsByTagNameNS(W, 'p')]) {
      const text = textOf(p).trim();
      const line = FILL_LINES.find(([label]) => text.startsWith(label));
      if (!line) continue;
      rebuildLine(doc, p, line[0], String(values?.[line[1]] ?? ''), styleTabs);
      filled++;
    }
  }
  if (!filled) return { xml, filled };
  let out = new XMLSerializer().serializeToString(doc);
  const decl = /^<\?xml[^>]*\?>/.exec(xml);
  if (decl && !out.startsWith('<?xml')) out = `${decl[0]}\r\n${out}`;
  return { xml: out, filled };
}

function rebuildLine(doc, p, label, value, styleTabs) {
  const mk = (local, attrs = {}) => {
    const n = doc.createElementNS(W, `w:${local}`);
    for (const [k, v] of Object.entries(attrs)) n.setAttributeNS(W, `w:${k}`, v);
    return n;
  };
  const runs = [...p.getElementsByTagNameNS(W, 'r')];
  const labelRun = runs.find((r) => textOf(r).trim().length && label.startsWith(textOf(r).trim().slice(0, 4)))
    ?? runs[0];
  const after = runs.slice(runs.indexOf(labelRun) + 1);
  const rpr = (r) => (r ? kids(r, 'rPr')[0] : null);
  const labelRpr = rpr(labelRun)?.cloneNode(true) ?? mk('rPr');
  const blankRpr = rpr(after.find((r) => textOf(r).includes('_')) ?? after.find((r) => textOf(r).trim()))
    ?.cloneNode(true) ?? labelRpr.cloneNode(true);
  for (const n of kids(blankRpr, 'b').concat(kids(blankRpr, 'bCs'))) n.remove();
  const valueRpr = blankRpr.cloneNode(true);
  for (const n of kids(valueRpr, 'u')) n.remove();
  insertInOrder(valueRpr, mk('u', { val: 'single' }), AFTER_U);

  // Stops scale with the label's size; the template's is 14pt (28 half-points).
  const size = Number(kids(labelRpr, 'sz')[0]?.getAttributeNS(W, 'val')) || FILL_STOPS.atSize;
  const at = (twips) => String(Math.round((twips * size) / FILL_STOPS.atSize));

  let ppr = kids(p, 'pPr')[0];
  if (!ppr) { ppr = mk('pPr'); p.insertBefore(ppr, p.firstChild); }
  for (const n of [...kids(ppr, 'tabs'), ...kids(ppr, 'jc')]) n.remove();
  const tabs = mk('tabs');
  const style = kids(ppr, 'pStyle')[0]?.getAttributeNS(W, 'val');
  for (const pos of styleTabs[style] ?? []) tabs.append(mk('tab', { val: 'clear', pos: String(pos) }));
  tabs.append(mk('tab', { val: 'right', pos: at(FILL_STOPS.colon) }));
  tabs.append(mk('tab', { val: 'left', pos: at(FILL_STOPS.value) }));
  tabs.append(mk('tab', { val: 'right', pos: at(FILL_STOPS.end) }));
  insertInOrder(ppr, tabs, AFTER_TABS);
  insertInOrder(ppr, mk('jc', { val: 'left' }), AFTER_JC);

  for (const n of [...p.childNodes]) if (n !== ppr) n.remove();
  const run = (r, content) => {
    const n = mk('r');
    n.append(r.cloneNode(true));
    if (content === '\t') n.append(mk('tab'));
    else { const t = mk('t'); t.textContent = content; n.append(t); }
    p.append(n);
  };
  run(labelRpr, '\t');
  run(labelRpr, label);
  run(blankRpr, '\t');
  run(valueRpr, value);
  run(valueRpr, '\t');
}

/** "P01480 - SL-...-LaserChecklist.docx": the job's number in front. */
export const filledName = (prodNo, name) => `${prodNo} - ${name}`;

/**
 * Where a checklist PDF takes the production number and due date, from one
 * page's text in PDF units, y up: [{str, x, y, w, size}].
 *
 * Each label is found at the start of its line - spaces ignored, since a PDF
 * may keep them as text or leave them as gaps - and ends where its colon
 * does. The blanks after it are covered; both values start together just
 * past the further colon (the template's two colons sit within a point or two
 * of each other) and are underlined to an end both share, as the Word fill.
 * Null when the page has neither label.
 *
 * @returns {null | {size, valueX, endX, lines: [{key, baseline, cover: [x0, y0, x1, y1]}]}}
 */
export function stampPlan(items) {
  const rows = [];
  for (const it of items ?? []) {
    if (!it?.str) continue;
    let row = rows.find((r) => Math.abs(r.y - it.y) < 1.5);
    if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
    row.items.push(it);
  }
  const found = [];
  for (const [label, key] of FILL_LINES) {
    const want = label.replace(/\s+/g, '');
    for (const row of rows) {
      const its = [...row.items].sort((a, b) => a.x - b.x);
      if (!its.map((i) => i.str).join('').replace(/\s+/g, '').startsWith(want)) continue;
      // Walk to the colon, counting characters that are not spaces.
      let left = want.length;
      let end = null;
      let size = null;
      for (const it of its) {
        const chars = [...it.str];
        for (let i = 0; i < chars.length && end === null; i++) {
          if (/\s/.test(chars[i])) continue;
          if (--left === 0) { end = it.x + (it.w * (i + 1)) / chars.length; size = it.size; }
        }
        if (end !== null) break;
      }
      if (end === null) continue;
      const blanksEnd = Math.max(end, ...its.filter((i) => i.x + i.w > end + 0.5).map((i) => i.x + i.w));
      found.push({ key, baseline: row.y, end, blanksEnd, size });
      break;
    }
  }
  if (!found.length) return null;
  const size = Math.max(...found.map((f) => f.size || 0)) || 12;
  const valueX = Math.max(...found.map((f) => f.end)) + size * 0.45;
  const endX = valueX + size * 6.2;
  return {
    size, valueX, endX,
    lines: found.map((f) => ({
      key: f.key, baseline: f.baseline,
      cover: [f.end + size * 0.04, f.baseline - size * 0.3, Math.max(f.blanksEnd, endX) + size * 0.1, f.baseline + size * 0.95],
    })),
  };
}

// ---------------------------------------------------------------------------
// print defaults
//
// Plenty of products keep laminated drawings on the floor, so their sets need
// not print with every job. A package remembers which documents start
// unticked: `skip`, each with the file's date when it was set aside. A file
// changed since then starts ticked again - a laminated copy of an old
// revision is the thing to replace.
// ---------------------------------------------------------------------------

/** Slack for file dates that round differently on the way back from disk. */
const SAME_FILE_MS = 2000;

/** Does a document start ticked? */
export function printsByDefault(path, lastModified, skip) {
  const s = (skip ?? []).find((x) => x.path === path);
  return !s || (lastModified ?? 0) > (s.modified ?? 0) + SAME_FILE_MS;
}

/** The documents left unticked, as a package's `skip`. */
export const skipFrom = (docs) => (docs ?? [])
  .filter((d) => !d.checked)
  .map((d) => ({ path: d.path, modified: d.lastModified ?? 0 }));
