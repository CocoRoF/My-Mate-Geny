import { nameClipboardFiles } from "../../stores/composerStore";

/** Files on a paste event. Office apps put an image AND tab/newline text on the
 * clipboard for copied cells — that's a text paste, not an attachment. */
export function filesFromClipboard(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files = Array.from(dt.files || []);
  const fromItems = Array.from(dt.items || [])
    .filter((it) => it.kind === "file")
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
  const all = files.length ? files : fromItems;
  if (!all.length) return [];
  const text = dt.getData("text/plain");
  if (text && /[\t\n]/.test(text.trim())) return [];
  return nameClipboardFiles(all);
}

/** a drag that carries files (not text or a link) */
export const dragHasFiles = (e: { dataTransfer: DataTransfer | null }) =>
  Array.from(e.dataTransfer?.types || []).includes("Files");

/** a paste that lands in a text field is the field's own business */
export const pastedIntoField = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (!!el.closest?.("textarea, input, [contenteditable=true]") || el.isContentEditable);
};
