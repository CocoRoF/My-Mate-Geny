package me.hrletsgo.harnessor;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * The app kept running in the background so she can call like a phone does (docs/mate-calls.md "On Android"). There is
 * no push service: the user's own server holds one line open to this service — ``GET /api/mate-calls/link`` (server-sent
 * events: her ringing, where every call stands, a ping at least every 45 s) — and the service rings the phone the way a
 * call does (CallNotifier), with the app closed, the screen off or locked.
 *
 * - Runs while the user lets it (on by default: Settings → 메이트 → 전화) and the app is signed in to a server it
 *   remembers; started by the page (GenyCallPlugin.link), after a reboot and after an update (BootReceiver).
 * - During a call it also holds the microphone (a foreground service of that type, started while the call screen is in
 *   front), so a call goes on with the screen locked or another app in front — and shows the call: her face, the clock,
 *   끊기.
 * - A dropped line comes back: at once when the network does, else after 2 s … 5 min; signed out (a stale token), it
 *   waits for the page to sign it in again (or tries every 15 min).
 */
public class GenyLinkService extends Service {

    private static final String TAG = "GenyLink";
    static final String ACTION_SYNC = "me.hrletsgo.harnessor.LINK_SYNC";
    static final String ACTION_CALL = "me.hrletsgo.harnessor.LINK_CALL";
    private static final int READ_TIMEOUT_MS = 120_000; // (the server pings every 45 s: two missed is a dead line)
    private static final long[] BACKOFF = {2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000};
    private static final long SIGNED_OUT_RETRY = 15 * 60_000L;

    /** the running service (one at most), touched on the main thread */
    private static GenyLinkService instance = null;
    /** where the line stands: off · connecting · connected · offline · signed_out */
    static volatile String state = "off";
    /** she may call this phone (speaking first is on here), and who */
    static volatile boolean calls = false;
    static volatile String mate = "";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Object gate = new Object();
    private volatile boolean running = false;
    private volatile HttpURLConnection line = null;
    private Thread worker = null;
    private int failures = 0;
    /** the server said it is stopping (a restart): try again every few seconds for a while, not on the long backoff */
    private int restarting = 0;
    private volatile boolean bye = false;
    private ConnectivityManager.NetworkCallback network = null;
    private PowerManager.WakeLock wake = null;

    /** the call on now (null: none): its id, her id and name, since when */
    private String callId = null;
    private String callMate = "";
    private String callName = "";
    private long callSince = 0;

    // ---- the app's side (any thread) ----

    static boolean wanted(Context c) {
        return GenyLink.background(c) && GenyLink.ready(c);
    }

    static boolean running() {
        return instance != null;
    }

