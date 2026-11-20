import * as db from './db.js';

/* ---------- Settings & daily stats (localStorage) ---------- */

const DEFAULTS = { dailyGoal: 100, retentionDays: 10, reminderTime: '20:00' };
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

let photos = [];                // all metadata records
let tab = 'pending';
const thumbUrls = new Map();    // id -> object URL

const $ = (id) => document.getElementById(id);
const byStatus = (s) => photos.filter((p) => p.status === s);

function thumbUrl(p) {
  if (!p.thumb) return null;
  if (!thumbUrls.has(p.id)) thumbUrls.set(p.id, URL.createObjectURL(p.thumb));
  return thumbUrls.get(p.id);
}
function forget(ids) {
  ids.forEach((id) => {
    const u = thumbUrls.get(id);
    if (u) URL.revokeObjectURL(u);
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

/* ---------- Auto-delete expired items ---------- */

async function purgeExpired() {
  const cutoff = Date.now() - settings.retentionDays * DAY;
  const expired = photos.filter((p) => p.status === 'trash' && p.trashedAt <= cutoff).map((p) => p.id);
  if (!expired.length) return 0;
  await db.deletePhotos(expired);
  forget(expired);
  photos = photos.filter((p) => !expired.includes(p.id));
  return expired.length;
}

/* ---------- Import ---------- */

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
  const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif)$/i.test(f.name));
  if (!files.length) return;
  $('importing').classList.remove('hidden');
  let added = 0, skipped = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      $('importText').textContent = `Adding photos… ${i + 1} / ${files.length}`;
      const sig = `${f.name}|${f.size}|${f.lastModified}`;
      if (await db.hasSig(sig)) { skipped++; continue; }
      let thumb = null;
      try { thumb = await makeThumb(f); } catch { /* unsupported format: still importable */ }
      const meta = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sig, name: f.name, size: f.size, type: f.type,
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
  if (added || skipped) toast(`Added ${added} photo${added === 1 ? '' : 's'}${skipped ? ` · ${skipped} already here` : ''}`);
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
    : pending === 0 ? 'Add photos to start cleaning'
    : `${Math.min(goal - done, pending)} to go${s ? ` · 🔥 ${s}-day streak` : ''}`;
  $('startBtn').disabled = pending === 0;
}

function renderGrid() {
  const list = sortList(byStatus(tab), tab);
  const grid = $('grid');
  grid.textContent = '';
  const frag = document.createDocumentFragment();
  for (const p of list) {
    const cell = document.createElement('button');
    cell.className = 'cell';
    cell.dataset.id = p.id;
    const url = thumbUrl(p);
    if (url) {
      const img = document.createElement('img');
      img.src = url; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
      cell.append(img);
    } else {
      const d = document.createElement('div');
      d.className = 'noimg'; d.textContent = p.name;
      cell.append(d);
    }
    if (tab === 'trash') {
      const left = daysLeft(p);
      const b = document.createElement('span');
      b.className = 'badge' + (left <= 1 ? ' soon' : '');
      b.textContent = left === 0 ? 'today' : `${left}d left`;
      cell.append(b);
    }
    frag.append(cell);
  }
  grid.append(frag);

  const empty = $('empty');
  empty.classList.toggle('hidden', list.length > 0);
  if (!list.length) {
    empty.innerHTML =
      tab === 'pending'
        ? (photos.length
          ? `<div class="big">✨</div><h3>All caught up</h3><p>Nothing left to review. Add more photos whenever you're ready.</p>`
          : `<div class="big">📷</div><h3>Let's clean up your photos</h3><p>Pick a batch from your library. Then swipe right to keep, left to delete.</p><button class="primary small" id="emptyAdd">Choose photos</button>`)
      : tab === 'kept'
        ? `<div class="big">💚</div><h3>No kept photos yet</h3><p>Photos you swipe right on show up here.</p>`
        : `<div class="big">🗑️</div><h3>Deleted is empty</h3><p>Photos you swipe left on wait here for ${settings.retentionDays} days so you can restore them.</p>`;
    $('emptyAdd')?.addEventListener('click', () => $('fileInput').click());
  }

  $('trashBar').classList.toggle('hidden', tab !== 'trash' || !list.length);
  $('trashInfo').textContent = `Removed for good after ${settings.retentionDays} day${settings.retentionDays === 1 ? '' : 's'}`;
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
  await db.putMeta(p);
}

/* ---------- Swipe view ---------- */

