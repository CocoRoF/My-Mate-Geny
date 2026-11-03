/**
 * Hosts of a chat's folders (backend services/folders.py): every additional folder is a path on this server
 * (connection_id null) or on an SSH connection's host — independent of where the workspace is.
 *
 * The workbench (explorer roots, file tabs, selection) keys things by one string per path. A path on the
 * workspace's own host stays as it is (tabs saved before hosts keep working); a path on another host is
 * *qualified*: `@<connection id | local>:<absolute path>` (absolute paths start with `/` or `~`, so the form
 * can't clash with a real one). {@link unqualify} turns it back into (host, path) for the fs API.
 */
import { create } from "zustand";
import { listHosts, type HostInfo } from "../api/connections";
import type { Connection, Folder, Session } from "../types";

export const LOCAL = "local";
const Q = /^@([^:/]+):((?:\/|~).*)$/;

export const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
export const hostKey = (conn: string | null | undefined) => conn || LOCAL;
export const sameHost = (a: string | null | undefined, b: string | null | undefined) => (a || null) === (b || null);

/** The chat's additional folders with their hosts (an older server only sends `extra_dirs`: the workspace's host). */
export function sessionFolders(s: Session): Folder[] {
  if (s.folders) return s.folders;
  return (s.extra_dirs || []).map((path) => ({ path, connection_id: s.connection_id || null }));
}

export const folderKey = (f: { path: string; connection_id: string | null }) => `${hostKey(f.connection_id)}::${strip(f.path)}`;

/** One workbench key for a path on a host (plain on the workspace's host, `@host:path` elsewhere). */
export function qualify(session: Pick<Session, "connection_id">, conn: string | null | undefined, path: string): string {
  return sameHost(conn, session.connection_id) ? path : `@${hostKey(conn)}:${path}`;
}

export function isQualified(q: string): boolean {
  return Q.test(q);
}

export function unqualify(session: Pick<Session, "connection_id">, q: string): { conn: string | null; path: string } {
  const m = Q.exec(q);
  if (!m) return { conn: session.connection_id || null, path: q };
  return { conn: m[1] === LOCAL ? null : m[1], path: m[2] };
}

/** The folder of the chat a host path belongs to (the deepest), if any — e.g. to tell which host an absolute
 *  path the agent printed is on. */
export function folderFor(session: Session, path: string): Folder | undefined {
  const inside = (p: string, r: string) => p === r || p.startsWith(r === "/" ? "/" : r + "/");
  return sessionFolders(session)
    .filter((f) => inside(path, strip(f.path)))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** Display name of a host: "this server" or the connection's name. */
export function hostName(conn: string | null | undefined, connections: Connection[], thisServer: string): string {
  if (!conn) return thisServer;
  return connections.find((c) => c.id === conn)?.name || conn;
}

// ---- which hosts exist (this server + the SSH connections, the ones that are this machine marked) ----

interface HostsState {
  hosts: HostInfo[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: (force?: boolean) => Promise<void>;
}

let inflight: Promise<void> | null = null;

export const useHosts = create<HostsState>((set, get) => ({
  hosts: [],
  loaded: false,
  loading: false,
  error: "",
  load: (force = false) => {
    if (get().loaded && !force) return Promise.resolve();
    if (inflight) return inflight;
    set({ loading: true });
    inflight = listHosts()
      .then((hosts) => set({ hosts, loaded: true, loading: false, error: "" }))
      .catch((e) => set({ loading: false, error: String(e?.message || e) }))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },
}));

/** SSH connections that are this very machine (their folders are this server's). */
export const thisHostIds = (hosts: HostInfo[]) => new Set(hosts.filter((h) => h.id && h.this_host).map((h) => h.id as string));
