# Geny Net — your phone on your desktop app

Settings → **디바이스 인증** (Device sign-in) shows a QR code. The My Mate Geny Android app scans it
from its connect screen (**Connect with QR code**). What happens next depends on where the console runs.

* **Server execution**: the code signs the phone in to this server with the account that is signed in now
  (§ 6).
* **Local execution** (the desktop app): the code pairs the phone with this computer. From then on the phone reaches
  the computer's own backend:
  * directly on the same network;
  * from the internet, directly through a port the computer's own router forwards to it (UPnP / NAT-PMP, § 4).

  No server of anyone's is in between, and either way the traffic is end-to-end encrypted. There is no VPN app to
  install, no account with anyone, and nothing to set up on the router by hand. When the computer is off or the app is
  closed, the phone can't reach it, and the app says so. Where the router can't forward a port (§ 4), the phone
  connects only on the same network.

It plays the role a mesh VPN (Tailscale and the like) would, but it is built into the two apps:

* the phone installs nothing else;
* it isn't tied to anyone's service terms or servers.

## 1. The pieces

```
phone (Android app)                                         desktop app (local backend)
 WebView ── http://127.0.0.1:<p> ─┐                          ┌─ TLS listener 0.0.0.0:<port>  (app/net/service.py)
 GenyLink / GenyCheck (native) ───┤  GenyNet proxy           │     │  piped, byte for byte, into
                                  └─ (GenyNet.java) ──TLS──► │     ▼
                                       LAN: straight         │  ingress: 127.0.0.1:<ingress>  (local_main.py's 2nd socket)
                                       internet: the router's│     │  app/net/ingress.py: who is it, what may it reach
                                       forwarded port ──────►┘     ▼
                                       (app/net/portmap.py)       the app (signed in as the owner)
```

**Node.** The desktop's local backend is its own certificate authority (`app/net/identity.py`):

* Its keys live in `<data>/net/` (mode 0600). Nothing exists there until a phone is paired for the first time.
* The CA uses an EC P-256 key.
* The **node id** is the SHA-256 of the CA's public key, as 26 base32 characters (130 bits).
* The listener's certificate is `<node id>.geny.net`, valid for 825 days. The node issues it under its own CA, and
  the name is never looked up in DNS.

**Listener.** The listener speaks TLS 1.3, or TLS 1.2 with forward-secret AEAD suites only (Android 7–9). It may be
on the internet (§ 4), so:

* It takes plain TCP first, and refuses an address that keeps failing before any TLS work: 10 failures in 10 minutes
  block that address for 30 minutes. A failure is a bad handshake, a certificate that isn't a listed phone's, or no
  certificate when nothing is being paired. Loopback (this machine itself) is never blocked.
* A connection without a certificate is answered only while something is being paired: a code on screen, or a phone
  waiting for its answer.

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

**Router.** The node asks its own router to forward a port to the listener (`app/net/portmap.py`). See § 4.

**Phone.** `GenyNet.java` + `GenyNetPlugin.java`. See § 5.

## 2. What a paired phone can do

A request that came over Geny Net is signed in as the owner. The session cookie is put on the request at the ingress;
the phone never holds a session. The phone's only credential is its Keystore key, which can't leave the phone. The
sliding session cookie the app re-issues is taken off the answer before it goes to the phone.

The phone gets the whole console: chats, mates, voice, calls, files. A few things stay with the computer alone:

