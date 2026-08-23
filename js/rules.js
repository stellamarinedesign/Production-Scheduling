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

// Print layout: which categories sit where on the A4 page. Davits runs
// full-width underneath because its descriptions are long.
export const PRINT_LAYOUT = {
  left:  ['Cylinder lifters', 'Ladders and Chairs'],
  right: ['Launchers, Doors & Chocks', 'Rotary Lifters'],
  full:  ['Davits'],
};

// Statuses that appear on the board. Completed/Canceled/Closed are already
// excluded by the ERP saved filter, but re-check in case that filter is edited.
export const BOARD_STATUSES = new Set(['Planned', 'Released', 'In Process', 'On Hold']);

// Customer name that means "no external customer — stock / internal build".
export const INTERNAL_CUSTOMER = 'Stella Marine Group Pty Ltd';

// Columns the transform needs. The adapter warns by name on any that are
// missing rather than yielding a board that looks correct and is wrong.
export const REQUIRED_COLUMNS = [
  'Production Nbr.', 'Inventory ID', 'Production Description', 'Status',
  'End Date', 'Start Date', 'Customer Name', 'Customer Order Nbr.',
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
