// vessel-codes.js — Stella code derivation, boat grouping, board labels.
//
// the manufacturer issue concept hull codes to conceal unreleased vessel models, so a
// Stella item code (XX16) and the model actually used in practice (XX06) can
// differ. Which one the floor uses is a HUMAN decision — it cannot be derived.
// This module derives what can be derived and resolves the rest through the
// hand-maintained `display` field.

// Everything after "RIV" is the model. Anchoring on RIV rather than on the
// first digit is what makes SWD4PDRIVXX02 resolve to XX02 and not 4PDRIV.
export const CODE_RE = /RIV([A-Z0-9/]+?)(?:\(\d+\)|\/\d+)?$/i;

// Product wording per item-code prefix. {code} is the resolved display code.
// Ordered: the first matching prefix wins.
export const PRODUCT_TEMPLATE = [
  ['SGD', '{code} Garage Door'],
  ['STL', '{code} Launcher'],
  ['SBL', 'Boarding Ladder {code}'],
  ['SWD', 'Watertight Door {code}'],
  ['SHC', 'Helm Seat Box {code}'],
  ['SRL', '{code}'],
  ['SL',  '{code}'],
];

// Item-code prefixes that carry a vessel code at all. ST* is watermakers but
// STL* is tender launchers, so the check has to be specific.
//
// SDC is deliberately ABSENT. Some davits are built for a specific boat and say
// so in the code; most are not, and a generic davit has no boat to record.
// Adding the prefix would work — `stellaCode` already tells them apart — but it
// makes the manufacturer's own model codes into vessel codes, which every
// deployment would then be asked to resolve on its next import. That is a
// decision, not a detail.
const VESSEL_CODED_PREFIXES = ['SL', 'SRL', 'SBL', 'SGD', 'STL', 'SWD', 'SHC'];

/** The Stella code — the token after RIV. Null when the item carries none. */
export function stellaCode(inventoryId) {
  const m = CODE_RE.exec(String(inventoryId ?? ''));
  return m ? m[1].toUpperCase() : null;
}

/** Does this item code belong to a vessel-coded product line? */
export function isVesselCoded(inventoryId) {
  const u = String(inventoryId ?? '').toUpperCase();
  if (u.includes('COMMISSION') || u.startsWith('SLPOWER')) return false;
  return VESSEL_CODED_PREFIXES.some((p) => u.startsWith(p));
}

// ---------------------------------------------------------------------------
// BOAT GROUPS
//
// Two or more Stella codes can name the same boat. The map is keyed on the
// Stella code, so SLRIVXX01(24) and SHCELECPLINTHRIVXX01 became independent
// entries and nothing ever compared them.
//
// Grouping is MANUAL, via the `boat` field. It has to be: the upstream codes
// are not consistently managed, so no derivable signal gets this right.
//
//   - 56 / XX16 / XX05 are one boat. the manufacturer call it XX06 and also XX15;
//     `56` was a lazy office entry for XX06. Their the manufacturer models do not match
//     as strings, so a model-matching rule splits them wrongly.
//   - 56 and XX05 share the hull prefix 5000 — but hull prefixes are a third
//     code system and a XX06-model part can be fitted to a 5000 hull, so hull
//     is not evidence of identity either.
//
// A shared the manufacturer model is still a good SUGGESTION for a code nobody has
// assigned yet, so it seeds the group for un-assigned codes only. The moment a
// human sets `boat`, that wins — in both directions. Two codes sharing a model
// but carrying different `boat` values stay split, because someone said so.
// ---------------------------------------------------------------------------

/** The group key for a code: explicit when assigned, else null. */
export const boatOf = (codeMap, code) => codeMap[code]?.boat ?? null;

/**
 * Partition the code map into boat groups.
 * @returns {Array<{codes: string[], models: string[], boat: string|null, assigned: boolean}>}
 */
