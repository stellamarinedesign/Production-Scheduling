// plinths.js — a davit's plinth: how high, with or without a compression post,
// and with an enclosed gusset or an open one.
//
// Drafting keeps every plinth in one folder under Stella Systems: a folder per
// model, named for the lift and the drive ("350kg - Manual", "450kg-750kg -
// Hydraulic"), and in each a folder per height - "100mm - St'd" being the
// model's standard, "200mm" another, or a one-off with more to its name. A
// height folder keeps its laser checklist in Build Forms and its drawings in
// PDF: "...-200mm.pdf" without a compression post, "...-200mm-CP.pdf" with one,
// and "-OG" after either for an open gusset ("...-200mm-OG.pdf",
// "...-200mm-CP-OG.pdf"). An open gusset has its own checklist,
// "...-200mm-OG-LaserChecklist"; enclosed is the standard.
//
// The folder is read in the Package dialog into a CATALOGUE kept beside the
// packages (`packages/plinths`), so a davit's row can offer the heights there
// are without a PC's folder to hand. What a davit is to have is kept on its
// job (`jobOverrides.plinth`) and is nothing until a manager says - the
// standard included - so a blank is never taken for a choice.
//
// Nothing here touches the disk: package-dialog.js reads the folder.

import { joinPath, isArchiveName, docKind } from './packages.js';

export const PLINTHS_KEY = 'plinths';

/** The board category davits are in (rules.js, CATEGORY_RULES). */
const DAVITS = 'Davits';

/** A davit, not a davit part: the jobs a plinth is chosen for. */
export const isDavit = (job) => job?.category === DAVITS && !job?.part_order;

// ---------------------------------------------------------------------------
// reading the folder
// ---------------------------------------------------------------------------

/** "350kg - Manual" or "450kg-750kg - Hydraulic": the lift a model takes, and its drive. */
export function parseModel(name) {
  const m = /^\s*(\d+)\s*kg(?:\s*-\s*(\d+)\s*kg)?\s*-\s*(.+?)\s*$/i.exec(String(name ?? ''));
  if (!m || isArchiveName(name)) return null;
  return { lo: Number(m[1]), hi: Number(m[2] ?? m[1]), drive: m[3] };
}

/** "100mm - St'd", "200mm", or a one-off's longer name: the height, and whether it is the standard. */
export function parseHeight(name) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*mm\b(.*)$/i.exec(String(name ?? ''));
  if (!m || isArchiveName(name)) return null;
  return { mm: Number(m[1]), std: /\bst'?d\b|\bstandard\b/i.test(m[2]) };
}

const newest = (list) => list.reduce((a, b) => (!a || (b.lastModified ?? 0) > (a.lastModified ?? 0) ? b : a), null);
const fileOf = (e) => (e ? joinPath([...(e.dirs ?? []), e.name]) : null);

/** An open gusset's document: "-OG" as a part of its own in the name. */
const isOpen = (name) => /-OG(?=[-_.\s]|$)/i.test(name);

/**
 * A height folder's checklists and drawings, from a listing of it. A
 * checklist for each gusset: in Build Forms named for the height (another
 * variant has more to its name), else any in Build Forms, else any - an
 * open gusset's only ever one with "-OG" in its name, an enclosed one's
 * never. The drawings named for the height, without and with a compression
 * post, enclosed and open. A drawing of another height, or of another model,
 * saved alongside is passed over.
 * @param {Array<{dirs: string[], name: string, lastModified: number}>} entries  files below the folder
 * @param {number} mm  the folder's height
 * @param {number} lo  the model's lift, which its own drawings carry in their names
 * @returns {{checklist: string|null, checklistOpen: string|null, drawing: string|null,
 *            drawingPost: string|null, drawingOpen: string|null, drawingPostOpen: string|null}}  paths below the folder
 */
