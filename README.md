# Stella Production Board

Generates the workshop's printed production order list from the ERP export.
The production manager uploads the export, checks and edits the result in the
page, and prints one A4 sheet. Edits persist to the next upload.

Replaces a hand-typed Word document. Static site — GitHub Pages + Firebase, no
build step.

---

## Using it

1. Export **Production Order Maintenance** from the ERP as `.xlsx`.
2. Open the board, drop the file on the page.
3. Check the warnings, adjust the horizon, hide or relabel anything that needs it.
4. **Print board.**

Four tabs over the same data: **Current orders**, **Gantt**, **History**, and
**Print preview**.

The vessel codes page prints its own **landscape A4 cheat sheet** — display code
against ERP codes, Riviera model and hull — for pinning up next to the board.

Everything is parsed in the browser. The spreadsheet is never uploaded anywhere.

---

## How it works

```
SOURCE ADAPTER  →  RawRow[]  →  TRANSFORM  →  Job[]  →  STORE + VIEWS
   js/adapters/                js/transform.js         js/store.js
                                                       index.html
                                                       vessel-codes.html
```

The adapter boundary exists so the app does not care where its rows came from.
Only the xlsx adapter is built; an Acumatica OData adapter is designed for and
deliberately deferred (`handoff/DATA_SOURCE_ARCHITECTURE.md` §5). **`RawRow`
keys are the ERP column names verbatim** — `Production Nbr.` with the trailing
dot — because an OData feed on a Generic Inquiry returns those same captions.
Normalising happens in the transform, once, downstream.

| File | Role |
|---|---|
| `js/rules.js` | Category prefix map, filters, label overrides. The business rules. |
| `js/vessel-codes.js` | Stella code derivation, boat groups, new-code detection, labels. |
| `js/transform.js` | `RawRow[] → Job[]`. The only place that knows ERP column names. |
| `js/adapters/xlsx.js` | Reads the export, validates its columns, stamps provenance. |
| `js/print.js` | The A4 board layout, column balancing, and the measured auto-fit. |
| `js/codes-print.js` | The vessel code cheat sheet — landscape A4, type-step auto-fit. |
| `js/gantt.js` | Start/end bars, lane packing. Layout is a pure function; only the renderer touches the DOM. |
| `js/store.js` | Firestore, with a localStorage fallback. |
| `js/auth.js` | Sign-in and roles. |
| `js/firebase.js` | One Firebase app, shared by the store and the auth gate. |
| `js/app.js` | Manager view and floor view. |
| `js/codes-page.js` | Vessel codes table. |

### Rules worth knowing before you change anything

- **Category comes from the `Inventory ID` prefix**, never `Lot/Serial Class` —
  48 of 92 rows are `NOTTRACKED` and that bucket mixes unrelated products.
- **`CATEGORY_RULES` is ordered and first-match-wins. Do not sort it.**
  `SLRIVCOMMISSION` starts with `SLRIV`; if it drops below that rule, on-site
  commissioning prints as real cylinder-lifter work. Both `COMMISSION`
  spellings stay pinned at the top.
- **The ERP's own saved filter cannot be trusted** — it excludes
  `SLRIVCOMMISSION` but the data contains `STL`RIVCOMMISSION (with a T), so 15
  rows come through. Filtering happens here, so a raw or filtered export gives
  the same board.
- **Vessel codes anchor on `RIV`**, not on the first digit: `SWD4PDRIV62SY` is
  `62SY`, not `4PDRIV`.
- **The display code is a human decision.** `SY23` prints as `56SY` but `SY20`
  prints as `SY20`. Both are correct and confirmed individually. It lives in
  `data/vessel-codes.seed.json` and is maintained by hand.
- **Grouping merges on the display, not just the stored key.** Two codes that
  print the same thing are one boat whatever `boat` says, so a legacy value
  cannot split a line — the model heals itself rather than needing a migration.
