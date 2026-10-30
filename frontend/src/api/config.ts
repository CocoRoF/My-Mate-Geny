import { apiFetch } from "./client";
import type { ProviderCatalog, ProviderStatus } from "../types";

export interface AppConfig {
  version: string;
  providers: string[];
  provider_status: ProviderStatus[];
  catalog: ProviderCatalog;
}

export const getConfig = () => apiFetch<AppConfig>("/api/config");
