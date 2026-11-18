/**
 * Mate settings → 기질 (docs/geny-state-system.md §3): how she is made to feel — her temperament, read from her persona
 * or set by hand (gss/TemperamentEditor; saved with the Save bar). Settings only: how she feels now, what she is to the
 * user, the promises and the record of what happened are in the ♥ status window (stage/StatusWindow.tsx).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { deriveTemperament, getGss, type GssView, type Mate, type Temperament } from "../../../api/mates";
import { useMateStore } from "../../../stores/mateStore";
import { useT } from "../../../i18n";
import { cleanTemperament, overrideOf, sameTemperament } from "../../../mate/gss";
import { ifConfirmed } from "../../ui/ConfirmDialog";
import { ErrorLine, SaveBar, Section, useSaver } from "./ui";
import TemperamentEditor from "./gss/TemperamentEditor";

export default function TemperamentTab({ mate }: { mate: Mate }) {
  const t = useT();
  const [v, setV] = useState<GssView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      // (only what is in effect and what was set by hand: the journal isn't needed here)
      const x = await getGss(mate.id, { limit: 1 });
      setV(x);
      setErr(null);
      return x;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    }
  }, [mate.id]);
  useEffect(() => {
    void load();
  }, [load]);

  // her temperament: the form follows what is in effect until it is touched
  const effective = useMemo(() => cleanTemperament(v?.temperament), [v]);
  const custom = useMemo(() => cleanTemperament(v?.temperament_custom), [v]);
  const [draft, setDraft] = useState<Temperament | null>(null);
  const form = draft ?? effective;
  const dirty = draft !== null && !sameTemperament(draft, effective);
  const saver = useSaver();
  const [deriving, setDeriving] = useState(false);
  const [tempErr, setTempErr] = useState<string | null>(null);
  const savePrefs = (temperament: Temperament | null) => useMateStore.getState().patch(mate.id, { prefs: { temperament } });
  const save = () =>
    saver.run(async () => {
      await savePrefs(overrideOf(form, effective, custom));
      await load();
      setDraft(null);
    });
  const backToHers = () =>
    ifConfirmed({ body: t("gss.tempResetConfirm", { name: mate.name }), confirmLabel: t("gss.tempReset") }, async () => {
      setTempErr(null);
      try {
        await savePrefs(null);
        await load();
        setDraft(null);
      } catch (e) {
        setTempErr((e as Error).message);
      }
    });
  const derive = async () => {
    setDeriving(true);
    setTempErr(null);
    try {
      const r = await deriveTemperament(mate.id);
      const x = await load();
      // (saved by the server: the form shows it, and stays changed only if what is in effect didn't take it)
      const next = cleanTemperament({ ...cleanTemperament(x?.temperament ?? v?.temperament), ...cleanTemperament(r.temperament) });
      setDraft(x && sameTemperament(next, cleanTemperament(x.temperament)) ? null : next);
    } catch (e) {
      setTempErr((e as Error).message);
    } finally {
      setDeriving(false);
    }
  };
  const askDerive = () => (Object.keys(custom).length || dirty ? ifConfirmed({ body: t("gss.tempDeriveConfirm", { name: mate.name }), confirmLabel: t("gss.tempDerive") }, derive) : void derive());

  if (!v) {
    return (
      <Section title={t("mateSettings.tabState")}>
        <ErrorLine text={err} />
        {!err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>}
      </Section>
    );
  }
  return (
    <>
      <ErrorLine text={err} />
      <TemperamentEditor name={mate.name} form={form} effective={effective} custom={custom} onChange={setDraft} onDerive={askDerive} onReset={backToHers} deriving={deriving} err={tempErr} dirty={dirty} />
      <SaveBar saver={saver} onSave={() => void save()} dirty={dirty} onReset={() => setDraft(null)} label={t("gss.tempSave")} />
    </>
  );
}
