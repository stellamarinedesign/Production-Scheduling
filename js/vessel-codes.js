// vessel-codes.js — Stella code derivation, alias grouping, board labels.
//
// Riviera issue concept hull codes to conceal unreleased vessel models, so a
// Stella item code (SY23) and the model actually used in practice (56SY) can
// differ. Which one the floor uses is a HUMAN decision — it cannot be derived.
// This module derives what can be derived and resolves the rest through the
// hand-maintained `display` field.

// Everything after "RIV" is the model. Anchoring on RIV rather than on the
// first digit is what makes SWD4PDRIV62SY resolve to 62SY and not 4PDRIV.
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
// Stella code, so SLRIVSY20(24) and SHCELECPLINTHRIV43SY became independent
// entries and nothing ever compared them.
//
// Grouping is MANUAL, via the `boat` field. It has to be: the upstream codes
// are not consistently managed, so no derivable signal gets this right.
//
//   - 56 / SY23 / SY26 are one boat. Riviera call it 56SY and also 5000SY;
//     `56` was a lazy office entry for 56SY. Their Riviera models do not match
//     as strings, so a model-matching rule splits them wrongly.
//   - 56 and SY26 share the hull prefix 5000 — but hull prefixes are a third
//     code system and a 56SY-model part can be fitted to a 5000 hull, so hull
//     is not evidence of identity either.
//
// A shared Riviera model is still a good SUGGESTION for a code nobody has
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

  // 2. A shared Riviera model only suggests a group, and only for codes nobody
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
      for (const c of codes) {
        for (const m of codeMap[c]?.riviera ?? []) models.add(String(m).toUpperCase());
        boat ??= boatOf(codeMap, c);
      }
      return { codes: codes.sort(), models: [...models].sort(), boat, assigned: Boolean(boat) };
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
 * 'SY22' + SGDRIVSY22 -> 'SY22 Garage Door'.
 */
export function applyTemplate(inventoryId, displayCode) {
  const inv = String(inventoryId ?? '').toUpperCase();
  for (const [prefix, tmpl] of PRODUCT_TEMPLATE) {
    if (inv.startsWith(prefix)) return tmpl.replace('{code}', displayCode).trim();
  }
  return displayCode;
}

/**
 * Full board label for a vessel-coded item — 'SY22 Garage Door',
 * 'Boarding Ladder 56SY'. Null when the item carries no vessel code.
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
        // What the ERP description says Riviera call it — often absent.
        riviera: v.riviera[0] ?? null,
      },
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Existing boats, for the "add to an existing code" dropdown.
 * @returns {Array<{boat, codes[], display}>}
 */
export function existingBoats(codeMap) {
  return aliasGroups(codeMap)
    .map((g) => ({
      boat: g.boat ?? g.codes[0],
      codes: g.codes,
      display: codeMap[g.codes.find((c) => codeMap[c]?._confirmed) ?? g.codes[0]]?.display
        ?? g.codes[0],
    }))
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
