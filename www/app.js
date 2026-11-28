import * as db from './db.js';

/* ---------- Platform ----------
 * Website (PWA): you pick photos; the app works on copies kept in the browser.
 * Native app (Capacitor, iOS/Android): the app reads your real photo library
 * and deletes from it via the PhotoLibrary plugin.
 */
const Cap = window.Capacitor;
const NATIVE = !!Cap?.isNativePlatform?.();
const registerPlugin = window.capacitorExports?.registerPlugin || Cap?.registerPlugin;
const Lib = NATIVE ? registerPlugin('PhotoLibrary') : null;
const Notify = NATIVE ? registerPlugin('LocalNotifications') : null;
const IOS = NATIVE && Cap.getPlatform?.() === 'ios';
const SITE_URL = 'https://aayushmk.github.io/swipe-clean/';
const REMINDER_ID = 1001;

/* ---------- Settings & daily stats (localStorage) ---------- */

const DEFAULTS = { dailyGoal: 100, retentionDays: 10, reminderTime: '20:00', reminderOn: false, sortOrder: 'newest',
  reminderMode: 'daily', busyThreshold: 30 };
const DAY = 24 * 60 * 60 * 1000;

const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('settings') || '{}') };
// A completely full phone makes saving throw; the app must keep working anyway.
{
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    try { set.call(this, k, v); } catch (e) { console.warn('Could not save', k, e); }
  };
}
const saveSettings = () => localStorage.setItem('settings', JSON.stringify(settings));

const stats = JSON.parse(localStorage.getItem('stats') || '{}'); // { 'YYYY-MM-DD': reviewedCount }
const saveStats = () => localStorage.setItem('stats', JSON.stringify(stats));

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const todayCount = () => stats[dayKey()] || 0;
function bumpToday(delta) {
  const k = dayKey();
  stats[k] = Math.max(0, (stats[k] || 0) + delta);
  saveStats();
}
function streak() {
  let n = 0;
  const d = new Date();
  if ((stats[dayKey(d)] || 0) < settings.dailyGoal) d.setDate(d.getDate() - 1); // today not done yet doesn't break it
  while ((stats[dayKey(d)] || 0) >= settings.dailyGoal) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ---------- State ---------- */

let photos = [];                // all photo records
let tab = 'pending';
let access = 'granted';         // native: granted | limited | denied | prompt
const thumbUrls = new Map();    // id -> displayable URL

const $ = (id) => document.getElementById(id);
const byStatus = (s) => photos.filter((p) => p.status === s);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isVideo = (p) => p.kind === 'video';
const itemWord = (n, list) => {
  const v = list?.length ? list.every(isVideo) : false;
  return plural(n, v ? 'video' : (list && list.some(isVideo) ? 'item' : 'photo'));
};
function fmtDuration(sec) {
  if (!sec && sec !== 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}` : `${m}:${String(s2).padStart(2, '0')}`;
}
function fmtBytes(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b < 10 && i ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}
const freed = () => Number(localStorage.getItem('freedBytes') || 0);
const freedDaily = () => JSON.parse(localStorage.getItem('freedDaily') || '{}');
const freedToday = () => freedDaily()[dayKey()] || 0;
function addFreed(n) {
  if (!n) return;
  localStorage.setItem('freedBytes', String(freed() + n));
  const d = freedDaily();
  d[dayKey()] = (d[dayKey()] || 0) + n;
  localStorage.setItem('freedDaily', JSON.stringify(d));
}

function forget(ids) {
  ids.forEach((id) => {
    const u = thumbUrls.get(id);
    if (u?.startsWith('blob:')) URL.revokeObjectURL(u);
    thumbUrls.delete(id);
  });
}

// Order of "To review" (the grid and the swipe view).
const SORTS = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  random: 'Random',
  largest: 'Largest first',
  screenshots: 'Screenshots first',
  videos: 'Videos first',
  onthisday: 'On this day',
};
if (!SORTS[settings.sortOrder]) settings.sortOrder = DEFAULTS.sortOrder;

// Random order stays the same while the app is open (so the grid and the
// swipe view agree) and changes on every launch or when you tap Shuffle.
const randKeys = new Map();
const randKey = (p) => {
  if (!randKeys.has(p.id)) randKeys.set(p.id, Math.random());
  return randKeys.get(p.id);
};

// Days between a photo's month/day and today's, ignoring the year.
function daysFromToday(t) {
  if (!t) return 999;
  const d = new Date(t), now = new Date();
  const a = Date.UTC(2001, d.getMonth(), d.getDate()), b = Date.UTC(2001, now.getMonth(), now.getDate());
  const diff = Math.abs(a - b) / DAY;
  return Math.min(diff, 365 - diff);
}

function sortPending(list) {
  const newest = (a, b) => b.taken - a.taken;
  const by = {
    newest,
    oldest: (a, b) => a.taken - b.taken,
    random: (a, b) => randKey(a) - randKey(b),
    largest: (a, b) => (b.size ?? -1) - (a.size ?? -1) || newest(a, b),
    screenshots: (a, b) => (!!b.screenshot - !!a.screenshot) || newest(a, b),
    videos: (a, b) => (isVideo(b) - isVideo(a)) || newest(a, b),
    onthisday: (a, b) => daysFromToday(a.taken) - daysFromToday(b.taken) || newest(a, b),
  }[settings.sortOrder] || newest;
  return list.sort(by);
}

function sortList(list, status) {
  if (status === 'trash') return list.sort((a, b) => b.trashedAt - a.trashedAt);
  if (status === 'kept') return list.sort((a, b) => b.reviewedAt - a.reviewedAt);
  return sortPending(list);
}

function daysLeft(p) {
  return Math.max(0, Math.ceil((p.trashedAt + settings.retentionDays * DAY - Date.now()) / DAY));
}

/* ---------- Images (thumbnails + full size) ---------- */

async function nativeImage(id, size) {
  const { path, data } = await Lib.getImage({ id, size });
  return data || Cap.convertFileSrc(path);   // data: when the phone is too full for a file
}

// Synchronous when we already have it (web thumbs are stored blobs).
function thumbUrlNow(p) {
  if (thumbUrls.has(p.id)) return thumbUrls.get(p.id);
  if (!NATIVE && p.thumb) {
    const u = URL.createObjectURL(p.thumb);
    thumbUrls.set(p.id, u);
    return u;
  }
  return null;
}

async function loadThumb(p) {
  if (p.remote) return remoteImage(p, 360);
  const now = thumbUrlNow(p);
  if (now || !NATIVE) return now;
  try {
    const u = await nativeImage(p.id, 360);
    thumbUrls.set(p.id, u);
    return u;
  } catch { return null; }
}

async function loadFull(p) {
  if (p.remote) return isVideo(p) ? remoteImage(p, 1024) : remoteImage(p, 2048);
  if (NATIVE) {
    if (isVideo(p)) {
      try {
        const { path } = await Lib.getVideo({ id: p.id });
        return Cap.convertFileSrc(path);
      } catch (e) {
        if (e?.code === 'NO_SPACE') { toast('Phone is full, so this video can’t play. You can still keep or delete it.'); showFullBanner(); }
        return null;
      }
    }
    try { return await nativeImage(p.id, 2048); } catch { return loadThumb(p); }
  }
  const blob = await db.getBlob(p.id);
  return blob ? URL.createObjectURL(blob) : thumbUrlNow(p);
}

/* ---------- Removing photos for good ---------- */

// Returns true if the photos are gone. On the native app, iOS/Android show
// their own "Allow Swipe Clean to delete N photos?" confirmation.
async function removeForever(ids) {
  if (!ids.length) return true;
  if (NATIVE) {
    let res;
    try { res = await Lib.deletePhotos({ ids }); } catch (e) { res = { deleted: false }; }
    if (!res.deleted) return false;
    addFreed(res.bytes);
    setTimeout(refreshStorage, 500);
  } else {
    const gone = new Set(ids);
    addFreed(photos.filter((p) => gone.has(p.id)).reduce((a, p) => a + (p.size || 0), 0));
  }
  await db.deletePhotos(ids);
  forget(ids);
  const gone = new Set(ids);
  photos = photos.filter((p) => !gone.has(p.id));
  return true;
}

const expiredIds = () => {
  const cutoff = Date.now() - settings.retentionDays * DAY;
  return photos.filter((p) => p.status === 'trash' && p.trashedAt <= cutoff).map((p) => p.id);
};

let autoPurgeTried = false;
async function purgeExpired({ force = false } = {}) {
  const ids = expiredIds();
  if (!ids.length) return 0;
  // Native deletes need the system confirmation: ask once per app launch automatically,
  // after that only when the user taps the banner.
  if (NATIVE && autoPurgeTried && !force) return 0;
  autoPurgeTried = true;
  const ok = await removeForever(ids);
  return ok ? ids.length : 0;
}

/* ---------- Native library sync ---------- */

// iOS reads file sizes during the storage scan (too slow to do while listing photos).
let sizeCache = {};

async function syncNativeLibrary() {
  let lib = [];
  try { ({ photos: lib } = await Lib.getPhotos()); } catch (e) { console.error(e); }
  const stored = new Map((await db.getAllMeta()).map((r) => [r.id, r]));
  const inLib = new Set();
  photos = lib.map((a) => {
    inLib.add(a.id);
    const s = stored.get(a.id);
    return {
      id: a.id, name: '', taken: a.taken || 0, width: a.width, height: a.height,
      kind: a.type === 'video' ? 'video' : 'image', duration: a.duration, size: a.size ?? sizeCache[a.id],
      screenshot: !!a.screenshot,
      status: s?.status || 'pending', reviewedAt: s?.reviewedAt || 0, trashedAt: s?.trashedAt || 0,
    };
  });
  // Forget review records for photos that were deleted outside the app.
  const stale = [...stored.keys()].filter((id) => !inLib.has(id));
  if (stale.length) await db.deletePhotos(stale);
}

/* ---------- Web import ---------- */

// Poster frame + duration for a picked video file (website mode).
function videoInfo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const done = (r) => { URL.revokeObjectURL(url); r(); };
    v.onloadedmetadata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); };
    v.onseeked = () => {
      const MAX = 360, w = v.videoWidth, h = v.videoHeight;
      const scale = Math.min(1, MAX / Math.min(w, h));
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((thumb) => done(() => resolve({ thumb, duration: v.duration })), 'image/jpeg', 0.78);
    };
    v.onerror = () => done(() => reject(new Error('video')));
    v.src = url;
  });
}

async function makeThumb(file) {
  const MAX = 360;
  let src;
  try {
    src = await createImageBitmap(file);
  } catch {
    // Fallback (older Safari): decode via <img>
    src = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 0); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const scale = Math.min(1, MAX / Math.min(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  if (src.close) src.close();
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.78));
}

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => /^(image|video)\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp|gif|mov|mp4|m4v)$/i.test(f.name));
  if (!files.length) return;
  $('importing').classList.remove('hidden');
  let added = 0, skipped = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      $('importText').textContent = `Adding… ${i + 1} / ${files.length}`;
      const sig = `${f.name}|${f.size}|${f.lastModified}`;
      if (await db.hasSig(sig)) { skipped++; continue; }
      const video = f.type.startsWith('video/') || /\.(mov|mp4|m4v)$/i.test(f.name);
      let thumb = null, duration;
      try {
        if (video) ({ thumb, duration } = await videoInfo(f));
        else thumb = await makeThumb(f);
      } catch { /* unsupported format: still importable */ }
      const meta = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sig, name: f.name, size: f.size, type: f.type, kind: video ? 'video' : 'image', duration,
        screenshot: /screen ?shot|screenshot|screen ?record/i.test(f.name),
        taken: f.lastModified || Date.now(), addedAt: Date.now(),
        status: 'pending', reviewedAt: 0, trashedAt: 0, thumb,
      };
      await db.addPhoto(meta, f);
      photos.push(meta);
      added++;
    }
  } catch (err) {
    console.error(err);
    toast('Storage is full or unavailable — try fewer photos at once.');
  } finally {
    $('importing').classList.add('hidden');
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  setTab('pending');
  if (added || skipped) toast(`Added ${plural(added, 'item')}${skipped ? ` · ${skipped} already here` : ''}`);
}

/* ---------- Rendering ---------- */

function renderCounts() {
  $('cPending').textContent = byStatus('pending').length;
  $('cKept').textContent = byStatus('kept').length;
  $('cTrash').textContent = byStatus('trash').length;

  const done = todayCount(), goal = settings.dailyGoal;
  const pct = Math.min(100, Math.round((done / goal) * 100));
  $('todayCount').textContent = done;
  $('goalCount').textContent = goal;
  $('goalPct').textContent = `${pct}%`;
  $('goalRing').style.setProperty('--p', pct);
  const pending = byStatus('pending').length;
  const s = streak();
  $('goalSub').textContent =
    done >= goal ? `Goal done for today 🎉${s > 1 ? ` · ${s}-day streak` : ''}`
    : pending === 0 ? (NATIVE ? 'Nothing left to review' : 'Add photos to start cleaning')
    : `${Math.min(goal - done, pending)} to go${s ? ` · 🔥 ${s}-day streak` : ''}`;
  $('startBtn').disabled = pending === 0;

  // Native: expired photos still waiting for the system delete confirmation
  const exp = NATIVE ? expiredIds().length : 0;
  $('expiredBar').classList.toggle('hidden', !exp);
  $('expiredText').textContent = `${plural(exp, 'photo')} passed ${settings.retentionDays} days in Deleted`;
}

// Grid renders in pages so huge libraries stay fast.
const PAGE = 240;
let gridList = [], gridShown = 0, gridIndex = new Map();
const thumbObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      const p = remoteItems.get(e.target.dataset.id) || photos.find((x) => x.id === e.target.dataset.id);
      if (p) loadThumb(p).then((u) => { if (u) e.target.querySelector('img').src = u; });
    }
  }, { rootMargin: '600px' })
  : null;
const moreObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) appendCells(); }, { rootMargin: '800px' })
  : null;

function makeCell(p) {
  const cell = document.createElement('button');
  cell.className = 'cell';
  cell.dataset.id = p.id;
  const img = document.createElement('img');
  img.alt = ''; img.decoding = 'async'; img.draggable = false;
  const now = thumbUrlNow(p);
  if (now) img.src = now;
  else if (!NATIVE) {
    const d = document.createElement('div');
    d.className = 'noimg'; d.textContent = p.name;
    cell.append(d);
  } else if (thumbObserver) thumbObserver.observe(cell);
  else loadThumb(p).then((u) => { if (u) img.src = u; });
  if (now || NATIVE) cell.prepend(img);
  if (isVideo(p)) {
    const v = document.createElement('span');
    v.className = 'vbadge';
    v.textContent = `▶ ${fmtDuration(p.duration)}`;
    cell.append(v);
  }
  const check = document.createElement('span');
  check.className = 'check';
  cell.append(check);
  if (sel.ids.has(p.id)) cell.classList.add('sel');
  if (view?.kind === 'dups' && view.groups.some((g) => g[0] === p.id)) cell.classList.add('dup-first');
  if (view?.kind === 'pcdups') {
    const b = document.createElement('span');
    b.className = 'src' + (p.remote ? '' : ' phone');
    b.textContent = p.remote ? 'Computer' : 'Phone';
    cell.append(b);
  }
  if (tab === 'trash') {
    const left = daysLeft(p);
    const b = document.createElement('span');
    b.className = 'badge' + (left <= 1 ? ' soon' : '');
    b.textContent = left === 0 ? 'today' : `${left}d left`;
    cell.append(b);
  }
  return cell;
}

function appendCells() {
  if (gridShown >= gridList.length) return;
  const frag = document.createDocumentFragment();
  const next = gridList.slice(gridShown, gridShown + PAGE);
  next.forEach((p) => frag.append(makeCell(p)));
  gridShown += next.length;
  $('grid').append(frag);
}

function renderGrid() {
  if (view) {
    const byId = new Map(photos.map((p) => [p.id, p]));
    remoteItems.forEach((p, id) => byId.set(id, p));
    gridList = view.ids.map((id) => byId.get(id)).filter((p) => p && p.status !== 'trash');
  } else {
    gridList = sortList(byStatus(tab), tab);
  }
  gridIndex = new Map(gridList.map((p, i) => [p.id, i]));
  for (const id of sel.ids) if (!gridIndex.has(id)) sel.ids.delete(id);
  gridShown = 0;
  $('grid').textContent = '';
  appendCells();
  if (moreObserver) { moreObserver.disconnect(); moreObserver.observe($('gridEnd')); }

  const empty = $('empty');
  empty.classList.toggle('hidden', gridList.length > 0);
  if (!gridList.length) {
    const days = settings.retentionDays;
    if (NATIVE && access === 'denied') {
      empty.innerHTML = `<div class="big">🔒</div><h3>Photo access is off</h3><p>Allow Swipe Clean to see your photos so you can review and clean them up.</p><button class="primary small" id="emptyAction">Open Settings</button>`;
      $('emptyAction').onclick = () => Lib.openSettings();
    } else if (tab === 'pending') {
      empty.innerHTML = photos.length
        ? `<div class="big">✨</div><h3>All caught up</h3><p>${NATIVE ? 'Every photo in your library has been reviewed. New photos show up here automatically.' : "Nothing left to review. Add more photos whenever you're ready."}</p>`
        : NATIVE
          ? `<div class="big">📷</div><h3>No photos found</h3><p>${access === 'limited' ? 'You gave access to selected photos only. Allow full access to see your whole library.' : 'Your photo library is empty.'}</p>${access === 'limited' ? '<button class="primary small" id="emptyAction">Open Settings</button>' : ''}`
          : `<div class="big">📷</div><h3>Let's clean up your photos</h3><p>Pick a batch from your library. Then swipe right to keep, left to delete.</p><button class="primary small" id="emptyAction">Choose photos</button>`;
      $('emptyAction')?.addEventListener('click', () => (NATIVE ? Lib.openSettings() : $('fileInput').click()));
    } else if (tab === 'kept') {
      empty.innerHTML = `<div class="big">💚</div><h3>No kept photos yet</h3><p>Photos you swipe right on show up here.</p>`;
    } else {
      empty.innerHTML = `<div class="big">🗑️</div><h3>Deleted is empty</h3><p>Photos you swipe left on wait here for ${plural(days, 'day')} so you can restore them.</p>`;
    }
  }

  $('gridTools').classList.toggle('hidden', !gridList.length);
  if (!gridList.length && sel.on) setSelecting(false);
  $('sortBar').classList.toggle('hidden', !!view || tab !== 'pending' || gridList.length < 2 || sel.on);
  renderSelection();
  $('sortSelect').value = settings.sortOrder;
  $('shuffleBtn').classList.toggle('hidden', settings.sortOrder !== 'random');
  $('trashBar').classList.toggle('hidden', !!view || tab !== 'trash' || !gridList.length);
  $('photosTrashHint').classList.toggle('hidden', !!view || !IOS || tab !== 'trash');
  renderViewBar();
  $('trashInfo').textContent = NATIVE
    ? `Deleted from your phone after ${plural(settings.retentionDays, 'day')}`
    : `Removed for good after ${plural(settings.retentionDays, 'day')}`;
}

