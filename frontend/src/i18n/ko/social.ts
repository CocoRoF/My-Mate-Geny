// 다른 메이트 (components/mate/social, app/mate/social)
import type { Messages } from "..";

const social: Messages<"social"> = {
  title: "다른 메이트",
  empty: "{name:은} 아직 다른 메이트를 몰라요.",
  knowsOf: "알고만 있음",
  how_told: "내가 알려 줌",
  how_talked: "서로 대화함",
  convos: "둘이 나눈 대화",
  convosHelp: "열어 보면 {name:과} {other} 둘 다 내가 대화를 읽었다는 걸 알게 돼요.",
  convoWith: "{name:과} 나눈 대화",
  convoGoingOn: "아직 대화 중이에요…",
  unseen: "새 메시지 {count}",
  planOn: "지금 함께 있어요",
  onlyHer: "{name}만 아는 것",
  calledOffMine: "약속에 못 갔어요",
  calledOffTheirs: "약속이 취소됐어요",
  mood_great: "정말 즐거웠어요",
  mood_good: "즐거웠어요",
  mood_okay: "무난했어요",
  mood_awkward: "조금 어색했어요",
  settingsTitle: "메이트끼리",
  settingsOn: "메이트끼리 알고 지내기",
  settingsOnHelp: "처음엔 서로 존재만 알아요. 내가 다른 메이트 얘기를 해 주거나 말을 걸어 보라고 하면 알게 되고, 그 뒤로는 가까울수록 자주 서로 알아서 메시지를 주고받아요. 둘이 나눈 대화는 관계 탭에서 읽을 수 있고, 읽으면 메이트도 알아요.",
  settingsRomance: "메이트끼리 설렘",
  settingsRomanceHelp: "메이트끼리도 사람처럼 설렘이 생기고 연인이 될 수도 있어요. 끄면 우정까지만이에요.",
};
export default social;
