---
name: Stella Production Board
description: The workshop's production order list, on screen and on one A4 sheet for the wall.
colors:
  black-night: "#0e0a0a"
  band: "#1c1c1b"
  shadow-grey: "#282827"
  chip-grey: "#333331"
  rule-grey: "#454542"
  rule-strong: "#5e5e5a"
  text-white: "#ffffff"
  text-ash: "#d2d2ce"
  text-muted: "#b0b0ab"
  upsdell-red: "#af1f24"
  burning-star-red: "#ea372e"
  link-coral: "#ff7369"
  signal-red-bg: "#2b100e"
  signal-amber: "#d97706"
  signal-amber-bg: "#2b1f08"
  signal-amber-text: "#f2b84b"
  signal-green: "#5fb85f"
  signal-green-bg: "#13261a"
  signal-green-text: "#7fd47f"
  toast-green: "#1f7a3a"
  paper-white: "#ffffff"
  paper-ink: "#1a1a1a"
  paper-grey: "#5f5f5f"
  paper-rule: "#9a9a9a"
  paper-head: "#f2efef"
  paper-band: "#faf8f8"
  paper-on-hold: "#b00020"
typography:
  headline:
    fontFamily: "Friz Quadrata Pro, Friz Quadrata BT, Friz Quadrata, Georgia, serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "0.1em"
  title:
    fontFamily: "Friz Quadrata Pro, Friz Quadrata BT, Friz Quadrata, Georgia, serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Sweet Sans Pro, Sweet Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "tnum"
  row:
    fontFamily: "Sweet Sans Pro, Sweet Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    fontFeature: "tnum"
  meta:
    fontFamily: "Sweet Sans Pro, Sweet Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    fontFeature: "tnum"
  label:
    fontFamily: "Sweet Sans Pro, Sweet Sans, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.1em"
  mono:
    fontFamily: "ui-monospace, Cascadia Mono, Consolas, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  inner: "6px"
  md: "8px"
  lg: "11px"
  pill: "999px"
components:
  header:
    backgroundColor: "{colors.shadow-grey}"
    textColor: "{colors.text-white}"
    typography: "{typography.headline}"
    height: "56px"
  button-primary:
    backgroundColor: "{colors.upsdell-red}"
    textColor: "{colors.text-white}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-ash}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-mini:
    backgroundColor: "transparent"
    textColor: "{colors.text-ash}"
    typography: "{typography.meta}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "30px"
  button-mini-on:
    backgroundColor: "{colors.chip-grey}"
    textColor: "{colors.text-white}"
  input:
    backgroundColor: "{colors.band}"
    textColor: "{colors.text-white}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  pill:
    backgroundColor: "transparent"
    textColor: "{colors.text-ash}"
    typography: "{typography.meta}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "30px"
  pill-on:
    backgroundColor: "{colors.chip-grey}"
    textColor: "{colors.text-white}"
  side-panel:
    backgroundColor: "{colors.shadow-grey}"
    width: "256px"
  side-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-ash}"
    typography: "{typography.row}"
    rounded: "{rounded.md}"
    padding: "7px 10px"
    height: "36px"
  side-item-chosen:
    backgroundColor: "{colors.chip-grey}"
    textColor: "{colors.text-white}"
  count-pill:
    backgroundColor: "{colors.chip-grey}"
    textColor: "{colors.text-ash}"
    typography: "{typography.mono}"
    rounded: "{rounded.pill}"
    padding: "1px 6px"
  category-card:
    backgroundColor: "{colors.shadow-grey}"
    textColor: "{colors.text-white}"
    rounded: "{rounded.lg}"
  category-head:
    backgroundColor: "transparent"
    textColor: "{colors.text-white}"
    typography: "{typography.title}"
    padding: "0 14px 0 12px"
    height: "48px"
  order-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-white}"
    typography: "{typography.row}"
    padding: "0 10px 0 14px"
    height: "44px"
  order-row-open:
    backgroundColor: "{colors.band}"
  warning-chip:
    backgroundColor: "{colors.signal-amber-bg}"
    textColor: "{colors.signal-amber-text}"
    typography: "{typography.meta}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  warning-chip-alert:
    backgroundColor: "{colors.signal-red-bg}"
    textColor: "{colors.link-coral}"
  dialog:
    backgroundColor: "{colors.shadow-grey}"
    textColor: "{colors.text-white}"
    rounded: "{rounded.lg}"
    padding: "20px"
    width: "540px"
  sheet-banner:
    backgroundColor: "{colors.upsdell-red}"
    textColor: "{colors.paper-white}"
    padding: "3px 6px"
  sheet-column-head:
    backgroundColor: "{colors.paper-head}"
    textColor: "{colors.paper-grey}"
