package com.aayushmk.swipeclean;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.util.Calendar;

/**
 * "Only on busy days" reminder: once a day at the chosen time, count the photos and videos
 * added in the last 24 hours and notify only if there are at least `threshold`.
 * Also re-plans itself after the phone restarts.
 */
public class BusyCheckReceiver extends BroadcastReceiver {
    static final String ACTION_CHECK = "com.aayushmk.swipeclean.BUSY_CHECK";
    private static final String PREFS = "busyCheck";
    private static final String CHANNEL = "busy_days";
    private static final int NOTIFICATION_ID = 2001;

    static void schedule(Context ctx, int hour, int minute, int threshold) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("on", true).putInt("hour", hour).putInt("minute", minute).putInt("threshold", threshold)
            .apply();
        planNext(ctx);
    }

    static void cancel(Context ctx) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("on", false).apply();
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(pending(ctx));
    }

    private static PendingIntent pending(Context ctx) {
        Intent i = new Intent(ctx, BusyCheckReceiver.class).setAction(ACTION_CHECK);
        return PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void planNext(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!p.getBoolean("on", false)) return;
        Calendar at = Calendar.getInstance();
        at.set(Calendar.HOUR_OF_DAY, p.getInt("hour", 20));
        at.set(Calendar.MINUTE, p.getInt("minute", 0));
        at.set(Calendar.SECOND, 0);
        at.set(Calendar.MILLISECOND, 0);
        if (at.getTimeInMillis() <= System.currentTimeMillis() + 1000) at.add(Calendar.DAY_OF_YEAR, 1);
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        // Inexact on purpose: no "Alarms & reminders" permission needed.
        if (am != null) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at.getTimeInMillis(), pending(ctx));
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            planNext(ctx);
            return;
        }
        if (!ACTION_CHECK.equals(action)) return;
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!p.getBoolean("on", false)) return;
        int threshold = p.getInt("threshold", 30);
        int count = countRecent(ctx, MediaStore.Images.Media.EXTERNAL_CONTENT_URI)
            + countRecent(ctx, MediaStore.Video.Media.EXTERNAL_CONTENT_URI);
        if (count >= threshold) notifyBusy(ctx, count);
        planNext(ctx);
    }

    /** Items added to the phone in the last 24 hours. */
    private static int countRecent(Context ctx, Uri collection) {
        long since = System.currentTimeMillis() / 1000 - 24 * 3600;
        try (Cursor c = ctx.getContentResolver().query(collection, new String[] { MediaStore.MediaColumns._ID },
                MediaStore.MediaColumns.DATE_ADDED + " >= ?", new String[] { String.valueOf(since) }, null)) {
            return c == null ? 0 : c.getCount();
        } catch (Exception e) {
            return 0;
        }
    }

    private static void notifyBusy(Context ctx, int count) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Busy-day reminders", NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(ctx, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_swipeclean)
            .setColor(0xFF8B7BFF)
            .setContentTitle("Swipe Clean 🧹")
            .setContentText("You took " + count + " photos & videos today — clean them up while you remember them.")
            .setStyle(new NotificationCompat.BigTextStyle()
                .bigText("You took " + count + " photos & videos today — clean them up while you remember them."))
            .setContentIntent(tap)
            .setAutoCancel(true);
        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, b.build());
        } catch (SecurityException ignored) { /* notifications turned off */ }
    }
}
