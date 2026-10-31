/**
 * "Resync now" signal: the sidebar's refresh button (and anything else that
 * wants a hard resync) asks every live view to reconnect and reload what it
 * shows. A plain DOM event keeps the hooks decoupled.
 */
const EVT = "hrh:resync";

export function requestResync(): void {
  window.dispatchEvent(new Event(EVT));
}

export function onResync(cb: () => void): () => void {
  window.addEventListener(EVT, cb);
  return () => window.removeEventListener(EVT, cb);
}
