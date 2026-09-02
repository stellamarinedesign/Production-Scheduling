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

Tabs over the same data: **Import**, **Current orders**, **Gantt**, **Internal
Factory Jobs**, **Time & Materials Jobs**, and — alone on the right — **Print**,
which is where the horizon, the stock cap and the printed sheet live.

This is a board for looking at what the workshop has committed to. Printing is
one thing it does, not what it is for, so the paper settings stay behind that
one tab and nothing else is trimmed to fit a page.

The vessel codes page prints its own **landscape A4 cheat sheet** — display
code, Riviera model, hull and products — for pinning up next to the board. The
ERP codes are deliberately not on it: the sheet is for the floor, and the floor
reads the display code. What the ERP calls a boat is a manager's problem and
stays on the vessel codes page.

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
| `js/rules.js` | Category prefix map, lane rules, filters, label overrides. The business rules. |
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
- **A custom one-off's name is asked for, not guessed.** Custom work carries no
  model code, so the name comes out of free text — and the two columns that
  could supply it disagree. `Description` holds the boat on two of the three
  custom rows in the 21/08 export ("Riviera 48", "Alaska 47 square transom") and
  "5% drawing fee" on the third, where the answer is the customer. Where the
  vessel rule cannot read the Description the import asks, showing the
  production number and both columns with the label each would print, plus a
  free-text option. The answer is an ordinary job label override keyed on the
  production number, which is what makes "use the customer name" — the reading
  the board would have picked anyway — stick instead of being asked again every
  import.
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
- **The horizon and the stock cap are print settings, not filters.** They used
  to drop rows out of the board entirely, which quietly made the app a thing for
  producing one sheet of paper. An order due in five months is still committed
  work, so it stays on the board and on the Gantt and is marked as not printing.
  `printJobs()` is the set that reaches the page; three separate things keep a
  real job off it — no column in `PRINT_LAYOUT`, past the horizon, or already
  enough of its category under the stock cap.
- **The export holds three kinds of work, and two fields separate them.**
  `Order Type == 'TM'` is time & materials; no `Order Nbr.` and
  `Type == 'Component Part'` is an internal factory job; everything else is a
  production order. Scored against the office's own hand-sorted sheets that is
  120 of 120 rows with no misclassification. The sales order is what says
  whether there is a customer behind the work, and `Type` is what separates an
  internal sub-assembly (bronze glands, bearing tubes, Aquarius panels) from a
  stock build of a sellable product (davits, chocks) — production work that
  happens to have no buyer yet.
- **The lane rule describes how an order was raised, not what it is for**, so it
  cannot fix a miskeyed row. `SDC0287`, the davit rope kit, is booked
  `Finished Good` and therefore reads as production even though it is really
  internal work. The import review flags it; the rule does not bend around it.
- **T&M and internal jobs are not on the Gantt, on purpose.** Every T&M row in
  the 01/09 export has `Start Date` equal to `End Date` equal to the day the
  order was raised — the ERP stamps it once and nobody revises it — and eight of
  the thirteen internal rows are the same. Every bar would be a zero-width mark
  at an arbitrary date. Their tabs show **how long the job has been open**
  instead, which is the true and useful thing, and two of them are nearly a year
  old.
- **`ALL RECORDS` is the sheet the board reads.** It is the whole order book;
  the hand-sorted sheets beside it are a subset, and the board derives the same
  split itself. It carries 49 more open rows than those sheets do, most of which
  the category rules already drop (commissioning, a row literally called
  `test`); the rest are genuine internal part builds the office's sheet omitted.
  `Data` is still accepted — that is the older export.
- **A finished watermaker's item code ends in flow rate over voltage.**
  `STAQSAB/240/230`, `STG4LA/160/230`. Everything else in the family is a kit,
  filter, upgrade or spare, so water treatment reaches the board as two
  categories rather than being excluded outright. The rule anchors on the PAIR
  of numbers because `STAUTO24` ends in a voltage and is a flush accessory. The
  same ordering trap applies as everywhere else in that list: `STL`, `STC` and
  both `COMMISSION` spellings begin with `ST` and are matched above it.
  Softeners are the exception that proves the shape of the rule: `SS` is a whole
  product line with no flow-rate/voltage pair in the code, so the prefix alone
  makes it a finished unit.
- **An import supplements the record; it does not replace it.** Only the ERP
  rows are replaced. Labels, vessel codes, hidden jobs, hand-set statuses and
  completed work are keyed on the production number and survive. History used to
  be assembled only from rows in the current export, which made it lossy in the
  exact case it exists for — mark a job done, the ERP closes it a fortnight
  later, the row stops being exported, and the completed job vanished from the
  one view whose job is to remember it. A completed job now carries a snapshot
  of itself, so History outlives the export it came from.
- **An applied import keeps the open order book, not the whole file.**
  `ALL RECORDS` goes back to the beginning: the 01/09 export is 1216 rows of
  which 1047 are Completed, Closed or Canceled and can never reach the board.
  Carrying them broke sharing outright — the import record is a single Firestore
  document, documents are capped at 1 MiB, and rows plus the rendered board came
  to 1.38 MB. The write was refused, so the upload looked fine on the machine
  that made it and reached nobody. `publish` now checks the size in UTF-8 bytes
  before writing and says so plainly if it will not fit.
- **A published import must be NEWER, not merely different.** The live watcher
  compared for inequality, so a snapshot carrying an older record replaced the
  export a manager had just applied — silently, back to the previous sheet. It
  showed up exactly when a publish had been refused for size: the newest record
  in the collection was still the previous one. `isNewerImport` is the rule now.
