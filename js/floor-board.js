// floor-board.js - the board a floor screen shows.
//
// A floor screen used to read the last import as it was published, so a job
// completed, hidden or relabelled after it stayed as it had been until the
// next one, and a screen left open never changed at all. The managers' board
// now keeps one small document of what the floor is shown, written again a
// moment after each edit, and the floor watches it. It carries the fields a
// floor row is drawn from and nothing else; the import, with its raw rows, is
// a hundred times the size and a phone had to fetch all of it.

/** What a floor row is drawn from. */
export const FLOOR_FIELDS = ['prod_no', 'label', 'qty', 'category', 'hull', 'due_display',
  'is_stock', 'is_custom', 'on_hold', 'part_order'];

const pick = (j) => Object.fromEntries(FLOOR_FIELDS.map((k) => [k, j[k] ?? null]));

/**
 * The document, from a board built with no job held back.
 * @param {{jobs: Array, meta: Object}} board
 * @param {Object} source  where the board came from, as `state.source` has it
 */
export function floorBoard(board, source) {
  const jobs = (board?.jobs ?? []).filter((j) => !j.hidden && !j.completed).map(pick);
  return {
    jobs,
    meta: { job_count: jobs.length },
    sourceLabel: source?.sourceLabel ?? null,
    sourceId: source?.sourceId ?? null,
    retrievedAt: source?.retrievedAt ?? null,
    uploadedBy: source?.uploadedBy ?? null,
  };
}

/** The part of it that matters: two boards that read the same are the same. */
export const floorSignature = (rec) => JSON.stringify([rec?.retrievedAt ?? null,
  (rec?.jobs ?? []).map((j) => FLOOR_FIELDS.map((k) => j[k] ?? null))]);
