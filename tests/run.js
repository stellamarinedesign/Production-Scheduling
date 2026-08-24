// tests/run.js — fixture tests for the transform layer.
//
// No build step and no Node in this environment, so these run in the browser,
// against the real 21/08/2026 export and the reference implementation's real
// output. The transform is only correct if it reproduces all 48 board rows and
// all 44 exclusion reasons exactly.

import { xlsxAdapter, validateColumns } from '../js/adapters/index.js';
import { buildBoard, toDateOnly, toAU, toISO, addWeeks } from '../js/transform.js';
import { resolveDisplays, aliasGroups, stellaCode, labelFor, detectNewCodes,
         existingBoats, acceptNewCode, applyTemplate } from '../js/vessel-codes.js';
import { renderPrint, measure, fitToPage, balanceColumns } from '../js/print.js';
import { ganttLayout, packLanes, renderGantt as renderGanttChart } from '../js/gantt.js';

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

/**
 * The fixtures are the real ERP export and its reference output — customer
 * names, Riviera PO numbers, sales orders, hull numbers, internal notes. They
 * are gitignored and never leave the workshop, so a clone of the public repo
 * does not have them. Say so plainly rather than failing.
 *
 * To run these: copy from the private handoff folder into tests/fixtures/ —
 *   Production Order Maintenance 20260821.xlsx  ->  export-20260821.xlsx
 *   jobs.json                                   ->  jobs.expected.json
 *   jobs_excluded.csv                           ->  excluded.expected.csv
 */
async function fixturesPresent() {
  try {
    // no-store, or a cached 200 from a previous run reports fixtures that are
    // no longer on disk and the suite fails halfway through instead of skipping.
    const r = await fetch('fixtures/export-20260821.xlsx', { method: 'HEAD', cache: 'no-store' });
    return r.ok;
  } catch { return false; }
}