export function plinthFiles(entries, mm, lo) {
  const live = (entries ?? []).filter((e) => !(e.dirs ?? []).some(isArchiveName));
  const inForms = (e) => (e.dirs ?? []).some((d) => /^build\s*forms?$/i.test(d));
  const lists = live.filter((e) => ['checklist', 'checklistPdf'].includes(docKind(e.name)));
  const checklist = (open) => {
    const named = (e) => new RegExp(`-${mm}mm${open ? '-OG' : ''}-?laser\\s*-?check\\s*-?list\\.(docx|pdf)$`, 'i').test(e.name);
    const mine = lists.filter((e) => isOpen(e.name) === open);
    const best = [mine.filter((e) => inForms(e) && named(e)), mine.filter(inForms), mine].find((l) => l.length) ?? [];
    // The Word file where there is one: the Package dialog finds its PDF beside it.
    const word = best.filter((e) => docKind(e.name) === 'checklist');
    return fileOf(newest(word.length ? word : best));
  };
  const drawing = (post, open) => {
    const tail = post && open ? '-(?:CP-OG|OG-CP)' : post ? '-CP' : open ? '-OG' : '';
    const re = new RegExp(`-${mm}mm${tail}\\.pdf$`, 'i');
    const found = live.filter((e) => re.test(e.name) && docKind(e.name) === 'pdf');
    const own = found.filter((e) => e.name.includes(String(lo)));
    return fileOf(newest(own.length ? own : found));
  };
  return {
    checklist: checklist(false), checklistOpen: checklist(true),
    drawing: drawing(false, false), drawingPost: drawing(true, false),
    drawingOpen: drawing(false, true), drawingPostOpen: drawing(true, true),
  };
}

/**
 * The catalogue, read from the plinth folder at `path` (below Stella Systems).
 * @param {string} path
 * @param {{folders: (path) => Promise<string[]>, files: (path) => Promise<Array>}} read
 *        the folders directly inside one, and every file below one (archives left out)
 * @returns {Promise<{path: string, models: Array}>}
 */
export async function readCatalogue(path, read) {
  const models = [];
  for (const name of await read.folders(path)) {
    const model = parseModel(name);
    if (!model) continue;
    const heights = [];
    for (const folder of await read.folders(joinPath([path, name]))) {
      const h = parseHeight(folder);
      if (!h) continue;
      const base = joinPath([path, name, folder]);
      const found = plinthFiles(await read.files(base), h.mm, model.lo);
      const full = Object.fromEntries(Object.entries(found).map(([k, p]) => [k, p ? joinPath([base, p]) : null]));
      heights.push({ name: folder, ...h, ...full });
    }
    heights.sort((a, b) => a.mm - b.mm || a.name.localeCompare(b.name));
    models.push({ name, ...model, heights });
  }
  models.sort((a, b) => a.lo - b.lo || a.name.localeCompare(b.name));
  return { path, models };
}

/** Has the folder changed since the catalogue was read? */
export const sameCatalogue = (a, b) => a?.path === b?.path && JSON.stringify(a?.models ?? []) === JSON.stringify(b?.models ?? []);

// ---------------------------------------------------------------------------
// which model a davit is
// ---------------------------------------------------------------------------

/**
 * A davit's lift, and the drive its plinth follows: the slew's, since a
 * manual-slew davit sits on a manual-slew post and a hydraulic-slew davit on
 * a hydraulic one, whatever its luff. The item description names all three
 * drives (luff, slew, extension); a one-off's own order text says how it
 * differs, so it is read first for one. The item code's slew token (HS, MS,
 * in the pairs after the lift) is the last resort.
 */
export function davitOf(job) {
  const code = String(job?.inventory_id ?? '');
  const texts = [job?.item_description, job?.description].map((t) => String(t ?? ''));
  if (job?.is_custom) texts.reverse();
  const kg = /^SDC(\d{3})/i.exec(code)?.[1] ?? /(\d{3})\s*kg/i.exec(texts.join(' '))?.[1] ?? null;
  const slew = (t) => (/hydraulic\s+slew/i.test(t) ? 'hydraulic' : /manual\s+slew|slew\s+assist/i.test(t) ? 'manual' : null);
  const pairs = /^SDC\d{3}([A-Z]+)/i.exec(code)?.[1].toUpperCase().match(/../g) ?? [];
  const drive = /fold/i.test(`${code} ${texts.join(' ')}`) ? 'folding'
    : texts.map(slew).find(Boolean)
      ?? (pairs.includes('HS') ? 'hydraulic' : pairs.includes('MS') ? 'manual' : null);
  return { kg: kg === null ? null : Number(kg), drive };
}

/** The models a davit could be: its lift within theirs, and its drive where that is known. */
export function modelsFor(job, catalogue) {
  const { kg, drive } = davitOf(job);
  if (kg === null) return [];
  return (catalogue?.models ?? []).filter((m) => kg >= m.lo && kg <= m.hi
    && (!drive || m.drive.toLowerCase().startsWith(drive)));
}

