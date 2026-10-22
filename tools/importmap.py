#!/usr/bin/env python3
"""Write the import map into index.html, parts.html and vessel-codes.html.

Every module under js/ gets an entry "./js/x.js" -> "./js/x.js?v=<VERSION>",
VERSION read from js/version.js. The page's own links reach only the entry
script and the stylesheet; the map is what reaches the modules they import, so
a page and its modules always come from the same build however the browser
has cached them (GitHub Pages caches every file for ten minutes).

Run it after adding or removing a module, no arguments, from anywhere:

    python tools/importmap.py

The version bump itself stays the usual substitution over the four files; it
reaches the map's strings too, so this script is not part of a release.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = ['index.html', 'parts.html', 'vessel-codes.html']
START = '<!-- importmap:start'
END = '<!-- importmap:end -->'


def version():
    text = (ROOT / 'js' / 'version.js').read_text(encoding='utf-8')
    m = re.search(r"VERSION = '([^']+)'", text)
    if not m:
        sys.exit('js/version.js: no VERSION found')
    return m.group(1)


def modules():
    return sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / 'js').rglob('*.js'))


def block(v, mods, nl):
    entries = (',' + nl).join(f'    "./{m}": "./{m}?v={v}"' for m in mods)
    return nl.join([
        f"{START} - every module named with the build's ?v=, so a page is never mixed with"
        ' cached modules; regenerate with: python tools/importmap.py -->',
        '<script type="importmap">',
        '{',
        '  "imports": {',
        entries,
        '  }',
        '}',
        '</script>',
        END,
    ])


def main():
    v, mods = version(), modules()
    for name in PAGES:
        path = ROOT / name
        html = path.read_text(encoding='utf-8', newline='')
        nl = '\r\n' if '\r\n' in html else '\n'
        new = block(v, mods, nl)
        if START in html:
            s, e = html.index(START), html.index(END) + len(END)
            out = html[:s] + new + html[e:]
        elif '</head>' in html:
            out = html.replace('</head>', new + nl + '</head>', 1)
        else:
            sys.exit(f'{name}: no </head> to put the map before')
        changed = out != html
        if changed:
            path.write_text(out, encoding='utf-8', newline='')
        print(f'{name}: {len(mods)} modules at v{v}' + ('' if changed else ' (unchanged)'))


if __name__ == '__main__':
    main()
