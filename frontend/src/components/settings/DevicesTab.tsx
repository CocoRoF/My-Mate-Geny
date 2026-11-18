/**
 * Settings → 디바이스 인증 (docs/geny-net.md): the user's phone signs in by scanning a QR code shown here.
 *   Local execution (the desktop app)  Geny Net: a pairing code (one phone, 5 minutes) → the phone asks, both screens
 *                                      show the same six digits, the user allows it here; then the paired devices
 *                                      (rename / remove: its connections end at once) and how they reach this computer
 *                                      (same network directly, from anywhere through a relay — end-to-end encrypted).
 *   Over Geny Net itself               which computer this phone is linked to (and unlinking it, in the app).
 *   Server execution                   a sign-in code: this server's address + a one-time code for this account.
 */
import qrcode from "qrcode-generator";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  cancelLoginCode,
  closeOffer,
  decide,
  loginCode,
  netStatus,
  newOffer,
  NET_CHANGED,
  putNetSettings,
  removeDevice,
  renameDevice,
  type LoginCode,
  type NetDevice,
  type NetOffer,
  type NetStatus,
} from "../../api/net";
import { useT, type MsgKey } from "../../i18n";
import { relTime } from "../../i18n/format";
import { useConfigStore } from "../../stores/configStore";
import { openSettings } from "../../stores/uiStore";
import { Toggle } from "../mate/settings/ui";
import { confirmDialog } from "../ui/ConfirmDialog";
import HelpTip from "../ui/HelpTip";
import Icon from "../ui/Icon";
import PageLoading from "../ui/Loading";

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
  }, [text]);
  return (
    <div
      className="h-56 w-56 rounded-xl bg-white p-2 shadow-float [&>svg]:h-full [&>svg]:w-full"
      data-testid="net-qr"
      data-uri={text}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function Card({ title, help, right, children, testId }: { title: ReactNode; help?: ReactNode; right?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="card space-y-4 p-4 sm:p-5" data-testid={testId}>
      <div className="flex items-center gap-2">
        <h3 className="flex min-w-0 flex-1 items-center text-[14px] font-semibold text-content">
          {title}
          {help && <HelpTip>{help}</HelpTip>}
        </h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Pill({ tone, children, testId }: { tone: "ok" | "warn" | "off"; children: ReactNode; testId?: string }) {
  const cls = { ok: "bg-success/15 text-success", warn: "bg-warning/15 text-warning", off: "bg-surface-3 text-content-faint" }[tone];
  return <span className={`pill shrink-0 ${cls}`} data-testid={testId}>{children}</span>;
}

/** seconds left until `until` (ms), ticking */
function useLeft(until: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (until === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.round((until - now) / 1000));
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** the code on screen: the QR, the time it has left, a way to close it */
function CodeShown({ uri, left, onClose, onAgain, caption }: { uri: string; left: number; onClose: () => void; onAgain: () => void; caption: ReactNode }) {
  const t = useT();
  if (left <= 0) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[13px] text-content-dim" data-testid="net-code-expired">{t("net.expired")}</span>
        <button className="btn-primary !py-1.5 text-[12.5px]" onClick={onAgain} data-testid="net-code-again">
          <Icon name="refresh" size={13} /> {t("net.again")}
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 py-1">
      <Qr text={uri} />
      <div className="text-[12.5px] text-content-dim">{caption}</div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-[12.5px] tabular-nums text-content-faint" data-testid="net-code-left">{t("net.left", { time: mmss(left) })}</span>
        <button className="btn-ghost border border-border !py-1 text-[12px]" onClick={onClose} data-testid="net-code-close">
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

// ---- local execution: Geny Net --------------------------------------------------------------------------------------

const RELAY_STATE: Record<NonNullable<NetStatus["relay"]>, { key: MsgKey; tone: "ok" | "warn" | "off" }> = {
  online: { key: "net.relayOnline", tone: "ok" },
  connecting: { key: "net.relayConnecting", tone: "warn" },
  offline: { key: "net.relayOffline", tone: "warn" },
  off: { key: "net.off", tone: "off" },
};

function DeviceRow({ d, onChanged }: { d: NetDevice; onChanged: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.name);
  const [err, setErr] = useState("");
  const save = async () => {
    const n = name.trim();
    setEditing(false);
    if (!n || n === d.name) return setName(d.name);
    try {
      await renameDevice(d.id, n);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ body: t("net.removeConfirm", { name: d.name }), confirmLabel: t("common.remove"), danger: true }))) return;
    try {
      await removeDevice(d.id);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const seen = d.last_seen ? `${t(d.last_via === "relay" ? "net.viaRelay" : "net.viaLan")} · ${relTime(d.last_seen * 1000)}` : t("net.never");
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/50 px-3.5 py-2.5" data-testid={`net-device-${d.id}`}>
      <span className="relative shrink-0 text-content-dim">
        <Icon name="smartphone" size={18} />
        {d.online && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-success ring-2 ring-surface-2" title={t("net.online")} />}
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") {
                setName(d.name);
                setEditing(false);
              }
            }}
            className="field !py-1 text-[13px]"
            data-testid="net-device-name"
          />
        ) : (
          <div className="truncate text-[13px] font-medium text-content">{d.name}</div>
        )}
        <div className="truncate text-[11.5px] text-content-faint">{d.online ? t("net.online") : seen}</div>
        {err && <div className="text-[11.5px] text-danger">{err}</div>}
      </div>
      <button className="btn-ghost !p-1.5 text-content-faint hover:text-content" title={t("common.rename")} aria-label={t("common.rename")} onClick={() => setEditing(true)}>
        <Icon name="pencil" size={14} />
      </button>
      <button className="btn-ghost !p-1.5 text-content-faint hover:text-danger" title={t("common.remove")} aria-label={t("common.remove")} onClick={() => void remove()} data-testid="net-device-remove">
        <Icon name="trash" size={14} />
      </button>
    </li>
  );
}

