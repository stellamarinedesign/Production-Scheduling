// ask.js - the app's own question, in place of the browser's prompt and confirm.
//
// A title, what it is about, the fields, and buttons that say what they do.
// The dialog stays up while the answer is saved, so a refusal is said where it
// was typed and nothing has to be typed again.

import { closeOnBackdrop } from './dialog.js';
import { busy } from './busy.js';
import { refuse, accept } from './field.js';
import { failure } from './words.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

let seq = 0;

/**
 * Ask, and wait for the answer.
 *
 * @param {object} q
 * @param {string} q.title
 * @param {string} [q.lede]
 * @param {Array<[string, string]>} [q.facts]   read-only lines, name and value
 * @param {Array<object>} [q.fields]   { key, label, value, options, hint, placeholder, check }
 *        `options` ([{ value, label }]) makes it a list to pick from; `check(value)`
 *        returns why a value is refused, or nothing
 * @param {Array<object>} q.actions    { value, label, kind, busy, run }
 *        `kind` 'primary' | 'danger' | 'ghost' (the default). `run(values, say)` saves
 *        while the button reads `busy`; if it throws, the dialog stays and says so
 * @param {string} [q.failed]          what a failed `run` did not do: "Name not saved"
 * @param {boolean} [q.wide]
 * @returns {Promise<{action: any, values: Object}|null>}  null when closed without an answer
 */
export function ask(q) {
  return new Promise((resolve) => {
    const overlay = el('div', 'overlay');
    const box = el('div', `box${q.wide ? ' wide' : ''} ask`);
    box.append(el('h3', null, q.title));
    if (q.lede) box.append(el('div', 'lede', q.lede));
    if (q.facts?.length) {
      const d = el('div', 'derived');
      for (const [k, v] of q.facts) {
        const r = el('div', 'row');
        r.append(el('span', null, k), el('span', null, v || '\u2014'));
        d.append(r);
      }
      box.append(d);
    }

    const inputs = new Map();
    for (const f of q.fields ?? []) {
      const wrap = el('div', 'field');
      const id = `ask${++seq}`;
      const label = el('label', null, f.label);
      label.htmlFor = id;
      let input;
      if (f.options) {
        input = el('select');
        for (const o of f.options) {
          const opt = el('option', null, o.label ?? o.value);
          opt.value = o.value;
          opt.selected = o.value === f.value;
          input.append(opt);
        }
      } else {
        input = el('input');
        input.type = 'text';
        input.value = f.value ?? '';
        input.autocomplete = 'off';
        input.spellcheck = false;
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      input.id = id;
      wrap.append(label, input);
      if (f.hint) wrap.append(el('div', 'hint', f.hint));
      box.append(wrap);
      inputs.set(f.key, { f, input });
    }

    const err = el('div', 'form-err');
    err.setAttribute('role', 'alert');
    box.append(err);

    const acts = el('div', 'actions');
    box.append(acts);
    overlay.append(box);

    const values = () => Object.fromEntries([...inputs].map(([k, { input }]) => [k, input.value.trim()]));
    let working = false;
    const finish = (answer) => {
      overlay.classList.remove('show');
      // Gone once the focus has been handed back.
      setTimeout(() => overlay.remove(), 0);
      resolve(answer);
    };
    const giveUp = () => { if (!working) finish(null); };

    const answer = async (a, btn) => {
      if (working) return;
      err.textContent = '';
      const v = values();
      // Only an action that saves something needs the fields to hold.
      if (a.run || a.kind === 'primary' || a.kind === 'danger') {
        for (const { f, input } of inputs.values()) {
          accept(input);
          const why = f.check?.(input.value.trim());
          if (why) { refuse(input, why); return; }
        }
      }
      if (!a.run) { finish({ action: a.value, values: v }); return; }
      working = true;
      try {
        await busy(btn, a.busy ?? 'Saving\u2026', (say) => a.run(v, say));
        working = false;
        finish({ action: a.value, values: v });
      } catch (e) {
        working = false;
        err.textContent = e?.words ?? failure(q.failed ?? 'Not saved', e);
      }
    };

    let first = null;
    for (const a of q.actions) {
      const btn = el('button', a.kind === 'primary' ? 'primary' : `ghost${a.kind === 'danger' ? ' danger' : ''}`, a.label);
      btn.type = 'button';
      btn.addEventListener('click', () => (a.close ? giveUp() : answer(a, btn)));
      acts.append(btn);
      if (!first && !a.close) first = { a, btn };
    }
    for (const { input } of inputs.values()) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.tagName === 'INPUT' && first) { e.preventDefault(); answer(first.a, first.btn); }
      });
    }

    document.body.append(overlay);
    closeOnBackdrop(overlay, giveUp);
    overlay.classList.add('show');
    const one = [...inputs.values()][0]?.input;
    if (one) { one.focus(); one.select?.(); }
  });
}

/**
 * A choice between two outcomes, each named by its button.
 * @returns {Promise<boolean>} true when the first was chosen
 */
export async function choose({ title, lede, facts, yes, no, danger = false, run, busyLabel, failed }) {
  const got = await ask({
    title, lede, facts, failed,
    actions: [
      { value: true, label: yes, kind: danger ? 'danger' : 'primary', run, busy: busyLabel },
      { value: false, label: no, close: true },
    ],
  });
  return got?.action === true;
}
