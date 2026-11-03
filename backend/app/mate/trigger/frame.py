"""Frame comparison and TTL helpers copied from Project Geny screen_observation.py."""
import os
from typing import Optional

def _hamming(a: str, b: str) -> Optional[int]:
    """Bit-difference between two hex-encoded perceptual hashes, or ``None``
    when either side isn't valid hex (→ caller treats as 'changed')."""
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except (ValueError, TypeError):
        return None

def _same_screen_threshold() -> int:
    """dHash Hamming distance BELOW which the screen counts as "the same
    situation" for proactive-comment de-dup. Deliberately LENIENT (default
    10/64, vs the change-gate's ~4) so the captured avatar overlay's idle
    animation (a few flipped bits in its corner) never reads as a new
    situation — only a substantial screen change earns a fresh comment."""
    try:
        return int(os.environ.get("GENY_SCREEN_OBS_SAME_THRESHOLD", "10"))
    except ValueError:
        return 10

def _screen_active_window() -> float:
    """How long after the last upload a session counts as 'observing'. A bit
    over 2× the 3-min capture interval so a missed tick doesn't flap it off."""
    try:
        return float(os.environ.get("GENY_SCREEN_OBS_ACTIVE_WINDOW_S", "400"))
    except ValueError:
        return 400.0
