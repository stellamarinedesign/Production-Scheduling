// version.js — what build is on screen.
//
// There is no build step, so nothing stamps this automatically: it is bumped by
// hand in the same commit as the change it names. That is a real cost, and it
// buys something worth more — a way to tell "the fix is not deployed" apart
// from "the fix is deployed and my browser is still holding the old CSS".
//
// GitHub Pages serves everything with max-age=600, so a refresh within ten
// minutes of a deploy can legitimately show the old stylesheet. Without a
// version on screen that is indistinguishable from a broken fix, and we spent a
// round trip on exactly that.
//
// The stylesheet links in index.html and vessel-codes.html carry `?v=` with
// this same string. Bump all three together.
export const VERSION = '2026-09-04.5';
