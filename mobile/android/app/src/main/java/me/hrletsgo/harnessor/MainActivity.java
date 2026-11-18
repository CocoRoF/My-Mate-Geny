package me.hrletsgo.harnessor;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.view.ViewGroup;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;
import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {

    private static final Pattern FILENAME_STAR = Pattern.compile("filename\\*\\s*=\\s*(?:UTF-8|utf-8)''([^;]+)");
    private static final Pattern FILENAME = Pattern.compile("filename\\s*=\\s*\"?([^\";]+)\"?");

    /** Launcher shortcut (res/xml/shortcuts.xml): back to the connect page. */
    static final String ACTION_SWITCH_SERVER = "me.hrletsgo.harnessor.SWITCH_SERVER";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The server is the user's choice (GenyServerPlugin): no saved server →
        // the local connect page; a saved one → Capacitor's server.url.
        Intent intent = getIntent();
        if (intent != null && ACTION_SWITCH_SERVER.equals(intent.getAction())) {
            if (savedInstanceState == null) GenyServerPlugin.forgetServer(this, false);
            setIntent(new Intent(Intent.ACTION_MAIN)); // handled once (BridgeActivity re-delivers it below)
        }
        boolean ringing = GenyCallPlugin.isCallIntent(intent);
        if (ringing) {
            // her call notification brought the app up: the page hears it once the plugin is there
            answering(intent);
            GenyCallPlugin.deliverLater(intent);
            setIntent(new Intent(Intent.ACTION_MAIN));
        }
        // a geny:// code opened from outside the app (the camera app, a browser): asked about before anything happens
        String link = savedInstanceState == null ? genyLink(intent) : null;
        if (link != null) setIntent(new Intent(Intent.ACTION_MAIN));
        registerPlugin(GenyServerPlugin.class);
        registerPlugin(GenyCallPlugin.class);
        registerPlugin(GenyNetPlugin.class);
        // on the paired computer (Geny Net): its proxy up and the WebView's pass to it set before the page loads
        GenyNet.ensureProxy(this);
        if (GenyNet.active(this)) GenyNet.allowWebView(this);
        config = GenyServerPlugin.buildConfig(this);
        super.onCreate(savedInstanceState);
        // The Mate reads replies aloud when they arrive (not inside a tap), so
        // media may start without a user gesture. Microphone requests are
        // handled by Capacitor's BridgeWebChromeClient (runtime permission).
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        // (her ringing brought it up over the lock screen: it stays there until the page takes or ends the call)
        if (ringing) GenyCallPlugin.overLock(this, true);
        if (link != null && GenyServerPlugin.server(this) != null) askLink(link);
        // the background link, so her calls ring with the app closed (GenyLinkService): on if it should be
        GenyLinkService.sync(this);
        GenyCheck.schedule(this); // (her calls and messages with the app closed: checks now and then, no line held)
        // light / dark as the console last chose (ThemeBars): the window, the WebView behind the page and the bars,
        // before the page draws (the console says it again once loaded: GenyServer.setTheme)
        ThemeBars.apply(this, getBridge().getWebView(), ThemeBars.mode(this));
        // Capacitor's WebView has no DownloadListener: without this, download
        // links (file viewer, explorer, attachments, Download page) do nothing.
        // The download runs in DownloadManager with the console's login cookie.
        getBridge().getWebView().setDownloadListener((url, userAgent, disposition, mimeType, length) -> {
            try {
                String name = fileName(url, disposition, mimeType);
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null) req.addRequestHeader("Cookie", cookies);
                req.addRequestHeader("User-Agent", userAgent);
                if (mimeType != null && !mimeType.isEmpty()) req.setMimeType(mimeType);
                req.setTitle(name);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                } else {
                    // Android 7–9: the public folder would need a storage permission
                    req.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
                }
                ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(req);
                Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // the phone's dark theme switched (uiMode is handled here, no restart): "system" follows it
        if (getBridge() != null) ThemeBars.apply(this, getBridge().getWebView(), ThemeBars.mode(this));
    }

    @Override
    public void onStart() {
        super.onStart();
        GenyCheck.back(this); // (in front: the page has her messages and her ringing)
    }

    @Override
    public void onStop() {
        super.onStop();
        // Away (closed, another app, the screen off): the page goes quiet (lib/appState.ts) and nothing of it runs on —
        // a call goes on (its service holds the microphone). Her answer on its way shows soon after (GenyCheck).
        if (!GenyCallPlugin.calling()) GenyCheck.soon(this);
    }

    @Override
    public void onPause() {
        super.onPause();
        // the login cookie to disk now: a swiped-away app must not lose it
        try {
            CookieManager.getInstance().flush();
        } catch (Exception ignored) {
            // no WebView provider
        }
    }

    @Override
    public void onDestroy() {
        // Switching servers recreates the activity; the old WebView (and the
        // page it held) must go with it rather than linger until GC.
        WebView old = getBridge() != null ? getBridge().getWebView() : null;
        super.onDestroy();
        if (old != null) {
            try {
                old.stopLoading();
                if (old.getParent() instanceof ViewGroup) ((ViewGroup) old.getParent()).removeView(old);
                old.destroy();
            } catch (Exception ignored) {
                // already gone
            }
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        if (GenyCallPlugin.isCallIntent(intent)) {
            answering(intent);
            // her ringing (its full-screen intent on a locked phone, or a tap): the app over the lock screen, the screen on
            GenyCallPlugin.overLock(this, true);
            // a tap on her call notification (open / 수락 / 거절): to the page (docs/mate-calls.md)
            PluginHandle h = getBridge() != null ? getBridge().getPlugin("GenyCall") : null;
            if (h != null && h.getInstance() instanceof GenyCallPlugin) ((GenyCallPlugin) h.getInstance()).deliver(intent);
            else GenyCallPlugin.deliverLater(intent);
            setIntent(new Intent(Intent.ACTION_MAIN));
            return;
        }
        if (intent != null && ACTION_SWITCH_SERVER.equals(intent.getAction())) {
            GenyServerPlugin.forgetServer(this, false);
            setIntent(new Intent(Intent.ACTION_MAIN));
            recreate();
            return;
        }
        String link = genyLink(intent);
        if (link != null) {
            setIntent(new Intent(Intent.ACTION_MAIN));
            if (GenyServerPlugin.server(this) == null) recreate(); // (the connect page takes it up, and asks)
            else askLink(link);
            return;
        }
        super.onNewIntent(intent);
    }

    /** geny://link (pair with a computer) or geny://login (sign in to a server), or null. On the connect page it is
     *  kept for the page (which asks first); in the console the user is asked here (askLink) — a link can come from
     *  anywhere, and following it leaves the server the app is on. */
    private String genyLink(Intent intent) {
        Uri u = intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) ? null : intent.getData();
        if (u == null || !"geny".equals(u.getScheme())) return null;
        if (GenyServerPlugin.server(this) == null) GenyNet.incoming(this, u.toString(), false);
        return u.toString();
    }

    private void askLink(String link) {
        Uri u = Uri.parse(link);
        boolean login = "login".equals(u.getHost());
        String where = login ? String.valueOf(GenyServerPlugin.cleanBase(u.getQueryParameter("u"))) : u.getQueryParameter("d");
        if (!login && (where == null || where.isEmpty())) where = getString(R.string.link_ask_pair_any);
        new androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(login ? R.string.link_ask_login : R.string.link_ask_pair)
            .setMessage(getString(login ? R.string.link_ask_login_text : R.string.link_ask_pair_text, where))
            .setPositiveButton(R.string.link_ask_go, (d, w) -> {
                GenyNet.incoming(this, link, true);
                GenyServerPlugin.forgetServer(this, false); // (to the connect page, which goes on with it)
                recreate();
            })
            .setNegativeButton(R.string.link_ask_cancel, null)
            .show();
    }

    /** 받기 on her ringing: the server holds the call while the page comes up to take it (it would go missed meanwhile) */
    private void answering(Intent intent) {
        String id = intent.getStringExtra(GenyCallPlugin.EXTRA_ID);
        if (!GenyCallPlugin.ACTION_ACCEPT.equals(intent.getAction()) || id == null || !id.matches("[A-Za-z0-9_-]{1,80}")) return;
        CallNotifier.cancelRing(this, id);
        GenyLink.post(this, "/api/mate-calls/" + id + "/answering", null);
    }

    /** Name from Content-Disposition (RFC 5987 first, so Korean names survive), else guessed. */
    static String fileName(String url, String disposition, String mimeType) {
        String name = null;
        if (disposition != null) {
            Matcher m = FILENAME_STAR.matcher(disposition);
            if (m.find()) {
                try {
                    name = URLDecoder.decode(m.group(1).trim(), "UTF-8");
                } catch (Exception ignored) {
                    // fall through
                }
            }
            if (name == null) {
                m = FILENAME.matcher(disposition);
                if (m.find()) name = m.group(1).trim();
            }
        }
        if (name == null || name.isEmpty()) name = URLUtil.guessFileName(url, disposition, mimeType);
        return name.replaceAll("[/\\\\:*?\"<>|]", "_");
    }
}