- **The display code IS the boat.** It is what the floor reads and what the
  board prints, so it is the key on the vessel codes page, the first column, and
  the thing you edit — `boat` and `display` are kept equal. Keying on the Stella
  code instead is what put `SY20` and `43SY` on separate lines despite printing
  the same thing.
- **Which codes are the same boat is assigned by hand,** via the `boat` field.
  It has to be — nothing upstream records it. `56` is office shorthand for the
  56SY and groups with `SY23`; `SY26` is the **5000, a different boat**. A
  shared Riviera model only *suggests* a group for a code nobody has assigned.
- **Labels resolve in three scopes, narrowest first: job → item → boat.**
  A boat decision covers every product on that vessel. An *item* decision
  latches to the `Inventory ID` and covers every future order for one product —
  that is the layer for a part whose item code names one boat but which is
  built to the drawings of another. A job decision covers one order.
- **A code the map has never seen is never auto-accepted.** It is queued on
  import and answered by hand, because the alternative is the board printing a
  guess that nobody knows is one.
- **`Type` is not a filter.** The board used to require `Finished Good`, which
  dropped a watertight door and a helm seat box that are real workshop jobs —
  the ERP field reflects how a thing is sold, not whether the floor builds it.
  Every other component part in the export is `ST*` water treatment and is
  already excluded by category, so the prefix list is the filter and decides
  alone. Component parts that reach the board are flagged, not hidden.
- **The horizon runs from today**, not from the export date, so a stale export
  shows a shrinking board rather than a wrong one.
- **Print column placement is computed, not pinned.** `balanceColumns` tries all
  16 splits of the four narrow categories and takes the shortest page. With 19
  cylinder lifters against 5 rotary, a fixed two-and-two layout wastes half a
  column.
- **The Gantt window follows committed work, not every bar.** Stock ignores the
  horizon and its ERP dates are set once and never revised — on the 21/08 export
  all seven stock builds have spans entirely in the past, the oldest from March.
  Letting them set the left edge stretched the chart from 16 weeks to 35 and
  halved every bar. Anything the window cannot place is listed under the chart
  with its dates rather than drawn as a sliver.
- **Completion is marked here, not read from the ERP.** The handoff assumed
  finished work never arrives, because the ERP saved filter drops
  Completed/Canceled/Closed. That only holds while the ERP status actually
  flips — a job finished on the floor and never closed stays `In Process` in
  every export after it, so the board accumulates work that is long done. A
  completed job leaves the board for good and lands in History; it is keyed on
  the production number, so it never returns. Reversible from History.
- **Completion is not hiding.** Hidden means "not on this print"; completed
  means "finished". They are separate fields with separate consequences.
- **Dates are calendar days, never instants.** `JSON.stringify` writes a Date as
  UTC, so local midnight on 12 Nov becomes `2026-11-11T14:00:00Z` — and Brisbane
  is UTC+10, the direction that loses a day. Both stores go through the same
  serialiser, which writes `YYYY-MM-DD` from local parts, and `toDateOnly`
  resolves any timestamp it is handed to the local calendar day. Either alone
  would have been enough; both together mean data already written the old way
  reads correctly too.
- **Shared state is live.** Board data, job overrides, item overrides, vessel
  codes and board settings are watched, so an edit on one device appears on the
  others without a reload. Rebuilds are debounced (a bulk complete writes one
  document per job), deferred while a dialog is open (the overlays hold a
  captured row), and a client ignores the echo of its own writes so a control
  is not reset under the person using it.
- **Board settings are shared; view settings are not.** Horizon, stock cap and
  auto-fit live in Firestore because every manager should be looking at the same
  board. Gantt lanes/everything and collapsed categories are per device — how
  somebody prefers to look at the chart says nothing about the work.
- **An upload reaches every manager, not just the one who did it.** The import
  record carries the raw rows as well as the rendered board, so the second
  manager continues from the same export rather than being asked to upload it
  again. Local cache wins only when it is genuinely newer.
