<p align="center"><img src="assets/geny-logo.png" width="240" alt="Geny 로고"></p>

<h1 align="center">My Mate Geny</h1>

<p align="center">
  코딩 에이전트(Claude Code, Codex)를 위한 셀프 호스팅 콘솔 — 그리고 그 일을 대신 맡겨 주는 아바타 비서.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Python 3.11+" src="https://img.shields.io/badge/python-3.11%2B-3776AB">
  <img alt="React 18" src="https://img.shields.io/badge/react-18-61DAFB">
  <img alt="Docker" src="https://img.shields.io/badge/docker-compose-2496ED">
  <img alt="Apps" src="https://img.shields.io/badge/apps-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-555">
</p>

<p align="center"><a href="README.md">English</a></p>

---

My Mate Geny는 **Claude Code**·**Codex** CLI를 내 컴퓨터나 서버에서 돌아가는 채팅 서비스로
만들어 준다. 브라우저·데스크톱 앱·안드로이드 앱으로 접속해 로컬 또는 원격(SSH) 폴더에서 채팅을
시작하고, 모든 도구 호출과 파일 변경을 지켜보며, 여러 구독 계정에 부하를 나눈다. 그 위에 **메이트**가
있다 — 말을 걸 수 있는 아바타(영상·사진·Live2D 몸, 음성 입출력)로, 일을 채팅에 맡기고, 챙기고,
결과를 보고한다.

*(옛 이름 "hr-harnessor": 기존 설치가 그대로 업데이트되도록 `~/.hr-harnessor` 상태 폴더,
쿠키·저장소 키, 앱 ID 등 내부 식별자는 그 이름을 유지한다.)*

<!-- 스크린샷: docs/images/console.png, docs/images/mate.png, docs/images/desktop-mate.png 추가 -->
| 콘솔 | 메이트 | 데스크톱 메이트 |
|---|---|---|
| _스크린샷: 채팅 + 탐색기_ | _스크린샷: 메이트 무대_ | _스크린샷: 데스크톱 오버레이_ |

## 기능

- **엔진** — Claude Code(`claude`)와 Codex(`codex`). 대화 중 엔진을 바꿔도 맥락이 넘어간다.
  Claude는 채팅마다 상주 엔진(백그라운드 작업, 후속 턴, 실시간 중단·모델·권한 전환), Codex는 턴마다
  `exec`. 출력은 하나의 정규화 이벤트 스키마로 스트리밍된다.
- **Workspace** — 서버의 폴더, 또는 SSH 기반 MCP 브리지(`remote_bash/read/write/list`)로 원격 호스트의
  폴더. Git 저장소를 클론해 workspace로 쓸 수 있고, 채팅마다 추가 폴더도 붙일 수 있다.
- **에이전트 UX** — 본문과 도구 활동 분리(접히는 도구 묶음, diff, 서브에이전트 중첩), git 스냅샷 기반
  턴별 파일 변경·diff·되돌리기, 백그라운드 작업 패널, 실행 중 턴 조종, 대기열, `/` 명령과 `@` 파일,
  사진·파일·클립보드 첨부, 알림.
- **탐색기 + 뷰어** — VS Code 스타일 탐색기(로컬·원격)와 파일 탭: 코드, 마크다운, CSV/TSV, 엑셀, 워드,
  파워포인트, PDF, 노트북, HTML(샌드박스), 이미지·오디오·영상. 에이전트가 출력한 경로는 클릭하면 열린다.
  서버 자체의 자격증명은 절대 보여 주지 않는다.
- **컨텍스트·사용량** — 컨텍스트 미터, 압축 구분선, "Compact now", 자동 압축 창 설정, 채팅별 비용과
  플랜 사용량.
- **계정** — 여러 Claude / Codex 로그인을 풀로 묶어 플랜 사용량 기반 분산, 채팅 고정(계정별 프롬프트
  캐시), 한도 시 쿨다운과 자동 이관.
- **운영** — 관리자 콘솔(오류 로그, 시스템, 보안), 세션 폐기, IP별 로그인 차단.
- **메이트** — 페르소나, 기억, 음성(브라우저, OpenAI, ElevenLabs, OmniVoice, 임의의 HTTP TTS;
  Whisper 호환 STT), 감정 태그와 립싱크가 있는 영상·사진·Live2D 몸, 채팅으로의 위임. 데스크톱 앱에서는
  바탕화면에 산다(투명한 항상-위 아바타, **Ctrl/Cmd+Shift+G** 빠른 채팅).
