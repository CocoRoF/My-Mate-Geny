package me.hrletsgo.harnessor;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a reboot or an update of the app: the checks with the app closed (GenyCheck) and, when switched on, the
 *  real-time line (GenyLinkService) come back by themselves. */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            GenyCheck.schedule(context);
            GenyLinkService.sync(context);
        }
    }
}
