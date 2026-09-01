// transform.js — RawRow[] -> Job[].
//
// The only place that knows the ERP's column names. Everything upstream is an
// adapter handing over rows with those names verbatim; everything downstream
// works on the canonical Job record. This function must never branch on where
// the rows came from — if it ever needs to, the adapter contract is wrong.
//
// Every exclusion carries a reason. Nothing disappears silently: if a job is
// missing from the board, the excluded list says why.

import {
  CATEGORY_ORDER, BOARD_STATUSES, INTERNAL_CUSTOMER, HULL_RE,
  LANE, laneFor, tmCategory, internalCategory,
  TM_CATEGORY_ORDER, INTERNAL_CATEGORY_ORDER, PRINT_CATEGORIES,
  VESSEL_IN_DESC_RE, CUSTOMER_SUFFIX_RE, LABEL_OVERRIDES, COMPONENT_TYPE,
  EXCLUSION_ORDER, classify,
} from './rules.js';
import { resolveDisplays, labelFor, detectNewCodes, applyTemplate } from './vessel-codes.js';

// ---------------------------------------------------------------------------
// Value normalisation. This is the transform's job, done once, downstream of
// the adapter boundary — the adapter hands over whatever the source produced.
// ---------------------------------------------------------------------------

const isBlank = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

/** Trimmed string, '' for blanks. Integral numbers never gain a '.0'. */
function text(v) {
  if (isBlank(v)) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

/** Trimmed string, or null for blanks — for the optional background fields. */
const textOrNull = (v) => text(v) || null;

/**
 * A date-only {y, m, d}, or null.
 *
 * SheetJS with `cellDates: true` yields Date objects whose time-of-day is
 * midnight in either UTC or local time depending on version and cell. Reading
 * the parts from the wrong side shifts the due date by a day, which on this
 * board silently moves a job in or out of the horizon. Pick the side that
 * actually sits on midnight.
 */
export function toDateOnly(v) {
  if (isBlank(v) || v === '') return null;

  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    if (v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0) {
      return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
    }
    return { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate() };
  }

  // Excel serial day number (1899-12-30 epoch), in case cellDates is off.
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = Math.round(v) * 86400000 + Date.UTC(1899, 11, 30);
    const d = new Date(ms);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }

  const s = String(v).trim();

  // A bare YYYY-MM-DD is a calendar day and is taken literally.
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };

  // A full timestamp is NOT. Reading the date off the front of
  // "2026-11-11T14:00:00Z" gives the 11th, when what that instant means in
  // Brisbane is midnight on the 12th — which is how a whole board of dates
  // once came back a day early. Resolve it to the local calendar day instead.
  //
  // This assumes the timestamp was written in the same timezone it is read in,
  // which holds here: both managers are in Brisbane, and anything written since
  // the cache was fixed is a bare date that needs no assumption at all.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = new Date(s);
    if (!Number.isNaN(t.getTime())) {
      return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
    }
  }

  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);           // dd/mm/yyyy — AU order
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime())
    ? null
    : { y: parsed.getFullYear(), m: parsed.getMonth() + 1, d: parsed.getDate() };
}

/** Sortable/comparable integer for a date-only value: 20260903. */
const ord = (dt) => (dt ? dt.y * 10000 + dt.m * 100 + dt.d : null);
const pad = (n) => String(n).padStart(2, '0');
export const toISO = (dt) => (dt ? `${dt.y}-${pad(dt.m)}-${pad(dt.d)}` : null);
export const toAU = (dt) => (dt ? `${pad(dt.d)}/${pad(dt.m)}/${dt.y}` : null);

/** Today, as a date-only value in the user's timezone. */
export function today() {
  const n = new Date();
  return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
}

