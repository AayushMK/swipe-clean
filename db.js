// Tiny IndexedDB layer.
// "photos" holds metadata + a small thumbnail; "blobs" holds the full image,
// kept separate so listing the library never loads full-size files.

const DB_NAME = 'swipeclean';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        const photos = d.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('sig', 'sig', { unique: false });
        d.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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

export async function getAllMeta() {
  const d = await open();
  return result(d.transaction('photos').objectStore('photos').getAll());
}

export async function hasSig(sig) {
  const d = await open();
  const n = await result(d.transaction('photos').objectStore('photos').index('sig').count(sig));
  return n > 0;
}

export async function addPhoto(meta, blob) {
  const d = await open();
  const tx = d.transaction(['photos', 'blobs'], 'readwrite');
  tx.objectStore('photos').put(meta);
  tx.objectStore('blobs').put(blob, meta.id);
  return done(tx);
}

export async function putMeta(meta) {
  const d = await open();
  const tx = d.transaction('photos', 'readwrite');
  tx.objectStore('photos').put(meta);
  return done(tx);
}

export async function putManyMeta(metas) {
  const d = await open();
  const tx = d.transaction('photos', 'readwrite');
  const store = tx.objectStore('photos');
  metas.forEach((m) => store.put(m));
  return done(tx);
}

export async function getBlob(id) {
  const d = await open();
  return result(d.transaction('blobs').objectStore('blobs').get(id));
}

export async function deletePhotos(ids) {
  if (!ids.length) return;
  const d = await open();
  const tx = d.transaction(['photos', 'blobs'], 'readwrite');
  ids.forEach((id) => {
    tx.objectStore('photos').delete(id);
    tx.objectStore('blobs').delete(id);
  });
  return done(tx);
}
