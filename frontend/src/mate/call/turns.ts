/**
 * Whose turn it is on a call (docs/mate-calls.md "Taking turns"): when they have finished, when they only paused, when
 * they went on after she began, and when what they say while she talks is for her at all. Pure (test/call-turns.test.ts).
 *
 * The recognizer (mate/stt/realtime.ts, ElevenLabs) hears; this decides. A fixed pause of quiet is either slow (a finished
 * "오늘 날씨 어때?" waits for it) or too quick (a "그래서 어제 친구를 만났는데…" breathing in is cut into pieces, and
 * she answers the half). Here the words say how long to wait: a finished sentence is theirs to be answered almost at once,
 * one that is clearly going on (a connective, a particle, a filler) is waited for, and between the two a short while.
 *
 * And it goes faster than it waits: once the end is likely, their words go to her at once (`send`) — she starts making
 * her answer — while her voice waits for the end to be sure (`confirm`). Should they go on meanwhile (`resumed`), her
 * answer is dropped unheard and their whole sentence goes again (`send` with amend): she answers all of it, as if they
 * had never paused. The same when she had only just begun to speak.
 *
 * While she is well into talking, what they say is mostly not a turn: a backchannel ("응", "맞아", a laugh) or noise is
 * let be. Words meant to stop her ("잠깐만", "그만", her name, "응?") stop her at once (`barge`), and so does talking over
 * her for long. Anything else — words to someone beside them, a remark — only softens her voice (`duck`) and goes to her
 * as an aside (`send` with aside): she judges whether it was for her, and goes on where she was if it wasn't.
 *
 * The recognizer (Scribe v3 Live, committed by us) shows a segment's words as they come (partials) and its final words
 * when we commit; a commit closes the segment, the next one's words are new. A turn is the words of the segments it
 * closed and of the open one. Measured on the live stream (docs/mate-calls.md "Taking turns"): its partials can
 * reword or re-punctuate what they had (no more words), show a key term — her name — alone at the start of any sound
 * (no words yet), and a commit of a stretch with no words in it may echo the last one (nothing new).
 */

// ── what the words say ───────────────────────────────────────────────────────────────────────────────────────────

export type EndState = "complete" | "unsure" | "open";

/** how long a quiet stretch (ms) ends a turn: their words go to her (`send`), her voice may play (`confirm`) */
export const SEND_MS: Record<EndState, number> = { complete: 200, unsure: 400, open: 800 };
export const CONFIRM_MS: Record<EndState, number> = { complete: 250, unsure: 600, open: 1300 };
/** With the server's ear (app/mate/ear.py: their voice itself, and Smart Turn's judgement of it the moment it stops):
 *  how long after their voice stopped her voice may play — fast only when the words and the voice both say done,
 *  patient when either says more is coming (a real call cut them off at "근데 그냥 자꾸…" after 0.4 s). [voice sounds
 *  done (p ≥ 0.5), doesn't] */
export const PATIENCE_MS: Record<EndState, [number, number]> = { complete: [300, 650], unsure: [600, 1000], open: [1100, 1600] };
/** quiet this long ends any turn, however it ended */
export const CEILING_MS = 2000;
/** they go on within this long after their turn ended, before she said much: it is the same turn (merged) */
export const CONTINUE_MS = 6000;
/** "said much": her answer played this long (ms) */
export const HEARD_ENOUGH_MS = 1500;
/** they keep talking over her this long with words of their own: they mean it, whatever the words */
export const SUSTAINED_MS = 2000;
/** a long stretch this much quieter than their turns usually are: someone else (a TV, a voice across the room) */
export const BACKGROUND_RATIO = 0.25;
const BACKGROUND_MIN_MS = 1200;

const HANGUL0 = 0xac00;
/** the final consonant (jongseong index, 0 = none) of a Hangul syllable, or -1 when it isn't one */
function jong(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  return c >= HANGUL0 && c <= 0xd7a3 ? (c - HANGUL0) % 28 : -1;
}
const RIEUL = 8; // ㄹ
const BIEUP = 17; // ㅂ