- **클라이언트** — 웹 콘솔(데스크톱·모바일 레이아웃), 데스크톱 앱(Electron: Windows·macOS·Linux),
  안드로이드 앱(Capacitor). 앱은 내 서버의 콘솔을 불러오므로 UI 업데이트가 새 빌드 없이 반영된다.

## 빠른 시작 (Docker)

필요: Docker + Compose v2.24 이상, 이미지용 디스크 약 3 GB.

```bash
git clone <이 저장소> my-mate-geny && cd my-mate-geny
docker compose up -d
```

**http://localhost:8080** 을 열고 **`admin` / `geny-admin`** 으로 로그인한 뒤, 바로
**Admin → Security** 에서 비밀번호를 바꾼다([docs/auth.md](docs/auth.md)).

서버가 보관하는 모든 것(DB, 암호화된 vault, 계정 로그인, 메이트, 업로드, 클론한 저장소)은 `geny-home`
Docker 볼륨에 있다. 포트·바인드 주소·uid·작업 폴더 같은 선택 설정은 [.env.example](.env.example)
을 `.env` 로 복사해 고친다.

### Claude Code / Codex 연결

이미지에 두 CLI가 이미 들어 있다. 터미널 없이 콘솔에서 로그인한다.

1. **Providers** → Claude → **Add account** → **Sign in**: 링크를 열어 승인하고 코드를 붙여 넣는다.
   계정을 더 추가하면 풀로 묶인다.
2. **Codex** 계정 추가 → 기기 인증 링크를 열고 표시된 코드를 입력(또는 OpenAI API 키 저장).

호스트 사용자의 로그인을 그대로 쓰려면 호스트에서 `claude` / `codex login` 을 한 번 실행한 뒤
[docker-compose.yml](docker-compose.yml) 의 `~/.claude`, `~/.claude.json`, `~/.codex` 마운트 주석을 푼다.

### 작업 폴더

에이전트는 컨테이너 안 `/workspaces` 에서 일한다. 기본은 Docker 볼륨이고, 호스트 폴더를 쓰려면
`.env` 에 `GENY_WORKSPACES=/path/to/projects` 와 폴더 주인의 `GENY_UID`/`GENY_GID`(`id -u` / `id -g`)를
적고 `docker compose up -d --build`. 원격 머신은 **Connections** 에서 SSH 호스트를 추가한다(키는 암호화 저장).

그다음 엔진·workspace·폴더를 골라 채팅을 시작한다.

### 메이트 설정

1. **Mate** 를 연다. 내장 메이트를 고르거나, 새 메이트(페르소나, 인사말, 언어)를 만들고 몸을 준다 —
   영상 클립·사진(zip 또는 서버 폴더 가져오기) 또는 **Live2D** 모델.
2. **Live2D 런타임**: Live2D 몸에는 재배포가 허용되지 않는 Cubism Core가 필요하다. 메이트 화면의
   **Global settings → Live2D** 에서 Live2D 라이선스를 읽고 동의하면 서버가 live2d.com 에서 한 번 내려받는다.
