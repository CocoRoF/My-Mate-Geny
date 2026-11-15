package me.hrletsgo.harnessor;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * One check-in (GenyCheck): ``GET /api/mate-calls/link?checkin=1&since=`` for a few seconds — the server says what the
 * mates said that nobody has seen since the last check (shown as their messages), and rings if she would call now (the
 * line stays open while she rings: taken, turned down, or missed — a missed one stays in the shade); then ``bye``.
 */
public class GenyCheckWorker extends Worker {

    private static final int READ_TIMEOUT_MS = 60_000; // (the server pings every 45 s; a check-in lasts seconds)

    public GenyCheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        // (the app in front: the page has it all — her messages on screen, her ringing on the page)
        if (!GenyLink.ready(c) || GenyCallPlugin.front()) return Result.success();
        SharedPreferences prefs = GenyLink.prefs(c);
        String since = prefs.getString(GenyCheck.K_SINCE, "");
        String result = "offline";
        HttpURLConnection con = null;
        try {
            String url = GenyLink.server(c) + "/api/mate-calls/link?checkin=1&device=" + enc(GenyLink.device(c))
                    + (since.isEmpty() ? "" : "&since=" + enc(since));
            con = (HttpURLConnection) new URL(url).openConnection();
            con.setConnectTimeout(15_000);
            con.setReadTimeout(READ_TIMEOUT_MS);
            con.setUseCaches(false);
            con.setRequestProperty("Authorization", "Bearer " + GenyLink.token(c));
            con.setRequestProperty("Accept", "text/event-stream");
            int code = con.getResponseCode();
            GenyLink.fromResponse(c, con);
            if (code == 401 || code == 403) {
                result = "signed_out";
                return Result.success();
            }
            if (code != 200) return Result.success();
            BufferedReader r = new BufferedReader(new InputStreamReader(con.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder data = new StringBuilder();
            String line;
            boolean done = false;
            while (!done && !isStopped() && (line = r.readLine()) != null) {
                if (line.startsWith("data:")) {
                    data.append(line.substring(5).trim());
                } else if (line.isEmpty() && data.length() > 0) {
                    done = handle(c, prefs, data.toString());
                    data.setLength(0);
                }
            }
            result = "ok";
        } catch (Exception e) {
            result = "offline";
        } finally {
            if (con != null) con.disconnect();
            prefs.edit().putLong(GenyCheck.K_LAST, System.currentTimeMillis()).putString(GenyCheck.K_RESULT, result).apply();
        }
        return Result.success();
    }

    /** one event → whether the check-in is over */
    private static boolean handle(Context c, SharedPreferences prefs, String raw) {
        JSONObject m;
        try {
            m = new JSONObject(raw);
        } catch (Exception e) {
            return false;
        }
        switch (m.optString("type")) {
            case "hello":
                GenyLinkService.ringFrom(c, m.optJSONObject("ring"));
                return false;
            case "notices":
                JSONArray items = m.optJSONArray("items");
                for (int i = 0; items != null && i < items.length(); i++) {
                    JSONObject n = items.optJSONObject(i);
                    if (n == null) continue;
                    CallNotifier.message(c, n.optString("id"), n.optString("mate_id"), n.optString("name"), n.optString("text"),
                            when(n.optString("at")));
                }
                String now = m.optString("now", "");
                if (!now.isEmpty()) prefs.edit().putString(GenyCheck.K_SINCE, now).apply();
                return false;
            case "call.ring":
                GenyLinkService.ringFrom(c, m.optJSONObject("data"));
                return false;
            case "call.update":
                GenyLinkService.updateFrom(c, m.optJSONObject("data"));
                return false;
            case "bye":
                return true;
            default:
                return false; // ping
        }
    }

    /** an ISO time from the server → ms (now when unreadable) */
    private static long when(String iso) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                return java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli();
            } catch (Exception ignored) {
                // below
            }
        }
        return System.currentTimeMillis();
    }

    private static String enc(String s) throws java.io.UnsupportedEncodingException {
        return URLEncoder.encode(s == null ? "" : s, "UTF-8");
    }
}