---

# Design System: Stella Production Board

## Overview

**Creative North Star: "The Workshop Wall"**

The board exists to put one sheet of paper on the workshop wall, and the screen is where that
sheet is checked and made right. So the page behaves like the wall it serves: dark and quiet
at rest, its work laid out in category cards the floor already knows from the paper, and only
what needs a decision lit up. The paper itself is the opposite: white, plain and fixed, a
workshop document read at arm's length, and it does not move when the screen does.

The system belongs to the Stella family and is built on design scheduling's tokens, with the
same header, controls and words as the other apps. It differs in two ways. Its main output is
a printed sheet, which keeps its own colours and type whatever the screen wears. And it is
used three ways at once: a desk with a mouse, half-screen beside CAD, and a phone on the
floor.

Controls are quiet and exact: hairline borders, 8px corners, outlined secondary actions and
one filled red button per view. What is chosen is grey with a red line, never a colour of its
own. Motion is there only to say that something changed.

**Key Characteristics:**
- Dark by default, with a light Workshop theme per device; values only.
- Category cards with Friz Quadrata names over a red line, rows on hairlines.
- A 256px grey sidebar for the views on every manager page; a menu on a phone.
- Things to deal with as one line of chips, shut until opened.
- Roomy 44px rows; 44px targets on phones, 48px on the parts page.
- The printed sheets keep their own literal colours, type and size.

## Colors

Near-black and warm grey at rest, the brand's two reds for the one action and the one line,
amber and red for what needs dealing with, and a separate, fixed set for paper.

### Primary

- **Upsdell Red** (#af1f24): the one filled button in a view (Print board, Print code
  sheet). On paper, the category banners and the title's rule.