| path | why |
|---|---|
| `/api/internal/*`, `/api/local/*` | loopback-only calls (the mate bridges, the desktop shell's bootstrap) |
| `/api/net/*` except `GET /api/net/status` and `GET /api/net/where` | the device list and pairing: a phone can't add another phone or remove the others |
| `/api/net/pair/*` from a paired phone | pairing is for phones without a certificate |

The ingress also controls what the app sees about the connection:

* It drops `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP` and `Forwarded`, along with the phone's own `Cookie`
  and `Authorization` values for the session.
* The client address the app sees is the phone's own address (on the LAN, or its public one from the internet). It is
  never loopback, so nothing that trusts "this machine" trusts the phone.

On the computer's own socket, the pairing calls return 404: pairing only ever happens over Geny Net.

## 3. Pairing

1. The desktop shows a code (`POST /api/net/offer`): `geny://link?v=1&n=<node id>&f=<CA SHA-256, base64url>&k=<one-time
   secret, 32 bytes>&d=<computer name>&h=<LAN addresses>&p=<port>&w=<the router's public ip:port>`. Rules for a code:
   * it pairs one phone;
   * it lasts 5 minutes;
   * at most 3 codes are live at once;
   * it closes when the tab is left.

   Showing a code starts Geny Net if it wasn't on.
2. The phone parses the code and generates a new EC P-256 key in the **Android Keystore** under a fresh alias. The key
   is non-exportable and lives in hardware on most phones.
3. The phone connects (the LAN first, then the router's address) and checks the computer with `Pinned`:
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
| controls the network | can't read anything, and can't pose as the computer (the pin) or as the phone (its certificate) |
| holds a removed phone | its connections end at once (§ 7); its certificate is refused from then on |

## 4. From the internet, directly (the router)

With *Open a port on the router automatically* on (the default; it needs *Directly on the same network*), the node
asks its own router to forward one TCP port to the listener. It needs no library:

* **UPnP IGD** (most home routers): SSDP discovery, the device description, then the SOAP calls `AddPortMapping`,
  `GetExternalIPAddress` and `DeletePortMapping`.
  * A one-hour lease is renewed at the half. A router that only keeps permanent mappings gets lease 0, removed when
    Geny Net stops.
  * A port that is taken outside gets another.
* **NAT-PMP** (RFC 6886) when UPnP isn't there. It asks the usual router addresses next to this machine (`a.b.c.1`
  / `.254`).
* Only private addresses are ever contacted: an answer on the LAN can't point the node anywhere else.
* The external port is the listener's own when it's free, and is kept across starts.

The router's public address and port (`ip:port`) go into the QR code (`w=`).

A paired phone asks for the computer's current addresses over the link itself (`GET /api/net/where`), so a home
address that changed is followed.

It can't work in these cases, and the phone then connects only on the same network:

* the router has UPnP / NAT-PMP off;
* the router isn't on a public address itself, because of a second router in front or the provider's carrier-grade
  NAT. The node sees this (the router's "external" address isn't public) and shows *Not possible*.

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

**Connections.** Each local connection becomes one TLS connection to the computer, tried in this order:

1. **The LAN.** All the addresses race, with a 1.2 s timeout.
2. **The router's `ip:port`**, from the internet, with a 2.5 s timeout.

A way that failed in the last 30 s is tried last.

* When the computer can't be reached, the connection closes without an answer, and the app shows its offline screen.
* After a connection, at most every 5 minutes, the phone asks where the computer is now, over the link
  (`/api/net/where`).
* If the page closes only its sending half, the answer still comes back (for up to 30 s).

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

The device list shows each phone's name, when it was last seen and over which way (the LAN, or the internet through
the router), and whether it is connected now.

* **Rename:** changes the name shown in the list.
* **Remove:** revokes the phone's certificate and cancels its live pipes, so its connections end at once rather than
  when it next speaks.
* With no phone left (and no code on screen), the listener stops and the router's forwarded port is removed: a machine
  that has paired nothing listens on nothing.
* On the phone, *Disconnect this phone* removes the phone's own pairing and key. The computer keeps listing the phone
  until it is removed there.

## 8. Settings

| setting | default |
|---|---|
| *Directly on the same network* | on. Off: the listener is on loopback only — no phone can reach it |
| *Open a port on the router automatically* | on (needs the one above) |

The settings are stored in `net_settings`, and devices in `net_devices`, both in the app's database.

On Windows or macOS, the first LAN listen may bring up the firewall's question: allow it (private networks), or no
phone can connect.

## 9. Tests

* `backend/tests/test_net.py` runs the backend for real: uvicorn on its two sockets and the TLS listener. A Python TLS
  client acts as the phone. It covers:
  * pairing, with the six digits, the desktop's approval over HTTP, and one code for one phone;
  * the paired phone's requests and its WebSocket;
  * what it can't reach;
  * a forged forwarding header;
  * the ingress refusing connections it didn't open;
  * removal ending a held-open connection;
  * the server sign-in code.
* `backend/tests/test_net_portmap.py` uses a fake router on loopback (UPnP description + SOAP, NAT-PMP) and covers:
  * mapping with a taken port and with permanent-only leases, and unmapping;
  * *Not possible* behind the provider's NAT;
  * a node offering its router's address in the QR code;
  * an address that keeps failing refused.
* `mobile/test/connect.test.js` covers the connect page's code parsing.

The relay (a server joining a phone and its computer when nothing direct works) was taken out on 2026-11-18; it is in
the history of #61 / #63 if it is ever wanted again.
