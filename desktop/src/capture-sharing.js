"use strict";
// Runtime ownership is transient; explicit sharing intent is stored in device preferences.
function createSharing({ broadcast, cancel, preferences, changed = () => {} }) {
  let owner = null,
    state = null,
    revision = 0;
  const watched = new WeakSet();
  let previousThrottling = null;
  let reservation = null;
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
  function stop(remember = true) {
    reservation = null;
    if (remember && preferences) preferences.patch({sharing:{enabled:false}});
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
    if (next.restoring && (reservation?.id !== sender.id || !preferences?.get().sharing.enabled)) return snapshot(sender);
    if (owner && owner.id !== sender.id) stop(false);
    if (!owner) {
      owner = sender;
      // A chat can be hidden while its avatar stays visible. Its observation timer must keep running.
      previousThrottling = sender.getBackgroundThrottling?.() ?? true;
      sender.setBackgroundThrottling?.(false);
      if (!watched.has(sender)) {
        watched.add(sender);
        sender.once("destroyed", () => {
          if (owner?.id === sender.id) stop(false);
        });
      }
    }
    reservation = null;
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
  function claim(sender, origin) {
    const saved = preferences?.get().sharing;
    if (!saved?.enabled || saved.origin !== origin || owner || (reservation && !reservation.isDestroyed() && reservation.id !== sender.id)) return false;
    if (reservation?.id === sender.id) return true;
    reservation = sender;
    sender.once("destroyed", () => { if(reservation?.id === sender.id) {reservation=null;announce();} });
    return true;
  }
  return { snapshot, publish, stop, mode, claim, active: () => !!state };
}
module.exports = { createSharing };