function render() { renderCounts(); renderStorage(); renderGrid(); }

/* ---------- Storage dashboard ---------- */

let storage = JSON.parse(localStorage.getItem('storageInfo') || 'null');
let storageLoading = false;

async function refreshStorage() {
  if (!NATIVE || storageLoading || !(access === 'granted' || access === 'limited')) return;
  storageLoading = true;
  renderStorage();
  try {
    storage = await Lib.getStorageInfo();
    if (storage.sizes) {
      sizeCache = storage.sizes;
      delete storage.sizes;
      photos.forEach((p) => { if (sizeCache[p.id] != null) p.size = sizeCache[p.id]; });
      if (tab === 'pending' && settings.sortOrder === 'largest') renderGrid();
    }
    localStorage.setItem('storageInfo', JSON.stringify(storage));
  } catch (e) { console.error(e); }
  storageLoading = false;
  renderStorage();
}

function renderStorage() {
  const zero = (b) => fmtBytes(b) || '0 MB';
  $('cleanedToday').textContent = zero(freedToday());
  $('cleanedAll').textContent = zero(freed());

  // Website: only what was added to the app. Native: the phone's whole library.
  let s = storage;
  if (!NATIVE) {
    s = { photoBytes: 0, videoBytes: 0, photoCount: 0, videoCount: 0, totalBytes: 0, freeBytes: 0 };
    for (const p of photos) {
      if (isVideo(p)) { s.videoBytes += p.size || 0; s.videoCount++; } else { s.photoBytes += p.size || 0; s.photoCount++; }
    }
  }
  $('storageLabel').textContent = NATIVE ? 'Photos & videos on this phone' : 'Photos & videos in Swipe Clean';
  if (!s) {
    $('storageValue').textContent = storageLoading ? 'Calculating…' : '—';
    $('storageBar').classList.add('hidden');
    $('storageLegend').textContent = '';
    $('storageSub').textContent = '';
    return;
  }
  const media = s.photoBytes + s.videoBytes;
  $('storageValue').textContent = zero(media) + (storageLoading ? ' · updating…' : '');
  $('storageLegend').innerHTML =
    `<span><i class="dot photos"></i>Photos ${zero(s.photoBytes)} · ${s.photoCount.toLocaleString()}</span>` +
    `<span><i class="dot videos"></i>Videos ${zero(s.videoBytes)} · ${s.videoCount.toLocaleString()}</span>`;

  const bar = $('storageBar');
  if (s.totalBytes) {
    const used = Math.max(0, s.totalBytes - s.freeBytes);
    const pct = (b) => `${Math.max(0, Math.min(100, (b / s.totalBytes) * 100))}%`;
    const other = Math.max(0, used - media);
    bar.querySelector('.photos').style.width = pct(Math.min(s.photoBytes, used));
    bar.querySelector('.videos').style.width = pct(Math.min(s.videoBytes, Math.max(0, used - s.photoBytes)));
    bar.querySelector('.other').style.width = pct(other);
    bar.classList.remove('hidden');
    $('storageSub').textContent =
      `${Math.round((media / s.totalBytes) * 100)}% of your ${zero(s.totalBytes)} phone · ${zero(s.freeBytes)} free` +
      (media > used ? ' · sizes include iCloud originals' : '');
  } else {
    bar.classList.add('hidden');
    $('storageSub').textContent = '';
  }
}

/* ---------- Swipe left/right on the main screen to change tabs ---------- */

const TAB_ORDER = ['pending', 'kept', 'trash'];
function switchTabBy(step) {
  const i = TAB_ORDER.indexOf(tab) + step;
  if (i < 0 || i >= TAB_ORDER.length) return;
  setTab(TAB_ORDER[i]);
  const g = $('gridWrap');
  g.classList.remove('slide-from-left', 'slide-from-right');
  void g.offsetWidth;                       // restart the animation
  g.classList.add(step > 0 ? 'slide-from-right' : 'slide-from-left');
}
function setupTabSwipe() {
  const area = $('app');
  let x0 = 0, y0 = 0, t0 = 0, tracking = false;
  const begin = (x, y, target) => {
    if (!$('swiper').classList.contains('hidden') || target.closest('input, .tabs') || sel.on) return;
    tracking = true; x0 = x; y0 = y; t0 = performance.now();
  };
  const finish = (x, y) => {
    if (!tracking) return;
    tracking = false;
    if (sel.on) return;   // a drag that started selecting photos isn't a tab swipe
    const dx = x - x0, dy = y - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy) && performance.now() - t0 < 700) {
      switchTabBy(dx < 0 ? 1 : -1);        // swipe left → next tab, right → previous
    }
  };
  area.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) begin(e.touches[0].clientX, e.touches[0].clientY, e.target);
    else tracking = false;   // two fingers: that's selecting, not a tab swipe
  }, { passive: true });
  area.addEventListener('touchend', (e) => finish(e.changedTouches[0].clientX, e.changedTouches[0].clientY), { passive: true });
  area.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
  // mouse (desktop)
  area.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') begin(e.clientX, e.clientY, e.target); });
  area.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') finish(e.clientX, e.clientY); });
}

function setTab(t) {
  if (sel.on) setSelecting(false);
  if (view) { view = null; document.body.classList.remove('viewing'); }
  tab = t;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  render();
  window.scrollTo({ top: 0 });
}

/* ---------- Selecting several photos ----------
   Select → tap photos, or drag across them like the iPhone Photos app: start sideways and
   keep going (rows included); near the top/bottom edge the grid scrolls by itself.
   Shortcuts: drag with two fingers, or long-press a photo. */

const sel = { on: false, ids: new Set(), drag: null, suppressClick: false };

function setSelecting(on) {
  sel.on = on;
  sel.drag = null;
  if (!on) sel.ids.clear();
  document.body.classList.toggle('selecting', on);
  $('sortBar').classList.toggle('hidden', !!view || tab !== 'pending' || gridList.length < 2 || on);
  renderSelection();
}

function toggleSelected(id) {
  if (sel.ids.has(id)) sel.ids.delete(id); else sel.ids.add(id);
  renderSelection();
}

function selectedPhotos() { return gridList.filter((p) => sel.ids.has(p.id)); }

function renderSelection() {
  document.querySelectorAll('#grid .cell').forEach((c) => c.classList.toggle('sel', sel.ids.has(c.dataset.id)));
  $('selectBtn').textContent = sel.on ? 'Done' : 'Select';
  $('selCount').classList.toggle('hidden', !sel.on);
  $('selectAllBtn').classList.toggle('hidden', !sel.on);
  const list = selectedPhotos(), n = list.length;
  $('selCount').textContent = n ? `${itemWord(n, list)} selected` : 'Tap or drag to select';
  $('selectAllBtn').textContent = n && n === gridList.length ? 'Deselect all' : 'Select all';
  const bar = $('selBar');
  bar.classList.toggle('hidden', !sel.on);
  if (!sel.on) return;
  const key = view ? ({ remote: 'remote', pcdups: 'pcdups' }[view.kind] || 'view') : tab;
  const actions = {
    pending: [['Share', '', 'share'], ['Delete', 'trash', 'trash'], ['Keep', 'keep', 'kept']],
    kept: [['Share', '', 'share'], ['Back to review', '', 'pending'], ['Delete', 'trash', 'trash']],
    trash: [['Restore', '', 'kept'], [NATIVE ? 'Delete from phone' : 'Delete permanently', 'trash', 'forever']],
    view: [['Share', 'keep', 'share'], ['Delete', 'trash', 'trash']],
    remote: [['Move to Trash on computer', 'trash', 'pctrash']],
    pcdups: [['Delete selected copies', 'trash', 'pcdelete']],
  }[key];
  if (bar.dataset.tab !== key) {
    bar.dataset.tab = key;
    bar.textContent = '';
    actions.forEach(([label, cls, to]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = cls; b.textContent = label;
      b.onclick = () => applyToSelected(to);
      bar.append(b);
    });
  }
  bar.querySelectorAll('button').forEach((b) => { b.disabled = !n; });
}

