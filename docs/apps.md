# The apps: builds, releases, the Download page

My Mate Geny ships as a desktop app (Windows, macOS on Apple Silicon and Intel, Linux — Electron, `desktop/`) and as a
phone app (Android and iOS · iPadOS — Capacitor, `mobile/`). The phone apps and the desktop's server mode load the
console live from the user's own server; the desktop's local execution bundles the backend and the UI.

## Releases

`.github/workflows/apps.yml` builds them; each platform is **built and published on its own** — the moment its build is
done it is on the Download page, whatever the others are doing:

| job | what | publishes |
|---|---|---|
| plan | which platforms this push needs (below) | — |
| version | this run's version `<line>.<n>` and its draft release `apps-v<version>` (one run at a time) | — |
| ui | the local-execution UI, built once for every desktop platform | an artifact |
| verify | the backend's tests (three parts side by side) and the UI's typecheck / unit / i18n tests | — |
| desktop (linux, windows, macos-arm64, macos-x64) | the installers; macOS signed and notarized once (the .dmg) | its files, once verify has passed |
| android | the signed APK | its APK |
| ios | the signed IPA, uploaded to App Store Connect | the IPA (this run's release only) |
| testflight | waits for Apple, the public link's group, beta review | `ios.json` once a build has passed |
| finalize | an empty draft goes; old releases are pruned | — |

**What a push builds** (`.github/scripts/apps_plan.py`). A platform is built when something it is made of changed since
its newest published build (the release holding its installer names the commit): the desktop follows `desktop/`,
`backend/app/`, `backend/pyproject.toml`, `frontend/` and `assets/` (tests and docs don't count); Android and iOS follow
`mobile/` only — they load the console from the server, so a backend or UI change doesn't make a new phone app. The
workflow and its scripts make every platform again. The run's summary has the table of what was built and why.

**Publishing one platform** (`.github/scripts/apps_publish.py publish`): its files go into this run's versioned release
(the first one to arrive makes the draft public) and into the rolling `apps-latest`:

1. the installers first, the update feed last (`latest.yml`, `latest-linux.yml`, `latest-mac-<arch>.yml`, `ios.json`): a
   feed never names a file that isn't there yet;
2. never over a newer build of the same platform: an older run that finishes late leaves `apps-latest` alone;
3. then that platform's older files go; another platform's are never touched.

So `apps-latest` holds each platform's newest build — the versions differ for a while, and the Download page shows each
platform's own (`backend/app/services/downloads.py`, `desktop/src/update-source.js`: the version is in each file name).
Its notes are the newest build's; its hrh-meta says `latest`, never `version`: apps up to 1.1.0 pin their files to the
versioned release a `version` names, and one platform's release doesn't hold the others.

**Each Mac architecture has its own feed** (`latest-mac-arm64.yml`, `latest-mac-x64.yml`); the desktop's update source
serves the one of its own architecture as `latest-mac.yml`. Apps up to 1.1.0 read one `latest-mac.yml` for both: it is
written (`apps_publish.py mac-legacy`) once both architectures of one version are up, and the files it names stay until
then.

**One build per platform at a time.** Each platform's job has its own concurrency group: a newer push's build waits for
the running one (it is never cancelled half-way) and replaces any older one still waiting.

**Versions.** `<line>.<n>`: the line is the product's version (`APP_LINE`, `backend/app/__init__.py`, the package.json
files); `n` is one past the highest release of the line, drafts included (a run still building holds its number; a run
that published nothing gives it back). Android's versionCode is the run number; iOS's build number is
`<run>.<attempt>`. The 5 newest releases are kept, and each platform's newest.

**By hand** (Actions → apps → Run workflow): `platforms` = `all`, `changed`, or a list (`windows,linux,macos-arm64,
macos-x64,android,ios`); `channel` = `release` (from main only) or `test` — `apps-test-v<version>` releases, never
`apps-latest` and never the public TestFlight link: a branch's pipeline can be tried without anyone getting it.

**Time.** The phone apps are up in a few minutes, Windows and Linux in about five; macOS takes longest (signing a
~530 MB app, one notarization of the .dmg — Apple's ticket covers the app inside, and both are stapled — and the image
itself on the Intel runner). Caches: npm, uv, the desktop's managed Python and its packages (keyed by the dependencies,
not the product's version), Electron and electron-builder's downloads, Gradle, Capacitor's Swift packages.

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
the simulator on every change to it (`ci.yml` "ios"); the release build signs only the app target by hand
(`.github/scripts/ios_signing.py`: Swift packages take no profile).

The Download page's iOS card appears once a build has passed beta review: `ios.json` on `apps-latest` names the build
and the public TestFlight link (its QR code on other devices; on an iPhone the button opens it). Updates come through
TestFlight.

## Android

`mobile/README.md`. On the desktop app with a private repository the Download page's QR code can't point at GitHub:
*Get it on my phone* serves the APK from the computer to the home network for 30 minutes, under a link only the code
knows (`desktop/src/update-source.js` `phoneLink`).

## CI

`.github/workflows/ci.yml`: each part only when something it checks changed (the changes job) — the backend's tests in
three parts side by side (`backend/tests/conftest.py --shard i/n`, balanced by `backend/tests/durations.json`; refresh it
with `pytest -n 4 --durations=0 --junitxml=…` when the suite's shape changes a lot), the Windows stdio bridges, the avatar
pipeline, the UI, the desktop's and the phone app's unit tests, the iOS app's compile, the compose files.
