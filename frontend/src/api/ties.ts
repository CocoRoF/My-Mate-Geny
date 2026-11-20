// What the two of them are, in her own view (app/mate/gss/ties.py; docs/geny-state-system.md §12): read only — hers to decide.
import { apiFetch } from "./client";

export type TieLabel =
  | "stranger"
  | "indifferent"
  | "acquaintance"
  | "friend"
  | "close_friend"
  | "crush"
  | "flirting"
  | "lovers"
  | "ex"
  | "estranged"
  | "rivals"
  | "love_hate"
  | "loathing";

/** how she came to it: at the moment (her own word), at night (thinking over her day), her first view, or as it began */
export type TieBy = "moment" | "night" | "first" | "start";

export interface TieChange {
  at: string;
  from: TieLabel;
  to: TieLabel;
  /** her words, then */
  why: string;
  by: TieBy;
}

export interface Tie {
  label: TieLabel;
  since: string;
  /** her own words for it */
  why: string;
  by: TieBy;
  /** how she felt about the two of them on a night she kept it (while it is still with her) */
  thought: string;
  thought_at: string | null;
  reviewed_at: string | null;
  /** she is about to put it into words (someone she already knew) */
  pending: boolean;
  /** how settled it is: what has built up against it since she last settled it */
  steadiness: "steady" | "wavering" | "shaken";
  /** 0 – 1: how far towards her thinking it over */
  pressure: number;
  /** newest first */
  history: TieChange[];
}

export interface TiesView {
  tie: Tie | null;
  labels: TieLabel[];
  romantic: TieLabel[];
  review_at: number;
}

export const getTies = (id: string) => apiFetch<TiesView>(`/api/mates/${encodeURIComponent(id)}/ties`);
