import { apiFetch } from "./client";

export interface GitAccount {
  id: string;
  provider: string; // github | gitlab
  label: string;
  host: string | null;
  username: string | null;
  created_at: string;
}

export interface GitRepo {
  full_name: string;
  name: string;
  clone_url: string;
  private: boolean;
  description: string;
  default_branch: string;
  updated_at: string | null;
}

export const listGitAccounts = () => apiFetch<GitAccount[]>("/api/git/accounts");

export const connectGit = (body: { provider: string; token: string; host?: string; label?: string }) =>
  apiFetch<GitAccount>("/api/git/accounts", { method: "POST", body: JSON.stringify(body) });

export const deleteGit = (id: string) => apiFetch(`/api/git/accounts/${id}`, { method: "DELETE" });

export const getRepos = (id: string, q = "") =>
  apiFetch<GitRepo[]>(`/api/git/accounts/${id}/repos?q=${encodeURIComponent(q)}`);

export const cloneRepo = (id: string, full_name: string, clone_url: string) =>
  apiFetch<{ path: string; cloned: boolean }>(`/api/git/accounts/${id}/clone`, {
    method: "POST",
    body: JSON.stringify({ full_name, clone_url }),
  });
