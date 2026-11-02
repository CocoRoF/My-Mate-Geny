/** Avatar Create in the Mate view (docs/avatar-create.md §2): open for a mate (or a new one), which project. */
import { create } from "zustand";

interface AvatarCreateState {
  open: boolean;
  /** the mate it was opened for (its projects first; a new project targets it) — null: a new mate */
  mateId: string | null;
  projectId: string | null;
  show: (mateId: string | null, projectId?: string | null) => void;
  setProject: (projectId: string | null) => void;
  close: () => void;
}

export const useAvatarCreate = create<AvatarCreateState>((set) => ({
  open: false,
  mateId: null,
  projectId: null,
  show: (mateId, projectId = null) => set({ open: true, mateId, projectId }),
  setProject: (projectId) => set({ projectId }),
  close: () => set({ open: false }),
}));
