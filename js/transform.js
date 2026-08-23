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
  VESSEL_IN_DESC_RE, CUSTOMER_SUFFIX_RE, LABEL_OVERRIDES, classify,
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
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
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

  // Custom / one-off work has no model code. The ERP Description field often
  // carries the real vessel ("Riviera 48", "Alaska 47") — prefer that, and fall
  // back to the customer name when it holds something else entirely
  // ("5% drawing fee" starts with a digit, so it falls through).
  if (/CUSTOM/i.test(inv)) {
    if (!isBlank(descField) && descField !== '') {
      const m = VESSEL_IN_DESC_RE.exec(String(descField));
      if (m) return m[1].replace(/\s+/g, ' ').trim();
    }
    const name = text(customer).replace(CUSTOMER_SUFFIX_RE, '');
    return name ? name.toUpperCase() : desc;
  }

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
 * @returns {{jobs: Array, excluded: Array, warnings: Object, meta: Object}}
 */
export function buildBoard(rows, opts = {}) {
  const {
    codeMap = {}, horizonWeeks = 12, asOf = today(),
    overrides = {}, itemOverrides = {}, maxStock = null,
  } = opts;

  const resolved = resolveDisplays(codeMap);
  const cutoff = horizonWeeks ? addWeeks(asOf, horizonWeeks) : null;
  const cutoffOrd = cutoff ? ord(cutoff) : null;

  const jobs = [];
  const excluded = [];

  // Codes this export carries that the map has never seen. Detected across ALL
  // rows, not just the ones on the board: a code first appearing outside the
  // horizon is worth resolving now, so it is already right when it arrives.
  const newCodes = detectNewCodes(rows, codeMap);

  for (const r of rows) {
    const prodNo = text(r['Production Nbr.']);
    const inv = r['Inventory ID'];
    const drop = (reason) => excluded.push({
      prod_no: prodNo,
      inventory_id: text(inv),
      description: text(r['Production Description']).slice(0, 70),
      reason,
    });

    const { category, excludeReason } = classify(inv);
    if (excludeReason) { drop(excludeReason); continue; }

    if (text(r['Type']) !== 'Finished Good') { drop('component part, not a finished good'); continue; }

    const status = text(r['Status']);
    if (!BOARD_STATUSES.has(status)) { drop(`status '${status}' not shown on board`); continue; }

    const endDate = toDateOnly(r['End Date']);
    if (!endDate) { drop('no End Date'); continue; }

    const customer = text(r['Customer Name']);
    const isStock = customer === INTERNAL_CUSTOMER;

    // Stock builds carry no real due-date commitment — they stay on the board
    // regardless of horizon, shown as STOCK.
    if (cutoffOrd !== null && ord(endDate) > cutoffOrd && !isStock) {
      drop(`due ${toISO(endDate)}, beyond ${horizonWeeks}-week horizon`);
      continue;
    }

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

    const startDate = toDateOnly(r['Start Date']);

    jobs.push({
      prod_no: prodNo,
      category,
      description: text(r['Production Description']),
      label: ov.labelOverride || label,
      base_label: label,                       // pre-job-override, for reset
      item_override: itemOverride,             // so the UI can show and clear it
      inventory_id: text(inv),
      customer,
      is_stock: isStock,
      due_date: isStock ? null : toISO(endDate),
      due_display: isStock ? 'STOCK' : toAU(endDate),
      end_date: toISO(endDate),                // real date even for stock — Gantt needs it
      start_date: toISO(startDate),
      status,
      qty: Number(r['Qty. to Produce']) || 1,
      // Background fields — captured, not displayed on the printed board:
      hull: extractHull(r['Description'], r['Production Description']),
      customer_po: textOrNull(r['Customer Order Nbr.']),
      sales_order: textOrNull(r['Order Nbr.']),
      notes: textOrNull(r['Internal Notes']),
      // Flags the board acts on:
      on_hold: status === 'On Hold',
      hidden: Boolean(ov.hidden),
      hidden_reason: ov.hiddenReason ?? null,
    });
  }

  // Category order, then stock last within category, then due date ascending.
  // Ties keep source order — Array.prototype.sort is stable.
  const rank = new Map(CATEGORY_ORDER.map((c, i) => [c, i]));
  jobs.sort((a, b) =>
    (rank.get(a.category) ?? 99) - (rank.get(b.category) ?? 99)
    || (a.is_stock ? 1 : 0) - (b.is_stock ? 1 : 0)
    || String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')));

  // Per-board stock cap. Trims only when an export carries more stock builds
  // than the page will hold; off by default.
  let kept = jobs;
  if (maxStock !== null && maxStock !== undefined && maxStock !== '') {
    const seen = new Map();
    kept = [];
    for (const j of jobs) {
      if (j.is_stock) {
        const n = (seen.get(j.category) ?? 0) + 1;
        seen.set(j.category, n);
        if (n > Number(maxStock)) {
          excluded.push({
            prod_no: j.prod_no,
            inventory_id: j.inventory_id,
            description: j.description.slice(0, 70),
            reason: `stock build beyond stock cap ${maxStock}`,
          });
          continue;
        }
      }
      kept.push(j);
    }
  }

  const visible = kept.filter((j) => !j.hidden);
  return {
    jobs: kept,
    excluded,
    warnings: {
      // Only warn for jobs that would actually appear — an On Hold job outside
      // the horizon is already gone and is not worth flagging.
      onHold: visible.filter((j) => j.on_hold),
      hidden: kept.filter((j) => j.hidden),
      unmapped: excluded.filter((e) => e.reason.startsWith('unmapped')),
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
    },
    resolved,
  };
}

/** Jobs grouped by category in board order, hidden ones dropped. */
export function byCategory(jobs, { includeHidden = false } = {}) {
  const out = new Map(CATEGORY_ORDER.map((c) => [c, []]));
  for (const j of jobs) {
    if (!includeHidden && j.hidden) continue;
    out.get(j.category)?.push(j);
  }
  return out;
}