const swipe = { queue: [], index: 0, history: [], urls: new Map(), goalCelebrated: false };

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
  document.body.style.overflow = '';
  swipe.urls.forEach((u) => URL.revokeObjectURL(u));
  swipe.urls.clear();
  $('deck').textContent = '';
  if (!fromPop && history.state?.swiper) history.back();
  render();
}

async function fullUrl(p) {
  if (swipe.urls.has(p.id)) return swipe.urls.get(p.id);
  const blob = await db.getBlob(p.id);
  const url = blob ? URL.createObjectURL(blob) : thumbUrl(p);
  swipe.urls.set(p.id, url);
  return url;
}

function fmtDate(ms) {
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

async function buildCard(p, isTop) {
  const card = document.createElement('div');
  card.className = 'card' + (isTop ? '' : ' back');
  card.dataset.id = p.id;
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.src = thumbUrl(p) || '';           // instant low-res, then swap to full
  card.append(img);
  card.insertAdjacentHTML('beforeend',
    `<div class="stamp keep">KEEP</div><div class="stamp trash">DELETE</div>
     <div class="info">${fmtDate(p.taken)}</div>`);
  fullUrl(p).then((u) => { if (u) img.src = u; });
  return card;
}

async function renderDeck() {
  const deck = $('deck');
  deck.textContent = '';
  updateSwiperBar();

  if (swipe.index >= swipe.queue.length) {
    const goalDone = todayCount() >= settings.dailyGoal;
    deck.innerHTML = `<div class="card-done">
      <div><div class="big">${goalDone ? '🎉' : '✨'}</div>
      <h3>${goalDone ? 'Daily goal done!' : 'All caught up'}</h3>
      <p>${byStatus('trash').length} photo(s) waiting in Deleted · restore any within ${settings.retentionDays} days.</p>
      <button class="primary small" id="doneBack">Back to photos</button></div></div>`;
    $('doneBack').onclick = () => closeSwiper();
    return;
  }

  const top = swipe.queue[swipe.index];
  const next = swipe.queue[swipe.index + 1];
  if (next) deck.append(await buildCard(next, false));
  const card = await buildCard(top, true);
  deck.append(card);
  attachDrag(card);
  // warm the cache for the one after
  const after = swipe.queue[swipe.index + 2];
  if (after) fullUrl(after);
}

function attachDrag(card) {
  let x0 = 0, y0 = 0, dx = 0, dy = 0, t0 = 0, active = false;
  const keepStamp = card.querySelector('.stamp.keep');
  const trashStamp = card.querySelector('.stamp.trash');

  card.addEventListener('pointerdown', (e) => {
    active = true; x0 = e.clientX; y0 = e.clientY; dx = dy = 0; t0 = performance.now();
    card.setPointerCapture(e.pointerId);
    card.style.transition = 'none';
  });
  card.addEventListener('pointermove', (e) => {
    if (!active) return;
    dx = e.clientX - x0; dy = e.clientY - y0;
    card.style.transform = `translate(${dx}px, ${dy * 0.4}px) rotate(${dx / 18}deg)`;
    keepStamp.style.opacity = Math.max(0, Math.min(1, dx / 90));
    trashStamp.style.opacity = Math.max(0, Math.min(1, -dx / 90));
  });
  const end = () => {
    if (!active) return;
    active = false;
    const v = dx / Math.max(1, performance.now() - t0); // px per ms
    const threshold = Math.min(120, card.offsetWidth * 0.28);
    if (dx > threshold || (v > 0.5 && dx > 30)) decide('kept');
    else if (dx < -threshold || (v < -0.5 && dx < -30)) decide('trash');
    else {
      card.style.transition = 'transform .25s cubic-bezier(.2,.9,.3,1.2)';
      card.style.transform = '';
      keepStamp.style.opacity = trashStamp.style.opacity = 0;
    }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

let deciding = false;
async function decide(status) {
  if (deciding || swipe.index >= swipe.queue.length) return;
  deciding = true;
  const p = swipe.queue[swipe.index];
  const card = $('deck').querySelector(`.card[data-id="${p.id}"]:not(.back)`);
  if (card) {
    const dir = status === 'kept' ? 1 : -1;
    card.querySelector(`.stamp.${status === 'kept' ? 'keep' : 'trash'}`).style.opacity = 1;
    card.style.transition = 'transform .3s ease-in, opacity .3s';
    card.style.transform = `translate(${dir * window.innerWidth * 1.2}px, 40px) rotate(${dir * 28}deg)`;
    card.style.opacity = '0';
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
  await renderDeck();
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
  await renderDeck();
}

/* ---------- Viewer for kept / deleted photos ---------- */

let viewerUrl = null;
async function openViewer(p) {
  const blob = await db.getBlob(p.id);
  viewerUrl = blob ? URL.createObjectURL(blob) : null;
  $('viewerImg').src = viewerUrl || thumbUrl(p) || '';
  const extra = p.status === 'trash'
    ? ` · deleted ${fmtDate(p.trashedAt)} · ${daysLeft(p)} day(s) left`
    : ` · kept ${fmtDate(p.reviewedAt)}`;
  $('viewerMeta').textContent = `${p.name} · ${fmtDate(p.taken)}${extra}`;

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
    add('Delete forever now', 'trash', async () => {
      await db.deletePhotos([p.id]); forget([p.id]);
      photos = photos.filter((x) => x.id !== p.id);
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
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = null;
}

/* ---------- Reminders ---------- */

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

// Extra nudge where the platform allows: a notification when the app is
// opened/resumed later in the day and the goal isn't done yet.
function maybeNotify() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
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
    <div class="stat"><b>${byStatus('trash').length}</b><span>in Deleted</span></div>`;
  $('notifyBtn').classList.toggle('hidden', !('Notification' in window) || Notification.permission !== 'default');
  $('settings').classList.remove('hidden');
}

async function saveSettingsForm(e) {
  e.preventDefault();
  settings.dailyGoal = Math.max(1, parseInt($('setGoal').value, 10) || DEFAULTS.dailyGoal);
  settings.retentionDays = Math.max(0, parseInt($('setDays').value, 10) || 0);
  settings.reminderTime = $('setTime').value || DEFAULTS.reminderTime;
  saveSettings();
  $('settings').classList.add('hidden');
  const n = await purgeExpired();
  render();
  toast(n ? `Saved · ${n} expired photo(s) removed` : 'Saved');
}

/* ---------- Share & install ---------- */

async function shareApp() {
  const url = location.href.split('#')[0];
  const data = { title: 'Swipe Clean', text: 'Clean up your photo library by swiping — right to keep, left to delete.', url };
  try {
    if (navigator.share) await navigator.share(data);
    else { await navigator.clipboard.writeText(url); toast('Link copied — send it to anyone'); }
  } catch { /* user cancelled */ }
}

let installEvent = null;
function setupInstallHint() {
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
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

/* ---------- Wire up ---------- */

function bind() {
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
    list.forEach((p) => { p.status = 'kept'; p.trashedAt = 0; p.reviewedAt = Date.now(); });
    await db.putManyMeta(list);
    render();
    toast(`Restored ${list.length} photo(s)`);
  };
  $('emptyTrashBtn').onclick = async () => {
    const ids = byStatus('trash').map((p) => p.id);
    if (!ids.length || !confirm(`Remove ${ids.length} photo(s) for good? This can't be undone.`)) return;
    await db.deletePhotos(ids); forget(ids);
    photos = photos.filter((p) => !ids.includes(p.id));
    render();
  };

  $('settingsBtn').onclick = openSettings;
  $('settingsClose').onclick = () => $('settings').classList.add('hidden');
  $('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('settings').classList.add('hidden'); });
  $('settingsForm').onsubmit = saveSettingsForm;
  $('reminderBtn').onclick = () => { settings.reminderTime = $('setTime').value || settings.reminderTime; saveSettings(); downloadReminder(); };
  $('notifyBtn').onclick = async () => {
    const r = await Notification.requestPermission();
    $('notifyBtn').classList.add('hidden');
    toast(r === 'granted' ? 'Notifications on' : 'Notifications blocked');
  };
  $('resetBtn').onclick = async () => {
    if (!confirm('Remove all photos and progress from Swipe Clean? (Your phone\'s photo library is not touched.)')) return;
    await db.deletePhotos(photos.map((p) => p.id));
    forget(photos.map((p) => p.id));
    photos = [];
    localStorage.clear();
    location.reload();
  };

  $('shareBtn').onclick = shareApp;
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
    if (await purgeExpired()) render(); else renderCounts();
    maybeNotify();
  });
}

async function init() {
  bind();
  setupInstallHint();
  photos = await db.getAllMeta();
  const purged = await purgeExpired();
  render();
  if (purged) toast(`${purged} photo(s) passed ${settings.retentionDays} days in Deleted and were removed`);
  else if (byStatus('pending').length && todayCount() < settings.dailyGoal && todayCount() > 0) {
    toast(`${settings.dailyGoal - todayCount()} left for today's goal`);
  }
  maybeNotify();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for testing/debugging in the console
window.swipeClean = { importFiles, purgeExpired, settings, render, get photos() { return photos; } };

init();
