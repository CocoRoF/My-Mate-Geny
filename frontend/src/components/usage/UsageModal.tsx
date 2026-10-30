import { useEffect } from "react";
import Icon from "../ui/Icon";
import SubscriptionUsage from "./SubscriptionUsage";

export default function UsageModal({ provider, onClose }: { provider: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md card p-6 animate-fade-in max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 mb-4">
          <div className="grid place-items-center w-9 h-9 rounded-lg bg-gradient-to-br from-accent to-cyan shadow-glow">
            <Icon name="cpu" size={17} className="text-white" />
          </div>
          <h3 className="text-base font-semibold flex-1">Account &amp; Usage</h3>
          <button onClick={onClose} className="text-content-faint hover:text-content">
            <Icon name="x" size={18} />
          </button>
        </div>
        <SubscriptionUsage provider={provider} />
      </div>
    </div>
  );
}
