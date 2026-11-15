import { apiFetch } from "./client";
import type { Connection } from "../types";

export const listConnections = () => apiFetch<Connection[]>("/api/connections");

export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  username: string;
  /** used once to install a key made by the server (never kept) */
  password?: string | null;
  private_key_pem?: string | null;
  /** empty: the home folder there */
  default_path: string;
}

export const createConnection = (body: ConnectionInput) =>
  apiFetch<Connection>("/api/connections", { method: "POST", body: JSON.stringify(body) });

/** a connection without a key (or whose key no longer signs in): the password installs one */
export const finishWithPassword = (id: string, password: string) =>
  apiFetch<Connection>(`/api/connections/${id}/password`, { method: "POST", body: JSON.stringify({ password }) });

export const updateConnection = (id: string, patch: { name?: string; default_path?: string }) =>
  apiFetch<Connection>(`/api/connections/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

export const deleteConnection = (id: string) =>
  apiFetch(`/api/connections/${id}`, { method: "DELETE" });

/** Where folders can come from: this server (id null), then each SSH connection — `this_host` = it is this very
 *  machine (its folders are offered as this server's). */
export interface HostInfo {
  id: string | null;
  name: string | null;
  local: boolean;
  this_host: boolean;
  host?: string;
  port?: number;
  username?: string;
  default_path?: string | null;
}

export const listHosts = () => apiFetch<HostInfo[]>("/api/connections/hosts");

export const connectionStatus = (id: string) =>
  apiFetch<Record<string, unknown>>(`/api/connections/${id}/status`);