    private static void onMain(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) r.run();
        else new Handler(Looper.getMainLooper()).post(r);
    }

    private static void start(Context c, Intent i) {
        try {
            ContextCompat.startForegroundService(c, i);
        } catch (Exception e) {
            // (not allowed from the background here: the page or the next boot starts it)
            Log.w(TAG, "could not start: " + e);
        }
    }

    /** run if it should (and isn't), stop if it shouldn't (outside a call), reconnect now if it runs */
    static void sync(Context c) {
        Context app = c.getApplicationContext();
        onMain(() -> {
            if (instance != null) instance.reconsider();
            else if (wanted(app)) start(app, new Intent(app, GenyLinkService.class).setAction(ACTION_SYNC));
        });
    }

    /** a call screen began (in front): hold the microphone and show the call — the service starts for it if it isn't on */
    static void callStarted(Context c, String id, String mateId, String name) {
        Context app = c.getApplicationContext();
        onMain(() -> {
            if (instance != null) instance.inCall(id, mateId, name);
            else start(app, new Intent(app, GenyLinkService.class).setAction(ACTION_CALL)
                    .putExtra("id", id).putExtra("mate", mateId).putExtra("name", name));
        });
    }

    static void callEnded() {
        onMain(() -> {
            if (instance != null) instance.outOfCall();
        });
    }

    static void stop() {
        onMain(() -> {
            if (instance != null) instance.shutdown();
        });
    }

    // ---- the service ----

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        CallNotifier.channels(this);
        watchNetwork();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_CALL.equals(intent.getAction())) {
            callId = intent.getStringExtra("id");
            callMate = nz(intent.getStringExtra("mate"));
            callName = nz(intent.getStringExtra("name"));
            callSince = System.currentTimeMillis();
        }
        // (first: a service started for the foreground must say so within seconds)
        if (!foreground()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!wanted(this) && callId == null) {
            shutdown();
            return START_NOT_STICKY;
        }
        if (wanted(this)) ensureWorker();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (instance == this) instance = null;
        state = "off";
        unwatchNetwork();
        drop();
        if (wake != null && wake.isHeld()) wake.release();
        super.onDestroy();
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    /** in the foreground with what it shows now (the call, or the line); false: not allowed */
    private boolean foreground() {
        boolean mic = callId != null;
        Notification n = mic ? CallNotifier.ongoing(this, callId, callMate, callName, callSince) : status();
        try {
            ServiceCompat.startForeground(this, CallNotifier.LINK, n, type(mic));
            return true;
        } catch (Exception e) {
            if (mic) {
                // (the microphone isn't allowed now — no permission, or not started from the call screen in front)
                Log.w(TAG, "call without the microphone type: " + e);
                try {
                    ServiceCompat.startForeground(this, CallNotifier.LINK, n, type(false));
                    return true;
                } catch (Exception again) {
                    Log.w(TAG, "foreground refused: " + again);
                    return false;
                }
            }
            Log.w(TAG, "foreground refused: " + e);
            return false;
        }
    }

    private static int type(boolean mic) {
        if (Build.VERSION.SDK_INT >= 34) {
            return ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE | (mic ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && mic) return ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        return 0;
    }

    /** the line's own notification: what it is there for, and how it stands */
    private Notification status() {
        String title;
        String text;
        switch (state) {
            case "signed_out":
                title = getString(R.string.link_title);
                text = getString(R.string.link_signed_out);
                break;
            case "offline":
                title = getString(R.string.link_title);
                text = getString(R.string.link_offline);
                break;
            case "connected":
                if (calls) {
                    title = mate.isEmpty() ? getString(R.string.link_on_any) : getString(R.string.link_on, mate);
                    text = getString(R.string.link_on_text);
                } else {
                    title = getString(R.string.link_title);
                    text = getString(R.string.link_off_text);
                }
                break;
            default:
                title = getString(R.string.link_title);
                text = getString(R.string.link_connecting);
        }
        return CallNotifier.link(this, title, text);
    }

    private void refresh() {
        if (callId != null) return;
        main.post(() -> {
            if (instance != this || callId != null) return;
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            try {
                if (nm != null) nm.notify(CallNotifier.LINK, status());
            } catch (Exception ignored) {
                // notifications off: it still runs
            }
        });
    }

    private void setState(String s) {
        if (s.equals(state)) return;
        state = s;
        refresh();
    }

    // ---- calls on the phone ----

    private void inCall(String id, String mateId, String name) {
        callId = id;
        callMate = nz(mateId);
        callName = nz(name);
        callSince = System.currentTimeMillis();
        foreground();
    }

    private void outOfCall() {
        if (callId == null) return;
        callId = null;
        if (!wanted(this)) {
            shutdown();
            return;
        }
        foreground();
        ensureWorker();
    }

    private void reconsider() {
        if (!wanted(this)) {
            if (callId == null) shutdown();
            return;
        }
        ensureWorker();
        failures = 0;
        wake(); // (a new token from the page, a switch turned on: try now)
        refresh();
    }

    private void shutdown() {
        running = false;
        wake();
        drop();
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
            // already gone
        }
        stopSelf();
    }

    // ---- the line ----

    private void ensureWorker() {
        if (worker != null && worker.isAlive()) return;
        running = true;
        worker = new Thread(this::loop, "geny-link");
        worker.start();
    }

    /** the open line goes (the loop reconnects, or ends when not running) — off the main thread */
    private void drop() {
        HttpURLConnection c = line;
        if (c == null) return;
        new Thread(() -> {
            try {
                c.disconnect();
            } catch (Exception ignored) {
                // closing
            }
        }, "geny-link-drop").start();
    }

    private void wake() {
        synchronized (gate) {
            gate.notifyAll();
        }
    }

    private void pause(long ms) {
        synchronized (gate) {
            try {
                gate.wait(ms);
            } catch (InterruptedException ignored) {
                // on
            }
        }
    }

    private long backoff() {
        if (restarting > 0) {
            restarting--;
            return 3_000;
        }
        long d = BACKOFF[Math.min(failures, BACKOFF.length - 1)];
        failures++;
        return d + (long) (Math.random() * 1000);
    }

    private void loop() {
        while (running) {
            if (!wanted(this)) {
                if (callId == null) main.post(this::shutdown);
                return;
            }
            String base = GenyLink.server(this);
            String device = GenyLink.device(this);
            String token = GenyLink.token(this);
            setState(failures > 0 ? "offline" : "connecting");
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(base + "/api/mate-calls/link?device=" + URLEncoder.encode(device, "UTF-8")).openConnection();
                c.setConnectTimeout(15_000);
                c.setReadTimeout(READ_TIMEOUT_MS);
                c.setUseCaches(false);
                c.setRequestProperty("Authorization", "Bearer " + token);
                c.setRequestProperty("Accept", "text/event-stream");
                line = c;
                int code = c.getResponseCode();
                GenyLink.fromResponse(this, c);
                if (code == 401 || code == 403) {
                    setState("signed_out");
                    pause(SIGNED_OUT_RETRY);
                    continue;
                }
                if (code != 200) throw new IOException("HTTP " + code);
                failures = 0;
                restarting = 0;
                bye = false;
                setState("connected");
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                StringBuilder data = new StringBuilder();
                String l;
                while (running && !bye && (l = r.readLine()) != null) {
                    if (l.startsWith("data:")) {
                        data.append(l.substring(5).trim());
                    } else if (l.isEmpty() && data.length() > 0) {
                        handle(data.toString());
                        data.setLength(0);
                    }
                }
                if (bye) restarting = 40; // (two minutes of tries every 3 s: a restart is back long before)
                if (running) {
                    // (the server went away — a restart: back soon)
                    failures = Math.max(failures, 1);
                    setState("offline");
                    pause(backoff());
                }
            } catch (Exception e) {
                if (!running) break;
                setState("offline");
                pause(backoff());
            } finally {
                if (c != null) c.disconnect();
                line = null;
            }
        }
    }

    private void handle(String raw) {
        JSONObject m;
        try {
            m = new JSONObject(raw);
        } catch (Exception e) {
            return;
        }
        switch (m.optString("type")) {
            case "hello":
                policy(m);
                JSONObject now = m.optJSONObject("ring");
                if (now != null) ring(now);
                break;
            case "policy":
                policy(m);
                break;
            case "call.ring":
                ring(m.optJSONObject("data"));
                break;
            case "call.update":
                update(m.optJSONObject("data"));
                break;
            case "bye":
                bye = true; // (the server is stopping: back to the next one in seconds)
                break;
            default:
                // ping
        }
    }

    private void policy(JSONObject m) {
        boolean on = m.optBoolean("calls", false);
        String who = m.optString("mate", "");
        if (on == calls && who.equals(mate)) return;
        calls = on;
        mate = who;
        refresh();
    }

    /** she is calling this phone: it rings like a call (the page rings itself while it is in front and unlocked) */
    private void ring(JSONObject call) {
        if (call == null || !"ringing".equals(call.optString("status")) || !"incoming".equals(call.optString("direction"))) return;
        String dev = call.optString("device", "");
        if (!dev.isEmpty() && !dev.equals(GenyLink.device(this))) return;
        hold();
        if (GenyCallPlugin.front() && !CallNotifier.locked(this)) return;
        CallNotifier.ring(this, call.optString("id"), call.optString("mate_id"), call.optString("name"), getString(R.string.call_ring_text));
    }

    private void update(JSONObject call) {
        if (call == null) return;
        String id = call.optString("id");
        String status = call.optString("status");
        if ("ringing".equals(status) || "dialing".equals(status)) return;
        boolean rangHere = id.equals(CallNotifier.ringing());
        CallNotifier.cancelRing(this, id);
        if (!"ended".equals(status)) return;
        if (rangHere) main.post(GenyCallPlugin::ringOver); // (not taken: the app no longer comes up over the lock screen)
        if (rangHere && "missed".equals(call.optString("end_reason"))) {
            CallNotifier.missed(this, id, call.optString("mate_id"), call.optString("name"));
        }
        // (a call whose screen is gone — the page closed mid-call: it is over here too)
        if (id.equals(callId)) main.post(this::outOfCall);
    }

    /** a moment awake to ring (the phone may be asleep when the line wakes it) */
    private void hold() {
        try {
            if (wake == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm == null) return;
                wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "geny:ring");
                wake.setReferenceCounted(false);
            }
            wake.acquire(10_000);
        } catch (Exception ignored) {
            // it rings anyway
        }
    }

    // ---- the network ----

    private void watchNetwork() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        network = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network n) {
                failures = 0;
                wake(); // (back: reconnect now, not after the backoff)
            }

            @Override
            public void onLost(Network n) {
                drop(); // (a line on the network that went would hang until its timeout)
            }
        };
        try {
            cm.registerDefaultNetworkCallback(network);
        } catch (Exception e) {
            network = null;
        }
    }

    private void unwatchNetwork() {
        if (network == null) return;
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        try {
            if (cm != null) cm.unregisterNetworkCallback(network);
        } catch (Exception ignored) {
            // gone
        }
        network = null;
    }
}