/** The one model a davit is, or null when the code and description leave it open. */
export function modelOf(job, catalogue) {
  const found = modelsFor(job, catalogue);
  return found.length === 1 && davitOf(job).drive ? found[0] : null;
}

// ---------------------------------------------------------------------------
// a davit's plinth
//
// Kept on the job as {model, height, mm, post, gusset}: the model and height
// folders it was chosen from (height null for a height typed in), the height
// in mm, the compression post - true, false, or null while nobody has said -
// and the gusset, 'enclosed', 'open' or null. Always written whole, so a merge
// never leaves a stale field behind.
// ---------------------------------------------------------------------------

export const blankPlinth = () => ({ model: null, height: null, mm: null, post: null, gusset: null });

/**
 * A plinth as kept, made whole. One kept before the gusset was a choice is
 * enclosed: the only plinth the board offered then, and the drawings and
 * checklist its packages printed.
 */
export function wholePlinth(p) {
  if (!p) return null;
  const out = { ...blankPlinth(), ...p };
  if (!('gusset' in p)) out.gusset = 'enclosed';
  return out;
}

/** A plinth with nothing chosen is no plinth: null, to be removed. */
export function tidyPlinth(p) {
  const out = { ...blankPlinth(), ...(p ?? {}) };
  return out.mm === null && out.post === null && out.gusset === null ? null : out;
}

/** The plinth a model's standard is: its standard height, no compression post, enclosed. */
export function standardPlinth(model) {
  const h = model?.heights?.find((x) => x.std);
  return h ? { model: model.name, height: h.name, mm: h.mm, post: false, gusset: 'enclosed' } : null;
}

/** The catalogue's height a plinth was chosen from, while it is there. */
export function heightOf(catalogue, p) {
  if (!p?.height) return null;
  return catalogue?.models?.find((m) => m.name === p.model)?.heights?.find((h) => h.name === p.height) ?? null;
}

/** The drawing for a plinth, once the post and the gusset are chosen; null if there is none. */
export function drawingFor(catalogue, plinth) {
  const p = wholePlinth(plinth);
  if (p?.post == null || p.gusset == null) return null;
  const h = heightOf(catalogue, p);
  const open = p.gusset === 'open';
  return (p.post ? (open ? h?.drawingPostOpen : h?.drawingPost) : (open ? h?.drawingOpen : h?.drawing)) ?? null;
}

/** The checklist for a plinth, once the gusset is chosen: an open gusset has its own. */
export function checklistFor(catalogue, plinth) {
  const p = wholePlinth(plinth);
  if (p?.gusset == null) return null;
  const h = heightOf(catalogue, p);
  return (p.gusset === 'open' ? h?.checklistOpen : h?.checklist) ?? null;
}

/** A height typed in, or a post and gusset with no drawing at their height: a drawing to be made. */
export function needsDrawing(catalogue, plinth) {
  const p = wholePlinth(plinth);
  if (p?.mm == null) return false;
  if (!p.height) return true;
  return p.post != null && p.gusset != null && !drawingFor(catalogue, p);
}

/** A height in the folder with no checklist for the gusset chosen: a checklist to be made. */
export function needsChecklist(catalogue, plinth) {
  const p = wholePlinth(plinth);
  return Boolean(p?.gusset != null && heightOf(catalogue, p) && !checklistFor(catalogue, p));
}

/** The plinth in words, for the log and the Package dialog. */
export function plinthText(plinth) {
  const p = wholePlinth(plinth);
  if (!p || (p.mm == null && p.post == null && p.gusset == null)) return 'not set';
  const height = p.height ?? (p.mm != null ? `${p.mm}mm custom` : 'height not set');
  const post = p.post === true ? 'compression post' : p.post === false ? 'no compression post' : 'post not set';
  const gusset = p.gusset === 'open' ? 'open gusset' : p.gusset === 'enclosed' ? 'enclosed' : 'gusset not set';
  return `${height}, ${post}, ${gusset}`;
}

/** The plinth's checklist and drawing, as package sources. */
export function plinthSources(catalogue, plinth) {
  return [checklistFor(catalogue, plinth), drawingFor(catalogue, plinth)].filter(Boolean)
    .map((path) => ({ kind: 'file', path, plinth: true }));
}
