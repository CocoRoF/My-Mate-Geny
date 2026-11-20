# Working in this repository (agents)

## Tests: run what your change can break, once — CI runs the rest

Several agents work here at once, on one shared machine, and every PR runs CI. A test run that CI repeats anyway,
or one that checks code you didn't touch, only costs time.

**Locally, before a PR — only what the change can break:**

- **Backend:**

  ```
  cd backend && python -m pytest -q -p no:cacheprovider $(python tools/affected_tests.py)
  ```

  `tools/affected_tests.py` picks:
  - the changed tests;
  - the tests that import a changed module (directly, or through one module that does);
  - the tests named after a changed module.

  It prints `tests` (everything) only when the base itself changed: `conftest.py`, `pyproject.toml`, `app/db.py`,
  `app/config.py`, `app/main.py`. It prints nothing when the backend didn't change. `--why` shows why each test was
  picked.
- **Frontend:**

  ```
  cd frontend && node scripts/affected-tests.mjs
  ```

  It prints the commands to run, and only those that apply:
  - `tsc` when TypeScript changed;
  - the unit tests that import what changed;
  - `test:i18n` when messages or components changed.
- **Not locally:**
  - the whole backend suite. CI runs it on every PR that touches `backend/`, in three parallel parts;
  - the whole frontend unit suite, unless the selector asks for it;
  - a second run of something that already passed on the same code. A rebase onto main doesn't call for one, unless
    its conflicts touched code.
- **End-to-end runs** (Playwright, a throwaway server, real models) are only for a user flow that no unit test can
  show. Run one scenario, once. Don't run one for a backend-only or docs-only change.
- **Docs-only changes:** no tests. CI skips them too.

## CI and releases (docs/apps.md → "CI", "Releases")

- **CI runs the full suites.** A PR runs each part whose files it changed. Don't repeat that work locally, and don't
  re-run a workflow "to be sure".
- **Apps:** never dispatch an apps build by hand for a change. Pushing to main builds what changed (docs/apps.md).
- **Failures:** when a CI job fails on something your change doesn't touch (a known flaky test), re-run that one failed
  job (`gh run rerun <id> --failed`), not the whole workflow.

## The shared machine

- **Heavy work:** run builds, test suites, bundlers, model runs and big data jobs one at a time, never several side by
  side. Machines where `capped` exists: run them under it.
- **Stopping a process:** use its PID (`ss -ltnp`, `pgrep -f` and check what it found). Never use a broad `pkill -f`:
  its pattern also matches the shell that runs it.
