"use strict";
// Transient consent/ownership belongs to the app process, never settings.json.
function createSharing({ broadcast, cancel, changed = () => {} }) {
  let owner = null,
    state = null,
    revision = 0;
  const watched = new WeakSet();
  let previousThrottling = null;
  function releaseTimerOwner() {
    if (owner && !owner.isDestroyed() && previousThrottling !== null)
      owner.setBackgroundThrottling?.(previousThrottling);
    previousThrottling = null;
  }
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
    releaseTimerOwner();
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
        releaseTimerOwner();
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
      // A chat can be hidden while its avatar stays visible. Its observation timer must keep running.
      previousThrottling = sender.getBackgroundThrottling?.() ?? true;
      sender.setBackgroundThrottling?.(false);
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
