import { useT, type TFunction } from "../../i18n";

const KEYS = {
  docker_missing: "mcp.issueDocker",
  docker_unavailable: "mcp.issueDockerDaemon",
  executable_missing: "mcp.issueExecutable",
  executable_denied: "mcp.issuePermission",
  working_directory_missing: "mcp.issueFolder",
  working_directory_denied: "mcp.issueFolderPermission",
  invalid_docker_environment: "mcp.issueDockerEnv",
  authentication_failed: "mcp.issueAuth",
  connection_timeout: "mcp.issueTimeout",
  connection_failed: "mcp.issueConnection",
  package_missing: "mcp.issuePackage",
} as const;
export function issueText(t: TFunction, code?: string) {
  const key = KEYS[code as keyof typeof KEYS];
  return key ? t(key) : "";
}
export default function McpIssue({
  code,
  fallback,
}: {
  code?: string;
  fallback?: string;
}) {
  const t = useT();
  if (!code && !fallback) return null;
  return (
    <div
      role="alert"
      className="mt-2 rounded-lg border border-danger/20 bg-danger/5 p-3 text-xs text-danger"
    >
      <p>{issueText(t, code) || fallback}</p>
      {code && fallback && (
        <details className="mt-2 text-content-faint">
          <summary className="cursor-pointer">
            {t("mcp.technicalDetails")}
          </summary>
          <p className="mt-1 whitespace-pre-wrap break-words font-mono">
            {fallback}
          </p>
        </details>
      )}
    </div>
  );
}
