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

const DEFAULTS = { dailyGoal: 100, retentionDays: 10, reminderTime: '20:00', reminderOn: false };
const DAY = 24 * 60 * 60 * 1000;

const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('settings') || '{}') };
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
  const v = list ? list.every(isVideo) : false;
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
const addFreed = (n) => localStorage.setItem('freedBytes', String(freed() + (n || 0)));

function forget(ids) {
  ids.forEach((id) => {
    const u = thumbUrls.get(id);
    if (u?.startsWith('blob:')) URL.revokeObjectURL(u);
    thumbUrls.delete(id);
  });
}

function sortList(list, status) {
  if (status === 'trash') return list.sort((a, b) => b.trashedAt - a.trashedAt);
  if (status === 'kept') return list.sort((a, b) => b.reviewedAt - a.reviewedAt);
  return list.sort((a, b) => b.taken - a.taken);
}

function daysLeft(p) {
  return Math.max(0, Math.ceil((p.trashedAt + settings.retentionDays * DAY - Date.now()) / DAY));
}

/* ---------- Images (thumbnails + full size) ---------- */

async function nativeImage(id, size) {
  const { path } = await Lib.getImage({ id, size });
  return Cap.convertFileSrc(path);
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
  const now = thumbUrlNow(p);
  if (now || !NATIVE) return now;
  try {
    const u = await nativeImage(p.id, 360);
    thumbUrls.set(p.id, u);
    return u;
  } catch { return null; }
}

