package me.hrletsgo.harnessor;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;

/**
 * Her alarms with the app closed (docs/mate-calls.md "Alarms"): she phones at the time they set with her, but a closed app
 * only checks in every 15 minutes or so. So the server hands the app the moments to be awake (``wakes``: a little before
 * each alarm — the link's hello, a ``wakes`` message, the page's GenyCall.setWakes), and the app sets the system's alarm
 * clock for the soonest (exact, allowed while the phone dozes; the alarm icon shows, as for any alarm). It goes off →
 * a check-in at once (WakeReceiver → GenyCheckWorker), which stays on the line for the alarm due, and she rings it like
 * any call. Kept across reboots (BootReceiver), the past ones dropped.
 */
final class GenyWakes {

    private static final String TAG = "GenyWakes";
    static final String K_WAKES = "alarm_wakes";
    static final String NOW = "geny-check-wake";
    /** a wake further ahead than this isn't set (the next hello hands it again) */
    private static final long AHEAD_MAX_MS = 26L * 60 * 60 * 1000;

    private GenyWakes() {}

    /** the server's list (ISO times): kept, and the soonest set */
    static void set(Context c, JSONArray isoTimes) {
        if (isoTimes == null) return;
        List<Long> at = new ArrayList<>();
        long now = System.currentTimeMillis();
        for (int i = 0; i < isoTimes.length(); i++) {
            long t = when(isoTimes.optString(i, ""));
            if (t > now && t - now < AHEAD_MAX_MS) at.add(t);
        }
        Collections.sort(at);
        StringBuilder b = new StringBuilder();
        for (Long t : at) b.append(b.length() == 0 ? "" : ",").append(t);
        GenyLink.prefs(c).edit().putString(K_WAKES, b.toString()).apply();
        arm(c);
    }

    /** the soonest wake still ahead → the system's alarm (none: cancelled) */
    static void arm(Context c) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = intent(c);
        long next = next(c);
        try {
            if (next <= 0) {
                am.cancel(pi);
                return;
            }
            boolean exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms();
            if (exact) {
                // (an alarm clock: exact, allowed while dozing, the alarm icon shows like any alarm's)
                am.setAlarmClock(new AlarmManager.AlarmClockInfo(next, openApp(c)), pi);
            } else {
                // (exact alarms not allowed here: as close as Android lets it — a few minutes at most)
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi);
            }
        } catch (Exception e) {
            Log.w(TAG, "could not set: " + e);
        }
    }

    /** it went off: a check-in now (the server holds the line for the alarm due), and the next one set */
    static void fired(Context c) {
        SharedPreferences p = GenyLink.prefs(c);
        long now = System.currentTimeMillis();
        StringBuilder left = new StringBuilder();
        for (String s : p.getString(K_WAKES, "").split(",")) {
            try {
                long t = Long.parseLong(s.trim());
                if (t > now + 5_000) left.append(left.length() == 0 ? "" : ",").append(t);
            } catch (NumberFormatException ignored) {
                // empty
            }
        }
        p.edit().putString(K_WAKES, left.toString()).apply();
        arm(c);
        if (!GenyLink.ready(c) || GenyCallPlugin.front()) return; // (the page in front has her ringing itself)
        try {
            WorkManager.getInstance(c.getApplicationContext()).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE,
                    new OneTimeWorkRequest.Builder(GenyCheckWorker.class)
                            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST).build());
        } catch (Exception e) {
            Log.w(TAG, "could not check in: " + e);
        }
    }

    private static long next(Context c) {
        long now = System.currentTimeMillis();
        for (String s : GenyLink.prefs(c).getString(K_WAKES, "").split(",")) {
            try {
                long t = Long.parseLong(s.trim());
                if (t > now) return t;
            } catch (NumberFormatException ignored) {
                // empty
            }
        }
        return 0;
    }

    private static PendingIntent intent(Context c) {
        Intent i = new Intent(c, WakeReceiver.class).setAction("me.hrletsgo.harnessor.WAKE");
        return PendingIntent.getBroadcast(c, 7, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** what the alarm icon opens: the app */
    private static PendingIntent openApp(Context c) {
        Intent i = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 8, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** an ISO time → ms (0 when unreadable) */
    static long when(String iso) {
        if (iso == null || iso.isEmpty()) return 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                return java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli();
            } catch (Exception ignored) {
                return 0;
            }
        }
        return 0;
    }
}
