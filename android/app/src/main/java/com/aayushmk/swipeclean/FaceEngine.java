package com.aayushmk.swipeclean;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * Face recognition on the phone (OpenCV model zoo models, run with ONNX Runtime):
 *   YuNet finds faces + 5 landmarks → the face is aligned to the standard 112×112 crop →
 *   SFace turns it into 128 numbers. Same person ⇔ the numbers point the same way (cosine).
 */
class FaceEngine {
    static final String TAG = "SwipeCleanFaces";
    private static final int DET = 640;   // detector input (letterboxed square)
    // Standard 112×112 positions of: right eye, left eye, nose tip, right mouth corner, left mouth corner
    private static final float[] TEMPLATE = {
        38.2946f, 51.6963f, 73.5318f, 51.5014f, 56.0252f, 71.7366f, 41.5493f, 92.3655f, 70.7299f, 92.2041f
    };

    static class Face {
        float x, y, w, h, score;
        float[] lm = new float[10];
        float[] embedding;
    }

    private final OrtEnvironment env;
    private final OrtSession det, rec;
    private final String detIn, recIn;

    FaceEngine(Context ctx) throws Exception {
        env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions o = new OrtSession.SessionOptions();
        o.setIntraOpNumThreads(2);
        det = env.createSession(asset(ctx, "models/face_detection_yunet_2023mar.onnx"), o);
        rec = env.createSession(asset(ctx, "models/face_recognition_sface_2021dec_int8.onnx"), o);
        detIn = det.getInputNames().iterator().next();
        recIn = rec.getInputNames().iterator().next();
        Log.i(TAG, "detector in=" + det.getInputInfo() + " out=" + det.getOutputNames());
        Log.i(TAG, "recogniser in=" + rec.getInputInfo() + " out=" + rec.getOutputNames());
    }

    private static byte[] asset(Context ctx, String path) throws Exception {
        try (InputStream in = ctx.getAssets().open(path); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[1 << 16];
            int r;
            while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
            return out.toByteArray();
        }
    }

    /** Faces in a photo (coordinates in the bitmap's pixels), each with its embedding. */
    List<Face> analyze(Bitmap bmp) throws Exception {
        List<Face> faces = detect(bmp);
        for (Face f : faces) f.embedding = embed(bmp, f.lm);
        return faces;
    }

