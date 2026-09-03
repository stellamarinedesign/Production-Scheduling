// help.js — the long explanations, in one place, behind a button.
//
// They used to sit in the interface: three paragraphs under the vessel codes
// table, a scope chooser that explained itself at length every time it opened.
// Somebody reading it for the tenth time is not being helped by it, and a
// dialog you have to read past is slower than one you can act on.
//
// So the interface says the short version and this says the rest. Nothing here
// is required to use the board.
//
// NO REAL CODES OR CUSTOMER NAMES. This file ships to anyone who opens the app.

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export const HELP = [
  {
    title: 'Vessel codes',
    topics: [
      {
        q: 'What is the display code?',
        a: [
          'What the floor reads and what the board prints. It is a decision somebody '
          + 'made, not something derived: the same boat can carry an item code, a '
          + 'manufacturer model code and an office shorthand, and only a person knows '
          + 'which of them the workshop actually uses.',
          'It is the key on this page, the first column, and the thing you edit. Every '
          + 'ERP code that resolves to it sits on the same line.',
        ],
      },
      {
        q: 'Why is grouping manual?',
        a: [
          'Nothing upstream records which codes mean the same boat. A manufacturer may '
          + 'issue two codes for one hull, and an office may have typed a third by hand.',
          'Rename sets what a line reads. Split moves a code off a line that grouped '
          + 'wrongly. A shared model only ever suggests a group; it never decides one.',
        ],
      },
      {
        q: 'One line per boat, or split by product?',
        a: [
          'A boat usually builds more than one product. One line per boat tags each with '
          + 'the line it is best known by, lifters first. Split by product gives it a row '
          + 'per category, so a lifter and a boarding ladder for the same hull are '
          + 'separate rows.',
        ],
      },
      {
        q: 'What does the Model column print?',
        a: [
          'The manufacturer code, when there is one. A boat often carries several — a '
          + 'plain code, the same code with a voltage, one with a note appended — and the '
          + 'cheat sheet should show one.',
          'Set it with Model on any line: pick one of the codes found in the data, or '
          + 'type what the sheet should read. It affects the cheat sheet only; nothing '
          + 'else changes.',
        ],
      },
      {
        q: 'Where is the code map kept?',
        a: [
          'In Firestore. Save file writes it out as JSON and Load file reads one back, '
          + 'which is both the backup and how a map reaches another environment.',
          'It is deliberately not in the repository or on the web server: a static site '
          + 'hands its files to anyone who asks for them.',
        ],
      },
    ],
  },
  {
    title: 'Labels',
    topics: [
      {
        q: 'Which scope should I use?',
        a: [
          'The narrowest one that fixes the problem.',
          'Just this job replaces the label on one production order. Use it for a one-off '
          + 'that is not going to repeat.',
          'Every job for this item code latches to the product and applies to every future '
          + 'order for it. Use it when the item code itself is the problem — a part whose '
          + 'code names one boat but which is built to the drawings of another.',
          'Every job on this boat changes the vessel code for every product on that hull. '
          + 'Use it when the boat is wrong, not the part.',
        ],
      },
      {
        q: 'Why does an item edit ask for a code and not a label?',
        a: [
          'Because the product wording comes from a template. Setting the code on a '
          + 'boarding ladder still leaves it reading as a boarding ladder, with the new '
          + 'code. An item with no vessel code in it — a davit, a set of chocks — gets the '
          + 'whole label instead.',
        ],
      },
      {
        q: 'What do EDITED and ITEM mean on a row?',
        a: [
          'EDITED: this job carries a label set by hand, on this production order only.',
          'ITEM: the label comes from a decision pinned to the item code, so every order '
          + 'for that product reads the same.',
        ],
      },
    ],
  },
  {
    title: 'The board',
    topics: [
      {
        q: 'What does the horizon do?',
        a: [
          'It trims the printed sheet, not the board. Everything open stays on Current '
          + 'orders and on the Gantt whatever the horizon says; the horizon decides how '
          + 'far ahead the paper reaches.',
          'Auto-fit pulls it in until the sheet holds one page, and says so when it has.',
        ],
      },
      {
        q: 'Why is something on the board but not on the print?',
        a: [
          'Three reasons, all about fitting a page: its category has no column on the '
          + 'sheet, it is past the horizon, or the stock cap already took enough of its '
          + 'category. The count above the preview says how many of each.',
        ],
      },
      {
        q: 'Hidden or complete?',
        a: [
          'Hidden means not on this print. Complete means finished, for good: it leaves '
          + 'the board and lands in History, and it stays gone whatever later exports say. '
          + 'Reversible from History.',
        ],
      },
      {
        q: 'What is a stock build?',
        a: [
          'Work with no customer behind it. Its dates are set once and never revised, so a '
          + 'passed date says nothing about whether it is done — which is why stock starts '
          + 'unticked in the complete sweep, and prints STOCK instead of a date.',
        ],
      },
    ],
  },
  {
    title: 'Importing',
    topics: [
      {
        q: 'What happens when I drop a file?',
        a: [
          'It is read and built into the board it would produce, and nothing else. The '
          + 'review says what it contains, what will not print and anything it cannot '
          + 'settle on its own. Nothing reaches the other managers until you apply it.',
        ],
      },
      {
        q: 'What are items of concern?',
        a: [
          'Things the import cannot answer for itself: a vessel code never seen before, a '
          + 'custom job whose name is not in either column, an item code with no category '
          + 'rule, a job on hold.',
          'Each one can be settled from the review, before the import is applied. Resolve '
          + 'does that row; Resolve all walks the list, and can be stopped or undone '
          + 'partway.',
        ],
      },
      {
        q: 'Does an import replace what is there?',
        a: [
          'Only the ERP rows. Labels, vessel codes, hidden jobs, hand-set statuses and '
          + 'completed work are keyed on the production number and survive it. Completed '
          + 'jobs stay in History even once the ERP stops exporting them.',
          'Closed and cancelled rows are not carried forward — the board can never show '
          + 'them, and an export going back years does not fit in one record.',
        ],
      },
      {
        q: 'Why are there three tabs of jobs?',
        a: [
          'The export holds three kinds of work and two fields separate them: time and '
          + 'materials, internal factory builds with no customer behind them, and '
          + 'production orders.',
          'The first two have no schedule worth the name — the ERP stamps their dates the '
          + 'day the order is raised and never revises them — so those tabs show how long '
          + 'a job has been open instead, and neither appears on the Gantt.',
        ],
      },
    ],
  },
  {
    title: 'Status and history',
    topics: [
      {
        q: 'Can I change a status?',
        a: [
          'Yes, on any row. The ERP owns it and lags — a job put on hold this morning '
          + 'still reads as in process in tonight’s export.',
          'A hand-set status expires on its own when the ERP moves: it was a correction to '
          + 'one specific value, and once that value changes the correction no longer '
          + 'applies. Hand-set statuses show in red.',
        ],
      },
      {
        q: 'Where did a completed job go?',
        a: [
          'History, behind the button beside each list. Each lane keeps its own, because '
          + 'finished production work and a finished workshop job are different questions.',
          'Reopen puts it back on the board.',
        ],
      },
    ],
  },
];

let built = false;

function build() {
  const host = document.getElementById('helpBody');
  if (!host || built) return;
  built = true;
  for (const section of HELP) {
    host.append(el('h3', 'help-section', section.title));
    for (const t of section.topics) {
      const d = document.createElement('details');
      d.className = 'help-topic';
      const sum = document.createElement('summary');
      sum.textContent = t.q;
      d.append(sum);
      for (const para of t.a) d.append(el('p', null, para));
      host.append(d);
    }
  }
}

export function openHelp() {
  build();
  document.getElementById('helpOverlay')?.classList.add('show');
}

export function wireHelp() {
  const close = () => document.getElementById('helpOverlay')?.classList.remove('show');
  document.getElementById('helpBtn')?.addEventListener('click', openHelp);
  document.getElementById('helpClose')?.addEventListener('click', close);
  document.getElementById('helpOverlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'helpOverlay') close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}
