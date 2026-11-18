import { apiFetch } from "./client";

/**
 * Settings → 디바이스 인증 (backend app/routers/net.py, docs/geny-net.md).
 * Local execution: Geny Net — this desktop pairs the user's phone by a QR code, then the phone reaches it directly: on
 * the same network, or from the internet through the computer's own router (UPnP / NAT-PMP), end-to-end encrypted.
 * Server execution: a QR code that signs the phone in.
 */
export interface NetDevice {
  id: string;
  name: string;
  platform: string;
  created_at: number;
  last_seen: number | null;
  last_via: "lan" | "wan" | null;
  online: boolean;
}

export interface NetRequest {
  id: string;
  name: string;
  platform: string;
  sas: string;
  created: number;
}

export interface NetStatus {
  mode: "local" | "server";
  /** a request that came over Geny Net: which paired device this is (nothing else is shown to it) */
  here?: { device: string; via: "lan" | "wan" };
  on?: boolean;
  node?: string;
  name?: string;
  port?: number;
  lan?: string[];
  lan_on?: boolean;
  /** the router asked to forward a port (UPnP / NAT-PMP): the internet reaches this computer directly */
  upnp_on?: boolean;
  wan?: { state: "off" | "trying" | "open" | "unavailable"; endpoint: string; method: string; error: string };
  devices?: NetDevice[];
  pending?: NetRequest[];
}

export interface NetOffer {
  id: string;
  expires: number;
  uri: string;
}

export interface LoginCode {
  uri: string;
  code: string;
  expires_in: number;
  server: string;
  username: string;
}

/** the server pushes `net.changed` (a device asked, was allowed, came online): whoever shows it refetches */
export const NET_CHANGED = "hrh:net-changed";

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const netStatus = () => apiFetch<NetStatus>("/api/net/status");
export const newOffer = () => apiFetch<NetOffer>("/api/net/offer", json("POST"));
export const closeOffer = (id: string) => apiFetch<{ ok: boolean }>(`/api/net/offer/${encodeURIComponent(id)}`, json("DELETE"));
export const decide = (id: string, allow: boolean) =>
  apiFetch<{ state: string; device: string }>(`/api/net/requests/${encodeURIComponent(id)}`, json("POST", { allow }));
export const renameDevice = (id: string, name: string) =>
  apiFetch<{ ok: boolean }>(`/api/net/devices/${encodeURIComponent(id)}`, json("PATCH", { name }));
export const removeDevice = (id: string) => apiFetch<{ ok: boolean }>(`/api/net/devices/${encodeURIComponent(id)}`, json("DELETE"));
export const putNetSettings = (p: { lan?: boolean; upnp?: boolean }) =>
  apiFetch<NetStatus>("/api/net/settings", json("PUT", p));
export const loginCode = (origin: string) => apiFetch<LoginCode>("/api/net/login-code", json("POST", { origin }));
export const cancelLoginCode = (code: string) => apiFetch<{ ok: boolean }>("/api/net/login-code/cancel", json("POST", { code }));