// Change many photos at once (one save for all of them).
async function setStatusMany(list, status) {
  const now = Date.now();
  list.forEach((p) => {
    p.status = status;
    p.reviewedAt = status === 'pending' ? 0 : now;
    p.trashedAt = status === 'trash' ? now : 0;
  });
  if (NATIVE) {
    if (status === 'pending') await db.deletePhotos(list.map((p) => p.id));
    else await db.putManyMeta(list.map((p) => ({ id: p.id, status, reviewedAt: p.reviewedAt, trashedAt: p.trashedAt })));
  } else {
    await db.putManyMeta(list);
  }
  if (!db.storageOk()) showFullBanner();
}

async function applyToSelected(to) {
  const list = selectedPhotos();
  if (!list.length) return;
  const from = tab, n = list.length, what = itemWord(n, list);
  if (to === 'share') { openShare(list); return; }
  if (to === 'pctrash' || to === 'pcdelete') { await deleteMixed(list); return; }
  if (to === 'forever') {
    if (!NATIVE && !confirm(`Remove ${what} for good? This can't be undone.`)) return;
    const ok = await removeForever(list.map((p) => p.id));
    setSelecting(false); render();
    if (ok) deletedToast(`Deleted ${what}`); else toast('Not deleted');
    return;
  }
  const before = new Map(list.map((p) => [p.id, p.status]));
  const reviewed = to === 'pending' ? 0 : list.filter((p) => p.status === 'pending').length;
  await setStatusMany(list, to);
  bumpToday(reviewed);   // reviewing counts toward today's goal
  setSelecting(false); render();
  const done = { trash: `Moved ${what} to Deleted`, kept: from === 'trash' && !view ? `Restored ${what}` : `Kept ${what}`, pending: `Moved ${what} back to To review` }[to];
  toast(done, {
    label: 'Undo',
    fn: async () => {
      for (const st of new Set(before.values())) await setStatusMany(list.filter((p) => before.get(p.id) === st), st);
      bumpToday(-reviewed);
      render();
    },
  });
}

// Drag-select: everything between where the drag started and the finger gets the
// opposite of the starting photo's state; photos the drag leaves go back to how they were.
function rangeBegin(i) {
  if (i == null) return;
  sel.drag = { anchor: i, base: new Set(sel.ids), target: !sel.ids.has(gridList[i].id), x: 0, y: 0, raf: 0 };
  rangeTo(i);
}
function rangeTo(i) {
  const d = sel.drag;
  if (!d || i == null) return;
  const a = Math.min(d.anchor, i), b = Math.max(d.anchor, i);
  sel.ids = new Set(d.base);
  for (let k = a; k <= b; k++) { const id = gridList[k].id; if (d.target) sel.ids.add(id); else sel.ids.delete(id); }
  renderSelection();
}
function cellIndexAt(x, y) {
  const c = document.elementFromPoint(x, y)?.closest?.('#grid .cell');
  return c ? gridIndex.get(c.dataset.id) : null;
}
function rangeMove(x, y) {
  const d = sel.drag;
  if (!d) return;
  d.x = x; d.y = y;
  rangeTo(cellIndexAt(x, y));
  if (!d.raf) d.raf = requestAnimationFrame(autoScroll);
}
// Near the top or bottom edge, scroll while selecting (faster the closer you get).
function autoScroll() {
  const d = sel.drag;
  if (!d) return;
  d.raf = 0;
  const edge = 110, top = d.y - edge, bottom = window.innerHeight - edge - d.y;
  const v = top < 0 ? Math.max(-24, top / 4) : bottom < 0 ? Math.min(24, -bottom / 4) : 0;
  if (v) {
    window.scrollBy(0, v);
    rangeTo(cellIndexAt(d.x, d.y));
    d.raf = requestAnimationFrame(autoScroll);
  }
}
function rangeEnd() {
  if (sel.drag?.raf) cancelAnimationFrame(sel.drag.raf);
  sel.drag = null;
}

// Photos per row: pinch the grid to change it (2–8), remembered between visits.
function gridCols() {
  const v = parseInt($('grid').style.getPropertyValue('--cols'), 10);
  return v || Math.max(3, Math.round($('grid').clientWidth / 110));
}
function setGridCols(n) {
  n = Math.max(2, Math.min(8, n));
  if (n === parseInt($('grid').style.getPropertyValue('--cols'), 10)) return;
  $('grid').style.setProperty('--cols', n);
  $('grid').classList.add('fixed-cols');
}

function setupSelection() {
  const savedCols = parseInt(localStorage.getItem('gridCols'), 10);
  if (savedCols) setGridCols(savedCols);
  const grid = $('grid');
  $('selectBtn').onclick = () => setSelecting(!sel.on);
  $('selectAllBtn').onclick = () => {
    const all = sel.ids.size === gridList.length;
    sel.ids = all ? new Set() : new Set(gridList.map((p) => p.id));
    renderSelection();
  };

  let mode = null, x0 = 0, y0 = 0, startIdx = null, pressTimer = 0, two = null;
  const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;
  const startRangeHere = (i) => { sel.suppressClick = true; rangeBegin(i); };

  grid.addEventListener('touchstart', (e) => {
    clearTimeout(pressTimer);
    if (e.touches.length === 1) sel.suppressClick = false;   // a fresh gesture
    if (e.touches.length === 2) {
      // Two fingers: spreading/pinching resizes the grid; sliding together selects (iPhone shortcut).
      e.preventDefault();
      clearTimeout(pressTimer);
      if (mode === 'range') rangeEnd();
      const m = mid(e.touches);
      two = { m, d: spread(e.touches), cols: gridCols(), idx: cellIndexAt(m.x, m.y) };
      mode = 'two';
      return;
    }
    if (e.touches.length > 2) return;
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY;
    startIdx = cellIndexAt(x0, y0);
    if (startIdx == null) { mode = null; return; }
    if (sel.on) { mode = 'decide'; return; }
    // Long-press a photo: start selecting with it (and keep dragging to add more).
    mode = 'press';
    pressTimer = setTimeout(() => {
      if (mode !== 'press') return;
      setSelecting(true);
      mode = 'range';
      startRangeHere(startIdx);
      if (navigator.vibrate) navigator.vibrate(10);
    }, 450);
  }, { passive: false });

  grid.addEventListener('touchmove', (e) => {
    if (!mode) return;
    if (mode === 'two' && e.touches.length >= 2) {
      e.preventDefault();
      const m = mid(e.touches), ratio = spread(e.touches) / two.d;
      if (Math.abs(ratio - 1) > 0.12) mode = 'pinch';
      else if (Math.hypot(m.x - two.m.x, m.y - two.m.y) > 16) {
        if (!sel.on) setSelecting(true);
        mode = 'range';
        startRangeHere(two.idx);
        rangeMove(m.x, m.y);
      }
      return;
    }
    if (mode === 'pinch' && e.touches.length >= 2) {
      e.preventDefault();
      setGridCols(Math.round(two.cols / (spread(e.touches) / two.d)));
      return;
    }
    if (mode === 'range') {
      e.preventDefault();
      const p = e.touches.length >= 2 ? mid(e.touches) : { x: e.touches[0].clientX, y: e.touches[0].clientY };
      rangeMove(p.x, p.y);
      return;
    }
    const t = e.touches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.hypot(dx, dy) < 8) return;
    if (mode === 'press') { clearTimeout(pressTimer); mode = null; return; }   // it was a scroll
    if (mode === 'decide') {
      if (Math.abs(dx) > Math.abs(dy)) {   // sideways: select; up/down: let it scroll
        e.preventDefault();
        mode = 'range';
        startRangeHere(startIdx);
        rangeMove(t.clientX, t.clientY);
      } else mode = null;
    }
  }, { passive: false });

  const end = (e) => {
    clearTimeout(pressTimer);
    if ((mode === 'range' || mode === 'pinch' || mode === 'two') && e.touches.length) return;   // a finger is still down
    if (mode === 'pinch') { localStorage.setItem('gridCols', String(gridCols())); sel.suppressClick = true; }
    if (mode === 'range') rangeEnd();
    mode = null;
  };
  grid.addEventListener('touchend', end);
  grid.addEventListener('touchcancel', end);

  // Mouse: while selecting, press and drag across photos.
  let mouse = null;
  grid.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || !sel.on) return;
    sel.suppressClick = false;
    mouse = { x: e.clientX, y: e.clientY, i: cellIndexAt(e.clientX, e.clientY), dragging: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!mouse || e.pointerType !== 'mouse') return;
    if (!mouse.dragging && Math.hypot(e.clientX - mouse.x, e.clientY - mouse.y) > 6 && mouse.i != null) {
      mouse.dragging = true;
      startRangeHere(mouse.i);
    }
    if (mouse.dragging) rangeMove(e.clientX, e.clientY);
  });
  window.addEventListener('pointerup', () => { if (mouse?.dragging) rangeEnd(); mouse = null; });
}


/* ---------- Results view: one person, or photos similar to one ---------- */

let view = null;   // { kind: 'person' | 'similar', title, face, ids, queryId }

function openView(v) {
  if (sel.on) setSelecting(false);
  view = v;
  document.body.classList.add('viewing');
  render();
  window.scrollTo({ top: 0 });
}

function closeView() {
  if (sel.on) setSelecting(false);
  view = null;
  document.body.classList.remove('viewing');
  render();
}

function renderViewBar() {
  $('viewBar').classList.toggle('hidden', !view);
  if (!view) return;
  $('viewTitle').textContent = view.title;
  const n = gridList.length;
  const scanning = indexState?.running ? ' · still scanning, more may appear' : '';
  if (view.kind === 'pcdups') {
    const extra = view.groups.reduce((a, g) => a + g.length - 1, 0);
    $('viewSub').textContent = view.groups.length
      ? `${plural(view.groups.length, 'photo')} with copies · ${extra} ${extra === 1 ? 'copy' : 'copies'} selected — check, then Delete`
      : 'No copies found between this phone and the computer 🎉';
  } else if (view.kind === 'remote') {
    $('viewSub').textContent = n ? `${itemWord(n, gridList)} on this computer · Select to move to its Trash` : 'No photos found. Add a folder or the Photos library in the companion’s menu.';
  } else if (view.kind === 'dups') {
    const extra = view.groups.reduce((a, g) => a + g.length - 1, 0);
    $('viewSub').textContent = view.groups.length
      ? `${plural(view.groups.length, 'group')} · ${extra} extra ${extra === 1 ? 'copy' : 'copies'} selected — check, then Delete${scanning}`
      : (indexState?.running ? 'Still scanning your photos — duplicates will appear here' : 'No duplicates found 🎉');
  } else {
    $('viewSub').textContent = (n ? `${itemWord(n, gridList)}` : 'No matches yet') + (n ? ' · Select to share or delete' : '') + scanning;
  }
  $('viewFace').classList.toggle('hidden', !view.face);
  if (view.face) $('viewFace').src = view.face;
}

/* ---------- Sharing (originals, never kept by the app) ---------- */

let shareList = [];
function openShare(list) {
  if (!list.length) return;
  shareList = list;
  $('shareTitle').textContent = `Share ${itemWord(list.length, list)}`;
  $('shareZip').classList.toggle('hidden', !NATIVE);
  $('jpegRow').classList.toggle('hidden', !IOS || list.every(isVideo));
  $('shareJpeg').checked = localStorage.getItem('shareJpeg') === '1';
  $('shareSheet').classList.remove('hidden');
}

function busy(text) {
  $('importText').textContent = text;
  $('importing').classList.toggle('hidden', !text);
}

async function doShare(zip) {
  $('shareSheet').classList.add('hidden');
  const list = shareList;
  localStorage.setItem('shareJpeg', $('shareJpeg').checked ? '1' : '0');
  if (NATIVE) {
    busy(list.length > 1 ? `Getting ${itemWord(list.length, list)} ready…` : 'Getting it ready…');
    try {
      await Lib.shareItems({ ids: list.map((p) => p.id), zip, jpeg: IOS && $('shareJpeg').checked });
    } catch (e) {
      toast(`Couldn't share: ${e?.message || 'something went wrong'}`);
    } finally {
      busy('');
    }
    return;
  }
  // Website: the browser's share sheet with the original files.
  const files = (await Promise.all(list.map(async (p) => {
    const b = await db.getBlob(p.id);
    return b ? new File([b], p.name || 'photo.jpg', { type: b.type || p.type || 'image/jpeg' }) : null;
  }))).filter(Boolean);
  if (files.length && navigator.canShare?.({ files })) {
    try { await navigator.share({ files }); } catch { /* cancelled */ }
  } else {
    toast('This browser can’t share photos — use the Swipe Clean app');
  }
}

/* ---------- Similar photos & people (index built on the phone) ---------- */

// How far apart two fingerprints may be and still count as "similar".
const SIMILAR_CUT = IOS ? 0.55 : 0.45;
let indexState = null;
let people = [];

async function startIndex() {
  if (!NATIVE || indexState?.running) return;
  indexState = { ...(indexState || {}), running: true };
  renderPeople();
  try { indexState = await Lib.indexLibrary(); } catch (e) { console.error(e); }
  indexState = { ...(indexState || {}), running: false };
  await refreshPeople();
  if (view?.kind === 'similar') showSimilar({ id: view.queryId }, { refresh: true });
  if (view?.kind === 'dups') showDuplicates({ refresh: true });
}