export function aliasGroups(codeMap) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  for (const code of Object.keys(codeMap)) if (!parent.has(code)) parent.set(code, code);

  // 1. Explicit assignment is authoritative.
  const byBoat = new Map();
  for (const code of Object.keys(codeMap)) {
    const boat = boatOf(codeMap, code);
    if (!boat) continue;
    const key = boat.toUpperCase();
    if (byBoat.has(key)) union(code, byBoat.get(key));
    else byBoat.set(key, code);
  }

  // 2. THE DISPLAY IS THE BOAT, so two codes printing the same thing are one
  //    boat whatever their stored key says.
  //
  //    This is what makes the model self-healing. `boat` and `display` are
  //    written together now, but Firestore still holds entries from before they
  //    were aligned — XX01 stored with boat 'XX11' — and a code given the
  //    display 'XX01' by hand takes boat 'XX01'. Grouping on the key alone put
  //    those on two rows that both printed XX01, which is precisely the
  //    confusion the page exists to remove. No migration needed: they merge on
  //    what they print.
  const byDisplay = new Map();
  for (const [code, entry] of Object.entries(codeMap)) {
    const d = entry?.display;
    if (!d) continue;
    const key = String(d).trim().toUpperCase();
    if (byDisplay.has(key)) union(code, byDisplay.get(key));
    else byDisplay.set(key, code);
  }

  // 3. A shared the manufacturer model only suggests a group, and only for codes nobody
  //    has assigned. Never merge across two different explicit assignments.
  const byModel = new Map();
  for (const [code, entry] of Object.entries(codeMap)) {
    for (const model of entry?.riviera ?? []) {
      const key = String(model).toUpperCase();
      const seen = byModel.get(key);
      if (!seen) { byModel.set(key, code); continue; }
      const a = boatOf(codeMap, code);
      const b = boatOf(codeMap, seen);
      if (a && b && a.toUpperCase() !== b.toUpperCase()) continue;   // deliberately split
      union(code, seen);
    }
  }

  const groups = new Map();
  for (const code of Object.keys(codeMap)) {
    const root = find(code);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(code);
  }

  return [...groups.values()]
    .map((codes) => {
      const models = new Set();
      let boat = null;
      let display = null;
      for (const c of codes) {
        for (const m of codeMap[c]?.riviera ?? []) models.add(String(m).toUpperCase());
        boat ??= boatOf(codeMap, c);
        // A confirmed display speaks for the group; fall back to any display.
        if (codeMap[c]?._confirmed && codeMap[c]?.display) display ??= codeMap[c].display;
      }
      for (const c of codes) display ??= codeMap[c]?.display;
      // Report the boat as what it prints. The stored key may still be a legacy
      // value; the display is the identity.
      return {
        codes: codes.sort(), models: [...models].sort(),
        boat: display ?? boat, assigned: Boolean(boat ?? display),
      };
    })
    .sort((a, b) => a.codes[0].localeCompare(b.codes[0]));
}

/**
 * Resolve the display code for every Stella code, applying alias groups.
 *
 * Within a group: a confirmed entry supplies the display code. Two confirmed
 * entries that disagree are a conflict — surfaced, never silently resolved.
 * A group with no confirmed entry needs a decision and is surfaced too, using
 * its existing value provisionally.
 *
 * @returns {{display: Map<string,string>, groups: Array, conflicts: Array, undecided: Array}}
 */
export function resolveDisplays(codeMap) {
  const display = new Map();
  const conflicts = [];
  const undecided = [];
  const groups = aliasGroups(codeMap);

  for (const group of groups) {
    const entries = group.codes.map((c) => ({ code: c, ...(codeMap[c] ?? {}) }));
    const confirmed = entries.filter((e) => e._confirmed);
    const distinct = [...new Set(confirmed.map((e) => e.display).filter(Boolean))];

    let chosen;
    if (distinct.length === 1) {
      chosen = distinct[0];
    } else if (distinct.length > 1) {
      // Two hand-confirmed answers for one boat. Do not guess.
      chosen = distinct[0];
      conflicts.push({
        codes: group.codes,
        models: group.models,
        values: confirmed.filter((e) => e.display).map((e) => ({ code: e.code, display: e.display })),
      });
    } else {
      // Nothing confirmed — keep whatever is there, flag for a decision.
      chosen = entries.find((e) => e.display)?.display || group.codes[0];
      undecided.push({ codes: group.codes, models: group.models, provisional: chosen });
    }

    for (const c of group.codes) display.set(c, chosen);
  }

  // Codes whose display now differs from what the raw map holds — i.e. the
  // ones the alias rule corrected. Worth showing on the vessel codes page.
  for (const group of groups) {
    group.display = display.get(group.codes[0]);
    group.corrected = group.codes.filter((c) => (codeMap[c]?.display ?? c) !== display.get(c));
  }

  return { display, groups, conflicts, undecided };
}

/** Display code for one Stella code, honouring alias groups. */
export function displayFor(code, resolved, codeMap = {}) {
  if (!code) return null;
  return resolved?.display?.get(code) ?? codeMap[code]?.display ?? code;
}

