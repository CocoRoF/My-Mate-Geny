"""The sentences a training run is measured with: new to the model and to her recordings, everyday speech, no digits
(Whisper writes numbers its own way). One set per language; others use English."""

EVAL = {
    "ko": (
        "오늘은 하늘이 정말 맑아서 산책하기 좋은 날이에요.",
        "어제 친구랑 오랜만에 만나서 맛있는 저녁을 먹었어.",
        "그 얘기를 들으니까 나도 모르게 웃음이 나더라.",
        "혹시 내일 시간 괜찮으면 같이 영화 보러 갈래?",
        "요즘 날씨가 갑자기 추워져서 감기 조심해야 해.",
        "천천히 해도 괜찮으니까 너무 걱정하지 마.",
    ),
    "en": (
        "The weather is so nice today that I want to take a long walk.",
        "I met an old friend yesterday and we talked for hours.",
        "Could you tell me what you think about this idea?",
        "Don't worry, we still have plenty of time to finish it.",
        "That story made me laugh more than I expected.",
        "Let's grab a coffee together sometime next week.",
    ),
    "ja": (
        "今日は天気がとても良くて、散歩したくなります。",
        "昨日、久しぶりに友達と会って話しました。",
        "その話を聞いて、思わず笑ってしまいました。",
        "もし明日時間があれば、一緒に映画を見に行きませんか。",
        "急に寒くなったので、風邪に気をつけてください。",
        "ゆっくりで大丈夫だから、心配しないでね。",
    ),
    "zh": (
        "今天天气特别好，很适合出去散步。",
        "昨天我和老朋友见面，聊了很久。",
        "听了那个故事，我忍不住笑了出来。",
        "如果明天有空，我们一起去看电影吧。",
        "最近天气突然变冷了，要小心感冒。",
        "慢慢来没关系，你不用太担心。",
    ),
}

# Whisper's names for the languages it is told to hear
WHISPER = {"ko": "korean", "en": "english", "zh": "chinese", "ja": "japanese", "de": "german", "es": "spanish",
           "fr": "french", "it": "italian", "ru": "russian", "pt": "portuguese", "vi": "vietnamese", "th": "thai",
           "id": "indonesian"}


def eval_texts(lang: str) -> tuple[str, ...]:
    return EVAL.get(lang, EVAL["en"])


def norm(t: str) -> str:
    """for the character error rate: letters and digits only, lower case"""
    return "".join(ch for ch in t.lower() if ch.isalnum())


def cer(ref: str, hyp: str) -> float:
    r, h = norm(ref), norm(hyp)
    if not r:
        return 0.0
    prev = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        cur = [i] + [0] * len(h)
        for j, hc in enumerate(h, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rc != hc))
        prev = cur
    return min(1.0, prev[-1] / len(r))