/** words that end a thought in the middle (said last, they mean more is coming) */
const OPEN_WORDS = new Set(
  ("그래서 그리고 근데 그런데 그러니까 그니까 그러면 그럼서 아니면 왜냐하면 왜냐면 그러다가 그래도 그런데도 하지만 그치만 " +
    "그러나 또 또는 막 약간 좀 그 저 이 이제 뭐 뭐냐면 뭐랄까 음 어 아 엄 으음 음음 어어 그게 그거 그거를 저기 있잖아 있잖아요 " +
    "그니까요 그러니까요 일단 우선 혹시 만약 만약에 아무튼 어쨌든 솔직히 사실 진짜로 정말로 and but so because or then like um uh " +
    "the a an to of with for in on at my your i we you if when that which").split(/\s+/),
);
const STANDALONE_VERBS = new Set("가 와 해 봐 줘 자 놔 써 사 타 돼 펴 꺼 켜".split(" "));
/** adverbs and the like said last: the verb they go with is still to come ("근데 그냥 자꾸…", "나 오늘 진짜 너무…") */
const HANGING = new Set(
  ("자꾸 그냥 계속 막 너무 진짜 정말 완전 되게 엄청 아주 좀 조금 많이 다시 또 아직 이미 벌써 혹시 아마 제발 같이 다 잘 못 안 " +
    "원래 요즘 요새 거의 별로 전혀 절대 항상 맨날 매일 가끔 자주 이제 이따 나중에 먼저 빨리 천천히 한번 그렇게 이렇게 저렇게 " +
    "어떻게 왜냐하면 그러면서 그러니까는 그래가지고 해가지고 가지고 그래갖고 갖고 해서는 했는데도 때문에 땜에 처럼 대신에 말고").split(/\s+/),
);
const PRONOUNS = new Set("나 너 저 제 내 니 우리 저희 걔 쟤 얘 그녀 그분".split(" "));
/** whole answers by themselves */
const ANSWERS = new Set(
  ("응 웅 엉 어 아 어어 네 예 넵 아니 아니야 아니요 아뇨 그래 그래요 좋아 좋아요 싫어 싫어요 알았어 알겠어 알았어요 알겠어요 몰라 몰라요 " +
    "맞아 맞아요 오케이 됐어 괜찮아 괜찮아요 고마워 고마워요 감사합니다 미안 미안해 뭐 왜 진짜 정말 당연하지 물론이지 그럼 그렇지 " +
    "yes yeah yep no nope okay ok sure right thanks what why").split(/\s+/),
);
/** backchannels and fillers: them listening, not a turn — nothing to stop her for */
const BACKCHANNEL = new Set(
  ("응 웅 엉 어 음 아 오 와 우와 아하 아아 어어 응응 웅웅 네 네네 예 그래 그래그래 그치 그렇지 그렇구나 그랬구나 그렇네 그러네 " +
    "그러게 맞아 맞아맞아 진짜 진짜야 정말 헐 대박 와우 오호 흠 음음 으음 하하 허허 헤헤 히히 크크 ㅋㅋ ㅋㅋㅋ ㅎㅎ ㅎㅎㅎ 아 진짜 " +
    "오케이 엉엉 그니까 그러니까 그쵸 그죠 아이고 어머 세상에 우와아 mhm uh-huh uh huh hmm yeah yep right okay ok wow oh ah").split(/\s+/),
);
/** what a recognizer writes for a noise, or "hears" in one (a recording's Whisper, mostly) */
const NOISE = /^(?:[\s\p{P}\p{S}]*|[([{*♪].*[)\]}*♪]|.*(?:시청(?:해)? ?주셔서 감사|구독(?:과)? 좋아요|자막 ?(?:제공|by)|MBC ?뉴스|thanks? for watching|subscribe).*)$/iu;

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean);

/** a noise, a tag, a hallucination — nothing anyone said */
export const noiseOnly = (text: string) => NOISE.test(text.trim());

/** nothing but backchannels / fillers ("응", "맞아 맞아", "아 진짜", "ㅋㅋ") */
export function backchannel(text: string): boolean {
  const w = words(text);
  if (!w.length) return true;
  return w.every((x) => BACKCHANNEL.has(x) || /^[ㅋㅎ]+$/.test(x) || /^(?:하|허|헤|히|크)+$/.test(x));
}

/** someone else they talk to (said first): "엄마, 나 지금 통화 중이야" is not for her */
const OTHERS = new Set(
  ("엄마 아빠 어머니 아버지 할머니 할아버지 언니 오빠 누나 형 동생 여보 선생님 사장님 팀장님 부장님 과장님 대리님 실장님 " +
    "저기요 아저씨 아줌마 이모 삼촌 고모 아가 얘들아 mom dad honey").split(/\s+/),
);
/** said first, words that stop someone talking ("잠깐만", "그만", "여보세요"): for her, now */
const STOPPERS = new Set(
  ("잠깐 잠깐만 잠깐만요 잠시만 잠시만요 그만 그만해 그만해요 스톱 멈춰 멈춰봐 여보세요 뭐라고 뭐라고요 다시 " +
    "stop wait hello pardon").split(/\s+/),
);
const PUZZLED = new Set("응 어 네 뭐 왜 엥 에 what huh".split(/\s+/));

/** words meant for her — to stop her now: her name called, a stopper, "응?" (they didn't catch it), a correction
 *  ("아니 그게…") — unless they began by calling someone else */
