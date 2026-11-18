package me.hrletsgo.harnessor;

import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.journeyapps.barcodescanner.ScanIntentResult;
import com.journeyapps.barcodescanner.ScanOptions;
import org.json.JSONObject;

/**
 * The connect page's (www/connect.js) and the console's side of Geny Net (GenyNet.java) and of sign-in QR codes:
 *
 * - scan() → {text}: the camera's QR scanner (zxing-android-embedded; it asks for the camera itself).
 * - incoming() → {uri, confirmed}: a geny:// link the app was opened with (the camera app, a browser), once.
 * - state() → {paired, name, via, active}.
 * - pair({uri}) → {request, sas, name}: the first half of pairing (the six digits to show); then wait() → {state}
 *   until "approved" (or "denied" / "expired"), and open() — the app on that computer from now on.
 * - forget(): this phone's pairing gone, back to the connect page.
 */
@CapacitorPlugin(name = "GenyNet")
public class GenyNetPlugin extends Plugin {

    @PluginMethod
    public void scan(PluginCall call) {
        ScanOptions o = new ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(call.getString("prompt", ""))
                .setBeepEnabled(false)
                .setOrientationLocked(false);
        Intent i = o.createScanIntent(getContext());
        startActivityForResult(call, i, "scanned");
    }

    @ActivityCallback
    private void scanned(PluginCall call, ActivityResult result) {
        if (call == null) return;
        ScanIntentResult r = ScanIntentResult.parseActivityResult(result.getResultCode(), result.getData());
        JSObject out = new JSObject();
        out.put("text", r.getContents() == null ? "" : r.getContents());
        call.resolve(out);
    }

    @PluginMethod
    public void incoming(PluginCall call) {
        String[] u = GenyNet.takeIncoming(getContext());
        JSObject out = new JSObject();
        out.put("uri", u == null ? "" : u[0]);
        out.put("confirmed", u != null && !u[1].isEmpty());
        call.resolve(out);
    }

    @PluginMethod
    public void state(PluginCall call) {
        JSObject out = new JSObject();
        out.put("paired", GenyNet.paired(getContext()));
        out.put("name", GenyNet.name(getContext()));
        out.put("via", GenyNet.via(getContext()));
        out.put("active", GenyNet.active(getContext()));
        call.resolve(out);
    }

    @PluginMethod
    public void pair(PluginCall call) {
        String uri = call.getString("uri", "");
        new Thread(() -> {
            try {
                JSONObject r = GenyNet.pair(getContext(), uri);
                call.resolve(JSObject.fromJSONObject(r));
            } catch (GenyNet.PairException e) {
                call.reject(e.getMessage(), e.code);
            } catch (IllegalArgumentException e) {
                call.reject(e.getMessage(), "bad_code");
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "error");
            }
        }, "geny-net-pair").start();
    }

    @PluginMethod
    public void waitResult(PluginCall call) {
        new Thread(() -> {
            try {
                JSObject out = new JSObject();
                out.put("state", GenyNet.pairWait(getContext()));
                call.resolve(out);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "unreachable");
            }
        }, "geny-net-wait").start();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        GenyNet.cancelPairing(getContext());
        call.resolve();
    }

    /** the app on the paired computer: the proxy up, the WebView's pass set, the activity started on it */
    @PluginMethod
    public void open(PluginCall call) {
        if (!GenyNet.paired(getContext())) {
            call.reject("No computer is paired");
            return;
        }
        GenyNet.ensureProxy(getContext());
        GenyNet.allowWebView(getContext());
        String base = GenyNet.base(getContext());
        GenyServerPlugin.select(getContext(), base, base + "/", true);
        call.resolve();
        restart();
    }

    @PluginMethod
    public void forget(PluginCall call) {
        boolean wasActive = GenyNet.active(getContext());
        GenyNet.forget(getContext());
        if (wasActive) GenyServerPlugin.forgetServer(getContext(), true);
        call.resolve();
        if (wasActive) restart();
    }

    private void restart() {
        Activity a = getActivity();
        if (a != null) a.runOnUiThread(a::recreate);
    }
}
