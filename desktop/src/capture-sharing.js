"use strict";
// Transient consent/ownership belongs to the app process, never settings.json.
function createSharing({ broadcast, cancel, changed = () => {} }) {
  let owner = null,
    state = null,
    revision = 0;
  const watched = new WeakSet();
  function snapshot(sender) {
    return { revision, state, owner: !!owner && sender?.id === owner.id };
  }
  function announce() {
    revision++;
    broadcast((w) => snapshot(w));
    changed(!!state, !!state?.capturing);
  }
  function stop() {
    const old = owner;
    owner = null;
    state = null;
    cancel();
    if (old && !old.isDestroyed())
      old.send("capture:control", { type: "stop" });
    announce();
  }
  function publish(sender, next) {
    if (!next) {
      if (owner?.id === sender.id) {
        owner = null;
        state = null;
        announce();
      }
      return snapshot(sender);
    }
    if (
      typeof next.sid !== "string" ||
      !["ask", "on_turn", "observe"].includes(next.mode)
    )
      return snapshot(sender);
    if (owner && owner.id !== sender.id) stop();
    if (!owner) {
      owner = sender;
      if (!watched.has(sender)) {
        watched.add(sender);
        sender.once("destroyed", () => {
          if (owner?.id === sender.id) stop();
        });
      }
    }
    state = {
      sid: next.sid.slice(0, 100),
      name: String(next.name || "").slice(0, 100),
      source: String(next.source || "").slice(0, 200),
      kind: next.kind === "window" ? "window" : "screen",
      mode: next.mode,
      interval: Math.max(60, Math.min(600, Number(next.interval) || 180)),
      capturing: !!next.capturing,
      error: String(next.error || "").slice(0, 400),
    };
    announce();
    return snapshot(sender);
  }
  function mode(value, interval) {
    if (owner && !owner.isDestroyed())
      owner.send("capture:control", { type: "mode", mode: value, interval });
  }
  return { snapshot, publish, stop, mode, active: () => !!state };
}
module.exports = { createSharing };