async function showSimilar(p, { refresh = false } = {}) {
  if (!NATIVE) return;
  if (!refresh) {
    closeViewer();
    if (!$('swiper').classList.contains('hidden')) closeSwiper();
    busy('Looking for similar photos…');
  }
  try {
    const st = await Lib.indexStatus();
    indexState = { ...st, running: st.running || indexState?.running };
    if (!st.running && st.indexed < st.total) startIndex();   // keep improving in the background
    const { matches } = await Lib.findSimilar({ id: p.id, limit: 150 });
    const ids = [p.id, ...matches.filter((m) => m.d <= SIMILAR_CUT).map((m) => m.id)];
    const v = { kind: 'similar', title: 'Similar photos', queryId: p.id, ids, face: null };
    if (refresh) { if (view?.kind === 'similar' && view.queryId === p.id) { view = v; render(); } }
    else openView(v);
  } catch (e) {
    toast('Couldn’t look for similar photos');
  } finally {
    if (!refresh) busy('');
  }
}

// Duplicates: how close two fingerprints must be to count as the same picture.
const DUP_CUT = IOS ? 0.27 : 0.2;

async function showDuplicates({ refresh = false } = {}) {
  if (!NATIVE) return;
  if (!refresh) busy('Looking for duplicates…');
  try {
    const st = await Lib.indexStatus();
    indexState = { ...st, running: st.running || indexState?.running };
    if (!st.running && st.indexed < st.total) startIndex();   // first time: index in the background
    const { groups } = await Lib.findDuplicates({ maxDistance: DUP_CUT });
    const byId = new Map(photos.map((p) => [p.id, p]));
    const live = groups.map((g) => g.ids.filter((id) => byId.get(id) && byId.get(id).status !== 'trash')).filter((g) => g.length > 1);
    const v = { kind: 'dups', title: 'Duplicates', ids: live.flat(), groups: live, face: null };
    if (refresh) { if (view?.kind !== 'dups') return; view = v; }
    else openView(v);
    // Pre-select every copy except the best one in each group; the user reviews, then deletes.
    if (live.length) {
      if (!sel.on) setSelecting(true);
      sel.ids = new Set(live.flatMap((g) => g.slice(1)));
    }
    render();
  } catch (e) {
    console.error(e);
    toast('Couldn’t look for duplicates');
  } finally {
    if (!refresh) busy('');
  }
}

async function refreshPeople() {
  if (!NATIVE || !(access === 'granted' || access === 'limited')) return renderPeople();
  try {
    const st = await Lib.indexStatus();
    indexState = { ...st, running: st.running || indexState?.running };
    if (st.indexed > 0) people = (await Lib.getPeople({ strictness: parseFloat($('matchSelect').value) })).people || [];
  } catch (e) { console.error(e); }
  renderPeople();
}

function renderPeople() {
  const sec = $('people');
  sec.classList.toggle('hidden', !NATIVE || !photos.length);
  if (!NATIVE) return;
  const body = $('peopleBody');
  const st = indexState || {};
  $('matchPill').classList.toggle('hidden', !people.length);
  if (st.running) {
    const pct = st.total ? Math.round((st.indexed / st.total) * 100) : 0;
    body.innerHTML = `<div class="people-card"><span>Looking for faces on your phone… <b id="scanText">${(st.indexed || 0).toLocaleString()} of ${(st.total || 0).toLocaleString()}</b></span>
      <div class="scan-bar"><i id="scanFill" style="width:${pct}%"></i></div>
      <span>You can keep using the app. Nothing leaves your phone.</span></div>`;
    return;
  }
  if (!st.indexed) {
    body.innerHTML = `<div class="people-card"><b>Find your friends in your photos</b>
      <span>Swipe Clean groups faces so you can share every photo of someone before you clean up. It runs on your phone; nothing is uploaded.</span>
      <button class="primary small" id="scanBtn">Scan photos</button></div>`;
    $('scanBtn').onclick = startIndex;
    return;
  }
  if (!people.length) {
    body.innerHTML = `<div class="people-card"><span>No groups of faces found yet${st.indexed < st.total ? '' : '. Try “Loose match”'}.</span>
      ${st.indexed < st.total ? '<button class="primary small" id="scanBtn">Scan the rest</button>' : ''}</div>`;
    $('scanBtn')?.addEventListener('click', startIndex);
    return;
  }
  body.textContent = '';
  people.forEach((person, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'face-chip';
    const face = Cap.convertFileSrc(person.thumb);
    b.innerHTML = `<img alt="" src="${face}" /><span>${person.count}</span>`;
    b.setAttribute('aria-label', `Person ${i + 1}, ${person.count} photos`);
    b.onclick = () => {
      const byId = new Map(photos.map((p) => [p.id, p]));
      const ids = person.ids.filter((id) => byId.has(id)).sort((a, c) => byId.get(c).taken - byId.get(a).taken);
      openView({ kind: 'person', title: `Person ${i + 1}`, face, ids });
    };
    body.append(b);
  });
}

function setupFindAndShare() {
  $('viewClose').onclick = closeView;
  $('dupBtn').onclick = () => showDuplicates();
  $('viewerShare').onclick = () => { if (pv.p) openShare([pv.p]); };
  $('viewerSimilar').onclick = () => { if (pv.p) showSimilar(pv.p); };
  $('viewerSimilar').classList.toggle('hidden', !NATIVE);
  $('shareMedia').onclick = () => doShare(false);
  $('shareZip').onclick = () => doShare(true);
  $('shareClose').onclick = () => $('shareSheet').classList.add('hidden');
  $('shareSheet').addEventListener('click', (e) => { if (e.target.id === 'shareSheet') $('shareSheet').classList.add('hidden'); });
  $('matchSelect').onchange = refreshPeople;
  if (NATIVE) {
    Lib.addListener('indexProgress', ({ done, total }) => {
      indexState = { ...(indexState || {}), indexed: done, total, running: done < total };
      const fill = $('scanFill'), text = $('scanText');
      if (fill && text) {
        fill.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
        text.textContent = `${done.toLocaleString()} of ${total.toLocaleString()}`;
      } else if (NATIVE) renderPeople();
    });
  }
}


/* ---------- Computers (Swipe Clean Companion on a Mac) ----------
   The companion shows a 6-digit code in the Mac's menu bar. The phone finds it on the Wi-Fi, pairs
   with the code, and from then on only talks to that computer's certificate (pinned). Photos never
   leave your home network. */

let computers = JSON.parse(localStorage.getItem('computers') || '[]');
const remoteItems = new Map();   // 'r:<computer>:<item>' -> photo-like object
const saveComputers = () => localStorage.setItem('computers', JSON.stringify(computers));
const phoneName = () => (IOS ? 'iPhone' : 'Android phone');

async function rediscover(comp) {
  try {
    const { computers: found } = await Lib.discoverComputers();
    const m = found.find((c) => c.fp && c.fp === comp.fp) || found.find((c) => c.name === comp.name);
    if (m) { comp.host = m.host; comp.port = m.port; saveComputers(); return true; }
  } catch { /* ignore */ }
  return false;
}

async function pcCall(comp, path, { method = 'GET', body, binary = false } = {}) {
  const go = () => Lib.computerRequest({ host: comp.host, port: comp.port, path, method, body, token: comp.token, pin: comp.fp, binary });
  let r;
  try { r = await go(); } catch (e) {
    if (/identity changed/.test(e?.message || '')) throw e;
    if (!(await rediscover(comp))) throw new Error(`Can't reach ${comp.name}. Make sure Swipe Clean Companion is running and you're on the same Wi-Fi.`);
    r = await go();
  }
  if (r.status === 401) throw new Error(`${comp.name} doesn't know this phone any more. Connect it again.`);
  if (r.status >= 400) throw new Error(`${comp.name} said: ${(() => { try { return JSON.parse(r.text).error; } catch { return r.status; } })()}`);
  return binary ? r.base64 : JSON.parse(r.text);
}

const remoteImgCache = new Map();
function remoteImage(p, size) {
  const key = `${p.id}@${size}`;
  if (!remoteImgCache.has(key)) {
    remoteImgCache.set(key, pcCall(p.remote.comp, `/thumb?id=${encodeURIComponent(p.remote.itemId)}&size=${size}`, { binary: true })
      .then((b64) => `data:image/jpeg;base64,${b64}`)
      .catch(() => { remoteImgCache.delete(key); return null; }));
  }
  return remoteImgCache.get(key);
}

async function loadComputerItems(comp) {
  const { items } = await pcCall(comp, '/items');
  for (const id of [...remoteItems.keys()]) if (id.startsWith(`r:${comp.id}:`)) remoteItems.delete(id);
  for (const it of items) {
    const id = `r:${comp.id}:${it.id}`;
    remoteItems.set(id, { id, remote: { comp, itemId: it.id, source: it.source }, name: it.name, size: it.size, taken: it.taken,
      width: it.width, height: it.height, kind: it.kind, duration: it.duration, status: 'remote' });
  }
  return [...remoteItems.values()].filter((p) => p.remote.comp === comp);
}

async function browseComputer(comp) {
  $('pcSheet').classList.add('hidden');
  busy(`Loading photos from ${comp.name}…`);
  try {
    const list = (await loadComputerItems(comp)).sort((a, b) => b.taken - a.taken);
    openView({ kind: 'remote', title: comp.name, ids: list.map((p) => p.id), face: null, comp });
  } catch (e) { toast(e.message); } finally { busy(''); }
}

// Copies of the same photo on the phone and on the computer: same picture size and either the
// same file size or the same capture time. Keep the phone copy; computer copies start selected.
async function findComputerCopies(comp) {
  $('pcSheet').classList.add('hidden');
  busy(`Comparing your phone with ${comp.name}…`);
  try {
    const remote = await loadComputerItems(comp);
    const dims = (p) => `${p.kind}|${Math.min(p.width, p.height)}x${Math.max(p.width, p.height)}`;
    const phoneByDims = new Map();
    for (const p of photos) {
      if (p.status === 'trash' || !p.width) continue;
      const k = dims(p);
      if (!phoneByDims.has(k)) phoneByDims.set(k, []);
      phoneByDims.get(k).push(p);
    }
    const same = (a, b) => (a.size && b.size && a.size === b.size) || Math.abs((a.taken || 0) - (b.taken || 0)) < 2000;
    const groups = new Map();   // phone id (or first computer id) -> ids
    const used = new Set();
    for (const r of remote) {
      if (!r.width) continue;
      const match = (phoneByDims.get(dims(r)) || []).find((p) => same(p, r));
      if (match) {
        if (!groups.has(match.id)) groups.set(match.id, [match.id]);
        groups.get(match.id).push(r.id);
        used.add(r.id);
      }
    }
    // copies within the computer itself (same size, picture size and time)
    const seen = new Map();
    for (const r of remote) {
      if (used.has(r.id) || !r.size) continue;
      const k = `${dims(r)}|${r.size}`;
      if (seen.has(k)) { const g = seen.get(k); if (!groups.has(g)) groups.set(g, [g]); groups.get(g).push(r.id); }
      else seen.set(k, r.id);
    }
    const list = [...groups.values()];
    openView({ kind: 'pcdups', title: `Copies on ${comp.name}`, ids: list.flat(), groups: list, face: null, comp });
    if (list.length) {
      setSelecting(true);
      sel.ids = new Set(list.flatMap((g) => g.slice(1)));
      render();
    }
  } catch (e) { toast(e.message); } finally { busy(''); }
}

// Delete a mix of phone photos (→ Deleted tab, as usual) and computer photos (→ that computer's Trash).
async function deleteMixed(list, { confirmFirst = true } = {}) {
  const remote = list.filter((p) => p.remote), local = list.filter((p) => !p.remote);
  const byComp = new Map();
  remote.forEach((p) => { const c = p.remote.comp; if (!byComp.has(c)) byComp.set(c, []); byComp.get(c).push(p); });
  if (confirmFirst && remote.length) {
    const where = [...byComp.keys()].map((c) => c.name).join(', ');
    const fromPhotos = remote.some((p) => p.remote.source === 'photos');
    if (!confirm(`Move ${itemWord(remote.length, remote)} to the Trash on ${where}?${fromPhotos ? '\n\nPhotos-app items go to Recently Deleted; your Mac will ask you to confirm.' : ''}`)) return;
  }
  busy(remote.length ? 'Moving to the computer’s Trash…' : '');
  let moved = 0;
  try {
    for (const [comp, items] of byComp) {
      const { deleted } = await pcCall(comp, '/trash', { method: 'POST', body: { ids: items.map((p) => p.remote.itemId) } });
      const gone = new Set(deleted);
      items.forEach((p) => { if (gone.has(p.remote.itemId)) { remoteItems.delete(p.id); moved++; } });
    }
  } catch (e) { toast(e.message); }
  busy('');
  if (local.length) { await setStatusMany(local, 'trash'); }
  if (view) {
    const gone = new Set([...list.filter((p) => !remoteItems.has(p.id) && p.remote).map((p) => p.id), ...local.map((p) => p.id)]);
    view.ids = view.ids.filter((id) => !gone.has(id));
    if (view.groups) {
      view.groups = view.groups.map((g) => g.filter((id) => !gone.has(id))).filter((g) => g.length > 1);
      view.ids = view.groups.flat();   // photos left without copies drop out of the list
    }
  }
  setSelecting(false);
  render();
  const parts = [];
  if (moved) parts.push(`${itemWord(moved, remote)} moved to the computer’s Trash`);
  if (local.length) parts.push(`${itemWord(local.length, local)} moved to Deleted`);
  if (parts.length) toast(parts.join(' · '));
}

function renderComputersButton() {
  const c = computers[0];
  $('pcTitle').textContent = c ? c.name : 'Your computer';
  $('pcSub').textContent = c ? 'Browse its photos or remove copies' : 'See photos on your Mac and remove copies';
}

