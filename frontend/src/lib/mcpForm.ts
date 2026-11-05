/** Both input styles preserve arguments containing spaces; no shell is evaluated. */
export function mcpArguments(text: string): string[] {
  if (text.trim().startsWith("[")) {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
      throw new Error("invalid_arguments");
    return value as string[];
  }
  return text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}
export interface SecretRow {
  name: string;
  value: string;
  keep: boolean;
}
export function mcpSecrets(
  rows: SecretRow[],
  headers = false,
): Record<string, string | null> {
  const out: Record<string, string | null> = {},
    names = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && !row.value && !row.keep) continue;
    const key = headers ? name.toLowerCase() : name;
    if (!name || names.has(key)) throw new Error("duplicate_or_empty_key");
    names.add(key);
    out[name] = row.keep && !row.value ? null : row.value;
  }
  return out;
}
