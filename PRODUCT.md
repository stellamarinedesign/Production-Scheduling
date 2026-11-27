# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static site with no build step: plain ES modules behind an import map, served as-is by
GitHub Pages from `main`.

- **Backend:** Firebase JS SDK 10.12.2 (modular) in the board's own Firebase project: Auth
  (email and password) and Firestore. Sign-in runs through the hub, the family's one login,
  where it can be reached.
- **Libraries:** SheetJS, ExcelJS, JSZip, pdf-lib and PDF.js, kept in `vendor/` rather than
  loaded from a CDN.
- **Install:** works as a home-screen app through the web manifest.
- **Local mode:** with no Firebase config, the board runs without sign-in and keeps
  everything in the browser, on one machine. The header and the source line say so.

## Users

Who sees what is decided by role. A role is never shown on screen, and a control a role
cannot use is not drawn.

- **The production manager.** Works at a desk.
  - Exports the production orders from the ERP, drops the file on the board, checks the
    warnings, and corrects what needs it: hides, labels, vessel codes, holds.
  - Prints the board: one A4 sheet for the workshop wall.
  - Runs the part list's stock export.
- **Engineers (drafting).** Work at a desk, often at half-screen beside CAD.
  - Keep the vessel codes and the part list right: rename, set a model, correct a
    description or a bin.
- **The floor.** Everyone else who signs in, mostly on phones in the workshop.
  - Read the current orders and look parts up, read-only.
  - Read the printed sheets on the wall more often than the screen.
- **The admin.** Gives people their roles in the hub; the board links there.

## Product Purpose

The board turns the ERP's production order export into the workshop's production order
list, and into one printed A4 sheet. It replaced a hand-typed Word document.

On screen it is a board for what the workshop has committed to: current orders by category,
a Gantt, the internal factory jobs and the time and materials jobs. Printing is one thing it
does, so the paper settings stay behind Print and nothing else is trimmed to fit a page.

Two more pages sit beside it:
- **Vessel codes:** what the floor calls each boat, and the landscape A4 code sheet pinned
  next to the board.
- **Parts:** the part list, searched on a phone and corrected at a desk.

Success is a sheet on the wall that is right, made in minutes from the morning's export.

## Positioning

The board reads the ERP's own export rather than asking anyone to retype it. The decisions a
person makes (a display code, a label, a hidden row, a hold) are kept and applied again to
the next upload, so each upload costs only what is new.

## Operating Context

- **The export:** MYOB Acumatica's Production Order Maintenance, as `.xlsx`. It is parsed in
  the browser and never uploaded. Its column captions are kept verbatim at the adapter and
  normalised once in the transform. Its saved filter, cell references and spellings are not
  trusted.
- **The paper:** the board prints A4 portrait (or A3 for the warehouse), the code sheet A4
  landscape. Both are pinned up on the workshop floor and read at arm's length.
- **The devices:** a Windows desktop for the manager; half-screen beside SolidWorks or
  AutoCAD for drafting; phones on the floor, often on weak workshop Wi-Fi.
- **The family:** the Stella apps share one login (the hub) and one look: material
  ordering, workshop drawings and design scheduling. "Jobs" on the board are production
  orders; in design scheduling they are design jobs.

## Capabilities and Constraints

- **Views:** Current orders, Gantt, Internal Factory Jobs, Time & Materials Jobs, Print,
  and the records of what is hidden from print and what was excluded.
- **Vessel codes:** one line per boat or split by product; rename, set a model, hide from
  the sheet, move a code; download and load the map as a file.
- **Parts:** search, materials, corrections and the stock import.
- **Test mode** takes every change and keeps none of them, so a tester can try things on the
  real data without touching the board.
- **The repository is public.** No customer names, vessel codes, hull numbers, PO numbers,
  staff addresses or real exports in it, ever. The boat builders' markers live in Firestore
  settings; the code map moves only as a file on the manager's machine; real exports and the
  tests that read them stay in a private folder.
- **The Firestore rules are the enforcement.** Hiding a control is tidiness, not security.
- **Not built:** an Acumatica OData adapter (designed for and deferred); the licensed brand
  webfonts are not shipped.

## Brand Commitments

- Stella Marine's palette from the Corporate Brand Guidelines 2025: Black Night, Shadow Grey,
  Upsdell Red, Burning Star Red, Titanium White.
- Friz Quadrata Pro for headings and Sweet Sans Pro for text, where installed.
- The family's header: the mark, the page's name, the links, the 3px red rule.
- The brand tokens, the palette and the Friz Quadrata headings change only with the owner's
  approval.
- Words: plain, formal and passive in titles. New on-screen words go to the owner before they
  ship; there are no unrequested explanations on screen.

## Evidence on Hand

- Real ERP exports, the vessel code map and the test suite that reads them are private, kept
  outside this repository. Nothing here should be reconstructed from them.
- Placeholders stand in for real values in code and documents: `AB0001`, `XX01`,
  `P00001`, `name@example.com`.

## Product Principles

1. **The sheet is the contract.** What prints does not move with the screen, the theme or a
   redesign, unless the owner asks for it to.
2. **A person's decision outlives the upload.** Labels, codes and hides persist, and are
   shown before anything overwrites them.
3. **The code absorbs the mess.** Odd exports, captions and spellings are handled once, at
   the boundary, with a warning rather than a refusal.
4. **One family.** The same header, controls, words and behaviour as the other Stella apps.
5. **Draw only what works.** Buttons appear once they work, and only for those who may use
   them.

## Accessibility & Inclusion

- Targets are 44px at phone widths and on touch screens, and 48px on the parts page, which is
  used standing up.
- Reduced motion takes every duration to zero.
- The Workshop theme gives a light look for bright offices and the workshop floor, chosen per
  device.
- Focus is a visible ring of its own, outside the control.
