# Geny Net — your phone on your desktop app

Settings → **디바이스 인증** (Device sign-in) shows a QR code. The My Mate Geny Android app scans it
from its connect screen (**Connect with QR code**). What happens next depends on where the console runs.

* **Server execution**: the code signs the phone in to this server with the account that is signed in now
  (§ 6).
* **Local execution** (the desktop app): the code pairs the phone with this computer. From then on the phone reaches
  the computer's own backend:
  * directly on the same network;
  * from anywhere else through a relay.

  Either way the traffic is end-to-end encrypted. There is no VPN app to install, no account with anyone, and no port
  to open on the router. When the computer is off or the app is closed, the phone can't reach it, and the app says so.

It plays the role a mesh VPN (Tailscale and the like) would, but it is built into the two apps:

* the phone installs nothing else;
* it isn't tied to anyone's service terms;
* the relay is any My Mate Geny server, including your own.

## 1. The pieces

```
phone (Android app)                                        desktop app (local backend)
 WebView ── http://127.0.0.1:<p> ─┐                         ┌─ TLS listener 0.0.0.0:<port>  (app/net/service.py)
 GenyLink / GenyCheck (native) ───┤  GenyNet proxy          │     │  piped, byte for byte, into
                                  └─ (GenyNet.java) ──TLS──►│     ▼
                                       │  LAN: straight      │  ingress: 127.0.0.1:<ingress>  (local_main.py's 2nd socket)
                                       │  else: WebSocket ──►│     │  app/net/ingress.py: who is it, what may it reach
                                       ▼                     │     ▼
                                   relay (any server         │  the app (signed in as the owner)
                                   with NET_RELAY=1)  ◄──────┘  the node's own line to the relay (relay_client.py)
```

**Node.** The desktop's local backend is its own certificate authority (`app/net/identity.py`):

* Its keys live in `<data>/net/` (mode 0600). Nothing exists there until a phone is paired for the first time.
* The CA uses an EC P-256 key.
* The **node id** is the SHA-256 of the CA's public key, as 26 base32 characters (130 bits).
* The listener's certificate is `<node id>.geny.net`, valid for 825 days. The node issues it under its own CA, and
  the name is never looked up in DNS.

**Listener.** The listener speaks TLS 1.3, or TLS 1.2 with forward-secret AEAD suites only (Android 7–9).

* It listens on the LAN, and on loopback only when "directly on the same network" is off.
* It keeps the same port across starts.
* It asks every connection for a client certificate.
  * With a certificate this node issued to a device that is still listed, the connection is that device.
  * Without one, the connection may only pair (§ 3): at most 8 at once.
  * Anything else is closed.

**Ingress.** The backend has a second loopback socket (`NET_INGRESS_PORT`). Only the listener's pipes connect to it:

* The listener records each pipe's local port before the first byte goes in.
* The ASGI layer `NetIngress`, outermost, looks the connection up by that port. It refuses a connection it doesn't
  know, such as another program on this machine.
* uvicorn runs with `proxy_headers=False` (local_main.py), so the client address is always the socket's own.

**Relay.** A relay joins a phone that is away from home to its computer (`app/net/relay.py`). Both connect out to it,
and it forwards bytes it can't read. See § 4.

**Phone.** `GenyNet.java` + `Relay.java` + `GenyNetPlugin.java`. See § 5.

## 2. What a paired phone can do

A request that came over Geny Net is signed in as the owner. The session cookie is put on the request at the ingress;
the phone never holds a session. The phone's only credential is its Keystore key, which can't leave the phone. The
sliding session cookie the app re-issues is taken off the answer before it goes to the phone.

The phone gets the whole console: chats, mates, voice, calls, files. A few things stay with the computer alone:

