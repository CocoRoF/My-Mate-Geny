// Settings → Device sign-in (components/settings/DevicesTab.tsx, docs/geny-net.md).
export default {
  tab: "Device sign-in",
  on: "On",
  off: "Off",

  // ---- local execution: Geny Net
  pairTitle: "Connect a phone",
  pairHelp:
    "Scan this code with the My Mate Geny app on your phone (Connect with QR). Both screens then show the same six digits — allow it here. From then on the phone reaches this computer directly — on the same network, and from the internet through your router when it can forward a port — with no server in between. Everything is end-to-end encrypted: the phone keeps a key of its own that never leaves it. A code pairs one phone and lasts 5 minutes. When this computer is off or the app is closed, the phone can't reach it.",
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
  viaWan: "Internet (direct)",
  removeConfirm: "Disconnect {name} and remove it? To use it again, connect it with a new QR code.",
  waysTitle: "How the phone reaches this computer",
  lan: "Directly on the same network",
  lanHelp: "On the same Wi-Fi the phone connects straight to this computer. If your firewall asks, allow My Mate Geny on private networks.",
  upnp: "Open a port on the router automatically",
  upnpHelp:
    "This computer asks your router (UPnP or NAT-PMP) to forward one port to it, so your phone reaches it from anywhere on the internet directly — no server in between. It only answers your paired phones. It doesn't work when the router has UPnP off or isn't on a public address itself (a second router in front of it, or the provider's own NAT); then the phone connects only on the same network.",
  upnpOpen: "Open",
  upnpTrying: "Trying",
  upnpUnavailable: "Not possible",
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
