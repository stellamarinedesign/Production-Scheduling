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
// Marker category, never displayed. Water products are one prefix family but two
// different things to a manager, and the difference is not in the prefix — it is
// in the suffix. `classify` refines this into the two real categories below.
const WATER = '@water';

// A finished watermaker's item code ends in flow rate over voltage:
// STAQSAB/240/230, STAQFAB/240/230, STAQFAR/240/230, STG4/240/230,
// STG4LA/160/230. Everything else in the family — STMEDIAFILTER, STKITJUMBO,
// STFKITAQ, STMU, STPH, ST DUPLEX UPGRADE X3, STG3COMFILTUPGRADE — is a kit,
// filter, upgrade or spare that ships against the same order.
//
// STAUTO24 ends in a voltage but is a flush accessory, not a unit, which is why
// this anchors on the LPH/volts PAIR rather than one trailing number.
export const WATERMAKER_UNIT_RE = /\/\d+\/\d+\s*$/;

// Softeners are a product line, not a parts family: SS is the whole prefix and
// SS17500, the Stellasoftener, is the only code either export has ever carried.
// So SS is a finished unit on the prefix alone - there is no flow-rate/voltage
// pair in the code to read, and no SS accessory to confuse it with.
//
// If softener spares ever arrive under this prefix they will read as units
// until somebody adds a rule, which is the same bargain every prefix here makes.
export const SOFTENER_PREFIX = 'SS';

/** Finished unit, as against a kit, filter, upgrade or spare. */
export const isWaterUnit = (inventoryId) => {
  const inv = String(inventoryId ?? '').trim().toUpperCase();
  return WATERMAKER_UNIT_RE.test(inv) || inv.startsWith(SOFTENER_PREFIX);
};

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
  // Water treatment. These used to be excluded outright. They now reach the
  // board under WATER, which `classify` splits into finished units and
  // accessories. They are still kept off the printed sheet by PRINT_LAYOUT,
  // which lists what prints rather than what exists.
  //
  // Ordering matters as much here as anywhere: STL (launchers), STC (chocks)
  // and both COMMISSION spellings all begin with ST and are all matched above.
  // Anything reaching these rules is genuinely a water product.
  ['STKIT',              WATER,                        null],
  ['STF',                WATER,                        null],
  ['STMEDIAFILTER',      WATER,                        null],
  ['ST',                 WATER,                        null],
  ['SS',                 WATER,                        null],   // softeners - always a unit
];

// Board display order — matches the current Word document.
export const CATEGORY_ORDER = [
  'Launchers, Doors & Chocks',
  'Cylinder lifters',
  'Ladders and Chairs',
  'Rotary Lifters',
  'Davits',
  // Water treatment, at the bottom of the board and off the printed sheet.
  'Watermakers',
  'Watermaker accessories',
];

export const WATER_CATEGORY = { unit: 'Watermakers', accessory: 'Watermaker accessories' };
export const WATERMAKER_CATEGORIES = [WATER_CATEGORY.unit, WATER_CATEGORY.accessory];

// Print layout. Davits runs full-width underneath because its descriptions are
// long; the other four share a two-column grid.
//
// Which of the four sits in which column is NOT fixed — print.js balances them
// by row count so the page comes out as short as possible. With 19 cylinder
// lifters against 5 rotary, a pinned layout wastes most of one column.
// It is also what decides that watermakers do not print: it lists what goes on
// the sheet rather than what exists, so a category added to the board stays off
// the paper until somebody puts it here deliberately.
export const PRINT_LAYOUT = {
  narrow: ['Cylinder lifters', 'Ladders and Chairs', 'Launchers, Doors & Chocks', 'Rotary Lifters'],
  full:   ['Davits'],
};

// Pinned to the top of the left column, on the sheet and in the orders view.
//
// It is the biggest category and the one the floor reads first, and a balancer
// free to put it anywhere moved it between prints as the row counts drifted.
// Everything else still balances around it, which is where the balancing earns
// its keep; this one category just does not move.
export const ANCHOR_CATEGORY = 'Cylinder lifters';

/** Every category that reaches the printed sheet, in board order. */
export const PRINT_CATEGORIES = [...PRINT_LAYOUT.narrow, ...PRINT_LAYOUT.full];

// Statuses that appear on the board. Completed/Canceled/Closed are already
// excluded by the ERP saved filter, but re-check in case that filter is edited.
export const BOARD_STATUSES = new Set(['Planned', 'Released', 'In Process', 'On Hold']);

// What a manager may set a job to by hand, in the order the work runs.
//
// The same four the ERP uses, deliberately: the point of a manual status is to
// correct one the ERP has not caught up with - a job put on hold on the floor
// this morning, a planned order the workshop has actually started - not to
// invent a vocabulary the ERP cannot express. Inventing one would also break
// the round trip, because the override is dropped as soon as the ERP moves.
export const SETTABLE_STATUSES = ['Planned', 'Released', 'In Process', 'On Hold'];

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
  // 'Order Type' is load-bearing: it is what separates T&M from everything else.
  'Order Type',
  'Production Nbr.', 'Inventory ID', 'Production Description', 'Item Description',
  'Status', 'End Date', 'Start Date', 'Customer Name', 'Customer Order Nbr.',
  'Order Nbr.', 'Type', 'Qty. to Produce', 'Description', 'Internal Notes',
];

// 'Used by 00SY/001' out of any free-text field.
export const HULL_RE = /used\s*by\s*([A-Z0-9]+\s*\/\s*[A-Z0-9]+)/i;

