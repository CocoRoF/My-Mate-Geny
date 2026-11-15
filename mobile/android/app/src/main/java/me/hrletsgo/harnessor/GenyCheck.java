package me.hrletsgo.harnessor;

import android.content.Context;
import android.util.Log;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

/**
 * Her calls and messages with the app closed, without a line held open (docs/mate-calls.md "On Android"): the phone
 * checks in now and then — a minute and five minutes after the app goes away, then every 15 minutes (Android may wait
 * longer while the phone sleeps) — for a few seconds each (GenyCheckWorker): what the mates said that nobody has seen
 * shows as their messages, and if she would call now, the phone rings like a call. Nothing runs in between, and
 * nothing of the app stays in the shade.
 */
final class GenyCheck {

    private static final String TAG = "GenyCheck";
    static final String PERIODIC = "geny-check";
    static final String SOON_1 = "geny-check-1m";
    static final String SOON_5 = "geny-check-5m";
    /** the server's time at the last check: what the mates said after it is news */
    static final String K_SINCE = "notice_since";
    /** when the last check ended (ms) and how: ok · offline · signed_out */
    static final String K_LAST = "check_last";
    static final String K_RESULT = "check_result";

    private GenyCheck() {}

    private static Constraints online() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    private static WorkManager wm(Context c) {
        return WorkManager.getInstance(c.getApplicationContext());
    }

    /** every 15 minutes while the app is signed in to a server it remembers (WorkManager keeps it across reboots) */
    static void schedule(Context c) {
        try {
            if (!GenyLink.ready(c)) {
                wm(c).cancelUniqueWork(PERIODIC);
                return;
            }
            PeriodicWorkRequest r = new PeriodicWorkRequest.Builder(GenyCheckWorker.class, 15, TimeUnit.MINUTES)
                    .setConstraints(online())
                    .build();
            wm(c).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, r);
        } catch (Exception e) {
            Log.w(TAG, "could not schedule: " + e);
        }
    }

    /** the app went away (closed, another app, the screen off): soon after — her answer on its way, a reply to what was
     *  just said — then the usual 15 minutes */
    static void soon(Context c) {
        if (!GenyLink.ready(c)) return;
        try {
            wm(c).enqueueUniqueWork(SOON_1, ExistingWorkPolicy.REPLACE, new OneTimeWorkRequest.Builder(GenyCheckWorker.class)
                    .setInitialDelay(1, TimeUnit.MINUTES).setConstraints(online()).build());
            wm(c).enqueueUniqueWork(SOON_5, ExistingWorkPolicy.REPLACE, new OneTimeWorkRequest.Builder(GenyCheckWorker.class)
                    .setInitialDelay(5, TimeUnit.MINUTES).setConstraints(online()).build());
        } catch (Exception e) {
            Log.w(TAG, "could not schedule: " + e);
        }
    }

    /** the app is in front again: the page has it all */
    static void back(Context c) {
        try {
            wm(c).cancelUniqueWork(SOON_1);
            wm(c).cancelUniqueWork(SOON_5);
        } catch (Exception ignored) {
            // nothing scheduled
        }
    }

    /** signed out, or another server: no more checks, and nothing of the old one kept */
    static void cancel(Context c) {
        try {
            wm(c).cancelUniqueWork(PERIODIC);
            back(c);
        } catch (Exception ignored) {
            // nothing scheduled
        }
        GenyLink.prefs(c).edit().remove(K_SINCE).remove(K_LAST).remove(K_RESULT).apply();
    }
}
