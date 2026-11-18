// import-review.js — the review an import is checked in before it is applied.
//
// The board and the parts page both stage an export, describe it and wait for
// Apply. They used to draw that review each in their own way; this draws both,
// so the two read alike. It knows nothing about boards, parts or the store: the
// page hands it a description of what to show and the functions to call, and
// it keeps only which counts, concerns, groups and toggles are open. Every
// click on one of those changes that state and asks the page to draw the review
// again, through the callback it was made with, so the description is always
// rebuilt from the page's own current data.
//
// A description:
//   {
//     title, lede,
//     notes:    [{ cls, text }]                      under the lede
//     stats:    [{ key, n, label, note, detail }]    a card each; one with a
//               `detail` (a function returning a Detail) opens and shuts it
//     summary:  { first } | { lead, parts: [{ n, label, cls }], after } | null
//     concerns: [{ id, level, title, note, rows: [Row], resolveAll }]
//     clean:    shown in place of the concerns when there are none
//     actions:  { apply: { label, run }, cancel: { label, run }, hint } | null
//   }
//   Detail: { title, note, toggle, groups: [{ key, title, rows: [Row], shutByDefault }] }
//     `toggle` undefined draws a plain heading (and the note); null or
//     { id, label } draws a heading bar, the latter with a button that flips
//     `isOn(id)`.
//   Row: { key, main, detail, cls, marks: [{ cls, text }], action: { label, run },
//          control: () => Node, wire: (rowElement) => void }
//     key, main and detail are text or a Node.

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const cell = (cls, v) => {
  if (v instanceof Node) { const s = el('span', cls); s.append(v); return s; }
  return el('span', cls, v);
};

// A concern this short is open whatever was clicked: there is nothing to save
// by shutting three rows.
const ALWAYS_OPEN = 3;

/**
 * One review's open and shut state, and the drawing.
 * @param {() => void} rerender the page's own draw, called after every change
 * @returns {{ render: (desc: object) => HTMLElement, isOn: (id: string) => boolean }}
 */
