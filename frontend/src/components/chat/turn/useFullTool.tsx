import { useEffect, useState } from "react";
import { useChatStore, type ToolActivity } from "../../../stores/chatStore";
import { useT } from "../../../i18n";
import Icon from "../../ui/Icon";

/**
 * Tool calls from a lite history page carry previews of big inputs / outputs
 * (`ToolActivity.lazy`). While `active` (a row open, a subagent shown), fetch
 * the originals into the store. `failed`: the server couldn't hand them over
 * (retry() asks again).
 */
export function useFullTools(tools: ToolActivity[], active: boolean) {
  const key = tools
    .filter((t) => t.lazy)
    .map((t) => t.id)
    .join("\n");
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active || !key) return;
    let alive = true;
    const ids = key.split("\n");
    useChatStore
      .getState()
      .hydrate(ids)
      .then(
        () => {
          // (still a preview: the server didn't have it)
          const { turns, detached } = useChatStore.getState();
          const all = [...turns, ...(detached ? [detached] : [])].flatMap((t) => t.tools);
          if (alive && all.some((t) => ids.includes(t.id) && t.lazy)) setFailedKey(key);
        },
        () => alive && setFailedKey(key),
      );
    return () => {
      alive = false;
    };
  }, [active, key, attempt]);
  const failed = !!key && failedKey === key;
  return {
    loading: active && !!key && !failed,
    failed,
    retry: () => {
      setFailedKey(null);
      setAttempt((n) => n + 1);
    },
  };
}

/** In place of a call's details while its full input / output loads. */
export function FullToolNote({ failed, retry }: { failed: boolean; retry: () => void }) {
  const t = useT();
  return failed ? (
    <div className="flex items-center gap-2 text-[11.5px] text-danger/90 light:text-danger" data-testid="tool-load-failed">
      <Icon name="alert-circle" size={12} />
      {t("turn.loadFullFailed")}
      <button onClick={retry} className="underline underline-offset-2 hover:text-danger">
        {t("common.retry")}
      </button>
    </div>
  ) : (
    <div className="flex items-center gap-2 text-[11.5px] text-content-faint" data-testid="tool-loading">
      <Icon name="spinner" size={12} spin />
      {t("turn.loadingFull")}
    </div>
  );
}
