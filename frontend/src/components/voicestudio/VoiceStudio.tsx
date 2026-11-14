/**
 * Settings → 로컬 모델 호스팅 → Voice Studio (docs/local-voice.md "Voice Studio"): speech models served from this
 * machine's own GPU, made to work.
 *   개요       the GPU now (load, memory and whose it is — this app's models, other programs — temperature, power) and
 *              over the last half hour, the models on it, the GPU queue (running, waiting, done: for whom), events
 *   모델       download (after the license) and serve each model: install, load / unload, its default parameters
 *   프로필     voices: clips by feeling (upload, record, trim, transcribe), description, default model and parameters
 *   생성       a line in a profile's voice (clone), a described one (design) or the model's own (auto) → play, download
 *   일괄 생성  many lines at once from text / CSV / JSON → progress, ZIP
 *   히스토리   every line made here: search, play, download, star, make again, save as a profile's clip
 *   도구       A/B comparison, seed search, a clip's analysis (and the best stretch to keep), transcription, language
 *   설정       GPU share, idle times, history limits, the default models and profile
 * The page is part of the address (`&page=`), so a link opens it.
 */
import { lazy, Suspense } from "react";
import { useT, type MsgKey } from "../../i18n";
import Icon, { type IconName } from "../ui/Icon";
import ScrollRow from "../ui/ScrollRow";
import { ProgressBar, ErrorLine, Banner } from "../mate/settings/ui";
import { gateText, PAGES, StudioProvider, useStudio, type Page, gb } from "./shared";

const OverviewPage = lazy(() => import("./OverviewPage"));
const ModelsPage = lazy(() => import("./ModelsPage"));
const ProfilesPage = lazy(() => import("./ProfilesPage"));
const GeneratePage = lazy(() => import("./GeneratePage"));
const BatchPage = lazy(() => import("./BatchPage"));
const HistoryPage = lazy(() => import("./HistoryPage"));
const ToolsPage = lazy(() => import("./ToolsPage"));
const SettingsPage = lazy(() => import("./StudioSettingsPage"));

const ICON: Record<Page, IconName> = {
  overview: "activity",
  models: "cpu",
  profiles: "user",
  generate: "sparkles",
  batch: "layers",
  history: "history",
  tools: "wand",
  settings: "settings",
};

export default function VoiceStudio() {
  return (
    <StudioProvider>
      <Studio />
    </StudioProvider>
  );
}

function Studio() {
  const t = useT();
  const { status, statusErr, page, go } = useStudio();
  const gpu = status?.system.gpus[0];
  return (
    <div className="space-y-3" data-testid="voice-studio" data-page={page}>
      {/* the pages, and the GPU at a glance beside them (above them on a narrow screen) */}
      <div className="flex flex-wrap-reverse items-end justify-end gap-x-3 gap-y-2 border-b border-border">
        {status && (
          <span
            className={`pill order-last mb-1.5 shrink-0 border ${status.gate.ok ? "border-success/40 bg-success/10 text-success" : "border-warning/40 bg-warning/10 text-warning"}`}
            data-testid="voice-studio-gate"
            title={gateText(t, status.gate)}
          >
            <Icon name={status.gate.ok ? "check" : "warning"} size={11} />{" "}
            {gpu ? t("voiceStudio.gatePill", { name: gpu.name, used: gb(gpu.used), total: gb(gpu.total) }) : t("localVoice.notHere")}
          </span>
        )}
        <ScrollRow className="-mx-1 min-w-0 flex-1 basis-[700px] px-1">
          <div className="-mb-px flex gap-1" role="tablist">
            {PAGES.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={page === p}
                data-active={page === p}
                onClick={() => go(p)}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[13px] font-medium text-content-dim transition hover:text-content data-[active=true]:border-accent data-[active=true]:text-content"
                data-testid={`vs-tab-${p}`}
              >
                <Icon name={ICON[p]} size={14} />
                {t(`voiceStudio.page_${p}` as MsgKey)}
              </button>
            ))}
          </div>
        </ScrollRow>
      </div>
      {!status ? (
        statusErr ? <ErrorLine text={statusErr} /> : <ProgressBar indeterminate />
      ) : (
        <>
          {!status.gate.ok && page !== "overview" && page !== "models" && page !== "settings" && (
            <Banner tone="warn" testId="voice-studio-not-here">
              {gateText(t, status.gate)}
            </Banner>
          )}
          <Suspense fallback={<ProgressBar indeterminate />}>
            {page === "overview" && <OverviewPage />}
            {page === "models" && <ModelsPage />}
            {page === "profiles" && <ProfilesPage />}
            {page === "generate" && <GeneratePage />}
            {page === "batch" && <BatchPage />}
            {page === "history" && <HistoryPage />}
            {page === "tools" && <ToolsPage />}
            {page === "settings" && <SettingsPage />}
          </Suspense>
        </>
      )}
    </div>
  );
}
