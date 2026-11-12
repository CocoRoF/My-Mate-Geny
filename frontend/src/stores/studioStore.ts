/**
 * The Mate Create studio in the Mate view (docs/avatar-create.md §11): open or not, for a new mate's draft
 * (`create`) or an existing mate's avatar (`avatar`), and which project. Its own screen — lib/nav.ts makes every
 * change a history entry (`/?view=mate&create=<draft>`, `/?view=mate&avatar=<mate>`), so back closes it.
 */
import { create } from "zustand";
import { openStudio } from "../api/avatar";
import { tr, useI18n } from "../i18n";

export type StudioKind = "create" | "avatar";

interface StudioState {
  open: boolean;
  kind: StudioKind;
  /** the draft's id (create) or the mate's (avatar); "new" = make a draft first (a deep link from another window) */
  mateId: string | null;
  /** one project of that mate (null: the draft's / the mate's latest) */
  projectId: string | null;
  /** a new draft is being made (New mate pressed) */
  starting: boolean;
  startError: string | null;
  /** a line for the Mate view once the studio closed ("Harin is ready", "Draft discarded") */
  notice: string | null;
  /** a mate just created here: the Mate view opens her guide once the studio closed (components/mate/guide) */
  guideFor: string | null;
  askGuide: (mateId: string | null) => void;
  openCreate: (draftId: string) => void;
  openAvatar: (mateId: string, projectId?: string | null) => void;
  /** the project filling one outfit of her wardrobe */
  openOutfit: (mateId: string, outfitId: string) => Promise<void>;
  setProject: (projectId: string | null) => void;
  /** New mate: a fresh draft (the agent starts on it) and its studio */
  startNew: () => Promise<void>;
  close: () => void;
  note: (msg: string | null) => void;
}

export const useStudio = create<StudioState>((set, get) => ({
  open: false,
  kind: "create",
  mateId: null,
  projectId: null,
  starting: false,
  startError: null,
  notice: null,
  guideFor: null,
  askGuide: (guideFor) => set({ guideFor }),
  openCreate: (draftId) => set({ open: true, kind: "create", mateId: draftId, projectId: null, startError: null }),
  openAvatar: (mateId, projectId = null) => set({ open: true, kind: "avatar", mateId, projectId, startError: null }),
  openOutfit: async (mateId, outfitId) => {
    if (get().starting) return;
    set({ starting: true, startError: null });
    try {
      const p = await openStudio({ mate_id: mateId, language: useI18n.getState().lang, outfit: { id: outfitId } });
      set({ open: true, kind: "avatar", mateId, projectId: p.id, starting: false });
    } catch (e) {
      set({ starting: false, startError: (e as Error).message || tr("studio.startFailed") });
    }
  },
  setProject: (projectId) => set({ projectId }),
  startNew: async () => {
    if (get().starting) return;
    set({ starting: true, startError: null });
    try {
      const p = await openStudio({ language: useI18n.getState().lang });
      set({ open: true, kind: "create", mateId: p.studio?.mate_id ?? null, projectId: p.id, starting: false });
    } catch (e) {
      set({ starting: false, startError: (e as Error).message || tr("studio.startFailed") });
    }
  },
  close: () => set({ open: false, starting: false }),
  note: (notice) => set({ notice }),
}));
