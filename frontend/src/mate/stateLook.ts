/**
 * What her face does comes from how she feels (app/mate/state.py, docs/mate-memory-affinity.md §6): the look for her state, shown
 * now and then while she is idle, in place of a blank `[neutral]`, when she is tapped, and held as her resting face once she
 * feels it enough.
 */
import type { MateState, StateLabel } from "../api/mates";

/** how she feels → the look a body shows for it (a rig without one falls to a near feeling: mate/emotion.ts) */
const STATE_LOOK: Partial<Record<StateLabel, string>> = {
  happy: "smile",
  excited: "joy",
  shy: "shy",
  angry: "angry",
  sad: "sad",
  lonely: "sad",
  worried: "worried",
  sleepy: "sleepy",
};
/** from here she looks it all the time, and shows it more often */
export const STATE_STRONG = 0.45;

interface WithState {
  state?: MateState;
  relation?: { avatar_mood?: boolean };
}

/** the look for how she feels now; undefined when calm or when the user switched this off (`on`: an unsaved preview) */
export function stateLook(mate: WithState | null | undefined, on?: boolean): string | undefined {
  if (!mate?.state || !(on ?? mate.relation?.avatar_mood ?? true)) return undefined;
  return STATE_LOOK[mate.state.label];
}

/** the same, only when she feels it enough to keep that face */
export function restingLook(mate: WithState | null | undefined, on?: boolean): string | undefined {
  return (mate?.state?.level ?? 0) >= STATE_STRONG ? stateLook(mate, on) : undefined;
}