async function openComputers() {
  $('pcSheet').classList.remove('hidden');
  const body = $('pcBody');
  body.textContent = '';
  computers.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'pc-card';
    card.innerHTML = `<b></b><small>Paired · photos stay on your home network</small>
      <div class="pc-actions"><button class="primary" data-a="copies">Find copies</button><button data-a="browse">Browse photos</button><button class="danger" data-a="forget">Forget</button></div>`;
    card.querySelector('b').textContent = c.name;
    card.querySelector('[data-a=copies]').onclick = () => findComputerCopies(c);
    card.querySelector('[data-a=browse]').onclick = () => browseComputer(c);
    card.querySelector('[data-a=forget]').onclick = () => { computers.splice(i, 1); saveComputers(); renderComputersButton(); openComputers(); };
    body.append(card);
  });
  const add = document.createElement('div');
  add.className = 'pc-card';
  add.innerHTML = `<b>${computers.length ? 'Connect another computer' : 'Connect your Mac'}</b>
    <ol class="pc-steps"><li>Open <b>Swipe Clean Companion</b> on your Mac. It sits in the menu bar.</li>
    <li>Keep this phone on the same Wi-Fi.</li><li>Pick your Mac below and type the 6-digit code from its menu.</li></ol>
    <div id="pcFound"><small>Looking for computers…</small></div>`;
  body.append(add);
  try {
    const { computers: found } = await Lib.discoverComputers();
    const box = $('pcFound');
    if (!box) return;
    box.textContent = '';
    const fresh = found.filter((f) => !computers.some((c) => c.fp && c.fp === f.fp));
    if (!fresh.length) {
      box.innerHTML = `<small>${found.length ? 'Your paired computers are all here.' : 'No computer found. Check that Swipe Clean Companion is running and you’re on the same Wi-Fi.'}</small>`;
      return;
    }
    fresh.forEach((f) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pc-found';
      b.textContent = `💻  ${f.name}`;
      b.onclick = () => askCode(f);
      box.append(b);
    });
  } catch (e) { const box = $('pcFound'); if (box) box.innerHTML = `<small>Couldn’t search the network: ${e.message}</small>`; }
}

function askCode(f) {
  const box = $('pcFound');
  box.innerHTML = `<small>Type the code shown in the menu bar of <b></b></small>
    <input class="pc-code" id="pcCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" />
    <div class="pc-actions" style="margin-top:10px"><button class="primary" id="pcPair">Connect</button></div>`;
  box.querySelector('b').textContent = f.name;
  const input = $('pcCode');
  input.focus();
  const go = async () => {
    const code = input.value.replace(/\D/g, '');
    if (code.length !== 6) { toast('The code has 6 digits'); return; }
    try {
      const r = await Lib.computerRequest({ host: f.host, port: f.port, path: '/pair', method: 'POST', body: { code, name: phoneName() }, pin: f.fp || '' });
      if (r.status !== 200) { toast('That code didn’t work. Check the Mac’s menu bar for the current code.'); return; }
      const { token, name } = JSON.parse(r.text);
      const fp = f.fp || r.fp;
      computers.push({ id: fp.slice(0, 12), name: name || f.name, host: f.host, port: f.port, fp, token });
      saveComputers();
      renderComputersButton();
      toast(`Connected to ${name || f.name}`);
      openComputers();
    } catch (e) { toast(e.message); }
  };
  $('pcPair').onclick = go;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

function setupComputers() {
  if (!NATIVE) return;
  renderComputersButton();
  $('pcBtn').onclick = openComputers;
  $('pcClose').onclick = () => $('pcSheet').classList.add('hidden');
  $('pcSheet').addEventListener('click', (e) => { if (e.target.id === 'pcSheet') $('pcSheet').classList.add('hidden'); });
}

/* ---------- Status changes ---------- */

async function setStatus(p, status) {
  p.status = status;
  p.reviewedAt = status === 'pending' ? 0 : Date.now();
  p.trashedAt = status === 'trash' ? Date.now() : 0;
  if (NATIVE) {
    // Only review state is stored; the photo itself stays in the library.
    if (status === 'pending') await db.deletePhotos([p.id]);
    else await db.putMeta({ id: p.id, status, reviewedAt: p.reviewedAt, trashedAt: p.trashedAt });
  } else {
    await db.putMeta(p);
  }
  if (!db.storageOk()) showFullBanner();
}

/* ---------- Swipe view ---------- */

const swipe = { queue: [], index: 0, history: [], urls: new Map(), goalCelebrated: false, muted: true };

function openSwiper(startId) {
  const list = sortList(byStatus('pending'), 'pending');
  if (!list.length) return;
  let start = startId ? list.findIndex((p) => p.id === startId) : 0;
  if (start < 0) start = 0;
  // start at the tapped photo, then continue with the rest
  swipe.queue = [...list.slice(start), ...list.slice(0, start)];
  swipe.index = 0;
  swipe.history = [];
  swipe.goalCelebrated = todayCount() >= settings.dailyGoal;
  $('swiper').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  history.pushState({ swiper: true }, '');
  renderDeck();
}

function closeSwiper(fromPop = false) {
  if ($('swiper').classList.contains('hidden')) return;
  $('swiper').classList.add('hidden');
  $('swiper').style.backgroundColor = '';
  document.body.style.overflow = '';
  swipe.urls.forEach((u) => { if (u?.startsWith('blob:')) URL.revokeObjectURL(u); });
  swipe.urls.clear();
  $('deck').textContent = '';
  if (!fromPop && history.state?.swiper) history.back();
  render();
}

async function fullUrl(p) {
  if (swipe.urls.has(p.id)) return swipe.urls.get(p.id);
  const pending = loadFull(p);
  swipe.urls.set(p.id, pending);
  const url = await pending;
  swipe.urls.set(p.id, url);
  return url;
}

function fmtDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function updateSwiperBar() {
  const done = todayCount(), goal = settings.dailyGoal;
  $('swiperBar').style.width = `${Math.min(100, (done / goal) * 100)}%`;
  $('swiperCount').textContent = `${done} / ${goal} today`;
  const left = swipe.queue.length - swipe.index;
  $('swiperLeft').textContent = left > 0 ? `${left} left` : '';
  $('btnUndo').disabled = swipe.history.length === 0;
  const finished = swipe.index >= swipe.queue.length;
  $('btnKeep').disabled = $('btnTrash').disabled = finished;
}

function infoText(p) {
  return [p.remote ? `On ${p.remote.comp.name}` : '', fmtDate(p.taken), isVideo(p) ? fmtDuration(p.duration) : '', fmtBytes(p.size)].filter(Boolean).join(' · ');
}

function buildCard(p, isTop) {
  const card = document.createElement('div');
  card.className = 'card' + (isTop ? '' : ' back');
  card.dataset.id = p.id;
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  const quick = thumbUrlNow(p);          // instant low-res, then swap to full
  if (quick) img.src = quick;
  card.append(img);
  card.insertAdjacentHTML('beforeend',
    `<div class="stamp keep">KEEP</div><div class="stamp trash">DELETE</div>
     <div class="info"></div>`);
  const info = card.querySelector('.info');
  info.textContent = infoText(p);
  if (NATIVE && p.size == null) {
    Lib.getInfo({ id: p.id }).then(({ size }) => { p.size = size; info.textContent = infoText(p); }).catch(() => {});
  }

  if (isVideo(p)) {
    card.classList.add('is-video');
    const badge = document.createElement('div');
    badge.className = 'vplay';
    badge.textContent = isTop ? 'Loading video…' : '▶';
    card.append(badge);
    if (isTop) {
      Promise.resolve(fullUrl(p)).then((u) => {
        if (!u || !card.isConnected) { badge.textContent = 'Video unavailable'; return; }
        const v = document.createElement('video');
        v.src = u; v.muted = swipe.muted; v.loop = true; v.playsInline = true; v.autoplay = true;
        v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
        if (quick) v.poster = quick;
        v.addEventListener('playing', () => { img.remove(); updateMuteBadge(card); }, { once: true });
        card.insertBefore(v, img);
        v.play().catch(() => { badge.textContent = '▶ Tap to play'; });
      });
    } else {
      fullUrl(p);   // start preparing the next video in the background
    }
  } else {
    Promise.resolve(fullUrl(p)).then((u) => { if (u) img.src = u; });
  }
  return card;
}

function updateMuteBadge(card) {
  const b = card.querySelector('.vplay');
  if (b) b.textContent = swipe.muted ? '🔇 Tap for sound' : '🔊 Sound on';
}

// Tap on a video card: play if paused, otherwise toggle sound.
function tapCard(card) {
  const v = card.querySelector('video');
  if (!v) {   // photo: open it full size
    const p = swipe.queue[swipe.index];
    if (p && p.id === card.dataset.id) openViewer(p, { fromSwipe: true });
    return;
  }
  if (v.paused) { v.play().catch(() => {}); updateMuteBadge(card); return; }
  swipe.muted = !swipe.muted;
  v.muted = swipe.muted;
  updateMuteBadge(card);
}

function renderDeck() {
  const deck = $('deck');
  deck.textContent = '';
  updateSwiperBar();

  if (swipe.index >= swipe.queue.length) {
    const goalDone = todayCount() >= settings.dailyGoal;
    const n = byStatus('trash').length;
    deck.innerHTML = `<div class="card-done">
      <div><div class="big">${goalDone ? '🎉' : '✨'}</div>
      <h3>${goalDone ? 'Daily goal done!' : 'All caught up'}</h3>
      <p>${itemWord(n, byStatus('trash'))} waiting in Deleted · restore any within ${plural(settings.retentionDays, 'day')}.</p>
      <button class="primary small" id="doneBack">Back to photos</button></div></div>`;
    $('doneBack').onclick = () => closeSwiper();
    return;
  }

  const top = swipe.queue[swipe.index];
  const next = swipe.queue[swipe.index + 1];
  if (next) deck.append(buildCard(next, false));
  const card = buildCard(top, true);
  deck.append(card);
  attachDrag(card); attachPinch(card);
  // warm the cache for the one after
  const after = swipe.queue[swipe.index + 2];
  if (after && !isVideo(after)) fullUrl(after);
}

// Calls start/move/end with {x, y}. Uses touch events on phones (most reliable
// on iOS) and pointer events for mouse/trackpad.
function onDrag(el, { start, move, end }, capture = false) {
  if ('ontouchstart' in window) {
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (start({ x: t.clientX, y: t.clientY }, e) === false) return;
      const id = t.identifier;
      const find = (list) => [...list].find((x) => x.identifier === id);
      const onMove = (ev) => { const p = find(ev.changedTouches); if (p) { ev.preventDefault(); move({ x: p.clientX, y: p.clientY }); } };
      const onEnd = (ev) => {
        if (!find(ev.changedTouches)) return;
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onEnd);
        window.removeEventListener('touchcancel', onEnd);
        end();
      };
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);
      window.addEventListener('touchcancel', onEnd);
    }, { passive: true, capture });
  }
  {
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && 'ontouchstart' in window) return;   // handled above
      if (start({ x: e.clientX, y: e.clientY }, e) === false) return;
      el.setPointerCapture(e.pointerId);
      const onMove = (ev) => move({ x: ev.clientX, y: ev.clientY });
      const onEnd = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onEnd);
        el.removeEventListener('pointercancel', onEnd);
        end();
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onEnd);
      el.addEventListener('pointercancel', onEnd);
    }, { capture });
  }
}

// Pinch a swipe card to zoom into the photo right there; it springs back when you let go.
function attachPinch(card) {
  let p0 = null, el = null;
  const geo = (ts) => ({
    d: Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY),
    x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2,
  });
  card.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    el = card.querySelector('video') || card.querySelector('img');
    if (!el) return;
    const g = geo(e.touches), r = el.getBoundingClientRect();
    p0 = g;
    card.pinching = true; card.pinched = true;
    card.style.transition = 'none'; card.style.transform = '';
    card.querySelectorAll('.stamp').forEach((s) => { s.style.opacity = 0; });
    card.classList.add('zooming');
    el.style.transition = 'none';
    el.style.transformOrigin = `${g.x - r.left}px ${g.y - r.top}px`;
  }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    if (!card.pinching || e.touches.length < 2 || !p0) return;
    e.preventDefault();
    const g = geo(e.touches);
    const s = Math.max(1, Math.min(5, g.d / p0.d));
    el.style.transform = `translate(${g.x - p0.x}px, ${g.y - p0.y}px) scale(${s})`;
  }, { passive: false });
  const finish = (e) => {
    if (!card.pinching || e.touches.length >= 2) return;
    card.pinching = false;
    if (el) {
      el.style.transition = 'transform .25s cubic-bezier(.2,.8,.2,1)';
      el.style.transform = '';
      setTimeout(() => { if (!card.pinching) card.classList.remove('zooming'); }, 260);
    }
  };
  card.addEventListener('touchend', finish);
  card.addEventListener('touchcancel', finish);
}

