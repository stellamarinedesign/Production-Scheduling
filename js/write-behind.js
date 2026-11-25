// write-behind.js - a record drawn first, and written behind it.
//
// A correction is on screen from the moment it is made and the write follows
// it: nothing there waits for the server, which offline does not answer at
// all until the connection is back. A write that is refused puts the record
// back as the server has it. Two changes to one record can be out at once, so
// what the server has is kept apart from what is drawn, and only the last
// change out decides what stays: put back to the one before it, a pair of
// refused changes left the first of them on screen as if it were saved.

/**
 * @param {object} o
 * @param {(key: string) => any} o.get                 the record drawn; undefined for none
 * @param {(key: string, record: any) => void} o.draw  put this in its place; undefined takes it away
 * @param {(key: string, record: any) => Promise} o.write
 * @param {() => void} [o.moved]                       a write has gone out, or been answered
 */
export function writeBehind({ get, draw, write, moved = () => {} }) {
  const out = new Map();     // key -> { server, turn, since }

  /**
   * Draw a record, and write it.
   * @returns {Promise<boolean>} true once it is saved, false when a later change
   *   to the same record has taken its place; throws when it was refused, with
   *   the record put back
   */
  async function put(key, record) {
    const w = out.get(key) ?? { server: get(key), turn: 0, since: Date.now() };
    w.turn += 1;
    const turn = w.turn;
    out.set(key, w);
    draw(key, record);
    moved();
    try {
      await write(key, record);
    } catch (e) {
      // A later change carries the whole record, so that one decides.
      if (w.turn !== turn) return false;
      out.delete(key);
      draw(key, w.server);
      moved();
      throw e;
    }
    w.server = record;
    if (w.turn !== turn) return false;
    out.delete(key);
    moved();
    return true;
  }

  return {
    put,
    /** Records the server has not answered for, and since when the oldest has waited. */
    waiting: () => ({ n: out.size, since: out.size ? Math.min(...[...out.values()].map((w) => w.since)) : null }),
    /** What is drawn, less whatever the server has not answered for: what it is known to have. */
    confirmed(drawn) {
      const known = { ...drawn };
      for (const [key, w] of out) {
        if (w.server === undefined) delete known[key]; else known[key] = w.server;
      }
      return known;
    },
  };
}
