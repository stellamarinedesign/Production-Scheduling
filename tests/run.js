// tests/run.js — fixture tests for the transform layer.
//
// No build step and no Node in this environment, so these run in the browser,
// against the real 21/08/2026 export and the reference implementation's real
// output. The transform is only correct if it reproduces all 48 board rows and
// all 44 exclusion reasons exactly.

import { xlsxAdapter, validateColumns } from '../js/adapters/index.js';
import { buildBoard, toDateOnly, toAU, toISO, addWeeks, jobTitle,
         customNameOptions, CUSTOM_PREFIX, isEmptyCustomName,
         printJobs, isPrintable, daysBetween, ageLabel,
         effectiveStatus, snapshotOf, fromSnapshot } from '../js/transform.js';
import { classify, CATEGORY_ORDER, PRINT_CATEGORIES, WATERMAKER_CATEGORIES,
         laneFor, LANE, tmCategory, internalCategory,
         isWaterUnit, WATERMAKER_UNIT_RE } from '../js/rules.js';
import { resolveDisplays, aliasGroups, stellaCode, labelFor, detectNewCodes,
         existingBoats, acceptNewCode, applyTemplate, boatRows } from '../js/vessel-codes.js';
import { renderPrint, measure, fitToPage, balanceColumns } from '../js/print.js';
import { ganttLayout, packLanes, renderGantt as renderGanttChart } from '../js/gantt.js';
import { fitCodesSheet, measureSheet, renderCodesSheet, CONTENT_H, TYPE_STEPS } from '../js/codes-print.js';
import { packRows, unpackRows, isEmptyOverride, OVERRIDE_FIELDS } from '../js/store.js';

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

  // THE REFERENCE PRODUCED A PRINTED SHEET, so that is what it must be compared
  // against. `board.jobs` is now a wider thing: the horizon and the stock cap
  // trim the paper rather than the board, and watermakers are on the board but
  // have no column on it. `printJobs` is the set the reference was describing.
  const printed = printJobs(board);
  eq('50 jobs on the printed sheet — 48 from the reference plus 2 real component parts',
    printed.length, expected.job_count + 2);
  check('the board itself is wider than the sheet',
    board.jobs.length > printed.length, `${board.jobs.length} vs ${printed.length}`);
  eq('horizon end still computed', board.meta.horizon_end, expected.horizon_end);

  const componentJobs = printed.filter((j) => j.is_component);
  eq('the two component parts that are real jobs are on the board',
    componentJobs.map((j) => j.inventory_id).sort(),
    ['SHCELECPLINTHRIV43SY', 'SWD4PDRIV62SY']);
  eq('...in their proper categories',
    componentJobs.map((j) => j.category).sort(),
    ['Ladders and Chairs', 'Launchers, Doors & Chocks']);
  eq('...labelled through the usual rules, not their raw description',
    componentJobs.map((j) => j.label).sort(),
    ['Helm Seat Box SY20', 'Watertight Door 62SY']);
  // They used to be excluded as "water treatment". They are now on the board in
  // the watermaker categories and simply do not print.
  eq('the water-treatment component parts are on the board but off the sheet',
    board.jobs.filter((j) => j.is_component && WATERMAKER_CATEGORIES.includes(j.category)).length >= 5, true);
  eq('...and none of them reach the paper',
    printed.filter((j) => WATERMAKER_CATEGORIES.includes(j.category)), []);
  eq('nothing is dropped for being a component part any more',
    board.excluded.filter((e) => /component part/i.test(e.reason)), []);

  // Every field the reference implementation emits, on every row, in order.
  const FIELDS = ['prod_no', 'category', 'description', 'label', 'inventory_id', 'customer',
    'is_stock', 'due_date', 'due_display', 'start_date', 'status', 'qty', 'hull',
    'customer_po', 'sales_order', 'notes', 'on_hold', 'hidden', 'hidden_reason'];

  // Match on production number rather than position: the two component parts
  // sort into the middle of their categories and would shift every index.
  const gotByProd = new Map(printed.map((j) => [j.prod_no, j]));
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
  // The reference excluded 44. Two are real jobs now, and the water-treatment
  // rows are on the board rather than excluded — so the only rows still
  // EXCLUDED are the ones with no category at all: commissioning, powerpacks,
  // davit spares. Everything the reference dropped is still off the sheet, but
  // "off the sheet" and "not in the system" are no longer the same statement.
  // Which reference rows moved rather than vanished is decided by classifying
  // them, not by reading the old reason text: STKIT and STF rows were worded
  // "spares/kit" and are water products all the same.
  const nowWater = (e) => WATERMAKER_CATEGORIES.includes(classify(e.inventory_id).category);
  // Two reference exclusions are no longer exclusions at all, for the same
  // reason: the row is real work that simply has no place on this sheet. Water
  // products have no column, and a job past the horizon is not yet due. Both
  // are on the board; neither prints.
  const offSheetNotOut = (e) => nowWater(e) || /horizon/i.test(e.reason);
  const stillExcluded = expExcl.filter((e) =>
    !/component part/i.test(e.reason) && !offSheetNotOut(e));
  eq('every reference exclusion that was not water is still excluded',
    board.excluded.length, stillExcluded.length);

  // Reasons are worded for the manager now, so compare on what was excluded and
  // why in kind, not on the exact sentence.
  const gotExcl = new Map(board.excluded.map((e) => [e.prod_no, e]));
  const wrong = [];
  const onPaper = new Set(printed.map((j) => j.prod_no));
  for (const e of expExcl) {
    if (/component part/i.test(e.reason)) continue;          // deliberately kept now
    // Water rows moved from "excluded" to "on the board, off the sheet". Either
    // way the reference's claim holds: they do not print.
    if (offSheetNotOut(e)) {
      if (onPaper.has(e.prod_no)) wrong.push(`${e.prod_no} should not print`);
      continue;
    }
    const got = gotExcl.get(e.prod_no);
    if (!got) { wrong.push(`${e.prod_no} should be excluded (${e.reason})`); continue; }
    if (got.inventory_id !== e.inventory_id) wrong.push(`${e.prod_no} inventory id differs`);
  }
  check('nothing the reference kept off the sheet reaches it now',
    wrong.length === 0, wrong.slice(0, 8).join('\n'));

  // ---- excluded ordering --------------------------------------------------
  const capped2 = buildBoard(src.rows, {
    codeMap, horizonWeeks: 12, asOf: { y: 2026, m: 8, d: 21 }, maxStock: 2 });
  const kinds = capped2.excluded.map((e) => e.kind);
  // The horizon and the stock cap no longer EXCLUDE anything — they mark a job
  // as not printing and it stays on the board. So neither can appear here.
  eq('the horizon is not an exclusion any more',
    kinds.filter((k) => k === 'horizon' || k === 'stockCap'), []);
  check('what is left is unmapped codes and things with no category',
    kinds.every((k) => k === 'category' || k === 'unmapped'), kinds.join(','));
  eq('every excluded row carries the item description field',
    capped2.excluded.every((e) => 'item_description' in e), true);

  check('the COMMISSION ordering trap holds',
    board.excluded.filter((e) => e.inventory_id.includes('COMMISSION')).length === 15
    && !board.jobs.some((j) => j.inventory_id.includes('COMMISSION')),
    `${board.excluded.filter((e) => e.inventory_id.includes('COMMISSION')).length} commissioning rows excluded`);

  // ---- horizon sensitivity (BOARD_SPEC §2) --------------------------------
  const asOf = { y: 2026, m: 8, d: 21 };
  // Measured on the SHEET now. The board no longer changes size with the
  // horizon — that is the whole point of the change — so counting board.jobs
  // here would produce a flat line and prove nothing.
  const counts = {};
  for (const w of [4, 6, 8, 10, 12]) {
    counts[w] = printJobs(buildBoard(src.rows, { codeMap, horizonWeeks: w, asOf })).length;
  }
  check('the board is the same size at every horizon',
    new Set([4, 12, 26].map((w) =>
      buildBoard(src.rows, { codeMap, horizonWeeks: w, asOf }).jobs.length)).size === 1, '');
  // The documented curve was 4->26, 6->33, 8->37, 10->39, 12->48, none->49.
  // Each figure gains the component parts that fall inside that horizon.
  eq('horizon curve still climbs with the documented shape',
    Object.values(counts).every((n, i, a) => i === 0 || n >= a[i - 1]), true);
  eq('12 weeks prints 50', counts[12], 50);
  eq('unlimited horizon prints 51',
    printJobs(buildBoard(src.rows, { codeMap, horizonWeeks: null, asOf })).length, 51);

  // ---- stock --------------------------------------------------------------
  const stock = printed.filter((j) => j.is_stock);
  eq('7 stock builds', stock.length, 7);
  check('stock shows STOCK, not a date', stock.every((j) => j.due_display === 'STOCK'), '');
  check('stock ignores the horizon',
    printJobs(buildBoard(src.rows, { codeMap, horizonWeeks: 4, asOf })).filter((j) => j.is_stock).length === 7, '');
  check('stock sorts last within its category',
    (() => {
      const d = printed.filter((j) => j.category === 'Davits');
      return d.findIndex((j) => j.is_stock) === d.length - d.filter((j) => j.is_stock).length;
    })(), '');

  const capped = buildBoard(src.rows, { codeMap, horizonWeeks: 12, asOf, maxStock: 3 });
  eq('stock cap trims the sheet to 3 per category',
    printJobs(capped).filter((j) => j.is_stock && j.category === 'Davits').length, 3);
  check('...and the capped rows stay on the board, marked',
    capped.jobs.filter((j) => j.over_stock_cap).length > 0
    && capped.jobs.filter((j) => j.is_stock && j.category === 'Davits').length
       === board.jobs.filter((j) => j.is_stock && j.category === 'Davits').length, '');
  eq('the stock cap excludes nothing',
    capped.excluded.filter((e) => e.kind === 'stockCap'), []);

  // ---- overrides ----------------------------------------------------------
  const ov = buildBoard(src.rows, {
    codeMap, horizonWeeks: 12, asOf,
    overrides: { P01093: { hidden: true, hiddenReason: 'waiting on parts' }, P01092: { labelOverride: 'Custom label' } },
  });
  const hidden = ov.jobs.find((j) => j.prod_no === 'P01093');
  check('a hidden job stays in the record but off the count',
    hidden.hidden === true && hidden.hidden_reason === 'waiting on parts'
    && ov.meta.job_count === board.meta.job_count - 1, '');
  const relabelled = ov.jobs.find((j) => j.prod_no === 'P01092');
  check('a label override applies and keeps the original for reset',
    relabelled.label === 'Custom label' && relabelled.base_label === 'SY22 Launcher', '');

  // ---- warnings -----------------------------------------------------------
  eq('no unmapped prefixes in this export', board.warnings.unmapped, []);
  eq('one On Hold job on this board', board.warnings.onHold.length, 1);

  const held = buildBoard(
    src.rows.map((r) => (r['Production Nbr.'] === 'P01093' ? { ...r, Status: 'On Hold' } : r)),
    { codeMap, horizonWeeks: 12, asOf },
  );
  eq('an On Hold job is flagged, not hidden', held.warnings.onHold.length, 2);
  check('On Hold only warns for jobs that would actually appear',
    buildBoard(
      src.rows.map((r) => (r['Production Nbr.'] === 'P01093' ? { ...r, Status: 'On Hold' } : r)),
      { codeMap, horizonWeeks: 12, asOf, overrides: { P01093: { hidden: true } } },
    ).warnings.onHold.length === 1, '');

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

  // ---- quantity in the title ----------------------------------------------
  // Shown only when there is more than one to build: "x1" on 85 of the 92 rows
  // would bury the three that matter.
  eq('one to build shows no quantity', jobTitle({ label: 'SY22 Launcher', qty: 1 }), 'SY22 Launcher');
  eq('more than one does', jobTitle({ label: 'Watertight Door 62SY', qty: 5 }), 'Watertight Door 62SY x5');
  eq('a missing quantity is treated as one', jobTitle({ label: 'X' }), 'X');

  const qtyJobs = printed.filter((j) => j.qty > 1);
  eq('the export carries three multi-quantity jobs on the sheet',
    qtyJobs.map((j) => `${j.inventory_id}:${j.qty}`).sort(),
    ['SHCELECPLINTHRIV43SY:5', 'STCFXCHOCK:2', 'SWD4PDRIV62SY:5']);
  eq('...and each shows it', qtyJobs.map((j) => jobTitle(j)).sort(),
    ['Fixed Tender Chocks x2', 'Helm Seat Box SY20 x5', 'Watertight Door 62SY x5']);

  // The suffix must NOT live in `label`. The editor prefills from `label`, so a
  // suffix stored there would be saved into the override and suffixed again on
  // the next render — "Chocks x2 x2".
  check('the quantity is not baked into the stored label',
    qtyJobs.every((j) => !/ x\d+$/.test(j.label)), qtyJobs.map((j) => j.label).join(' | '));
  eq('a relabelled job still shows its quantity', (() => {
    const b = buildBoard(src.rows, { codeMap, horizonWeeks: 12, asOf,
      overrides: { [qtyJobs[0].prod_no]: { labelOverride: 'Bespoke' } } });
    return jobTitle(b.jobs.find((j) => j.prod_no === qtyJobs[0].prod_no));
  })(), `Bespoke x${qtyJobs[0].qty}`);

  // ---- lanes: production, T&M, internal -----------------------------------
  //
  // The office sorts the export into three sheets by hand. Two fields
  // reproduce that split exactly, and the 01/09 export ships the hand-sorted
  // sheets alongside ALL RECORDS, so the rule can be checked against them.
  const laneOf = (over) => laneFor({ 'Order Type': 'RO', 'Order Nbr.': '', Type: 'Finished Good', ...over });

  eq('Order Type TM is time & materials', laneOf({ 'Order Type': 'TM' }), LANE.tm);
  eq('...whatever else the row says',
    laneOf({ 'Order Type': 'TM', 'Order Nbr.': 'SO002015', Type: 'Component Part' }), LANE.tm);
  eq('a component part with no sales order is internal',
    laneOf({ Type: 'Component Part' }), LANE.internal);
  eq('a component part WITH a sales order is production',
    laneOf({ Type: 'Component Part', 'Order Nbr.': 'SO002029' }), LANE.production);
  // This is the distinction that keeps the two real component-part jobs on the
  // board: a watertight door sold against an order is production work.
  eq('a finished good with no sales order is a stock build, not internal',
    laneOf({}), LANE.production);

  // The 21/08 export is the ERP's pre-filtered production inquiry, so every row
  // in it is production work. The lane rule must not invent lanes that are not
  // there.
  eq('the 21/08 export is all production', [board.tm.length, board.internal.length], [0, 0]);

  const newFile = await fetch('fixtures/export-20260901.xlsx', { cache: 'no-store' });
  if (newFile.ok) {
    const src2 = await xlsxAdapter.fetch({
      file: new File([await newFile.arrayBuffer()], 'export-20260901.xlsx') });
    eq('the newer export is read from ALL RECORDS, not the hand-sorted sheets',
      src2.sheetName, 'ALL RECORDS');

    // Score the rule against the office's own three sheets, row by row.
    const XLSXm = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
    const wb = XLSXm.read(await (await fetch('fixtures/export-20260901.xlsx')).arrayBuffer(),
      { cellDates: true });
    const sheet = (n) => XLSXm.utils.sheet_to_json(wb.Sheets[n], { defval: null });
    const score = (name, expectedLane) => {
      const rows = sheet(name);
      const wrongRows = rows.filter((r) => laneFor(r) !== expectedLane);
      check(`every row on the ${name} sheet reads as ${expectedLane}`,
        rows.length > 0 && wrongRows.length === 0,
        `${wrongRows.length} of ${rows.length} wrong: ${wrongRows.slice(0, 3).map((r) => r['Production Nbr.']).join(', ')}`);
    };
    score('TM', LANE.tm);
    score('INTERNAL', LANE.internal);
    score('REGULAR', LANE.production);

    const b2 = buildBoard(src2.rows, { codeMap, horizonWeeks: 12, asOf: { y: 2026, m: 9, d: 1 } });
    eq('T&M comes through at the size of its own sheet', b2.tm.length, sheet('TM').length);
    check('...and internal is at least the size of its own sheet',
      b2.internal.length >= sheet('INTERNAL').length,
      `${b2.internal.length} vs ${sheet('INTERNAL').length}`);

    // T&M categories: the sales order is the only distinction the data
    // supports, and Project agrees with it on every row.
    eq('T&M splits on whether there is a sales order behind it',
      [...new Set(b2.tm.map((j) => j.category))].sort(),
      ['Customer work', 'Workshop & internal']);
    check('...and Project agrees with that split on every row',
      sheet('TM').every((r) => (tmCategory(r) === 'Customer work')
        === (String(r.Project ?? '').trim() !== 'X')), '');

    eq('internal jobs are grouped by product line',
      [...new Set(b2.internal.map((j) => j.category))].sort(),
      ['Cylinder lifter parts', 'Davit parts', 'Watermaker parts']);
    eq('internal category comes off the part number',
      ['SL0452', 'ST0255', 'SDC0168', 'SXX1'].map(internalCategory),
      ['Cylinder lifter parts', 'Watermaker parts', 'Davit parts', 'Other parts']);

    // A T&M row's item code is always STELLA-REPAIR-T&M, so the production
    // description is the job. Running it through the vessel rules would invent
    // a boat code out of nothing.
    check('a T&M job is named by its description, not a vessel code',
      b2.tm.every((j) => j.label && !/^S[A-Z]*RIV/.test(j.label)),
      b2.tm.slice(0, 3).map((j) => j.label).join(' | '));

    // Neither lane belongs on the Gantt, and this is why: the ERP stamps start
    // and end to the day the order was raised and never revises it.
    check('every T&M row has start == end, so it has no schedule to chart',
      b2.tm.every((j) => j.unscheduled), '');
    check('...which is what the age is for instead',
      b2.tm.every((j) => typeof j.age_days === 'number'), '');
    check('some of them have been open for the better part of a year',
      Math.max(...b2.tm.map((j) => j.age_days ?? 0)) > 250, '');

    eq('side-lane jobs never reach the printed sheet',
      printJobs(b2).filter((j) => j.lane !== LANE.production), []);
  } else {
    check('the 01/09 export fixture is present', false, 'export-20260901.xlsx not found');
  }

  eq('days between two calendar days', daysBetween({ y: 2026, m: 8, d: 21 }, { y: 2026, m: 9, d: 1 }), 11);
  eq('age reads in days up to eight weeks', ageLabel(40), '40 days');
  eq('...then in months', ageLabel(90), '3 months');
  eq('...then in years', ageLabel(400), '1.1 years');
  eq('one day is not "1 days"', ageLabel(1), '1 day');

  // ---- status, set by hand ------------------------------------------------
  //
  // The ERP owns the status and lags. A manager can correct it, and the
  // correction EXPIRES the moment the ERP moves: it was a statement about one
  // specific ERP value, and once that value changes it is a claim about a fact
  // that no longer holds.
  eq('no override follows the ERP', effectiveStatus('Planned', {}), 'Planned');
  eq('an override holds while the ERP says what it said',
    effectiveStatus('In Process', { status: 'On Hold', statusFrom: 'In Process' }), 'On Hold');
  eq('...and is dropped the moment the ERP moves',
    effectiveStatus('Released', { status: 'On Hold', statusFrom: 'In Process' }), 'Released');
  // The trap this guards: marking a job In Process would otherwise permanently
  // mask the ERP putting it On Hold later, for a different reason.
  eq('...including when the ERP itself goes On Hold',
    effectiveStatus('On Hold', { status: 'In Process', statusFrom: 'Released' }), 'On Hold');
  eq('a status outside the board set is ignored',
    effectiveStatus('Planned', { status: 'Completed', statusFrom: 'Planned' }), 'Planned');

  const heldByHand = buildBoard(src.rows, {
    codeMap, horizonWeeks: 12, asOf,
    overrides: { P01093: { status: 'On Hold', statusFrom: 'In Process' } },
  });
  const byHand = heldByHand.jobs.find((j) => j.prod_no === 'P01093');
  check('a hand-set status reaches the job, flagged as manual',
    byHand.status === 'On Hold' && byHand.status_manual === true
    && byHand.erp_status === 'In Process' && byHand.on_hold === true, byHand.status);
  eq('...and it warns like any other On Hold job',
    heldByHand.warnings.onHold.filter((j) => j.prod_no === 'P01093').length, 1);

  // WHETHER A ROW EXISTS stays the ERP's call. An override must never drag a
  // Completed or Canceled row back onto the board.
  const closedRow = buildBoard(
    src.rows.map((r) => (r['Production Nbr.'] === 'P01093' ? { ...r, Status: 'Completed' } : r)),
    { codeMap, horizonWeeks: 12, asOf,
      overrides: { P01093: { status: 'In Process', statusFrom: 'Completed' } } },
  );
  eq('an override cannot resurrect a row the ERP closed',
    closedRow.jobs.filter((j) => j.prod_no === 'P01093'), []);

  // An override record with nothing meaningful left is deleted. That check has
  // to know every field, or the first field added after it is written and then
  // immediately thrown away - which is exactly what happened to `status`.
  check('every override field keeps its record alive',
    OVERRIDE_FIELDS.every((f) => !isEmptyOverride({ [f]: f === 'progress' ? 0.5 : 'x' })),
    OVERRIDE_FIELDS.filter((f) => isEmptyOverride({ [f]: 'x' })).join(','));
  check('an empty record is empty', isEmptyOverride({}) && isEmptyOverride({ updatedAt: 'now' }), '');
  check('a cleared field does not keep it alive',
    isEmptyOverride({ hidden: false, labelOverride: '', status: null }), '');
  check('status is one of the fields', OVERRIDE_FIELDS.includes('status'), '');

  // ---- an import supplements, it does not replace --------------------------
  //
  // History used to be assembled only from rows in the CURRENT export, which
  // made it lossy in the exact case it exists for: mark a job done, the ERP
  // closes it a fortnight later, the row stops being exported, and the completed
  // job vanishes from the one view whose job is to remember it.
  const doneJob = board.jobs[0];
  const snap = snapshotOf(doneJob);
  const asDone = {
    [doneJob.prod_no]: {
      completed: true, completedAt: '2026-08-25T01:00:00.000Z',
      completedBy: 'pete@example.com', snapshot: snap,
    },
  };

  // Still in the export: the live row is used, as before.
  const present = buildBoard(src.rows, { codeMap, horizonWeeks: 12, asOf, overrides: asDone });
  eq('a completed job in the export is in History once',
    present.completed.filter((j) => j.prod_no === doneJob.prod_no).length, 1);
  check('...built from the live row, not the snapshot',
    present.completed.find((j) => j.prod_no === doneJob.prod_no).from_snapshot === undefined, '');
  eq('...and off the board', present.jobs.filter((j) => j.prod_no === doneJob.prod_no), []);

  // Gone from the export entirely - the ERP closed it, or it simply is not in
  // the next file.
  const gone = buildBoard(
    src.rows.filter((r) => r['Production Nbr.'] !== doneJob.prod_no),
    { codeMap, horizonWeeks: 12, asOf, overrides: asDone },
  );
  const kept2 = gone.completed.find((j) => j.prod_no === doneJob.prod_no);
  check('a completed job absent from the export is STILL in History', Boolean(kept2),
    `${gone.completed.length} completed rows`);
  check('...rebuilt from its snapshot, and saying so', kept2?.from_snapshot === true, '');
  eq('...with the name it had when it was finished', kept2?.label, doneJob.label);
  eq('...its category, so History still groups it', kept2?.category, doneJob.category);
  eq('...and who finished it, when', [kept2?.completed_by, kept2?.completed_at],
    ['pete@example.com', '2026-08-25T01:00:00.000Z']);
  eq('it is not counted as work', gone.jobs.filter((j) => j.prod_no === doneJob.prod_no), []);

  // The ERP marking it Completed is the same case: the status gate drops the
  // row before anything else looks at it.
  const erpClosed = buildBoard(
    src.rows.map((r) => (r['Production Nbr.'] === doneJob.prod_no
      ? { ...r, Status: 'Completed' } : r)),
    { codeMap, horizonWeeks: 12, asOf, overrides: asDone },
  );
  eq('the ERP closing a job does not erase our record of it',
    erpClosed.completed.filter((j) => j.prod_no === doneJob.prod_no).length, 1);

  // A snapshot that was never written still yields a usable row rather than
  // throwing - old records predate the field.
  const bare = fromSnapshot('P00001', { completed: true });
  check('a record with no snapshot degrades to the production number',
    bare.label === 'P00001' && bare.completed === true && bare.lane === 'production', '');

  eq('an uncompleted override brings nothing back',
    buildBoard(src.rows.filter((r) => r['Production Nbr.'] !== doneJob.prod_no),
      { codeMap, horizonWeeks: 12, asOf,
        overrides: { [doneJob.prod_no]: { hidden: true } } })
      .completed.filter((j) => j.prod_no === doneJob.prod_no), []);

  // ---- watermakers --------------------------------------------------------
  //
  // Water products were excluded outright. They are on the board now, split by
  // the one thing that reliably separates a finished unit from a kit: an item
  // code ending in flow rate over voltage.
  eq('a unit code ends in litres over volts',
    ['STAQSAB/240/230', 'STG4/240/230', 'STG4LA/160/230'].map((c) => classify(c).category),
    ['Watermakers', 'Watermakers', 'Watermakers']);
  eq('a kit, a filter and an upgrade are accessories',
    ['STKITJUMBO', 'STMEDIAFILTER', 'STG3COMFILTUPGRADE', 'STPH'].map((c) => classify(c).category),
    ['Watermaker accessories', 'Watermaker accessories',
      'Watermaker accessories', 'Watermaker accessories']);
  // STAUTO24 ends in a voltage but is a flush unit. The rule anchors on the
  // PAIR of numbers for exactly this reason.
  eq('a trailing voltage alone is not a watermaker',
    classify('STAUTO24').category, 'Watermaker accessories');
  // Softeners have no flow-rate/voltage pair to read, so the prefix carries it:
  // SS is a product line and SS17500 is a finished unit.
  eq('a softener is a finished unit', classify('SS17500').category, 'Watermakers');
  check('...on the prefix, since there is no pair in the code',
    isWaterUnit('SS17500') && !WATERMAKER_UNIT_RE.test('SS17500'), '');
  check('...and the pair still decides everything else',
    isWaterUnit('STG4/240/230') && !isWaterUnit('STKITJUMBO'), '');
  // ORDERING TRAP, same family as the COMMISSION one: STL, STC and both
  // COMMISSION spellings all begin with ST and must still win.
  eq('launchers, chocks and commissioning are not water',
    ['STLRIVSY22', 'STCFXCHOCK', 'STLRIVCOMMISSION'].map((c) => classify(c).category),
    ['Launchers, Doors & Chocks', 'Launchers, Doors & Chocks', null]);
  eq('no watermaker category is in the print layout',
    PRINT_CATEGORIES.filter((c) => WATERMAKER_CATEGORIES.includes(c)), []);
  check('the export puts water work on the board',
    board.jobs.filter((j) => WATERMAKER_CATEGORIES.includes(j.category)).length === 24,
    String(board.jobs.filter((j) => WATERMAKER_CATEGORIES.includes(j.category)).length));

  // ---- the horizon is a print setting -------------------------------------
  const near = buildBoard(src.rows, { codeMap, horizonWeeks: 4, asOf: { y: 2026, m: 8, d: 21 } });
  check('a job past the horizon stays on the board, marked',
    near.jobs.some((j) => j.beyond_horizon) && near.jobs.length === board.jobs.length, '');
  eq('...and does not print',
    printJobs(near).filter((j) => j.beyond_horizon), []);
  check('isPrintable rejects each reason separately', [
    isPrintable({ category: 'Davits' }),
    isPrintable({ category: 'Davits', beyond_horizon: true }),
    isPrintable({ category: 'Davits', over_stock_cap: true }),
    isPrintable({ category: 'Watermakers' }),
  ].join(',') === 'true,false,false,false', '');

  // ---- naming a custom one-off --------------------------------------------
  // Two columns, neither reliably right, so the transform reads both and says
  // when it is guessing rather than picking quietly.
  const opts = (o) => customNameOptions({ inventoryId: 'SLCUSTOMSINGLE(12)', ...o });

  eq('a standard item has no custom naming to do',
    customNameOptions({ inventoryId: 'SBLRIV56', descField: 'x', customer: 'y' }), null);

  const vesselRow = opts({ descField: 'Riviera 48', customer: 'Rory Corbett' });
  eq('a vessel in the Description settles it', vesselRow.ambiguous, false);
  eq('...and is what the board takes', vesselRow.chosen.label, 'Custom Lifter - Riviera 48');
  eq('trailing words after the vessel are dropped',
    opts({ descField: 'Alaska 47 square transom', customer: 'Leigh Smith Yachts' }).chosen.label,
    'Custom Lifter - Alaska 47');

  const feeRow = opts({ descField: '5% drawing fee', customer: 'Galaxy Charters' });
  check('text the vessel rule cannot read is ambiguous, not silently dropped', feeRow.ambiguous);
  eq('...the board still prints what it always did', feeRow.chosen.label, 'Custom Lifter - GALAXY');
  eq('...and both columns are offered verbatim',
    [feeRow.description.raw, feeRow.customer.raw], ['5% drawing fee', 'Galaxy Charters']);
  eq('...each with the label it would produce',
    [feeRow.description.label, feeRow.customer.label],
    ['Custom Lifter - 5% drawing fee', 'Custom Lifter - GALAXY']);

  // An empty column is not an option — the dialog hides it rather than offering
  // a choice that prints "Custom Lifter - ".
  eq('a blank Description offers no label', opts({ descField: '', customer: 'Galaxy Charters' }).description.label, null);
  eq('...and is still ambiguous', opts({ descField: '', customer: 'Galaxy Charters' }).ambiguous, true);

  // On the real export: three custom rows, one of which the board is guessing at.
  eq('the export raises exactly one ambiguous custom name',
    board.warnings.customNames.map((j) => j.prod_no), ['P01137']);
  eq('...and it is the drawing-fee row', board.warnings.customNames[0].name_options.description.raw, '5% drawing fee');
  eq('the two custom rows with a readable vessel are not raised',
    board.jobs.filter((j) => j.name_options && !j.name_options.ambiguous).map((j) => j.label).sort(),
    ['Custom Lifter - Alaska 47', 'Custom Lifter - Riviera 48']);

  // Answering writes an ordinary job label override. It must clear the warning
  // even when the answer is the reading the board would have chosen anyway —
  // otherwise "use the customer name" is asked again on every single import.
  const answered = (label) => buildBoard(src.rows, { codeMap, horizonWeeks: 12, asOf,
    overrides: { P01137: { labelOverride: label } } });
  eq('answering clears the question', answered('Custom Lifter - GALAXY').warnings.customNames, []);
  eq('...including when the answer matches the guess exactly',
    answered('Custom Lifter - GALAXY').jobs.find((j) => j.prod_no === 'P01137').label,
    'Custom Lifter - GALAXY');
  eq('a typed answer prints as typed',
    answered('Custom Lifter - Galaxy 62 hull 4').jobs.find((j) => j.prod_no === 'P01137').label,
    'Custom Lifter - Galaxy 62 hull 4');

  // Nothing more specific may be second-guessed: a pinned item label decides
  // before the custom branch is ever reached, so there is nothing to ask about.
  eq('an item override leaves nothing ambiguous',
    buildBoard(src.rows, { codeMap, horizonWeeks: 12, asOf,
      itemOverrides: { 'SLCUSTOMDOUBLE(24)': { label: 'Galaxy one-off' } } }).warnings.customNames, []);

  eq('the prefix is what marks a job as a one-off', CUSTOM_PREFIX, 'Custom Lifter - ');

  // The dialog prefills the field with the prefix, and `trim()` takes the
  // trailing space off it — so an untouched field arrives as "Custom Lifter -"
  // and a compare against CUSTOM_PREFIX alone saved that as a real name.
  check('an untouched prefilled field is empty', isEmptyCustomName('Custom Lifter -'));
  check('...with its trailing space too', isEmptyCustomName(CUSTOM_PREFIX));
  check('...as is whitespace', isEmptyCustomName('   '));
  check('...and nothing at all', isEmptyCustomName(''));
  check('a real name is not empty', !isEmptyCustomName('Custom Lifter - Galaxy 62'));

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

  // ---- the codes page: one line per boat ----------------------------------
  // The DISPLAY is the boat. The old page keyed on the Stella code, which put
  // SY20 and 43SY on separate lines despite printing the same thing.
  const boats = boatRows(codeMap, classify, { mode: 'boats' });
  eq('nine boats, not eleven Stella codes', boats.length, 9);
  eq('...and every code is accounted for on exactly one line',
    boats.flatMap((b) => b.codes).sort(), Object.keys(codeMap).sort());
  eq('SY20 and 43SY share a line', boats.find((b) => b.display === 'SY20').codes, ['43SY', 'SY20']);
  eq('56 and SY23 share a line', boats.find((b) => b.display === '56SY').codes, ['56', 'SY23']);
  eq('SY26 keeps its own', boats.find((b) => b.display === 'SY26').codes, ['SY26']);

  // Lifters lead, then rotary, then the rest.
  eq('boats sort by category priority, lifters first',
    [...new Set(boats.map((b) => b.category))], ['Cylinder lifters', 'Rotary Lifters']);
  eq('a boat is tagged with the line it is best known by',
    boats.find((b) => b.display === '56SY').primaryCategory, 'Cylinder lifters');
  eq('...while still listing everything it builds',
    boats.find((b) => b.display === '56SY').categories,
    ['Cylinder lifters', 'Ladders and Chairs']);

  // Split by product gives a boat a line per category.
  const products = boatRows(codeMap, classify, { mode: 'products' });
  check('splitting by product yields more lines than boats',
    products.length > boats.length, `${products.length} vs ${boats.length}`);
  eq('the 56SY lifter and the 56SY ladder are separate lines',
    products.filter((r) => r.display === '56SY').map((r) => r.category),
    ['Cylinder lifters', 'Ladders and Chairs']);
  eq('...each carrying only its own items',
    products.find((r) => r.display === '56SY' && r.category === 'Ladders and Chairs')
      .items.map((x) => x.item), ['SBLRIV56']);
  eq('...and only the codes that build for it',
    products.find((r) => r.display === '56SY' && r.category === 'Ladders and Chairs').codes, ['56']);
  check('every product line falls under a real board category',
    products.every((r) => r.category === null || CATEGORY_ORDER.includes(r.category)), '');

  // ---- assigning a new code to an existing boat ---------------------------
  // A new product arrives naming a boat the map already knows.
  eq('an item spelling a KNOWN code raises nothing and resolves on its own',
    detectNewCodes([{ 'Inventory ID': 'SBLRIV43SY',
      'Production Description': 'Stella Folding Boarding Ladder - Riviera 43SY' }], codeMap), []);
  eq('...printing the boat it belongs to, not its own spelling',
    labelFor('SBLRIV43SY', resolved, codeMap), 'Boarding Ladder SY20');

  // A genuinely unseen spelling — the hull code rather than the model.
  const unseen = detectNewCodes([{ 'Inventory ID': 'SBLRIV43SE',
    'Production Description': 'Stella Folding Boarding Ladder - Riviera 43SE', Description: '' }], codeMap);
  eq('an unseen spelling is raised for a decision', unseen.map((u) => u.code), ['43SE']);
  eq('...and the dropdown offers boats by what they print',
    existingBoats(codeMap).map((b) => b.display),
    ['56SY', '62SY', 'FB31', 'Riv 505', 'Riv 64', 'SU12', 'SY20', 'SY22', 'SY26']);

  // Route 1: pick the existing boat from the dropdown.
  const viaDropdown = { ...codeMap, '43SE': acceptNewCode('43SE', { mode: 'existing', boat: 'SY20' }, unseen[0]) };
  eq('joining an existing boat lands on its line',
    aliasGroups(viaDropdown).find((g) => g.codes.includes('43SE')).codes, ['43SE', '43SY', 'SY20']);
  eq('...and prints that boat', labelFor('SBLRIV43SE', resolveDisplays(viaDropdown), viaDropdown),
    'Boarding Ladder SY20');

  // Route 2: type the display by hand instead. Same destination.
  const viaTyping = { ...codeMap, '43SE': acceptNewCode('43SE', { mode: 'custom', value: 'SY20' }, unseen[0]) };
  eq('typing the display merges it just the same',
    aliasGroups(viaTyping).find((g) => g.codes.includes('43SE')).codes, ['43SE', '43SY', 'SY20']);

  // THE DISPLAY IS THE BOAT — grouping must not depend on the stored key alone.
  // Firestore holds entries written before boat and display were aligned, so a
  // legacy boat:'43SY' can sit beside a new boat:'SY20' while both print SY20.
  // Keying on the stored value put those on two rows that printed the same
  // thing, which is the exact confusion this page exists to remove.
  const legacyMix = {
    SY20:   { boat: '43SY', display: 'SY20', _confirmed: true, riviera: ['43SY'], items: ['SLRIVSY20(24)'] },
    '43SY': { boat: '43SY', display: 'SY20', _confirmed: true, riviera: ['43SY'], items: ['SHCELECPLINTHRIV43SY'] },
    '43SE': { boat: 'SY20', display: 'SY20', _confirmed: true, riviera: ['43SE'], items: ['SBLRIV43SE'] },
  };
  eq('a legacy key mismatch still lands on ONE line',
    boatRows(legacyMix, classify, { mode: 'boats' }).filter((r) => r.display === 'SY20').length, 1);
  eq('...carrying every code', boatRows(legacyMix, classify, { mode: 'boats' })[0].codes,
    ['43SE', '43SY', 'SY20']);

  // ...but a deliberate split still holds: same model, different displays.
  eq('two different displays stay two boats',
    aliasGroups({
      A: { riviera: ['66SY'], boat: 'one', display: 'Alpha', _confirmed: true },
      B: { riviera: ['66SY'], boat: 'two', display: 'Beta', _confirmed: true },
    }).map((g) => g.codes), [['A'], ['B']]);

  // ---- gantt --------------------------------------------------------------
  const gJobs = board.jobs.filter((j) => !j.hidden);
  const g = ganttLayout(gJobs, { asOf });

  eq('every job is either charted or listed, none lost',
    g.groups.flatMap((x) => x.rows).length + g.unscheduled.length, gJobs.length);
  eq('bands follow board order, not date order',
    g.groups.map((x) => x.category), CATEGORY_ORDER);
  check('watermakers get their own bands, at the bottom',
    CATEGORY_ORDER.slice(-2).join('|') === WATERMAKER_CATEGORIES.join('|'), CATEGORY_ORDER.join(','));
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
  // packLanes enforces a ONE-DAY GAP between bars in a lane, so that a job
  // ending Friday and the next starting Monday still read as two. Two bars that
  // merely touch therefore conflict, and the bound has to say so: comparing
  // against bare overlap understates the lanes needed, which went unnoticed
  // while every category was small enough for the two to agree.
  const day = 86400000;
  const conflicts = (a, b) =>
    Date.parse(a.start_date) <= Date.parse(b.end_date) + day
    && Date.parse(b.start_date) <= Date.parse(a.end_date) + day;
  const gLanes = ganttLayout(gJobs, { asOf });
  for (const grp of gLanes.groups) {
    if (!grp.rows.length) continue;
    const peak = Math.max(...grp.rows.map((r) => grp.rows.filter((o) => conflicts(o, r)).length));
    check(`lanes for ${grp.category} are as few as the gap allows`,
      grp.lanes.length <= peak, `${grp.lanes.length} lanes, peak conflict ${peak}`);
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

  // ---- rows survive a round trip through Firestore -------------------------
  // An upload used to live only in the uploading device's localStorage, so the
  // second manager signed in to an empty drop zone. The import record now
  // carries the raw rows, which means they have to survive being stored.
  const packed = packRows(src.rows);
  const revived = unpackRows(packed);

  eq('every row survives the round trip', revived.length, src.rows.length);
  eq('...with its ERP column names intact',
    Object.keys(revived[0]).slice(0, 4),
    Object.keys(src.rows[0]).slice(0, 4));

  // THE TRAP. JSON.stringify emits UTC for a Date, so a local-midnight 12 Nov
  // becomes "2026-11-11T14:00:00Z" east of Greenwich — and toDateOnly reads the
  // date off the front of an ISO string, so every date would come back a day
  // early. Brisbane is UTC+10, exactly the direction that breaks.
  const naive = JSON.parse(JSON.stringify(src.rows));
  const naiveBoard = buildBoard(naive, { codeMap, horizonWeeks: 12, asOf });
  const revivedBoard = buildBoard(revived, { codeMap, horizonWeeks: 12, asOf });

  eq('a stored board matches the board built from the original file',
    revivedBoard.jobs.map((j) => `${j.prod_no}:${j.due_date}:${j.start_date}`),
    board.jobs.map((j) => `${j.prod_no}:${j.due_date}:${j.start_date}`));
  eq('...and the same rows are excluded for the same reasons',
    revivedBoard.excluded.map((e) => `${e.prod_no}:${e.kind}`),
    board.excluded.map((e) => `${e.prod_no}:${e.kind}`));

  // A naive JSON round trip writes Dates as UTC, which used to shift every date
  // back a day east of Greenwich. It no longer does, because toDateOnly now
  // resolves a timestamp to the local calendar day — belt as well as braces, so
  // that data already written the old way reads correctly rather than only
  // being prevented from getting worse.
  eq('even a naive round trip lands on the right day now',
    naiveBoard.jobs.map((j) => `${j.prod_no}:${j.due_date}`),
    board.jobs.map((j) => `${j.prod_no}:${j.due_date}`));
  check('...and the timezone here is one where it used to break',
    new Date().getTimezoneOffset() <= 0,
    `offset ${new Date().getTimezoneOffset()} (negative means east of Greenwich)`);

  // ---- a UTC timestamp means the LOCAL calendar day ------------------------
  // A whole board of dates once came back a day early because the local cache
  // went through plain JSON.stringify, which writes a Date as UTC: local
  // midnight on 12 Nov becomes "2026-11-11T14:00:00Z" in Brisbane, and reading
  // the date off the front of that gives the 11th. Two guards now.
  eq('a bare date is taken literally', toDateOnly('2026-11-12'), { y: 2026, m: 11, d: 12 });
  eq('a UTC timestamp resolves to the local day it represents',
    toDateOnly(new Date(Date.UTC(2026, 10, 12)).toISOString()),
    (() => { const d = new Date(Date.UTC(2026, 10, 12));
      return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }; })());
  eq('...including the exact shape the old cache wrote',
    toDateOnly(new Date(2026, 10, 12).toISOString()), { y: 2026, m: 11, d: 12 });

  // The cache round trip has to leave the board identical, which is the thing
  // that actually broke: right on upload, a day early on every reload after.
  const cachedShape = JSON.parse(JSON.stringify({ rowsJson: packRows(src.rows) }));
  const fromCache = buildBoard(unpackRows(cachedShape.rowsJson),
    { codeMap, horizonWeeks: 12, asOf });
  eq('a board rebuilt from the cache matches the one built from the file',
    fromCache.jobs.map((j) => `${j.prod_no}:${j.due_date}:${j.start_date}`),
    board.jobs.map((j) => `${j.prod_no}:${j.due_date}:${j.start_date}`));

  // And data already written the old way still reads correctly, so the fix
  // repairs what is stored rather than only preventing more of it.
  const legacyCache = JSON.parse(JSON.stringify(src.rows));   // Dates -> UTC strings
  const fromLegacy = buildBoard(legacyCache, { codeMap, horizonWeeks: 12, asOf });
  eq('rows cached the old way still resolve to the right day',
    fromLegacy.jobs.map((j) => `${j.prod_no}:${j.due_date}`),
    board.jobs.map((j) => `${j.prod_no}:${j.due_date}`));

  // ---- vessel code cheat sheet --------------------------------------------
  // Landscape A4. The board fits by shortening its horizon; this sheet has no
  // horizon, so it fits by stepping the type down instead.
  {
    const sh = document.createElement('div');
    sh.id = 'codesSheet';
    sh.style.cssText = 'position:absolute; left:-100000px; top:0; visibility:hidden;';
    document.body.append(sh);

    const sheetRows = boatRows(codeMap, classify, { mode: 'boats' });
    const fit = fitCodesSheet(sh, sheetRows, { mode: 'boats', asOf });

    eq('the real code list fits one landscape page at full size',
      [fit.fits, fit.pt, fit.shrunk], [true, TYPE_STEPS[0], false]);
    check('...with room to spare rather than exactly filling it',
      fit.height > 0 && fit.height < CONTENT_H, `${fit.height} of ${CONTENT_H}`);

    // The measurement must not be scrollHeight: the on-screen preview carries a
    // min-height of a whole page, which pins scrollHeight and would make every
    // sheet report as exactly full however little is on it.
    renderCodesSheet(sh, sheetRows.slice(0, 2), { mode: 'boats', asOf });
    const small = measureSheet(sh);
    renderCodesSheet(sh, sheetRows, { mode: 'boats', asOf });
    const bigger = measureSheet(sh);
    check('a shorter sheet measures shorter', small.height < bigger.height,
      `${small.height} vs ${bigger.height}`);

    // A sheet nobody can measure must not claim to fit — the trap the board's
    // auto-fit originally had.
    sh.style.display = 'none';
    eq('an unmeasurable sheet never reports a fit',
      [measureSheet(sh).measured, measureSheet(sh).fits], [false, false]);
    sh.style.display = '';

    // Step-down, on a list far longer than one page.
    const many = Array.from({ length: 60 }, (_, i) => ({
      display: `B${i}`, codes: [`C${i}`], riviera: [`${i}SY`], hulls: [`${i}H`],
      categories: ['Cylinder lifters'], items: [{ item: `SLRIV${i}` }],
      category: 'Cylinder lifters',
    }));
    const fat = fitCodesSheet(sh, many, { mode: 'boats', asOf });
    eq('an oversized list is tried at every size', fat.steps.map((x) => x.pt), TYPE_STEPS);
    check('...each smaller than the last', fat.steps.every((x, i, a) => i === 0 || x.height < a[i - 1].height),
      fat.steps.map((x) => `${x.pt}pt=${x.height}`).join(' '));
    check('...and it says so rather than pretending', fat.fits === false, '');

    // The sheet is the same data the page shows, in board order.
    renderCodesSheet(sh, sheetRows, { mode: 'boats', asOf });
    eq('every boat reaches the sheet',
      sh.querySelectorAll('tbody tr:not(.cs-banner)').length, sheetRows.length);
    eq('banners follow category priority',
      [...sh.querySelectorAll('.cs-banner th')].map((b) => b.textContent),
      ['CYLINDER LIFTERS', 'ROTARY LIFTERS']);
    eq('the display leads each row',
      sh.querySelector('tbody tr:not(.cs-banner) td').textContent, sheetRows[0].display);
    eq('...with the Riviera model beside it',
      [...[...sh.querySelectorAll('tbody tr:not(.cs-banner)')]
        .find((tr) => tr.children[0].textContent === 'SY20').children]
        .slice(0, 2).map((c) => c.textContent),
      ['SY20', '43SY']);
    // The ERP codes came off the sheet: it is pinned up for the floor, and the
    // floor reads the display code. What the ERP calls a boat is a manager's
    // problem and lives on the vessel codes page.
    eq('the header order matches',
      [...sh.querySelectorAll('thead th')].map((h) => h.textContent),
      ['Reads as', 'Riviera', 'Hull', 'Products']);
    eq('no row carries an ERP code column',
      [...sh.querySelectorAll('tbody tr:not(.cs-banner)')]
        .map((tr) => tr.children.length).filter((n) => n !== 4), []);
    check('the run date is on the sheet',
      sh.querySelector('.cs-range').textContent.includes(toAU(asOf)), '');

    sh.remove();
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
