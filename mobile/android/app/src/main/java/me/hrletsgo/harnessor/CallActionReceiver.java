package me.hrletsgo.harnessor;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 거절 on her ringing and 끊기 on a call's notification, done without opening the app — like a phone's (docs/mate-calls.md
 * "On Android"): the ring stops at once and the server is told; a page that is open hears it from the server.
 */
public class CallActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String id = intent.getStringExtra(CallNotifier.EXTRA_ID);
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,80}")) return;
        String what;
        if (CallNotifier.ACTION_DECLINE.equals(intent.getAction())) {
            CallNotifier.cancelRing(context, id);
            what = "decline";
        } else if (CallNotifier.ACTION_HANGUP.equals(intent.getAction())) {
            what = "hangup";
        } else {
            return;
        }
        PendingResult done = goAsync(); // (the process stays until the server has it)
        GenyLink.post(context, "/api/mate-calls/" + id + "/" + what, done::finish);
    }
}
