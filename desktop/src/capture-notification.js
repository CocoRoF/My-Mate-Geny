"use strict";

/** Route each completed capture to one visible app window without showing or moving windows. */
function createCaptureNotifier({ windows, focused, send }) {
  const seen = new Set();
  let serial = 0;
  return {
    done(info = {}) {
      const id = String(info.id || `capture_${++serial}`);
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > 128) seen.delete(seen.values().next().value);
      const visible = windows().filter(
        w => w && !w.isDestroyed() && w.isVisible() && !w.isMinimized?.(),
      );
      const active = focused();
      const recipient = visible.includes(active) ? active : visible[0];
      if (recipient) send(recipient, { type: "capture", state: "done", notification_id: id });
    },
  };
}
module.exports = { createCaptureNotifier };