/**
 * Wrap a display code in this item's product wording.
 * 'XX03' + SGDRIVXX03 -> 'XX03 Garage Door'.
 */
export function applyTemplate(inventoryId, displayCode) {
  const inv = String(inventoryId ?? '').toUpperCase();
  for (const [prefix, tmpl] of PRODUCT_TEMPLATE) {
    if (inv.startsWith(prefix)) return tmpl.replace('{code}', displayCode).trim();
  }
  return displayCode;
}

/**
 * Full board label for a vessel-coded item — 'XX03 Garage Door',
 * 'Boarding Ladder XX06'. Null when the item carries no vessel code.
 */
export function labelFor(inventoryId, resolved, codeMap = {}) {
  const code = stellaCode(inventoryId);
  if (!code) return null;
  return applyTemplate(inventoryId, displayFor(code, resolved, codeMap));
}

/**
 * Derive the code cross-reference from an export — the columns that CAN be
 * derived. Merged into the stored map without ever overwriting a `display`.
 * @returns {Object} code -> { riviera[], hull_prefix[], items[], descriptions[], count }
 */
export function deriveFromRows(rows) {
  const out = {};
  for (const r of rows) {
    const inv = String(r['Inventory ID'] ?? '');
    if (!isVesselCoded(inv)) continue;
    const code = stellaCode(inv);
    if (!code) continue;

    const e = (out[code] ??= {
      riviera: new Set(), hull_prefix: new Set(), items: new Set(),
      descriptions: new Set(), count: 0,
    });
    e.items.add(inv);
    e.count += 1;

    const prodDesc = String(r['Production Description'] ?? '').trim();
    if (prodDesc) e.descriptions.add(prodDesc);

    const blob = `${r['Description'] ?? ''} ${prodDesc}`;
    const h = /Used by\s*([A-Z0-9]+)\s*\//i.exec(blob);
    if (h) e.hull_prefix.add(h[1].toUpperCase());

    const dm = /Riviera\s+([0-9][0-9A-Z/\s]*?)\s*(?:-|$)/i.exec(prodDesc);
    if (dm) e.riviera.add(dm[1].trim().replace(/\s*\/\s*/g, '/').toUpperCase());
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => [k, {
      riviera: [...v.riviera].sort(),
      hull_prefix: [...v.hull_prefix].sort(),
      items: [...v.items].sort(),
      descriptions: [...v.descriptions],
      count: v.count,
    }]),
  );
}

/**
 * Codes in this export that the map has never seen.
 *
 * Upstream does not manage these consistently, so a new code must never be
 * auto-accepted — the board would print a guess. Each one is handed to the
 * manager with what can be derived and the choices available.
 *
 * @returns {Array<{code, riviera[], hull_prefix[], items[], descriptions[],
 *                  count, suggestion: {stella, riviera: string|null}}>}
 */
