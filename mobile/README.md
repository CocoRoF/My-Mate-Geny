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

## Auth

The app logs in against `/api/auth/login`, stores the returned **token** in
AsyncStorage, and sends it as `Authorization: Bearer <token>` on REST and as
`?token=` on the chat WebSocket (native clients can't hold the HttpOnly cookie
the web UI uses). Same 7-day sliding session and IP-ban rules apply server-side.

## Screens

- **Login** → **Sessions** (list + logout + new) → **New session** (provider +
  location + workspace path) → **Chat** (streaming turns over WS).

## Status

Functional buildout against the token API (login, sessions, session creation
with provider/location/path, streaming chat). Not yet run on a device/emulator
here — `npm install && npm start`, set `expo.extra.apiBaseUrl` to your
deployment (defaults to https://agent.hrletsgo.me), then open in Expo Go.
Remaining: in-app connection/provider management and store builds.
