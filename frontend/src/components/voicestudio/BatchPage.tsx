/**
 * Voice Studio → 일괄 생성: many lines in one go — pasted or from a file (text: a line each, `[joy] …` for its feeling;
 * CSV with a `text` column and any of profile, feeling, seed, language, instruct, model; JSON: strings or objects with
 * the same keys), made with shared settings (a line's own columns win), one at a time at the GPU's lowest priority (a
 * mate's words go first). Progress, cancel, retry what failed, hear each line, a ZIP in a chosen format.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AUDIO_FORMATS,
  batchZipUrl,
  cancelBatch,
  createBatch,
  deleteBatch,
  getBatch,
  historyAudioUrl,
  listBatches,
  retryBatch,
  type AudioFormat,
  type Batch,
  type BatchState,
} from "../../api/voice";
import { useT, type MsgKey } from "../../i18n";
import { confirmDialog } from "../ui/ConfirmDialog";
import Icon from "../ui/Icon";
import { ErrorLine, Field, ProgressBar, Segmented, StatusBadge, type Status } from "../mate/settings/ui";
import { LineForm, useDefaultLine, useTts, type LineSettings } from "./lineForm";
import { Card, DownloadMenu, PlayButton, secs, useStudio } from "./shared";

type Fmt = "txt" | "csv" | "json";
const MAX_LINES = 500;

/** what the server will read, roughly — for the preview (the server's own reading decides) */
function preview(content: string, fmt: Fmt): { lines: { text: string; tag?: string }[]; error?: string } {
  const s = content.replace(/^﻿/, "");
  try {
    if (fmt === "json") {
      const d = JSON.parse(s || "[]");
      if (!Array.isArray(d)) return { lines: [], error: "list" };
      return {
        lines: d
          .map((x) => (typeof x === "string" ? { text: x } : x && typeof x === "object" ? { text: String(x.text ?? ""), tag: x.feeling ?? x.emotion ?? x.profile } : { text: "" }))
          .filter((x) => x.text.trim()),
      };
    }
    if (fmt === "csv") {
      const rows = s.split(/\r?\n/).filter((r) => r.trim());
      const cells = (r: string) => (r.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim());
      const head = cells(rows[0] ?? "").map((h) => h.toLowerCase());
      const ti = head.indexOf("text");
      const fi = Math.max(head.indexOf("feeling"), head.indexOf("emotion"));
      const body = ti >= 0 ? rows.slice(1) : rows;
      return { lines: body.map((r) => cells(r)).map((c) => ({ text: c[ti >= 0 ? ti : 0] ?? "", tag: fi >= 0 ? c[fi] : undefined })).filter((x) => x.text) };
    }
    return {
      lines: s
        .split(/\r?\n/)
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => {
          const m = r.match(/^\[([a-zA-Z_]+)\]\s*/);
          return m ? { text: r.slice(m[0].length), tag: m[1] } : { text: r };
        })
        .filter((x) => x.text),
    };
  } catch {
    return { lines: [], error: "parse" };
  }
}

const STATE_STATUS: Record<BatchState, Status> = {
  queued: "checking",
  running: "checking",
  done: "ok",
  done_with_errors: "warn",
  cancelled: "off",
  interrupted: "warn",
  failed: "error",
};

