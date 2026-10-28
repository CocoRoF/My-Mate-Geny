# hr-harnessor

직접 호스팅하는 **에이전트 하네스 서비스** — 채팅으로 업무를 지시하고, Provider를 꽂아 쓰며,
로컬 **2223** 서버에서 실행되지만 원격 서버(2222 / 2224)의 폴더도 조작할 수 있다.

## 개요

- **Provider** — Claude Code(`claude` CLI)는 실동작하며, Codex(`codex` CLI)는 연결만 하면 되는
  인터페이스 stub가 준비돼 있다. 각 provider는 stream-json 모드의 subprocess로 실행되고,
  그 출력은 하나의 정규화 이벤트 스키마로 변환된다.
- **Workspace** — 에이전트가 *어디서* 돌지 고른다: 2223 로컬 폴더, 또는 원격 SSH 호스트
  (2222 / 2224)의 폴더. 런타임은 항상 2223에 있고, 원격 폴더는 sshfs로 마운트되며 원격 명령은
  SSH로 프록시된다.
- **Web + Mobile** — React/Vite 웹 UI와 Expo(React Native) 앱이 동일한 FastAPI 백엔드에
  REST + WebSocket으로 접속한다.

세션 = **Provider × Workspace × 대화기록** 의 조합.

## 빠른 시작 (개발)

```bash
# 백엔드
cd backend
uv pip install -e .
cp ../.env.example ../.env
uvicorn app.main:app --reload --port 8080

# 프론트엔드 (다른 셸)
cd frontend
npm install
npm run dev     # http://localhost:5173
```

웹 UI에서 Claude provider를 연결(구독 인증 사용)하고, 로컬 폴더를 워크스페이스로 고른 뒤 채팅한다.

설계 전체는 [docs/architecture.md](docs/architecture.md) 참고. 패턴은 로컬의 `geny-executor`,
`geny-executor-web`, GAPT에서 차용했다.
