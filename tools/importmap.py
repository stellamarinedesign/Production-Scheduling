#!/usr/bin/env python3
"""Write the import map, the preloads and the start-up watch into index.html,
parts.html and vessel-codes.html.

THE IMPORT MAP. Every module under js/ gets an entry "./js/x.js" ->
"./js/x.js?v=<VERSION>", VERSION read from js/version.js. The page's own links
reach only the entry script and the stylesheet; the map is what reaches the
modules they import, so a page and its modules always come from the same build
however the browser has cached them (GitHub Pages caches every file for ten
minutes).

THE PRELOADS. After the map, a <link rel="modulepreload"> for every module the
page's entry script reaches by static import, at the same ?v=, and for the
three Firebase SDK files firebase.js loads. Without them the browser found the
modules one import level at a time - six levels deep, a round trip each - and
fetched the SDK only once all of them had run; with them every file is asked
for as the <head> is read, the SDK alongside the app.

THE START-UP WATCH. js/watchdog.js, written inline at the top of the <head>,
before the stylesheet, so it runs before any module has arrived (see that file).

Run it after adding or removing a module or an import, or after editing
js/watchdog.js, no arguments, from anywhere:

    python tools/importmap.py

The version bump itself stays the usual substitution over the four files; it
reaches the map's and the preloads' strings too, so this script is not part of
a release.
"""
import re
import sys
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = ['index.html', 'parts.html', 'vessel-codes.html']
START = '<!-- importmap:start'
END = '<!-- importmap:end -->'
WATCH_START = '<!-- watchdog:start'
WATCH_END = '<!-- watchdog:end -->'
# What firebase.js imports at start-up (App Check only when a site key is set).
SDK_FILES = ['firebase-app.js', 'firebase-firestore.js', 'firebase-auth.js']

# A static import or re-export: `import ... from './x.js'`, `export ... from
# './x.js'`, `import './x.js'`, each at the start of a line. Dynamic import()
# is not followed: what it loads is not needed to start.
STATIC = re.compile(
    r"""^(?:import|export)\s[^;]*?\bfrom\s*['"](\.{1,2}/[^'"]+)['"]|^import\s*['"](\.{1,2}/[^'"]+)['"]""",
    re.M)


def version():
    text = (ROOT / 'js' / 'version.js').read_text(encoding='utf-8')
    m = re.search(r"VERSION = '([^']+)'", text)
    if not m:
        sys.exit('js/version.js: no VERSION found')
    return m.group(1)


def modules():
    return sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / 'js').rglob('*.js'))


def sdk():
    """The SDK base URL as firebase.js has it, and the files it imports at start-up."""
    text = (ROOT / 'js' / 'firebase.js').read_text(encoding='utf-8')
    m = re.search(r"const SDK = '([^']+)'", text)
    if not m:
        sys.exit('js/firebase.js: no SDK constant found')
    for f in SDK_FILES:
        if '${SDK}/' + f not in text:
            sys.exit(f'js/firebase.js: does not import {f}; update SDK_FILES')
    return [f'{m.group(1)}/{f}' for f in SDK_FILES]


def graph(entry):
    """Every module the entry reaches by static import, nearest first."""
    seen, order, todo = {entry}, [], deque([entry])
    while todo:
        mod = todo.popleft()
        order.append(mod)
        path = ROOT / mod
        if not path.exists():
            sys.exit(f'{mod}: imported but missing')
        for m in STATIC.finditer(path.read_text(encoding='utf-8')):
            spec = m.group(1) or m.group(2)
            dep = (path.parent / spec).resolve().relative_to(ROOT).as_posix()
            if dep not in seen:
                seen.add(dep)
                todo.append(dep)
    return order


def entry_of(name, html):
    m = re.search(r'<script type="module" src="([^"?]+)', html)
    if not m:
        sys.exit(f'{name}: no entry module')
    return m.group(1)


def block(v, mods, preloads, nl):
    entries = (',' + nl).join(f'    "./{m}": "./{m}?v={v}"' for m in mods)
    return nl.join([
        f"{START} - every module named with the build's ?v=, so a page is never mixed with"
        ' cached modules, then every file the page starts with preloaded; regenerate with:'
        ' python tools/importmap.py -->',
        '<script type="importmap">',
        '{',
        '  "imports": {',
        entries,
        '  }',
        '}',
        '</script>',
        *(f'<link rel="modulepreload" href="{href}">' for href in preloads),
        END,
    ])


def watch_block(nl):
    src = (ROOT / 'js' / 'watchdog.js').read_text(encoding='utf-8').replace('\r\n', '\n').strip('\n')
    if '</script' in src.lower() or '<!--' in src:
        sys.exit('js/watchdog.js: cannot be written inline')
    return nl.join([
        f'{WATCH_START} - js/watchdog.js, inline so it runs before any module; regenerate with:'
        ' python tools/importmap.py -->',
        '<script>',
        src.replace('\n', nl),
        '</script>',
        WATCH_END,
    ])


def put(html, start, end, new, where, name, after=''):
    """Replace the block between the markers, or insert it (and `after`) at `where`."""
    if start in html:
        s, e = html.index(start), html.index(end) + len(end)
        return html[:s] + new + html[e:]
    m = re.search(where, html)
    if not m:
        sys.exit(f'{name}: nowhere to put {start}')
    return html[:m.end()] + new + after + html[m.end():]


def main():
    v, mods, firebase = version(), modules(), sdk()
    for name in PAGES:
        path = ROOT / name
        html = path.read_text(encoding='utf-8', newline='')
        nl = '\r\n' if '\r\n' in html else '\n'
        reach = graph(entry_of(name, html))
        preloads = (firebase if 'js/firebase.js' in reach else []) + [f'{m}?v={v}' for m in reach]
        out = put(html, START, END, block(v, mods, preloads, nl), r'(?=</head>)', name)
        out = put(out, WATCH_START, WATCH_END, watch_block(nl),
                  r'<meta name="viewport"[^>]*>' + re.escape(nl), name, after=nl)
        changed = out != html
        if changed:
            path.write_text(out, encoding='utf-8', newline='')
        print(f'{name}: {len(mods)} modules at v{v}, {len(preloads)} preloaded'
              + ('' if changed else ' (unchanged)'))


if __name__ == '__main__':
    main()
