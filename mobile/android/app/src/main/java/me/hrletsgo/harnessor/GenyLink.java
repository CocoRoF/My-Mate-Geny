package me.hrletsgo.harnessor;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

/**
 * What the app's background link keeps (docs/mate-calls.md "On Android"): which device the page is (its id, as the
 * server knows it), the session token it signs in with — taken from the page's login cookie, kept fresh by the server's
 * sliding cookie on every answer — and whether it should run at all (the user can switch it off).
 */
final class GenyLink {

    static final String PREFS = "geny_link";
    static final String K_DEVICE = "device";
    static final String K_BACKGROUND = "background";
    static final String K_TOKEN = "token";
    static final String COOKIE = "hrh_session";

    private GenyLink() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String device(Context c) {
        return prefs(c).getString(K_DEVICE, null);
    }

    /** the user's choice: the link runs with the app closed (on unless switched off) */
    static boolean background(Context c) {
        return prefs(c).getBoolean(K_BACKGROUND, true);
    }

    static String server(Context c) {
        return GenyServerPlugin.server(c);
    }

    static String token(Context c) {
        return prefs(c).getString(K_TOKEN, null);
    }

    /** a server, a device, a token, and a sign-in that is remembered (not one for this start only) */
    static boolean ready(Context c) {
        return server(c) != null && device(c) != null && token(c) != null && !GenyServerPlugin.ephemeral(c);
    }

    /** signed out or another server: nothing of the old one is kept */
    static void forget(Context c) {
        prefs(c).edit().remove(K_TOKEN).remove(K_DEVICE).apply();
    }

    /** a token's expiry (unix seconds; 0: unreadable) — its payload is base64url JSON {sub, exp} */
    static long expiry(String token) {
        try {
            int dot = token.lastIndexOf('.');
            if (dot <= 0) return 0;
            byte[] raw = Base64.decode(token.substring(0, dot), Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            return new JSONObject(new String(raw, StandardCharsets.UTF_8)).optLong("exp", 0);
        } catch (Exception e) {
            return 0;
        }
    }

    /** keep `token` if it outlives the one kept */
    static void offer(Context c, String token) {
        if (token == null || token.isEmpty()) return;
        String have = token(c);
        if (have != null && expiry(have) >= expiry(token)) return;
        prefs(c).edit().putString(K_TOKEN, token).apply();
    }

    /** the session token in a Cookie / Set-Cookie value, or null */
    static String fromCookie(String header) {
        if (header == null) return null;
        for (String part : header.split(";")) {
            String p = part.trim();
            if (p.startsWith(COOKIE + "=")) {
                String v = p.substring(COOKIE.length() + 1).trim();
                return v.isEmpty() ? null : v;
            }
        }
        return null;
    }

    /** the fresh token an answer carries (the server re-issues it on every signed-in request) */
    static void fromResponse(Context c, HttpURLConnection con) {
        try {
            Map<String, List<String>> headers = con.getHeaderFields();
            if (headers == null) return;
            for (Map.Entry<String, List<String>> h : headers.entrySet()) {
                if (h.getKey() == null || !"set-cookie".equalsIgnoreCase(h.getKey()) || h.getValue() == null) continue;
                for (String v : h.getValue()) offer(c, fromCookie(v));
            }
        } catch (Exception ignored) {
            // no headers: the old token stays
        }
    }

    /** POST `path` (e.g. /api/mate-calls/…/decline) signed in, on a thread of its own; best effort. `done` runs after. */
    static void post(Context c, String path, Runnable done) {
        Context app = c.getApplicationContext();
        new Thread(() -> {
            HttpURLConnection con = null;
            try {
                String base = server(app);
                String tok = token(app);
                if (base == null || tok == null) return;
                con = (HttpURLConnection) new URL(base + path).openConnection();
                con.setRequestMethod("POST");
                con.setConnectTimeout(10_000);
                con.setReadTimeout(15_000);
                con.setRequestProperty("Authorization", "Bearer " + tok);
                con.setRequestProperty("Content-Type", "application/json");
                con.setDoOutput(true);
                try (OutputStream o = con.getOutputStream()) {
                    o.write("{}".getBytes(StandardCharsets.UTF_8));
                }
                con.getResponseCode();
                fromResponse(app, con);
            } catch (Exception ignored) {
                // the page (or the ring running out) settles it
            } finally {
                if (con != null) con.disconnect();
                if (done != null) done.run();
            }
        }, "geny-link-post").start();
    }
}
