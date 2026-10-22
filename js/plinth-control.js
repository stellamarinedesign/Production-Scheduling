// plinth-control.js — a davit's plinth, chosen in its row on the board.
//
// Two selects that start blank: the height - one the plinth folder has, the
// davit's own model first, or one typed in - and the compression post.
// Standard sets the model's standard height without a post in one click. A
// blank stays a blank until somebody chooses, so nothing is assumed.

import {
  modelsFor, modelOf, standardPlinth, tidyPlinth, blankPlinth, heightOf, needsDrawing, plinthText,
} from './plinths.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const option = (parent, value, text) => {
  const o = el('option', null, text);
  o.value = value;
  parent.append(o);
  return o;
};

const heightKey = (model, height) => `h|${encodeURIComponent(model ?? '')}|${encodeURIComponent(height)}`;

/**
 * @param {Object} job  a board job; `plinth` is its plinth, or null
 * @param {Object|null} catalogue  the plinth folder as last read (plinths.js)
 * @param {(plinth: Object|null) => void} onSet  the plinth to keep, whole, or null to clear it
 */
export function plinthControl(job, catalogue, onSet) {
  const cur = { ...blankPlinth(), ...(job.plinth ?? {}) };
  const wrap = el('span', 'plinth');
  wrap.append(el('span', 'pl-label', 'Plinth'));

  // The height: the davit's own model's heights first, then the others'.
  const height = el('select', `pl-select${cur.mm == null ? ' is-blank' : ''}`);
  height.setAttribute('aria-label', 'Plinth height');
  option(height, '', 'Height');
  const mine = modelsFor(job, catalogue);
  const models = [...mine, ...(catalogue?.models ?? []).filter((m) => !mine.includes(m))]
    .filter((m) => m.heights?.length);
  for (const m of models) {
    const group = el('optgroup');
    group.label = m.name;
    for (const h of m.heights) option(group, heightKey(m.name, h.name), h.name);
    height.append(group);
  }
  if (cur.height && !heightOf(catalogue, cur)) option(height, heightKey(cur.model, cur.height), cur.height);
  if (cur.mm != null && !cur.height) option(height, 'typed', `${cur.mm}mm custom`);
  option(height, 'custom', 'Custom height…');
  const shown = cur.mm == null ? '' : cur.height ? heightKey(cur.model, cur.height) : 'typed';
  height.value = shown;
  if (cur.height) height.title = `${cur.model} › ${cur.height}`;

  // A height typed in: a number in mm, kept with the davit's model where there is one.
  const typed = el('input', 'pl-mm');
  typed.type = 'number';
  typed.min = '1';
  typed.step = '1';
  typed.placeholder = 'mm';
  typed.setAttribute('aria-label', 'Plinth height in mm');
  typed.hidden = true;
  const putBack = () => { typed.hidden = true; height.value = shown; };
  typed.addEventListener('change', () => {
    const mm = Math.round(Number(typed.value));
    if (!(mm > 0)) { putBack(); return; }
    onSet(tidyPlinth({ ...cur, model: modelOf(job, catalogue)?.name ?? cur.model, height: null, mm }));
  });
  typed.addEventListener('keydown', (e) => { if (e.key === 'Escape') putBack(); });
  typed.addEventListener('blur', () => { if (typed.value === '') putBack(); });

  height.addEventListener('change', () => {
    const v = height.value;
    if (v === 'custom') {
      typed.hidden = false;
      typed.value = cur.mm != null && !cur.height ? String(cur.mm) : '';
      typed.focus();
      return;
    }
    if (v === 'typed') return;
    if (!v) { onSet(tidyPlinth({ ...cur, model: null, height: null, mm: null })); return; }
    const [, model, name] = v.split('|').map(decodeURIComponent);
    const found = heightOf(catalogue, { model, height: name });
    onSet(tidyPlinth({ ...cur, model, height: name, mm: found?.mm ?? cur.mm }));
  });

  // The compression post: a select, so not saying is a state of its own.
  const post = el('select', `pl-select${cur.post == null ? ' is-blank' : ''}`);
  post.setAttribute('aria-label', 'Compression post');
  option(post, '', 'Post');
  option(post, 'no', 'No compression post');
  option(post, 'yes', 'Compression post');
  post.value = cur.post == null ? '' : cur.post ? 'yes' : 'no';
  post.addEventListener('change', () => onSet(tidyPlinth({ ...cur, post: post.value === '' ? null : post.value === 'yes' })));

  wrap.append(height, typed, post);

  const std = standardPlinth(modelOf(job, catalogue));
  if (std && (cur.mm == null || cur.post == null)) {
    const b = el('button', 'mini', 'Standard');
    b.title = plinthText(std);
    b.addEventListener('click', () => onSet(std));
    wrap.append(b);
  }
  if (needsDrawing(catalogue, cur)) wrap.append(el('span', 'pl-flag', 'Drawing needed'));
  return wrap;
}
