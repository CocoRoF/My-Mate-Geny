import { useState, useSyncExternalStore } from "react";
import type { Mate } from "../api/mates";
import { useMateStore } from "../stores/mateStore";
import { hushDevice } from "./voiceOwner";
import { createReplySpeechControl, readsReplies } from "./replySpeechControl";

const control = createReplySpeechControl({
  save: (id, on) => useMateStore.getState().patch(id, { voice: { auto_read: on } }),
  unmute: () => useMateStore.getState().setMuted(false),
  hush: hushDevice,
});

/** Settings, composer and native avatar all operate on the same saved mate field. */
export function useReplySpeech(mate: Mate | null) {
  const saved = useMateStore((s) => s.mates.find((m) => m.id === mate?.id) ?? s.drafts[mate?.id ?? ""] ?? mate);
  const muted = useMateStore((s) => s.muted);
  const busy = useSyncExternalStore(control.subscribe, () => !!mate && control.busy(mate.id));
  const [error, setError] = useState<string | null>(null);
  const available = !!saved && saved.voice.tts.engine !== "off";
  const enabled = !!saved && readsReplies(saved.voice, muted);
  const setEnabled = async (on: boolean) => {
    if (!saved || (on && !available)) return;
    setError(null);
    try { await control.set(saved.id, on); }
    catch (e) { setError((e as Error).message); }
  };
  return { enabled, available, busy, error, setEnabled };
}