export default function BatchPage() {
  const t = useT();
  const { go } = useStudio();
  const tts = useTts();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [running, setRunning] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const r = await listBatches();
      setBatches(r.batches);
      setRunning(r.running);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  const active = batches.some((b) => b.state === "running" || b.state === "queued");
  useEffect(() => {
    void reload();
    const timer = setInterval(() => document.visibilityState === "visible" && void reload(), active ? 1500 : 10000);
    return () => clearInterval(timer);
  }, [reload, active]);
  if (!tts.length) {
    return (
      <Card>
        <p className="text-[12.5px] text-content-dim">{t("localVoice.noTts")}</p>
        <button className="btn-soft mt-2 !py-1 text-[12px]" onClick={() => go("models")}>{t("voiceStudio.gnToModels")}</button>
      </Card>
    );
  }
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" data-testid="vs-batch">
      <NewBatch
        onStarted={async (b) => {
          await reload();
          setOpen(b.id);
        }}
      />
      <div className="space-y-2" data-testid="vs-batch-list">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 text-[13px] font-semibold text-content">{t("voiceStudio.btJobs", { n: batches.length })}</h3>
          <button className="btn-ghost !p-1.5" onClick={() => void reload()} title={t("voiceStudio.refresh")}>
            <Icon name="refresh" size={13} />
          </button>
        </div>
        {batches.length === 0 && (
          <Card>
            <p className="text-[12.5px] text-content-faint">{t("voiceStudio.btNoJobs")}</p>
          </Card>
        )}
        {batches.map((b) => (
          <Job key={b.id} b={b} isRunning={running.includes(b.id)} open={open === b.id} onToggle={() => setOpen(open === b.id ? null : b.id)} onChange={reload} />
        ))}
        <ErrorLine text={err} />
      </div>
    </div>
  );
}

