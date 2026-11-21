// The usage bar under the conversations (components/layout/SystemBar.tsx, docs/monitoring.md "Usage bar")
const sysbar = {
  title: "System usage",
  host: "Machine: {host}",
  cores: { one: "{count} core", other: "{count} cores" },
  geny: "Geny itself: {mem} GB memory · {cpu}% CPU",
  open: "Click for the whole picture (Settings → Admin → System)",
  connecting: "Reading system usage…",
  offline: "Reconnecting…",
  off: "The system monitor is off on this server",
  alerts: { one: "{count} alert", other: "{count} alerts" },
  hide: "Hide the usage bar",
  hideHint: "Hide — turn it on again in Settings → Theme",
  closed: "Usage bar hidden. Turn it on again in Settings → Theme.",
  setting: "System usage bar",
  settingHint:
    "A thin bar under the mate and chat conversations: how busy the machine Geny runs on is — CPU, memory, GPU load, video memory and temperature, the network. This device only.",
};
export default sysbar;