| path | why |
|---|---|
| `/api/internal/*`, `/api/local/*` | loopback-only calls (the mate bridges, the desktop shell's bootstrap) |
| `/api/net/*` except `GET /api/net/status` | the device list and pairing: a phone can't add another phone or remove the others |
| `/api/net/pair/*` from a paired phone | pairing is for phones without a certificate |

The ingress also controls what the app sees about the connection:

* It drops `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP` and `Forwarded`, along with the phone's own `Cookie`
  and `Authorization` values for the session.
* The client address the app sees is the phone's LAN address, or `100.64.0.1` for a relayed phone. It is never
  loopback, so nothing that trusts "this machine" trusts the phone.

On the computer's own socket, the pairing calls return 404: pairing only ever happens over Geny Net.

## 3. Pairing

1. The desktop shows a code (`POST /api/net/offer`): `geny://link?v=1&n=<node id>&f=<CA SHA-256, base64url>&k=<one-time
   secret, 32 bytes>&d=<computer name>&h=<LAN addresses>&p=<port>&r=<relay>`. Rules for a code:
   * it pairs one phone;
   * it lasts 5 minutes;
   * at most 3 codes are live at once;
   * it closes when the tab is left.

   Showing a code starts Geny Net if it wasn't on.
2. The phone parses the code and generates a new EC P-256 key in the **Android Keystore** under a fresh alias. The key
   is non-exportable and lives in hardware on most phones.
3. The phone connects (LAN first, then the relay) and checks the computer with `Pinned`:
   * the chain must contain the certificate whose SHA-256 is `f`;
   * that certificate must sign the leaf;
   * the leaf must carry the server-auth usage, so a phone's certificate can't answer as the computer;
   * the leaf must be named `<n>.geny.net`.
4. The phone posts `POST /api/net/pair/request {pub: SPKI, proof, name, platform}`.
   * `proof` = HMAC-SHA256(secret, `"geny-net-pair|" + node id + "|" + SPKI`). It shows the phone read this code,
     and binds the code to this phone's key and to this computer.
   * The computer finds the live code whose secret made the proof, and marks it used.
5. Both screens show the same six digits: HMAC-SHA256(secret, `"geny-net-sas|" + SPKI`) mod 10⁶.
   * The phone computes them itself and refuses an answer that doesn't match.
   * The desktop shows the phone's name and the digits. The user allows or denies there
     (`POST /api/net/requests/{id}`).
   * A request waits up to 3 minutes. At most 5 wait at once.
6. The phone long-polls `POST /api/net/pair/result` (25 s per call). Once allowed, it receives its certificate:
   * CN = `d_<16 hex>`, client-auth usage, 825 days;
   * issued for the phone's own public key, so the computer never sees a private key.

   The phone stores the certificate, the pin and how to reach the computer. It drops the key it had for another
   computer (one computer per phone), and opens the console.

What would an attacker need?

| attacker | outcome |
|---|---|
| sees the QR code | must also beat the owner's phone to it, and then still needs the owner to press *Allow* on a request whose name and digits don't match the phone in hand |
| controls the network or the relay | can't read anything, and can't pose as the computer (the pin) or as the phone (its certificate) |
| holds a removed phone | its connections end at once (§ 7); its certificate is refused from then on |

## 4. The relay

Any My Mate Geny server started with `NET_RELAY=1` is a relay. The project's own relay is
`https://agent.hrletsgo.me`; Settings → 디바이스 인증 → *Relay address* changes it. Its routes:

| route | who | what |
|---|---|---|
| `WS /net/relay/host?n=<node>` | the node | answers a challenge with a signature by its CA key (`verify_node`: the key must hash to the id), says its LAN addresses and port, then waits for `{"open": session}` |
| `WS /net/relay/connect?n=<node>` | a phone | the relay asks the node to accept, then pipes the two WebSockets (4404: not online, 4504: it didn't accept in 12 s) |
| `WS /net/relay/accept?n=&s=&sig=` | the node, per session | signed again (`"geny-net-accept|" + session`) |
| `GET /net/relay/where?n=<node>` | a phone | `{online, lan, port}`: so a phone away from home tries the computer directly next time |

What the relay knows:

* which node ids are online;
* the private addresses a node reported;
* how many bytes went by.

It can't read anything: inside each pipe is the TLS between the phone and the computer (§ 3). Limits:

* 32 sessions per node;
* 240 connects per minute per client IP;
* 1 MiB per frame;
* a node that connects again replaces its old line.

The node holds its line with pings every 25 s, so a quiet line stays up through Cloudflare. It reconnects with backoff
from 1 s up to 60 s.

## 5. The phone

**The proxy.** The app runs a loopback proxy, `http://127.0.0.1:<port>`.

* The port is chosen at random once and kept.
* `GenyApp` starts it in every process start once a computer is paired: the activity, the background checks, the call
  line, after a reboot.
* The WebView loads the console from it. `127.0.0.1` is a secure context, so the microphone works without any
  certificate to install.
* The background link (`GenyLink`, `GenyCheckWorker`, `GenyLinkService`) talks to it too.

**Who may use the proxy.** Every connection's first request must carry the app's own pass:

* the `geny_net` cookie, which is HttpOnly, set for that address only, and used by the WebView;
* or `Authorization: Bearer <pass>`, used by the native requests (`GenyLink.token()` hands it out on Geny Net).

Anything else gets 403, so other apps on the phone can't use the link.

**Connections.** Each local connection becomes one TLS connection to the computer:

* The phone tries the LAN first. All the addresses race, with a 1.2 s timeout.
* If the LAN didn't work in the last 30 s, it goes straight to the relay. The relay's WebSocket (OkHttp) is bridged to
  a loopback socket pair, and Java's TLS runs over it.
* When the computer can't be reached, the connection closes without an answer, and the app shows its offline screen.
* After a relayed connection, the phone asks the relay where the computer is now (at most every 5 minutes), for the
  next direct try.

**Codes from outside the app.** A `geny://` code opened from outside the app (scanned with the camera app, or a link)
asks first: it would leave the server the app is on. In the app, *Connect with QR code* follows the code it scanned.

## 6. Server execution: a sign-in code

`POST /api/net/login-code {origin}` → `geny://login?v=1&u=<server>&c=<code>`.

* `origin` is the address the console was opened at.
* The code is a one-time exchange code for the current session, valid for 5 minutes (`create_exchange_code(ttl=…)`).
* The phone opens `<server>/auth/exchange?code=…`, the same first-party cookie flow its password sign-in ends in
  (docs/auth.md), and stays signed in to that account.
* Closing the code cancels it (`/api/net/login-code/cancel`).

## 7. Devices

The device list shows each phone's name, when it was last seen and over which way (LAN or relay), and whether it is
connected now.

* **Rename:** changes the name shown in the list.
* **Remove:** revokes the phone's certificate and cancels its live pipes, so its connections end at once rather than
  when it next speaks.
* With no phone left (and no code on screen), the listener and the relay line stop: a machine that has paired nothing
  listens on nothing.
* On the phone, *Disconnect this phone* removes the phone's own pairing and key. The computer keeps listing the phone
  until it is removed there.

## 8. Settings

| setting | default |
|---|---|
| *Directly on the same network* | on. Off: the listener is on loopback only, and the relay is the only way in |
| *From anywhere (relay)* | on |
| *Relay address* | `https://agent.hrletsgo.me` |

The settings are stored in `net_settings`, and devices in `net_devices`, both in the app's database.

On Windows or macOS, the first LAN listen may bring up the firewall's question. If it is denied, the relay still
works.

## 9. Tests

* `backend/tests/test_net.py` runs the backend for real: uvicorn on its two sockets, the TLS listener, and the relay
  routes on the same app. A Python TLS client acts as the phone. It covers:
  * pairing, with the six digits, the desktop's approval over HTTP, and one code for one phone;
  * the paired phone's requests and its WebSocket;
  * what it can't reach;
  * a forged forwarding header;
  * the ingress refusing connections it didn't open;
  * removal ending a held-open connection;
  * a full request through the relay, with TLS over the WebSocket;
  * a node id claimed with someone else's key;
  * the server sign-in code.
* `mobile/test/connect.test.js` covers the connect page's code parsing.