- **Cylinder lifters are pinned top-left**, on the sheet and in the orders view.
  It is the biggest category and the one the floor reads first, and a balancer
  free to move it did — the board reshuffled between exports as counts drifted.
  The other three still balance around it.
- **An import is staged, not applied.** Dropping a file parses it, builds the
  board it would produce against the current overrides and codes, and describes
  the result — counts per lane, what will not print, every unknown code, every
  custom job it cannot name, anything booked oddly. Nothing reaches the other
  managers until Apply. It used to change the board under whoever else was
  looking at it.
- **The review is where things get fixed, not just listed.** Every concern is
  itemised, and the ones with an answer carry the control that gives it — resolve
  a vessel code, name a custom job, set a status, hide a row. They all write to
  records keyed on a code or a production number rather than to the export, so
  they can be answered before the import is applied and are still right
  afterwards. Each answer restages, so the list shortens as it is worked
  through. A row's own button resolves that row and stops; **Resolve all** walks
  the list, and mid-run offers **Skip the rest** (keep what is answered) and
  **Cancel & undo** (put back everything that run changed). Every count opens
  too: "69 production orders" is a number you should be able to check, and its
  groups collapse — the excluded list runs to four figures and starts shut.
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
- **A status can be set by hand, and the correction expires.** The ERP owns the
  status and lags — a job put on hold on the floor this morning still reads
  In Process in tonight's export. An override records which ERP value it was
  correcting, and drops itself the moment the export disagrees with that value.
  Without that, marking a job In Process would permanently mask it being put
  On Hold later, for a different reason, by somebody else. Whether a row appears
  at all stays the ERP's call: an override cannot pull a Completed or Canceled
  row back onto the board.
- **`OVERRIDE_FIELDS` is the list that keeps an override alive.** A record with
  nothing meaningful left is deleted rather than kept as a husk, and that check
  has to know every field. It was written inline as
  `!hidden && !labelOverride && !completed`, so the first field added after it —
  `status` — was written and deleted by the next line and never survived a
  reload. One named list, both backends.
- **History is per lane and is not a tab.** Finished production work, finished
  T&M and finished internal builds are three different questions and one merged
  list answered none of them. It is a button beside each lane's own controls,
  because it is something you look up rather than something you keep open.
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
- **A davit is named from `Item Description`, not the production order.**
  `Item Description` is the product's own name: across the whole 01/09 export —
  1216 rows, 203 item codes, completed and closed included — not one code
  carries two different Item Descriptions. `Production Description` is free text
  typed per order, and 104 of those 203 codes have more than one; SDC250SSMLMSME
  alone has seven, down to "250kg SS Davit", and one SDC550SSHLHSHE row has a
  customer's name in it. For a davit the configuration IS the product —
  hydraulic against manual on the luff, slew and extension — and the item
  description carries all three where a production order often gives one word
  for the lot. (Manual and pneumatic assist are the same thing on these davits,
  so "full manual" for a pneumatic luff assist is loose wording, not a different
  product.)
- **A one-off on a standard code is marked, and named by the order.** A custom
  *lifter* has its own item code. The other kind is a standard product modified
  for one order, where the code says nothing and only the free text knows. Six
  rows in the 1216-row 01/09 export say "custom" without a custom code, and all
  six are genuine — a derated 650kg davit, a custom folding davit, a custom
  filter bracket, custom-length hoses, a custom single-arm lifter, a bespoke
  Prestige 420. No false positives, so `CUSTOM_TEXT_RE` is a keyword and not a
  cleverer comparison: comparing the production description against the item
  description flags nine davit rows of which only two are real, the rest being
  customer names and shipping notes. For a davit the production order is the one
  that knows what is *different*, so a custom one is named from it rather than
  from the standard product's description.
- **The quantity and the stock marker are display suffixes, not part of the
  label.** `x5` is appended
  at render time from `Qty. to Produce`, and only when it is not 1 — 85 of the 92
  rows are single builds and an `x1` on every line would bury the three that are
  not. It is deliberately kept out of `label`: the label editor prefills from
  `label`, so a suffix stored there would be saved into the override and
  suffixed again on the next render. `(Stock)` is the same: it used to arrive by
  accident, because some production descriptions ended "(STOCK)" and some did
  not, so half the stock builds said so. It is derived from `is_stock` now, so
  every one does and none says it twice.
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
| `Production Order Maintenance 20260901.xlsx` | `export-20260901.xlsx` |

The 01/09 export is the one that carries all three kinds of work, and it ships
with the office's own hand-sorted `TM` / `INTERNAL` / `REGULAR` sheets. The lane
tests score the rule against those sheets row by row; without the file they skip
with a note.

```bash
python -m http.server 8777
```

Then open <http://127.0.0.1:8777/tests/>. 277 assertions, checked against the
reference implementation's own output row by row.

Four deliberate differences from that output, each asserted explicitly rather
than quietly tolerated:

- **50 jobs, not 48** — `SWD4PDRIV62SY` and `SHCELECPLINTHRIV43SY` are booked as
  `Component Part` but are real workshop jobs, so the `Type` filter is gone.
  42 exclusions rather than 44 follows from the same change.
- **`43SY` displays `SY20`** — same boat as the SY20 lifter.
- **Custom jobs read `Custom Lifter - Riviera 48`** — the vessel alone made a
  one-off look like a standard model. The reference printed `Custom Lifter -
  GALAXY` for the drawing-fee row; the board still does until somebody answers
  the import prompt, and then prints whatever they chose.
- **Water treatment is on the board rather than excluded** — 24 rows on the
  21/08 export, in two categories, neither of which prints. The reference's
  claim still holds row for row: nothing it kept off the sheet reaches the
  sheet. "Excluded" and "does not print" are simply no longer the same
  statement, and the tests assert against the printed set for exactly that
  reason.
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
