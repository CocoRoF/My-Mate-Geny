package me.hrletsgo.harnessor;

import android.app.Application;

/** The app's process, however it started (the activity, the background checks, the call line, after a reboot): the
 *  Geny Net proxy is up in it whenever a computer is paired (GenyNet.java) — everything else talks to that. */
public class GenyApp extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        GenyNet.ensureProxy(this);
    }
}
