/**
 * Settings → 로컬 모델 호스팅 → Image Studio (docs/local-image.md "Image Studio"): picture and clip models served from
 * this machine's own GPU, set up here and used by the avatar maker (as Voice Studio's voices are used by the mates).
 *   개요     the engine (ComfyUI: running or not, its GPU memory), the job running and waiting, what the avatar maker
 *            can run here stage by stage, the latest results
 *   모델     the engine and each model: what it is for, what it takes (measured), its license (read, accepted, then
 *            downloaded), its install progress
 *   시험     each recipe tried by hand: a draft from words, a picture changed by words, a loop from a picture, a cut-out
 *   기록     every picture and clip made here and for the avatar maker: look, download, star, use as the next input
 *   설정     the model each use takes, a recipe's knobs, the avatar maker's engine per stage, the idle time
 * The page is part of the address (`&page=`), so a link opens it.
 */
import { lazy, Suspense } from "react";
import { useT, type MsgKey } from "../../i18n";
import Icon, { type IconName } from "../ui/Icon";
import ScrollRow from "../ui/ScrollRow";
import { Banner, ErrorLine, ProgressBar } from "../mate/settings/ui";
import { gateText, gb, ImageStudioProvider, PAGES, useImageStudio, type Page } from "./shared";
import "./imagestudio.css";

const OverviewPage = lazy(() => import("./OverviewPage"));
const ModelsPage = lazy(() => import("./ModelsPage"));
const TryPage = lazy(() => import("./TryPage"));
const HistoryPage = lazy(() => import("./HistoryPage"));
const SettingsPage = lazy(() => import("./SettingsPage"));

const ICON: Record<Page, IconName> = {
  overview: "activity",
  models: "cpu",
  try: "sparkles",
  history: "history",
  settings: "settings",
};

export default function ImageStudio() {
  return (
    <ImageStudioProvider>
      <Studio />
    </ImageStudioProvider>
  );
}

function Studio() {
  const t = useT();
  const { status, statusErr, page, go } = useImageStudio();
  const gpu = status?.system.gpus[0];
  return (
    <div className="space-y-3" data-testid="image-studio" data-page={page}>
      <div className="flex flex-wrap-reverse items-end justify-end gap-x-3 gap-y-2 border-b border-border">
        {status && (
          <span
            className={`pill order-last mb-1.5 shrink-0 border ${status.gate.ok ? "border-success/40 bg-success/10 text-success" : "border-warning/40 bg-warning/10 text-warning"}`}
            data-testid="image-studio-gate"
            title={gateText(t, status.gate)}
          >
            <Icon name={status.gate.ok ? "check" : "warning"} size={11} />{" "}
            {gpu ? t("imageStudio.gatePill", { name: gpu.name, used: gb(gpu.used), total: gb(gpu.total) }) : t("imageStudio.notHere")}
          </span>
        )}
        <ScrollRow className="-mx-1 min-w-0 flex-1 basis-[520px] px-1">
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
                data-testid={`is-tab-${p}`}
              >
                <Icon name={ICON[p]} size={14} />
                {t(`imageStudio.page_${p}` as MsgKey)}
                {p === "overview" && status?.queue.running && <span className="is-running-ring h-1.5 w-1.5 rounded-full bg-accent" />}
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
            <Banner tone="warn" testId="image-studio-not-here">
              {gateText(t, status.gate)}
            </Banner>
          )}
          <Suspense fallback={<ProgressBar indeterminate />}>
            {page === "overview" && <OverviewPage />}
            {page === "models" && <ModelsPage />}
            {page === "try" && <TryPage />}
            {page === "history" && <HistoryPage />}
            {page === "settings" && <SettingsPage />}
          </Suspense>
        </>
      )}
    </div>
  );
}
