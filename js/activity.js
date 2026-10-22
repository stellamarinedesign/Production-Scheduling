// activity.js - who did what on the board, in words.
//
// Now that several people edit the board, a change needs a name on it. Every
// manager edit goes through two choke points - a job override and an item
// override - plus completion, so those are described here, once, in the
// words the log shows, and written as an append-only record. The log is a
// record, not a mechanism: nothing reads it back to decide anything.

import { ERP_CLOSER } from './rules.js';
import { plinthText } from './plinths.js';

/** The verbs in the log, so a reader (or a filter) can rely on them. */
export const ACTION = {
  status: 'status', hide: 'hide', show: 'show', label: 'label', hull: 'hull',
  part: 'part', done: 'done', reopen: 'reopen', access: 'access', package: 'package',
  import: 'import', plinth: 'plinth',
};

/**
 * A job override patch, as the log says it. Null when the patch is not a
 * manager's edit worth a line (a completion snapshot, say, which has its own).
 * @returns {{action: string, text: string}|null}
 */
export function describeOverride(patch) {
  if (!patch) return null;
  if ('status' in patch) {
    return patch.status === null
      ? { action: ACTION.status, text: 'hand-set status removed' }
      : { action: ACTION.status, text: `status set to ${patch.status}` };
  }
  if ('hidden' in patch) {
    return patch.hidden
      ? { action: ACTION.hide, text: `hidden from the sheet${patch.hiddenReason ? ` — ${patch.hiddenReason}` : ''}` }
      : { action: ACTION.show, text: 'shown on the sheet again' };
  }
  if ('labelOverride' in patch) {
    return patch.labelOverride === null
      ? { action: ACTION.label, text: 'label reset to the default' }
      : { action: ACTION.label, text: `label set to "${patch.labelOverride}"` };
  }
  if ('hullOverride' in patch) {
    return patch.hullOverride === null
      ? { action: ACTION.hull, text: 'hand-set hull removed' }
      : { action: ACTION.hull, text: `hull set to ${patch.hullOverride}` };
  }
  if ('plinth' in patch) {
    return patch.plinth === null
      ? { action: ACTION.plinth, text: 'plinth cleared' }
      : { action: ACTION.plinth, text: `plinth set to ${plinthText(patch.plinth)}` };
  }
  return null;
}

/** An item override patch, for every job on the code, as the log says it. */
export function describeItemOverride(patch) {
  if (!patch) return null;
  if ('partOrder' in patch) {
    return patch.partOrder === true ? { action: ACTION.part, text: 'marked a part order, every job on this code' }
      : patch.partOrder === false ? { action: ACTION.part, text: 'marked a unit, every job on this code' }
        : { action: ACTION.part, text: 'part mark cleared' };
  }
  if ('displayCode' in patch && patch.displayCode) return { action: ACTION.label, text: `item shown as ${patch.displayCode}, every job on this code` };
  if ('label' in patch && patch.label) return { action: ACTION.label, text: `item label set to "${patch.label}", every job on this code` };
  if ('label' in patch || 'displayCode' in patch) return { action: ACTION.label, text: 'item label reset, every job on this code' };
  return null;
}

/**
 * One log entry.
 * @param {{action, text, by, prodNo?, label?, inventoryId?, at?}} o
 */
export function activityEntry({ action, text, by, prodNo = null, label = null, inventoryId = null, at = new Date() }) {
  return {
    at: at instanceof Date ? at.toISOString() : String(at),
    by: by || 'unknown',
    action,
    text,
    prodNo,
    label,
    inventoryId,
  };
}

/**
 * The short name in the log: the part before the @, or the whole if none.
 * The ERP closes jobs too (ERP_CLOSER on the completion), and reads as the
 * import that did it.
 */
export const whoShort = (by) => (by === ERP_CLOSER ? 'ERP import' : String(by ?? '').split('@')[0] || 'unknown');

/** dd/mm/yyyy hh:mm, local time. */
export function whenShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- reading the log ------------------------------------------------------
//
// One list for everyone, but not every line is everyone's to read: account
// changes are the masters' business. That is decided here, at render, so the
// record itself stays one append-only collection.

/** The actions only a master sees. Anything of that kind added later joins this set. */
export const ACCOUNT_ACTIONS = new Set([ACTION.access]);
export const isAccountEntry = (entry) => ACCOUNT_ACTIONS.has(entry?.action);

/** The filter row above the log. The one marked `masters` is offered to masters only. */
export const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'edits', label: 'Edits' },
  { key: 'imports', label: 'Imports' },
  { key: 'accounts', label: 'Accounts', masters: true },
];

/** Entries per page. A screen and a half; a Firestore read costs per document. */
export const PAGE = 50;

export function matchesFilter(entry, key) {
  if (key === 'imports') return entry?.action === ACTION.import;
  if (key === 'accounts') return isAccountEntry(entry);
  if (key === 'edits') return entry?.action !== ACTION.import && !isAccountEntry(entry);
  return true;
}

/**
 * The lines a reader may see, under a filter. Account entries are a master's
 * alone whatever the filter; the Accounts filter means nothing to anyone else
 * and shows them everything they may see.
 */
export function visibleEntries(rows, { master = false, filter = 'all' } = {}) {
  const key = !master && filter === 'accounts' ? 'all' : filter;
  return (rows ?? []).filter((r) => (master || !isAccountEntry(r)) && matchesFilter(r, key));
}

/**
 * What the line says. The board's own entries carry `text`; one written
 * elsewhere - an import's line per job, say - carries `what`. Either reads as
 * the sentence it is, whatever its action, so a kind of entry this file has
 * never heard of still shows.
 */
export const entryText = (entry) => String(entry?.text ?? entry?.what ?? '');

/**
 * Who last changed a job, and when, for History's column: the touch the last
 * write stamped on its override; failing that, the completion itself; failing
 * that, the newest log entry for the production number. Null when nothing is
 * known.
 * @returns {{by: string|null, at: string}|null}
 */
export function lastChanged({ override = null, job = null, rows = [] } = {}) {
  if (override?.touchedAt) return { by: override.touchedBy ?? null, at: override.touchedAt };
  if (job?.completed_at) return { by: job.completed_by ?? null, at: job.completed_at };
  const prodNo = job?.prod_no;
  let hit = null;
  for (const r of rows ?? []) {
    if (prodNo && r?.prodNo === prodNo && r.at && (!hit || String(r.at) > String(hit.at))) hit = r;
  }
  return hit ? { by: hit.by ?? null, at: hit.at } : null;
}
