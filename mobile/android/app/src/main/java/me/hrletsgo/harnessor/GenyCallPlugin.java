package me.hrletsgo.harnessor;

import android.app.Activity;
import android.app.KeyguardManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.view.WindowManager;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

/**
 * A phone call with the mate (docs/mate-calls.md "On Android") — the little the page can't do itself:
 *
 * - begin / setSpeaker / end: the phone in call mode for the call (MODE_IN_COMMUNICATION; the loudspeaker or the
 *   earpiece — setCommunicationDevice on Android 12+, setSpeakerphoneOn before; the screen kept on), and back after.
 *   (The WebView opening the mic puts the phone in that mode by itself, often turning her down or onto the earpiece:
 *   this keeps her where the call screen says.)
 * - ring / cancelRing: her ringing as a call notification while the app is in the background — the "calls" channel
 *   (ringtone, vibration), category CALL, a full-screen intent that brings the app up over the lock screen, and
 *   수락 / 거절 buttons. The page rings itself while it is in front. Taps come back to the page as "callAction"
 *   ({action: open | accept | decline, id}), kept until the page listens.
 *
 * A fully closed app can't ring: there is no push service, the page must be alive (open or in the background).
 */
@CapacitorPlugin(name = "GenyCall")
public class GenyCallPlugin extends Plugin {

    static final String CHANNEL = "geny_calls";
    static final int NOTIFICATION = 0x6e11;
    static final String ACTION_OPEN = "me.hrletsgo.harnessor.CALL_OPEN";
    static final String ACTION_ACCEPT = "me.hrletsgo.harnessor.CALL_ACCEPT";
    static final String ACTION_DECLINE = "me.hrletsgo.harnessor.CALL_DECLINE";
    static final String EXTRA_ID = "call_id";

    /** a tap that came before the plugin was loaded (the activity was recreated): delivered on load */
    private static JSObject pendingAction = null;

    private boolean inFront = true;
    private boolean inCall = false;
    private int modeBefore = AudioManager.MODE_NORMAL;

    @Override
    public void load() {
        if (pendingAction != null) {
            notifyListeners("callAction", pendingAction, true);
            pendingAction = null;
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        inFront = true;
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        inFront = false;
    }

    private AudioManager audio() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    private void route(boolean speaker) {
        AudioManager am = audio();
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            int want = speaker ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
            List<AudioDeviceInfo> devices = am.getAvailableCommunicationDevices();
            for (AudioDeviceInfo d : devices) {
                if (d.getType() == want) {
                    am.setCommunicationDevice(d);
                    return;
                }
            }
        }
        am.setSpeakerphoneOn(speaker);
    }

    private void keepOn(boolean on) {
        Activity a = getActivity();
        if (a == null) return;
        a.runOnUiThread(() -> {
            if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    @PluginMethod
    public void begin(PluginCall call) {
        try {
            AudioManager am = audio();
            if (am != null && !inCall) {
                modeBefore = am.getMode();
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            }
            inCall = true;
            route(Boolean.TRUE.equals(call.getBoolean("speaker", true)));
            keepOn(true);
            showOverLock(true); // (like a phone's call screen: over the lock screen while it lasts)
            call.resolve();
        } catch (Exception e) {
            call.reject("call mode: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setSpeaker(PluginCall call) {
        try {
            route(Boolean.TRUE.equals(call.getBoolean("on", true)));
            call.resolve();
        } catch (Exception e) {
            call.reject("speaker: " + e.getMessage());
        }
    }

    @PluginMethod
    public void end(PluginCall call) {
        try {
            AudioManager am = audio();
            if (am != null && inCall) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice();
                else am.setSpeakerphoneOn(false);
                am.setMode(modeBefore);
            }
        } catch (Exception ignored) {
            // the phone's own state wins
        }
        inCall = false;
        keepOn(false);
        showOverLock(false);
        call.resolve();
    }

    private void showOverLock(boolean on) {
        Activity a = getActivity();
        if (a == null) return;
        a.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                a.setShowWhenLocked(on);
                a.setTurnScreenOn(on);
            } else if (on) {
                a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
            } else {
                a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
            }
        });
    }

    private PendingIntent tap(String action, String id, int code) {
        Intent i = new Intent(getContext(), MainActivity.class);
        i.setAction(action);
        i.putExtra(EXTRA_ID, id);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(getContext(), code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void channel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Calls", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Your mate calling you");
        Uri ring = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        ch.setSound(ring, new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[] {0, 700, 500, 700, 1300});
        ch.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    @PluginMethod
    public void ring(PluginCall call) {
        String id = call.getString("id", "");
        JSObject out = new JSObject();
        // (in front, the page rings itself)
        if (inFront && !locked()) {
            out.put("shown", false);
            call.resolve(out);
            return;
        }
        try {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            channel(nm);
            String title = call.getString("title", "My Mate Geny");
            NotificationCompat.Builder b = new NotificationCompat.Builder(getContext(), CHANNEL)
                    .setSmallIcon(android.R.drawable.sym_call_incoming)
                    .setContentTitle(title)
                    .setContentText(call.getString("body", ""))
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setOngoing(true)
                    .setAutoCancel(true)
                    .setTimeoutAfter(40_000)
                    .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
                    .setVibrate(new long[] {0, 700, 500, 700, 1300})
                    .setContentIntent(tap(ACTION_OPEN, id, 1))
                    .setFullScreenIntent(tap(ACTION_OPEN, id, 2), true)
                    .addAction(0, call.getString("decline", "Decline"), tap(ACTION_DECLINE, id, 3))
                    .addAction(0, call.getString("accept", "Accept"), tap(ACTION_ACCEPT, id, 4));
            android.app.Notification n = b.build();
            n.flags |= android.app.Notification.FLAG_INSISTENT; // (it rings until answered, like a call)
            nm.notify(NOTIFICATION, n);
            showOverLock(true);
            out.put("shown", true);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("ring: " + e.getMessage());
        }
    }

    private boolean locked() {
        KeyguardManager km = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isKeyguardLocked();
    }

    @PluginMethod
    public void cancelRing(PluginCall call) {
        cancel(getContext());
        if (!inCall) showOverLock(false); // (taken: the call screen stays over the lock screen until it ends)
        call.resolve();
    }

    static void cancel(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIFICATION);
    }

    static boolean isCallIntent(Intent i) {
        if (i == null || i.getAction() == null) return false;
        String a = i.getAction();
        return ACTION_OPEN.equals(a) || ACTION_ACCEPT.equals(a) || ACTION_DECLINE.equals(a);
    }

    /** MainActivity: a tap on her call notification */
    void deliver(Intent i) {
        String a = i.getAction();
        JSObject data = new JSObject();
        data.put("action", ACTION_ACCEPT.equals(a) ? "accept" : ACTION_DECLINE.equals(a) ? "decline" : "open");
        data.put("id", i.getStringExtra(EXTRA_ID) == null ? "" : i.getStringExtra(EXTRA_ID));
        cancel(getContext());
        if (ACTION_DECLINE.equals(a)) showOverLock(false);
        notifyListeners("callAction", data, true);
    }

    static void deliverLater(Intent i) {
        String a = i.getAction();
        JSObject data = new JSObject();
        data.put("action", ACTION_ACCEPT.equals(a) ? "accept" : ACTION_DECLINE.equals(a) ? "decline" : "open");
        data.put("id", i.getStringExtra(EXTRA_ID) == null ? "" : i.getStringExtra(EXTRA_ID));
        pendingAction = data;
    }
}
