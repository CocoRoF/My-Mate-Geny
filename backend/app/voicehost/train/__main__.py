"""python -s -m app.voicehost.train <run dir> [--fake]: one training run (its job.json), events on stdout."""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

from . import PREFIX
from .control import Control, Released, Stopped


def main(argv: list[str]) -> int:
    run_dir = Path(argv[1])
    fake = "--fake" in argv
    job = json.loads((run_dir / "job.json").read_text())

    def emit(**kw) -> None:
        sys.stdout.write(PREFIX + json.dumps(kw, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    ctl = Control()
    try:
        if fake:
            from .fake import run
        else:
            from .run import run
        run(job, emit, ctl)
        return 0
    except Released:
        emit(stage="released")
        return 0
    except Stopped:
        emit(stage="canceled")
        return 0
    except Exception as e:  # noqa: BLE001 - one line back to the server, the trace to the log
        code = getattr(e, "code", "failed")
        data = getattr(e, "data", {}) or {}
        if type(e).__name__ == "OutOfMemoryError":
            code = "oom"
        emit(stage="failed", error=str(e)[:500], code=code, **data)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
