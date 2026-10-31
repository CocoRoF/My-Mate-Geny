/**
 * Global (app-wide) Mate settings — providers, Live2D runtime, desktop app.
 * Placeholder: the settings agent replaces this; the Mate view opens it from
 * its header ("Global settings").
 */
export default function GlobalSettings({ onClose }: { onClose: () => void }) {
  return (
    <div className="p-5 text-sm text-content-faint">
      Global settings
      <button onClick={onClose} className="btn-ghost ml-3">Close</button>
    </div>
  );
}