export async function run() {
  if (!await fixturesPresent()) return { skipped: true };

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

  // Boat grouping is MANUAL. The codes are not managed consistently upstream,
  // so no derived signal is authoritative: 56 is office shorthand for 56SY and
  // groups with SY23, while SY26 is the 5000 and stands alone — despite 56
  // carrying 5000 as a hull prefix, which is exactly the trap.
  const groups = aliasGroups(codeMap);
  const groupOf = (c) => groups.find((g) => g.codes.includes(c));
  eq('43SY and SY20 are one boat', groupOf('43SY').codes, ['43SY', 'SY20']);
  eq('56 and SY23 are the 56SY', groupOf('56').codes, ['56', 'SY23']);
  eq('SY26 is the 5000 — a DIFFERENT boat', groupOf('SY26').codes, ['SY26']);

  // A human must be able to SPLIT as well as merge: two codes sharing a model
  // but assigned to different boats stay apart.
  eq('an explicit boat assignment overrides a shared model',
    aliasGroups({
      A: { riviera: ['66SY'], boat: 'one' },
      B: { riviera: ['66SY'], boat: 'two' },
    }).map((g) => g.codes), [['A'], ['B']]);
  // ...and an unassigned pair still gets the model as a suggestion.
  eq('a shared model still groups codes nobody has assigned',
    aliasGroups({ A: { riviera: ['66SY'] }, B: { riviera: ['66SY'] } })[0].codes, ['A', 'B']);

  eq('43SY follows SY20', resolved.display.get('43SY'), 'SY20');
  eq('SY20 stays SY20', resolved.display.get('SY20'), 'SY20');
  eq('SY23 stays 56SY', resolved.display.get('SY23'), '56SY');
  eq('56 stays 56SY', resolved.display.get('56'), '56SY');
  // Global code preference, per boat: the 56SY prefers the Riviera model over
  // Stella's SY23; the 5000 prefers Stella's SY26 over Riviera's 5000SY. There
  // is no rule — each was decided by hand.
  eq('SY26 prints SY26, not 56SY and not 5000', resolved.display.get('SY26'), 'SY26');
  eq('the SY26 lifter is a different product from the 56SY lifter',
    [labelFor('SLRIVSY26(24)', resolved, codeMap), labelFor('SLRIVSY23(24)', resolved, codeMap)],
    ['SY26', '56SY']);
  // A 56SY ladder fitted to an SY26 hull is still a 56SY ladder: the item code
  // carries the boat, and the hull is never displayed.
  eq('a 56SY ladder prints 56SY whatever hull it lands on',
    labelFor('SBLRIV56', resolved, codeMap), 'Boarding Ladder 56SY');
  eq('SY22 stays SY22', resolved.display.get('SY22'), 'SY22');
  eq('505 stays Riv 505', resolved.display.get('505'), 'Riv 505');
  eq('no display conflicts in seed data', resolved.conflicts, []);
  eq('nothing left undecided', resolved.undecided, []);

  eq('helm seat box follows its boat', labelFor('SHCELECPLINTHRIV43SY', resolved, codeMap), 'Helm Seat Box SY20');
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

  // The reference implementation dropped every `Component Part`. Two of them are
  // real workshop jobs, so the board is now 50 rows where the fixture has 48.
  eq('50 jobs on the board — 48 from the reference plus 2 real component parts',
    board.jobs.length, expected.job_count + 2);
  eq('horizon end still computed', board.meta.horizon_end, expected.horizon_end);

  const componentJobs = board.jobs.filter((j) => j.is_component);
  eq('the two component parts that are real jobs are on the board',
    componentJobs.map((j) => j.inventory_id).sort(),
    ['SHCELECPLINTHRIV43SY', 'SWD4PDRIV62SY']);
  eq('...in their proper categories',
    componentJobs.map((j) => j.category).sort(),
    ['Ladders and Chairs', 'Launchers, Doors & Chocks']);
  eq('...labelled through the usual rules, not their raw description',
    componentJobs.map((j) => j.label).sort(),
    ['Helm Seat Box SY20', 'Watertight Door 62SY']);
  eq('the other 7 component parts are still out, on category alone',
    board.excluded.filter((e) => /^ST/.test(e.inventory_id) && e.kind === 'category').length >= 7, true);
  eq('nothing is dropped for being a component part any more',
    board.excluded.filter((e) => /component part/i.test(e.reason)), []);

  // Every field the reference implementation emits, on every row, in order.
  const FIELDS = ['prod_no', 'category', 'description', 'label', 'inventory_id', 'customer',
    'is_stock', 'due_date', 'due_display', 'start_date', 'status', 'qty', 'hull',
    'customer_po', 'sales_order', 'notes', 'on_hold', 'hidden', 'hidden_reason'];

  // Match on production number rather than position: the two component parts
  // sort into the middle of their categories and would shift every index.
  const gotByProd = new Map(board.jobs.map((j) => [j.prod_no, j]));
  const diffs = [];
  expected.jobs.forEach((exp, i) => {
    const got = gotByProd.get(exp.prod_no);
    if (!got) { diffs.push(`${exp.prod_no}: on the reference board but missing here`); return; }
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
      // Custom jobs now say so: "Riviera 48" alone reads as a standard model.
      if (f === 'label' && /CUSTOM/i.test(exp.inventory_id)) {
        if (got.label !== `Custom Lifter - ${exp.label}`) {
          diffs.push(`${exp.prod_no}.label: expected "Custom Lifter - ${exp.label}", got ${JSON.stringify(got.label)}`);
        }
        continue;
      }
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
  eq('42 rows excluded — the reference 44 less the 2 now kept',
    board.excluded.length, expExcl.length - 2);

  // Reasons are worded for the manager now, so compare on what was excluded and
  // why in kind, not on the exact sentence.
  const gotExcl = new Map(board.excluded.map((e) => [e.prod_no, e]));
  const wrong = [];
  for (const e of expExcl) {
    if (/component part/i.test(e.reason)) continue;          // deliberately kept now
    const got = gotExcl.get(e.prod_no);
    if (!got) { wrong.push(`${e.prod_no} should be excluded (${e.reason})`); continue; }
    if (got.inventory_id !== e.inventory_id) wrong.push(`${e.prod_no} inventory id differs`);
  }
  check('everything the reference excluded is still excluded', wrong.length === 0, wrong.slice(0, 8).join('\n'));

  // ---- excluded ordering --------------------------------------------------
  const capped2 = buildBoard(src.rows, {
    codeMap, horizonWeeks: 12, asOf: { y: 2026, m: 8, d: 21 }, maxStock: 2 });
  const kinds = capped2.excluded.map((e) => e.kind);
  const firstOf = (k) => kinds.indexOf(k);
  check('horizon cuts sort first, then the stock cap, then the rest',
    firstOf('horizon') === 0
    && firstOf('stockCap') > firstOf('horizon')
    && firstOf('category') > firstOf('stockCap'),
    kinds.join(','));
  eq('every excluded row carries the item description field',
    capped2.excluded.every((e) => 'item_description' in e), true);

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
  // The documented curve was 4->26, 6->33, 8->37, 10->39, 12->48, none->49.
  // Each figure gains the component parts that fall inside that horizon.
  eq('horizon curve still climbs with the documented shape',
    Object.values(counts).every((n, i, a) => i === 0 || n >= a[i - 1]), true);
  eq('12 weeks shows 50', counts[12], 50);
  eq('unlimited horizon shows 51',
    buildBoard(src.rows, { codeMap, horizonWeeks: null, asOf }).jobs.length, 51);

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
    capped.excluded.some((e) => e.kind === 'stockCap'), '');

  // ---- overrides ----------------------------------------------------------
  const ov = buildBoard(src.rows, {
    codeMap, horizonWeeks: 12, asOf,
    overrides: { P01093: { hidden: true, hiddenReason: 'waiting on parts' }, P01092: { labelOverride: 'Custom label' } },
  });
  const hidden = ov.jobs.find((j) => j.prod_no === 'P01093');
  check('a hidden job stays in the record but off the count',
    hidden.hidden === true && hidden.hidden_reason === 'waiting on parts' && ov.meta.job_count === 49, '');
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

  // ---- new vessel codes ---------------------------------------------------
  eq('a fully-known export raises no new codes', detectNewCodes(src.rows, codeMap), []);

  const withNew = [...src.rows, {
    ...src.rows.find((r) => String(r['Inventory ID']).startsWith('SGDRIV')),
    'Production Nbr.': 'P99001',
    'Inventory ID': 'SGDRIVSY31',
    'Production Description': 'Hydraulic Garage Door Opening System - Riviera 78SY - Used by 78SY/002',
    // Both free-text fields, or the hull scan finds the donor row's 68SY first.
    Description: 'Used by 78SY/002',
  }];
  const fresh = detectNewCodes(withNew, codeMap);
  eq('an unseen code is detected', fresh.map((f) => f.code), ['SY31']);
  eq('...with the Stella code it would use', fresh[0].suggestion.stella, 'SY31');
  eq('...and the Riviera model from the description', fresh[0].suggestion.riviera, '78SY');
  eq('...and the hull prefix', fresh[0].hull_prefix, ['78SY']);

  // The four choices.
  eq('choosing the Stella code', acceptNewCode('SY31', { mode: 'stella' }, fresh[0]).display, 'SY31');
  eq('choosing the Riviera model', acceptNewCode('SY31', { mode: 'riviera' }, fresh[0]).display, '78SY');
  eq('choosing a custom code', acceptNewCode('SY31', { mode: 'custom', value: '78 Sport' }, fresh[0]).display, '78 Sport');

  // Joining an existing boat sets no display of its own — it inherits the
  // group's, which is the whole point of joining rather than re-typing.
  const joined = acceptNewCode('SY31', { mode: 'existing', boat: '56SY' }, fresh[0]);
  eq('joining an existing boat sets no display of its own', joined.display, undefined);
  eq('...it takes the boat key instead', joined.boat, '56SY');
  eq('...and then resolves to the display of the boat it joined',
    resolveDisplays({ ...codeMap, SY31: joined }).display.get('SY31'), '56SY');

  check('a new code is never auto-added to the map',
    !Object.hasOwn(codeMap, 'SY31'), 'detectNewCodes must not mutate the map');

  eq('existing boats are offered for the dropdown, one entry per boat',
    existingBoats(codeMap).map((b) => `${b.display}:${b.codes.join('+')}`),
    ['56SY:56+SY23', '62SY:62SY', 'FB31:FB31', 'Riv 505:505', 'Riv 64:64',
     'SU12:SU12', 'SY20:43SY+SY20', 'SY22:SY22', 'SY26:SY26']);

  // A conflict is surfaced, never silently resolved.
  const clash = resolveDisplays({
    A: { riviera: ['9SY'], boat: 'x', display: 'AAA', _confirmed: true },
    B: { riviera: ['9SY'], boat: 'x', display: 'BBB', _confirmed: true },
  });
  eq('two confirmed answers for one boat is a conflict', clash.conflicts.length, 1);

  // ---- custom lifters -----------------------------------------------------
  const customs = board.jobs.filter((j) => /CUSTOM/i.test(j.inventory_id));
  eq('every custom job says it is one', customs.length > 0
    && customs.every((j) => j.label.startsWith('Custom Lifter - ')), true);
  eq('...taking the vessel from the Description field where there is one',
    customs.find((j) => j.inventory_id === 'SLCUSTOMSINGLE(12)')?.label,
    'Custom Lifter - Riviera 48');
  eq('...and the customer name where that field holds something else',
    customs.find((j) => j.inventory_id === 'SLCUSTOMDOUBLE(24)')?.label,
    'Custom Lifter - GALAXY');

  // ---- column balancing ---------------------------------------------------
  // 19 cylinder lifters against 5 rotary: pinning two-and-two wastes a column.
  const balanced = balanceColumns({
    'Cylinder lifters': 19, 'Ladders and Chairs': 6,
    'Launchers, Doors & Chocks': 7, 'Rotary Lifters': 5,
  });
  const cost = (set, c) => set.reduce((n, k) => n + c[k] + 2, 0);
  const C = { 'Cylinder lifters': 19, 'Ladders and Chairs': 6, 'Launchers, Doors & Chocks': 7, 'Rotary Lifters': 5 };
  check('balancing beats the old pinned layout',
    Math.max(cost(balanced.left, C), cost(balanced.right, C))
      < Math.max(cost(['Cylinder lifters', 'Ladders and Chairs'], C),
                 cost(['Launchers, Doors & Chocks', 'Rotary Lifters'], C)),
    `${JSON.stringify(balanced)}`);
  eq('the 19-row category gets a column to itself',
    balanced.left.length === 1 || balanced.right.length === 1, true);
  eq('an empty category is not given a table',
    balanceColumns({ 'Cylinder lifters': 4, 'Ladders and Chairs': 0,
      'Launchers, Doors & Chocks': 0, 'Rotary Lifters': 0 }),
    { left: [], right: ['Cylinder lifters'] });

  // ---- three scopes -------------------------------------------------------
  // Boat, item and job are different things. The case that forces the middle
  // one: an item code naming one boat for a part built to the drawings of
  // another. Nothing about the boat is wrong, and it is not a one-off.
  eq('template applies a code to an item', applyTemplate('SBLRIVSY26', '56SY'), 'Boarding Ladder 56SY');
  eq('template passes through an item with no wording rule', applyTemplate('SDC200FOLD', 'X'), 'X');

  const scoped = (itemOverrides, overrides = {}) =>
    buildBoard(src.rows, { codeMap, horizonWeeks: 12, asOf, itemOverrides, overrides });

  const lifterSY26 = (b) => b.jobs.find((j) => j.inventory_id === 'SLRIVSY26(24)');
  const ladder56 = (b) => b.jobs.find((j) => j.inventory_id === 'SBLRIV56');

  eq('by default an item follows its boat', lifterSY26(scoped({})).label, 'SY26');

  // Item scope pins the CODE and keeps the product wording.
  const pinnedCode = scoped({ 'SBLRIV56': { displayCode: 'SY26' } });
  eq('an item override changes the code, not the wording',
    ladder56(pinnedCode).label, 'Boarding Ladder SY26');
  eq('...and leaves every other item on that boat alone',
    pinnedCode.jobs.find((j) => j.inventory_id === 'SLRIVSY23(24)').label, '56SY');
  eq('...and leaves the boat itself alone', pinnedCode.resolved.display.get('56'), '56SY');

  // Item scope can also pin a whole label, for items with no vessel code.
  eq('an item override can pin a whole label',
    scoped({ 'SDC200FOLD': { label: 'Folding Davit 200kg' } })
      .jobs.find((j) => j.inventory_id === 'SDC200FOLD').label, 'Folding Davit 200kg');

  // Precedence: job beats item beats boat.
  const both = scoped(
    { 'SBLRIV56': { displayCode: 'SY26' } },
    { [ladder56(scoped({})).prod_no]: { labelOverride: 'One-off' } },
  );
  eq('a job override beats an item override', ladder56(both).label, 'One-off');
  eq('...and the item override is still what it falls back to',
    ladder56(both).base_label, 'Boarding Ladder SY26');

  // An item override beats the built-in LABEL_OVERRIDES table.
  eq('an item override beats the built-in label table',
    scoped({ 'SDC550SSHLHSHE': { label: 'Davit, 550 full hyd' } })
      .jobs.find((j) => j.inventory_id === 'SDC550SSHLHSHE').label, 'Davit, 550 full hyd');

  eq('the override is carried on the job so the UI can show it',
    Boolean(ladder56(pinnedCode).item_override), true);

  // ---- gantt --------------------------------------------------------------
  const gJobs = board.jobs.filter((j) => !j.hidden);
  const g = ganttLayout(gJobs, { asOf });

  eq('every job is either charted or listed, none lost',
    g.groups.flatMap((x) => x.rows).length + g.unscheduled.length, gJobs.length);
  eq('bands follow board order, not date order',
    g.groups.map((x) => x.category),
    ['Launchers, Doors & Chocks', 'Cylinder lifters', 'Ladders and Chairs', 'Rotary Lifters', 'Davits']);
  check('within a band, earliest start first',
    g.groups.every((x) => x.rows.every((r, i, a) => i === 0 || a[i - 1].start_date <= r.start_date)), '');

  // The window is driven by committed work. Every stock build on this export
  // has dates months in the past; letting them set the left edge stretched the
  // chart from 16 weeks to 35 and halved every bar.
  const stockStarts = gJobs.filter((j) => j.is_stock).map((j) => j.start_date).sort();
  check('the window ignores stale stock dates',
    toISO(g.start) > stockStarts[0], `window starts ${toISO(g.start)}, earliest stock ${stockStarts[0]}`);
  eq('...and everything it cannot place is listed instead',
    g.unscheduled.length, gJobs.filter((j) => j.is_stock).length);
  check('the listed ones really do sit outside the window',
    g.unscheduled.every((r) => r.end_date < toISO(g.start) || r.start_date >= toISO(g.end)), '');

  check('every drawn bar sits inside the chart', g.groups.flatMap((x) => x.rows)
    .every((r) => r.leftPct >= 0 && r.leftPct + r.widthPct <= 100.001), '');
  check('no bar is invisible', g.groups.flatMap((x) => x.rows).every((r) => r.widthPct > 0), '');
  check('today is on the chart', g.todayPct >= 0 && g.todayPct <= 100, String(g.todayPct));
  check('the window starts on a Monday',
    new Date(Date.UTC(g.start.y, g.start.m - 1, g.start.d)).getUTCDay() === 1, toISO(g.start));

  // A job whose end date has passed and which is still open. Nothing else in
  // the app surfaces this — the board sorts by due date, so it just looks like
  // the top row.
  eq('overdue counts jobs whose end date has passed',
    g.overdue, g.groups.flatMap((x) => x.rows).filter((r) => r.end_date < toISO(asOf) && !r.is_stock).length);
  check('overdue is more than nothing on this export', g.overdue > 0, String(g.overdue));
  check('stock is never called overdue — it carries no promised date',
    g.groups.flatMap((x) => x.rows).every((r) => !(r.is_stock && r.overdue)), '');

  // Bar geometry, on a window we control exactly.
  const synth = ganttLayout([
    { prod_no: 'A', label: 'A', category: 'Davits', start_date: '2026-01-05', end_date: '2026-01-11', is_stock: false },
    { prod_no: 'B', label: 'B', category: 'Davits', start_date: '2026-01-12', end_date: '2026-01-18', is_stock: false },
  ], { asOf: { y: 2026, m: 1, d: 12 } });
  eq('two flush weeks span the whole chart', synth.totalDays, 14);
  eq('the first week is the first half', Math.round(synth.groups[0].rows[0].widthPct), 50);
  eq('the second starts at the midpoint', Math.round(synth.groups[0].rows[1].leftPct), 50);
  eq('a same-day job still gets a day of width',
    Math.round(ganttLayout([{ prod_no: 'X', label: 'X', category: 'Davits',
      start_date: '2026-01-05', end_date: '2026-01-05', is_stock: false }],
      { asOf: { y: 2026, m: 1, d: 5 } }).groups[0].rows[0].widthPct), 14);

  eq('no jobs means no chart, not a crash', ganttLayout([], { asOf }).groups, []);
  eq('a job with no dates is counted, not dropped',
    ganttLayout([{ prod_no: 'N', label: 'N', category: 'Davits', start_date: null, end_date: null }],
      { asOf }).undated, 1);

  // ---- completion ---------------------------------------------------------
  // The handoff assumed finished work never arrives, because the ERP filter
  // drops Completed/Canceled/Closed. That holds only while the ERP status
  // actually flips; a job finished on the floor and never closed stays
  // In Process in every export after it, and the board accumulates it forever.
  const doneNo = board.jobs[0].prod_no;
  const withDone = buildBoard(src.rows, {
    codeMap, horizonWeeks: 12, asOf,
    overrides: { [doneNo]: { completed: true, completedAt: '2026-08-20T01:00:00.000Z', completedBy: 'x@y' } },
  });
  check('a completed job leaves the board', !withDone.jobs.some((j) => j.prod_no === doneNo), '');
  eq('...and lands in history', withDone.completed.map((j) => j.prod_no), [doneNo]);
  eq('...carrying who and when', withDone.completed[0].completed_by, 'x@y');
  eq('...counted out of the board total', withDone.meta.job_count, board.meta.job_count - 1);
  eq('...and reads as fully done for the bar fill', withDone.completed[0].progress, 1);

  // Completion is checked ahead of the horizon, or a job finished months ago
  // would be a horizon exclusion and never reach History at all.
  const oldJob = board.excluded.find((e) => e.kind === 'horizon');
  if (oldJob) {
    const farDone = buildBoard(src.rows, {
      codeMap, horizonWeeks: 12, asOf,
      overrides: { [oldJob.prod_no]: { completed: true } },
    });
    eq('a job completed outside the horizon still reaches history',
      farDone.completed.map((j) => j.prod_no), [oldJob.prod_no]);
  }

  eq('past-due is what the sweep offers, and it is not empty',
    board.warnings.pastDue.length > 0, true);
  check('everything offered is genuinely past its end date and on the board',
    board.warnings.pastDue.every((j) => j.end_date < toISO(asOf) && !j.hidden && !j.completed), '');

  // includeCompleted is what the everything-view uses.
  const everything = buildBoard(src.rows, {
    codeMap, horizonWeeks: null, asOf, includeCompleted: true,
    overrides: { [doneNo]: { completed: true } },
  });
  check('the everything view keeps completed work on the chart',
    everything.jobs.some((j) => j.prod_no === doneNo && j.completed), '');

  // ---- lane packing -------------------------------------------------------
  const lane = (rows) => packLanes(rows).map((l) => l.map((r) => r.prod_no));
  eq('jobs that never overlap share one lane',
    lane([
      { prod_no: 'a', start_date: '2026-01-01', end_date: '2026-01-05' },
      { prod_no: 'b', start_date: '2026-01-10', end_date: '2026-01-15' },
    ]), [['a', 'b']]);
  eq('jobs that overlap take a lane each',
    lane([
      { prod_no: 'a', start_date: '2026-01-01', end_date: '2026-01-10' },
      { prod_no: 'b', start_date: '2026-01-05', end_date: '2026-01-15' },
    ]), [['a'], ['b']]);
  eq('a lane is reused once it frees up',
    lane([
      { prod_no: 'a', start_date: '2026-01-01', end_date: '2026-01-10' },
      { prod_no: 'b', start_date: '2026-01-05', end_date: '2026-01-15' },
      { prod_no: 'c', start_date: '2026-01-20', end_date: '2026-01-25' },
    ]), [['a', 'c'], ['b']]);
  // Friday-then-Monday should still read as two jobs, not one long block.
  eq('touching jobs do not share a lane',
    lane([
      { prod_no: 'a', start_date: '2026-01-01', end_date: '2026-01-05' },
      { prod_no: 'b', start_date: '2026-01-06', end_date: '2026-01-09' },
    ]), [['a'], ['b']]);
  eq('input order does not matter',
    lane([
      { prod_no: 'c', start_date: '2026-01-20', end_date: '2026-01-25' },
      { prod_no: 'b', start_date: '2026-01-05', end_date: '2026-01-15' },
      { prod_no: 'a', start_date: '2026-01-01', end_date: '2026-01-10' },
    ]), [['a', 'c'], ['b']]);
  eq('nothing packs into nothing', packLanes([]), []);

  // Interval partitioning is optimal: lanes used == peak simultaneous jobs.
  const gLanes = ganttLayout(gJobs, { asOf });
  for (const grp of gLanes.groups) {
    const peak = Math.max(...grp.rows.map((r) =>
      grp.rows.filter((o) => o.start_date <= r.end_date && o.end_date >= r.start_date).length));
    check(`lanes for ${grp.category} are as few as the overlaps allow`,
      grp.lanes.length <= peak, `${grp.lanes.length} lanes, peak overlap ${peak}`);
  }
  check('packing loses no job',
    gLanes.groups.every((grp) => grp.lanes.flat().length === grp.rows.length), '');

  // The window narrows only when the chart has to fit. A scrolling chart shows
  // the whole span, which is the point of it.
  const wide = ganttLayout(gJobs, { asOf, scaleFromAll: true });
  check('the everything scale reaches back to the oldest job',
    toISO(wide.start) < toISO(gLanes.start), `${toISO(wide.start)} vs ${toISO(gLanes.start)}`);
  eq('...so nothing needs listing separately', wide.unscheduled.length, 0);

  // ---- gantt scroll position ----------------------------------------------
  // A scrolling chart opens on today, not on the oldest job. Today sits in the
  // middle of this synthetic two-year span, so a wrong target cannot hide
  // behind the clamp at either end — which is exactly what the real export did
  // while the arithmetic was wrong.
  {
    const wideJobs = [];
    for (let m = 0; m < 24; m++) {
      const y = 2026 + Math.floor(m / 12);
      const mm = String((m % 12) + 1).padStart(2, '0');
      wideJobs.push({ prod_no: `W${m}`, label: `Job ${m}`, category: 'Davits',
        start_date: `${y}-${mm}-02`, end_date: `${y}-${mm}-20`, is_stock: false });
    }
    const gh = document.createElement('div');
    gh.style.cssText = 'width:1000px; position:absolute; left:0; top:0; visibility:hidden;';
    document.body.append(gh);
    renderGanttChart(gh, wideJobs, { asOf: { y: 2027, m: 1, d: 15 }, pxPerDay: 8 });
    const chart = gh.querySelector('.gantt');
    const cb = chart.getBoundingClientRect();
    const line = chart.querySelector('.g-today').getBoundingClientRect();

    check('a scrolling chart opens somewhere other than the beginning',
      chart.scrollLeft > 0, String(chart.scrollLeft));
    check('...and not merely pinned to the far end',
      chart.scrollLeft < chart.scrollWidth - chart.clientWidth,
      `${chart.scrollLeft} of ${chart.scrollWidth - chart.clientWidth}`);
    check('today is on screen when it opens',
      line.x >= cb.x - 1 && line.x <= cb.x + cb.width + 1, '');
    check('...with history to its left, not jammed against the edge',
      line.x - cb.x > 40, String(Math.round(line.x - cb.x)));

    // The label column is frozen: it must not move as the chart scrolls.
    const lbl = gh.querySelector('.g-row:not(.g-head) .g-label');
    const before = lbl.getBoundingClientRect().x;
    chart.scrollLeft += 300;
    check('the label column stays put while the chart scrolls',
      Math.abs(lbl.getBoundingClientRect().x - before) < 1, '');
    gh.remove();
  }

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
  eq('all four narrow categories are placed, none lost or duplicated',
    [...cols[0], ...cols[1]].sort(),
    ['CYLINDER LIFTERS', 'LADDERS AND CHAIRS', 'LAUNCHERS, DOORS & CHOCKS', 'ROTARY LIFTERS']);
  check('the biggest category is not sharing with the second biggest',
    !(cols.find((c) => c.includes('CYLINDER LIFTERS'))?.includes('DAVITS')),
    cols.map((c) => c.join('+')).join(' | '));
  eq('davits runs full width underneath',
    [...host.querySelectorAll('.full .banner')].map((b) => b.textContent), ['DAVITS']);
  eq('three columns per table', host.querySelector('thead tr:nth-child(2)').children.length, 3);
  eq('print header carries the run date alone',
    host.querySelector('.doc-range').textContent.trim(), 'as of:  21/08/2026');
  // Read the PO out of the data rather than naming one: a real PO number is
  // customer data and does not belong in a public repo, and this way the test
  // covers whatever the export actually carries.
  const anyPO = board.jobs.find((j) => j.customer_po)?.customer_po;
  check('the Riviera PO never reaches the printed board',
    !/PO/.test(host.textContent) && Boolean(anyPO) && !host.textContent.includes(anyPO),
    anyPO ? '' : 'no PO in the export — the test would be vacuous');
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
