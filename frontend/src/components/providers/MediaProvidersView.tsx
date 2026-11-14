import { useState } from "react";
import { useT, type MsgKey } from "../../i18n";
import ProvidersPanel from "../mate/settings/global/ProvidersPanel";
import HiggsfieldPanel, { HiggsfieldTab } from "./HiggsfieldPanel";
import CliVersionsSection from "./CliVersionsSection";
import ScrollRow from "../ui/ScrollRow";
import { openAppSettings } from "../../lib/openAppSettings";
import { Banner, LinkButton } from "../mate/settings/ui";

const SERVICES: { id: string; label: string | MsgKey; translated?: boolean }[] =
  [
    { id: "openai", label: "mateSettings.engOpenai", translated: true },
    { id: "elevenlabs", label: "mateSettings.engElevenlabs", translated: true },
    { id: "google", label: "mcp.google", translated: true },
    { id: "self", label: "mcp.selfHosted", translated: true },
  ];
export default function MediaProvidersView() {
  const t = useT(),
    [tab, setTab] = useState("higgsfield");
  return (
    <div className="max-w-2xl" data-testid="media-providers">
      <ScrollRow className="mb-5 gap-1.5 border-b border-border" role="tablist" aria-label={t("mcp.mediaTitle")} watch={tab}>
        <HiggsfieldTab
          selected={tab === "higgsfield"}
          onPick={() => setTab("higgsfield")}
        />
        {SERVICES.map((service) => (
          <button
            key={service.id}
            role="tab"
            aria-selected={tab === service.id}
            onClick={() => setTab(service.id)}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === service.id ? "border-accent text-content" : "border-transparent text-content-dim hover:text-content"}`}
            data-testid={`media-tab-${service.id}`}
          >
            {service.translated ? t(service.label as MsgKey) : service.label}
          </button>
        ))}
      </ScrollRow>
      {tab === "higgsfield" ? (
        <>
          <HiggsfieldPanel />
          <CliVersionsSection ids={["higgsfield"]} />
        </>
      ) : (
        <div className="space-y-4" key={tab}>
          {tab === "self" && (
            // (models on this server's own GPU have their own place: 로컬 모델 호스팅 → Voice Studio)
            <Banner tone="info" testId="media-local-moved" action={<LinkButton onClick={() => openAppSettings("voice-studio")} testId="media-open-voice-studio">{t("voiceStudio.open")}</LinkButton>}>
              {t("voiceStudio.movedHere")}
            </Banner>
          )}
          <ProvidersPanel
            engines={tab === "self" ? ["omnivoice", "whisper", "http"] : [tab]}
          />
        </div>
      )}
    </div>
  );
}
