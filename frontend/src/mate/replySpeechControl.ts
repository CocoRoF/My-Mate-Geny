import type { MateVoice } from "../api/mates";

export function readsReplies(voice: MateVoice, muted: boolean): boolean {
  return voice.auto_read && !muted && voice.tts.engine !== "off";
}

/** Reply reading is an immediate switch, never part of a voice-settings draft. */
export function voiceSettingsDraft(voice: MateVoice) {
  const { auto_read: _read, volume: _volume, ...settings } = voice;
  return settings;
}

interface Ports {
  save(id: string, on: boolean): Promise<unknown>;
  unmute(): void;
  hush(id: string): void;
}

/** One write per mate at a time. A failed save keeps the previously confirmed state. */
export function createReplySpeechControl(ports: Ports) {
  const pending = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  return {
    busy: (id: string) => pending.has(id),
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    set(id: string, on: boolean): Promise<void> {
      const running = pending.get(id);
      if (running) return running;
      // Stop every playback owner now, including a different window. Do not replay
      // the stopped reply when enabled again (voiceOwner's hush/started ledger).
      if (!on) ports.hush(id);
      const job = Promise.resolve().then(() => ports.save(id, on)).then(() => {
        if (on) ports.unmute(); // an old device-mute flag must not keep an ON switch silent
      }).finally(() => { pending.delete(id); emit(); });
      pending.set(id, job);
      emit();
      return job;
    },
  };
}
