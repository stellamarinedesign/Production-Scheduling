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
// ALIAS GROUPS
//
// Two Stella codes can name the same boat. The map is keyed on the Stella
// code, so SLRIVSY20(24) and SHCELECPLINTHRIV43SY became independent entries
// and nothing ever compared them — yet both carry riviera: ["43SY"]. That
// shared model is the signal.
//
// Rule: group by shared Riviera model; codes in a group are the same boat and
// display the same code. Grouping is transitive.
//
// Group on the Riviera model, NEVER on the hull prefix. `56` (hull 5000, 56SY)
// and `SY26` (hull 5000) share a hull prefix but are different boats with
// different confirmed displays. Hull prefixes are a third code system and do
// not identify a model.
// ---------------------------------------------------------------------------

/**
 * Partition the code map into alias groups keyed by shared Riviera model.
 * @returns {Array<{codes: string[], models: string[]}>} sorted, one per boat
 */
export function aliasGroups(codeMap) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  for (const code of Object.keys(codeMap)) if (!parent.has(code)) parent.set(code, code);

  // Join any two codes that share a Riviera model.
  const byModel = new Map();
  for (const [code, entry] of Object.entries(codeMap)) {
    for (const model of entry?.riviera ?? []) {
      const key = String(model).toUpperCase();
      if (byModel.has(key)) union(code, byModel.get(key));
      else byModel.set(key, code);
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
      for (const c of codes) for (const m of codeMap[c]?.riviera ?? []) models.add(String(m).toUpperCase());
      return { codes: codes.sort(), models: [...models].sort() };
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
 * Full board label for a vessel-coded item — 'SY22 Garage Door',
 * 'Boarding Ladder 56SY'. Null when the item carries no vessel code.
 */
export function labelFor(inventoryId, resolved, codeMap = {}) {
  const inv = String(inventoryId ?? '').toUpperCase();
  const code = stellaCode(inv);
  if (!code) return null;
  const disp = displayFor(code, resolved, codeMap);
  for (const [prefix, tmpl] of PRODUCT_TEMPLATE) {
    if (inv.startsWith(prefix)) return tmpl.replace('{code}', disp).trim();
  }
  return disp;
}

/**
 * Derive the code cross-reference from an export — the columns that CAN be
 * derived. Merged into the stored map without ever overwriting a `display`.
 * @returns {Object} code -> { riviera[], hull_prefix[], items[] }
 */
export function deriveFromRows(rows) {
  const out = {};
  for (const r of rows) {
    const inv = String(r['Inventory ID'] ?? '');
    if (!isVesselCoded(inv)) continue;
    const code = stellaCode(inv);
    if (!code) continue;

    const e = (out[code] ??= { riviera: new Set(), hull_prefix: new Set(), items: new Set() });
    e.items.add(inv);

    const blob = `${r['Description'] ?? ''} ${r['Production Description'] ?? ''}`;
    const h = /Used by\s*([A-Z0-9]+)\s*\//i.exec(blob);
    if (h) e.hull_prefix.add(h[1].toUpperCase());

    const dm = /Riviera\s+([0-9][0-9A-Z/\s]*?)\s*(?:-|$)/i.exec(String(r['Production Description'] ?? ''));
    if (dm) e.riviera.add(dm[1].trim().replace(/\s*\/\s*/g, '/').toUpperCase());
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => [k, {
      riviera: [...v.riviera].sort(),
      hull_prefix: [...v.hull_prefix].sort(),
      items: [...v.items].sort(),
    }]),
  );
}

/**
 * Merge derived data into the stored map. Seeds `display` only when absent, so
 * a hand-confirmed decision survives every future export.
 * @returns {{map: Object, added: string[]}}
 */
export function syncCodeMap(codeMap, derived) {
  const map = structuredClone(codeMap ?? {});
  const added = [];
  for (const [code, v] of Object.entries(derived)) {
    if (!map[code]) { map[code] = {}; added.push(code); }
    const e = map[code];
    e.riviera = v.riviera;
    e.hull_prefix = v.hull_prefix;
    e.items = v.items;
    e.display ??= v.riviera[0] ?? code;   // never overwrite a human decision
    e._confirmed ??= false;
  }
  return { map, added };
}
