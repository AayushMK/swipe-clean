package com.aayushmk.swipeclean;

import android.Manifest;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
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

/** Reads the real photo library and deletes photos from it. JS name: PhotoLibrary */
@CapacitorPlugin(
    name = "PhotoLibrary",
    permissions = {
        @Permission(alias = "photos", strings = { Manifest.permission.READ_MEDIA_IMAGES }),
        @Permission(alias = "photosLegacy", strings = {
            Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE
        })
    }
)
public class PhotoLibraryPlugin extends Plugin {
    private static final Uri IMAGES = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
    private ActivityResultLauncher<IntentSenderRequest> deleteLauncher;
    private PluginCall pendingDelete;

    @Override
    public void load() {
        deleteLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            result -> {
                if (pendingDelete == null) return;
                JSObject ret = new JSObject();
                ret.put("deleted", result.getResultCode() == android.app.Activity.RESULT_OK);
                pendingDelete.resolve(ret);
                pendingDelete = null;
            }
        );
        deleteDir(new File(getContext().getCacheDir(), "photo-cache/full"));
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
            String[] cols = {
                MediaStore.Images.Media._ID, MediaStore.Images.Media.DATE_TAKEN,
                MediaStore.Images.Media.DATE_ADDED, MediaStore.Images.Media.WIDTH, MediaStore.Images.Media.HEIGHT
            };
            try (Cursor c = getContext().getContentResolver().query(IMAGES, cols, null, null,
                    MediaStore.Images.Media.DATE_ADDED + " DESC")) {
                if (c != null) {
                    while (c.moveToNext()) {
                        long taken = c.getLong(1);
                        if (taken == 0) taken = c.getLong(2) * 1000L;
                        JSObject o = new JSObject();
                        o.put("id", String.valueOf(c.getLong(0)));
                        o.put("taken", taken);
                        o.put("width", c.getInt(3));
                        o.put("height", c.getInt(4));
                        items.put(o);
                    }
                }
            } catch (Exception e) {
                call.reject("Could not read photos", e);
                return;
            }
            JSObject ret = new JSObject();
            ret.put("photos", items);
            call.resolve(ret);
        });
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
                    Uri uri = ContentUris.withAppendedId(IMAGES, Long.parseLong(id));
                    Bitmap bmp = load(uri, size);
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

    private Bitmap load(Uri uri, int size) throws Exception {
        ContentResolver r = getContext().getContentResolver();
        if (Build.VERSION.SDK_INT >= 29) {
            return r.loadThumbnail(uri, new Size(size, size), null);
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

    /** Deletes photos. On Android 11+ the system shows its own confirmation. */
    @PluginMethod
    public void deletePhotos(PluginCall call) {
        JSArray ids = call.getArray("ids", new JSArray());
        List<Uri> uris = new ArrayList<>();
        try {
            for (int i = 0; i < ids.length(); i++) {
                uris.add(ContentUris.withAppendedId(IMAGES, Long.parseLong(ids.getString(i))));
            }
        } catch (Exception e) {
            call.reject("Bad ids", e);
            return;
        }
        if (uris.isEmpty()) { JSObject ok = new JSObject(); ok.put("deleted", true); call.resolve(ok); return; }

        if (Build.VERSION.SDK_INT >= 30) {
            PendingIntent pi = MediaStore.createDeleteRequest(getContext().getContentResolver(), uris);
            pendingDelete = call;
            deleteLauncher.launch(new IntentSenderRequest.Builder(pi.getIntentSender()).build());
        } else {
            getBridge().execute(() -> {
                ContentResolver r = getContext().getContentResolver();
                boolean ok = true;
                for (Uri u : uris) {
                    try { r.delete(u, null, null); } catch (Exception e) { ok = false; }
                }
                JSObject ret = new JSObject();
                ret.put("deleted", ok);
                call.resolve(ret);
            });
        }
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