function NewBatch({ onStarted }: { onStarted: (b: Batch) => Promise<void> }) {
  const t = useT();
  const initial = useDefaultLine();
  const [line, setLine] = useState<LineSettings>(initial);
  const [label, setLabel] = useState("");
  const [fmt, setFmt] = useState<Fmt>("txt");
  const [content, setContent] = useState("");
  const [seedMode, setSeedMode] = useState<"random" | "fixed">("random");
  const [seed, setSeed] = useState(42);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const { voices } = useStudio();
  // (the profiles came after the page opened: start from them)
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !voices.length) return;
    started.current = true;
    if (!line.voice_id) setLine(initial());
  }, [voices.length, line.voice_id, initial]);
  const p = useMemo(() => preview(content, fmt), [content, fmt]);
  const load = async (f: File) => {
    const ext = f.name.split(".").pop()?.toLowerCase();
    setFmt(ext === "csv" ? "csv" : ext === "json" ? "json" : "txt");
    setContent(await f.text());
    if (!label) setLabel(f.name.replace(/\.[^.]+$/, ""));
  };
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const b = await createBatch({
        label: label.trim(),
        format: fmt,
        content,
        settings: { ...line, seed: seedMode === "fixed" ? seed : undefined },
      });
      setContent("");
      setLabel("");
      await onStarted(b);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const over = p.lines.length > MAX_LINES;
  return (
    <div className="space-y-3">
      <Card title={t("voiceStudio.btNew")} testId="vs-batch-new">
        <div className="space-y-2">
          <Field label={t("voiceStudio.btLabel")}>
            <input className="field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("voiceStudio.btLabelPh")} data-testid="vs-batch-label" />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={fmt}
              onChange={setFmt}
              options={[
                { id: "txt", label: t("voiceStudio.btTxt") },
                { id: "csv", label: "CSV" },
                { id: "json", label: "JSON" },
              ]}
              testId="vs-batch-format"
            />
            <span className="flex-1" />
            <input ref={file} type="file" accept=".txt,.csv,.json,text/plain,text/csv,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} data-testid="vs-batch-file" />
            <button className="btn-soft !py-1 text-[12px]" onClick={() => file.current?.click()}>
              <Icon name="upload" size={12} /> {t("voiceStudio.btFile")}
            </button>
          </div>
          <textarea
            className="field min-h-[160px] font-mono text-[12.5px] leading-relaxed"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t(`voiceStudio.btPh_${fmt}` as MsgKey)}
            data-testid="vs-batch-content"
          />
          <p className="text-[11px] leading-snug text-content-faint">{t(`voiceStudio.btHelp_${fmt}` as MsgKey)}</p>
          {content.trim() && (
            <div className="rounded-lg border border-border/60 bg-surface/40 p-2" data-testid="vs-batch-preview">
              <p className={`text-[12px] ${p.error || over ? "text-danger" : "text-content-dim"}`}>
                {p.error ? t("voiceStudio.btParseError") : over ? t("voiceStudio.btTooMany", { n: p.lines.length, max: MAX_LINES }) : t("voiceStudio.btLines", { n: p.lines.length })}
              </p>
              <ol className="mt-1 max-h-40 space-y-0.5 overflow-auto text-[11.5px] text-content">
                {p.lines.slice(0, 30).map((x, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="w-6 shrink-0 text-right tabular-nums text-content-faint">{i + 1}</span>
                    {x.tag && <span className="pill border border-border bg-surface-3/50 text-[10px] text-content-dim">{x.tag}</span>}
                    <span className="min-w-0 flex-1 truncate">{x.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </Card>
      <Card title={t("voiceStudio.btShared")}>
        <LineForm value={line} onChange={setLine} testId="vs-batch-line" />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium text-content-dim">{t("voiceStudio.gnSeed")}</span>
          <Segmented
            value={seedMode}
            onChange={setSeedMode}
            options={[
              { id: "random", label: t("voiceStudio.btSeedRandom") },
              { id: "fixed", label: t("voiceStudio.btSeedFixed") },
            ]}
          />
          {seedMode === "fixed" && <input className="field !w-32 !py-1 font-mono text-[12.5px]" type="number" min={0} value={seed} onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[11px] leading-snug text-content-faint">{t("voiceStudio.btPriorityHint")}</span>
          <button className="btn-primary !px-4 !py-1.5 text-[13px]" disabled={busy || !p.lines.length || !!p.error || over} onClick={() => void start()} data-testid="vs-batch-start">
            {busy ? <Icon name="spinner" size={13} spin /> : <Icon name="play" size={13} />} {t("voiceStudio.btStart", { n: p.lines.length })}
          </button>
        </div>
        <ErrorLine text={err} />
      </Card>
    </div>
  );
}

function Job({ b, isRunning, open, onToggle, onChange }: { b: Batch; isRunning: boolean; open: boolean; onToggle: () => void; onChange: () => Promise<void> }) {
  const t = useT();
  const [full, setFull] = useState<Batch | null>(null);
  const [fmt, setFmt] = useState<AudioFormat>("wav");
  const [err, setErr] = useState<string | null>(null);
  const live = b.state === "running" || b.state === "queued";
  useEffect(() => {
    if (!open) return;
    let dead = false;
    const get = () => getBatch(b.id).then((x) => !dead && setFull(x)).catch((e) => !dead && setErr((e as Error).message));
    void get();
    const timer = live ? setInterval(get, 2000) : undefined;
    return () => {
      dead = true;
      if (timer) clearInterval(timer);
    };
  }, [open, b.id, live, b.done, b.failed]);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
    await onChange();
  };
  const remove = async () => {
    if (!(await confirmDialog({ body: t("voiceStudio.btDeleteConfirm", { n: b.done }), confirmLabel: t("voiceStudio.delete"), danger: true }))) return;
    await act(() => deleteBatch(b.id));
  };
  const finished = b.done + b.failed;
  return (
    <Card testId={`vs-batch-${b.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={onToggle} aria-expanded={open}>
          <Icon name={open ? "chevron-down" : "chevron"} size={13} />
          <span className="truncate text-[13px] font-medium text-content">{b.label || t("voiceStudio.btUnnamed")}</span>
        </button>
        <StatusBadge status={STATE_STATUS[b.state]} testId={`vs-batch-state-${b.id}`}>
          {t(`voiceStudio.bs_${b.state}` as MsgKey)}
        </StatusBadge>
      </div>
      <div className="mt-2">
        <ProgressBar value={b.total ? finished / b.total : 0} indeterminate={b.state === "queued"} />
        <p className="mt-1 text-[11px] tabular-nums text-content-faint">
          {t("voiceStudio.btProgress", { done: b.done, total: b.total })}
          {b.failed ? ` · ${t("voiceStudio.btFailed", { n: b.failed })}` : ""} · {new Date(b.created_at).toLocaleString()}
        </p>
        {b.error && <p className="mt-1 text-[11.5px] text-danger">{b.error}</p>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {(live || isRunning) && (
          <button className="btn-soft !py-1 text-[12px]" onClick={() => void act(() => cancelBatch(b.id))} data-testid={`vs-batch-cancel-${b.id}`}>
            <Icon name="stop" size={12} /> {t("voiceStudio.cancel")}
          </button>
        )}
        {!live && b.failed > 0 && (
          <button className="btn-soft !py-1 text-[12px]" onClick={() => void act(() => retryBatch(b.id, true))} data-testid={`vs-batch-retry-${b.id}`}>
            <Icon name="refresh" size={12} /> {t("voiceStudio.btRetryFailed")}
          </button>
        )}
        {!live && (b.state === "cancelled" || b.state === "interrupted") && b.done < b.total && (
          <button className="btn-soft !py-1 text-[12px]" onClick={() => void act(() => retryBatch(b.id, false))}>
            <Icon name="play" size={12} /> {t("voiceStudio.btResume")}
          </button>
        )}
        <span className="flex-1" />
        {b.done > 0 && (
          <>
            <select className="field !w-auto !py-1 text-[12px]" value={fmt} onChange={(e) => setFmt(e.target.value as AudioFormat)} aria-label={t("voiceStudio.btZipFormat")}>
              {AUDIO_FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
            <a className="btn-soft !py-1 text-[12px]" href={batchZipUrl(b.id, fmt)} download data-testid={`vs-batch-zip-${b.id}`}>
              <Icon name="download" size={12} /> ZIP
            </a>
          </>
        )}
        {!live && (
          <button className="btn-ghost !p-1.5 hover:text-danger" onClick={() => void remove()} title={t("voiceStudio.delete")} data-testid={`vs-batch-delete-${b.id}`}>
            <Icon name="trash" size={13} />
          </button>
        )}
      </div>
      {open && full?.items && (
        <ol className="mt-2 max-h-96 space-y-1 overflow-auto border-t border-border/60 pt-2" data-testid={`vs-batch-items-${b.id}`}>
          {full.items.map((it) => (
            <li key={it.idx} className="flex items-center gap-2 text-[12px]">
              <span className="w-7 shrink-0 text-right tabular-nums text-content-faint">{it.idx + 1}</span>
              {it.state === "done" && it.history_id ? (
                <PlayButton url={historyAudioUrl(it.history_id)} small />
              ) : it.state === "running" ? (
                <span className="grid h-7 w-7 place-items-center"><Icon name="spinner" size={12} spin /></span>
              ) : (
                <span className={`grid h-7 w-7 place-items-center ${it.state === "failed" ? "text-danger" : "text-content-faint"}`}>
                  <Icon name={it.state === "failed" ? "warning" : "clock"} size={12} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-content" title={it.text}>{it.text}</span>
                {it.error ? (
                  <span className="block truncate text-[11px] text-danger" title={it.error}>{it.error}</span>
                ) : it.state === "done" ? (
                  <span className="block text-[11px] tabular-nums text-content-faint">
                    {secs(it.seconds)} · {t("voiceStudio.rtfN", { n: it.rtf != null ? it.rtf.toFixed(2) : "–" })} · {t("voiceStudio.gnSeedN", { n: String(it.seed ?? "–") })}
                  </span>
                ) : null}
              </span>
              {it.state === "done" && it.history_id && <DownloadMenu href={(f) => historyAudioUrl(it.history_id, f, true)} />}
            </li>
          ))}
        </ol>
      )}
      <ErrorLine text={err} />
    </Card>
  );
}
