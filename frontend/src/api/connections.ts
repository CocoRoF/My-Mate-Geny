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

export const connectionStatus = (id: string) =>
  apiFetch<Record<string, unknown>>(`/api/connections/${id}/status`);