// A one-off built on a STANDARD item code.
//
// A custom lifter has its own code (SLCUSTOM*, SRLCUSTOM*) and is handled by
// that. This is the other kind: a standard product modified for one order, so
// the code says nothing and only the free text does. Across the whole 01/09
// export — 1216 rows — six say "custom" without a custom code, and all six are
// genuinely one-offs: a derated 650kg davit with an extended boom, a custom
// folding davit, a custom seawater filter bracket, custom-length hoses, a
// custom single-arm lifter, a bespoke Meridian 420 build. No false positives.
//
// Deliberately a keyword and not a similarity test. Comparing the production
// description against the item description flags nine davit rows and only two
// are real — the rest are customer names ("Harbour Marine"), shipping notes
// ("International Export through Freight Forwarding facility") and hull refs.
// A person writing "custom" means it; a wording difference means nothing.
export const CUSTOM_TEXT_RE = /\bcustom\b/i;

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
  // SDC550SSHLHSHE was here, because its PRODUCTION description was
  // `550SSHLHSHE Davit (stock)` — a part code where a description belongs. Its
  // ITEM description is `Stella Davit 550kg - Single Stage (Hydraulic Luff /
  // Hydraulic Slew / Hydraulic Extension)`, which is the fix that entry was
  // waiting for, so the davit rule now handles it like every other davit and
  // says more than the hand-written label did.
};

/**
 * Category for an Inventory ID. Exactly one of the two fields is non-null.
 * Anything unmatched is excluded loudly — never silently dropped.
 * @returns {{category: string|null, excludeReason: string|null}}
 */
export function classify(inventoryId) {
  const inv = String(inventoryId ?? '').trim().toUpperCase();
  for (const [prefix, category, reason] of CATEGORY_RULES) {
    if (!inv.startsWith(prefix)) continue;
    // The prefix says "water product"; the suffix says which kind.
    if (category === WATER) {
      return {
        category: isWaterUnit(inv) ? WATER_CATEGORY.unit : WATER_CATEGORY.accessory,
        excludeReason: null,
      };
    }
    return { category, excludeReason: reason };
  }
  return { category: null, excludeReason: `unmapped inventory prefix (${inv.slice(0, 20)})` };
}

// ---------------------------------------------------------------------------
// LANES
//
// The ERP export holds three different kinds of work that the office sorts by
// hand into three sheets. Two fields reproduce that split exactly — 120 of 120
// rows in the 01/09 export, no misclassifications:
//
//   Order Type == 'TM'                                 Time & Materials
//   no Order Nbr. AND Type == 'Component Part'         internal factory job
//   otherwise                                          production order
//
// `Order Nbr.` blank and `Order Type_1` blank agree on every row, so either
// works; the sales order is the one that means something — internal work has no
// customer behind it. `Type` is what separates an internal sub-assembly (bronze
// glands, bearing tubes, Aquarius panels — all Component Part) from a stock
// build of a sellable product (davits, chocks — all Finished Good), which is
// production work that happens to have no buyer yet.
//
// This is a rule about how an order was RAISED, not about what it is for, so it
// cannot fix a miskeyed row: SDC0287, the davit rope kit, is booked Finished
// Good and therefore reads as production. The import review flags it rather
// than the rule bending around it.
// ---------------------------------------------------------------------------
export const LANE = { production: 'production', tm: 'tm', internal: 'internal' };

export const LANE_LABEL = {
  production: 'Production orders',
  tm: 'Time & Materials Jobs',
  internal: 'Internal Factory Jobs',
};

export function laneFor(row) {
  const val = (k) => String(row?.[k] ?? '').trim();
  if (val('Order Type').toUpperCase() === 'TM') return LANE.tm;
  if (!val('Order Nbr.') && val('Type') === COMPONENT_TYPE) return LANE.internal;
  return LANE.production;
}

// Categories for the two new lanes. Neither can use CATEGORY_RULES: every T&M
// row in the export is booked to STELLA-REPAIR-T&M or STELLA-REPAIR-T&M 2, so
// the item code carries nothing at all.
//
// T&M splits on whether there is a sales order behind it — chargeable customer
// work against the workshop's own jobs, maintenance and warranty. That is the
// only distinction the data actually supports; `Project` agrees with it on
// every row (PR#### where there is an order, 'X' where there is not).
export const TM_CATEGORY = { customer: 'Customer work', internal: 'Workshop & internal' };
export const TM_CATEGORY_ORDER = [TM_CATEGORY.customer, TM_CATEGORY.internal];

export const tmCategory = (row) =>
  String(row?.['Order Nbr.'] ?? '').trim() ? TM_CATEGORY.customer : TM_CATEGORY.internal;

// Internal jobs are sub-assemblies, so the item code IS informative — it is the
// part number of the thing being made. Product line by prefix.
export const INTERNAL_CATEGORY_RULES = [
  ['SDC', 'Davit parts'],
  ['SL',  'Cylinder lifter parts'],
  ['ST',  'Watermaker parts'],
  ['SS',  'Watermaker parts'],
];
export const INTERNAL_CATEGORY_ORDER = ['Cylinder lifter parts', 'Watermaker parts', 'Davit parts', 'Other parts'];

export function internalCategory(inventoryId) {
  const inv = String(inventoryId ?? '').trim().toUpperCase();
  for (const [prefix, category] of INTERNAL_CATEGORY_RULES) {
    if (inv.startsWith(prefix)) return category;
  }
  return 'Other parts';
}