export function createReview(rerender) {
  let openDetail = null;
  const openConcerns = new Set();
  // Groups inside an opened count. A key on its own means shut by hand; an
  // `open:` key means opened by hand where the group starts shut. Not saved:
  // which part of a one-off listing you were reading is not worth remembering.
  const shutGroups = new Set();
  const on = new Set();

  const isOn = (id) => on.has(id);

  function row(r) {
    const x = el('div', `flag-row${r.cls ? ` ${r.cls}` : ''}`);
    x.append(cell('fr-key', r.key));
    x.append(cell('fr-main', r.main));
    x.append(cell('fr-detail', r.detail ?? ''));
    const act = el('span', 'fr-act');
    for (const m of r.marks ?? []) act.append(el('span', m.cls, m.text));
    if (r.control) act.append(r.control());
    else if (r.action) {
      const btn = el('button', 'mini', r.action.label);
      btn.addEventListener('click', r.action.run);
      act.append(btn);
    }
    x.append(act);
    return x;
  }

  function rowsTable(rows) {
    const t = el('div', 'flag-rows');
    for (const r of rows) {
      const x = row(r);
      t.append(x);
      // After it is in the table: a wire may put something beside the row.
      r.wire?.(x);
    }
    return t;
  }

  function group(wrap, g) {
    const shut = shutGroups.has(g.key)
      || (g.shutByDefault && !shutGroups.has(`open:${g.key}`));
    const head = el('button', `detail-group${shut ? ' is-shut' : ''}`);
    head.setAttribute('aria-expanded', String(!shut));
    head.append(el('span', 'dg-caret', shut ? '\u25b8' : '\u25be'));
    head.append(el('span', 'dg-name', g.title));
    head.append(el('span', 'dg-n', String(g.rows.length)));
    head.addEventListener('click', () => {
      if (shut) { shutGroups.delete(g.key); shutGroups.add(`open:${g.key}`); }
      else { shutGroups.add(g.key); shutGroups.delete(`open:${g.key}`); }
      rerender();
    });
    wrap.append(head);
    // Rows are drawn only for an open group: a shut one may hold a thousand.
    if (!shut) wrap.append(rowsTable(g.rows));
  }

  function detail(d) {
    const wrap = el('div', 'import-detail');
    if (d.toggle === undefined) {
      wrap.append(el('h3', null, d.title));
      if (d.note) wrap.append(el('div', 'flag-note', d.note));
    } else {
      const head = el('div', 'detail-head');
      head.append(el('h3', null, d.title));
      if (d.toggle) {
        const t = d.toggle;
        const btn = el('button', `mini${on.has(t.id) ? ' on' : ''}`, t.label);
        btn.addEventListener('click', () => {
          if (on.has(t.id)) on.delete(t.id); else on.add(t.id);
          rerender();
        });
        head.append(btn);
      }
      wrap.append(head);
    }
    for (const g of d.groups ?? []) if (g.rows.length) group(wrap, g);
    return wrap;
  }

  function stats(list) {
    const grid = el('div', 'import-stats');
    for (const s of list) {
      const open = Boolean(s.detail) && openDetail === s.key;
      const c = el(s.detail ? 'button' : 'div', `stat${open ? ' is-open' : ''}`);
      c.append(el('b', null, String(s.n)), el('span', null, s.label));
      if (s.note) c.append(el('em', null, s.note));
      if (s.detail) {
        c.append(el('span', 'stat-more', open ? 'Hide' : 'Show all'));
        c.addEventListener('click', () => {
          openDetail = openDetail === s.key ? null : s.key;
          rerender();
        });
      }
      grid.append(c);
    }
    return grid;
  }

  function summary(s) {
    const wrap = el('div', 'import-diff');
    if (s.first) {
      wrap.append(el('span', 'id-first', s.first));
      return wrap;
    }
    wrap.append(el('b', null, s.lead));
    for (const p of s.parts ?? []) {
      if (!p.n) continue;
      const x = el('span', `id-part${p.cls ? ` ${p.cls}` : ''}`);
      x.append(el('b', null, String(p.n)), el('span', null, p.label));
      wrap.append(x);
    }
    if (s.after) wrap.append(el('span', 'id-part is-same', s.after));
    return wrap;
  }

  /** One collapsible concern: a heading, and every item under it with its fix. */
  function concern(c) {
    const open = openConcerns.has(c.id) || c.rows.length <= ALWAYS_OPEN;
    const wrap = el('div', `flag flag-${c.level}${open ? ' is-open' : ''}`);
    const bar = el('div', 'flag-bar');
    const head = el('button', 'flag-head');
    head.setAttribute('aria-expanded', String(open));
    head.append(el('span', 'flag-caret', open ? '\u25be' : '\u25b8'));
    // The count leads: the line's whole point is how many of these there are.
    head.append(el('span', 'flag-n', `${c.rows.length}\u00d7`));
    head.append(el('b', null, c.title));
    head.addEventListener('click', () => {
      if (openConcerns.has(c.id)) openConcerns.delete(c.id);
      else openConcerns.add(c.id);
      rerender();
    });
    bar.append(head);
    // One button for the whole list, where a row's own button does only that row.
    if (c.resolveAll && c.rows.length > 1) {
      const all = el('button', 'mini', `Resolve all ${c.rows.length}`);
      all.addEventListener('click', c.resolveAll);
      bar.append(all);
    }
    wrap.append(bar);
    if (c.note) wrap.append(el('div', 'flag-note', c.note));
    if (open) wrap.append(rowsTable(c.rows));
    return wrap;
  }

  function render(desc) {
    const box = el('div', 'import-review');
    box.append(el('h2', null, desc.title));
    if (desc.lede) box.append(el('div', 'lede', desc.lede));
    for (const n of desc.notes ?? []) box.append(el('div', n.cls, n.text));

    if (desc.stats?.length) box.append(stats(desc.stats));
    if (desc.summary) box.append(summary(desc.summary));
    const opened = desc.stats?.find((s) => s.key === openDetail && s.detail);
    if (opened) box.append(detail(opened.detail()));

    const concerns = (desc.concerns ?? []).filter((c) => c.rows.length);
    const total = concerns.reduce((n, c) => n + c.rows.length, 0);
    if (total) {
      const list = el('div', 'import-flags');
      list.append(el('h3', null, `Items of concern (${total})`));
      for (const c of concerns) list.append(concern(c));
      box.append(list);
    } else if (desc.clean) {
      box.append(el('div', 'import-clean', desc.clean));
    }

    const a = desc.actions;
    if (a) {
      const acts = el('div', 'import-actions');
      const apply = el('button', 'primary', a.apply.label);
      apply.addEventListener('click', a.apply.run);
      const cancel = el('button', 'ghost', a.cancel.label);
      cancel.addEventListener('click', a.cancel.run);
      acts.append(apply, cancel);
      if (total && a.hint) acts.append(el('span', 'hint', a.hint));
      box.append(acts);
    }
    return box;
  }

  return { render, isOn };
}
