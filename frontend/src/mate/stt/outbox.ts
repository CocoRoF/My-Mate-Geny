import type { SpeechPacket } from "./draft";
const key = "hrh_speech_outbox_v2";
interface Stored {
  sid: string;
  packet: SpeechPacket;
  attachments: string[];
}
function read(): Record<string, Stored> {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(([id, v]) => {
        const item = v as Stored;
        return (
          item &&
          typeof item.sid === "string" &&
          item.packet &&
          item.packet.group_id === id &&
          typeof item.packet.input === "string" &&
          Number.isInteger(item.packet.revision) &&
          Array.isArray(item.attachments)
        );
      }),
    ) as Record<string, Stored>;
  } catch {
    return {};
  }
}
export function saveSpeech(sid: string, packet: SpeechPacket, attachments: string[]): boolean {
  if (packet.op === "touch") return true;
  try {
    const all = read();
    all[packet.group_id] = { sid, packet, attachments: [...new Set([...(all[packet.group_id]?.attachments ?? []), ...attachments])] };
    localStorage.setItem(key, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}
export function pendingSpeech(sid: string): Stored[] {
  return Object.values(read()).filter((p) => p.sid === sid);
}
export function ackSpeech(sid: string, group: string, revision: number, acceptedText?: string): string {
  const all = read(),
    entry = all[group];
  if (!entry || entry.sid !== sid) return "";
  if (entry.packet.revision > revision && acceptedText === undefined) return "";
  delete all[group];
  try {
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    /* keep the durable packet; replay is idempotent */
  }
  if (entry.packet.revision <= revision) return "";
  const text = entry.packet.input || "";
  return acceptedText && text.startsWith(acceptedText) ? text.slice(acceptedText.length).trim() : text;
}
