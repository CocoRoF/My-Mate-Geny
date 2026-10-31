import { useUIStore } from "../../stores/uiStore";
import Icon from "../ui/Icon";

/** Phone-only header: opens the sidebar drawer. */
export function MenuButton({ className = "" }: { className?: string }) {
  const setSidebar = useUIStore((s) => s.setSidebar);
  return (
    <button
      onClick={() => setSidebar(true)}
      className={`md:hidden grid shrink-0 place-items-center w-10 h-10 -ml-2 rounded-lg text-content-dim hover:text-content hover:bg-surface-3 ${className}`}
      aria-label="Open menu"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
  );
}

export default function MobileTopBar({ title }: { title: string }) {
  return (
    <div className="md:hidden pt-safe shrink-0 border-b border-border/70 bg-surface/80 backdrop-blur-xl">
      <div className="flex h-12 items-center gap-1 px-3">
        <MenuButton />
        <div className="grid place-items-center w-6 h-6 rounded-md bg-gradient-to-br from-accent to-cyan">
          <Icon name="bolt" size={12} className="text-white" />
        </div>
        <span className="ml-1.5 text-[15px] font-semibold">{title}</span>
      </div>
    </div>
  );
}
