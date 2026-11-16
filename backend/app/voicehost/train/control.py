"""The server's say over a running training (stdin lines), checked between steps:

- pause / resume: her voice is wanted now (a mate speaking): it keeps what is on the GPU and only stops computing;
- release: the GPU memory is wanted (a call, an image job): it saves where it is and leaves; started again later,
  it goes on from there;
- stop: the run is called off."""

from __future__ import annotations

import sys
import threading
import time
from typing import Callable


class Stopped(Exception):
    pass


class Released(Stopped):
    """leave the GPU now, to go on later from here"""


class Control:
    def __init__(self, stream=None) -> None:
        self.paused = False
        self.stopped = False
        self.released = False
        self._t = threading.Thread(target=self._read, args=(stream or sys.stdin,), daemon=True)
        self._t.start()

    def _read(self, stream) -> None:
        for line in stream:
            word = line.strip().lower()
            if word == "pause":
                self.paused = True
            elif word == "resume":
                self.paused = False
            elif word == "stop":
                self.stopped = True
            elif word == "release":
                self.released = True
        self.stopped = True  # (the server went away: stdin closed)

    def check(self, on_pause: Callable[[bool], None] | None = None) -> None:
        """between two steps: wait while paused, raise Stopped when told to stop"""
        if self.released:
            raise Released()
        if self.stopped:
            raise Stopped()
        if not self.paused:
            return
        if on_pause:
            on_pause(True)
        while self.paused and not self.stopped and not self.released:
            time.sleep(0.1)
        if self.released:
            raise Released()
        if self.stopped:
            raise Stopped()
        if on_pause:
            on_pause(False)
