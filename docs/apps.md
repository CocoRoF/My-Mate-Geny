# The apps: builds, releases, the Download page

My Mate Geny ships as a desktop app (Windows, macOS on Apple Silicon and Intel, Linux — Electron, `desktop/`) and as a
phone app (Android and iOS · iPadOS — Capacitor, `mobile/`). The phone apps and the desktop's server mode load the
console live from the user's own server; the desktop's local execution bundles the backend and the UI.

## Releases

`.github/workflows/apps.yml` builds them — **for a release only, never for a push** (since 2026-11-20; until then every
push to main built both Macs, Windows, Linux and whatever else changed — about 300 macOS runner minutes a day, and the
owner: "사용량이 과해"). A release is one of:

- **by hand** — *ship the apps now*: Actions → apps → Run workflow (branch `main`), or
  `gh workflow run apps -R CocoRoF/My-Mate-Geny` (`-f platforms=…` / `-f channel=test` as below); `gh run watch` follows it;
- **nightly**, 18:17 UTC (03:17 KST): the day's changes, at most one release a day. A night with nothing new for any app
  builds nothing (only the plan job, seconds on Linux). Switched off — without a change to the workflow — by the
  repository variable `APPS_NIGHTLY=off` (Settings → Secrets and variables → Actions → Variables); on again by deleting it.

Either way the release builds only what changed (below). Pushing to main builds no app: a change reaches the apps with
the next release (that night, or the moment someone runs it). The jobs:

| job | what | publishes |
|---|---|---|
| plan | which platforms this release needs (below) | — |
| version | this run's version `<line>.<n>` and its draft release `apps-v<version>` | — |
| ui | the local-execution UI, built once for every desktop platform | an artifact |
| verify | the backend's tests (three parts side by side) and the UI's typecheck / unit / i18n tests | — |
| desktop (linux, windows, macos-arm64, macos-x64) | the installers; macOS signed and notarized once (the .dmg) | its files, once verify has passed |
| android | the signed APK | its APK |
| ios | the signed IPA, uploaded to App Store Connect | the IPA (this run's release only) |
| testflight | waits for Apple, the public link's group, beta review | `ios.json` once a build has passed |
| finalize | an empty draft goes; old releases are pruned | — |

**What a release builds** (`.github/scripts/apps_plan.py`). A platform is built when something it is made of changed
since its newest published build (the release holding its installer names the commit): the desktop (all four of it,
which share their sources) follows `desktop/`, `backend/app/`, `backend/pyproject.toml`, `frontend/` and `assets/` — it
bundles the backend and the UI for local execution; Android follows `mobile/` but its iOS project, iOS `mobile/` but its
Android project — the phone apps load the console from the server, so a backend or UI change never makes a new phone
app, and an Android change no iOS build (macOS, an App Store upload, a beta review). Tests, docs, tools and the
workflow and its scripts make nothing: a build is never made again from the same sources (to anyway: by hand with the
platforms). The run's summary has the table of what was built and why.

So each platform has its own version — the Download page shows each one's (the phones stay at theirs while only the
desktop changes); what one release builds goes up together, never one platform ahead of the others.

**Publishing** (`.github/scripts/apps_publish.py`): each platform's files go into this run's versioned release the moment
it is built (`publish`; the first one to arrive makes the draft public). **Onto the Download page together**: once every
platform the run built is there, the `latest` job puts them all onto the rolling `apps-latest` at once (`promote`) — so
no platform of a release shows on the Download page before the others (since 2026-11-19; before, each platform went up
the moment it was built and for a quarter of an hour Android said 1.1.7 while the desktop still said 1.1.6). A platform
that failed holds them all at the last version until it is run again (Re-run failed jobs runs `latest` after it) — or
until the next release, which brings up with its own builds those of the held-back one it didn't need to make again
(nothing they are made of changed: `held_back`). Onto `apps-latest`:

1. every platform's installers first, the update feeds last (`latest.yml`, `latest-linux.yml`, `latest-mac-<arch>.yml`,
   `ios.json`): a feed never names a file that isn't there yet — and while the installers go up the Download page offers
   the version every platform has (`downloads.py` `_going_up`), so it never shows one ahead of the others;
