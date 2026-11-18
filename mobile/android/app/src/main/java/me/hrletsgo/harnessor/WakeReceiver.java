package me.hrletsgo.harnessor;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The alarm set for her alarm went off (GenyWakes): a check-in now, to be on the line when she calls. */
public class WakeReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        GenyWakes.fired(context);
    }
}
