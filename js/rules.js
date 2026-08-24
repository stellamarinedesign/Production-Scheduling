// rules.js — the board's business rules, in one place.
//
// Ported from the reference transform.py. Every rule here was established by
// inspecting real ERP data and confirmed with Pete; see BOARD_SPEC.md and
// STELLA_PRODUCTION_BOARD_CONTEXT.md. Do not re-derive them.

// ---------------------------------------------------------------------------
// CATEGORY MAP
// Matched against Inventory ID as an ordered prefix list — FIRST MATCH WINS,
// so specific prefixes must sit above their general parent.
// category: null  ->  excluded from the board, with the reason given.
//
// !! ORDERING TRAP — do not sort this list !!
// SLRIVCOMMISSION and STLRIVCOMMISSION both exist as real items.
// SLRIVCOMMISSION begins with SLRIV, so if it drops below the SLRIV rule it is
// classified as a cylinder lifter and prints as real work. Both spellings stay
// pinned above SL and STL.
//
// The ERP's own saved filter excludes only SLRIVCOMMISSION — a typo, missing
// the T — so the 21/08 export carried 15 rows of STLRIVCOMMISSION straight
// through. Never rely on the ERP-side filter; this list is the real one.
// ---------------------------------------------------------------------------
export const CATEGORY_RULES = [
  // prefix,             category,                     excludeReason
  ['SLRIVCOMMISSION',    null,                         'on-site commissioning, not workshop fab'],
  ['STLRIVCOMMISSION',   null,                         'on-site commissioning, not workshop fab'],
  ['SRLCUSTOM',          'Rotary Lifters',             null],
  ['SRL',                'Rotary Lifters',             null],
  ['SLPOWER',            null,                         'component: powerpack'],
  ['SLCUSTOM',           'Cylinder lifters',           null],
  ['SLRIV',              'Cylinder lifters',           null],
  ['SL',                 'Cylinder lifters',           null],
  ['SDC0',               null,                         'spares/kit'],
  ['SDC',                'Davits',                     null],
  ['SBL',                'Ladders and Chairs',         null],
  ['SHC',                'Ladders and Chairs',         null],
  ['STL',                'Launchers, Doors & Chocks',  null],
  ['SGD',                'Launchers, Doors & Chocks',  null],
  ['SWD',                'Launchers, Doors & Chocks',  null],
  ['STC',                'Launchers, Doors & Chocks',  null],
  ['STKIT',              null,                         'spares/kit'],
  ['STF',                null,                         'spares/kit'],
  ['STMEDIAFILTER',      null,                         'water treatment'],
  ['ST',                 null,                         'water treatment'],
  ['SS',                 null,                         'water treatment'],
];

// Board display order — matches the current Word document.
export const CATEGORY_ORDER = [
  'Launchers, Doors & Chocks',
  'Cylinder lifters',
  'Ladders and Chairs',
  'Rotary Lifters',
  'Davits',
];

// Print layout. Davits runs full-width underneath because its descriptions are
// long; the other four share a two-column grid.
//
// Which of the four sits in which column is NOT fixed — print.js balances them
// by row count so the page comes out as short as possible. With 19 cylinder
// lifters against 5 rotary, a pinned layout wastes most of one column.
export const PRINT_LAYOUT = {
  narrow: ['Cylinder lifters', 'Ladders and Chairs', 'Launchers, Doors & Chocks', 'Rotary Lifters'],
  full:   ['Davits'],
};

// Statuses that appear on the board. Completed/Canceled/Closed are already
// excluded by the ERP saved filter, but re-check in case that filter is edited.
export const BOARD_STATUSES = new Set(['Planned', 'Released', 'In Process', 'On Hold']);

// `Type` is NOT a filter.
//
// It used to be: only `Finished Good` reached the board. That was wrong.
// SWD4PDRIV62SY (a watertight door) and SHCELECPLINTHRIV43SY (a helm seat box)
// are both booked as `Component Part` and are both real workshop jobs — the ERP
// classification reflects how they are sold, not whether the floor builds them.
//
// The filter was also doing no work. Of the 9 component parts in the 21/08
// export, 7 are ST* water treatment and were already excluded by category; the
// only two it ever caught were those two legitimate jobs. The category prefix
// list is the filter, and it decides alone.
//
// `Type` is still carried on every job so the manager view can flag it.
export const COMPONENT_TYPE = 'Component Part';

// Order the excluded panel groups its rows in. Whatever the horizon cut comes
// first — that is the list the manager actually acts on, by widening it — then
// whatever the stock cap trimmed, then codes needing a rule, then the rest.
export const EXCLUSION_ORDER = ['horizon', 'stockCap', 'unmapped', 'category'];

export const EXCLUSION_GROUP_LABEL = {
  horizon:  'Beyond the horizon',
  stockCap: 'Trimmed by the stock cap',
  unmapped: 'Unmapped code — needs a rule',
  category: 'Not a board category',
};

// Customer name that means "no external customer — stock / internal build".
export const INTERNAL_CUSTOMER = 'Stella Marine Group Pty Ltd';

// Columns the transform needs. The adapter warns by name on any that are
// missing rather than yielding a board that looks correct and is wrong.
export const REQUIRED_COLUMNS = [
  'Production Nbr.', 'Inventory ID', 'Production Description', 'Item Description',
  'Status', 'End Date', 'Start Date', 'Customer Name', 'Customer Order Nbr.',
  'Order Nbr.', 'Type', 'Qty. to Produce', 'Description', 'Internal Notes',
];

// 'Used by 78SY/002' out of any free-text field.
export const HULL_RE = /used\s*by\s*([A-Z0-9]+\s*\/\s*[A-Z0-9]+)/i;

// A vessel name in the free-text Description field looks like "Riviera 48" or
// "Alaska 47 square transom": a word followed by a number. "5% drawing fee"
// starts with a digit so it does not match and correctly falls through to the
// customer name.
export const VESSEL_IN_DESC_RE = /^\s*([A-Za-z]{3,}\s*\d+[A-Za-z]{0,3})/;

// Trailing company words stripped off a customer name used as a label.
export const CUSTOMER_SUFFIX_RE = /\s+(Pty Ltd|Charters|Yachts|Marine|Group)\b.*$/i;

// The handful of labels the regex cannot resolve. This is the only
// hand-maintained table in the system besides the vessel codes. Keep it small.
export const LABEL_OVERRIDES = {
  STCFXCHOCK: 'Fixed Tender Chocks',
  // Currently unreachable: the SDC0 rule above excludes rope kits before any
  // label is built. Kept because BOARD_SPEC lists it and the SDC0 rule could
  // change; harmless while dead.
  SDC0287: 'Davit Rope Kit',
  // ERP description is `550SSHLHSHE Davit (stock)` — a part code where a
  // description belongs. Overridden here rather than papered over; fix at
  // source when someone gets to it.
  SDC550SSHLHSHE: '550kg Full Hydraulic Davit',
};

/**
 * Category for an Inventory ID. Exactly one of the two fields is non-null.
 * Anything unmatched is excluded loudly — never silently dropped.
 * @returns {{category: string|null, excludeReason: string|null}}
 */
export function classify(inventoryId) {
  const inv = String(inventoryId ?? '').trim().toUpperCase();
  for (const [prefix, category, reason] of CATEGORY_RULES) {
    if (inv.startsWith(prefix)) return { category, excludeReason: reason };
  }
  return { category: null, excludeReason: `unmapped inventory prefix (${inv.slice(0, 20)})` };
}