export function detectNewCodes(rows, codeMap) {
  const derived = deriveFromRows(rows);
  return Object.entries(derived)
    .filter(([code]) => !codeMap[code])
    .map(([code, v]) => ({
      code,
      ...v,
      suggestion: {
        // What the item code itself says — always available.
        stella: code,
        // What the ERP description says the manufacturer call it — often absent.
        riviera: v.riviera[0] ?? null,
      },
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------
// BOATS FOR THE CODES PAGE
//
// The display code IS the boat. That is the identity everyone actually uses —
// the floor reads "XX06", not "XX16" — so it is the key, the first column, and
// the thing you edit. `boat` still stores it, but the two are kept equal: a row
// whose display says one thing and whose grouping key says another was the main
// source of confusion on the old page, where XX01 and XX11 sat on separate
// lines despite printing the same code.
//
// Category comes from the item codes a boat carries, through the same prefix
// rules the board uses. A boat usually has several — a XX06 has a lifter AND a
// boarding ladder — so there are two ways to look at it:
//
//   'boats'    one line per boat, tagged with its PRIMARY category
//   'products' one line per boat per category, so the XX06 lifter and the
//              XX06 boarding ladder are separate rows
// ---------------------------------------------------------------------------

// Which category speaks for a boat when it has several. Lifters first because
// that is the product line most boats are known by, rotary next, then the rest
// in board order.
export const CATEGORY_PRIORITY = [
  'Cylinder lifters',
  'Rotary Lifters',
  'Launchers, Doors & Chocks',
  'Ladders and Chairs',
  'Davits',
];

const categoryRank = (c) => {
  const i = CATEGORY_PRIORITY.indexOf(c);
  return i === -1 ? CATEGORY_PRIORITY.length : i;
};

/**
 * One row per boat, or one row per boat per product category.
 *
 * @param {Object} codeMap
 * @param {(inv:string)=>({category:string|null})} classify  from rules.js
 * @param {{mode:'boats'|'products'}} opts
 */
/**
 * What the latest export knows about each item code.
 *
 * The code map holds item codes and nothing else about them — it is a map of
 * boats, not an order book. Two things on the codes page need more than that:
 * the customer's order number, and the item's own description, which is the
 * name a davit actually goes by.
 *
 * Optional throughout. With no rows this is empty and the page shows what it
 * always showed.
 *
 * @param {Array<Object>} rows RawRow[] from the latest import
 * @returns {Map<string, {description: string, orders: string[]}>}
 */
/** Customer order numbers seen for a set of item codes, deduped. */
function ordersFor(items, facts) {
  if (!facts) return [];
  const out = new Set();
  for (const i of items) for (const o of facts.get(i)?.orders ?? []) out.add(o);
  return [...out].sort();
}

export function itemFacts(rows) {
  const out = new Map();
  for (const r of rows ?? []) {
    const inv = String(r['Inventory ID'] ?? '').trim();
    if (!inv) continue;
    if (!out.has(inv)) out.set(inv, { description: '', orders: new Set() });
    const f = out.get(inv);
    const desc = String(r['Item Description'] ?? '').trim();
    if (desc && !f.description) f.description = desc;
    const order = String(r['Customer Order Nbr.'] ?? '').trim();
    if (order) f.orders.add(order);
  }
  for (const f of out.values()) f.orders = [...f.orders].sort();
  return out;
}

export function boatRows(codeMap, classify, { mode = 'boats', facts = null } = {}) {
  const groups = aliasGroups(codeMap);

  const built = groups.map((g) => {
    const display = codeMap[g.codes.find((c) => codeMap[c]?._confirmed) ?? g.codes[0]]?.display
      ?? g.boat ?? g.codes[0];

    // Item codes bucketed by the board category their prefix resolves to.
    const byCategory = new Map();
    const riviera = new Set();
    const hulls = new Set();
    for (const code of g.codes) {
      const e = codeMap[code] ?? {};
      for (const m of e.riviera ?? []) riviera.add(m);
      for (const h of e.hull_prefix ?? []) hulls.add(h);
      for (const item of e.items ?? []) {
        const { category } = classify(item);
        if (!category) continue;
        if (!byCategory.has(category)) byCategory.set(category, []);
        byCategory.get(category).push({ item, code });
      }
    }

    const categories = [...byCategory.keys()].sort((a, b) => categoryRank(a) - categoryRank(b));
    return {
      display,
      boat: g.boat ?? display,
      codes: g.codes,
      confirmed: g.codes.some((c) => codeMap[c]?._confirmed),
      riviera: [...riviera].sort(),
      // What the cheat sheet's Model column prints: the override where one is
      // set, every derived code otherwise.
      model: modelFor(g, codeMap),
      modelSet: g.codes.some((c) => String(codeMap[c]?.sheetModel ?? '').trim()),
      hulls: [...hulls].sort(),
      byCategory,
      categories,
      primaryCategory: categories[0] ?? null,
      itemCount: [...byCategory.values()].reduce((n, v) => n + v.length, 0),
      orders: ordersFor(g.codes.flatMap((c) => codeMap[c]?.items ?? []), facts),
    };
  });

  if (mode === 'products') {
    // A boat appears once per category it builds for, so the XX06 lifter and
    // the XX06 boarding ladder are separate lines.
    return built
      .flatMap((b) => (b.categories.length ? b.categories : [null]).map((category) => {
        const codes = category
          ? [...new Set(b.byCategory.get(category).map((x) => x.code))].sort()
          : b.codes;
        // HULLS AND MODEL CODES BELONG TO THESE CODES, not to the boat. This
        // narrowed the item codes and left the rest of the row alone, so a
        // lifter line listed every hull the boat had ever been fitted to —
        // including hulls that belong to a different product entirely.
        const group = { codes };
        return {
          ...b,
          category,
          items: category ? b.byCategory.get(category) : [],
          codes,
          hulls: [...new Set(codes.flatMap((c) => codeMap[c]?.hull_prefix ?? []))].sort(),
          riviera: [...new Set(codes.flatMap((c) => codeMap[c]?.riviera ?? []))].sort(),
          model: modelFor(group, codeMap),
          modelSet: codes.some((c) => String(codeMap[c]?.sheetModel ?? '').trim()),
          orders: ordersFor((category ? b.byCategory.get(category) : []).map((x) => x.item), facts),
        };
      }))
      .sort((a, x) => categoryRank(a.category) - categoryRank(x.category)
        || a.display.localeCompare(x.display));
  }

  return built
    .map((b) => ({
      ...b,
      category: b.primaryCategory,
      items: [...b.byCategory.values()].flat(),
    }))
    .sort((a, x) => categoryRank(a.category) - categoryRank(x.category)
      || a.display.localeCompare(x.display));
}

/**
 * Existing boats, for the "add to an existing code" dropdown.
 * @returns {Array<{boat, codes[], display}>}
 */
/**
 * What the Model column prints for a boat.
 *
 * A hull often carries several manufacturer codes — a plain one, the same code
 * with a voltage, one with a note somebody appended — and the cheat sheet is a
 * single sheet of paper. Which of them to show is a decision, and sometimes the
 * answer is none of them: a boat sold under one code may be known on the floor
 * by another entirely.
 *
 * So `sheetModel` on any code in the group overrides the lot. Derived codes are
 * the suggestions, not the answer — the same arrangement as the display code,
 * for the same reason.
 *
 * @returns {string} the override, or every derived code joined.
 */
export function modelFor(group, codeMap) {
  for (const c of group.codes) {
    const set = String(codeMap[c]?.sheetModel ?? '').trim();
    if (set) return set;
  }
  return [...new Set(group.codes.flatMap((c) => codeMap[c]?.riviera ?? []))].join('  ·  ');
}

/** Every derived model code on a boat, as the options to choose between. */
export function modelOptions(group, codeMap) {
  return [...new Set(group.codes.flatMap((c) => codeMap[c]?.riviera ?? []))];
}

export function existingBoats(codeMap) {
  return aliasGroups(codeMap)
    .map((g) => {
      const display = codeMap[g.codes.find((c) => codeMap[c]?._confirmed) ?? g.codes[0]]?.display
        ?? g.codes[0];
      // Keyed on the display: it is the identity in practice, and keeping the
      // two equal is what stops a row printing one code while grouping under
      // another.
      return { boat: g.boat ?? display, codes: g.codes, display };
    })
    .sort((a, b) => a.display.localeCompare(b.display));
}

/**
 * Merge derived data into the stored map. Seeds `display` only when absent, so
 * a hand-confirmed decision survives every future export.
 *
 * NOTE: this only refreshes codes the map already holds. A code that is new is
 * NOT added here — it goes through the manager first (see detectNewCodes), so
 * nothing reaches the board on a guess.
 *
 * @returns {{map: Object, refreshed: string[]}}
 */
export function syncCodeMap(codeMap, derived) {
  const map = structuredClone(codeMap ?? {});
  const refreshed = [];
  for (const [code, v] of Object.entries(derived)) {
    if (!map[code]) continue;
    map[code].riviera = v.riviera;
    map[code].hull_prefix = v.hull_prefix;
    map[code].items = v.items;
    refreshed.push(code);
  }
  return { map, refreshed };
}

/**
 * Accept a new code, as decided by the manager.
 * @param {string} code
 * @param {{mode: 'stella'|'riviera'|'existing'|'custom', value?: string, boat?: string}} choice
 * @param {Object} derived  the derived entry for this code
 */
export function acceptNewCode(code, choice, derived) {
  const entry = {
    riviera: derived.riviera ?? [],
    hull_prefix: derived.hull_prefix ?? [],
    items: derived.items ?? [],
    _confirmed: true,
  };
  switch (choice.mode) {
    case 'stella':
      entry.display = code;
      entry.boat = derived.riviera?.[0] ?? code;
      break;
    case 'riviera':
      entry.display = derived.riviera?.[0] ?? code;
      entry.boat = derived.riviera?.[0] ?? code;
      break;
    case 'existing':
      // Joins an existing boat; the group's confirmed display carries over, so
      // no display is set here — resolveDisplays takes it from the sibling.
      entry.boat = choice.boat;
      break;
    case 'custom':
      entry.display = choice.value;
      entry.boat = choice.boat || choice.value;
      break;
    default:
      throw new Error(`Unknown choice mode '${choice.mode}'`);
  }
  return entry;
}