    private List<Face> detect(Bitmap bmp) throws Exception {
        float scale = DET / (float) Math.max(bmp.getWidth(), bmp.getHeight());
        Bitmap canvasBmp = Bitmap.createBitmap(DET, DET, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(canvasBmp);
        c.drawColor(Color.BLACK);
        Matrix m = new Matrix();
        m.setScale(scale, scale);
        c.drawBitmap(bmp, m, new Paint(Paint.FILTER_BITMAP_FLAG));
        int[] px = new int[DET * DET];
        canvasBmp.getPixels(px, 0, DET, 0, 0, DET, DET);
        float[] data = new float[3 * DET * DET];
        int plane = DET * DET;
        for (int i = 0; i < plane; i++) {   // BGR, 0–255, channel-first (what YuNet expects)
            int p = px[i];
            data[i] = p & 0xff;
            data[plane + i] = (p >> 8) & 0xff;
            data[2 * plane + i] = (p >> 16) & 0xff;
        }
        List<Face> found = new ArrayList<>();
        try (OnnxTensor t = OnnxTensor.createTensor(env, FloatBuffer.wrap(data), new long[] { 1, 3, DET, DET });
             OrtSession.Result r = det.run(Collections.singletonMap(detIn, t))) {
            Map<String, float[]> out = new HashMap<>();
            for (Map.Entry<String, ai.onnxruntime.OnnxValue> e : r) out.put(e.getKey(), floats(e.getValue()));
            for (int stride : new int[] { 8, 16, 32 }) {
                float[] cls = out.get("cls_" + stride), obj = out.get("obj_" + stride);
                float[] box = out.get("bbox_" + stride), kps = out.get("kps_" + stride);
                if (cls == null || obj == null || box == null || kps == null) continue;
                int cols = DET / stride, rows = DET / stride;
                for (int row = 0; row < rows; row++) for (int col = 0; col < cols; col++) {
                    int idx = row * cols + col;
                    float score = (float) Math.sqrt(clamp(cls[idx]) * clamp(obj[idx]));
                    if (score < 0.8f) continue;
                    Face f = new Face();
                    float cx = (col + box[idx * 4]) * stride, cy = (row + box[idx * 4 + 1]) * stride;
                    float w = (float) Math.exp(box[idx * 4 + 2]) * stride, h = (float) Math.exp(box[idx * 4 + 3]) * stride;
                    f.x = (cx - w / 2) / scale; f.y = (cy - h / 2) / scale; f.w = w / scale; f.h = h / scale;
                    f.score = score;
                    for (int n = 0; n < 5; n++) {
                        f.lm[2 * n] = (kps[idx * 10 + 2 * n] + col) * stride / scale;
                        f.lm[2 * n + 1] = (kps[idx * 10 + 2 * n + 1] + row) * stride / scale;
                    }
                    found.add(f);
                }
            }
        }
        // keep the best box where boxes overlap; ignore tiny faces (too blurry to recognise)
        found.sort((a, b) -> Float.compare(b.score, a.score));
        List<Face> keep = new ArrayList<>();
        float minSide = Math.max(bmp.getWidth(), bmp.getHeight()) * 0.04f;
        for (Face f : found) {
            if (Math.min(f.w, f.h) < minSide) continue;
            boolean clash = false;
            for (Face k : keep) if (iou(f, k) > 0.3f) { clash = true; break; }
            if (!clash) keep.add(f);
            if (keep.size() >= 20) break;
        }
        return keep;
    }

    /** Align the face on its 5 landmarks to the 112×112 template, then embed with SFace. */
    private float[] embed(Bitmap bmp, float[] lm) throws Exception {
        Bitmap crop = Bitmap.createBitmap(112, 112, Bitmap.Config.ARGB_8888);
        new Canvas(crop).drawBitmap(bmp, similarity(lm, TEMPLATE), new Paint(Paint.FILTER_BITMAP_FLAG));
        int[] px = new int[112 * 112];
        crop.getPixels(px, 0, 112, 0, 0, 112, 112);
        int plane = 112 * 112;
        float[] data = new float[3 * plane];
        for (int i = 0; i < plane; i++) {   // RGB, 0–255, channel-first (what SFace expects)
            int p = px[i];
            data[i] = (p >> 16) & 0xff;
            data[plane + i] = (p >> 8) & 0xff;
            data[2 * plane + i] = p & 0xff;
        }
        try (OnnxTensor t = OnnxTensor.createTensor(env, FloatBuffer.wrap(data), new long[] { 1, 3, 112, 112 });
             OrtSession.Result r = rec.run(Collections.singletonMap(recIn, t))) {
            float[] v = floats(r.get(0));
            double n = 0;
            for (float x : v) n += x * x;
            n = Math.sqrt(n);
            if (n > 0) for (int i = 0; i < v.length; i++) v[i] /= (float) n;
            return v;
        }
    }

    /** Least-squares similarity transform (scale + rotation + shift) taking src points to dst. */
    static Matrix similarity(float[] src, float[] dst) {
        int n = src.length / 2;
        float sx = 0, sy = 0, dx = 0, dy = 0;
        for (int i = 0; i < n; i++) { sx += src[2 * i]; sy += src[2 * i + 1]; dx += dst[2 * i]; dy += dst[2 * i + 1]; }
        sx /= n; sy /= n; dx /= n; dy /= n;
        double num_a = 0, num_b = 0, den = 0;
        for (int i = 0; i < n; i++) {
            double x = src[2 * i] - sx, y = src[2 * i + 1] - sy, u = dst[2 * i] - dx, v = dst[2 * i + 1] - dy;
            num_a += x * u + y * v;
            num_b += x * v - y * u;
            den += x * x + y * y;
        }
        float a = (float) (num_a / den), b = (float) (num_b / den);
        float tx = dx - (a * sx - b * sy), ty = dy - (b * sx + a * sy);
        Matrix m = new Matrix();
        m.setValues(new float[] { a, -b, tx, b, a, ty, 0, 0, 1 });
        return m;
    }

    private static float clamp(float v) { return Math.max(0f, Math.min(1f, v)); }

    private static float iou(Face a, Face b) {
        float x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
        float x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
        float inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        return inter / (a.w * a.h + b.w * b.h - inter + 1e-6f);
    }

    private static float[] floats(ai.onnxruntime.OnnxValue v) {
        FloatBuffer fb = ((OnnxTensor) v).getFloatBuffer();
        float[] out = new float[fb.remaining()];
        fb.get(out);
        return out;
    }
}