- **The quantity is a display suffix, not part of the label.** `x5` is appended
  at render time from `Qty. to Produce`, and only when it is not 1 — 85 of the 92
  rows are single builds and an `x1` on every line would bury the three that are
  not. It is deliberately kept out of `label`: the label editor prefills from
  `label`, so a suffix stored there would be saved into the override and
  suffixed again on the next render.
- Nothing is ever dropped silently. Every excluded row carries a reason.

Full background: `handoff/STELLA_PRODUCTION_BOARD_CONTEXT.md`.

---

## Tests

No Node in the target environment, so the tests run in a browser against the
real 21/08/2026 export and the reference implementation's real output.

**The fixtures are not in this repo and never will be.** They carry customer
names, Riviera PO numbers, sales orders, hull numbers and ERP internal notes —
Stella's and Riviera's order book — and this repo is public. They are
gitignored, and the test page says so and skips if they are absent.

To run the tests, copy from the private handoff folder into `tests/fixtures/`:

| From `handoff/` | To `tests/fixtures/` |
|---|---|
| `Production Order Maintenance 20260821.xlsx` | `export-20260821.xlsx` |
| `jobs.json` | `jobs.expected.json` |
| `jobs_excluded.csv` | `excluded.expected.csv` |

```bash
python -m http.server 8777
```

Then open <http://127.0.0.1:8777/tests/>. 212 assertions, checked against the
reference implementation's own output row by row.

Four deliberate differences from that output, each asserted explicitly rather
than quietly tolerated:

- **50 jobs, not 48** — `SWD4PDRIV62SY` and `SHCELECPLINTHRIV43SY` are booked as
  `Component Part` but are real workshop jobs, so the `Type` filter is gone.
  42 exclusions rather than 44 follows from the same change.
- **`43SY` displays `SY20`** — same boat as the SY20 lifter.
- **Custom jobs read `Custom Lifter - Riviera 48`** — the vessel alone made a
  one-off look like a standard model.
- **Stock rows have `sales_order: null`** rather than the string `"nan"`, which
  is what Python's `str(NaN)` wrote into every empty cell.

---

## Accounts

Firebase email/password, no self-signup — the same model as the Drawings app.

| Account | Sees |
|---|---|
| `design@` · `production@` | Full manager view: upload, edit, hide, relabel, print |
| `workshop@` | Floor view: the printed board, read-only |

Roles fail closed — any signed-in address that is not a manager gets the floor
view, so a new account can never arrive with edit rights by accident. Hiding
manager controls is tidiness, not security; the Firestore rules are the
enforcement.

Accounts are created in the Firebase console, never by self-signup: the floor
role can read the whole published schedule, so read access is what is being
protected. Passwords are not: **"Set or reset my password"** on the sign-in
screen emails a link, so people choose their own and whoever created the
account never sees it.

Firebase project `production-scheduling-stella` is configured; sign-in and the
Firestore rules are the gate, and App Check is deliberately off. If the config
is ever emptied the app falls back to **local-only** — no sign-in, edits in
`localStorage`, one machine — and the header and provenance strip say so.

> Setup, security rules, accounts and deployment steps live in a private
> SETUP document kept outside this repository, next to `handoff/`.
> The rules name the staff accounts, which is why they are not in here.

---

## Deploying

Live at <https://stellamarinedesign.github.io/Production-Scheduling/>.

GitHub Pages serves `main` at the repo root. No build step — everything is ES
modules loaded directly, SheetJS from CDN — so the files here are the files
that ship, and a deploy is one push:

```bash
git push origin main
```

---

## Not built

- **Acumatica OData adapter.** Designed for, deliberately deferred — the
  blockers are organisational, and it needs a Cloud Function to hold the OAuth
  secret. See `handoff/DATA_SOURCE_ARCHITECTURE.md` §5.
- **Brand webfonts.** Friz Quadrata Pro and Sweet Sans Pro are licensed and not
  in the repo; `css/style.css` has the `@font-face` blocks commented out and
  falls back. Drop the `.woff2` files into `fonts/` and uncomment.
