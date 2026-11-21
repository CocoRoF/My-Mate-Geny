// 대화 아래 사용량 바 (components/layout/SystemBar.tsx, docs/monitoring.md "Usage bar")
import type { Messages } from "..";

const sysbar: Messages<"sysbar"> = {
  title: "시스템 사용량",
  host: "머신: {host}",
  cores: { one: "코어 {count}개", other: "코어 {count}개" },
  geny: "Geny 자체: 메모리 {mem} GB · CPU {cpu}%",
  open: "누르면 전체 모니터를 열어요 (설정 → 관리자 → 시스템)",
  connecting: "시스템 사용량을 읽는 중…",
  offline: "다시 연결하는 중…",
  off: "이 서버는 시스템 모니터가 꺼져 있어요",
  alerts: { one: "경고 {count}개", other: "경고 {count}개" },
  hide: "사용량 바 숨기기",
  hideHint: "숨기기 — 설정 → 테마에서 다시 켤 수 있어요",
  closed: "사용량 바를 숨겼어요. 설정 → 테마에서 다시 켤 수 있어요.",
  setting: "시스템 사용량 바",
  settingHint:
    "메이트와 채팅 대화 아래에 얇은 바로 Geny가 돌아가는 머신의 CPU, 메모리, GPU 사용률, 그래픽 메모리와 온도, 네트워크를 보여 줘요. 이 기기에서만 적용돼요.",
};
export default sysbar;
