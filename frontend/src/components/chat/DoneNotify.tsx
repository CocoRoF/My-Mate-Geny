/**
 * “끝나면 알려 줘” by the message box (backend app/services/done_notify.py, docs/mate-calls.md "Alarms"): armed, the chat's
 * mate phones them when its turn ends — what it did, on the device they are on. Armed by the chat's agent when they ask
 * in words, or by the bell here; the chip above the box says so (✕ calls it off). No mate who can call: no bell.
 */
import { useEffect } from "react";
import { useDoneNotifyStore } from "../../stores/doneNotifyStore";
import { useT } from "../../i18n";
import Icon from "../ui/Icon";

function useDoneNotify(sid: string) {
  const state = useDoneNotifyStore((s) => s.by[sid]);
  useEffect(() => {
    void useDoneNotifyStore.getState().load(sid);
  }, [sid]);
  return state;
}

/** the bell beside + */
export function DoneBell({ sid }: { sid: string }) {
  const t = useT();
  const st = useDoneNotify(sid);
  if (!st?.available) return null;
  const name = st.mate_name;
  return (
    <button
      onClick={() => void useDoneNotifyStore.getState().toggle(sid)}
      className={`grid place-items-center w-10 h-10 sm:w-8 sm:h-8 rounded-lg transition ${
        st.armed ? "bg-warning/15 text-warning" : "text-content-dim hover:text-content hover:bg-surface-3"
      }`}
      title={st.armed ? t("chat.doneNotifyOn", { name }) : t("chat.doneNotifyOff", { name })}
      aria-label={st.armed ? t("chat.doneNotifyOn", { name }) : t("chat.doneNotifyOff", { name })}
      aria-pressed={st.armed}
      data-testid="chat-done-bell"
    >
      <Icon name={st.armed ? "bell-ring" : "bell"} size={16} />
    </button>
  );
}

/** armed: a line above the message box (✕ calls it off) */
export function DoneChip({ sid }: { sid: string }) {
  const t = useT();
  const st = useDoneNotify(sid);
  if (!st?.armed) return null;
  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-1.5 text-[12px] text-content animate-fade-in" data-testid="chat-done-chip" role="status">
      <Icon name="bell-ring" size={13} className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1 truncate">{t("chat.doneNotifyArmed", { name: st.mate_name })}</span>
      <button
        onClick={() => void useDoneNotifyStore.getState().toggle(sid)}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-content-faint hover:bg-surface-3 hover:text-content"
        aria-label={t("chat.doneNotifyCancel")}
        title={t("chat.doneNotifyCancel")}
        data-testid="chat-done-chip-off"
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