3. **음성**: 키와 서비스 URL은 **Global settings → Voice services**, 메이트별 **Voice** 탭에서 TTS 엔진을
   고른다 — `browser`(무료, 내장), `openai`·`elevenlabs`(API 키, vault 저장), `omnivoice`(셀프 호스팅,
   [geny-audio-services](https://github.com/CocoRoF/geny-audio-services) 참고; 모델 가중치는 비상업용),
   임의의 `http` TTS. 음성 입력용 Whisper 호환 STT URL도 지정할 수 있다.
4. 메이트에게 프로젝트 일을 부탁하면 채팅을 열거나 재사용해 일을 맡기고 결과를 보고한다.

설계와 API: [docs/mate.md](docs/mate.md).

## 운영 배포

HTTPS를 앞에 두거나(Caddy / nginx 예시) Cloudflare 터널을 쓴다: [docs/deploy.md](docs/deploy.md),
[deploy/](deploy/). Docker 없이 호스트에서 돌리려면 `deploy/start-backend.sh` 가 현재 사용자로 백엔드를 띄운다.

## 앱

- **데스크톱**(`desktop/`, Electron)과 **안드로이드**(`mobile/`, Capacitor)는 *내* 서버의 콘솔을 불러오는
  얇은 껍데기다. 처음 실행할 때 서버 주소를 입력한다. [desktop/README.md](desktop/README.md),
  [mobile/README.md](mobile/README.md) 참고.
- [.github/workflows/apps.yml](.github/workflows/apps.yml) 이 Windows / macOS / Linux 설치 파일과 서명된 APK를
  GitHub 릴리스로 만들고, 콘솔의 **Download** 페이지는 `APPS_REPO` / `APPS_RELEASE_TAG` 릴리스를 보여 준다.
- **자체 앱을 배포하는 포크**: 앱 ID(`desktop/package.json` 의 `appId`, `mobile/capacitor.config.json` 의
  `appId`, `mobile/android/app/build.gradle` 의 `applicationId` / `namespace` 와 Java 패키지)를 바꾸고,
  안드로이드 서명 시크릿(`HRH_KEYSTORE_B64`, `HRH_KEYSTORE_PASSWORD`, `HRH_KEY_ALIAS`, `HRH_KEY_PASSWORD`)을
  직접 만들고, `APPS_REPO` 를 내 저장소로 지정한다. 원본 ID `me.hrletsgo.harnessor` 는 기존 설치의
  업데이트 연속성 때문에만 남아 있다.

## 설정

모든 백엔드 설정과 기본값·설명: [backend/.env.example](backend/.env.example) (`backend/.env` 로 복사).
Compose 설정: [.env.example](.env.example), [deploy/.env.example](deploy/.env.example).

## 개발

```bash
# 백엔드 (Python 3.11+)
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
cp .env.example .env                   # 수정 (http://localhost 면 COOKIE_SECURE=false)
uvicorn app.main:app --reload --port 8080
pytest -q

# 웹 콘솔 (Node 22)
cd frontend
npm ci
npm run dev                            # http://localhost:5173, /api + /ws 를 :8080 으로 프록시
npx tsc -p . --noEmit                  # 타입 체크
```

실제 턴을 돌리려면 `claude` 와/또는 `codex` 가 `PATH` 에 있어야 한다
(`npm i -g @anthropic-ai/claude-code @openai/codex`). 테스트에는 필요 없다.

## 구조

```
 웹 콘솔          데스크톱 앱 (Electron)        안드로이드 앱 (Capacitor)
        └──────────────────┬───────────────────────┘   REST + WebSocket (같은 origin)
                           ▼
        (HTTPS 프록시 / 터널) → FastAPI 백엔드 — 콘솔, API, WS, 로그인 제공
                           ├─ Engines       claude (상주) | codex (턴마다)
                           ├─ Accounts      CLI 로그인 풀, 분산
                           ├─ Workspaces    local | remote SSH (MCP 브리지)
                           ├─ Changes       턴별 git 스냅샷
                           ├─ Mate          페르소나, 음성, 아바타, 위임
                           ├─ Vault         OAuth 토큰, API 키, SSH 키 (Fernet)
                           └─ Store         세션, 이벤트, 작업, 로그 (SQLite)
```

채팅 = **엔진 × workspace × 대화**. 자세히: [docs/architecture.md](docs/architecture.md),
[docs/providers.md](docs/providers.md), [docs/remote.md](docs/remote.md), [docs/mate.md](docs/mate.md).

## 브랜딩 (포크)

모든 아이콘은 마스터 이미지 하나(`assets/geny-logo.png`)에서 만들어진다. 바꾸려면 정사각형 투명 PNG로
교체하고 `python3 scripts/make-icons.py`(Pillow 필요)를 실행하면 파비콘, PWA 아이콘, 앱 내 로고, 데스크톱
아이콘, 안드로이드 아이콘 원본이 다시 생성된다. 로고와 내장 캐릭터는 Apache 라이선스 대상이 아닌
프로젝트 아트워크다 — [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## 기여 · 보안 · 라이선스

- [CONTRIBUTING.md](CONTRIBUTING.md) — 변경 제안 방법.
- [SECURITY.md](SECURITY.md) — 취약점 제보 방법(공개 이슈로 올리지 말 것).
- 코드: [Apache-2.0](LICENSE) ([NOTICE](NOTICE)). 내장 캐릭터, Live2D 샘플 모델, 로고는 별도 조건:
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

My Mate Geny는 Anthropic, OpenAI, Live2D와 관계가 없다. Claude Code, Codex와 연결한 계정의 사용은 각
제공자의 약관을 따른다.
