import { useT, type MsgKey } from "../../i18n";
const STATUS: Record<string, MsgKey> = {
  connected: "mcp.connected",
  connecting: "mcp.connecting",
  disconnected: "mcp.disconnected",
  disabled: "mcp.disabled",
  error: "mcp.failed",
};
export function McpStatus({ state }: { state: string }) {
  const t = useT();
  return (
    <span
      className={`pill shrink-0 ${state === "connected" ? "bg-success/10 text-success" : state === "error" ? "bg-danger/10 text-danger" : "bg-surface-3 text-content-faint"}`}
      role="status"
    >
      {t(STATUS[state] ?? "mcp.disconnected")}
    </span>
  );
}