2. never over a newer build of the same platform: an older run that finishes late leaves `apps-latest` alone;
3. then that platform's older files go; another platform's are never touched.

So `apps-latest` holds each platform's newest build — all of them the same version; the Download page shows each
platform's own (`backend/app/services/downloads.py`, `desktop/src/update-source.js`: the version is in each file name).
Its notes are the newest build's; its hrh-meta says `latest`, never `version`: apps up to 1.1.0 pin their files to the
versioned release a `version` names, and one platform's release doesn't hold the others.

**Each Mac architecture has its own feed** (`latest-mac-arm64.yml`, `latest-mac-x64.yml`); the desktop's update source
serves the one of its own architecture as `latest-mac.yml`. Apps up to 1.1.0 read one `latest-mac.yml` for both: it is
written (`apps_publish.py mac-legacy`) once both architectures of one version are up, and the files it names stay until
then.

**One release at a time** (per channel): a newer run waits for the running one (a release is never cancelled half-way:
it would leave one half up) and replaces any older one still waiting — so two runs never build the same thing.

**Versions.** `<line>.<n>`: the line is the product's version (`APP_LINE`, `backend/app/__init__.py`, the package.json
files); `n` is one past the highest release of the line, drafts included (a run still building holds its number; a run
that published nothing gives it back). Android's versionCode is the run number; iOS's build number is
`<run>.<attempt>`. The 5 newest releases are kept, and each platform's newest.

The web console and the server built from a commit say that commit's version too, never the bare line (until 2026-11-20
they said `1.1.0` whatever the release). `deploy/app-version.py [<commit>]` gives it, in this order:

1. the release tag on the commit;
2. else the commit's draft release (asked of GitHub);
3. else the newest release before it on the line (a commit that built no app);
4. else the line.

`deploy/swap-frontend.sh --build` builds the console with it (`APP_VERSION` → `vite.config.ts` → `src/version.ts`; a
build without it takes the newest release tag in git). `--write-backend` writes `backend/app/build.json`, which the server
reports from its next start (`app.build_version`: `/api/health`, `/api/config`). The desktop app hands its own version to
the server it bundles (`GENY_APP_VERSION`), and its Settings and sidebar show the app's version.

