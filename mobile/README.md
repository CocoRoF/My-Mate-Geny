# hr-harnessor mobile (Expo)

Minimal React Native client for the hr-harnessor backend. Lists sessions and
streams chat over the same `/ws/chat/{id}` WebSocket the web UI uses.

## Run

```bash
cd mobile
npm install
# set the backend URL for your phone/emulator in app.json > expo.extra.apiBaseUrl
#   (use your 2223 server's LAN IP, or a Cloudflare tunnel URL)
npm start           # then press a (Android) / i (iOS), or scan the QR in Expo Go
```

## Status

Scaffold: sessions list + chat screen wired to the backend. Session creation,
provider connect, and the workspace picker are web-only for now — build them
out here when the mobile flow is prioritized.