function Ways({ st, onChanged }: { st: NetStatus; onChanged: (s: NetStatus) => void }) {
  const t = useT();
  const [url, setUrl] = useState(st.relay_url ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setUrl(st.relay_url ?? ""), [st.relay_url]);
  const put = async (p: Parameters<typeof putNetSettings>[0]) => {
    setBusy(true);
    setErr("");
    try {
      onChanged(await putNetSettings(p));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const relay = RELAY_STATE[st.relay ?? "off"];
  const where = st.on && st.lan_on && st.lan?.length ? st.lan.map((a) => `${a}:${st.port}`).join(" · ") : "";
  return (
    <Card title={t("net.waysTitle")} testId="net-ways">
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <Toggle on={!!st.lan_on} disabled={busy} onChange={(v) => void put({ lan: v })} label={t("net.lan")} testId="net-lan" />
          </div>
          <HelpTip>{t("net.lanHelp")}</HelpTip>
        </div>
        {where && <div className="font-mono sm:pl-12 text-[11.5px] text-content-faint" data-testid="net-lan-where">{where}</div>}
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <Toggle on={!!st.relay_on} disabled={busy} onChange={(v) => void put({ relay: v })} label={t("net.relay")} testId="net-relay" />
          </div>
          {st.relay_on && st.on && <Pill tone={relay.tone} testId="net-relay-state">{t(relay.key)}</Pill>}
          <HelpTip>{t("net.relayHelp")}</HelpTip>
        </div>
        {st.relay_on && (
          <form
            className="flex gap-2 sm:pl-12"
            onSubmit={(e) => {
              e.preventDefault();
              void put({ relay_url: url.trim() });
            }}
          >
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://"
              autoCapitalize="none"
              spellCheck={false}
              aria-label={t("net.relayUrl")}
              className="field !py-1.5 font-mono text-[12px]"
              data-testid="net-relay-url"
            />
            {url.trim() !== (st.relay_url ?? "") && (
              <button className="btn-primary shrink-0 !py-1.5 text-[12.5px]" disabled={busy}>
                {t("common.save")}
              </button>
            )}
          </form>
        )}
        {err && <p className="text-[12px] text-danger" role="alert">{err}</p>}
      </div>
    </Card>
  );
}

function LocalNet() {
  const t = useT();
  const [st, setSt] = useState<NetStatus | null>(null);
  const [offer, setOffer] = useState<NetOffer | null>(null);
  const [err, setErr] = useState("");
  const [paired, setPaired] = useState("");
  const left = useLeft(offer ? offer.expires * 1000 : null);

  const load = useCallback(() => {
    netStatus().then(setSt, (e) => setErr((e as Error).message));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(NET_CHANGED, load);
    return () => window.removeEventListener(NET_CHANGED, load);
  }, [load]);
  const pending = st?.pending ?? [];
  // (while a code is up or a phone is waiting: a look every 2 s, in case the push doesn't come)
  useEffect(() => {
    if (!offer && !pending.length) return;
    const id = window.setInterval(load, 2000);
    return () => window.clearInterval(id);
  }, [offer, pending.length, load]);
  // (the code was used: the phone's request is what's shown now)
  useEffect(() => {
    if (pending.length && offer) setOffer(null);
  }, [pending.length, offer]);
  // (the code is closed when the tab is)
  useEffect(() => () => void (offer && closeOffer(offer.id).catch(() => {})), [offer]);

  const show = async () => {
    setErr("");
    setPaired("");
    try {
      setOffer(await newOffer());
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const answer = async (id: string, name: string, allow: boolean) => {
    try {
      await decide(id, allow);
      if (allow) setPaired(name);
    } catch (e) {
      setErr((e as Error).message);
    }
    load();
  };

  if (!st) return err ? <p className="text-[13px] text-danger">{err}</p> : <PageLoading />;
  if (st.here) return <LinkedHere st={st} />;
  const devices = st.devices ?? [];
  return (
    <div className="space-y-4">
      <Card
        title={t("net.pairTitle")}
        help={t("net.pairHelp")}
        right={<Pill tone={st.on ? "ok" : "off"} testId="net-state">{t(st.on ? "net.on" : "net.off")}</Pill>}
        testId="net-pair"
      >
        {pending.map((r) => (
          <div key={r.id} className="space-y-3 rounded-xl border border-accent/40 bg-accent/5 p-4 text-center" data-testid="net-request">
            <div className="text-[13.5px] font-medium text-content">{t("net.asks", { name: r.name })}</div>
            <div className="font-mono text-[34px] font-semibold tracking-[0.18em] text-content tabular-nums" data-testid="net-sas">
              {r.sas.slice(0, 3)} {r.sas.slice(3)}
            </div>
            <div className="text-[12px] text-content-dim">{t("net.sasHint")}</div>
            <div className="flex justify-center gap-2">
              <button className="btn-ghost border border-border !py-1.5 text-[12.5px]" onClick={() => void answer(r.id, r.name, false)} data-testid="net-deny">
                {t("net.deny")}
              </button>
              <button className="btn-primary !py-1.5 text-[12.5px]" onClick={() => void answer(r.id, r.name, true)} data-testid="net-allow">
                <Icon name="check" size={13} /> {t("net.allow")}
              </button>
            </div>
          </div>
        ))}
        {!pending.length && offer && (
          <CodeShown
            uri={offer.uri}
            left={left}
            caption={t("net.scanCaption")}
            onClose={() => {
              void closeOffer(offer.id).catch(() => {});
              setOffer(null);
            }}
            onAgain={() => void show()}
          />
        )}
        {!pending.length && !offer && (
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-primary !py-1.5 text-[12.5px]" onClick={() => void show()} data-testid="net-show-qr">
              <Icon name="qr" size={14} /> {t("net.showQr")}
            </button>
            {paired && (
              <span className="flex items-center gap-1.5 text-[12.5px] text-success" role="status" data-testid="net-paired">
                <Icon name="check" size={13} /> {t("net.paired", { name: paired })}
              </span>
            )}
          </div>
        )}
        {err && <p className="text-[12px] text-danger" role="alert">{err}</p>}
      </Card>

      {devices.length > 0 && (
        <Card title={t("net.devicesTitle")} testId="net-devices">
          <ul className="space-y-2">
            {devices.map((d) => (
              <DeviceRow key={d.id} d={d} onChanged={load} />
            ))}
          </ul>
        </Card>
      )}

      <Ways st={st} onChanged={setSt} />
    </div>
  );
}

/** this page came over Geny Net: the phone it's on is linked to that computer */
function LinkedHere({ st }: { st: NetStatus }) {
  const t = useT();
  const cap = (window as any).Capacitor;
  const canForget = !!cap?.isNativePlatform?.();
  const forget = async () => {
    if (!(await confirmDialog({ body: t("net.forgetConfirm"), confirmLabel: t("net.forget"), danger: true }))) return;
    await cap.nativePromise("GenyNet", "forget", {}).catch(() => {});
  };
  return (
    <Card title={t("net.hereTitle")} testId="net-here">
      <div className="flex flex-wrap items-center gap-3">
        <Icon name="laptop" size={18} className="text-accent" />
        <span className="min-w-0 flex-1 text-[13px] text-content">{t("net.here", { name: st.name ?? "" })}</span>
        <Pill tone="ok">{t(st.here?.via === "relay" ? "net.viaRelay" : "net.viaLan")}</Pill>
      </div>
      {canForget && (
        <button className="btn-ghost border border-border !py-1.5 text-[12.5px] text-danger" onClick={() => void forget()} data-testid="net-forget">
          {t("net.forget")}
        </button>
      )}
    </Card>
  );
}

// ---- server execution: a sign-in code -------------------------------------------------------------------------------

function ServerLogin() {
  const t = useT();
  const [code, setCode] = useState<(LoginCode & { until: number }) | null>(null);
  const [err, setErr] = useState("");
  const left = useLeft(code ? code.until : null);
  const origin = window.location.origin;
  useEffect(() => () => void (code && cancelLoginCode(code.code).catch(() => {})), [code]);
  const show = async () => {
    setErr("");
    try {
      const c = await loginCode(origin);
      setCode({ ...c, until: Date.now() + c.expires_in * 1000 });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Card title={t("net.loginTitle")} help={t("net.loginHelp")} testId="net-login">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
        <dt className="text-content-faint">{t("net.server")}</dt>
        <dd className="truncate font-mono text-content" data-testid="net-login-server">{origin}</dd>
        {code && (
          <>
            <dt className="text-content-faint">{t("net.account")}</dt>
            <dd className="truncate text-content">{code.username}</dd>
          </>
        )}
      </dl>
      {code ? (
        <CodeShown
          uri={code.uri}
          left={left}
          caption={t("net.scanCaption")}
          onClose={() => {
            void cancelLoginCode(code.code).catch(() => {});
            setCode(null);
          }}
          onAgain={() => void show()}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-primary !py-1.5 text-[12.5px]" onClick={() => void show()} data-testid="net-show-login-qr">
            <Icon name="qr" size={14} /> {t("net.showQr")}
          </button>
          <button className="btn-ghost border border-border !py-1.5 text-[12.5px]" onClick={() => openSettings("updates", "downloads")}>
            <Icon name="download" size={13} /> {t("net.getApp")}
          </button>
        </div>
      )}
      {err && <p className="text-[12px] text-danger" role="alert">{err}</p>}
    </Card>
  );
}

export default function DevicesTab() {
  const local = useConfigStore((s) => s.executionMode) === "local";
  return local ? <LocalNet /> : <ServerLogin />;
}