function attachDrag(card) {
  let x0 = 0, y0 = 0, dx = 0, dy = 0, t0 = 0;
  let mode = null;   // decided after a few px: 'side' (keep/delete) or 'down' (back to grid)
  const keepStamp = card.querySelector('.stamp.keep');
  const trashStamp = card.querySelector('.stamp.trash');
  const swiperEl = $('swiper');

  onDrag(card, {
    start: (p, e) => {
      if (edgeBack.active || e.__edge) return false;
      card.pinched = false;
      mode = null; x0 = p.x; y0 = p.y; dx = dy = 0; t0 = performance.now();
      card.style.transition = 'none';
    },
    move: (p) => {
      if (card.pinching || card.pinched) return;   // two fingers: zooming, not swiping
      dx = p.x - x0; dy = p.y - y0;
      if (!mode && Math.hypot(dx, dy) > 10) mode = dy > Math.abs(dx) ? 'down' : 'side';
      if (mode === 'down') {
        const d = Math.max(0, dy);
        card.style.transform = `translate(${dx * 0.3}px, ${d}px) scale(${Math.max(0.8, 1 - d / 1200)})`;
        swiperEl.style.backgroundColor = `rgba(14,14,20,${Math.max(0.35, 1 - d / 500)})`;
        return;
      }
      card.style.transform = `translate(${dx}px, ${dy * 0.4}px) rotate(${dx / 18}deg)`;
      keepStamp.style.opacity = Math.max(0, Math.min(1, dx / 90));
      trashStamp.style.opacity = Math.max(0, Math.min(1, -dx / 90));
    },
    end: () => {
      if (card.pinching || card.pinched) { card.style.transform = ''; keepStamp.style.opacity = 0; trashStamp.style.opacity = 0; return; }
      const dt = Math.max(1, performance.now() - t0);
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && dt < 400) {
        card.style.transform = '';
        tapCard(card);
        return;
      }
      if (mode === 'down') {
        if (dy > 120 || (dy / dt > 0.5 && dy > 40)) {
          card.style.transition = 'transform .22s ease-in, opacity .22s';
          card.style.transform = `translate(${dx * 0.3}px, ${window.innerHeight}px) scale(.8)`;
          card.style.opacity = '0';
          card.querySelector('video')?.pause();
          setTimeout(() => closeSwiper(), 200);
        } else {
          card.style.transition = 'transform .25s cubic-bezier(.2,.9,.3,1.2)';
          card.style.transform = '';
          swiperEl.style.backgroundColor = '';
        }
        return;
      }
      const v = dx / dt; // px per ms
      const threshold = Math.min(120, card.offsetWidth * 0.28);
      if (dx > threshold || (v > 0.5 && dx > 30)) decide('kept');
      else if (dx < -threshold || (v < -0.5 && dx < -30)) decide('trash');
      else {
        card.style.transition = 'transform .25s cubic-bezier(.2,.9,.3,1.2)';
        card.style.transform = '';
        keepStamp.style.opacity = trashStamp.style.opacity = 0;
      }
    },
  });
}

// iPhone-style back: swipe in from the left edge of the screen.
const edgeBack = { active: false };
function setupEdgeBack() {
  const el = $('swiper');
  const EDGE = 24;
  let x0 = 0, dx = 0, t0 = 0;
  // The swipe view never scrolls: stop iOS from turning drags into page scrolling.
  el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  onDrag(el, {
    start: (p, e) => {
      if (p.x > EDGE || el.classList.contains('hidden')) return false;
      e.__edge = true;                 // the card ignores this touch
      edgeBack.active = true; x0 = p.x; dx = 0; t0 = performance.now();
      el.style.transition = 'none';
    },
    move: (p) => {
      dx = Math.max(0, p.x - x0);
      el.style.transform = `translateX(${dx}px)`;
      el.style.boxShadow = '-12px 0 30px rgba(0,0,0,.5)';
    },
    end: () => {
      edgeBack.active = false;
      const v = dx / Math.max(1, performance.now() - t0);
      const go = dx > window.innerWidth * 0.3 || (v > 0.5 && dx > 40);
      el.style.transition = 'transform .22s ease-out';
      el.style.transform = go ? `translateX(${window.innerWidth}px)` : '';
      setTimeout(() => {
        el.style.transition = el.style.transform = el.style.boxShadow = '';
        if (go) closeSwiper();
      }, 220);
    },
  }, true);   // capture phase: runs before the card's handler
}

let deciding = false;
async function decide(status) {
  if (deciding || swipe.index >= swipe.queue.length) return;
  deciding = true;
  const p = swipe.queue[swipe.index];
  const card = $('deck').querySelector(`.card:not(.back)`);
  if (card) {
    const dir = status === 'kept' ? 1 : -1;
    card.querySelector(`.stamp.${status === 'kept' ? 'keep' : 'trash'}`).style.opacity = 1;
    card.style.transition = 'transform .3s ease-in, opacity .3s';
    card.style.transform = `translate(${dir * window.innerWidth * 1.2}px, 40px) rotate(${dir * 28}deg)`;
    card.style.opacity = '0';
    card.querySelector('video')?.pause();
    const back = $('deck').querySelector('.card.back');
    if (back) back.classList.remove('back');
  }
  if (navigator.vibrate) navigator.vibrate(status === 'trash' ? 18 : 8);

  swipe.history.push({ id: p.id });
  await setStatus(p, status);
  bumpToday(1);
  swipe.index++;

  if (!swipe.goalCelebrated && todayCount() >= settings.dailyGoal) {
    swipe.goalCelebrated = true;
    toast(`🎉 Daily goal of ${settings.dailyGoal} done! Keep going if you like.`);
    refreshNativeReminders();   // no reminder later today
  }
  await new Promise((r) => setTimeout(r, 220));
  renderDeck();
  deciding = false;
}

async function undo() {
  const last = swipe.history.pop();
  if (!last || deciding) return;
  const p = photos.find((x) => x.id === last.id);
  if (!p) return;
  await setStatus(p, 'pending');
  bumpToday(-1);
  swipe.index = Math.max(0, swipe.index - 1);
  swipe.queue[swipe.index] = p;
  renderDeck();
}

/* ---------- Viewer for kept / deleted photos ---------- */

/* ---------- Full-size viewer ----------
   Works like the Photos app: the picture fills a black screen, pinch or double-tap to
   zoom (up to the photo's real pixels), drag to look around, swipe down to close, tap
   to hide the controls. Pictures sharpen in steps: thumbnail → screen size → 4096 px. */

const DETAIL_PX = 4096;
const pv = {
  p: null, fromSwipe: false, urls: [],
  s: 1, tx: 0, ty: 0, w: 0, h: 0, max: 3,   // scale, position of the image's top-left, fitted size
};

async function detailUrl(p) {
  if (p.remote) return isVideo(p) ? null : remoteImage(p, 4096);
  if (NATIVE) {
    if (isVideo(p)) return null;
    try { return await nativeImage(p.id, DETAIL_PX); } catch { return null; }
  }
  const blob = await db.getBlob(p.id);   // website: the original file itself
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  pv.urls.push(u);
  return u;
}

function pvStageSize() { const r = $('pvStage').getBoundingClientRect(); return { W: r.width, H: r.height }; }

// Size the image to fit the screen; zoom happens on top of this with a transform.
function pvFit(natW, natH) {
  const img = $('viewerImg');
  const { W, H } = pvStageSize();
  if (!natW || !natH) return;
  const k = Math.min(W / natW, H / natH);
  pv.w = natW * k; pv.h = natH * k;
  img.style.width = pv.w + 'px'; img.style.height = pv.h + 'px';
  pv.s = 1; pv.tx = (W - pv.w) / 2; pv.ty = (H - pv.h) / 2;
  pvApply(false);
}

function pvSetMax(natW) {
  // Allow zooming until one photo pixel is bigger than one screen pixel, and at least 3x.
  pv.max = Math.max(3, (natW / pv.w) / (window.devicePixelRatio || 1) * 2);
}

function pvClamp() {
  const { W, H } = pvStageSize();
  const dw = pv.w * pv.s, dh = pv.h * pv.s;
  pv.tx = dw <= W ? (W - dw) / 2 : Math.min(0, Math.max(W - dw, pv.tx));
  pv.ty = dh <= H ? (H - dh) / 2 : Math.min(0, Math.max(H - dh, pv.ty));
}

function pvApply(animate, clamp = true) {
  const img = $('viewerImg');
  if (clamp) pvClamp();
  img.classList.toggle('settle', !!animate);
  img.style.transform = `translate3d(${pv.tx}px, ${pv.ty}px, 0) scale(${pv.s})`;
}

// Zoom to scale s keeping the screen point (x, y) still.
function pvZoomAt(s, x, y, animate) {
  s = Math.max(1, Math.min(pv.max, s));
  pv.tx = x - (x - pv.tx) * (s / pv.s);
  pv.ty = y - (y - pv.ty) * (s / pv.s);
  pv.s = s;
  pvApply(animate);
}

function pvToggleChrome() { $('viewer').classList.toggle('bare'); }

function setupViewerGestures() {
  const stage = $('pvStage'), viewer = $('viewer');
  let mode = null, start = null, lastTap = 0, lastTapAt = null, tapTimer = null, moved = false;
  const pt = (t) => ({ x: t.clientX, y: t.clientY });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  stage.addEventListener('touchstart', (e) => {
    if (!$('viewerVideo').classList.contains('hidden')) return;   // video: let its controls work
    e.preventDefault();
    const ts = [...e.touches].map(pt);
    moved = false;
    if (ts.length >= 2) {
      mode = 'pinch';
      start = { d: dist(ts[0], ts[1]), m: mid(ts[0], ts[1]), s: pv.s, tx: pv.tx, ty: pv.ty };
    } else {
      mode = pv.s > 1.01 ? 'pan' : 'maybe-close';
      start = { p: ts[0], tx: pv.tx, ty: pv.ty, t: performance.now() };
    }
  }, { passive: false });

  stage.addEventListener('touchmove', (e) => {
    if (!mode) return;
    e.preventDefault();
    const ts = [...e.touches].map(pt);
    if (mode === 'pinch' && ts.length >= 2) {
      moved = true;
      const m = mid(ts[0], ts[1]);
      const s = Math.max(0.6, Math.min(pv.max * 1.15, start.s * dist(ts[0], ts[1]) / start.d));
      // keep the point that was under the fingers under the fingers
      pv.tx = m.x - (start.m.x - start.tx) * (s / start.s);
      pv.ty = m.y - (start.m.y - start.ty) * (s / start.s);
      pv.s = s;
      pvApply(false, false);
      if (s > 1.05) loadDetail();
      return;
    }
    if (!ts.length) return;
    const dx = ts[0].x - start.p.x, dy = ts[0].y - start.p.y;
    if (Math.hypot(dx, dy) > 8) moved = true;
    if (mode === 'pan') {
      pv.tx = start.tx + dx; pv.ty = start.ty + dy;
      pvApply(false);
    } else if (mode === 'maybe-close' && moved && !start.axis) {
      start.axis = Math.abs(dx) > Math.abs(dy) ? 'nav' : 'close';
    }
    if (mode === 'maybe-close' && start.axis === 'nav') {
      // Sideways: the photo follows the finger; past the first/last photo it resists.
      const atEnd = (dx < 0 && pv.i >= pv.list.length - 1) || (dx > 0 && pv.i <= 0);
      stage.style.transition = 'none';
      stage.style.transform = `translate3d(${atEnd ? dx * 0.3 : dx}px,0,0)`;
    } else if (mode === 'maybe-close' && start.axis === 'close') {
      // Swipe down to close, like Photos: the picture follows the finger and the black fades.
      const d = Math.max(0, dy);
      pv.tx = start.tx + dx * 0.4; pv.ty = start.ty + d;
      pvApply(false, false);
      viewer.style.backgroundColor = `rgba(0,0,0,${Math.max(0.2, 1 - d / 400)})`;
      viewer.classList.add('bare');
    }
  }, { passive: false });

  stage.addEventListener('touchend', (e) => {
    if (!mode) return;
    if (e.touches.length) {   // one finger lifted mid-pinch: carry on panning with the other
      mode = pv.s > 1.01 ? 'pan' : 'maybe-close';
      start = { p: pt(e.touches[0]), tx: pv.tx, ty: pv.ty, t: performance.now() };
      return;
    }
    const was = mode; mode = null;
    if (was === 'pinch') {
      if (pv.s < 1) { pv.s = 1; }
      pvApply(true);
      return;
    }
    if (was === 'maybe-close' && moved && start.axis === 'nav') {
      const dx = (e.changedTouches[0]?.clientX ?? start.p.x) - start.p.x;
      const dt = performance.now() - start.t;
      const dir = dx < 0 ? 1 : -1;
      const far = Math.abs(dx) > stage.clientWidth * 0.22 || (Math.abs(dx) > 40 && Math.abs(dx) / dt > 0.45);
      if (far && pv.list[pv.i + dir]) {
        stage.style.transition = 'transform .18s ease-in';
        stage.style.transform = `translate3d(${-dir * stage.clientWidth}px,0,0)`;
        setTimeout(() => pvGo(dir), 170);
      } else {
        stage.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
        stage.style.transform = '';
      }
      return;
    }
    if (was === 'maybe-close' && moved) {
      const dy = pv.ty - start.ty;
      viewer.style.backgroundColor = '';
      if (dy > 110) { closeViewer(); return; }
      viewer.classList.remove('bare');
      pv.tx = start.tx; pv.ty = start.ty; pvApply(true);
      return;
    }
    if (moved) { pvApply(true); return; }
    // A tap: two quick taps zoom, one tap shows/hides the controls.
    const now = performance.now(), at = start.p;
    if (now - lastTap < 300 && lastTapAt && dist(at, lastTapAt) < 40) {
      clearTimeout(tapTimer); lastTap = 0;
      if (pv.s > 1.01) { pv.s = 1; pvApply(true); }
      else { loadDetail(); pvZoomAt(Math.min(pv.max, 2.5), at.x, at.y, true); }
      return;
    }
    lastTap = now; lastTapAt = at;
    tapTimer = setTimeout(pvToggleChrome, 300);
  });

  // Computer: scroll wheel / trackpad pinch zooms at the pointer, double-click toggles, drag pans.
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    loadDetail();
    pvZoomAt(pv.s * Math.exp(-e.deltaY / 300), e.clientX, e.clientY, false);
  }, { passive: false });
  stage.addEventListener('dblclick', (e) => {
    if (pv.s > 1.01) { pv.s = 1; pvApply(true); } else { loadDetail(); pvZoomAt(2.5, e.clientX, e.clientY, true); }
  });
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || pv.s <= 1.01) return;
    drag = { x: e.clientX, y: e.clientY, tx: pv.tx, ty: pv.ty };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    pv.tx = drag.tx + e.clientX - drag.x; pv.ty = drag.ty + e.clientY - drag.y; pvApply(false);
  });
  stage.addEventListener('pointerup', () => { drag = null; });

  $('viewerClose').onclick = closeViewer;
  window.addEventListener('resize', () => {
    if (viewer.classList.contains('hidden')) return;
    const img = $('viewerImg');
    pvFit(img.naturalWidth || pv.p?.width, img.naturalHeight || pv.p?.height);
  });
  document.addEventListener('keydown', (e) => {
    if (viewer.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight') pvGo(1);
    else if (e.key === 'ArrowLeft') pvGo(-1);
  });
}

