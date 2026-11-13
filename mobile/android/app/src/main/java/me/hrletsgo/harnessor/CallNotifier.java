package me.hrletsgo.harnessor;

import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Shader;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;
import java.io.File;
import java.io.FileOutputStream;

/**
 * Her calls as the phone shows them (docs/mate-calls.md "On Android"), from the page (GenyCallPlugin) or the background
 * link (GenyLinkService) alike — one ring per call whoever asks first:
 *
 * - her ringing: a call notification (CallStyle: her face and name, 거절 / 받기), the "Calls" channel's ringtone, insistent,
 *   a full-screen intent that brings the app up over the lock screen;
 * - a call she made that nobody took: "부재중 전화", like a phone's;
 * - the link's own notification (quiet: what it is there for) and, during a call, the call's (the clock, 끊기).
 */
final class CallNotifier {

    static final String CH_RING = "geny_calls"; // (made by the first calls build: its sound and vibration stay as they are)
    static final String CH_LINK = "geny_link";
    static final String CH_ONGOING = "geny_call_ongoing";
    static final String CH_MISSED = "geny_calls_missed";
    static final int RING = 0x6e11;
    static final int LINK = 0x6e12;
    static final int MISSED = 0x6e13;

    static final String ACTION_OPEN = "me.hrletsgo.harnessor.CALL_OPEN";
    static final String ACTION_ACCEPT = "me.hrletsgo.harnessor.CALL_ACCEPT";
    static final String ACTION_DECLINE = "me.hrletsgo.harnessor.CALL_DECLINE";
    static final String ACTION_HANGUP = "me.hrletsgo.harnessor.CALL_HANGUP";
    static final String EXTRA_ID = "call_id";
    static final long[] VIBRATION = {0, 700, 500, 700, 1300};

    /** the call ringing on this phone now (its id), or null */
    private static String ringing = null;

    private CallNotifier() {}

