import { apiFetch } from "./client";
import type { Connection } from "../types";

export const listConnections = () => apiFetch<Connection[]>("/api/connections");

export interface ConnectionInput {
  name: string;
  host: string;
  port: number;
  username: string;
  private_key_pem?: string | null;
  default_path: string;
}

export const createConnection = (body: ConnectionInput) =>
  apiFetch<Connection>("/api/connections", { method: "POST", body: JSON.stringify(body) });

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
