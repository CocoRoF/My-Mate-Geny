/** The user's own small round picture (Settings → 계정: stores/userIcon.ts), else their name's initial. */
import { useState } from "react";
import { useUserIconUrl } from "../../stores/userIcon";

export default function UserIcon({ name, className = "h-6 w-6 text-[11px]" }: { name: string; className?: string }) {
  const url = useUserIconUrl();
  const [failed, setFailed] = useState("");
  const initial = ([...(name.trim() || "?")][0] ?? "?").toUpperCase();
  return (
    <span className={`relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-surface-3 font-semibold text-content-dim ${className}`} data-testid="user-icon">
      {url && failed !== url ? <img src={url} alt="" className="h-full w-full object-cover" draggable={false} onError={() => setFailed(url)} /> : initial}
    </span>
  );
}
