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

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

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
                if (video) o.put("duration", c.getLong(6) / 1000.0);
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
                        bmp.compress(Bitmap.CompressFormat.JPEG, thumb ? 75 : 88, out);
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
