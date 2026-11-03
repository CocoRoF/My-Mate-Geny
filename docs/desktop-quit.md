# Desktop Quit

Tray Quit, native application Quit and termination signals use `desktop/src/quit.js`. Window X/Alt+F4 and
avatar Hide retain their existing window/hide meaning. Quit sets both native close-to-tray guards first,
prevents second-instance/activate callbacks from opening UI, stops the device controller/capture requests,
shortcuts and tray timers, cancels updater downloads and disables install-on-quit. Only an explicit Restart &
install may run the update/relaunch path. Start-at-login and persistent device sharing intent are retained;
there is no periodic auto-start after Quit.

Responsive renderers receive `app:quitting`: STT cancels without submitting a final fragment, speech stops,
screen streams and pending uploads are released. Native renderer destruction releases OS media resources even
when JavaScript hangs. During Quit, `will-prevent-unload` vetoes are ignored. After five seconds, remaining
windows are destroyed and Electron exits; normal window close still respects unload handling.

The fixed baseline reproduced a tray callback reaching `app.quit()` but remaining alive when an unload veto
was installed. Normal, sharing and hidden-autostart exits worked on Linux. This reproduces a failure path;
it does not prove that the reporting Windows machine hit that same path. Main logs now record the request,
cleanup errors, ignored unload veto, deadline fallback and completed exit without conversation/image data.

Regression: `desktop/test/quit.test.js`, updater async cancellation tests, and
`desktop/test/e2e/tray-quit-e2e.js`: real Electron/X11/native menu callbacks with manual/hidden startup,
all windows + sharing, unload/close veto and unresponsive renderer. Detach the Node main-process inspector
before checking process exit, otherwise Node itself waits for the debugger. Windows Explorer tray routing,
Task Manager helper cleanup, actual Windows audio devices and Windows logon remain hardware-unverified.
