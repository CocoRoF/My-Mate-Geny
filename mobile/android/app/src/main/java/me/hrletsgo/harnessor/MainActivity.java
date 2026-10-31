package me.hrletsgo.harnessor;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
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
        registerPlugin(GenyServerPlugin.class);
        config = GenyServerPlugin.buildConfig(this);
        super.onCreate(savedInstanceState);
        // The Mate reads replies aloud when they arrive (not inside a tap), so
        // media may start without a user gesture. Microphone requests are
        // handled by Capacitor's BridgeWebChromeClient (runtime permission).
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
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
    protected void onNewIntent(Intent intent) {
        if (intent != null && ACTION_SWITCH_SERVER.equals(intent.getAction())) {
            GenyServerPlugin.forgetServer(this, false);
            setIntent(new Intent(Intent.ACTION_MAIN));
            recreate();
            return;
        }
        super.onNewIntent(intent);
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
