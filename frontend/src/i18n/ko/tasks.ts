import type { Messages } from "..";

const ko: Messages<"tasks"> = {
  title: "백그라운드 작업",
  thisChat: "이 채팅",
  allChats: "모든 채팅",
  empty: "에이전트가 백그라운드에서 실행하는 명령과 서브에이전트가 여기에 나타나요 — 예를 들어 개발 서버나 오래 걸리는 빌드를 “백그라운드에서” 시작해 달라고 해 보세요.",
  runningN: "실행 중 {n}",
  finishedN: "완료 {n}",
  typeCommand: "명령",
  typeSubagent: "서브에이전트",
  typeAgent: "에이전트",
  typeTask: "작업",
  background: "백그라운드",
  stRunning: "실행 중",
  stPending: "대기 중",
  stCompleted: "완료",
  stFailed: "실패",
  stStopped: "중지됨",
  stKilled: "강제 종료됨",
  stLost: "끊김",
  showSubagent: "이 서브에이전트가 한 일 보기",
  stopTask: "이 작업 중지",
  earlierTrimmed: "… (앞부분 출력은 잘림)",
  noOutput: "(기록된 출력 없음)",
};
export default ko;
