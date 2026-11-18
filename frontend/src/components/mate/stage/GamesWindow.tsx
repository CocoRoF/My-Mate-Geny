/**
 * 놀이 — little games with her (app/mate/games.py, docs/mate-games.md). Pick one; 끝말잇기, 스무고개 and 초성 퀴즈 are played
 * in the conversation (here too: what is typed below goes to her as a message), 가위바위보 with the buttons. The app keeps the
 * rules, the score and what she keeps secret; she plays as herself.
 */
import { useState } from "react";
import { gameAction, type GameKind, type GameView, type Mate, type RpsHand } from "../../../api/mates";
import { useT, type MsgKey } from "../../../i18n";
import Icon from "../../ui/Icon";
import { Card } from "../life/LifeSections";
import StageWindow from "./StageWindow";

const GLYPH: Record<GameKind, string> = { wordchain: "🔗", twenty: "❓", chosung: "ㄱㄴ", rps: "✌️" };
const HANDS: { id: RpsHand; glyph: string; label: MsgKey }[] = [
  { id: "rock", glyph: "✊", label: "games.hand_rock" },
  { id: "scissors", glyph: "✌️", label: "games.hand_scissors" },
  { id: "paper", glyph: "✋", label: "games.hand_paper" },
];
const GLYPH_OF: Record<RpsHand, string> = { rock: "✊", scissors: "✌️", paper: "✋" };

