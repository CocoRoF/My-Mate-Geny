package me.hrletsgo.harnessor;

import android.content.Context;
import android.os.Build;
import android.util.AttributeSet;
import android.view.View;
import com.getcapacitor.CapacitorWebView;

/**
 * The app's WebView (res/layout/capacitor_bridge_layout_main.xml, in place of Capacitor's own): during a call
 * (GenyCallPlugin.begin … end) the page goes on as if it were in front with the screen off, the phone at the ear or the
 * app behind another — its timers aren't held back, its voice and microphone aren't treated as a page no one sees, and its
 * renderer keeps its priority. Out of a call it is Capacitor's WebView as it was.
 */
public class CallWebView extends CapacitorWebView {

    private static CallWebView current = null;
    /** what the window really is (VISIBLE, INVISIBLE, GONE) */
    private int actual = View.VISIBLE;
    private boolean held = false;
    private int priorityBefore = -1;
    private boolean waivedBefore = false;

    public CallWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        current = this;
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        actual = visibility;
        super.onWindowVisibilityChanged(held ? View.VISIBLE : visibility);
    }

    /** a call is on: the page runs on as if in front (or, over: as the window really is again) */
    static void hold(boolean on) {
        CallWebView w = current;
        if (w != null) w.post(() -> w.setHeld(on));
    }

    private void setHeld(boolean on) {
        if (held == on) return;
        held = on;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                if (on) {
                    priorityBefore = getRendererRequestedPriority();
                    waivedBefore = getRendererPriorityWaivedWhenNotVisible();
                    setRendererPriorityPolicy(RENDERER_PRIORITY_IMPORTANT, false);
                } else if (priorityBefore >= 0) {
                    setRendererPriorityPolicy(priorityBefore, waivedBefore);
                }
            } catch (Exception ignored) {
                // (a WebView without it: the visibility is what counts)
            }
        }
        if (actual != View.VISIBLE) super.onWindowVisibilityChanged(on ? View.VISIBLE : actual);
    }
}