/** dt plus N weeks. */
export function addWeeks(dt, weeks) {
  const d = new Date(Date.UTC(dt.y, dt.m - 1, dt.d) + weeks * 7 * 86400000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** 'Used by 78SY/002' out of any free-text field. Null if absent. */
export function extractHull(...fields) {
  for (const f of fields) {
    if (isBlank(f) || f === '') continue;
    const m = HULL_RE.exec(String(f));
    if (m) return m[1].replace(/\s+/g, '').toUpperCase();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Naming a custom one-off
//
// A custom lifter carries no model code, so its name has to come out of free
// text — and the two columns that could supply it disagree. In the 21/08 export
// `Description` holds the vessel on two of the three custom rows ("Riviera 48",
// "Alaska 47 square transom") and "5% drawing fee" on the third, where the real
// answer is the customer, Galaxy. Neither column is reliably the right one.
//
// So this returns BOTH readings and what each would print, rather than picking.
// `chosen` is what the board shows when nobody has been asked — the historical
// behaviour, unchanged — and `ambiguous` says whether that was a guess. The
// import dialog puts an ambiguous one to the manager; nothing here decides.
// ---------------------------------------------------------------------------

/**
 * The vessel alone does not say a job is a one-off. "Riviera 48" next to a row
 * of standard lifters reads as just another model, so every custom label is
 * prefixed — that is what tells the floor to expect different drawings.
 */
export const CUSTOM_PREFIX = 'Custom Lifter - ';

/**
 * True when a typed custom name amounts to nothing. The dialog prefills the
 * field with the prefix so the convention stays visible, and `trim()` takes the
 * trailing space off it — so "nothing typed" has two spellings, and comparing
 * against CUSTOM_PREFIX alone let "Custom Lifter -" through as a real answer.
 */
export const isEmptyCustomName = (s) => {
  const t = String(s ?? '').trim();
  return !t || t === CUSTOM_PREFIX.trim();
};

/**
 * @returns {null|{
 *   vessel: string|null, ambiguous: boolean,
 *   description: {column: string, raw: string, label: string|null},
 *   customer:    {column: string, raw: string, label: string},
 *   chosen: object,
 * }} null for anything that is not a custom item.
 */
export function customNameOptions({ inventoryId, productionDescription, customer, descField }) {
  const inv = text(inventoryId);
  if (!/CUSTOM/i.test(inv)) return null;

  const descRaw = isBlank(descField) ? '' : String(descField).trim();
  const m = descRaw ? VESSEL_IN_DESC_RE.exec(descRaw) : null;
  const vessel = m ? m[1].replace(/\s+/g, ' ').trim() : null;

  const description = {
    column: 'Description',
    raw: descRaw,
    // With no vessel to read, the column can still be taken at face value — a
    // manager who says "that IS the name" gets exactly what the cell says.
    label: descRaw ? CUSTOM_PREFIX + (vessel ?? descRaw) : null,
  };

  const name = text(customer).replace(CUSTOMER_SUFFIX_RE, '');
  const cust = {
    column: 'Customer Name',
    raw: text(customer),
    label: CUSTOM_PREFIX + (name ? name.toUpperCase() : text(productionDescription)),
  };

  return {
    vessel,
    ambiguous: !vessel,
    description,
    customer: cust,
    chosen: vessel ? description : cust,
  };
}

/**
 * Short board label.
 *
 * THREE SCOPES, narrowest first. They are different things and must not be
 * conflated:
 *
 *   1. jobOverrides[prodNo].labelOverride   one production order  (in buildBoard)
 *   2. itemOverrides[inventoryId]           this product, forever
 *   3. vesselCodes[stellaCode].display      every product on this boat
 *
 * Scope 2 exists because the boat is not always the whole story. The SY26
 * lifter and the 56SY lifter are different products and must print different
 * codes — but a 56SY *ladder* fitted to an SY26 hull is still a 56SY ladder.
 * When an item code says one boat and the part is really another's, the fix
 * belongs to the item, not to the boat and not to one job. It latches to the
 * Inventory ID, so it survives every future production order for that product.
 */
export function shortLabel({
  inventoryId, productionDescription, customer, descField, resolved, codeMap,
  itemOverride = null,
}) {
  const inv = text(inventoryId);
  const desc = text(productionDescription);

  // Whole label, pinned to this product.
  if (itemOverride?.label) return itemOverride.label;

  // Just the vessel code, pinned to this product — the product wording still
  // comes from the template, so 'Boarding Ladder' stays 'Boarding Ladder'.
  if (itemOverride?.displayCode) return applyTemplate(inv, itemOverride.displayCode);

  if (LABEL_OVERRIDES[inv]) return LABEL_OVERRIDES[inv];

  // Custom / one-off work has no model code, so the name comes out of free
  // text — see `customNameOptions`, which is where that decision lives.
  const custom = customNameOptions({ inventoryId, productionDescription, customer, descField });
  if (custom) return custom.chosen.label;

  // Davits are labelled by capacity + configuration, not by vessel.
  //
  // The reference implementation triggered this branch on `SDC* OR is_stock`.
  // Stock-ness has nothing to do with how a davit is identified, and that
  // clause would strip a future stock cylinder lifter of its vessel code and
  // print raw ERP text instead. Narrowed to SDC*, which reproduces the
  // reference output exactly on real data — every stock row in the 21/08
  // export is either SDC* or caught by LABEL_OVERRIDES first.
  if (inv.toUpperCase().startsWith('SDC')) {
    return desc
      .replace(/^Stella\s+Davit\s*/i, '')
      .replace(/\s*[-–]?\s*Used by\s+[A-Z0-9]+\s*\/\s*[A-Z0-9]+\s*$/i, '')
      .trim();
  }

  return labelFor(inv, resolved, codeMap) || desc;
}

// ---------------------------------------------------------------------------
// Status
//
// The ERP owns the status and is usually right, but it lags: a job put on hold
// on the floor this morning still reads In Process in tonight's export, and a
// Planned order the workshop has already started reads Planned for weeks. So a
// manager can set one by hand.
//
// A MANUAL STATUS EXPIRES WHEN THE ERP MOVES. The override records which ERP
// value it was correcting; the moment the export disagrees with that value, the
// correction is about a fact that no longer holds and is dropped. Without this,
// marking a job In Process would permanently mask it being put On Hold later,
// for a different reason, by somebody else — the board would look right and be
// silently stale, which is the failure this whole app exists to avoid.
// ---------------------------------------------------------------------------

export function effectiveStatus(erpStatus, ov) {
  const set = ov?.status;
  if (!set || !BOARD_STATUSES.has(set)) return erpStatus;
  if (ov.statusFrom !== erpStatus) return erpStatus;   // the ERP has moved on
  return set;
}

// ---------------------------------------------------------------------------
// A completed job the export no longer carries
//
// Rebuilt from the snapshot written when it was marked done. Everything the
// History view reads is on the record; everything else is null rather than
// guessed, and `from_snapshot` says plainly that this row is a memory rather
// than a live one, so nothing downstream treats it as current work.
// ---------------------------------------------------------------------------

export function fromSnapshot(prodNo, ov) {
  const snap = ov.snapshot ?? {};
  return {
    prod_no: prodNo,
    from_snapshot: true,
    lane: snap.lane ?? 'production',
    category: snap.category ?? 'Uncategorised',
    label: snap.label ?? prodNo,
    base_label: snap.label ?? prodNo,
    inventory_id: snap.inventory_id ?? '',
    description: snap.description ?? '',
    qty: Number(snap.qty) || 1,
    due_display: snap.due_display ?? '',
    opened_display: snap.opened_display ?? '',
    age_display: snap.age_display ?? '',
    customer: snap.customer ?? '',
    is_stock: Boolean(snap.is_stock),
    status: snap.status ?? '',
    hidden: false,
    completed: true,
    completed_at: ov.completedAt ?? null,
    completed_by: ov.completedBy ?? null,
    progress: 1,
  };
}

/** What is kept about a job when it is completed, so History can outlive the export. */
export const snapshotOf = (j) => ({
  lane: j.lane ?? 'production',
  category: j.category,
  label: j.label,
  inventory_id: j.inventory_id,
  description: j.description ?? '',
  qty: j.qty ?? 1,
  due_display: j.due_display ?? '',
  opened_display: j.opened_display ?? '',
  age_display: j.age_display ?? '',
  customer: j.customer ?? '',
  is_stock: Boolean(j.is_stock),
  status: j.status ?? '',
});

// ---------------------------------------------------------------------------
// What reaches the paper
//
// Three separate reasons a real job does not print, all of them page-fitting
// decisions rather than judgements about the work:
//   - its category is not in PRINT_LAYOUT (watermakers)
//   - it is past the horizon
//   - the stock cap already took enough of its category
// None of them removes it from the board, the Gantt or the order count.
// ---------------------------------------------------------------------------

const PRINTABLE = new Set(PRINT_CATEGORIES);

export const isPrintable = (j) =>
  PRINTABLE.has(j.category) && !j.beyond_horizon && !j.over_stock_cap;

/** The production jobs that go on the printed sheet, in board order. */
export const printJobs = (board) =>
  (board?.jobs ?? []).filter((j) => !j.hidden && !j.completed && isPrintable(j));

// ---------------------------------------------------------------------------
// T&M and internal jobs
//
// These are NOT production orders and are deliberately not modelled as if they
// were. Two differences drive everything below.
//
// There is no vessel code and no label to derive: a T&M row's item code is
// always STELLA-REPAIR-T&M, so the production description IS the name of the
// job — "Machine Rudder Components", "Maintenance on Laser cutter". Running it
// through shortLabel would produce a boat code out of thin air.
//
// And there is no schedule. Every T&M row in the 01/09 export has Start Date
// equal to End Date equal to the date the order was raised: the ERP stamps the
// day and nobody revises it. Eight of the thirteen internal rows are the same.
// A due date built on that is fiction, and a Gantt bar built on it is a
// zero-width mark at an arbitrary point — which is why neither lane goes on the
// chart. What IS true and useful is how long the job has been open, so that is
// what these carry instead.
// ---------------------------------------------------------------------------

/** Whole days from `from` to `to`, both calendar days. */
export function daysBetween(from, to) {
  if (!from || !to) return null;
  return Math.round((Date.UTC(to.y, to.m - 1, to.d) - Date.UTC(from.y, from.m - 1, from.d)) / 86400000);
}

export function ageLabel(days) {
  if (days === null || days === undefined) return '';
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  if (days < 56) return `${days} days`;
  const months = Math.round(days / 30.4);
  return months < 12 ? `${months} months` : `${(days / 365).toFixed(1)} years`;
}

function sideJob(r, lane, { overrides, asOf }) {
  const prodNo = text(r['Production Nbr.']);
  const inv = text(r['Inventory ID']);
  const ov = overrides[prodNo] ?? {};
  const erpStatus = text(r['Status']);
  const status = effectiveStatus(erpStatus, ov);
  const customer = text(r['Customer Name']);
  const startDate = toDateOnly(r['Start Date']);
  const endDate = toDateOnly(r['End Date']);
  const opened = startDate ?? toDateOnly(r['Created Date']);
  const age = daysBetween(opened, asOf);

  // The description is the job. Trimmed of the ERP's own boilerplate prefix so
  // twenty rows do not all begin with the same eight words.
  const described = text(r['Production Description']).replace(/^Stella\s+Repair\s*[-–]\s*/i, '').trim();

  return {
    prod_no: prodNo,
    lane,
    category: lane === LANE.tm ? tmCategory(r) : internalCategory(inv),
    label: ov.labelOverride || described || inv,
    base_label: described || inv,
    inventory_id: inv,
    description: described,
    item_description: text(r['Item Description']),
    customer,
    // A T&M row with no customer at all is the workshop's own work; saying so
    // beats an empty cell.
    customer_display: customer && customer !== INTERNAL_CUSTOMER ? customer : 'Stella Marine',
    project: textOrNull(r['Project']) === 'X' ? null : textOrNull(r['Project']),
    sales_order: textOrNull(r['Order Nbr.']),
    customer_po: textOrNull(r['Customer Order Nbr.']),
    status,
    erp_status: erpStatus,
    status_manual: status !== erpStatus,
    type: text(r['Type']),
    qty: Number(r['Qty. to Produce']) || 1,
    notes: textOrNull(r['Internal Notes']),
    on_hold: status === 'On Hold',
    // Kept so the record is complete and the import review can show them, but
    // NOT surfaced as a due date — see the note above.
    start_date: toISO(startDate),
    end_date: toISO(endDate),
    opened_date: toISO(opened),
    opened_display: opened ? toAU(opened) : '',
    age_days: age,
    age_display: ageLabel(age),
    // The ERP stamps start and end the same day on a row nobody has scheduled.
    // Say so rather than drawing a one-day job.
    unscheduled: Boolean(startDate && endDate
      && toISO(startDate) === toISO(endDate)),
    hidden: Boolean(ov.hidden),
    hidden_reason: ov.hiddenReason ?? null,
    completed: Boolean(ov.completed),
    completed_at: ov.completedAt ?? null,
    completed_by: ov.completedBy ?? null,
    progress: ov.completed ? 1 : (typeof ov.progress === 'number' ? ov.progress : null),
  };
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/**
 * Build the board from raw ERP rows.
 *
 * @param {Array<Object>} rows       RawRow[] — keys are ERP column names verbatim
 * @param {Object}  opts
 * @param {Object}  opts.codeMap     vessel code map (stellaCode -> entry)
 * @param {number|null} opts.horizonWeeks  null = no horizon
 * @param {{y,m,d}} opts.asOf        defaults to today; horizon runs from here
 * @param {Object}  opts.overrides   prodNo -> { hidden, hiddenReason, labelOverride }
 * @param {Object}  opts.itemOverrides  inventoryId -> { label, displayCode } — pins
 *                                    a product's label across every future order
 * @param {number|null} opts.maxStock  cap stock rows per category; null = off
 * @param {boolean} opts.includeCompleted  keep completed jobs on the board too;
 *                                    the Gantt's "everything" view needs them
 * @returns {{jobs: Array, excluded: Array, warnings: Object, meta: Object}}
 */
export function buildBoard(rows, opts = {}) {
  const {
    codeMap = {}, horizonWeeks = 12, asOf = today(),
    overrides = {}, itemOverrides = {}, maxStock = null,
    includeCompleted = false,
  } = opts;

  const resolved = resolveDisplays(codeMap);
  const cutoff = horizonWeeks ? addWeeks(asOf, horizonWeeks) : null;
  const cutoffOrd = cutoff ? ord(cutoff) : null;

  const jobs = [];
  const tmJobs = [];
  const internalJobs = [];
  const excluded = [];
  const completed = [];

  // Codes this export carries that the map has never seen. Detected across ALL
  // rows, not just the ones on the board: a code first appearing outside the
  // horizon is worth resolving now, so it is already right when it arrives.
  const newCodes = detectNewCodes(rows, codeMap);

  for (const r of rows) {
    const prodNo = text(r['Production Nbr.']);
    const inv = r['Inventory ID'];
    const drop = (reason, kind) => excluded.push({
      prod_no: prodNo,
      inventory_id: text(inv),
      description: text(r['Production Description']).slice(0, 70),
      // The item's own description, which is often the more canonical of the
      // two — STFKITAQ reads "Jumbo filter kit Aquarius" here against
      // "4.5\" x 10\" 5/20 micron prefilter set" on the production order.
      item_description: text(r['Item Description']).slice(0, 70),
      reason,
      kind,
    });

    // Which of the three kinds of work this is. Decided BEFORE the category
    // map, because the map would mislead: every T&M row is booked to
    // STELLA-REPAIR-T&M, which starts with ST and would read as a water
    // product. See rules.js `laneFor`.
    const lane = laneFor(r);

    // WHETHER A ROW APPEARS AT ALL is the ERP's call, always. A manual status
    // corrects what a job is doing, not whether it exists — letting an override
    // pull a Completed or Canceled row back onto the board would make the
    // board disagree with the ERP about the order book itself.
    const status0 = text(r['Status']);
    if (!BOARD_STATUSES.has(status0)) { drop(`status '${status0}' not shown on board`, 'category'); continue; }

    if (lane !== LANE.production) {
      const job = sideJob(r, lane, { overrides, asOf });
      if (job.completed) { completed.push(job); if (!includeCompleted) continue; }
      (lane === LANE.tm ? tmJobs : internalJobs).push(job);
      continue;
    }

    const { category, excludeReason } = classify(inv);
    if (excludeReason) {
      drop(excludeReason, excludeReason.startsWith('unmapped') ? 'unmapped' : 'category');
      continue;
    }

    // `Type` is deliberately NOT a filter — see rules.js. It is carried on the
    // record so the manager view can flag a component part, not used to drop it.
    const type = text(r['Type']);

    const status = effectiveStatus(status0, overrides[prodNo]);

    const endDate = toDateOnly(r['End Date']);
    if (!endDate) { drop('no End Date', 'category'); continue; }

    const customer = text(r['Customer Name']);
    const isStock = customer === INTERNAL_CUSTOMER;

    const ov = overrides[prodNo] ?? {};
    const itemOverride = itemOverrides[text(inv)] ?? null;
    const label = shortLabel({
      inventoryId: inv,
      productionDescription: r['Production Description'],
      customer,
      descField: r['Description'],
      resolved,
      codeMap,
      itemOverride,
    });

    // Both readings of a custom job's name, so the import dialog can offer them
    // and so the board can say when it is guessing. Skipped where something
    // more specific has already claimed the label — `shortLabel` returns on an
    // item override or LABEL_OVERRIDES before it ever reaches the custom
    // branch, and a job override replaces its answer a few lines below.
    const nameOptions = (itemOverride?.label || itemOverride?.displayCode || LABEL_OVERRIDES[text(inv)])
      ? null
      : customNameOptions({
        inventoryId: inv,
        productionDescription: r['Production Description'],
        customer,
        descField: r['Description'],
      });

    const startDate = toDateOnly(r['Start Date']);

    const job = {
      prod_no: prodNo,
      lane: LANE.production,
      category,
      description: text(r['Production Description']),
      label: ov.labelOverride || label,
      base_label: label,                       // pre-job-override, for reset
      item_override: itemOverride,             // so the UI can show and clear it
      name_options: nameOptions,               // custom one-offs only; null otherwise
      inventory_id: text(inv),
      customer,
      is_stock: isStock,
      due_date: isStock ? null : toISO(endDate),
      due_display: isStock ? 'STOCK' : toAU(endDate),
      end_date: toISO(endDate),                // real date even for stock — Gantt needs it
      start_date: toISO(startDate),
      status,
      erp_status: status0,
      status_manual: status !== status0,
      type,
      is_component: type === COMPONENT_TYPE,
      qty: Number(r['Qty. to Produce']) || 1,
      // Background fields — captured, not displayed on the printed board:
      item_description: text(r['Item Description']),
      hull: extractHull(r['Description'], r['Production Description']),
      customer_po: textOrNull(r['Customer Order Nbr.']),
      sales_order: textOrNull(r['Order Nbr.']),
      notes: textOrNull(r['Internal Notes']),
      // Flags the board acts on:
      on_hold: status === 'On Hold',
      hidden: Boolean(ov.hidden),
      hidden_reason: ov.hiddenReason ?? null,
      // COMPLETION — marked here, not in the ERP.
      //
      // The handoff assumed completed work never arrives, because the ERP saved
      // filter drops Completed/Canceled/Closed before the export is written.
      // That only holds while the ERP status actually flips. A job finished on
      // the floor but never closed in the ERP stays `In Process` in every
      // export from then on, so the board accumulates work that is long done —
      // which is what the six past-due rows and all seven stock builds are.
      //
      // Hiding was the nearest existing tool and it is the wrong one: hidden
      // means "not on this print", completed means "finished, for good".
      completed: Boolean(ov.completed),
      completed_at: ov.completedAt ?? null,
      completed_by: ov.completedBy ?? null,
      // 0..1. No UI sets this yet; a completed job reads as done so the bar is
      // full the moment it is marked, rather than waiting on tracking.
      progress: ov.completed ? 1 : (typeof ov.progress === 'number' ? ov.progress : null),
    };

    // Completed work leaves the board permanently and lands in History. The
    // check sits ahead of the horizon so a job finished months ago is still a
    // full record rather than a horizon exclusion.
    if (job.completed) {
      completed.push(job);
      if (!includeCompleted) continue;
    }

    // THE HORIZON IS A PRINT SETTING, NOT A FILTER.
    //
    // It used to drop rows out of the board entirely, which made the app a
    // thing for producing one sheet of paper. It is used far more for looking
    // at what the workshop has committed to, and an order due in five months is
    // still committed work. So a job beyond the horizon stays on the board and
    // on the Gantt, marked, and the printed sheet is what the horizon trims.
    //
    // Stock builds carry no due-date commitment at all — they are never trimmed
    // by the horizon, and print as STOCK.
    job.beyond_horizon = cutoffOrd !== null && ord(endDate) > cutoffOrd
      && !isStock && !job.completed;

    jobs.push(job);
  }

  // Category order, then stock last within category, then due date ascending.
  // Ties keep source order — Array.prototype.sort is stable.
  const rank = new Map(CATEGORY_ORDER.map((c, i) => [c, i]));
  jobs.sort((a, b) =>
    (rank.get(a.category) ?? 99) - (rank.get(b.category) ?? 99)
    || (a.is_stock ? 1 : 0) - (b.is_stock ? 1 : 0)
    || String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')));

  // Stock cap — like the horizon, a question about what fits on the page, so it
  // marks rather than removes. Counted after the sort, so the cap keeps the
  // stock builds that sort first rather than whichever the export listed first.
  const kept = jobs;
  if (maxStock !== null && maxStock !== undefined && maxStock !== '') {
    const seen = new Map();
    for (const j of jobs) {
      if (!j.is_stock) continue;
      const n = (seen.get(j.category) ?? 0) + 1;
      seen.set(j.category, n);
      j.over_stock_cap = n > Number(maxStock);
    }
  }

  // Horizon cuts first — that is the group the manager acts on, by widening it.
  // Then the stock-cap trim, then codes needing a rule, then everything else
  // grouped by reason so like sits with like.
  const kindRank = new Map(EXCLUSION_ORDER.map((k, i) => [k, i]));
  excluded.sort((a, b) =>
    (kindRank.get(a.kind) ?? 99) - (kindRank.get(b.kind) ?? 99)
    || String(a.reason).localeCompare(String(b.reason))
    || String(a.prod_no).localeCompare(String(b.prod_no)));

  // Side lanes: category order, then oldest first — what a manager wants from
  // these tabs is what has been sitting the longest.
  const sortSide = (rows, order) => {
    const r = new Map(order.map((c, i) => [c, i]));
    return rows.sort((a, b) =>
      (r.get(a.category) ?? 99) - (r.get(b.category) ?? 99)
      || (b.age_days ?? 0) - (a.age_days ?? 0)
      || String(a.prod_no).localeCompare(String(b.prod_no)));
  };
  sortSide(tmJobs, TM_CATEGORY_ORDER);
  sortSide(internalJobs, INTERNAL_CATEGORY_ORDER);

  // AN IMPORT SUPPLEMENTS THE RECORD, IT DOES NOT REPLACE IT.
  //
  // History used to be assembled only from rows in the current export, which
  // made it quietly lossy in the exact case it exists for: mark a job done, the
  // ERP closes it a fortnight later, the row stops being exported, and the
  // completed job disappears from the one view whose job is to remember it.
  // Same for a row that simply is not in the next export.
  //
  // So anything marked completed that this export does not carry is rebuilt
  // from the snapshot taken when it was completed.
  //
  // `seen` is what the export actually PRODUCED, not every production number it
  // mentioned. The difference is the whole case: when the ERP finally marks a
  // job Completed the row is still in the file, but the status gate drops it,
  // so treating "mentioned" as "carried" would skip the restore and lose the
  // record at exactly the moment it is needed.
  const seen = new Set([...kept, ...tmJobs, ...internalJobs, ...completed]
    .map((j) => j.prod_no));
  for (const [prodNo, ov] of Object.entries(overrides)) {
    if (!ov?.completed || seen.has(prodNo)) continue;
    completed.push(fromSnapshot(prodNo, ov));
  }

  const visible = kept.filter((j) => !j.hidden && !j.completed);
  const onPaper = visible.filter(isPrintable);
  const tmVisible = tmJobs.filter((j) => !j.hidden && !j.completed);
  const internalVisible = internalJobs.filter((j) => !j.hidden && !j.completed);
  return {
    jobs: kept,
    tm: tmJobs,
    internal: internalJobs,
    excluded,
    completed: completed.sort((a, b) =>
      String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? ''))),
    warnings: {
      // Only warn for jobs that would actually appear — an On Hold job outside
      // the horizon is already gone and is not worth flagging.
      onHold: visible.filter((j) => j.on_hold),
      hidden: kept.filter((j) => j.hidden),
      unmapped: excluded.filter((e) => e.kind === 'unmapped'),
      // On the board, past its end date, and not marked done. The prompt for
      // the bulk-complete sweep.
      pastDue: visible.filter((j) => j.end_date && j.end_date < toISO(asOf)),
      components: visible.filter((j) => j.is_component),
      // On the board but not on the printed sheet. NOT exclusions — the horizon
      // and the stock cap are page-fitting settings, and these are real jobs the
      // manager can see everywhere except on paper.
      beyondHorizon: visible.filter((j) => j.beyond_horizon),
      overStockCap: visible.filter((j) => j.over_stock_cap),
      offPaper: visible.filter((j) => !isPrintable(j)),
      // Custom jobs the board can only guess the name of. A job override means
      // a human has settled it — whichever way they answered, including the
      // reading the board would have picked anyway, so it is never re-asked.
      customNames: visible.filter((j) =>
        j.name_options?.ambiguous && !overrides[j.prod_no]?.labelOverride),
      newCodes,
      codeConflicts: resolved.conflicts,
      codeUndecided: resolved.undecided,
    },
    meta: {
      as_of: toISO(asOf),
      horizon_end: cutoff ? toISO(cutoff) : null,
      horizon_weeks: horizonWeeks ?? null,
      max_stock: maxStock ?? null,
      row_count: rows.length,
      job_count: visible.length,
      tm_count: tmVisible.length,
      internal_count: internalVisible.length,
      print_count: onPaper.length,
    },
    resolved,
  };
}

/**
 * What a job is called wherever it is shown — label plus quantity.
 *
 * A DISPLAY concern, deliberately not baked into `label`. The label editor
 * prefills from `label`, so a suffix stored there would be saved back into the
 * override and then suffixed again on the next render: "Chocks x2 x2".
 *
 * Only ever shown when there is more than one to build. "x1" on 85 of 92 rows
 * would be noise that buries the three that matter.
 */
export const jobTitle = (j) => (Number(j?.qty) > 1 ? `${j.label} x${j.qty}` : j?.label ?? '');

/** Jobs grouped by category in board order, hidden ones dropped. */
export function byCategory(jobs, { includeHidden = false } = {}) {
  const out = new Map(CATEGORY_ORDER.map((c) => [c, []]));
  for (const j of jobs) {
    if (!includeHidden && j.hidden) continue;
    out.get(j.category)?.push(j);
  }
  return out;
}
