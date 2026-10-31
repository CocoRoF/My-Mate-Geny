# hr-harnessor Android

Capacitor shell that loads the live console (`server.url` in
`capacitor.config.json`) with its mobile layout. Native: notifications
(LocalNotifications), hardware back button (closes the top overlay, then
backgrounds the app), status bar/safe areas, file chooser + camera for uploads,
downloads (DownloadManager with the login cookie → Downloads folder),
offline page.

- `npm ci && npx cap sync android && (cd android && ./gradlew assembleRelease)`
- Release signing via env: `HRH_KEYSTORE_FILE`, `HRH_KEYSTORE_PASSWORD`,
  `HRH_KEY_ALIAS`, `HRH_KEY_PASSWORD` (GitHub secrets in CI). Keep the
  keystore: every update must be signed with the same key. A backup lives on
  the runtime server in `~/.hr-harnessor/android-signing/`.
- Icons/splash: `npm run icons` regenerates from `assets/`.
