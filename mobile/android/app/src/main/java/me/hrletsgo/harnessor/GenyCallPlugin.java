package me.hrletsgo.harnessor;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.WindowManager;
import android.webkit.CookieManager;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Iterator;
import java.util.List;

/**
 * A phone call with the mate (docs/mate-calls.md "On Android") — the little the page can't do itself:
 *
 * - begin / setSpeaker / end: the phone in call mode for the call (MODE_IN_COMMUNICATION; the loudspeaker or the
 *   earpiece — setCommunicationDevice on Android 12+, setSpeakerphoneOn before; the screen kept on, over the lock
 *   screen), and back after; the background link (GenyLinkService) holds the microphone meanwhile and shows the call.
 * - ring / cancelRing: her ringing as a call notification while the app is in the background or the phone is locked
 *   (CallNotifier); the page rings itself while it is in front. Taps come back to the page as "callAction"
 *   ({action: open | accept | decline, id}), kept until the page listens; 거절 is done without the page.
 * - link / status / setBackground / openSettings: the background link that keeps the app reachable with it closed, so
 *   her calls ring like a phone's — which device this page is and its sign-in, whether it runs, and what the phone
 *   still has to allow (notifications, full-screen calls, no battery optimisation).
 */
@CapacitorPlugin(name = "GenyCall")
public class GenyCallPlugin extends Plugin {

    static final String ACTION_OPEN = CallNotifier.ACTION_OPEN;
    static final String ACTION_ACCEPT = CallNotifier.ACTION_ACCEPT;
    static final String ACTION_DECLINE = CallNotifier.ACTION_DECLINE;
    static final String EXTRA_ID = CallNotifier.EXTRA_ID;

    /** a tap that came before the plugin was loaded (the activity was recreated): delivered on load */
    private static JSObject pendingAction = null;
    /** the app is in front (its page rings itself then) */
    private static volatile boolean inFront = false;

    static boolean front() {
        return inFront;
    }

    private boolean inCall = false;
    private int modeBefore = AudioManager.MODE_NORMAL;
    /** the loaded plugin (one activity at a time): a ring that ends with no page to say so still lets the lock screen back */
    private static GenyCallPlugin current = null;

    /** her ringing is over and nobody took it here (missed, declined elsewhere): off the lock screen again */
    static void ringOver() {
        GenyCallPlugin p = current;
        if (p != null && !p.inCall) p.showOverLock(false);
    }

    @Override
    public void load() {
        current = this;
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
            String id = call.getString("id", "");
            // (the microphone stays hers with the screen locked or another app in front; the call shows in the shade)
            if (id != null && !id.isEmpty()) GenyLinkService.callStarted(getContext(), id, call.getString("mate", ""), call.getString("name", ""));
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
        GenyLinkService.callEnded();
        call.resolve();
    }

    private void showOverLock(boolean on) {
        Activity a = getActivity();
        if (a != null) a.runOnUiThread(() -> overLock(a, on));
    }

    /** the app over the lock screen (her ringing, a call), or not */
    static void overLock(Activity a, boolean on) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            a.setShowWhenLocked(on);
            a.setTurnScreenOn(on);
        } else if (on) {
            a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        } else {
            a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }

    @PluginMethod
    public void ring(PluginCall call) {
        String id = call.getString("id", "");
        JSObject out = new JSObject();
        Context c = getContext();
        // (in front and unlocked, the page rings itself: a ring the link started for it stops — one ring at a time)
        if (inFront && !CallNotifier.locked(c)) {
            CallNotifier.cancelRing(c, id);
            out.put("shown", false);
            call.resolve(out);
            return;
        }
        boolean shown = CallNotifier.ring(c, id, call.getString("mate", ""), call.getString("title", ""), call.getString("body", ""));
        if (shown) showOverLock(true);
        out.put("shown", shown);
        call.resolve(out);
    }

    @PluginMethod
    public void cancelRing(PluginCall call) {
        CallNotifier.cancelRing(getContext(), call.getString("id", ""));
        if (!inCall) showOverLock(false); // (taken: the call screen stays over the lock screen until it ends)
        call.resolve();
    }

    static void cancel(Context c) {
        CallNotifier.cancelRing(c, null);
    }

    // ---- the background link ----

    /**
     * {device, faces?: {mateId: data URL}} — this page is `device` on the server it is signed in to: the background link
     * signs in as it (the login cookie's token), her face rings with her calls; it starts if it should. → status()
     */
    @PluginMethod
    public void link(PluginCall call) {
        String device = call.getString("device", "");
        Context c = getContext();
        if (device != null && device.matches("[A-Za-z0-9_.:-]{1,80}")) GenyLink.prefs(c).edit().putString(GenyLink.K_DEVICE, device).apply();
        JSObject faces = call.getObject("faces", null);
        if (faces != null) {
            Iterator<String> keys = faces.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                CallNotifier.keepFace(c, k, faces.optString(k, null));
            }
        }
        // (the cookie is the WebView's: read on its thread)
        getBridge().executeOnMainThread(() -> {
            try {
                String server = GenyLink.server(c);
                if (server != null) GenyLink.offer(c, GenyLink.fromCookie(CookieManager.getInstance().getCookie(server)));
            } catch (Exception ignored) {
                // no WebView provider: the kept token stays
            }
            GenyLinkService.sync(c);
            call.resolve(statusOf(c));
        });
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusOf(getContext()));
    }

    /** {on}: the link runs with the app closed, or only during a call */
    @PluginMethod
    public void setBackground(PluginCall call) {
        Context c = getContext();
        GenyLink.prefs(c).edit().putBoolean(GenyLink.K_BACKGROUND, Boolean.TRUE.equals(call.getBoolean("on", true))).apply();
        GenyLinkService.sync(c);
        call.resolve(statusOf(c));
    }

    /** {what: battery | fullscreen | notifications}: the phone's own page for it */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Context c = getContext();
        String what = call.getString("what", "");
        Uri pkg = Uri.parse("package:" + c.getPackageName());
        Intent i;
        if ("battery".equals(what)) {
            i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg);
        } else if ("fullscreen".equals(what) && Build.VERSION.SDK_INT >= 34) {
            i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg);
        } else if ("notifications".equals(what) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, c.getPackageName());
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg);
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            c.startActivity(i);
        } catch (Exception e) {
            try {
                c.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
                // nothing to open
            }
        }
        call.resolve();
    }

    static JSObject statusOf(Context c) {
        JSObject r = new JSObject();
        r.put("background", GenyLink.background(c));
        r.put("ready", GenyLink.ready(c));
        r.put("running", GenyLinkService.running());
        r.put("state", GenyLinkService.state);
        r.put("calls", GenyLinkService.calls);
        r.put("mate", GenyLinkService.mate);
        r.put("notifications", NotificationManagerCompat.from(c).areNotificationsEnabled());
        boolean full = true;
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            full = nm == null || nm.canUseFullScreenIntent();
        }
        r.put("fullScreen", full);
        boolean battery = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            battery = pm == null || pm.isIgnoringBatteryOptimizations(c.getPackageName());
        }
        r.put("batteryExempt", battery);
        return r;
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