export function addressed(text: string, names: string[] = []): boolean {
  const w = words(text);
  if (!w.length || OTHERS.has(w[0])) return false;
  if (names.some((n) => n && w.some((x) => x === n || (x.startsWith(n) && x.length <= n.length + 1)))) return true;
  if (STOPPERS.has(w[0]) || (w.length > 1 && STOPPERS.has(`${w[0]} ${w[1]}`))) return true;
  if (w.length <= 2 && PUZZLED.has(w[0]) && /[?？]$/.test(text.trim())) return true;
  return w[0] === "아니" && w.length >= 2;
}

/** enough words of their own to be talking to her (not a backchannel, not one stray syllable) */
export function substantive(text: string): boolean {
  const w = words(text).filter((x) => !BACKCHANNEL.has(x) && !/^[ㅋㅎ]+$/.test(x));
  const letters = w.join("").length;
  return w.length >= 2 ? letters >= 4 : letters >= 5;
}

/** does it sound finished? — the last word's ending (Korean), the punctuation the recognizer put (a weak sign) */
export function endState(text: string): EndState {
  const t = text.trim();
  if (!t) return "open";
  // a word cut off as it was said ("재미-"), a trailing "…": more is coming
  if (/(?:-|…|\.\.\.)$/.test(t)) return "open";
  const w = words(t);
  if (!w.length) return "unsure";
  const last = w[w.length - 1];
  if (w.length === 1 && ANSWERS.has(last)) return /[?!]$/.test(t) || last.length > 1 ? "complete" : "unsure";
  if (OPEN_WORDS.has(last)) return "open";
  if (/[?!]$/.test(t)) return "complete";
  if (/^[a-z']+$/.test(last)) return "unsure"; // (English: the words alone don't say)
  // (a one-syllable verb said last — "이사 가", "빨리 와" — is a sentence's end; a pronoun — "응, 나…" — begins one)
  if (w.length > 1 && STANDALONE_VERBS.has(last)) return "complete";
  if (PRONOUNS.has(last)) return "open";
  if (w.length > 1 && HANGING.has(last)) return "open";
  // (an adverb and a pronoun run together by the recognizer — "자꾸나" for "자꾸 나…")
  if (w.length > 1 && /^(?:자꾸|그냥|계속|진짜|너무)(?:나|너|내|네|우리)$/.test(last)) return "open";
  const end = last.slice(-2);
  const tail = last.slice(-1);
  const before = last.length > 1 ? last[last.length - 2] : "";
  // connective endings: 고 서 는데 지만 면 니까 려고 러 도록 거나 든지 다가 자마자 면서 며 길래 어도 는지 다고(quoting)…
  if (/(?:는데|은데|던데|ㄴ데|지만|니까|려고|도록|거나|든지|든가|다가|자마자|면서|으며|길래|는지|은지|던지)$/.test(last)) {
    // (formal questions are finished: 입니까, 합니까 — ㅂ before 니까)
    if (end === "니까" && last.length > 2 && jong(last[last.length - 3]) === BIEUP) return "complete";
    return "open";
  }
  if (/(?:다고|라고|냐고|자고)$/.test(last)) return "unsure"; // ("그랬다고!" ends a sentence as often as it quotes)
  if (tail === "고" || tail === "서" || tail === "며" || tail === "면" || tail === "러") return "open";
  if (/(?:아도|어도|해도)$/.test(last)) return "open";
  // particles: a noun with its particle and nothing after ("내가", "친구를", "집에서") — the verb is still to come
  if (last.length > 1 && /(?:을|를|은|는|이|가|에|에서|으로|로|와|과|랑|이랑|하고|의|도|만|까지|부터|한테|에게|께|보다|처럼|마다|밖에|조차)$/.test(last)) {
    // (but verbs and adjectives end in these too: "좋아" ← 아 not here; "싫어", "가" — the one-syllable ones are ambiguous)
    if (/(?:에서|으로|이랑|하고|까지|부터|한테|에게|보다|처럼|마다|밖에|조차)$/.test(last)) return "open";
    if (/(?:을|를|의|와|과|랑)$/.test(last)) return "open";
    return "unsure";
  }
  // a promise / will (ㄹ게: 갈게, 할게, 볼게), a sentence ending: finished
  if (tail === "게") return jong(before) === RIEUL ? "complete" : "unsure";
  if (/(?:요|다|죠|지|까|니|냐|나|래|대|자|네|군|구나|더라|잖아|거든|걸|야|어|아|해|여|와|줘|봐|라|지요|세요|네요|군요)$/.test(last)) return "complete";
  return "unsure";
}

// ── who is talking ──────────────────────────────────────────────────────────────────────────────────────────────

export interface TurnEvents {
  /** their turn as it stands: to her now (`amend`: the whole of a turn sent before — they went on — her answer to
   *  that one dropped; `aside`: said over her voice, maybe not to her — she judges, and goes on if it wasn't);
   *  `endAt`: when they stopped talking */
  send: (text: string, endAt: number, amend: boolean, aside: boolean) => void;
  /** the end is sure: her voice may play (her answer to what was sent) */
  confirm: () => void;
  /** they went on before her answer was heard much: it waits (unheard) or stops — the next `send` amends */
  resumed: () => void;
  /** words meant to stop her (or a long stretch over her): she stops — what they say is their next turn */
  barge: () => void;
  /** words of theirs over her (not a backchannel): her voice softens until it is clear what they were */
  duck?: () => void;
  /** their voice again after the end seemed sure, before her voice began: it waits once more (a `confirm` follows —
   *  or, words coming, `resumed`) */
  hold?: () => void;
  /** close the recognizer's segment now: its final words (`committed`) */
  commit: () => void;
  /** (diagnostics) a backchannel / noise / echo heard and let be */
  ignored?: (text: string, why: string) => void;
}

export interface TurnContext {
  /** her voice playing now */
  herVoice: () => boolean;
  /** how long her current answer has played (ms; 0: not yet) */
  heardMs: () => number;
}

type Phase = "idle" | "speaking" | "sent" | "confirmed";

/**
 * One call's turn-taking, fed by the recognizer: `partial` (the open segment's words — her echo already left out),
 * `level` (the microphone), `committed` (a segment's final words), `tick` (the clock, every ~50 ms).
 */
export class TurnTaker {
  private phase: Phase = "idle";
  private base = ""; // this turn's words in segments the recognizer closed
  private seg = ""; // the open segment's words (its latest partial)
  private segWords = false; // the open segment showed words of this turn
  private commits: ("turn" | "drop" | "settle")[] = []; // commits asked for, their words not back yet
  private settling = 0; // (the ear) their voice stopped: the recognizer's final words asked for — the turn waits for them
  private sentText = ""; // what went to her for this turn
  private amending = false; // the next send amends the last one
  private lastWordsAt = 0; // their words last grew
  private lastLoudAt = 0; // the microphone last heard someone (their breath between words, a word not shown yet)
  private endAt = 0;
  private startedAt = 0; // their talking began (this stretch)
  private overHer = false; // the stretch began while her voice played
  private barged = false;
  private ducked = false;
  private floor = 0.02; // the microphone's noise level
  private levels = 0; // levels heard (none: nothing to tell a sound by)
  private voicedRun = 0; // levels in a row that were a voice
  private voicedAt = -Infinity; // the last level that was a voice
  private runFrom = -Infinity; // when their voice began again after a gap (it holds the turn as words would, a moment)
  private sentLoud = 0; // how loud the turn sent was
  private lastSeg = ""; // the last segment the recognizer closed (normalized) — a new one may begin by echoing it
  private lastSegAt = -Infinity;
  private bargeAt = 0; // words meant to stop her heard: she stops if they still say so then
  private heldOnce = false; // her voice waited once more for this turn
  private lastAside = false; // the turn sent was an aside
  private fresh = false; // this stretch began right after their last turn (as a backchannel-like sound: it may yet be more of it)
  // the server's ear (app/mate/ear.py), when it is on: their voice itself (page ms), and Smart Turn at its end
  private ear = false;
  private earOn = false;
  private earFrom = -Infinity;
  private earTo = -Infinity;
  private earP: number | null = null;
  private soundAt = -Infinity; // the microphone last heard a sound above its noise
  private blindAt = -Infinity; // the microphone's level last couldn't tell (her voice in it)
  private phantom = ""; // words heard with no sound behind them, let be
  private turns = 0;
  private loud: number[] = []; // this stretch's voiced levels
  private recent: { at: number; v: number }[] = []; // voiced levels lately (a stretch began before its first words showed)
  private usual: number[] = []; // how loud their turns were (the last few)
  /** the stream's own pause before it commits (Scribe v2 with its VAD: 700 ms; a stream we commit ourselves: 0) — a
   *  commit we didn't ask for comes after that much quiet already */
  commitSilenceMs = 0;
  /** the recognizer's key terms (names): one alone is no words yet — Scribe v3 shows one at the start of a sound */
  keyterms: string[] = [];
  /** her names: called, they stop her */
  herNames: string[] = [];

  private ev: TurnEvents;
  private ctx: TurnContext;

  constructor(ev: TurnEvents, ctx: TurnContext) {
    this.ev = ev;
    this.ctx = ctx;
  }

  get state(): Phase {
    return this.phase;
  }

  /** the text of the turn so far (what would be sent) */
  text(): string {
    return join(this.base, this.seg);
  }

  /** the microphone's level (0..1; below 0: it can't tell — her voice is in it, a moment after she stops) */
  level(v: number, now: number): void {
    // (her voice is in the microphone while she speaks: its level says nothing of theirs then)
    if (v < 0 || this.ctx.herVoice()) {
      this.blindAt = now;
      return;
    }
    this.levels++;
    if (v < this.floor * 1.5) this.floor = this.floor * 0.97 + v * 0.03;
    else this.floor = this.floor * 0.999 + v * 0.001;
    if (v > Math.max(0.015, this.floor * 1.5)) this.soundAt = now;
    const voiced = v > Math.max(0.035, this.floor * 2.4);
    this.voicedRun = voiced ? this.voicedRun + 1 : 0;
    if (voiced) {
      if (now - this.voicedAt > 250) this.runFrom = now;
      this.voicedAt = now;
    }
    // (they make a sound again — the breath before going on — after the end seemed sure and before her voice began)
    // (with the ear, it says so — the level is any sound)
    if (!this.ear && this.voicedRun >= 2 && this.phase === "confirmed" && !this.heldOnce && this.ev.hold && this.ctx.heardMs() === 0 &&
        !this.ctx.herVoice() && now - this.endAt < CONTINUE_MS) {
      this.heldOnce = true; // (once a turn: a noisy room can't keep her quiet)
      this.phase = "sent";
      this.lastLoudAt = now;
      this.lastWordsAt = Math.max(this.lastWordsAt, now - LOUD_GRACE_MS);
      this.ev.hold();
    }
    if (voiced) {
      this.recent.push({ at: now, v });
      while (this.recent.length && this.recent[0].at < now - 3000) this.recent.shift();
    }
    if (voiced && (this.phase === "speaking" || this.phase === "sent")) {
      this.lastLoudAt = now;
      if (this.phase === "speaking" && !this.overHer && this.loud.length < 600) this.loud.push(v);
    }
  }

  /** The server's ear: their voice began (`on`) or ended at `at` (page ms) — `p`: Smart Turn's P(the turn is over)
   *  at that end. Once it is heard from, it — not the microphone's level — says when they talk. */
  heard(on: boolean, at: number, p: number | undefined, now: number): void {
    this.ear = true;
    if (on) {
      this.earOn = true;
      this.earFrom = at;
      // (their voice again after the end seemed sure, before hers began: her answer waits once more)
      if (this.phase === "confirmed" && !this.heldOnce && this.ev.hold && this.ctx.heardMs() === 0 && this.earLive(now) &&
          at > this.endAt && now - this.endAt < CONTINUE_MS) {
        this.heldOnce = true;
        this.phase = "sent";
        this.ev.hold();
      }
      if (this.phase === "speaking" || this.phase === "sent") this.lastLoudAt = Math.max(this.lastLoudAt, now);
    } else {
      this.earOn = false;
      this.earTo = at;
      this.earP = typeof p === "number" ? p : null;
      // (their voice stopped: what the recognizer shows may still be a word cut in half — "근데 그냥 자" for "자꾸" — and
      // look finished; its final words decide)
      if (this.phase === "speaking" && this.segWords && !this.commits.length && this.earLive(now)) {
        this.commits.push("settle");
        this.settling = now;
        this.ev.commit();
      }
    }
  }

  /** the ear is gone (the line dropped): the microphone's level again */
  earGone(): void {
    this.ear = false;
    this.earOn = false;
  }

  /** the ear says when they talk — not while her voice is in the microphone (it may hear her), nor a moment after;
   *  nor a voice it says goes on and on with no words (a noise it took for one — or its "ended" lost) */
  private earLive(now: number): boolean {
    if (!this.ear || this.ctx.herVoice() || now - this.blindAt <= EAR_BLIND_MS) return false;
    return !(this.earOn && now - Math.max(this.earFrom, this.lastWordsAt) > EAR_STUCK_MS);
  }

  /** when they last talked: their voice by the ear (the words lag it: they only count for a moment after it) — or
   *  without one, their words or, a little longer, the microphone (never for long: steady noise must not hold a turn
   *  open) */
  private lastVoice(now = Date.now()): number {
    if (this.earLive(now)) {
      if (this.earOn) return now;
      return Math.max(this.earTo, this.lastWordsAt - WORDS_LAG_MS);
    }
    // (their voice beginning again after a gap — words not shown yet — holds it from there; a steady noise, no gap,
    // only from their last words)
    const from = Math.max(this.lastWordsAt, this.runFrom);
    return Math.max(this.lastWordsAt, Math.min(this.lastLoudAt, from + LOUD_GRACE_MS));
  }

  /** someone made a sound lately (`at`): a recognizer's words with nothing behind them — the stream just opened, a hum
   *  it read her name into — are nobody's */
  private audible(at: number): boolean {
    if (!this.levels || this.ctx.herVoice()) return true;
    return at - this.soundAt < AUDIBLE_MS || at - this.blindAt < AUDIBLE_MS;
  }

  /** a new turn's first words with no sound behind them — or, right after a turn, none after it ended (the
   *  recognizer "hearing" an "음." in the quiet after their last word): let be */
  private unvoiced(t: string, at: number): boolean {
    if (this.phase !== "idle" && this.phase !== "confirmed") return false;
    if (this.earLive(at)) {
      // (by the ear: their voice now or lately — and, right after a turn, begun again since it ended)
      const voiced = this.earOn || at - this.earTo < AUDIBLE_MS;
      const again = this.phase !== "confirmed" || this.commits.length > 0 || this.earFrom > this.endAt;
      if (voiced && again) return false;
      if (t !== this.phantom) this.ev.ignored?.(t, "unvoiced");
      this.phantom = t;
      return true;
    }
    const after =
      this.phase !== "confirmed" || this.commits.length > 0 || !this.levels || this.ctx.herVoice() ||
      this.blindAt > this.endAt || this.soundAt > this.endAt + SOUND_AFTER_MS;
    if (this.audible(at) && after) return false;
    if (t !== this.phantom) this.ev.ignored?.(t, "unvoiced");
    this.phantom = t;
    return true;
  }

  /** a key term alone (her name, theirs): Scribe v3 shows one at the start of a sound, before any words */
  private nameOnly(t: string): boolean {
    const n = norm(t);
    return !!n && this.keyterms.some((k) => norm(k) === n);
  }

  partial(text: string, now: number): void {
    const t = text.trim();
    if (!t || noiseOnly(t) || this.nameOnly(t)) return;
    const n = norm(t);
    // (the same words reworded, re-punctuated: nobody said more)
    if (n === norm(this.seg)) {
      this.seg = t;
      return;
    }
    if (this.unvoiced(t, now)) return;
    // (a new segment beginning with the start of the one just closed — "밥" after "밥 먹었어?", "여보세요?" again: the
    // recognizer's echo of it, until its words go elsewhere)
    if (this.newSegment() && now - this.lastSegAt < ECHO_SEG_MS && this.lastSeg.startsWith(n)) {
      if (t !== this.phantom) this.ev.ignored?.(t, "echo");
      this.phantom = t;
      return;
    }
    const was = norm(this.seg);
    // (its words dropped from the end for a moment — "…병원 가야 돼." → "…병원": what it had stands)
    if (was.length > n.length && was.startsWith(n) && this.segWords) return;
    const grew = n.length > was.length;
    this.seg = t;
    this.segWords = true;
    this.lastWordsAt = now;
    if (!grew) {
      // (the recognizer rewording what it had — "음." → "응?": still hearing them)
      this.considerBarge(now);
      return;
    }
    const her = this.ctx.herVoice();
    switch (this.phase) {
      case "idle":
        this.begin(now, her);
        break;
      case "sent":
        // they went on before the end was sure: her answer (not heard yet) waits, the whole goes again
        if (this.more()) this.resume(now);
        break;
      case "confirmed":
        // (more of the segment that was sent — its commit not back —, or soon after and she had barely begun: the
        // same turn — her answer goes, theirs is answered whole)
        if (this.more() && (this.commits.length > 0 || this.amendable(now, t))) this.resume(now);
        else {
          this.begin(now, her);
          this.fresh = !!this.sentText && now - this.endAt < CONTINUE_MS;
        }
        break;
      case "speaking":
        // (a stretch begun just after their turn with a sound like "아" — then words: more of that turn after all)
        if (this.fresh && !this.amending && this.sentText && !backchannel(t) && this.amendable(now, t)) {
          this.fresh = false;
          this.base = this.sentText;
          this.resume(now);
        }
        break;
    }
    this.considerBarge(now);
  }

  /** the words now heard are a new segment's first (none shown yet in it, no commit of the last still out) */
  private newSegment(): boolean {
    return !this.segWords && !this.commits.length;
  }

  /** the turn has words beyond what went to her */
  private more(): boolean {
    return norm(this.text()).length > norm(this.sentText).length;
  }

  private begin(now: number, her: boolean): void {
    this.fresh = false;
    this.phase = "speaking";
    // (a segment still holding the last turn's words — its commit not asked for: a backchannel let be — is this
    // turn's start: the recognizer shows it whole)
    this.base = "";
    this.amending = false;
    this.startedAt = now;
    this.overHer = her;
    this.barged = false;
    this.bargeAt = 0;
    this.ducked = false;
    // (their voice began before its first words showed — the recognizer is ~0.3–0.6 s behind)
    this.loud = her ? [] : this.recent.filter((x) => x.at >= now - 1500).map((x) => x.v);
  }

  private resume(now: number): void {
    // (their own voice, far louder than the turn sent — that one was a voice behind them, a TV: theirs takes its place)
    const loud = this.recent.filter((x) => x.at >= now - 1500).map((x) => x.v);
    if (this.sentLoud && loud.length >= 4 && p90(loud) * BACKGROUND_RATIO > this.sentLoud && !this.lastAside) {
      this.ev.ignored?.(this.sentText, "background");
      this.base = "";
      if (this.commits.length) this.commits = this.commits.map(() => "drop");
      this.usual = [p90(loud)];
    }
    this.phase = "speaking";
    this.amending = true;
    this.startedAt = now;
    // (more of an aside: still over her voice, which goes on; else she stopped for it)
    this.overHer = this.lastAside && this.ctx.herVoice();
    this.barged = false;
    this.ev.resumed();
  }

  /** what they say while she talks: words meant to stop her (or a long stretch of their own) stop her; other words of
   *  theirs soften her voice */
  private considerBarge(now: number): void {
    if (this.phase !== "speaking" || this.barged || !this.overHer || !this.ctx.herVoice()) return;
    const t = this.text();
    if (now - this.startedAt >= SUSTAINED_MS && substantive(t)) {
      this.stopHer();
      return;
    }
    // (words meant to stop her: she stops if they still say so a moment later — a stream's first guess at a sound is
    // sometimes a word it then takes back)
    if (addressed(t, this.herNames)) {
      if (!this.bargeAt) this.bargeAt = now + BARGE_SURE_MS;
      else if (now >= this.bargeAt) {
        this.stopHer();
        return;
      }
    } else this.bargeAt = 0;
    if (!this.ducked && !backchannel(t)) {
      this.ducked = true;
      this.ev.duck?.();
    }
  }

  private stopHer(): void {
    this.barged = true;
    this.bargeAt = 0;
    this.ev.barge();
  }

  committed(text: string, now?: number): void {
    const at = now ?? Date.now();
    const t = noiseOnly(text) || this.nameOnly(text) ? "" : text.trim();
    const asked = this.commits.shift();
    if (asked) {
      if (asked === "settle") this.settling = 0;
      // (a segment that showed no words of this turn: the recognizer's echo of the last one, nothing new)
      const words = asked !== "drop" && this.segWords ? t || this.seg : "";
      this.base = join(this.base, words);
      if (words) {
        this.lastSeg = norm(words);
        this.lastSegAt = at;
      }
      this.seg = "";
      this.segWords = false;
      // more words than were sent that no partial showed: they went on
      if (words && (this.phase === "sent" || this.phase === "confirmed") && this.more()) {
        if (this.phase === "sent" || this.amendable(at, words)) {
          this.lastWordsAt = Math.max(this.lastWordsAt, at - 300);
          this.resume(at);
        }
      }
      return;
    }
    // a segment the recognizer closed by itself (its own pause — with a stream that has one, often the only word
    // of it —, its time limit): part of this turn, after the quiet it waited for
    if (!t || this.unvoiced(t, at - this.commitSilenceMs)) return;
    // (its words take the place of the partial that showed them, if one came)
    this.seg = "";
    this.segWords = false;
    if (this.phase === "idle") this.begin(at, this.ctx.herVoice());
    else if (this.phase === "confirmed") {
      if (this.amendable(at, t)) this.resume(at);
      else this.begin(at, this.ctx.herVoice());
    } else if (this.phase === "sent") this.resume(at);
    this.base = join(this.base, t);
    const quietFrom = at - this.commitSilenceMs;
    if (quietFrom > this.lastWordsAt) this.lastWordsAt = quietFrom;
    this.considerBarge(at);
    this.tick(at);
  }

  /** they go on soon after their turn, before she said much (or after an aside: her voice playing is what they spoke
   *  over, not her answer): the same turn */
  private amendable(now: number, t: string): boolean {
    if (!this.sentText || !this.turns || now - this.endAt >= CONTINUE_MS || backchannel(t)) return false;
    return this.lastAside || this.ctx.heardMs() < HEARD_ENOUGH_MS;
  }

  /** a long stretch far quieter than their turns: someone else's voice (a TV, across the room) */
  private background(): boolean {
    if (!this.usual.length || this.lastVoice() - this.startedAt < BACKGROUND_MIN_MS || this.loud.length < 6) return false;
    return p90(this.loud) < BACKGROUND_RATIO * median(this.usual);
  }

  /** how long after their voice her answer is made (send) and may be heard (confirm): by the ear's judgement and
   *  the words — or, without the ear, by the words alone */
  private waits(st: EndState, now: number): [number, number] {
    if (this.earLive(now) && !this.earOn && this.earP !== null) {
      const t = PATIENCE_MS[st][this.earP >= 0.5 ? 0 : 1];
      return [Math.max(200, Math.round(t * 0.6)), t];
    }
    return [SEND_MS[st], CONFIRM_MS[st]];
  }

  tick(now: number): void {
    if (this.phase !== "speaking" && this.phase !== "sent") return;
    const quiet = now - this.lastVoice(now);
    if (this.phase === "speaking") {
      const text = this.text();
      if (!text) {
        if (quiet > CEILING_MS) this.reset();
        return;
      }
      if (this.bargeAt && now >= this.bargeAt) this.considerBarge(now);
      // (their final words asked for as their voice stopped: decided on those — unless they are slow to come)
      if (this.settling && now - this.settling < SETTLE_MAX_MS) return;
      this.settling = 0;
      const st = endState(text);
      const [sendMs, confirmMs] = this.waits(st, now);
      // (her voice in the microphone lately: it couldn't hear whether they were still talking — a little longer then)
      const blind = now - this.blindAt < sendMs + BLIND_EXTRA_MS ? BLIND_EXTRA_MS : 0;
      if (quiet < sendMs + blind && quiet < CEILING_MS) return;
      const her = this.ctx.herVoice();
      // while she is still talking: a backchannel, a laugh — them listening, not a turn (once she has stopped, the same
      // "응" is an answer)
      if (this.overHer && !this.barged && her && !substantive(text) && !addressed(text, this.herNames)) {
        this.ev.ignored?.(text, "backchannel");
        this.reset();
        return;
      }
      if (!this.overHer && !this.amending && this.background()) {
        this.ev.ignored?.(text, "background");
        this.drop();
        return;
      }
      const aside = this.overHer && !this.barged && her;
      this.lastAside = aside;
      this.endAt = this.lastVoice(now);
      this.sentText = text;
      this.phase = "sent";
      this.turns++;
      this.heldOnce = false;
      // (a commit already asked for this segment: it will have these words too)
      if (this.segWords && !this.commits.length) {
        this.commits.push("turn");
        this.ev.commit();
      }
      this.sentLoud = this.loud.length >= 3 ? p90(this.loud) : 0;
      if (!this.overHer && this.loud.length >= 3) this.usual = [...this.usual, p90(this.loud)].slice(-6);
      this.ev.send(text, this.endAt, this.amending, aside);
      this.amending = false;
      if (quiet >= confirmMs || quiet >= CEILING_MS) this.confirmNow();
      return;
    }
    // sent: her voice waits for the end to be sure
    if (this.earLive(now) && this.earOn) return;
    if (quiet >= this.waits(endState(this.sentText), now)[1] || quiet >= CEILING_MS) this.confirmNow();
  }

  private confirmNow(): void {
    this.phase = "confirmed";
    this.ev.confirm();
  }

  /** a stretch let be: what the turn was before it stays (a later one may still amend it) */
  private reset(): void {
    this.phase = this.sentText && this.turns ? "confirmed" : "idle";
    this.base = "";
    this.amending = false;
    this.barged = false;
    this.ducked = false;
  }

  /** a stretch that was nobody's (a voice behind them): its segment closed and its words dropped */
  private drop(): void {
    if (this.segWords) {
      this.commits.push("drop");
      this.ev.commit();
    }
    this.seg = "";
    this.segWords = false;
    this.reset();
  }
}

/** the microphone can hold a turn open this much past their last words (a breath, a word still being recognized) */
const LOUD_GRACE_MS = 800;
/** a turn's first words must have a sound this recent behind them (the recognizer shows a word ~0.3–0.6 s after it) */
const AUDIBLE_MS = 2500;
/** …and, right after a turn, some sound this long after it ended (not only the tail of its last word) */
const SOUND_AFTER_MS = 250;
/** the ear isn't trusted while her voice plays and this long after (her voice may still be in the microphone) */
const EAR_BLIND_MS = 400;
/** their words show this long after they said them: with the ear, words this much later than their voice don't hold it */
const WORDS_LAG_MS = 700;
/** a voice the ear says goes on this long with no words: not trusted */
const EAR_STUCK_MS = 8000;
/** their final words, asked for as their voice stopped, are waited for this long at most */
const SETTLE_MAX_MS = 700;
/** a new segment may echo the one just closed for this long (Scribe v3: its last words, as the next sound begins) */
const ECHO_SEG_MS = 6000;
/** words meant to stop her: still so this much later, she stops */
const BARGE_SURE_MS = 150;
/** her voice blinding the microphone's level: a turn waits this much more for its end */
const BLIND_EXTRA_MS = 350;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const p90 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
};

function join(a: string, b: string): string {
  let x = a.trim();
  const y = b.trim();
  // (a word cut at one segment's end — "내-" — and said whole at the next one's start — "내일")
  const cut = x.match(/(\S+)-$/);
  if (cut && y.startsWith(cut[1])) x = x.slice(0, -cut[0].length).trim();
  if (!x) return y;
  if (!y) return x;
  return `${x} ${y}`;
}
