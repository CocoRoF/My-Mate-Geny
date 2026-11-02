package me.hrletsgo.harnessor;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/**
 * Light / dark for the app's own parts (the console's Settings → Appearance, frontend/src/lib/theme.ts): the
 * window and WebView colour behind the page (no dark frame around a light console, no flash at start), the
 * status / navigation bars' colour (Android 14 and older draw one) and their icons. The console tells the mode
 * through GenyServer.setTheme; it is kept here so the next start (and the local connect / offline pages) use it
 * before the console loads. "system" follows the phone's dark theme.
 */
final class ThemeBars {

    static final String K_THEME = "themeMode"; // system | light | dark (GenyServerPlugin.PREFS)
    static final int BG_DARK = 0xFF0A0C10;
    static final int BG_LIGHT = 0xFFF1F3F7;

    private ThemeBars() {}

    static String mode(Context c) {
        String m = GenyServerPlugin.prefs(c).getString(K_THEME, "system");
        return "light".equals(m) || "dark".equals(m) ? m : "system";
    }

    static void save(Context c, String mode) {
        GenyServerPlugin.prefs(c).edit().putString(K_THEME, mode).apply();
    }

    /** the theme drawn for a mode: true = dark */
    static boolean dark(Context c, String mode) {
        if ("dark".equals(mode)) return true;
        if ("light".equals(mode)) return false;
        int night = c.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return night == Configuration.UI_MODE_NIGHT_YES;
    }

    /** paint the window, the WebView and the bars for this mode (on the UI thread) */
    @SuppressWarnings("deprecation")
    static void apply(Activity a, WebView web, String mode) {
        if (a == null) return;
        boolean dark = dark(a, mode);
        int bg = dark ? BG_DARK : BG_LIGHT;
        try {
            Window w = a.getWindow();
            View decor = w.getDecorView();
            decor.setBackgroundColor(bg);
            if (web != null) web.setBackgroundColor(bg);
            if (Build.VERSION.SDK_INT < 35) {
                // before Android 15 the bars have a colour of their own
                w.setStatusBarColor(bg);
                w.setNavigationBarColor(bg);
            }
            WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(w, decor);
            bars.setAppearanceLightStatusBars(!dark);
            bars.setAppearanceLightNavigationBars(!dark);
        } catch (Exception ignored) {
            // no window yet / gone
        }
    }
}