    private static NotificationManager nm(Context c) {
        return (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = nm(c);
        if (nm == null) return;
        if (nm.getNotificationChannel(CH_RING) == null) {
            NotificationChannel ch = new NotificationChannel(CH_RING, c.getString(R.string.call_channel_calls), NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription(c.getString(R.string.call_channel_calls_about));
            Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ch.setSound(ring, new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            ch.enableVibration(true);
            ch.setVibrationPattern(VIBRATION);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CH_LINK) == null) {
            NotificationChannel ch = new NotificationChannel(CH_LINK, c.getString(R.string.call_channel_link), NotificationManager.IMPORTANCE_MIN);
            ch.setDescription(c.getString(R.string.call_channel_link_about));
            ch.setShowBadge(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CH_ONGOING) == null) {
            NotificationChannel ch = new NotificationChannel(CH_ONGOING, c.getString(R.string.call_channel_ongoing), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CH_MISSED) == null) {
            NotificationChannel ch = new NotificationChannel(CH_MISSED, c.getString(R.string.call_channel_missed), NotificationManager.IMPORTANCE_DEFAULT);
            nm.createNotificationChannel(ch);
        }
    }

    // ---- taps ----

    /** opens the app (the page hears it as callAction: open · accept) */
    static PendingIntent activity(Context c, String action, String id, int code) {
        Intent i = new Intent(c, MainActivity.class);
        i.setAction(action);
        i.putExtra(EXTRA_ID, id);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** done without opening the app (거절, 끊기): CallActionReceiver tells the server */
    static PendingIntent broadcast(Context c, String action, String id, int code) {
        Intent i = new Intent(c, CallActionReceiver.class);
        i.setAction(action);
        i.putExtra(EXTRA_ID, id);
        return PendingIntent.getBroadcast(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static boolean locked(Context c) {
        KeyguardManager km = (KeyguardManager) c.getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isKeyguardLocked();
    }

    // ---- her face (the page hands it over: GenyCallPlugin.link) ----

    private static File face(Context c, String mateId) {
        String safe = mateId == null ? "" : mateId.replaceAll("[^A-Za-z0-9_-]", "");
        return safe.isEmpty() ? null : new File(new File(c.getFilesDir(), "faces"), safe + ".png");
    }

    /** keep her face (a data: URL of a small picture) for the calls she makes while the page is gone */
    static void keepFace(Context c, String mateId, String dataUrl) {
        File f = face(c, mateId);
        if (f == null || dataUrl == null) return;
        int comma = dataUrl.indexOf(',');
        if (!dataUrl.startsWith("data:image/") || comma < 0) return;
        try {
            byte[] raw = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            if (raw.length == 0 || raw.length > 512 * 1024) return;
            File dir = f.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return;
            try (FileOutputStream o = new FileOutputStream(f)) {
                o.write(raw);
            }
        } catch (Exception ignored) {
            // her name is enough
        }
    }

    /** her face, round (null: none kept) */
    private static Bitmap roundFace(Context c, String mateId) {
        File f = face(c, mateId);
        if (f == null || !f.isFile()) return null;
        try {
            Bitmap src = BitmapFactory.decodeFile(f.getPath());
            if (src == null) return null;
            int s = Math.min(src.getWidth(), src.getHeight());
            Bitmap out = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
            Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
            p.setShader(new BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
            new Canvas(out).drawCircle(s / 2f, s / 2f, s / 2f, p);
            return out;
        } catch (Exception e) {
            return null;
        }
    }

    private static IconCompat round(Context c, String mateId) {
        Bitmap b = roundFace(c, mateId);
        return b == null ? null : IconCompat.createWithBitmap(b);
    }

    private static Person person(Context c, String mateId, String name) {
        Person.Builder b = new Person.Builder().setName(name == null || name.isEmpty() ? c.getString(R.string.call_mate) : name).setImportant(true);
        IconCompat icon = round(c, mateId);
        if (icon != null) b.setIcon(icon);
        return b.build();
    }

    // ---- her ringing ----

    /** ring for call `id` (once: asked again, it is already ringing) → shown */
    static synchronized boolean ring(Context c, String id, String mateId, String name, String body) {
        if (id == null || id.isEmpty()) return false;
        if (id.equals(ringing)) return true;
        NotificationManager nm = nm(c);
        if (nm == null) return false;
        channels(c);
        String who = name == null || name.isEmpty() ? c.getString(R.string.call_mate) : name;
        String text = body == null || body.isEmpty() ? c.getString(R.string.call_ring_text) : body;
        PendingIntent open = activity(c, ACTION_OPEN, id, 1);
        PendingIntent answer = activity(c, ACTION_ACCEPT, id, 4);
        PendingIntent decline = broadcast(c, ACTION_DECLINE, id, 3);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH_RING)
                .setSmallIcon(android.R.drawable.sym_call_incoming)
                .setContentTitle(who)
                .setContentText(text)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(true)
                .setTimeoutAfter(45_000)
                .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
                .setVibrate(VIBRATION)
                .setContentIntent(open)
                .setFullScreenIntent(open, true);
        Notification n;
        try {
            n = b.setStyle(NotificationCompat.CallStyle.forIncomingCall(person(c, mateId, who), decline, answer)).build();
        } catch (Exception e) {
            n = null;
        }
        try {
            if (n == null) throw new IllegalStateException("no call style");
            n.flags |= Notification.FLAG_INSISTENT; // (it rings until answered, like a call)
            nm.notify(RING, n);
        } catch (Exception e) {
            // (a phone that refuses a call-style notification here: the same with plain buttons)
            NotificationCompat.Builder plain = new NotificationCompat.Builder(c, CH_RING)
                    .setSmallIcon(android.R.drawable.sym_call_incoming)
                    .setContentTitle(who)
                    .setContentText(text)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setOngoing(true)
                    .setAutoCancel(true)
                    .setTimeoutAfter(45_000)
                    .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
                    .setVibrate(VIBRATION)
                    .setContentIntent(open)
                    .setFullScreenIntent(open, true)
                    .addAction(0, c.getString(R.string.call_decline), decline)
                    .addAction(0, c.getString(R.string.call_answer), answer);
            Notification p = plain.build();
            p.flags |= Notification.FLAG_INSISTENT;
            try {
                nm.notify(RING, p);
            } catch (Exception ignored) {
                return false;
            }
        }
        ringing = id;
        return true;
    }

    /** the ring of call `id` (null: whichever) stops */
    static synchronized void cancelRing(Context c, String id) {
        if (id != null && !id.isEmpty() && ringing != null && !id.equals(ringing)) return;
        NotificationManager nm = nm(c);
        if (nm != null) nm.cancel(RING);
        ringing = null;
    }

    static synchronized String ringing() {
        return ringing;
    }

    // ---- what is left after ----

    /** her call that nobody took: "부재중 전화", tapped → the app */
    static void missed(Context c, String id, String mateId, String name) {
        NotificationManager nm = nm(c);
        if (nm == null) return;
        channels(c);
        String who = name == null || name.isEmpty() ? c.getString(R.string.call_mate) : name;
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH_MISSED)
                .setSmallIcon(android.R.drawable.sym_call_missed)
                .setContentTitle(c.getString(R.string.call_missed_title))
                .setContentText(c.getString(R.string.call_missed_text, who))
                .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .setAutoCancel(true)
                .setContentIntent(activity(c, Intent.ACTION_MAIN, id, 5));
        Bitmap face = roundFace(c, mateId);
        if (face != null) b.setLargeIcon(face);
        try {
            nm.notify(MISSED, b.build());
        } catch (Exception ignored) {
            // notifications off
        }
    }

    // ---- the link's own ----

    static Notification link(Context c, String title, String text) {
        channels(c);
        return new NotificationCompat.Builder(c, CH_LINK)
                .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                .setContentTitle(title)
                .setContentText(text)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setOngoing(true)
                .setShowWhen(false)
                .setSilent(true)
                .setContentIntent(activity(c, Intent.ACTION_MAIN, "", 6))
                .build();
    }

    /** during a call: her face and name, the clock, 끊기 */
    static Notification ongoing(Context c, String id, String mateId, String name, long since) {
        channels(c);
        String who = name == null || name.isEmpty() ? c.getString(R.string.call_mate) : name;
        PendingIntent open = activity(c, Intent.ACTION_MAIN, id, 7);
        PendingIntent hangup = broadcast(c, ACTION_HANGUP, id, 8);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH_ONGOING)
                .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                .setContentTitle(who)
                .setContentText(c.getString(R.string.call_ongoing_text))
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setSilent(true)
                .setUsesChronometer(true)
                .setWhen(since)
                .setShowWhen(true)
                .setContentIntent(open);
        try {
            return b.setStyle(NotificationCompat.CallStyle.forOngoingCall(person(c, mateId, who), hangup)).build();
        } catch (Exception e) {
            return b.setStyle(null).addAction(0, c.getString(R.string.call_hangup), hangup).build();
        }
    }
}