// Swap in a sharper picture without moving anything on screen.
function pvShow(url, token) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);
    const probe = new Image();
    probe.onload = () => {
      if (token !== pv.token) return resolve(false);
      const img = $('viewerImg');
      const first = !pv.w;
      img.src = url;
      if (first) pvFit(probe.naturalWidth, probe.naturalHeight);
      pvSetMax(probe.naturalWidth);
      resolve(true);
    };
    probe.onerror = () => resolve(false);
    probe.src = url;
  });
}

let detailRequested = false;
async function loadDetail() {
  if (detailRequested || !pv.p || isVideo(pv.p)) return;
  detailRequested = true;
  const token = pv.token;
  const u = await detailUrl(pv.p);
  await pvShow(u, token);
}

// The viewer moves through a list: what's left to review (from the swipe view) or the
// photos in the current tab (Kept / Deleted). Swipe left for the next one, right for the previous.
async function openViewer(p, { fromSwipe = false } = {}) {
  pv.fromSwipe = fromSwipe;
  pv.list = fromSwipe ? swipe.queue.slice(swipe.index) : [...gridList];
  pv.i = Math.max(0, pv.list.findIndex((x) => x.id === p.id));
  pv.cache = new Map();
  const viewer = $('viewer');
  viewer.classList.remove('hidden', 'bare');
  viewer.style.backgroundColor = '';
  pvLoad(0);
}

// URL for a photo's screen-size picture, shared by the viewer and its neighbours.
function pvUrlFor(p) {
  if (pv.fromSwipe) return fullUrl(p);
  if (!pv.cache.has(p.id)) pv.cache.set(p.id, loadFull(p));
  return pv.cache.get(p.id);
}

// Show pv.list[pv.i]. dir = +1 / -1 slides it in from the right / left.
async function pvLoad(dir) {
  const img = $('viewerImg'), vid = $('viewerVideo'), stage = $('pvStage');
  const p = pv.list[pv.i];
  if (!p) { closeViewer(); return; }
  pv.p = p; pv.token = Symbol('view'); pv.w = 0; pv.s = 1;
  detailRequested = false;
  const token = pv.token;
  vid.pause(); vid.removeAttribute('src');
  img.removeAttribute('src'); img.style.transform = '';
  img.classList.remove('hidden'); vid.classList.add('hidden');

  const extra = p.status === 'trash'
    ? ` · deleted ${fmtDate(p.trashedAt)} · ${plural(daysLeft(p), 'day')} left`
    : p.status === 'kept' ? ` · kept ${fmtDate(p.reviewedAt)}` : '';
  const count = pv.list.length > 1 ? `${pv.i + 1} of ${pv.list.length}\n` : '';
  $('viewerMeta').textContent = `${count}${p.name ? p.name + ' · ' : ''}${infoText(p)}${extra}`;
  pvActions(p);

  // Slide the new photo in from the side it came from.
  stage.style.transition = 'none';
  stage.style.transform = dir ? `translate3d(${dir * stage.clientWidth}px,0,0)` : '';
  if (dir) requestAnimationFrame(() => requestAnimationFrame(() => {
    stage.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1)';
    stage.style.transform = '';
  }));

  // Get the neighbours ready so the next swipe is instant.
  [pv.list[pv.i + 1], pv.list[pv.i - 1]].forEach((n) => { if (n && !isVideo(n)) pvUrlFor(n); });

  if (isVideo(p)) {
    const u = await pvUrlFor(p);
    if (token !== pv.token) return;
    if (u) {
      vid.poster = thumbUrlNow(p) || '';
      vid.src = u;
      vid.classList.remove('hidden'); img.classList.add('hidden');
      vid.play().catch(() => {});
    }
    return;
  }
  // Sharpen in steps; each step replaces the picture in place.
  if (p.width && p.height) pvFit(p.width, p.height);
  // (iPhone thumbnails are square crops, so the app's first step there is the screen-size picture.)
  const thumb = NATIVE ? null : thumbUrlNow(p);
  if (thumb) await pvShow(thumb, token);
  await pvShow(await pvUrlFor(p), token);
  if (token === pv.token) loadDetail();
}

// Move to the next (+1) or previous (-1) photo. Returns false at either end.
function pvGo(dir) {
  const j = pv.i + dir;
  if (j < 0 || j >= pv.list.length) return false;
  pv.i = j;
  pvLoad(dir);
  return true;
}

// After acting on the photo on screen: drop it from the list and show the next one.
function pvAfterAction() {
  pv.list.splice(pv.i, 1);
  if (!pv.list.length) { closeViewer(); return; }
  if (pv.i >= pv.list.length) pv.i = pv.list.length - 1;
  pvLoad(1);
}

// The swipe deck always shows the photo the viewer was on.
function pvSyncDeck() {
  if (!pv.fromSwipe || !pv.p) return;
  const at = swipe.queue.indexOf(pv.p, swipe.index);
  if (at > swipe.index) {
    swipe.queue.splice(at, 1);
    swipe.queue.splice(swipe.index, 0, pv.p);
    renderDeck();
  }
}

function pvActions(p) {
  const actions = $('viewerActions');
  actions.textContent = '';
  const add = (label, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.className = cls;
    b.onclick = async () => {
      if (b.disabled) return;
      b.disabled = true;
      await fn();
      if (!pv.fromSwipe) render();
      pvAfterAction();
    };
    actions.append(b);
  };
  $('viewerShare').classList.toggle('hidden', !!p.remote);
  $('viewerSimilar').classList.toggle('hidden', !NATIVE || !!p.remote);
  if (p.remote) {
    add(`Move to Trash on ${p.remote.comp.name}`, 'trash', async () => { await deleteMixed([p], { confirmFirst: false }); });
    return;
  }
  if (pv.fromSwipe) {
    const decideHere = (status) => async () => { pvSyncDeck(); await decide(status); };
    add('✕ Delete', 'decide trash', decideHere('trash'));
    add('✓ Keep', 'decide keep', decideHere('kept'));
  } else if (p.status === 'trash') {
    add('Restore', 'keep', () => setStatus(p, 'kept'));
    add('Back to To review', '', () => setStatus(p, 'pending'));
    add(NATIVE ? 'Delete from phone now' : 'Delete forever', 'trash', async () => {
      if (await removeForever([p.id])) deletedToast(`Deleted ${itemWord(1, [p])}`);
      else toast('Not deleted');
    });
  } else if (p.status === 'pending') {
    add('✕ Delete', 'decide trash', async () => { await setStatus(p, 'trash'); bumpToday(1); });
    add('✓ Keep', 'decide keep', async () => { await setStatus(p, 'kept'); bumpToday(1); });
  } else {
    add('Move to Deleted', 'trash', () => setStatus(p, 'trash'));
    add('Back to To review', '', () => setStatus(p, 'pending'));
  }
}

function closeViewer() {
  const viewer = $('viewer');
  if (viewer.classList.contains('hidden')) return;
  pvSyncDeck();   // closing from the swipe view lands on the photo you were looking at
  viewer.classList.add('hidden');
  viewer.style.backgroundColor = '';
  $('pvStage').style.transform = '';
  pv.token = null; pv.p = null;
  if (!pv.fromSwipe) pv.cache?.forEach((u) => Promise.resolve(u).then((x) => { if (x?.startsWith('blob:')) URL.revokeObjectURL(x); }));
  pv.cache = new Map();
  const vid = $('viewerVideo');
  vid.pause(); vid.removeAttribute('src'); vid.load();
  $('viewerImg').removeAttribute('src');
  pv.urls.forEach((u) => URL.revokeObjectURL(u));
  pv.urls = [];
}

/* ---------- Reminders ---------- */

// Native app: a real daily local notification.
// One notification per day for the next REMINDER_DAYS days. Re-planned every time
// the app opens, so today's is skipped once the goal is done, and the text
// says how many are waiting. (A plain repeating reminder can't do either.)
const REMINDER_DAYS = 21;
const reminderIds = () => [REMINDER_ID, ...Array.from({ length: REMINDER_DAYS }, (_, i) => REMINDER_ID + 1 + i)];

async function cancelNativeReminders() {
  await Notify.cancel({ notifications: reminderIds().map((id) => ({ id })) }).catch(() => {});
  await Lib.cancelBusyCheck().catch(() => {});
}

function reminderText(isToday) {
  const waiting = byStatus('pending').length;
  const left = Math.max(0, settings.dailyGoal - (isToday ? todayCount() : 0));
  if (!waiting) return 'Time to clean up — new photos are waiting to be reviewed.';
  if (waiting <= left) return `${waiting.toLocaleString()} ${waiting === 1 ? 'photo' : 'photos'} left to review — finish them off today.`;
  return `Swipe through ${left || settings.dailyGoal} photos today · ${waiting.toLocaleString()} waiting to review.`;
}

// ask = may show the permission prompt. Returns true if reminders are scheduled.
async function scheduleNativeReminder({ ask = true } = {}) {
  let perm = await Notify.checkPermissions().catch(() => ({ display: 'denied' }));
  if (perm.display !== 'granted' && ask) perm = await Notify.requestPermissions();
  if (perm.display !== 'granted') {
    if (ask) toast('Notifications are off — allow them in Settings');
    return false;
  }
  await cancelNativeReminders();
  const [hour, minute] = settings.reminderTime.split(':').map(Number);
  if (settings.reminderMode === 'busy') {
    // The phone itself checks at this time each day and only notifies on busy days.
    await Lib.scheduleBusyCheck({ hour, minute, threshold: settings.busyThreshold });
    return true;
  }
  const now = new Date();
  const goalDone = todayCount() >= settings.dailyGoal;
  const list = [];
  for (let i = 0; i < REMINDER_DAYS; i++) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hour, minute, 0, 0);
    if (at <= now || (i === 0 && goalDone)) continue;
    list.push({
      id: REMINDER_ID + 1 + i,
      title: 'Swipe Clean 🧹',
      body: reminderText(i === 0),
      schedule: { at, allowWhileIdle: true },
      // A daily nudge doesn't need to-the-second timing; without this, Android
      // asks for the extra "Alarms & reminders" permission.
      isExactNotification: false,
    });
  }
  if (list.length) await Notify.schedule({ notifications: list });
  return true;
}

// Keep the planned reminders fresh (quietly — never shows a prompt).
async function refreshNativeReminders() {
  if (!NATIVE || !settings.reminderOn) return;
  settings.reminderOn = await scheduleNativeReminder({ ask: false }).catch(() => settings.reminderOn);
  saveSettings();
  updateReminderButton();
}

// Website: a repeating calendar event (works without notifications support).
function downloadReminder() {
  const [hh, mm] = settings.reminderTime.split(':').map(Number);
  const start = new Date();
  start.setHours(hh, mm, 0, 0);
  if (start < new Date()) start.setDate(start.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
  const end = new Date(start.getTime() + 15 * 60 * 1000);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const url = location.href.split('#')[0];
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SwipeClean//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:swipeclean-daily-${Date.now()}@swipeclean`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${local(start)}`,
    `DTEND:${local(end)}`,
    'RRULE:FREQ=DAILY',
    `SUMMARY:🧹 Swipe Clean: review ${settings.dailyGoal} photos`,
    `DESCRIPTION:Time for today's photo cleanup. Open Swipe Clean: ${url}`,
    `URL:${url}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Swipe Clean reminder', 'TRIGGER:PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'swipe-clean-reminder.ics';
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Open the file and tap “Add” to set your daily reminder');
}

async function onReminderButton() {
  settings.reminderTime = $('setTime').value || settings.reminderTime;
  if (NATIVE) {
    settings.reminderMode = $('setMode').value === 'busy' ? 'busy' : 'daily';
    settings.busyThreshold = Math.max(1, parseInt($('setBusy').value, 10) || DEFAULTS.busyThreshold);
    settings.reminderOn = await scheduleNativeReminder();
    saveSettings();
    updateReminderButton();
    if (settings.reminderOn) {
      toast(settings.reminderMode === 'busy'
        ? `At ${settings.reminderTime} you'll be reminded only if you took ${settings.busyThreshold}+ photos`
        : `Daily reminder set for ${settings.reminderTime}`);
    }
  } else {
    saveSettings();
    downloadReminder();
  }
}

function updateReminderButton() {
  if (!NATIVE) return;
  $('reminderBtn').textContent = settings.reminderOn ? '🔔 Reminder is on — tap to update' : '🔔 Turn on reminder';
  $('reminderNote').textContent = reminderNoteText(settings.reminderMode, settings.busyThreshold);
}

