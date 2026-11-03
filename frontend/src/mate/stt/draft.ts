import { joinText } from "./scribe";

/** Message finalization is independent of a recognizer's VAD/segment boundary. No text is sent twice or rewritten in history. */
export interface SpeechDraftOptions {
  autoSend: boolean;
  merge: boolean;
  grace: number;
  ignoreShort: boolean;
}
const clean = (s: string) => s.normalize("NFC").replace(/\s+/gu, " ").trim();
/** Remove only a substantial, whole-word overlap (recognizers sometimes repeat a boundary). Keep short deliberate repetitions. */
export function joinTranscript(a: string, b: string): string {
  a = a.normalize("NFC").trim();
  b = clean(b);
  if (!a) return b;
  if (!b) return a;
  const left = a.split(" "),
    right = b.split(" ");
  for (let n = Math.min(left.length, right.length); n > 0; n--) {
    if (
      (n > 1 || right[0].length >= 3) &&
      left.slice(-n).join(" ") === right.slice(0, n).join(" ")
    ) {
      b = right.slice(n).join(" ");
      break;
    }
  }
  return b
    ? /^[,.;:!?，。！？]/u.test(b) || /[([{“‘]$/u.test(a)
      ? a + b
      : joinText(a, b)
    : a;
}
export function createSpeechDraft(deps: {
  read: () => string;
  write: (text: string) => void;
  send: (text: string) => void;
  changed?: () => void;
  later?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (id: ReturnType<typeof setTimeout>) => void;
}) {
  let options: SpeechDraftOptions = {
    autoSend: false,
    merge: true,
    grace: 1.8,
    ignoreShort: false,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false,
    held = false,
    busy = false,
    partial = "",
    consumed = "",
    disposed = false;
  const cancel = () => {
    if (timer !== undefined) (deps.cancel ?? clearTimeout)(timer);
    timer = undefined;
  };
  const schedule = () => {
    cancel();
    if (disposed || !pending || held || busy || partial || !options.autoSend)
      return;
    timer = (deps.later ?? setTimeout)(
      () => {
        timer = undefined;
        if (
          disposed ||
          !pending ||
          held ||
          busy ||
          partial ||
          !options.autoSend
        )
          return;
        const text = deps.read().trim();
        pending = false;
        if (text) {
          deps.write("");
          deps.send(text);
        }
      },
      options.merge ? options.grace * 1000 : 0,
    );
  };
  const remainder = (text: string) => {
    text = clean(text);
    return consumed && text.startsWith(consumed)
      ? text.slice(consumed.length).trimStart()
      : text;
  };
  return {
    configure(next: SpeechDraftOptions) {
      const value = {
        ...next,
        grace: Math.min(5, Math.max(0.5, Number(next.grace) || 1.8)),
      };
      if (JSON.stringify(options) !== JSON.stringify(value)) {
        options = value;
        schedule();
      }
    },
    segment(text: string) {
      const tail = remainder(text);
      consumed = "";
      partial = "";
      if (options.ignoreShort && /^[\p{L}\p{N}]{1,2}[.!?]?$/u.test(tail)) {
        schedule();
        return;
      }
      if (tail) {
        if (!deps.read().trim() && !pending) held = false;
        deps.write(joinTranscript(deps.read(), tail));
        pending = true;
      }
      schedule();
      deps.changed?.();
    },
    partial(text: string) {
      partial = remainder(text);
      schedule();
    },
    busy(value: boolean) {
      if (busy !== value) {
        busy = value;
        schedule();
      }
    },
    activity() {
      if (pending) schedule();
    },
    /** Editing (including composition/cross-window draft changes) holds auto-send until an explicit send or clear. */
    edit(visiblePartial = "") {
      cancel();
      held = !!deps.read().trim();
      if (!held) pending = false;
      if (visiblePartial) consumed = clean(visiblePartial);
      partial = "";
      deps.changed?.();
    },
    manual(text: string, visiblePartial: string) {
      const tail = remainder(visiblePartial);
      const result = tail ? joinTranscript(text, tail) : text;
      cancel();
      pending = false;
      held = false;
      if (visiblePartial) consumed = clean(visiblePartial);
      partial = "";
      deps.changed?.();
      return result;
    },
    // Read before manual() consumes the current partial.
    visiblePartial: remainder,
    resume() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
