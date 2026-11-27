// Tiny IndexedDB layer.
// "photos" holds metadata + a small thumbnail; "blobs" holds the full image,
// kept separate so listing the library never loads full-size files.
//
// When the phone is completely full, WebKit can't open or write the database
// (it can hang forever instead of failing). So every call has a time limit, and
// everything written this session is also kept in memory: the app keeps working,
// it just can't remember progress after it's closed. storageOk() tells the app.

const DB_NAME = 'swipeclean';
const DB_VERSION = 1;
const LIMIT_MS = 4000;
let dbPromise;
let ok = true;

const memMeta = new Map();    // id -> meta written this session (wins over the database)
const memBlobs = new Map();   // id -> blob, only used when the database is unusable
const memGone = new Set();    // ids deleted this session

export const storageOk = () => ok;

function withLimit(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('storage timed out')), LIMIT_MS)),
  ]);
}

function open() {
  if (!dbPromise) {
    dbPromise = withLimit(new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        const photos = d.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('sig', 'sig', { unique: false });
        d.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    })).catch((e) => {
      console.warn('Storage unavailable, keeping progress in memory only:', e?.message || e);
      ok = false;
      return null;
    });
  }
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Run a write; if it fails or hangs, note it (the memory copy still has the data).
async function write(stores, fill) {
  const d = await open();
  if (!d || !ok) return;   // once saving has failed, don't make every swipe wait for it
  try {
    const tx = d.transaction(stores, 'readwrite');
    fill(tx);
    await withLimit(done(tx));
  } catch (e) {
    console.warn('Could not save progress:', e?.message || e);
    ok = false;
  }
}

async function read(fn, fallback) {
  const d = await open();
  if (!d) return fallback;
  try { return await withLimit(fn(d)); } catch { ok = false; return fallback; }
}

export async function getAllMeta() {
  const rows = await read((d) => result(d.transaction('photos').objectStore('photos').getAll()), []);
  const byId = new Map(rows.map((r) => [r.id, r]));
  memMeta.forEach((m, id) => byId.set(id, m));
  memGone.forEach((id) => byId.delete(id));
  return [...byId.values()];
}

export async function hasSig(sig) {
  for (const m of memMeta.values()) if (m.sig === sig && !memGone.has(m.id)) return true;
  const n = await read((d) => result(d.transaction('photos').objectStore('photos').index('sig').count(sig)), 0);
  return n > 0;
}

export async function addPhoto(meta, blob) {
  memMeta.set(meta.id, meta); memGone.delete(meta.id);
  if (!ok || !(await open())) memBlobs.set(meta.id, blob);
  await write(['photos', 'blobs'], (tx) => {
    tx.objectStore('photos').put(meta);
    tx.objectStore('blobs').put(blob, meta.id);
  });
  if (!ok) memBlobs.set(meta.id, blob);
}

export async function putMeta(meta) {
  memMeta.set(meta.id, meta); memGone.delete(meta.id);
  await write('photos', (tx) => tx.objectStore('photos').put(meta));
}

export async function putManyMeta(metas) {
  metas.forEach((m) => { memMeta.set(m.id, m); memGone.delete(m.id); });
  await write('photos', (tx) => {
    const store = tx.objectStore('photos');
    metas.forEach((m) => store.put(m));
  });
}

export async function getBlob(id) {
  if (memBlobs.has(id)) return memBlobs.get(id);
  return read((d) => result(d.transaction('blobs').objectStore('blobs').get(id)), null);
}

export async function deletePhotos(ids) {
  if (!ids.length) return;
  ids.forEach((id) => { memMeta.delete(id); memBlobs.delete(id); memGone.add(id); });
  await write(['photos', 'blobs'], (tx) => {
    ids.forEach((id) => {
      tx.objectStore('photos').delete(id);
      tx.objectStore('blobs').delete(id);
    });
  });
}