function reminderNoteText(mode, n) {
  return mode === 'busy'
    ? `At this time each day the app counts the photos you took in the last 24 hours and only notifies you if there are ${n} or more.${IOS ? ' iPhone decides exactly when the app may check, so it can come a bit later than this time.' : ''}`
    : 'A notification at this time every day (skipped once you’ve hit your daily goal).';
}

// Website extra nudge: a notification when the app is opened later in the day.
function maybeNotify() {
  if (NATIVE || !('Notification' in window) || Notification.permission !== 'granted') return;
  const [hh, mm] = settings.reminderTime.split(':').map(Number);
  const now = new Date();
  const due = new Date(); due.setHours(hh, mm, 0, 0);
  const key = `notified-${dayKey()}`;
  if (now >= due && todayCount() < settings.dailyGoal && byStatus('pending').length && !localStorage.getItem(key)) {
    localStorage.setItem(key, '1');
    navigator.serviceWorker?.ready.then((reg) =>
      reg.showNotification('Swipe Clean', {
        body: `${settings.dailyGoal - todayCount()} photos left for today's goal.`,
        icon: 'icons/icon-192.png', tag: 'daily',
      })
    ).catch(() => {});
  }
}

/* ---------- Settings sheet ---------- */

function openSettings() {
  $('setGoal').value = settings.dailyGoal;
  $('setDays').value = settings.retentionDays;
  $('setTime').value = settings.reminderTime;
  $('setMode').value = settings.reminderMode;
  $('setBusy').value = settings.busyThreshold;
  showModeFields();
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  $('statsBox').innerHTML = `
    <div class="stat"><b>${total}</b><span>reviewed all-time</span></div>
    <div class="stat"><b>${streak()}</b><span>day streak</span></div>
    <div class="stat"><b>${fmtBytes(freed()) || '0 MB'}</b><span>space freed</span></div>`;
  $('notifyBtn').classList.toggle('hidden', NATIVE || !('Notification' in window) || Notification.permission !== 'default');
  updateReminderButton();
  $('settings').classList.remove('hidden');
}

function showModeFields() {
  const busy = $('setMode').value === 'busy';
  $('busyField').classList.toggle('hidden', !busy);
  $('timeLabel').textContent = busy ? 'Check at this time' : 'Daily reminder time';
  if (NATIVE) $('reminderNote').textContent = reminderNoteText($('setMode').value, parseInt($('setBusy').value, 10) || DEFAULTS.busyThreshold);
}

async function saveSettingsForm(e) {
  e.preventDefault();
  const oldTime = settings.reminderTime, oldGoal = settings.dailyGoal;
  const oldMode = settings.reminderMode, oldBusy = settings.busyThreshold;
  if (NATIVE) {
    settings.reminderMode = $('setMode').value === 'busy' ? 'busy' : 'daily';
    settings.busyThreshold = Math.max(1, parseInt($('setBusy').value, 10) || DEFAULTS.busyThreshold);
  }
  const modeChanged = oldMode !== settings.reminderMode || oldBusy !== settings.busyThreshold;
  settings.dailyGoal = Math.max(1, parseInt($('setGoal').value, 10) || DEFAULTS.dailyGoal);
  settings.retentionDays = Math.max(0, parseInt($('setDays').value, 10) || 0);
  settings.reminderTime = $('setTime').value || DEFAULTS.reminderTime;
  saveSettings();
  if (NATIVE && (modeChanged || (settings.reminderOn && (oldTime !== settings.reminderTime || oldGoal !== settings.dailyGoal)))) {
    settings.reminderOn = await scheduleNativeReminder({ ask: true }).catch(() => settings.reminderOn);
    saveSettings();
  }
  $('settings').classList.add('hidden');
  render();
  const n = await purgeExpired({ force: true });
  render();
  toast(n ? `Saved · ${plural(n, 'expired photo')} deleted` : 'Saved');
}

/* ---------- Share & install ---------- */

async function shareApp() {
  const url = NATIVE ? SITE_URL : location.href.split('#')[0];
  const data = { title: 'Swipe Clean', text: 'Clean up your photo library by swiping — right to keep, left to delete.', url };
  try {
    if (navigator.share) await navigator.share(data);
    else { await navigator.clipboard.writeText(url); toast('Link copied — send it to anyone'); }
  } catch { /* user cancelled */ }
}

let installEvent = null;
function setupInstallHint() {
  if (NATIVE) return;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone || localStorage.getItem('installDismissed')) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (/android/i.test(navigator.userAgent)) {
    // The Android app reads the whole library and really deletes photos.
    $('installText').innerHTML = '<a href="SwipeClean.apk" download>Get the Android app</a> — it deletes photos from your phone';
    $('installBtn').classList.add('hidden');
    $('installHint').classList.remove('hidden');
    return;
  }
  if (ios) {
    $('installText').innerHTML = 'Install: tap <b>Share</b> → <b>Add to Home Screen</b>';
    $('installBtn').classList.add('hidden');
    $('installHint').classList.remove('hidden');
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    $('installText').textContent = 'Install Swipe Clean on your home screen';
    $('installBtn').classList.remove('hidden');
    $('installHint').classList.remove('hidden');
  });
}

/* ---------- Toast ---------- */

let toastTimer;
function toast(msg, action) {
  const t = $('toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { t.classList.add('hidden'); action.fn(); };
    t.append(b);
  }
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), action ? 6000 : 3200);
}

// iPhone: deleted items sit in Photos' "Recently Deleted" for 30 days. Apps can't
// empty it, so offer a shortcut to the Photos app.
async function openPhotosApp() {
  let opened = false;
  try { ({ opened } = await Lib.openPhotosApp()); } catch { /* ignore */ }
  if (!opened) toast('Open Photos → Collections → Utilities → Recently Deleted');
}
function deletedToast(msg) {
  toast(msg, IOS ? { label: 'Empty in Photos', fn: openPhotosApp } : null);
}

/* ---------- Wire up ---------- */

function bind() {
  setupEdgeBack();
  setupTabSwipe();
  $('addBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async (e) => { await importFiles(e.target.files); e.target.value = ''; };
  $('startBtn').onclick = () => openSwiper();
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

  $('grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const p = photos.find((x) => x.id === cell.dataset.id);
    if (!p) return;
    if (sel.suppressClick) { sel.suppressClick = false; return; }
    if (sel.on) { toggleSelected(p.id); return; }
    if (view) openViewer(p);
    else if (p.status === 'pending') openSwiper(p.id);
    else openViewer(p);
  });

  $('swiperClose').onclick = () => closeSwiper();
  $('btnKeep').onclick = () => decide('kept');
  $('btnTrash').onclick = () => decide('trash');
  $('btnUndo').onclick = undo;
  window.addEventListener('popstate', () => closeSwiper(true));
  document.addEventListener('keydown', (e) => {
    if ($('swiper').classList.contains('hidden')) return;
    if (e.key === 'ArrowRight') decide('kept');
    else if (e.key === 'ArrowLeft') decide('trash');
    else if (e.key === 'Escape') closeSwiper();
    else if ((e.metaKey || e.ctrlKey) && e.key === 'z') undo();
  });

  setupViewerGestures();
  setupSelection();
  setupFindAndShare();
  setupComputers();

  $('restoreAllBtn').onclick = async () => {
    const list = byStatus('trash');
    for (const p of list) await setStatus(p, 'kept');
    render();
    toast(`Restored ${itemWord(list.length, list)}`);
  };
  $('emptyTrashBtn').onclick = async () => {
    const list = byStatus('trash');
    const ids = list.map((p) => p.id);
    if (!ids.length) return;
    if (!NATIVE && !confirm(`Remove ${itemWord(ids.length, list)} for good? This can't be undone.`)) return;
    const ok = await removeForever(ids);
    render();
    if (ok) deletedToast(`Deleted ${itemWord(ids.length, list)}`); else toast('Not deleted');
  };
  $('expiredBtn').onclick = async () => {
    const n = await purgeExpired({ force: true });
    render();
    if (n) deletedToast(`Deleted ${plural(n, 'item')} from your phone`);
  };

  $('settingsBtn').onclick = openSettings;
  $('settingsClose').onclick = () => $('settings').classList.add('hidden');
  $('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('settings').classList.add('hidden'); });
  $('settingsForm').onsubmit = saveSettingsForm;
  $('reminderBtn').onclick = onReminderButton;
  $('setMode').onchange = showModeFields;
  $('setBusy').oninput = showModeFields;
  // iPhone: tapping the styled time field didn't open the time wheel. Open it ourselves.
  $('setTime').addEventListener('click', (e) => {
    try { e.currentTarget.showPicker?.(); } catch { /* not supported: focus is enough */ }
  });
  $('notifyBtn').onclick = async () => {
    const r = await Notification.requestPermission();
    $('notifyBtn').classList.add('hidden');
    toast(r === 'granted' ? 'Notifications on' : 'Notifications blocked');
  };
  $('resetBtn').onclick = async () => {
    const msg = NATIVE
      ? 'Reset all progress? Every photo goes back to To review. Nothing is deleted from your phone.'
      : 'Remove all photos and progress from Swipe Clean? (Your phone\'s photo library is not touched.)';
    if (!confirm(msg)) return;
    await db.deletePhotos((await db.getAllMeta()).map((r) => r.id));
    localStorage.clear();
    if (NATIVE) await cancelNativeReminders();
    location.reload();
  };

  $('shareBtn').onclick = shareApp;
  $('openPhotosBtn').onclick = openPhotosApp;
  $('installBtn').onclick = async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    $('installHint').classList.add('hidden');
  };
  $('installDismiss').onclick = () => { localStorage.setItem('installDismissed', '1'); $('installHint').classList.add('hidden'); };

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (NATIVE && $('swiper').classList.contains('hidden')) {
      await syncNativeLibrary();   // pick up new photos / ones deleted elsewhere
      render();
    }
    if (await purgeExpired()) render(); else renderCounts();
    maybeNotify();
    refreshNativeReminders();
  });
}

// Phone completely full: say why progress isn't saved, and point at what frees space fastest.
function showFullBanner() {
  if (!NATIVE) return;
  $('fullText').innerHTML = IOS
    ? '<b>Your iPhone is full.</b> Swipe Clean can’t save your progress until there’s a little space. Delete a few big videos, then empty <b>Recently Deleted</b> in Photos to free the space.'
    : '<b>Your phone is full.</b> Swipe Clean can’t save your progress until there’s a little space. Delete a few big videos first.';
  $('fullBar').classList.remove('hidden');
}

function setupSort() {
  $('fullBtn').onclick = () => {
    settings.sortOrder = 'largest';
    saveSettings();
    setTab('pending');
    renderGrid();
  };
  const sel = $('sortSelect');
  sel.innerHTML = Object.entries(SORTS).map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  sel.onchange = () => {
    settings.sortOrder = sel.value;
    saveSettings();
    if (settings.sortOrder === 'random') randKeys.clear();
    renderGrid();
    $('gridWrap').scrollIntoView({ block: 'nearest' });
  };
  $('shuffleBtn').onclick = () => { randKeys.clear(); renderGrid(); };
}

async function init() {
  bind();
  setupSort();
  setupInstallHint();
  if (NATIVE) {
    document.body.classList.add('native');
    $('resetBtn').textContent = 'Reset progress (photos are not deleted)';
    $('daysNote').textContent = Cap.getPlatform?.() === 'ios'
      ? 'After this, they\'re deleted from your iPhone (iOS keeps them in Recently Deleted for 30 more days). 0 = delete right away.'
      : 'After this, they\'re deleted from your phone. 0 = delete right away.';
    try { ({ status: access } = await Lib.requestAccess()); } catch (e) { console.error('PhotoLibrary.requestAccess failed:', e?.code, e?.message || e); access = 'denied'; }
    if (access === 'granted' || access === 'limited') { await syncNativeLibrary(); refreshStorage(); refreshPeople(); }
  } else {
    photos = await db.getAllMeta();
  }
  render();
  const purged = await purgeExpired();
  render();
  if (purged) deletedToast(`${plural(purged, 'item')} passed ${settings.retentionDays} days in Deleted and ${purged === 1 ? 'was' : 'were'} removed`);
  else if (byStatus('pending').length && todayCount() < settings.dailyGoal && todayCount() > 0) {
    toast(`${settings.dailyGoal - todayCount()} left for today's goal`);
  }
  maybeNotify();
  if (!db.storageOk()) showFullBanner();
  if (NATIVE) {
    // Daily reminder is on by default: ask for notifications once, on first launch.
    if (!settings.reminderAsked) {
      settings.reminderAsked = true;
      settings.reminderOn = await scheduleNativeReminder({ ask: true }).catch(() => false);
      saveSettings();
      updateReminderButton();
      if (settings.reminderOn) toast(`Daily reminder on at ${settings.reminderTime} · change it in ⚙︎`);
    } else {
      refreshNativeReminders();
    }
  }
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Android Back button: close whatever is open, step back to "To review",
// and only then let the app close. Returns true if it handled the press.
window.swipeCleanBack = () => {
  if (!$('viewer').classList.contains('hidden')) { closeViewer(); return true; }
  if (sel.on) { setSelecting(false); return true; }
  if (view) { closeView(); return true; }
  if (!$('settings').classList.contains('hidden')) { $('settings').classList.add('hidden'); return true; }
  if (!$('swiper').classList.contains('hidden')) { closeSwiper(); return true; }
  if (tab !== 'pending') { setTab('pending'); return true; }
  return false;
};

// Exposed for testing/debugging in the console
window.swipeClean = { importFiles, purgeExpired, settings, render, get photos() { return photos; } };

init();
