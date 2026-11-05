import type { Attachment } from "../types";

/** Screen-sharing frames are model context, not user-uploaded chat media. */
export function visibleAttachments(items: Attachment[] = []): Attachment[] {
  return items.filter(a => a.origin !== "screen");
}
