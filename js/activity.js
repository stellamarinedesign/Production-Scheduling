// activity.js - who did what on the board, in words.
//
// Now that several people edit the board, a change needs a name on it. Every
// manager edit goes through two choke points - a job override and an item
// override - plus completion, so those are described here, once, in the
// words the log shows, and written as an append-only record. The log is a
// record, not a mechanism: nothing reads it back to decide anything.

/** The verbs in the log, so a reader (or a filter) can rely on them. */
export const ACTION = {
  status: 'status', hide: 'hide', show: 'show', label: 'label', hull: 'hull',
  part: 'part', done: 'done', reopen: 'reopen', access: 'access', package: 'package',
  import: 'import',
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
      ? { action: ACTION.status, text: 'status follows the ERP again' }
      : { action: ACTION.status, text: `status set to ${patch.status}` };
  }
  if ('hidden' in patch) {
    return patch.hidden
      ? { action: ACTION.hide, text: `hidden from the sheet${patch.hiddenReason ? ` — ${patch.hiddenReason}` : ''}` }
      : { action: ACTION.show, text: 'back on the sheet' };
  }
  if ('labelOverride' in patch) {
    return patch.labelOverride === null
      ? { action: ACTION.label, text: 'label reset to the default' }
      : { action: ACTION.label, text: `label set to "${patch.labelOverride}"` };
  }
  if ('hullOverride' in patch) {
    return patch.hullOverride === null
      ? { action: ACTION.hull, text: 'hull follows the ERP again' }
      : { action: ACTION.hull, text: `hull set to ${patch.hullOverride}` };
  }
  return null;
}

/** An item override patch, for every job on the code, as the log says it. */
export function describeItemOverride(patch) {
  if (!patch) return null;
  if ('partOrder' in patch) {
    return patch.partOrder === true ? { action: ACTION.part, text: 'marked a part order, every job on this code' }
      : patch.partOrder === false ? { action: ACTION.part, text: 'marked a unit, every job on this code' }
        : { action: ACTION.part, text: 'part mark cleared, back to the code’s shape' };
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

/** The short name in the log: the part before the @, or the whole if none. */
export const whoShort = (by) => String(by ?? '').split('@')[0] || 'unknown';

/** dd/mm/yyyy hh:mm, local time. */
export function whenShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
