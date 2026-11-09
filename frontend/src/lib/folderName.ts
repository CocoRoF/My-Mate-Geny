/** A new folder's name, checked before it is sent (the server checks again: backend workspaces/base.py
 *  folder_name_error) — what's wrong with it as a message key, or null. */
export type FolderNameProblem = "workspace.nameEmpty" | "workspace.nameDots" | "workspace.nameSlash" | "workspace.nameLong";

export function folderNameProblem(raw: string): FolderNameProblem | null {
  const name = raw.trim();
  if (!name) return "workspace.nameEmpty";
  if (name === "." || name === "..") return "workspace.nameDots";
  // (a name, not a path; nor control characters)
  // eslint-disable-next-line no-control-regex
  if (/[/\\\x00-\x1f]/.test(name)) return "workspace.nameSlash";
  if (new TextEncoder().encode(name).length > 255) return "workspace.nameLong";
  return null;
}
