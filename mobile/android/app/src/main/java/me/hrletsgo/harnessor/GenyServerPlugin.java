package me.hrletsgo.harnessor;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.database.Cursor;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.webkit.CookieManager;
import com.getcapacitor.CapConfig;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Which server the app talks to — chosen by the user, never built in.
 *
 * No server saved: the WebView starts on the local connect page
 * (www/index.html at https://localhost) which finds the server and signs in
 * (www/connect-core.js, native HTTP) and then calls connect(). The activity
 * is recreated with Capacitor's {@code server.url} set to that server's
 * origin (exactly how the app was configured when the server was hard-coded,
 * so the console gets the native bridge — notifications, back button — on
 * its own origin) and first loads {server}/auth/exchange?code=… so the
 * session cookie is set first-party. Later starts open the saved server.
 *
 * Ways back to the connect page: switchServer() / signOut() (the console or
 * the server's login page can call them through the bridge), the launcher
 * shortcut "Switch server" (MainActivity), and the offline page, which
 * navigates to https://localhost/__geny/switch-server (handled here).
 */
@CapacitorPlugin(name = "GenyServer")
public class GenyServerPlugin extends Plugin {

    static final String PREFS = "geny_server";
    /** Builds before 0.4 always loaded this server. Only used to recognise those installs (migrate()). */
    static final String LEGACY_SERVER = "https://agent.hrletsgo.me";

    private static final String K_SERVER = "server"; // base URL: origin [+ sub-path], no trailing slash
    private static final String K_LAST = "lastServer"; // prefill for the connect page
    private static final String K_USER = "username";
    private static final String K_REMEMBER = "remember";
    private static final String K_EPHEMERAL = "ephemeral"; // connected without "remember": dropped at the next start
    private static final String K_PENDING = "pendingStart"; // the exchange URL for the next activity start
    private static final String K_MIGRATED = "migrated";

    private static boolean processStarted = false;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** "https://host[:port][/path]" without a trailing slash, or null. */
    static String cleanBase(String raw) {
        if (raw == null) return null;
        try {
            URL u = new URL(raw.trim());
            String scheme = u.getProtocol().toLowerCase();
            if (!scheme.equals("http") && !scheme.equals("https")) return null;
            if (u.getHost() == null || u.getHost().isEmpty()) return null;
            String path = u.getPath() == null ? "" : u.getPath().replaceAll("/+$", "");
            int port = u.getPort();
            boolean dflt = port == -1 || (scheme.equals("http") && port == 80) || (scheme.equals("https") && port == 443);
            return scheme + "://" + u.getHost().toLowerCase() + (dflt ? "" : ":" + port) + path;
        } catch (Exception e) {
            return null;
        }
    }

    static String origin(String base) {
        try {
            URL u = new URL(base);
            int port = u.getPort();
            return u.getProtocol() + "://" + u.getHost() + (port == -1 ? "" : ":" + port);
        } catch (Exception e) {
            return null;
        }
    }

    static boolean sameOrigin(String a, String b) {
        String oa = origin(a);
        return oa != null && oa.equals(origin(b));
    }

    /** Pre-0.4 installs: still signed in to the old built-in server → keep using it; else prefill it. */
    private static void migrate(Context c, SharedPreferences p) {
        if (p.getBoolean(K_MIGRATED, false)) return;
        SharedPreferences.Editor e = p.edit().putBoolean(K_MIGRATED, true);
        boolean ranBefore = c.getSharedPreferences("CapWebViewSettings", Context.MODE_PRIVATE).contains("lastBinaryVersionCode");
        if (ranBefore && p.getString(K_SERVER, null) == null) {
            String cookies = null;
            try {
                cookies = CookieManager.getInstance().getCookie(LEGACY_SERVER);
            } catch (Exception ignored) {
                // no WebView provider: nothing to migrate
            }
            if (cookies != null && cookies.contains("hrh_session=")) {
                e.putString(K_SERVER, LEGACY_SERVER).putString(K_LAST, LEGACY_SERVER).putBoolean(K_REMEMBER, true);
            } else if (p.getString(K_LAST, null) == null) {
                e.putString(K_LAST, LEGACY_SERVER);
            }
        }
        e.apply();
    }

    static void clearCookies() {
        try {
            CookieManager cm = CookieManager.getInstance();
            cm.removeAllCookies(null);
            cm.flush();
        } catch (Exception ignored) {
            // nothing to clear
        }
    }

    /** Forget the connected server (kept: lastServer/username for prefill, if remembered). */
    static void forgetServer(Context c, boolean signOut) {
        android.util.Log.i("GenyServer", signOut ? "signing out" : "switching server");
        SharedPreferences p = prefs(c);
        SharedPreferences.Editor e = p.edit().remove(K_SERVER).remove(K_PENDING).remove(K_EPHEMERAL);
        if (!p.getBoolean(K_REMEMBER, true)) e.remove(K_LAST).remove(K_USER);
        e.apply();
        if (signOut) clearCookies();
    }

    /**
     * Capacitor's config for this start: capacitor.config.json plus, when a
     * server is saved, server.url = its origin, server.appStartPath = the
     * exchange URL (right after connecting) or its sub-path, and
     * server.allowNavigation = its host (so http↔https on the same host
     * stays in the app; other links still open in the browser).
     */
    @SuppressWarnings("deprecation")
    static CapConfig buildConfig(Activity a) {
        SharedPreferences p = prefs(a);
        migrate(a, p);
        if (!processStarted) {
            processStarted = true;
            if (p.getBoolean(K_EPHEMERAL, false)) forgetServer(a, true);
        }
        JSONObject json;
        try {
            json = new JSONObject(readAsset(a, "capacitor.config.json"));
        } catch (Exception e) {
            Logger.error("GenyServer", "capacitor.config.json unreadable", e);
            return CapConfig.loadDefault(a);
        }
        try {
            // (the config is parsed without a Context below, so the debug-build
            // defaults Capacitor derives from one are set here)
            boolean debuggable = (a.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            JSONObject androidCfg = json.optJSONObject("android");
            if (androidCfg == null) json.put("android", androidCfg = new JSONObject());
            if (!androidCfg.has("webContentsDebuggingEnabled")) androidCfg.put("webContentsDebuggingEnabled", debuggable);
            // (loggingBehavior stays "debug" → off: Capacitor would log plugin
            // call data, including the sign-in request with the password)
            JSONObject server = json.optJSONObject("server");
            if (server == null) json.put("server", server = new JSONObject());
            server.remove("url");
            server.remove("appStartPath");
            server.remove("allowNavigation");

            String base = cleanBase(p.getString(K_SERVER, null));
            if (base != null) {
                String origin = origin(base);
                String start = p.getString(K_PENDING, null);
                p.edit().remove(K_PENDING).apply();
                String path = base.substring(origin.length()) + "/";
                if (start != null && sameOrigin(start, base)) {
                    URL s = new URL(start);
                    path = s.getFile(); // path + query
                }
                server.put("url", origin);
                server.put("appStartPath", path);
                server.put("allowNavigation", new JSONArray().put(new URL(origin).getHost()));
            }
            android.util.Log.i("GenyServer", base == null ? "start: connect page" : "start: " + server.optString("url") + server.optString("appStartPath").replaceAll("code=[^&]+", "code=…"));
        } catch (Exception e) {
            Logger.error("GenyServer", "could not apply the saved server", e);
        }
        return new CapConfig(a.getAssets(), json);
    }

    private static String readAsset(Context c, String name) throws Exception {
        try (InputStream in = c.getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private void restart() {
        Activity a = getActivity();
        if (a != null) a.runOnUiThread(a::recreate);
    }

    // ── the bridge (connect page, console, server login page) ──────

    @PluginMethod
    public void getState(PluginCall call) {
        SharedPreferences p = prefs(getContext());
        JSObject r = new JSObject();
        r.put("server", nz(cleanBase(p.getString(K_SERVER, null))));
        r.put("lastServer", nz(cleanBase(p.getString(K_LAST, null))));
        r.put("username", nz(p.getString(K_USER, null)));
        r.put("remember", p.getBoolean(K_REMEMBER, true));
        String version = "";
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            version = info.versionName;
        } catch (Exception ignored) {
            // unknown
        }
        r.put("version", nz(version));
        call.resolve(r);
    }

    /** {server, start, username, remember}: save the server and open start (its exchange URL). */
    @PluginMethod
    public void connect(PluginCall call) {
        String base = cleanBase(call.getString("server"));
        String start = call.getString("start");
        if (base == null) {
            call.reject("Not an http(s) server address");
            return;
        }
        if (start == null || !sameOrigin(start, base)) {
            call.reject("The start page must be on the server");
            return;
        }
        boolean remember = Boolean.TRUE.equals(call.getBoolean("remember", true));
        String user = call.getString("username", "");
        SharedPreferences.Editor e = prefs(getContext()).edit()
            .putString(K_SERVER, base)
            .putString(K_PENDING, start)
            .putBoolean(K_REMEMBER, remember)
            .putBoolean(K_EPHEMERAL, !remember);
        if (remember) e.putString(K_LAST, base).putString(K_USER, user == null ? "" : user.trim());
        else e.remove(K_USER);
        e.apply();
        call.resolve();
        restart();
    }

    /** Back to the connect page (the session cookie stays). */
    @PluginMethod
    public void switchServer(PluginCall call) {
        forgetServer(getContext(), false);
        call.resolve();
        restart();
    }

    /** Sign out: cookies cleared, back to the connect page. */
    @PluginMethod
    public void signOut(PluginCall call) {
        forgetServer(getContext(), true);
        call.resolve();
        restart();
    }

    /** Local pages ask for actions by navigating to https://localhost/__geny/<action>. */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (url == null || url.getPath() == null || !url.getPath().startsWith("/__geny/")) return null;
        if (bridge == null || !String.valueOf(url.getHost()).equalsIgnoreCase(bridge.getHost())) return null;
        String action = url.getPath().substring("/__geny/".length());
        android.util.Log.i("GenyServer", "local page asked for " + action);
        switch (action) {
            case "switch-server":
                forgetServer(getContext(), false);
                restart();
                break;
            case "sign-out":
                forgetServer(getContext(), true);
                restart();
                break;
            case "retry":
            default:
                String base = cleanBase(prefs(getContext()).getString(K_SERVER, null));
                if (base != null) bridge.getWebView().loadUrl(base + "/");
                else restart();
                break;
        }
        return true;
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    // ── the Download page: a new APK with progress, then the system installer ──
    // (frontend/src/lib/downloadProgress.ts; older apps lack these methods and the page falls back to the plain
    // link, which MainActivity's DownloadListener hands to DownloadManager)

    private DownloadManager downloads() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    /** Only APKs from the connected server. */
    @PluginMethod
    public void downloadApk(PluginCall call) {
        String url = call.getString("url");
        String base = cleanBase(prefs(getContext()).getString(K_SERVER, null));
        if (url == null || base == null || !sameOrigin(url, base)) {
            call.reject("not a download of this server");
            return;
        }
        String name = call.getString("name", "my-mate-geny.apk");
        if (name == null || !name.matches("[\\w.+-]{1,120}\\.apk")) name = "my-mate-geny.apk";
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) req.addRequestHeader("Cookie", cookies);
            req.setMimeType("application/vnd.android.package-archive");
            req.setTitle(name);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // the app's own Downloads folder: no storage permission, and the installer reads it through DownloadManager
            req.setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, name);
            long id = downloads().enqueue(req);
            JSObject r = new JSObject();
            r.put("id", id);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("download failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void downloadStatus(PluginCall call) {
        long id = call.getLong("id", -1L);
        JSObject r = new JSObject();
        try (Cursor c = downloads().query(new DownloadManager.Query().setFilterById(id))) {
            if (id < 0 || c == null || !c.moveToFirst()) {
                r.put("status", "gone");
                call.resolve(r);
                return;
            }
            int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            r.put("transferred", c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)));
            r.put("total", Math.max(0L, c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))));
            if (status == DownloadManager.STATUS_SUCCESSFUL) r.put("status", "done");
            else if (status == DownloadManager.STATUS_FAILED) {
                r.put("status", "failed");
                r.put("reason", "The download failed (" + c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)) + ").");
            } else r.put("status", status == DownloadManager.STATUS_PAUSED ? "paused" : "running");
            call.resolve(r);
        } catch (Exception e) {
            call.reject("status failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        long id = call.getLong("id", -1L);
        if (id >= 0) downloads().remove(id);
        call.resolve();
    }

    /** Open the system installer for a finished APK download (first asks to allow installs from this app). */
    @PluginMethod
    public void installApk(PluginCall call) {
        long id = call.getLong("id", -1L);
        Uri uri = id < 0 ? null : downloads().getUriForDownloadedFile(id);
        if (uri == null) {
            call.reject("the download is not finished");
            return;
        }
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.getPackageManager().canRequestPackageInstalls()) {
            Intent allow = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
            allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(allow);
            JSObject r = new JSObject();
            r.put("needsPermission", true);
            call.resolve(r);
            return;
        }
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
        call.resolve();
    }

    private static boolean sameOrigin(String url, String base) {
        try {
            Uri a = Uri.parse(url);
            Uri b = Uri.parse(base);
            return a.getScheme() != null && a.getScheme().equalsIgnoreCase(b.getScheme())
                && a.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost()) && a.getPort() == b.getPort();
        } catch (Exception e) {
            return false;
        }
    }
}