export default function GamesWindow({ mate, phone, game, onClose, onSend }: { mate: Mate; phone: boolean; game: { v: GameView | null; setV: (v: GameView) => void }; onClose: () => void; onSend: (text: string) => void }) {
  const t = useT();
  const { v, setV } = game;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const act = (body: Parameters<typeof gameAction>[1]) => {
    setBusy(true);
    setErr(null);
    gameAction(mate.id, body)
      .then(setV)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };
  const g = v?.game ?? null;
  const name = mate.name;
  const send = () => {
    const x = text.trim();
    if (!x) return;
    onSend(x);
    setText("");
  };
  return (
    <StageWindow title={t("games.title", { name })} sub={g ? t(`games.name_${g.game}` as MsgKey) : t("games.sub")} icon="dice" phone={phone} onClose={onClose} testId="stage-games">
      {err && <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{err}</p>}
      {!v ? (
        <p className="text-[12px] text-content-faint">{t("common.loading")}</p>
      ) : !g ? (
        <div className="grid gap-2.5 sm:grid-cols-2" data-testid="games-pick">
          {v.games.map((k) => (
            <button
              key={k}
              type="button"
              disabled={busy}
              onClick={() => act({ action: "start", game: k })}
              className="group flex items-start gap-3 rounded-2xl border border-content/10 bg-content/[0.04] p-3 text-left transition hover:border-accent/50 hover:bg-accent-soft"
              data-testid={`games-start-${k}`}
            >
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-content/10 text-[20px] font-bold text-content">{GLYPH[k]}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold text-content">{t(`games.name_${k}` as MsgKey)}</span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-content-faint">{t(`games.desc_${k}` as MsgKey, { name })}</span>
                {(v.record[k]?.user || v.record[k]?.mate) ? (
                  <span className="mt-1 block text-[11px] tabular-nums text-content-dim">{t("games.record", { user: String(v.record[k].user), mate: String(v.record[k].mate) })}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <Card testId="games-board">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-semibold text-content">{t(`games.name_${g.game}` as MsgKey)}</span>
              <span className="pill bg-content/10 tabular-nums text-content-dim" data-testid="games-score">
                {t("games.score", { user: String(g.score.user), mate: String(g.score.mate), name })}
              </span>
              {g.status === "on" && g.game !== "rps" && (
                <span className={`ml-auto text-[12px] ${g.turn === "user" ? "text-accent" : "text-content-faint"}`} data-testid="games-turn" data-turn={g.turn ?? ""}>
                  {g.turn === "user" ? t("games.yourTurn") : t("games.herTurn", { name })}
                </span>
              )}
            </div>
            <div className="mt-3">
              <Board v={v} name={name} />
            </div>
            {g.game === "rps" && g.status === "on" && (
              <div className="mt-3 grid grid-cols-3 gap-2" data-testid="games-hands">
                {HANDS.map((h) => (
                  <button key={h.id} type="button" disabled={busy} onClick={() => act({ action: "throw", hand: h.id })} className="btn-soft flex-col !gap-1 !py-3" data-testid={`games-throw-${h.id}`}>
                    <span className="text-[28px] leading-none">{h.glyph}</span>
                    <span className="text-[12px]">{t(h.label)}</span>
                  </button>
                ))}
              </div>
            )}
          </Card>
          {g.status === "on" && g.game !== "rps" && (
            <div className="space-y-1.5">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={t(`games.say_${g.game}` as MsgKey)}
                  className="field min-w-0 flex-1 !py-1.5 text-[13px]"
                  data-testid="games-say"
                />
                <button type="submit" className="btn-primary shrink-0 !py-1.5 text-[12.5px]" disabled={!text.trim()} data-testid="games-send">
                  <Icon name="send" size={13} /> {t("games.send")}
                </button>
              </form>
              <p className="text-[11px] text-content-faint">{t("games.chatToo")}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {g.status === "on" ? (
              <>
                {g.game !== "rps" && (
                  <button type="button" className="btn-ghost border border-border !py-1.5 text-[12.5px]" disabled={busy} onClick={() => act({ action: "give_up" })} data-testid="games-give-up">
                    <Icon name="flag" size={13} /> {g.game === "chosung" && g.ready ? t("games.pass") : t("games.giveUp")}
                  </button>
                )}
                <button type="button" className="btn-ghost !py-1.5 text-[12.5px]" disabled={busy} onClick={() => act({ action: "close" })} data-testid="games-stop">
                  {t("games.stop")}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn-primary !py-1.5 text-[12.5px]" disabled={busy} onClick={() => act({ action: "start", game: g.game })} data-testid="games-again">
                  <Icon name="refresh" size={13} /> {t("games.again")}
                </button>
                <button type="button" className="btn-ghost border border-border !py-1.5 text-[12.5px]" disabled={busy} onClick={() => act({ action: "close" })} data-testid="games-back">
                  {t("games.back")}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </StageWindow>
  );
}

function Board({ v, name }: { v: GameView; name: string }) {
  const t = useT();
  const g = v.game!;
  const last = g.last as { what?: string; word?: string; answer?: string };
  const result =
    g.status === "done" &&
    (g.result === "user" ? t("games.resultUser") : g.result === "mate" ? t("games.resultMate", { name }) : g.result === "draw" ? t("games.resultDraw") : t("games.resultQuit"));
  const banner = result && (
    <div className={`rounded-xl px-3 py-2.5 text-center ${g.result === "user" ? "bg-success/15 text-success" : "bg-content/10 text-content"}`} data-testid="games-result" data-result={g.result ?? ""}>
      <p className="flex items-center justify-center gap-1.5 text-[14px] font-semibold">
        {g.result === "user" && <Icon name="trophy" size={15} />} {result}
      </p>
      {g.answer && <p className="mt-0.5 text-[12px] opacity-90">{t("games.answerWas", { answer: g.answer })}</p>}
      {last.what === "mate_gave_up" && <p className="mt-0.5 text-[12px] opacity-90">{t("games.mateGaveUp", { name })}</p>}
    </div>
  );
  if (g.game === "wordchain") {
    const words = g.words ?? [];
    return (
      <div className="space-y-2.5">
        {words.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="games-words">
            {words.map((w, i) => (
              <span key={i} className={`rounded-full px-2.5 py-1 text-[13px] ${w.by === "user" ? "bg-accent-soft text-accent" : "bg-content/10 text-content"}`}>{w.w}</span>
            ))}
          </div>
        ) : (
          g.status === "on" && <p className="text-[12.5px] text-content-faint">{t("games.anyWord", { name })}</p>
        )}
        {g.status === "on" && g.next && g.next.length > 0 && (
          <p className="flex items-baseline gap-2" data-testid="games-next">
            <span className="text-[12px] text-content-faint">{t("games.nextLetter")}</span>
            <span className="text-[24px] font-bold text-content">{g.next.join(" · ")}</span>
          </p>
        )}
        {g.status === "on" && last.what === "user_word_bad" && last.word && <p className="text-[12px] text-warning">{t("games.bad", { word: last.word })}</p>}
        {g.status === "on" && last.what === "mate_rejected" && last.word && <p className="text-[12px] text-warning">{t("games.rejected", { name, word: last.word })}</p>}
        {banner}
      </div>
    );
  }
  if (g.game === "twenty") {
    if (g.status === "on" && !g.ready) return <p className="text-[12.5px] text-content-faint">{t("games.getsReady", { name })}</p>;
    const asked = g.asked ?? 0;
    const max = g.max ?? 20;
    return (
      <div className="space-y-2.5">
        {g.category && <p className="text-[13px] text-content">{t("games.topic", { topic: g.category })}</p>}
        <div>
          <p className="mb-1 text-[12px] tabular-nums text-content-dim" data-testid="games-asked">{t("games.asked", { n: String(asked), max: String(max) })}</p>
          <span className="block h-1.5 overflow-hidden rounded-full bg-content/10">
            <span className="block h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.round((asked / max) * 100)}%` }} />
          </span>
        </div>
        {banner}
      </div>
    );
  }
  if (g.game === "chosung") {
    return (
      <div className="space-y-2.5">
        <p className="text-[12px] tabular-nums text-content-dim">{t("games.round", { n: String(g.round ?? 1), total: String(g.rounds ?? 5) })}</p>
        {g.status === "on" &&
          (g.ready ? (
            <p className="text-center text-[34px] font-bold tracking-[0.3em] text-content" data-testid="games-initials">{g.initials}</p>
          ) : (
            <p className="text-[12.5px] text-content-faint">{t("games.getsReady", { name })}</p>
          ))}
        {g.status === "on" && g.hint && <p className="text-center text-[12.5px] text-accent">{t("games.hint", { hint: g.hint })}</p>}
        {g.status === "on" && (g.tries ?? 0) > 0 && <p className="text-center text-[11.5px] text-content-faint">{t("games.tries", { count: g.tries ?? 0 })}</p>}
        {(g.past ?? []).length > 0 && (
          <ul className="flex flex-wrap gap-1.5" data-testid="games-past">
            {(g.past ?? []).map((p, i) => (
              <li key={i} className={`rounded-full px-2.5 py-1 text-[12px] ${p.won ? "bg-success/15 text-success" : "bg-content/10 text-content-dim"}`}>
                {p.answer} · {p.won ? t("games.got") : t("games.passed")}
              </li>
            ))}
          </ul>
        )}
        {banner}
      </div>
    );
  }
  const throws = g.throws ?? [];
  const r = throws[throws.length - 1];
  return (
    <div className="space-y-2.5">
      {r && (
        <div className="flex items-center justify-center gap-4" data-testid="games-last-throw" data-win={r.win}>
          <span className="block text-[34px] leading-none">{GLYPH_OF[r.user]}</span>
          <span className="text-[12.5px] font-medium text-content-dim">
            {r.win === "user" ? t("games.roundWin") : r.win === "mate" ? t("games.roundLose", { name }) : t("games.roundDraw")}
          </span>
          <span className="block text-[34px] leading-none">{GLYPH_OF[r.mate]}</span>
        </div>
      )}
      {throws.length > 1 && (
        <p className="text-center text-[13px] tracking-wider text-content-faint">
          {throws.slice(-6, -1).map((x, i) => (
            <span key={i} className={x.win === "user" ? "text-success" : x.win === "mate" ? "text-danger" : ""}>
              {GLYPH_OF[x.user]}
              {GLYPH_OF[x.mate]}{" "}
            </span>
          ))}
        </p>
      )}
      {banner}
    </div>
  );
}
