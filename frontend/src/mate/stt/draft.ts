import { joinText } from "./scribe";

/** Message finalization is independent of a recognizer's VAD/segment boundary. No text is sent twice or rewritten in history. */
export interface SpeechDraftOptions {
  autoSend: boolean;
  merge: boolean;
  grace: number;
  silence?: number;
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
    if ((n > 1 || right[0].length >= 3) && left.slice(-n).join(" ") === right.slice(0, n).join(" ")) {
      b = right.slice(n).join(" ");
      break;
    }
  }
  return b ? (/^[,.;:!?，。！？]/u.test(b) || /[([{“‘]$/u.test(a) ? a + b : joinText(a, b)) : a;
}
export interface SpeechPacket {
  group_id: string;
  client_msg_id: string;
  revision: number;
  op: "submit" | "touch";
  input?: string;
  window_ms: number;
  idle_ms: number;
  activity_at: number;
}
/** Parallel deadlines: send at last activity + silence; the SERVER releases at last activity + grace. */
export function createSpeechDraft(deps: {
  read: () => string;
  write: (text: string) => void;
  send: (text: string, packet: SpeechPacket) => boolean | void;
  touch?: (packet: SpeechPacket) => void;
  changed?: () => void;
  late?: () => void;
  id?: () => string;
  now?: () => number;
  later?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (id: ReturnType<typeof setTimeout>) => void;
}) {
  let options: SpeechDraftOptions = { autoSend: false, merge: true, grace: 4, silence: 1.2, ignoreShort: false };
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let held = false,
    busy = false,
    speaking = false,
    disposed = false,
    ready = true,
    audioSeen = false;
  let partial = "",
    consumed = "",
    lastActivity = -Infinity,
    lastTouch = -Infinity;
  let group: { id: string; accepted: string; partialBase: string | null; sentPartial: string; lastText: string; revision: number } | null = null;
  let manualFull: string | null = null;
  const clear = () => {
    if (timer !== undefined) (deps.cancel ?? clearTimeout)(timer);
    timer = undefined;
  };
  const active = () => !!group && now() - lastActivity <= (options.merge ? options.grace : options.silence!) * 1000;
  const expire = () => {
    if (group && !active()) {
      group = null;
    }
  };
  const packet = (force = false, op: "submit" | "touch" = "submit"): SpeechPacket => ({
    group_id: group!.id,
    client_msg_id: group!.id,
    revision: group!.revision,
    op,
    window_ms: force ? 0 : (options.merge ? options.grace : options.silence!) * 1000,
    idle_ms: Math.max(0, now() - lastActivity),
    activity_at: lastActivity,
  });
  const remainder = (text: string) => {
    text = clean(text);
    const prefix = consumed || group?.sentPartial || "";
    if (!prefix || !text.startsWith(prefix)) return text;
    const tail = text.slice(prefix.length).trimStart();
    return /^[.,!?;:…，。！？]*$/u.test(tail) ? "" : tail;
  };
  const full = () => joinTranscript(group?.partialBase ?? group?.accepted ?? "", joinTranscript(deps.read(), partial));
  const ensure = () => {
    expire();
    if (!group) {
      const id = deps.id?.() ?? `speech-${now()}-${Math.random().toString(36).slice(2)}`;
      group = { id, accepted: "", partialBase: null, sentPartial: "", lastText: "", revision: 0 };
    }
  };
  const deliver = (force = false, override?: string) => {
    ensure();
    const text = override ?? full();
    if (!text.trim()) return false;
    if (!force && text === group!.lastText) return true;
    group!.revision++;
    const accepted = deps.send(text, { ...packet(force), input: text });
    if (accepted === false) {
      group!.revision--;
      return false;
    }
    if (partial) {
      group!.partialBase = joinTranscript(group!.partialBase ?? group!.accepted, deps.read());
      group!.sentPartial = partial;
    } else {
      group!.accepted = text;
      group!.partialBase = null;
      group!.sentPartial = "";
    }
    group!.lastText = text;
    deps.write("");
    deps.changed?.();
    return true;
  };
  const schedule = () => {
    clear();
    if (disposed || !ready || held || busy || speaking || !options.autoSend) return;
    if (!deps.read().trim() && !partial && (!group || group.accepted === group.lastText)) return;
    timer = (deps.later ?? setTimeout)(
      () => {
        timer = undefined;
        if (!disposed && !held && !busy && !speaking && ready) deliver();
      },
      Math.max(0, lastActivity + options.silence! * 1000 - now()),
    );
  };
  const activity = (audio = true) => {
    expire();
    lastActivity = now();
    if (audio) audioSeen = true;
    if (group && now() - lastTouch >= 150) {
      lastTouch = now();
      deps.touch?.(packet(false, "touch"));
    }
    schedule();
  };
  return {
    configure(next: SpeechDraftOptions) {
      const silence = Math.min(3, Math.max(0.5, Number(next.silence) || 1.2));
      const value = { ...next, silence, grace: Math.min(5, Math.max(silence, Number(next.grace) || 4)) };
      if (JSON.stringify(value) !== JSON.stringify(options)) {
        options = value;
        schedule();
      }
    },
    segment(text: string) {
      const tail = consumed ? remainder(text) : clean(text);
      consumed = "";
      if (options.ignoreShort && /^[\p{L}\p{N}]{1,2}[.!?]?$/u.test(tail)) {
        partial = "";
        schedule();
        return;
      }
      if (!Number.isFinite(lastActivity)) lastActivity = now() - options.silence! * 1000;
      if (group?.partialBase !== null && group?.partialBase !== undefined && !active()) {
        const rest = tail.startsWith(group.sentPartial) ? tail.slice(group.sentPartial.length).trim() : tail;
        group = null;
        partial = "";
        if (rest && !/^[.,!?;:…，。！？]*$/u.test(rest)) {
          deps.write(joinTranscript(deps.read(), rest));
          held = true;
          deps.late?.();
        }
        deps.changed?.();
        return;
      }
      if (group?.partialBase !== null && group?.partialBase !== undefined) {
        group.accepted = joinTranscript(group.partialBase, tail);
        group.partialBase = null;
        group.sentPartial = "";
      } else if (tail) deps.write(joinTranscript(deps.read(), tail));
      partial = "";
      audioSeen = false;
      schedule();
      deps.changed?.();
    },
    partial(text: string) {
      const next = clean(text);
      if (next && next !== partial && !audioSeen && !speaking) activity(false);
      partial = consumed ? remainder(next) : next;
      schedule();
    },
    activity() {
      activity();
    },
    speaking(value: boolean) {
      if (value !== speaking) {
        speaking = value;
        activity();
      }
    },
    busy(value: boolean) {
      if (value !== busy) {
        busy = value;
        schedule();
      }
    },
    ready(value: boolean) {
      ready = value;
      schedule();
    },
    edit(visiblePartial = "") {
      clear();
      held = true;
      if (visiblePartial) consumed = clean(visiblePartial);
      partial = "";
      if (group) activity(false);
      if (!deps.read().trim()) held = false;
      deps.changed?.();
    },
    manual(text: string, visiblePartial: string) {
      clear();
      expire();
      const joinManual = (a: string, b: string) => {
        if (!a || !b) return a || b;
        return a.includes("\n") || b.includes("\n") ? `${a}\n${b}` : joinText(a, b);
      };
      const manualPart = joinManual(text, remainder(visiblePartial));
      manualFull = group
        ? held ? (manualPart.startsWith(group.lastText) ? manualPart : joinManual(group.lastText, manualPart)) : full()
        : null;
      const result = group ? manualFull! : remainder(visiblePartial) ? joinTranscript(text, remainder(visiblePartial)) : text;
      consumed = clean(visiblePartial);
      partial = "";
      held = false;
      deps.changed?.();
      return result;
    },
    manualDispatch(): boolean | undefined {
      if (manualFull === null) return undefined;
      const text = manualFull;
      manualFull = null;
      const ok = deliver(true, text);
      if (ok) {
        group = null;
        lastActivity = -Infinity;
      }
      return ok;
    },
    closed(id: string) {
      if(group?.id!==id)return;
      if(group.partialBase!==null)consumed=group.sentPartial;
      group=null;manualFull=null;clear();deps.changed?.();
    },
    canFinalize: () => active() && !!group?.lastText,
    visiblePartial: remainder,
    resume() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
