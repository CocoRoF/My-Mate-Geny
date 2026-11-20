/**
 * Mate settings → 내보내기 (app/mate/transfer.py; docs/mate.md "Export and import"): her as one file — the character, how she
 * talks, her temperament, avatar and outfits, profile picture, voice settings — for another My Mate Geny to import as a new
 * mate. What is between her and this user (memories, conversations, the relationship) stays here.
 */
import type { Mate } from "../../../api/mates";
import { mateExportUrl } from "../../../api/mateTransfer";
import { useT } from "../../../i18n";
import Icon from "../../ui/Icon";
import { Section } from "./ui";

export default function ExportTab({ mate }: { mate: Mate }) {
  const t = useT();
  const draft = Boolean((mate as { draft?: boolean }).draft);
  return (
    <Section title={t("mateSettings.exportTitle", { name: mate.name })} hint={t("mateSettings.exportHint")} testId="mate-export-section">
      <ul className="space-y-1.5 text-[12px] leading-relaxed text-content-dim">
        <li className="flex gap-2">
          <Icon name="lock" size={13} className="mt-0.5 shrink-0 text-content-faint" />
          {t("mateSettings.exportStays")}
        </li>
        <li className="flex gap-2">
          <Icon name="mic" size={13} className="mt-0.5 shrink-0 text-content-faint" />
          {t("mateSettings.exportVoice")}
        </li>
        {mate.builtin && (
          <li className="flex gap-2">
            <Icon name="sparkles" size={13} className="mt-0.5 shrink-0 text-content-faint" />
            {t("mateSettings.exportBuiltin")}
          </li>
        )}
      </ul>
      <div className="flex items-center justify-end gap-3">
        {draft && <span className="text-[12px] text-content-faint">{t("mateSettings.exportDraft")}</span>}
        {draft ? (
          <button className="btn-primary" disabled>
            <Icon name="download" size={14} /> {t("mateSettings.exportBtn")}
          </button>
        ) : (
          <a className="btn-primary" href={mateExportUrl(mate.id)} download data-testid="mate-export">
            <Icon name="download" size={14} /> {t("mateSettings.exportBtn")}
          </a>
        )}
      </div>
    </Section>
  );
}