**By hand** (Actions → apps → Run workflow, or `gh workflow run apps -R CocoRoF/My-Mate-Geny -f platforms=… -f
channel=…`): `platforms` = `changed` (the default: what changed since each platform's last build), `all`, or a list
(`windows,linux,macos-arm64,macos-x64,android,ios`) — those whatever changed; `channel` = `release` (from main only) or
`test` — `apps-test-v<version>` releases, never `apps-latest` and never the public TestFlight link: a branch's pipeline
can be tried without anyone getting it (`gh workflow run apps --ref <branch> -f channel=test -f platforms=linux`).

**Time.** The phone apps are up in a few minutes, Windows and Linux in about five; macOS takes longest (signing a
~530 MB app, one notarization of the .dmg — Apple's ticket covers the app inside, and both are stapled — and the image
itself, ~10 min on the Intel runner): ~10 min on Apple Silicon, 12–30 on Intel. Every job has a time limit (the Macs 45
and 55 min, `apps_plan.py` `DESKTOP`), so a hung one stops there. Caches: npm, uv, the desktop's managed Python and its
packages (keyed by the dependencies, not the product's version), Electron and electron-builder's downloads, Gradle,
Capacitor's Swift packages.

**What it costs** (GitHub's runner minutes; macOS ones count ~10× Linux's). Per release: the desktop ~25–40 macOS minutes
(both Macs) + ~3 Windows + a few Linux; iOS ~2–5 macOS minutes (+ up to 110 Linux ones waiting on Apple's beta review);
Android ~2 Linux. Until 2026-11-20 that was every push to main (Nov 13–20: ~290 macOS minutes a day for the apps alone);
now at most once a day.

## iOS · iPadOS

The same Apple developer team, App Store Connect API key and Apple Distribution certificate as the user's other apps,
kept outside the repository (`~/.local/share/tomorrows-bell/`, or `APPLE_HOME`). `mobile/tools/appstore.py`:

```
python3 mobile/tools/appstore.py status       the app record, bundle ID, profile, TestFlight builds and groups
python3 mobile/tools/appstore.py bundle       registers the bundle ID (me.hrletsgo.harnessor)
python3 mobile/tools/appstore.py profile      an App Store profile for it with the Apple Distribution certificate
python3 mobile/tools/appstore.py secrets      the repository's Actions secrets (IOS_*, ASC_*)
python3 mobile/tools/appstore.py testflight   the internal group (every build) and the public link's group (홈페이지)
```

Once, by hand (the API can't): **App Store Connect → My Apps → + → New App** — iOS, name *My Mate Geny*, the bundle ID
above, SKU `mymategeny`. Until then the ios job builds and signs the IPA but doesn't upload it (a warning says so).
For the public link, beta review needs once, in **TestFlight → Test Information**: a contact (name, phone, e-mail), a
feedback e-mail and a privacy policy URL — the testflight job says which are missing.

The project (`mobile/ios`, Swift Package Manager) is Capacitor's with `App/GenyServer.swift`: the same server choice as
Android's `GenyServerPlugin.java` — no server built in; the connect page finds one and signs in, the bridge is made again
on that server's origin, and the first page is its `/auth/exchange` (the session cookie first-party). CI compiles it for
the simulator when it changes (`ci.yml` "ios": on the push to main, or on a PR labelled `ci:ios`); the release build
signs only the app target by hand (`.github/scripts/ios_signing.py`: Swift packages take no profile).

The Download page's iOS card appears once a build has passed beta review: `ios.json` on `apps-latest` names the build
and the public TestFlight link (its QR code on other devices; on an iPhone the button opens it). Updates come through
TestFlight.

## Android

`mobile/README.md`. On the desktop app with a private repository the Download page's QR code can't point at GitHub:
*Get it on my phone* serves the APK from the computer to the home network for 30 minutes, under a link only the code
knows (`desktop/src/update-source.js` `phoneLink`).

## CI

`.github/workflows/ci.yml`, on pushes to main and on PRs (docs alone run nothing): each part only when something it checks
changed (the changes job) — the backend's tests in three parts side by side (`backend/tests/conftest.py --shard i/n`,
balanced by `backend/tests/durations.json`; refresh it with `pytest -n 4 --durations=0 --junitxml=…` when the suite's
shape changes a lot), the Windows stdio bridges, the avatar pipeline, the UI, the desktop's and the phone app's unit
tests, the iOS app's compile, the compose files. Kept small (`.github/scripts/ci_gate.py`):

- **Linux runners only.** The Windows stdio bridges (when a bridge or its test changed) and the iOS compile (when the
  iOS project changed) run only on a PR with the label `ci:windows` / `ci:ios` — added after the run, re-run the PR's
  ci — never on a push (the release build compiles iOS anyway).
- **A merge isn't tested twice.** The PR's `tested` job leaves the tree it tested (the merge GitHub made) and the jobs
  that passed on it as the commit status `ci: tested tree` on the PR's head; the merge's push to main skips those jobs
  when it is that very tree (nothing landed on main in between). A direct push to main runs as always.
- A newer push cancels the run before it; every job has a time limit.

The heavy suites on Windows and macOS runners run only when asked for (since 2026-11-20, the owner: "과도한 테스트,
과도한 CI 중지"; `ci_gate.py heavy`): by hand (Actions → the workflow → Run workflow), or on a PR that changes what they
check with their label (re-run after adding it):

| workflow | what | PR label |
|---|---|---|
| `voice-local.yml` | local voice engines installed and speaking on Windows ×4, macOS ×3 (`docs/local-voice.md`) | `ci:voice` |
| `windows-update.yml` | the in-app update on Windows with the real installers (~40 min) | `ci:windows` |
| `local-desktop.yml` | the native local runtime on every OS (a push to `codex/native-local`) | — |