async function loadFull(p) {
  if (NATIVE) {
    if (isVideo(p)) {
      try {
        const { path } = await Lib.getVideo({ id: p.id });
        return Cap.convertFileSrc(path);
      } catch { return null; }
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
      kind: a.type === 'video' ? 'video' : 'image', duration: a.duration, size: a.size,
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
let gridList = [], gridShown = 0;
const thumbObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      const p = photos.find((x) => x.id === e.target.dataset.id);
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
  img.alt = ''; img.decoding = 'async';
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
  gridList = sortList(byStatus(tab), tab);
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

  $('trashBar').classList.toggle('hidden', tab !== 'trash' || !gridList.length);
  $('photosTrashHint').classList.toggle('hidden', !IOS || tab !== 'trash');
  $('trashInfo').textContent = NATIVE
    ? `Deleted from your phone after ${plural(settings.retentionDays, 'day')}`
    : `Removed for good after ${plural(settings.retentionDays, 'day')}`;
}

function render() { renderCounts(); renderGrid(); }

function setTab(t) {
  tab = t;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  render();
  window.scrollTo({ top: 0 });
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
  return [fmtDate(p.taken), isVideo(p) ? fmtDuration(p.duration) : '', fmtBytes(p.size)].filter(Boolean).join(' · ');
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
  if (!v) return;
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
  attachDrag(card);
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

function attachDrag(card) {
  let x0 = 0, y0 = 0, dx = 0, dy = 0, t0 = 0;
  let mode = null;   // decided after a few px: 'side' (keep/delete) or 'down' (back to grid)
  const keepStamp = card.querySelector('.stamp.keep');
  const trashStamp = card.querySelector('.stamp.trash');
  const swiperEl = $('swiper');

  onDrag(card, {
    start: (p, e) => {
      if (edgeBack.active || e.__edge) return false;
      mode = null; x0 = p.x; y0 = p.y; dx = dy = 0; t0 = performance.now();
      card.style.transition = 'none';
    },
    move: (p) => {
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

let viewerUrl = null;
async function openViewer(p) {
  const img = $('viewerImg'), vid = $('viewerVideo');
  img.src = thumbUrlNow(p) || '';
  img.classList.remove('hidden');
  vid.classList.add('hidden');
  $('viewer').classList.remove('hidden');
  viewerUrl = await loadFull(p);
  if (viewerUrl && isVideo(p)) {
    vid.poster = thumbUrlNow(p) || '';
    vid.src = viewerUrl;
    vid.classList.remove('hidden');
    img.classList.add('hidden');
  } else if (viewerUrl) img.src = viewerUrl;
  const extra = p.status === 'trash'
    ? ` · deleted ${fmtDate(p.trashedAt)} · ${plural(daysLeft(p), 'day')} left`
    : ` · kept ${fmtDate(p.reviewedAt)}`;
  $('viewerMeta').textContent = `${p.name ? p.name + ' · ' : ''}${infoText(p)}${extra}`;

  const actions = $('viewerActions');
  actions.textContent = '';
  const add = (label, cls, fn) => {
    const b = document.createElement('button');
    b.textContent = label; b.className = cls;
    b.onclick = async () => { await fn(); closeViewer(); render(); };
    actions.append(b);
  };
  if (p.status === 'trash') {
    add('↩︎ Restore (keep it)', 'keep', () => setStatus(p, 'kept'));
    add('Put back in To review', '', () => setStatus(p, 'pending'));
    add(NATIVE ? 'Delete from phone now' : 'Delete forever now', 'trash', async () => {
      if (await removeForever([p.id])) deletedToast(`Deleted ${itemWord(1, [p])}`);
      else toast('Not deleted');
    });
  } else {
    add('Move to Deleted', 'trash', () => setStatus(p, 'trash'));
    add('Put back in To review', '', () => setStatus(p, 'pending'));
  }
  add('Close', '', async () => {});
  $('viewer').classList.remove('hidden');
}
function closeViewer() {
  $('viewer').classList.add('hidden');
  const vid = $('viewerVideo');
  vid.pause(); vid.removeAttribute('src'); vid.load();
  if (viewerUrl?.startsWith('blob:')) URL.revokeObjectURL(viewerUrl);
  viewerUrl = null;
}

/* ---------- Reminders ---------- */

// Native app: a real daily local notification.
async function scheduleNativeReminder() {
  const perm = await Notify.requestPermissions();
  if (perm.display !== 'granted') {
    toast('Notifications are off — allow them in Settings');
    return false;
  }
  const [hour, minute] = settings.reminderTime.split(':').map(Number);
  await Notify.cancel({ notifications: [{ id: REMINDER_ID }] }).catch(() => {});
  await Notify.schedule({
    notifications: [{
      id: REMINDER_ID,
      title: 'Swipe Clean 🧹',
      body: `Time for today's cleanup — review ${settings.dailyGoal} photos.`,
      schedule: { on: { hour, minute }, allowWhileIdle: true },
    }],
  });
  return true;
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
    settings.reminderOn = await scheduleNativeReminder();
    saveSettings();
    updateReminderButton();
    if (settings.reminderOn) toast(`Daily reminder set for ${settings.reminderTime}`);
  } else {
    saveSettings();
    downloadReminder();
  }
}

function updateReminderButton() {
  if (!NATIVE) return;
  $('reminderBtn').textContent = settings.reminderOn ? '🔔 Daily reminder is on — tap to update' : '🔔 Turn on daily reminder';
  $('reminderNote').textContent = 'A notification at this time every day. Change the time and tap the button to update it.';
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
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  $('statsBox').innerHTML = `
    <div class="stat"><b>${total}</b><span>reviewed all-time</span></div>
    <div class="stat"><b>${streak()}</b><span>day streak</span></div>
    <div class="stat"><b>${fmtBytes(freed()) || '0 MB'}</b><span>space freed</span></div>`;
  $('notifyBtn').classList.toggle('hidden', NATIVE || !('Notification' in window) || Notification.permission !== 'default');
  updateReminderButton();
  $('settings').classList.remove('hidden');
}

async function saveSettingsForm(e) {
  e.preventDefault();
  const oldTime = settings.reminderTime, oldGoal = settings.dailyGoal;
  settings.dailyGoal = Math.max(1, parseInt($('setGoal').value, 10) || DEFAULTS.dailyGoal);
  settings.retentionDays = Math.max(0, parseInt($('setDays').value, 10) || 0);
  settings.reminderTime = $('setTime').value || DEFAULTS.reminderTime;
  saveSettings();
  if (NATIVE && settings.reminderOn && (oldTime !== settings.reminderTime || oldGoal !== settings.dailyGoal)) {
    await scheduleNativeReminder().catch(() => {});
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
  $('addBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async (e) => { await importFiles(e.target.files); e.target.value = ''; };
  $('startBtn').onclick = () => openSwiper();
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

  $('grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const p = photos.find((x) => x.id === cell.dataset.id);
    if (!p) return;
    if (p.status === 'pending') openSwiper(p.id);
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

  $('viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') closeViewer(); });

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
    if (NATIVE) await Notify.cancel({ notifications: [{ id: REMINDER_ID }] }).catch(() => {});
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
  });
}

async function init() {
  bind();
  setupInstallHint();
  if (NATIVE) {
    document.body.classList.add('native');
    $('resetBtn').textContent = 'Reset progress (photos are not deleted)';
    $('daysNote').textContent = Cap.getPlatform?.() === 'ios'
      ? 'After this, they\'re deleted from your iPhone (iOS keeps them in Recently Deleted for 30 more days). 0 = delete right away.'
      : 'After this, they\'re deleted from your phone. 0 = delete right away.';
    try { ({ status: access } = await Lib.requestAccess()); } catch (e) { console.error('PhotoLibrary.requestAccess failed:', e?.code, e?.message || e); access = 'denied'; }
    if (access === 'granted' || access === 'limited') await syncNativeLibrary();
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
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for testing/debugging in the console
window.swipeClean = { importFiles, purgeExpired, settings, render, get photos() { return photos; } };

init();
