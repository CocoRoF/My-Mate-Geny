/** Places: her neighbourhood, like a game's map. Choosing a place shows it; asking her along is a message like any other, and she decides. */
import { useState } from "react";
import type { Mate } from "../../../api/mates";
import { useLang, useT } from "../../../i18n";
import { LifeOff, MapView, PlaceDetail, PlaceGrid, useLifeView } from "../life/LifeSections";
import { lifeName } from "../life/needs";
import StageWindow from "./StageWindow";

export default function PlacesWindow({ mate, phone, onClose, onSay }: { mate: Mate; phone: boolean; onClose: () => void; onSay: (text: string) => void }) {
  const t = useT();
  const locale = useLang();
  const { v, setV, err } = useLifeView(mate);
  const [picked, setPicked] = useState<string | null>(null);
  const life = v?.enabled ? v : null;
  const here = life?.places?.find((p) => p.here);
  const chosen = life?.places?.find((p) => p.key === (picked ?? here?.key));
  return (
    <StageWindow
      title={t("stage.placesTitle")}
      sub={life ? t("stage.placesSub", { name: mate.name, place: lifeName(life.place_name, locale, life.place) }) : undefined}
      icon="map"
      phone={phone}
      onClose={onClose}
      testId="stage-places"
    >
      {err && <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{t("life.error", { error: err })}</p>}
      {!v ? (
        !err && <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
      ) : !life ? (
        <LifeOff mate={mate} onOn={setV} />
      ) : (
        <>
          <MapView v={life} picked={chosen?.key ?? null} onPick={setPicked} />
          {chosen && <PlaceDetail p={chosen} withUser={life.with_user} onSay={(text) => { onClose(); onSay(text); }} />}
          <PlaceGrid v={life} picked={chosen?.key ?? null} onPick={setPicked} />
        </>
      )}
    </StageWindow>
  );
}