- **Burning Star Red** (#ea372e): lines, never fills.
  - the 3px rule under the header;
  - the 2px underline under an open category's name;
  - the line on a chosen item (the sidebar's inset edge, the current page link, the current
    view's tab);
  - the Gantt's today line, and the focus ring on the dark theme.
- **Link Coral** (#ff7369): red words on the dark page: a refused value, a fault, a line on
  hold.

### Secondary

- **Signal Amber** (#d97706, on #2b1f08 with #f2b84b text): something to deal with that is
  not yet wrong: a warning chip, a vessel code not yet confirmed, the fit line under Print.
- **Signal Red** (#2b100e with #ff7369 text): something wrong now: a hard export problem, a
  conflict, a refused save.
- **Signal Green** (#5fb85f, on #13261a with #7fd47f text): done. The toast that says it
  worked is #1f7a3a.

### Neutral

- **Black Night** (#0e0a0a): the page.
- **Band** (#1c1c1b): fields, an opened row, the insets in dialogs.
- **Shadow Grey** (#282827): the header, the sidebar, cards and dialogs.
- **Chip Grey** (#333331): chips, count pills, and the chosen item.
- **Rule Grey** (#454542): every hairline, solid. Lines between rows use it at 1px.
- **Strong Rule** (#5e5e5a): outlines that must hold at a glance: buttons, pills.
- **White** (#ffffff), **Ash** (#d2d2ce) and **Muted Ash** (#b0b0ab): text, in that order of
  importance.

### Paper

Literal values, never tokens, in `#printRoot` and `#codesSheet`:
- **Paper** (#ffffff) and **Ink** (#1a1a1a).
- **Sheet Grey** (#5f5f5f): column heads, the date range, STOCK.
- **Sheet Rule** (#9a9a9a): every cell border.
- **Head Tint** (#f2efef): the column-head row. **Row Band** (#faf8f8): every other row.
- **On Hold** (#b00020): a vessel on hold, and the note under the sheet.
- Upsdell Red (#af1f24) for the banners and the title rule.

### Workshop theme

A light look for bright offices and the workshop floor, chosen per device under the cog and
kept as `stella.board.theme`. It is design scheduling's Workshop, value for value, which the
hub's own screens wear too.
- Page and cards #ffffff, Band #f5f4f0, Chip Grey #eceae4, hairlines #d4d2c8 and #b8b6ac.
- Text #1a1a18, #5a5a54 and #6f6f68.
- The primary button is near-black (#1a1a18 with #f5f4f0); focus is blue (#2563eb).
- Signals: red #dc2626 on #fef2f2 with #b91c1c, amber on #fffbeb with #b45309, green on
  #f0fdf4 with #15803d.
- Corners 6px and 10px; shadows soften.
- The header and the test strip stay dark bands: near-black, no red rule, no mark, the name
  in plain case.
- Screen only: the sheets print the same in either theme.

### Named Rules

**The Grey Choice Rule.** What is chosen (a pressed toggle, the current view, the current
page, a pill) is grey, with a red line where there is room for one. Blue is not used for
choosing. Ruled by the owner on 27 Nov 2026 for every Stella app.

**The One Red Button Rule.** One filled Upsdell Red button per view at most. Everything else
is outlined or plain.

**The Paper Is Paper Rule.** The sheets carry their own literal colours. No token, theme or
redesign reaches them, and a change to them is the owner's decision alone.

## Typography

**Display Font:** Friz Quadrata Pro (with Georgia)
**Body Font:** Sweet Sans Pro (with system-ui, Segoe UI and Roboto)
**Mono Font:** ui-monospace (with Cascadia Mono and Consolas)

**Character:** Friz Quadrata names places: the page, each category, a dialog. Sweet Sans does
everything that is read in a row or acted on. The licensed faces are never shipped; they show
where they are installed.

### Hierarchy

- **Headline** (700, 19px, 1.25): the page's name in the header, uppercase at .1em (plain
  case at .02em in Workshop), and the view's name over the board on a phone.
- **Title** (700, 16px, 1.3): a category card's name.
- **Body** (400, 14.5px, 1.4): the page's text, fields and buttons.
- **Row** (400, 14px): an order, a code line, a sidebar item.
- **Meta** (400, 13px): counts, hints, small buttons, chips.
- **Label** (700, 11px, .1em, uppercase): column heads and settings labels.
- **Mono** (400, 12px): ERP codes and the sidebar's counts.

Numbers on screen are tabular everywhere, so counts, dates and codes line up and do not
jiggle. Headings break evenly and paragraphs leave no word alone, on screen only.

### Named Rules

**The Sheets Keep Their Type Rule.** The sheets are pinned to 15px and proportional figures,
the code sheet to its own face list, because each is measured to fit its paper. A change to
the page's type never reaches them.

## Layout

- **The header** is 56px, then the source line, the full width of the window.
- **Manager pages** have the 256px sidebar down the left and the content beside it, up to
  1,720px. The floor's board has no sidebar.
- **The board** is two columns of category cards while the content column is wide enough:
  one column below a window about 1,236px wide (980px for the floor). Columns give way in a
  fixed order as the window narrows: Created at 1,696px, the PO at 1,496px, the Gantt's dates
  at 1,156px.
- **Vessel code lines** are six columns (display, ERP codes, model, hull, products, buttons)
  while the content is wider than 980px. Below that the facts stack on the left, Model and
  Hull labelled. The buttons sit two by two at the right at every width.
- **A phone** (760px and under): the sidebar becomes a menu that slides in from the left;
  the header's links take a strip of their own that scrolls sideways; an opened order's
  buttons form an even grid; on vessel codes the categories become a strip of pills and each
  line a card whose buttons wait behind a tap.
- **Rows** are 44px. Targets are 36px at a desk, 44px at phone widths and on touch screens,
  and 48px on the parts page, which is used standing up. A small control keeps its drawn size
  and grows its hit area.
- **Paper:** the board is drawn at A4 portrait (794 × 1123px) with the @page margins, the
  code sheet at A4 landscape (1123 × 794px). The preview scrolls in its own box when the
  window is narrower than the paper.

## Elevation & Depth

Flat, told apart by tone: Black Night, then Band, then Shadow Grey, then Chip Grey. Only
what floats over the page casts a shadow, and it goes away.

### Shadow Vocabulary

- **Panel** (`0 1px 2px rgba(0,0,0,.3), 0 4px 12px rgba(0,0,0,.25), 0 16px 40px rgba(0,0,0,.4)`):
  dialogs, the phone's menu and the toast.
- **Float** (`0 1px 2px rgba(0,0,0,.3), 0 6px 16px rgba(0,0,0,.3), 0 20px 48px rgba(0,0,0,.4)`):
  menus over the page.
- **Paper** (`0 6px 30px rgba(0,0,0,.55)`): a sheet on the screen. In Workshop it is a
  hairline ring and a soft shadow (`0 0 0 1px #d4d2c8, 0 4px 18px rgba(0,0,0,.08)`). Print
  takes it off.
- **Scrim** (`rgba(0,0,0,.55)`): behind a dialog or the phone's menu.

### Named Rules

**The Floating-Only Shadow Rule.** Nothing at rest casts a shadow. Cards, rows and the
sidebar are flat.

## Shapes

- **Corners:** 8px on buttons, fields, chips and sidebar items; 11px on cards and dialogs;
  6px on small insets and code tags; pills fully round. Workshop uses 6px and 10px.
- **Concentric:** a card clips its rows to its corners, so a row's hover never shows square
  inside a round card.
- **Hairlines:** 1px solid Rule Grey, never see-through.
- **Carets** are drawn chevrons that turn with their fold, never typed glyphs.

## Components

### Buttons

- **Primary:** Upsdell Red, white, 36px, 16px at the sides, 8px corners. One per view.
- **Ghost:** outlined in Strong Rule, Ash text, 36px. Secondary actions: Close, Cancel.
- **Mini:** outlined, 13px, drawn 30px and hit across 36px at a desk (44px on touch). Pressed
  or on, it takes Chip Grey with white text.
- **Joined switches:** two or more minis sharing one outline, corners only at the ends: the
  sheet picker, the paper picker, the theme.
- **Pressed:** every button, pill and tab gives a little under the finger (`scale(.97)`).
- **Hover** is one tone lighter, and only where a pointer can hover.
- **Labels** say what happens: Print board, Hide from sheet, Set model.

### Pills, chips and counts

- **Pills** filter a list: outlined, 30px, round. The chosen one is grey (The Grey Choice
  Rule).
- **Chips** are neutral: Chip Grey with Ash text, round. Only a chip that needs a decision
  takes a colour (UNCONFIRMED in amber).
- **Counts** in the sidebar are mono pills in Chip Grey that never shrink.

### Navigation

- **The header:** the mark, the page's name in Friz Quadrata, then the page links as tabs. A
  link is muted until it is the page you are on: then white and heavier, over a 3px red line
  lifted 6px clear of the header's rule. The heavier width is held from the start, so nothing
  beside it moves. The account, the hub's app switcher and the cog sit at the right.
- **The sidebar:** a Shadow Grey panel, sections divided by hairlines. On the board: the four
  views, then Print alone, then Hidden from print and Excluded rows when there are any. On
  vessel codes: the categories, marking the one at the top of the page as it scrolls.
- **On a phone** the sidebar is a menu opened from the button beside the view's name, and
  the vessel codes categories are a sticky strip of pills.

### Category cards and order rows (signature)

- **The card:** Shadow Grey, 1px Rule Grey edge, 11px corners, 16px apart. Its head is 48px:
  a drawn caret, the name in Friz Quadrata 16px, the count in Muted Ash, and a 2px Burning
  Star Red underline while it is open.
- **The row:** 44px, on a 1px hairline: the production number, the vessel, the hull, the
  due date, the status and the buttons, in tracks that match the cells it draws. On hold, the
  vessel is red and an ON HOLD chip follows it.
- **Opened:** the row steps back to Band and shows its note, its status and its tools. At a
  desk the note and the status share a line, and the tools sit beneath with Complete at the
  far right; on a phone they are an even two-column grid.
- **The fold:** only the category whose heading was just pressed grows open. Every other
  redraw draws plainly.

### Vessel code lines

The display code first and largest (16px, bold), the ERP codes as mono tags (dashed when they
match the display), model and hull, then the products as neutral chips. The buttons sit two
by two at the right: a line not yet confirmed is asked that first, across the top. A line off
the sheet dims its facts, not its buttons, and its code is struck through.

### Things to deal with

One line of chips over the board: amber for a warning, red for a problem. Each opens its
detail beneath the line, full width. They start shut, except a hard export problem and the
jobs not yet in History.

### Inputs and fields

Band, a 1px hairline, 8px corners, 36px at a desk and 16px text on a phone. Focus is a 2px
ring outside the control. A refused value turns its edge red, shakes once, and says why in
words beneath it.

### Dialogs and Settings

Shadow Grey, 11px corners, the panel shadow, rising a little as they open. The Settings
dialog carries the build at its top right, then the account, the theme and, for an admin,
the way to the hub's accounts.

### Toast, skeletons and states

- **The toast:** green for what worked, red for what did not, at the foot of the page.
- **Skeletons** are the size of what is coming, and they stand still.
- **The buttons of a page** appear once they work. Empty and refused states say why in one
  line.

### Motion

Every duration is a token, and reduced motion takes them all to zero: 120ms for a colour or a
press, 150ms for something going away, 180ms for a fold, 200ms for the toast, 260ms for the
phone's menu, 360ms for a refused value's shake. One easing, `cubic-bezier(.23, 1, .32, 1)`.
A change of theme lands at once, with no colour fading on its own.

### The printed sheets (signature)

- **The board:** A4 portrait, the title over a 2.5pt Upsdell Red rule with the date range at
  the right, the categories in two balanced columns and Davits full width beneath. Each
  category has an Upsdell Red banner, a tinted column-head row, banded rows and 1px Sheet
  Rule borders. An auto-fit shortens the horizon until the board holds to one page.
- **The code sheet:** A4 landscape: display code, model, hull and products, under the same
  banners; its type steps down until it fits.

## Do's and Don'ts

### Do:

- **Do** take every colour from a token on screen, so the Workshop theme is one block of
  values.
- **Do** show what is chosen in Chip Grey with a Burning Star Red line.
- **Do** keep one Upsdell Red button per view.
- **Do** prove print unchanged after any change to the stylesheet: the same export, laid out
  as the printer lays it out, element for element against main.
- **Do** keep targets at 44px on phones and 48px on the parts page.
- **Do** keep a control a role cannot use off the screen, not greyed out.
- **Do** use placeholders (`AB0001`, `XX01`, `P00001`) in examples: the repository is public.

### Don't:

- **Don't** let a token, the theme or a font change reach `#printRoot` or `#codesSheet`.
- **Don't** change the brand tokens, the palette or the Friz Quadrata headings without the
  owner's approval.
- **Don't** use blue for a chosen item.
- **Don't** put a shadow on anything at rest.
- **Don't** add words to the screen that the owner has not seen: no unrequested
  explanations.
- **Don't** show a role's name to the person who has it.
