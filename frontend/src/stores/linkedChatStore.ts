/**
 * Another chat beside this one (components/chat/LinkedChat.tsx): picked from + → 다른 세션의 대화, it stays above this chat's
 * message box — kept per chat in this browser — until its ✕.
 */
import { create } from "zustand";

const KEY = "hrh_linked_chats";

function read(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

interface LinkedChats {
  links: Record<string, string>;
  link: (sid: string, other: string) => void;
  unlink: (sid: string) => void;
}

export const useLinkedChats = create<LinkedChats>((set, get) => {
  const save = (links: Record<string, string>) => {
    set({ links });
    try {
      localStorage.setItem(KEY, JSON.stringify(links));
    } catch {
      /* private mode: this page only */
    }
  };
  return {
    links: typeof localStorage !== "undefined" ? read() : {},
    link: (sid, other) => save({ ...get().links, [sid]: other }),
    unlink: (sid) => {
      const { [sid]: _gone, ...rest } = get().links;
      save(rest);
    },
  };
});
