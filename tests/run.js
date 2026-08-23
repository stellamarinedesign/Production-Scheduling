// tests/run.js — fixture tests for the transform layer.
//
// No build step and no Node in this environment, so these run in the browser,
// against the real 21/08/2026 export and the reference implementation's real
// output. The transform is only correct if it reproduces all 48 board rows and
// all 44 exclusion reasons exactly.

import { xlsxAdapter, validateColumns } from '../js/adapters/index.js';
import { buildBoard, toDateOnly, toAU, addWeeks } from '../js/transform.js';
import { resolveDisplays, aliasGroups, stellaCode, labelFor } from '../js/vessel-codes.js';
import { renderPrint, measure, fitToPage } from '../js/print.js';

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, a === e ? '' : `expected ${e}, got ${a}`);
}

/** Minimal RFC4180 CSV parse — quoted fields, embedded commas and newlines. */
function parseCSV(txt) {
  const rows = [[]];
  let field = '', quoted = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (quoted) {
      if (c === '"' && txt[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { rows.at(-1).push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { rows.at(-1).push(field); field = ''; rows.push([]); }
    else field += c;
  }
  rows.at(-1).push(field);
  if (rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop();
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

export async function run() {
  // ---- date normalisation -------------------------------------------------
  eq('toDateOnly: UTC-midnight Date', toDateOnly(new Date(Date.UTC(2026, 8, 3))), { y: 2026, m: 9, d: 3 });
  eq('toDateOnly: local-midnight Date', toDateOnly(new Date(2026, 8, 3)), { y: 2026, m: 9, d: 3 });
  eq('toDateOnly: ISO string', toDateOnly('2026-09-03'), { y: 2026, m: 9, d: 3 });
  eq('toDateOnly: AU string', toDateOnly('03/09/2026'), { y: 2026, m: 9, d: 3 });
  eq('toDateOnly: Excel serial', toDateOnly(46268), { y: 2026, m: 9, d: 3 });
  eq('toDateOnly: blank', toDateOnly(null), null);
  eq('toAU formats day-first', toAU({ y: 2026, m: 9, d: 3 }), '03/09/2026');
  eq('addWeeks 12 from 21/08', addWeeks({ y: 2026, m: 8, d: 21 }, 12), { y: 2026, m: 11, d: 13 });

  // ---- vessel codes -------------------------------------------------------
  eq('stellaCode anchors on RIV, not the first digit', stellaCode('SWD4PDRIV62SY'), '62SY');
  eq('stellaCode strips (24)', stellaCode('SLRIVSY22(24)'), 'SY22');
  eq('stellaCode strips /24', stellaCode('SRLRIV505/24'), '505');
  eq('stellaCode plain', stellaCode('SBLRIV56'), '56');

  const codeMap = await (await fetch('../data/vessel-codes.seed.json')).json();
  const resolved = resolveDisplays(codeMap);

  // The alias rule: codes sharing a Riviera model are the same boat.
  const groups = aliasGroups(codeMap);
  const groupOf = (c) => groups.find((g) => g.codes.includes(c));
  eq('43SY and SY20 group together (both Riviera 43SY)', groupOf('43SY').codes, ['43SY', 'SY20']);
  eq('56 and SY23 group together (both Riviera 56SY)', groupOf('56').codes, ['56', 'SY23']);
  check('56 and SY26 do NOT group (shared hull 5000, different models)',
    !groupOf('56').codes.includes('SY26'),
    `got ${JSON.stringify(groupOf('56').codes)}`);

  eq('43SY resolves to SY20 (confirmed entry wins)', resolved.display.get('43SY'), 'SY20');
  eq('SY20 stays SY20', resolved.display.get('SY20'), 'SY20');
  eq('SY23 stays 56SY', resolved.display.get('SY23'), '56SY');
  eq('56 stays 56SY', resolved.display.get('56'), '56SY');
  eq('SY22 stays SY22', resolved.display.get('SY22'), 'SY22');
  eq('505 stays Riv 505', resolved.display.get('505'), 'Riv 505');
  eq('no display conflicts in seed data', resolved.conflicts, []);
  eq('nothing left undecided after the alias fix', resolved.undecided, []);

  eq('helm seat box label follows the alias', labelFor('SHCELECPLINTHRIV43SY', resolved, codeMap), 'Helm Seat Box SY20');
  eq('garage door template', labelFor('SGDRIVSY22', resolved, codeMap), 'SY22 Garage Door');
  eq('boarding ladder template', labelFor('SBLRIV56', resolved, codeMap), 'Boarding Ladder 56SY');
  eq('watertight door template', labelFor('SWD4PDRIV62SY', resolved, codeMap), 'Watertight Door 62SY');

  // ---- the adapter --------------------------------------------------------
  const buf = await (await fetch('fixtures/export-20260821.xlsx')).arrayBuffer();
  const file = new File([buf], 'Production Order Maintenance 20260821.xlsx');
  const src = await xlsxAdapter.fetch({ file });

  eq('adapter reports its id', src.sourceId, 'xlsx');
  eq('adapter reports the filename', src.sourceLabel, 'Production Order Maintenance 20260821.xlsx');
  check('adapter stamps retrievedAt itself, not from the filename',
    /^\d{4}-\d{2}-\d{2}T/.test(src.retrievedAt) && !src.retrievedAt.startsWith('2026-08-21T00'),
    src.retrievedAt);
  eq('92 rows in', src.rows.length, 92);
  check('RawRow keys stay verbatim',
    Object.hasOwn(src.rows[0], 'Production Nbr.') && Object.hasOwn(src.rows[0], 'Qty. to Produce'),
    Object.keys(src.rows[0]).slice(0, 6).join(' | '));
  eq('no missing-column warnings on a good export',
    src.warnings.filter((w) => w.startsWith('Export is missing')), []);
  eq('missing columns are named, not swallowed',
    validateColumns([{ 'Production Nbr.': 1 }]).length, 1);

  // ---- the board ----------------------------------------------------------
  const expected = await (await fetch('fixtures/jobs.expected.json')).json();
  const board = buildBoard(src.rows, {
    codeMap,
    horizonWeeks: 12,
    asOf: { y: 2026, m: 8, d: 21 },
  });

  eq('48 jobs on the board', board.jobs.length, expected.job_count);
  eq('horizon end matches', board.meta.horizon_end, expected.horizon_end);

  // Every field the reference implementation emits, on every row, in order.
  const FIELDS = ['prod_no', 'category', 'description', 'label', 'inventory_id', 'customer',
    'is_stock', 'due_date', 'due_display', 'start_date', 'status', 'qty', 'hull',
    'customer_po', 'sales_order', 'notes', 'on_hold', 'hidden', 'hidden_reason'];

  const diffs = [];
  expected.jobs.forEach((exp, i) => {
    const got = board.jobs[i];
    if (!got) { diffs.push(`row ${i}: missing (expected ${exp.prod_no})`); return; }
    for (const f of FIELDS) {
      // The one deliberate difference: 43SY now follows SY20 per Pete's ruling,
      // so the helm seat box label changed. Assert the new value explicitly.
      if (f === 'label' && exp.inventory_id === 'SHCELECPLINTHRIV43SY') {
        if (got.label !== 'Helm Seat Box SY20') diffs.push(`row ${i} ${exp.prod_no}.label: expected alias fix 'Helm Seat Box SY20', got ${JSON.stringify(got.label)}`);
        continue;
      }
      // The reference implementation wrote `str(NaN)` into empty cells, so all
      // 7 stock builds carry the literal string "nan" as their sales order.
      // Stock is internal and has no sales order; null is the right answer and
      // "nan" is a defect in the fixture, not a rule.
      if (exp[f] === 'nan') {
        if (got[f] !== null) diffs.push(`row ${i} ${exp.prod_no}.${f}: expected null (fixture has the str(NaN) bug), got ${JSON.stringify(got[f])}`);
        continue;
      }
      if (JSON.stringify(got[f]) !== JSON.stringify(exp[f])) {
        diffs.push(`row ${i} ${exp.prod_no}.${f}: expected ${JSON.stringify(exp[f])}, got ${JSON.stringify(got[f])}`);
      }
    }
  });
  check('every board row matches the reference output', diffs.length === 0, diffs.slice(0, 12).join('\n'));

  // ---- exclusions ---------------------------------------------------------
  const expExcl = parseCSV(await (await fetch('fixtures/excluded.expected.csv')).text());
  eq('44 rows excluded', board.excluded.length, expExcl.length);

  const key = (e) => `${e.prod_no}|${e.inventory_id}|${e.reason}`;
  const gotSet = new Set(board.excluded.map(key));
  const missing = expExcl.filter((e) => !gotSet.has(key(e))).map(key);
  check('every exclusion reason matches the reference', missing.length === 0, missing.slice(0, 8).join('\n'));

  check('the COMMISSION ordering trap holds',
    board.excluded.filter((e) => e.inventory_id.includes('COMMISSION')).length === 15
    && !board.jobs.some((j) => j.inventory_id.includes('COMMISSION')),
    `${board.excluded.filter((e) => e.inventory_id.includes('COMMISSION')).length} commissioning rows excluded`);

  // ---- horizon sensitivity (BOARD_SPEC §2) --------------------------------
  const asOf = { y: 2026, m: 8, d: 21 };
  const counts = {};
  for (const w of [4, 6, 8, 10, 12]) {
    counts[w] = buildBoard(src.rows, { codeMap, horizonWeeks: w, asOf }).jobs.length;
  }
  eq('horizon curve matches the documented sensitivity', counts, { 4: 26, 6: 33, 8: 37, 10: 39, 12: 48 });
  eq('unlimited horizon shows 49',
    buildBoard(src.rows, { codeMap, horizonWeeks: null, asOf }).jobs.length, 49);

  // ---- stock --------------------------------------------------------------
  const stock = board.jobs.filter((j) => j.is_stock);
  eq('7 stock builds', stock.length, 7);
  check('stock shows STOCK, not a date', stock.every((j) => j.due_display === 'STOCK'), '');
  check('stock ignores the horizon',
    buildBoard(src.rows, { codeMap, horizonWeeks: 4, asOf }).jobs.filter((j) => j.is_stock).length === 7, '');
  check('stock sorts last within its category',
    (() => {
      const d = board.jobs.filter((j) => j.category === 'Davits');
      return d.findIndex((j) => j.is_stock) === d.length - d.filter((j) => j.is_stock).length;
    })(), '');

  const capped = buildBoard(src.rows, { codeMap, horizonWeeks: 12, asOf, maxStock: 3 });
  eq('stock cap trims to 3 per category',
    capped.jobs.filter((j) => j.is_stock && j.category === 'Davits').length, 3);
  check('capped rows are excluded with a reason, not dropped',
    capped.excluded.some((e) => e.reason.includes('stock cap')), '');

  // ---- overrides ----------------------------------------------------------
  const ov = buildBoard(src.rows, {
    codeMap, horizonWeeks: 12, asOf,
    overrides: { P01093: { hidden: true, hiddenReason: 'waiting on parts' }, P01092: { labelOverride: 'Custom label' } },
  });
  const hidden = ov.jobs.find((j) => j.prod_no === 'P01093');
  check('a hidden job stays in the record but off the count',
    hidden.hidden === true && hidden.hidden_reason === 'waiting on parts' && ov.meta.job_count === 47, '');
  const relabelled = ov.jobs.find((j) => j.prod_no === 'P01092');
  check('a label override applies and keeps the original for reset',
    relabelled.label === 'Custom label' && relabelled.base_label === 'SY22 Launcher', '');

  // ---- warnings -----------------------------------------------------------
  eq('no unmapped prefixes in this export', board.warnings.unmapped, []);
  eq('no On Hold jobs on this board', board.warnings.onHold.length, 0);

  const held = buildBoard(
    src.rows.map((r) => (r['Production Nbr.'] === 'P01093' ? { ...r, Status: 'On Hold' } : r)),
    { codeMap, horizonWeeks: 12, asOf },
  );
  eq('an On Hold job is flagged, not hidden', held.warnings.onHold.length, 1);
  check('On Hold only warns for jobs that would actually appear',
    buildBoard(
      src.rows.map((r) => (r['Production Nbr.'] === 'P01093' ? { ...r, Status: 'On Hold' } : r)),
      { codeMap, horizonWeeks: 12, asOf, overrides: { P01093: { hidden: true } } },
    ).warnings.onHold.length === 0, '');

  // ---- print layout + auto-fit -------------------------------------------
  // A real A4-sized host, laid out but off-screen, so heights are truthful.
  const host = document.createElement('div');
  host.id = 'printPreview';
  const shell = document.createElement('div');
  shell.id = 'printRoot';
  shell.style.cssText = 'position:absolute; left:-100000px; top:0; visibility:hidden;';
  shell.append(host);
  document.body.append(shell);

  renderPrint(host, board);
  const cols = [...host.querySelectorAll('.grid > .col')].map(
    (c) => [...c.querySelectorAll('.banner')].map((b) => b.textContent));
  eq('left column: cylinder lifters then ladders', cols[0], ['CYLINDER LIFTERS', 'LADDERS AND CHAIRS']);
  eq('right column: launchers then rotary', cols[1], ['LAUNCHERS, DOORS & CHOCKS', 'ROTARY LIFTERS']);
  eq('davits runs full width underneath',
    [...host.querySelectorAll('.full .banner')].map((b) => b.textContent), ['DAVITS']);
  eq('three columns per table', host.querySelector('thead tr:nth-child(2)').children.length, 3);
  eq('print header carries the covered range, not just the run date',
    host.querySelector('.doc-range').textContent.trim(), 'as of:  21/08/2026  —  13/11/2026');
  check('the Riviera PO never reaches the printed board',
    !/PO/.test(host.textContent) && !host.textContent.includes('REDACTED'), '');
  eq('hidden jobs do not print', (() => {
    const h = buildBoard(src.rows, { codeMap, horizonWeeks: 12, asOf, overrides: { P01093: { hidden: true } } });
    renderPrint(host, h);
    return host.textContent.includes('P01093');
  })(), false);

  renderPrint(host, board);
  const m = measure(host);
  check('48 jobs measure inside one A4 page', m.measured && m.fits, `${m.height}px of ${m.limit}px`);

  // An unlaid-out host reports zero height, which reads as a comfortable fit.
  // It must say "unmeasurable" instead — silently blessing a three-page board
  // is the worst failure this code has.
  shell.style.display = 'none';
  const dead = measure(host);
  check('an unmeasurable host never reports a fit', dead.measured === false && dead.fits === false, JSON.stringify(dead));
  shell.style.display = '';

  // Auto-fit must actually trim. Triple the rows so no horizon short of a
  // real trim will fit.
  const fat = [...src.rows, ...src.rows.map((r, i) => ({ ...r, 'Production Nbr.': `X${i}` })),
    ...src.rows.map((r, i) => ({ ...r, 'Production Nbr.': `Y${i}` }))];
  const fit = fitToPage(host, (w) => buildBoard(fat, { codeMap, horizonWeeks: w, asOf }), { startWeeks: 12, minWeeks: 4 });
  check('auto-fit trims an oversized board', fit.trimmedFrom === 12 && fit.weeks < 12, JSON.stringify({ weeks: fit.weeks, fits: fit.fits, steps: fit.steps.length }));
  check('auto-fit refuses to go below the floor', fit.weeks >= 4, String(fit.weeks));

  const noTrim = fitToPage(host, (w) => buildBoard(src.rows, { codeMap, horizonWeeks: w, asOf }), { startWeeks: 12, minWeeks: 4 });
  check('auto-fit leaves a board that already fits alone',
    noTrim.trimmedFrom === null && noTrim.weeks === 12 && noTrim.fits, JSON.stringify({ weeks: noTrim.weeks, fits: noTrim.fits }));

  shell.remove();

  const unmapped = buildBoard(
    [...src.rows, { ...src.rows[0], 'Production Nbr.': 'P99999', 'Inventory ID': 'SZZNEWTHING' }],
    { codeMap, horizonWeeks: 12, asOf },
  );
  eq('an unknown prefix is excluded loudly, never silently', unmapped.warnings.unmapped.length, 1);

  return results;
}
