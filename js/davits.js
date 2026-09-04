// davits.js — which davit goes on which boat.
//
// DELIBERATELY SEPARATE FROM THE VESSEL CODE MAP. A davit is not a boat, and
// making these into vessel codes would put the manufacturer's own model codes
// into a map of Stella display codes and ask somebody to resolve each one on
// the next import. This reads the export directly and answers one question:
// for each boat, what davit is fitted.
//
// Most davits have no boat at all — a 250kg single-stage davit is a product in
// its own right. Only the ones built for a specific hull say so, in the item
// code, and those are the only ones here.
//
// NO REAL CODES IN THIS FILE. It ships to anyone who opens the app.

import { stellaCode } from './vessel-codes.js';

const text = (v) => String(v ?? '').trim();

/** Item codes for davits: the part-number family (SDC0nnn) is parts, not davits. */
const DAVIT_RE = /^SDC(?!0\d)/i;

/**
 * Boat -> the davits fitted to it, from the export.
 *
 * Keyed on the code after RIV, which is the manufacturer's model. One code can
 * name more than one hull, and a boat can take more than one davit — neither is
 * a problem here, because this is a reference list rather than a mapping that
 * has to be one to one.
 *
 * @param {Array<Object>} rows RawRow[]
 * @returns {Array<{boat: string, davits: Array<{item: string, description: string}>}>}
 */
export function davitsByBoat(rows) {
  const byBoat = new Map();
  for (const r of rows ?? []) {
    const inv = text(r['Inventory ID']);
    if (!DAVIT_RE.test(inv)) continue;
    const boat = stellaCode(inv);
    if (!boat) continue;                       // a davit with no boat is a product
    if (!byBoat.has(boat)) byBoat.set(boat, new Map());
    // The description is the davit — capacity and configuration. The part
    // number says nothing a person on the floor can use.
    const description = text(r['Item Description']) || inv;
    byBoat.get(boat).set(inv, description);
  }

  return [...byBoat.entries()]
    .map(([boat, items]) => ({
      boat,
      davits: [...items.entries()]
        .map(([item, description]) => ({ item, description }))
        .sort((a, b) => a.description.localeCompare(b.description)),
    }))
    .sort((a, b) => a.boat.localeCompare(b.boat, undefined, { numeric: true }));
}

/**
 * Fold a fresh reading into the stored one.
 *
 * THIS IS A REFERENCE LIST, NOT A VIEW OF CURRENT WORK. An export only carries
 * the davits it happens to mention, and an applied import keeps only open rows
 * — so read from those alone, a boat drops off the sheet the moment its last
 * order closes, which is exactly when somebody is most likely to be looking it
 * up. Fittings do not stop being true.
 *
 * So it accumulates. Nothing is removed automatically; a wrong entry is removed
 * by hand, which has not been needed yet and would be a deliberate act.
 */
export function mergeDavits(stored, fresh) {
  const byBoat = new Map();
  for (const group of [...(stored ?? []), ...(fresh ?? [])]) {
    if (!byBoat.has(group.boat)) byBoat.set(group.boat, new Map());
    const m = byBoat.get(group.boat);
    for (const d of group.davits ?? []) m.set(d.item, d.description);
  }
  return [...byBoat.entries()]
    .map(([boat, items]) => ({
      boat,
      davits: [...items.entries()]
        .map(([item, description]) => ({ item, description }))
        .sort((a, b) => a.description.localeCompare(b.description)),
    }))
    .sort((a, b) => a.boat.localeCompare(b.boat, undefined, { numeric: true }));
}
