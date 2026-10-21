// stella-folder.js — the Stella Systems folder on this PC.
//
// OneDrive syncs Stella Systems to every PC, under a different Windows
// profile each time, so the app never deals in full paths. The person at the
// PC points the browser at their Stella Systems folder once (Edge or Chrome:
// the File System Access API); the browser remembers it, here in IndexedDB,
// and asks again for permission when it chooses to. Everything a package
// holds is a path below that folder.
//
// A folder or document dragged in from File Explorer is placed by asking the
// browser where it sits relative to Stella Systems, which is what makes
// drag-and-drop work without anybody typing a path.

import { ROOT_NAME, splitPath, joinPath, isArchiveName, docKind } from './packages.js';

const DB = 'stella-board-files';
const STORE = 'handles';
const KEY = 'stellaSystems';

let remembered = null;          // this session's copy, for a browser that cannot store it

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

/** Edge and Chrome can; Firefox and Safari cannot. */
export const supported = () => typeof window.showDirectoryPicker === 'function';

/** The folder this PC was pointed at, if it was. */
export async function savedRoot() {
  if (remembered) return remembered;
  try { remembered = (await idb('readonly', (s) => s.get(KEY))) ?? null; } catch { remembered = null; }
  return remembered;
}

/**
 * Where this PC stands: no folder yet, a folder the browser wants to ask
 * about again, or a folder ready to read.
 * @returns {Promise<{handle: FileSystemDirectoryHandle|null, state: 'none'|'prompt'|'denied'|'granted'}>}
 */
export async function rootState() {
  const handle = await savedRoot();
  if (!handle) return { handle: null, state: 'none' };
  try { return { handle, state: await handle.queryPermission({ mode: 'read' }) }; }
  catch { return { handle, state: 'prompt' }; }
}

/** Ask again for a folder chosen before. Needs a click to have started it. */
export async function allowRoot(handle) {
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

/** Point this PC at its Stella Systems folder. Needs a click to have started it. */
export async function chooseRoot() {
  const handle = await window.showDirectoryPicker({ id: 'stella-systems', mode: 'read' });
  if (handle.name.toLowerCase() !== ROOT_NAME.toLowerCase()) {
    throw new Error(`That is "${handle.name}". Choose the ${ROOT_NAME} folder itself.`);
  }
  remembered = handle;
  try { await idb('readwrite', (s) => s.put(handle, KEY)); } catch { /* kept for this session only */ }
  return handle;
}

/** A folder or file's path below Stella Systems, or null when it is not inside it. */
export async function pathWithin(root, handle) {
  if (await root.isSameEntry(handle)) return '';
  const parts = await root.resolve(handle);
  return parts ? joinPath(parts) : null;
}

/** The handle at a path below Stella Systems. Throws NotFoundError when it has gone. */
export async function handleAt(root, path, kind) {
  const parts = splitPath(path);
  let dir = root;
  for (let i = 0; i < parts.length; i++) {
    if (i === parts.length - 1 && kind === 'file') return dir.getFileHandle(parts[i]);
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  return dir;
}

/**
 * The Word documents and PDFs under a folder, with their dates. Archive
 * folders are not entered. Reading a date does not download an online-only
 * file; reading its contents does, later, when it is printed.
 * @returns {Promise<Array<{dirs: string[], name: string, lastModified: number, handle}>>}
 */
export async function listFiles(dir, { maxDepth = 6, limit = 4000 } = {}) {
  const out = [];
  async function walk(d, dirs, depth) {
    for await (const [name, h] of d.entries()) {
      if (out.length >= limit) return;
      if (h.kind === 'directory') {
        if (depth < maxDepth && !isArchiveName(name) && !name.startsWith('.')) await walk(h, [...dirs, name], depth + 1);
      } else if (docKind(name)) {
        const f = await h.getFile();
        out.push({ dirs, name, lastModified: f.lastModified, handle: h });
      }
    }
  }
  await walk(dir, [], 0);
  return out;
}

/** The folders directly inside one, archives left out. */
export async function listFolders(dir) {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory' && !isArchiveName(name) && !name.startsWith('.')) out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * What was dropped, as handles. Has to be called inside the drop event itself,
 * before anything is awaited: the browser forgets the items once it returns.
 * @returns {Promise<Array<FileSystemHandle|null>>}
 */
export function droppedHandles(event) {
  const items = [...(event.dataTransfer?.items ?? [])].filter((i) => i.kind === 'file');
  return Promise.all(items.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : null)));
}
