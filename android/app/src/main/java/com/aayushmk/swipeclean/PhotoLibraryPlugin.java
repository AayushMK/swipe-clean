package com.aayushmk.swipeclean;

import android.Manifest;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Size;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import android.content.ClipData;
import android.graphics.Color;

import androidx.core.content.FileProvider;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Reads the real photo library (photos + videos) and deletes items from it. JS name: PhotoLibrary
 * Ids: photos are the MediaStore id ("123"), videos are prefixed ("v123").
 */
@CapacitorPlugin(
    name = "PhotoLibrary",
    permissions = {
        @Permission(alias = "photos", strings = {
            Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO
        }),
        @Permission(alias = "photosLegacy", strings = {
            Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE
        })
    }
)
public class PhotoLibraryPlugin extends Plugin {
    private static final Uri IMAGES = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
    private static final Uri VIDEOS = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
    private ActivityResultLauncher<IntentSenderRequest> deleteLauncher;
    private PluginCall pendingDelete;
    private long pendingBytes;

    @Override
    public void load() {
        deleteLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            result -> {
                if (pendingDelete == null) return;
                boolean ok = result.getResultCode() == android.app.Activity.RESULT_OK;
                JSObject ret = new JSObject();
                ret.put("deleted", ok);
                ret.put("bytes", ok ? pendingBytes : 0);
                pendingDelete.resolve(ret);
                pendingDelete = null;
            }
        );
        deleteDir(new File(getContext().getCacheDir(), "photo-cache/full"));
    }

    private static boolean isVideo(String id) { return id.startsWith("v"); }

    private static Uri uriFor(String id) {
        return isVideo(id)
            ? ContentUris.withAppendedId(VIDEOS, Long.parseLong(id.substring(1)))
            : ContentUris.withAppendedId(IMAGES, Long.parseLong(id));
    }

    private String alias() {
        return Build.VERSION.SDK_INT >= 33 ? "photos" : "photosLegacy";
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (getPermissionState(alias()) == PermissionState.GRANTED) {
            resolveStatus(call);
        } else {
            requestPermissionForAlias(alias(), call, "accessCallback");
        }
    }

    @PermissionCallback
    private void accessCallback(PluginCall call) {
        resolveStatus(call);
    }

    private void resolveStatus(PluginCall call) {
        PermissionState s = getPermissionState(alias());
        JSObject ret = new JSObject();
        ret.put("status", s == PermissionState.GRANTED ? "granted" : s == PermissionState.DENIED ? "denied" : "prompt");
        call.resolve(ret);
    }

    @PluginMethod
    public void getPhotos(PluginCall call) {
        getBridge().execute(() -> {
            JSArray items = new JSArray();
            try {
                addItems(items, IMAGES, false);
                addItems(items, VIDEOS, true);
            } catch (Exception e) {
                call.reject("Could not read photos", e);
                return;
            }
            JSObject ret = new JSObject();
            ret.put("photos", items);
            call.resolve(ret);
        });
    }

    private void addItems(JSArray items, Uri collection, boolean video) {
        List<String> cols = new ArrayList<>();
        cols.add(MediaStore.MediaColumns._ID);
        cols.add(MediaStore.MediaColumns.DATE_TAKEN);
        cols.add(MediaStore.MediaColumns.DATE_ADDED);
        cols.add(MediaStore.MediaColumns.WIDTH);
        cols.add(MediaStore.MediaColumns.HEIGHT);
        cols.add(MediaStore.MediaColumns.SIZE);
        cols.add(MediaStore.MediaColumns.DISPLAY_NAME);
        cols.add("bucket_display_name");   // folder, e.g. "Screenshots"
        if (video) cols.add(MediaStore.Video.VideoColumns.DURATION);
        try (Cursor c = getContext().getContentResolver().query(collection, cols.toArray(new String[0]), null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                long taken = c.getLong(1);
                if (taken == 0) taken = c.getLong(2) * 1000L;
                JSObject o = new JSObject();
                o.put("id", (video ? "v" : "") + c.getLong(0));
                o.put("taken", taken);
                o.put("width", c.getInt(3));
                o.put("height", c.getInt(4));
                o.put("size", c.getLong(5));
                o.put("type", video ? "video" : "image");
                String where = (c.getString(6) + " " + c.getString(7)).toLowerCase();
                if (where.contains("screenshot") || where.contains("screen record") || where.contains("screenrecord")) {
                    o.put("screenshot", true);
                }
                if (video) o.put("duration", c.getLong(8) / 1000.0);
                items.put(o);
            }
        }
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("id is required"); return; }
        JSObject ret = new JSObject();
        ret.put("size", sizeOf(uriFor(id)));
        call.resolve(ret);
    }

    private long sizeOf(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { MediaStore.MediaColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getLong(0);
        } catch (Exception ignored) { }
        return 0;
    }

    @PluginMethod
    public void getImage(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("id is required"); return; }
        int size = Math.max(64, call.getInt("size", 400));
        boolean thumb = size <= 600;
        getBridge().execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "photo-cache/" + (thumb ? "thumbs" : "full"));
                dir.mkdirs();
                File file = new File(dir, id + "_" + size + ".jpg");
                if (!file.exists()) {
                    Bitmap bmp = load(id, size);
                    if (bmp == null) { call.reject("Could not load photo"); return; }
                    try (FileOutputStream out = new FileOutputStream(file)) {
                        // Detail view (4096 px) gets near-lossless quality.
                        bmp.compress(Bitmap.CompressFormat.JPEG, thumb ? 75 : (size > 2048 ? 95 : 90), out);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("path", Uri.fromFile(file).toString());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Could not load photo", e);
            }
        });
    }

    private Bitmap load(String id, int size) throws Exception {
        ContentResolver r = getContext().getContentResolver();
        Uri uri = uriFor(id);
        if (Build.VERSION.SDK_INT >= 29) {
            return r.loadThumbnail(uri, new Size(size, size), null);
        }
        if (isVideo(id)) {
            MediaMetadataRetriever mmr = new MediaMetadataRetriever();
            try {
                mmr.setDataSource(getContext(), uri);
                return mmr.getFrameAtTime(0);
            } finally {
                mmr.release();
            }
        }
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream in = r.openInputStream(uri)) { BitmapFactory.decodeStream(in, null, bounds); }
        int sample = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= size) sample *= 2;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        try (InputStream in = r.openInputStream(uri)) { return BitmapFactory.decodeStream(in, null, opts); }
    }

    /** Returns a content:// URL the web view can play (via Capacitor.convertFileSrc). */
    @PluginMethod
    public void getVideo(PluginCall call) {
        String id = call.getString("id");
        if (id == null || !isVideo(id)) { call.reject("Video not found"); return; }
        JSObject ret = new JSObject();
        ret.put("path", uriFor(id).toString());
        call.resolve(ret);
    }

    /** Deletes items. On Android 11+ the system shows its own confirmation. */
    @PluginMethod
    public void deletePhotos(PluginCall call) {
        JSArray ids = call.getArray("ids", new JSArray());
        List<Uri> uris = new ArrayList<>();
        try {
            for (int i = 0; i < ids.length(); i++) uris.add(uriFor(ids.getString(i)));
        } catch (Exception e) {
            call.reject("Bad ids", e);
            return;
        }
        if (uris.isEmpty()) {
            JSObject ok = new JSObject();
            ok.put("deleted", true);
            ok.put("bytes", 0);
            call.resolve(ok);
            return;
        }
        long bytes = 0;
        for (Uri u : uris) bytes += sizeOf(u);

        if (Build.VERSION.SDK_INT >= 30) {
            PendingIntent pi = MediaStore.createDeleteRequest(getContext().getContentResolver(), uris);
            pendingDelete = call;
            pendingBytes = bytes;
            deleteLauncher.launch(new IntentSenderRequest.Builder(pi.getIntentSender()).build());
        } else {
            final long total = bytes;
            getBridge().execute(() -> {
                ContentResolver r = getContext().getContentResolver();
                boolean ok = true;
                for (Uri u : uris) {
                    try { r.delete(u, null, null); } catch (Exception e) { ok = false; }
                }
                JSObject ret = new JSObject();
                ret.put("deleted", ok);
                ret.put("bytes", ok ? total : 0);
                call.resolve(ret);
            });
        }
    }

    /** Total size of photos and videos, plus the phone's storage. */
    @PluginMethod
    public void getStorageInfo(PluginCall call) {
        getBridge().execute(() -> {
            long[] photos = sumSizes(IMAGES), videos = sumSizes(VIDEOS);
            android.os.StatFs fs = new android.os.StatFs(android.os.Environment.getDataDirectory().getPath());
            JSObject ret = new JSObject();
            ret.put("photoBytes", photos[0]);
            ret.put("photoCount", photos[1]);
            ret.put("videoBytes", videos[0]);
            ret.put("videoCount", videos[1]);
            ret.put("totalBytes", fs.getTotalBytes());
            ret.put("freeBytes", fs.getAvailableBytes());
            call.resolve(ret);
        });
    }

    private long[] sumSizes(Uri collection) {
        long bytes = 0, count = 0;
        try (Cursor c = getContext().getContentResolver().query(collection, new String[] { MediaStore.MediaColumns.SIZE }, null, null, null)) {
            if (c != null) while (c.moveToNext()) { bytes += c.getLong(0); count++; }
        } catch (Exception ignored) { }
        return new long[] { bytes, count };
    }

    /** "Only on busy days" reminder: check at hour:minute each day, notify if threshold+ new items. */
    @PluginMethod
    public void scheduleBusyCheck(PluginCall call) {
        BusyCheckReceiver.schedule(getContext(), call.getInt("hour", 20), call.getInt("minute", 0), call.getInt("threshold", 30));
        call.resolve();
    }

    @PluginMethod
    public void cancelBusyCheck(PluginCall call) {
        BusyCheckReceiver.cancel(getContext());
        call.resolve();
    }

    // ---------- Sharing originals ----------

    /** Shares the original gallery files (no copies), or one .zip of them (sent as a document). */
    @PluginMethod
    public void shareItems(PluginCall call) {
        JSArray ids = call.getArray("ids", new JSArray());
        boolean zip = Boolean.TRUE.equals(call.getBoolean("zip", false));
        List<String> list = new ArrayList<>();
        try { for (int i = 0; i < ids.length(); i++) list.add(ids.getString(i)); } catch (Exception e) { call.reject("Bad ids"); return; }
        if (list.isEmpty()) { call.reject("Nothing to share"); return; }
        getBridge().execute(() -> {
            try {
                ArrayList<Uri> uris = new ArrayList<>();
                String type;
                File shareDir = new File(getContext().getCacheDir(), "share");
                cleanOldShares(shareDir);
                if (zip) {
                    shareDir.mkdirs();
                    File out = new File(shareDir, "Swipe Clean photos.zip");
                    writeZip(list, out);
                    uris.add(FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", out));
                    type = "application/zip";
                } else {
                    boolean anyVideo = false, anyImage = false;
                    for (String id : list) { uris.add(uriFor(id)); if (isVideo(id)) anyVideo = true; else anyImage = true; }
                    type = anyVideo && anyImage ? "*/*" : anyVideo ? "video/*" : "image/*";
                }
                Intent send = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE);
                send.setType(type);
                if (uris.size() == 1) send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
                else send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                ClipData clip = ClipData.newRawUri("", uris.get(0));
                for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
                send.setClipData(clip);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(send, null);
                getActivity().runOnUiThread(() -> {
                    getActivity().startActivity(chooser);
                    JSObject ret = new JSObject();
                    ret.put("completed", true);
                    call.resolve(ret);
                });
            } catch (Exception e) {
                call.reject("Could not share", e);
            }
        });
    }

    private String displayName(Uri uri, String fallback) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (Exception ignored) { }
        return fallback;
    }

    private void writeZip(List<String> ids, File out) throws Exception {
        Set<String> taken = new HashSet<>();
        try (ZipOutputStream zos = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(out)))) {
            zos.setLevel(0);   // photos are already compressed: store them as they are
            byte[] buf = new byte[64 * 1024];
            for (String id : ids) {
                Uri uri = uriFor(id);
                String name = displayName(uri, id + (isVideo(id) ? ".mp4" : ".jpg"));
                String base = name, ext = "";
                int dot = name.lastIndexOf('.');
                if (dot > 0) { base = name.substring(0, dot); ext = name.substring(dot); }
                for (int n = 2; taken.contains(name.toLowerCase()); n++) name = base + " (" + n + ")" + ext;
                taken.add(name.toLowerCase());
                try (InputStream in = new BufferedInputStream(getContext().getContentResolver().openInputStream(uri))) {
                    zos.putNextEntry(new ZipEntry("Swipe Clean photos/" + name));
                    int r;
                    while ((r = in.read(buf)) > 0) zos.write(buf, 0, r);
                    zos.closeEntry();
                }
            }
        }
    }

    // The receiving app reads the zip after we hand it over, so old ones are removed next time.
    private static void cleanOldShares(File dir) {
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) if (System.currentTimeMillis() - f.lastModified() > 3600_000L) f.delete();
    }

    // ---------- Similar photos ----------
    // Phase 1 on Android: a small fingerprint per photo (shape hash + colour layout).
    // Finds near-duplicates, bursts and same-scene photos. People needs the face model (phase 2).

    private static final Map<String, long[]> prints = new HashMap<>();   // id -> [dHash, colour bytes packed in 6 longs]
    private static boolean indexLoaded = false, indexing = false;
    private final List<PluginCall> indexWaiters = new ArrayList<>();

    private File indexFile() { return new File(getContext().getFilesDir(), "similarity-index.bin"); }

    private void loadIndex() {
        synchronized (prints) {
            if (indexLoaded) return;
            indexLoaded = true;
            File f = indexFile();
            if (!f.exists()) return;
            try (DataInputStream in = new DataInputStream(new BufferedInputStream(new FileInputStream(f)))) {
                int n = in.readInt();
                for (int i = 0; i < n; i++) {
                    String id = in.readUTF();
                    long[] v = new long[7];
                    for (int k = 0; k < 7; k++) v[k] = in.readLong();
                    prints.put(id, v);
                }
            } catch (Exception ignored) { }
        }
    }

    private void saveIndex() {
        synchronized (prints) {
            try (DataOutputStream out = new DataOutputStream(new BufferedOutputStream(new FileOutputStream(indexFile())))) {
                out.writeInt(prints.size());
                for (Map.Entry<String, long[]> e : prints.entrySet()) {
                    out.writeUTF(e.getKey());
                    for (long x : e.getValue()) out.writeLong(x);
                }
            } catch (Exception ignored) { }
        }
    }

    private long[] fingerprint(String id) {
        try {
            Bitmap small = load(id, 96);
            if (small == null) return null;
            Bitmap g = Bitmap.createScaledBitmap(small, 9, 8, true);
            long hash = 0;
            int bit = 0;
            for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
                if (lum(g.getPixel(x, y)) > lum(g.getPixel(x + 1, y))) hash |= (1L << bit);
                bit++;
            }
            Bitmap c = Bitmap.createScaledBitmap(small, 4, 4, true);
            long[] v = new long[7];
            v[0] = hash;
            int b = 0;
            for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
                int p = c.getPixel(x, y);
                int[] rgb = { Color.red(p), Color.green(p), Color.blue(p) };
                for (int ch : rgb) { v[1 + b / 8] |= ((long) (ch & 0xff)) << ((b % 8) * 8); b++; }
            }
            return v;
        } catch (Exception e) { return null; }
    }

    private static int lum(int p) { return (Color.red(p) * 299 + Color.green(p) * 587 + Color.blue(p) * 114) / 1000; }

    private static double distance(long[] a, long[] b) {
        double ham = Long.bitCount(a[0] ^ b[0]) / 64.0;
        double sum = 0;
        for (int i = 0; i < 48; i++) {
            int x = (int) ((a[1 + i / 8] >>> ((i % 8) * 8)) & 0xff), y = (int) ((b[1 + i / 8] >>> ((i % 8) * 8)) & 0xff);
            sum += (x - y) * (x - y);
        }
        double colour = Math.sqrt(sum / 48) / 255.0;
        return ham * 0.6 + colour * 0.8;
    }

    private List<String> allIds() {
        List<String> ids = new ArrayList<>();
        String[] col = { MediaStore.MediaColumns._ID };
        try (Cursor c = getContext().getContentResolver().query(IMAGES, col, null, null, MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
            if (c != null) while (c.moveToNext()) ids.add(String.valueOf(c.getLong(0)));
        }
        try (Cursor c = getContext().getContentResolver().query(VIDEOS, col, null, null, MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
            if (c != null) while (c.moveToNext()) ids.add("v" + c.getLong(0));
        }
        return ids;
    }

    @PluginMethod
    public void indexLibrary(PluginCall call) {
        synchronized (indexWaiters) {
            indexWaiters.add(call);
            if (indexing) return;
            indexing = true;
        }
        new Thread(() -> {
            loadIndex();
            List<String> ids = allIds();
            Set<String> live = new HashSet<>(ids);
            synchronized (prints) { prints.keySet().retainAll(live); }
            int total = ids.size(), done = 0;
            for (String id : ids) {
                boolean have;
                synchronized (prints) { have = prints.containsKey(id); }
                if (!have) {
                    long[] v = fingerprint(id);
                    if (v != null) synchronized (prints) { prints.put(id, v); }
                }
                done++;
                if (done % 25 == 0) progress(done, total);
                if (done % 500 == 0) saveIndex();
            }
            saveIndex();
            progress(total, total);
            List<PluginCall> ws;
            synchronized (indexWaiters) { indexing = false; ws = new ArrayList<>(indexWaiters); indexWaiters.clear(); }
            JSObject st = statusObj(total);
            for (PluginCall w : ws) w.resolve(st);
        }, "swipeclean-index").start();
    }

    private void progress(int done, int total) {
        JSObject p = new JSObject();
        p.put("done", done);
        p.put("total", total);
        notifyListeners("indexProgress", p);
    }

    private JSObject statusObj(int total) {
        JSObject st = new JSObject();
        synchronized (prints) { st.put("indexed", Math.min(prints.size(), total)); }
        st.put("total", total);
        st.put("faces", 0);
        st.put("running", indexing);
        return st;
    }

    @PluginMethod
    public void indexStatus(PluginCall call) {
        getBridge().execute(() -> { loadIndex(); call.resolve(statusObj(allIds().size())); });
    }

    @PluginMethod
    public void findSimilar(PluginCall call) {
        String id = call.getString("id");
        int limit = call.getInt("limit", 80);
        if (id == null) { call.reject("id is required"); return; }
        getBridge().execute(() -> {
            loadIndex();
            long[] q;
            synchronized (prints) { q = prints.get(id); }
            if (q == null) { q = fingerprint(id); if (q != null) synchronized (prints) { prints.put(id, q); } }
            JSArray matches = new JSArray();
            if (q != null) {
                List<Object[]> all = new ArrayList<>();
                synchronized (prints) {
                    for (Map.Entry<String, long[]> e : prints.entrySet()) {
                        if (!e.getKey().equals(id)) all.add(new Object[] { e.getKey(), distance(q, e.getValue()) });
                    }
                }
                all.sort((a, b) -> Double.compare((double) a[1], (double) b[1]));
                for (int i = 0; i < Math.min(limit, all.size()); i++) {
                    JSObject m = new JSObject();
                    m.put("id", all.get(i)[0]);
                    m.put("d", all.get(i)[1]);
                    matches.put(m);
                }
            }
            JSObject ret = new JSObject();
            ret.put("matches", matches);
            call.resolve(ret);
        });
    }

    /** Duplicates and near-duplicates, compared with neighbours in date order. Best copy first. */
    @PluginMethod
    public void findDuplicates(PluginCall call) {
        double maxD = call.getDouble("maxDistance", 0.2);
        getBridge().execute(() -> {
            loadIndex();
            List<String> ordered = new ArrayList<>();
            Map<String, long[]> snap;
            synchronized (prints) { snap = new HashMap<>(prints); }
            for (String id : allIds()) if (snap.containsKey(id)) ordered.add(id);
            int n = ordered.size(), window = 40;
            int[] parent = new int[n];
            for (int i = 0; i < n; i++) parent[i] = i;
            for (int i = 0; i < n; i++) {
                long[] a = snap.get(ordered.get(i));
                for (int j = i + 1; j < Math.min(n, i + window); j++) {
                    if (isVideo(ordered.get(i)) != isVideo(ordered.get(j))) continue;
                    if (distance(a, snap.get(ordered.get(j))) <= maxD) parent[root(parent, j)] = root(parent, i);
                }
            }
            Map<Integer, List<String>> groups = new HashMap<>();
            for (int i = 0; i < n; i++) groups.computeIfAbsent(root(parent, i), k -> new ArrayList<>()).add(ordered.get(i));
            JSArray out = new JSArray();
            for (List<String> g : groups.values()) {
                if (g.size() < 2) continue;
                // best copy first: most pixels, then biggest file
                g.sort((x, y) -> {
                    long[] mx = meta(x), my = meta(y);
                    if (mx[0] != my[0]) return Long.compare(my[0], mx[0]);
                    return Long.compare(my[1], mx[1]);
                });
                JSObject o = new JSObject();
                o.put("ids", new JSArray(g));
                out.put(o);
            }
            JSObject ret = new JSObject();
            ret.put("groups", out);
            call.resolve(ret);
        });
    }

    private static int root(int[] p, int x) { while (p[x] != x) { p[x] = p[p[x]]; x = p[x]; } return x; }

    /** [pixels, bytes] for ranking copies. */
    private long[] meta(String id) {
        try (Cursor c = getContext().getContentResolver().query(uriFor(id),
                new String[] { MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT, MediaStore.MediaColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) return new long[] { (long) c.getInt(0) * c.getInt(1), c.getLong(2) };
        } catch (Exception ignored) { }
        return new long[] { 0, 0 };
    }

    /** People needs the face model (phase 2); Android returns none for now. */
    @PluginMethod
    public void getPeople(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("people", new JSArray());
        call.resolve(ret);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", getContext().getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    private static void deleteDir(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteDir(k);
        f.delete();
    }
}
