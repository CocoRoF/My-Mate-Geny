# hr-harnessor

직접 호스팅하는 **에이전트 하네스 서비스** — 채팅으로 업무를 지시하고, Provider를 꽂아 쓰며,
로컬 **2223** 서버에서 실행되지만 원격 서버(2222 / 2224)의 폴더도 조작할 수 있다.

## 개요

- **엔진** — Claude Code(`claude` CLI)와 Codex(`codex` CLI) 모두 실동작하며, 대화 중 엔진을
  바꿔도 맥락이 넘어간다. Claude는 채팅마다 **상주 엔진**으로 실행돼 백그라운드 작업, Claude의
  자발적 후속 턴, 실시간 중단·모델·권한 전환을 지원하고, Codex는 턴마다 `exec`로 실행된다.
  출력은 하나의 정규화 이벤트 스키마로 변환된다.
- **Workspace** — 에이전트가 *어디서* 돌지 고른다: 2223 로컬 폴더, 또는 원격 SSH 호스트
  (2222 / 2224)의 폴더. 런타임은 항상 2223에 있고, 원격 작업은 SSH 기반 MCP 브리지
  (`remote_bash/read/write/list`)로 Claude·Codex 모두 수행한다.
- **탐색기 + 파일 탭** — VS Code처럼 우측 탐색기(로컬·원격 호스트)에서 폴더를 보고, 파일은 채팅 옆
  탭으로 연다. 에이전트가 쓴 경로(`인라인 코드`, 링크, 절대 경로, `file.py:42`)는 클릭하면 바로 열린다.
  코드(하이라이트·줄 이동), 마크다운(렌더/원본), CSV(정렬 표, UTF-8/CP949), 엑셀(시트 탭), 워드,
  파워포인트(개요), PDF, 노트북, HTML(샌드박스), 이미지·오디오·영상. 하네스 자체 자격증명은 보여 주지 않는다.
- **Web + Apps** — 웹 콘솔(데스크톱/모바일 레이아웃), 데스크톱 앱(Electron: Windows·macOS·Linux),
  안드로이드 앱(Capacitor)이 같은 콘솔을 사용합니다. 앱은 콘솔을 실시간으로 불러오므로 UI 업데이트가
  즉시 반영되고, 앱 빌드는 CI가 만들어 콘솔의 Download 페이지에 올립니다.
- **컨텍스트** — 입력창 아래 컨텍스트 미터(마지막 모델 호출의 input + cache 토큰 / CLI가 알려 주는
  창 크기와 자동 압축 지점), 압축 구분선, "Compact now", 자동 압축 창 설정(전역 기본값 + 채팅별,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`로 전달). 모델 호출마다 컨텍스트 전체를 다시 읽으므로 창이 작을수록
  호출당 플랜 사용량이 줄지만, 이전 대화는 요약으로만 남는다.
- **계정 로드 밸런싱** — 채팅은 마지막으로 쓴 계정에 **고정**된다(프롬프트 캐시는 계정별). 유휴 엔진은
  30분 뒤 종료되지만 같은 계정으로 `--resume` 하므로 캐시를 잃지 않는다. 계정을 쓸 수 없거나 한도에 가까울 때
  (기본 5시간 ≥ 90%, 7일 ≥ 95%, 다른 계정에 여유가 있을 때)만 옮기고, 한도에 걸린 계정은 리셋까지 쉬게 하며
  진행 중인 턴은 다른 계정에서 한 번 이어서 실행된다(알림 표시). 이 머신의 기본 로그인은 제외하거나 예비로만 쓸 수 있다.
- 모든 클라이언트는 동일한 FastAPI 백엔드에 REST + WebSocket으로 접속한다.

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
