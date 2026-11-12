/** What a Live2D model offers, read from its model3.json (Settings → Avatar's editor, her guide's 아바타·의상 step). */
import { useEffect, useState } from "react";
import { tr } from "../../i18n";

export interface Live2DModelInfo {
  expressions: string[];
  motions: string[];
  hitAreas: string[];
}

export function useLive2DModelInfo(url: string): { info: Live2DModelInfo | null; err: string | null } {
  const [info, setInfo] = useState<Live2DModelInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setInfo(null);
    setErr(null);
    if (!url) return;
    let alive = true;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (!alive) return;
        const refs = j?.FileReferences || {};
        setInfo({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          expressions: (refs.Expressions || []).map((e: any) => String(e.Name ?? "")).filter(Boolean),
          motions: Object.keys(refs.Motions || {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hitAreas: (j?.HitAreas || []).map((h: any) => String(h.Name || h.Id || "")).filter(Boolean),
        });
      })
      .catch((e) => alive && setErr(tr("mateSettings.avModelErr", { error: (e as Error).message })));
    return () => {
      alive = false;
    };
  }, [url]);
  return { info, err };
}
