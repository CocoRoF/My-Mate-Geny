// Settings → Device sign-in (components/settings/DevicesTab.tsx, docs/geny-net.md).
export default {
  tab: "Device sign-in",
  on: "On",
  off: "Off",

  // ---- local execution: Geny Net
  pairTitle: "Connect a phone",
  pairHelp:
    "Scan this code with the My Mate Geny app on your phone (Connect with QR). Both screens then show the same six digits — allow it here and the phone reaches this computer directly on the same network, and from anywhere through the relay. Everything is end-to-end encrypted: the phone keeps a key of its own that never leaves it, and the relay only passes on bytes it can't read. A code pairs one phone and lasts 5 minutes. When this computer is off or the app is closed, the phone can't reach it.",
  showQr: "Show QR code",
  scanCaption: "Android app → Connect with QR",
  left: "{time} left",
  expired: "The code expired.",
  again: "New code",
  asks: "{name} wants to connect",
  sasHint: "Allow it if the phone shows the same number.",
  allow: "Allow",
  deny: "Deny",
  paired: "{name} is connected",
  devicesTitle: "Connected devices",
  online: "Connected now",
  never: "Not connected yet",
  viaLan: "Same network",
  viaRelay: "Relay",
  removeConfirm: "Disconnect {name} and remove it? To use it again, connect it with a new QR code.",
  waysTitle: "How the phone reaches this computer",
  lan: "Directly on the same network",
  lanHelp: "On the same Wi-Fi the phone connects straight to this computer. If your firewall asks, allow My Mate Geny on private networks.",
  relay: "From anywhere (relay)",
  relayHelp:
    "On another network the phone and this computer meet at a relay — both connect out to it, so no port has to be opened. The relay can't read anything: the encryption runs from the phone to this computer. Any My Mate Geny server started with NET_RELAY=1 can be the relay.",
  relayUrl: "Relay address",
  relayOnline: "Connected",
  relayConnecting: "Connecting",
  relayOffline: "Can't reach it",
  hereTitle: "This device",
  here: "Connected to {name} over Geny Net",
  forget: "Disconnect this phone",
  forgetConfirm: "Remove this phone's connection? To use it again, connect it with a new QR code.",

  // ---- server execution: a sign-in code
  loginTitle: "Sign in on a phone",
  loginHelp:
    "Scan this code with the My Mate Geny app on your phone (Connect with QR): it signs in to this server with this account. A code works once, for 5 minutes.",
  server: "Server",
  account: "Account",
  getApp: "Get the Android app",
};
