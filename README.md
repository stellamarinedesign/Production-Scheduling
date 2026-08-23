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
| `js/vessel-codes.js` | Stella code derivation, alias groups, board labels. |
| `js/transform.js` | `RawRow[] → Job[]`. The only place that knows ERP column names. |
| `js/adapters/xlsx.js` | Reads the export, validates its columns, stamps provenance. |
| `js/print.js` | The A4 layout and the measured auto-fit. |
| `js/store.js` | Firestore, with a localStorage fallback. |
| `js/app.js` | Manager view. |
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
- **Codes sharing a Riviera model are the same boat** and display the same
  code. Group on the model, never the hull prefix — `56` and `SY26` share hull
  `5000` and are different boats.
- **The horizon runs from today**, not from the export date, so a stale export
  shows a shrinking board rather than a wrong one.
- Nothing is ever dropped silently. Every excluded row carries a reason.

Full background: `handoff/STELLA_PRODUCTION_BOARD_CONTEXT.md`.

---

## Tests

No Node in the target environment, so the tests run in a browser against the
real 21/08/2026 export and the reference implementation's real output.

```bash
python -m http.server 8777
```

Then open <http://127.0.0.1:8777/tests/>. 67 assertions; the transform is only
correct if it reproduces all 48 board rows and all 44 exclusion reasons.

Two deliberate differences from the reference output, both asserted explicitly:

- `43SY` now displays `SY20` — same boat, per Pete's ruling on alias groups.
- Stock rows have `sales_order: null` rather than the string `"nan"`, which is
  what Python's `str(NaN)` produced.

---

## Firebase

The app runs **local-only** until Firebase is configured, saving edits to
`localStorage` on the one machine. The provenance strip says which mode it is
in. To go multi-device:

1. Create the Firebase project; paste the config into `firebaseConfig` in
   `js/store.js`.
2. Register App Check (reCAPTCHA v3) and paste the site key into
   `APPCHECK_SITE_KEY`. **App Check is the only gate in front of Firestore** —
   there is no login — so do not publish with a real project until it is on
   and enforced.
3. Publish `firestore.rules`.

Collections:

```
vesselCodes/{stellaCode}  { riviera[], hull_prefix[], items[], display, _confirmed }
jobOverrides/{prodNo}     { hidden, hiddenReason, labelOverride, updatedAt }
imports/{importId}        { retrievedAt, sourceId, sourceLabel,
                            horizonWeeks, maxStock, jobs[] }
settings/board            { horizonWeeks, maxStock, autoFit }
```

`imports` buys an audit trail and Gantt actuals. It does **not** buy exclusion
of completed jobs — the ERP saved filter drops Completed/Canceled/Closed before
the export is written, so those never arrive.

---

## Deploying

GitHub Pages, serving the repo root. No build step: everything is ES modules
loaded directly, SheetJS from CDN. Push to `main`.

---

## Not built

- **Gantt view.** `start_date` and `end_date` are populated on every job and
  carried on the record, so it needs no new data.
- **Acumatica OData adapter.** Designed for, deliberately deferred — the
  blockers are organisational, and it needs a Cloud Function to hold the OAuth
  secret. See `handoff/DATA_SOURCE_ARCHITECTURE.md` §5.
- **Brand webfonts.** Friz Quadrata Pro and Sweet Sans Pro are licensed and not
  in the repo; `css/style.css` has the `@font-face` blocks commented out and
  falls back. Drop the `.woff2` files into `fonts/` and uncomment.
