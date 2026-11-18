import type { Messages } from "..";

const ko: Messages<"net"> = {
  tab: "디바이스 인증",
  on: "켜짐",
  off: "꺼짐",

  // ---- 로컬 실행: Geny Net
  pairTitle: "휴대폰 연결",
  pairHelp:
    "휴대폰의 My Mate Geny 앱에서 [QR로 연결]을 눌러 이 코드를 스캔하세요. 두 화면에 같은 여섯 자리 숫자가 보이면 여기서 허용하면 돼요. 그다음부터 휴대폰은 같은 네트워크에서는 이 컴퓨터에 바로, 밖에서는 공유기를 통해 바로 연결하고, 그게 안 될 때만 릴레이를 거쳐요. 모든 통신은 종단간 암호화돼요. 휴대폰은 밖으로 나가지 않는 자기 키를 가지고, 릴레이는 읽을 수 없는 바이트만 전달해요. 코드 하나로 휴대폰 한 대를 연결할 수 있고, 5분 동안 유효해요. 이 컴퓨터가 꺼져 있거나 앱이 닫혀 있으면 연결할 수 없어요.",
  showQr: "QR 코드 보이기",
  scanCaption: "Android 앱 → QR로 연결",
  left: "{time} 남음",
  expired: "코드가 만료됐어요.",
  again: "새 코드",
  asks: "{name}에서 연결을 요청해요",
  sasHint: "휴대폰에도 같은 숫자가 보이면 허용하세요.",
  allow: "허용",
  deny: "거절",
  paired: "{name} 연결됨",
  devicesTitle: "연결된 기기",
  online: "지금 연결됨",
  never: "아직 연결 안 됨",
  viaLan: "같은 네트워크",
  viaWan: "인터넷 직접",
  viaRelay: "릴레이",
  removeConfirm: "{name}의 연결을 끊고 목록에서 지울까요? 다시 쓰려면 새 QR 코드로 연결해야 해요.",
  waysTitle: "휴대폰이 이 컴퓨터에 닿는 방법",
  lan: "같은 네트워크에서 직접 연결",
  lanHelp: "같은 Wi-Fi에 있으면 휴대폰이 이 컴퓨터에 바로 연결해요. 방화벽이 물어보면 개인 네트워크에서 My Mate Geny를 허용하세요.",
  upnp: "공유기 포트 자동 열기",
  upnpHelp:
    "이 컴퓨터가 공유기에 포트 하나를 열어 달라고 요청해요(UPnP, NAT-PMP). 그러면 휴대폰이 인터넷 어디서든 서버를 거치지 않고 이 컴퓨터에 바로 연결해요. 연결된 휴대폰만 받아들여요. 공유기에서 UPnP가 꺼져 있거나 공유기 자체가 공인 주소를 받지 못하면(공유기 앞에 공유기가 또 있거나, 통신사 NAT 뒤) 안 되고, 그때는 릴레이를 써요.",
  upnpOpen: "열림",
  upnpTrying: "시도 중",
  upnpUnavailable: "안 됨",
  reachOk: "밖에서 접속 확인됨",
  reachNo: "밖에서 닿지 않음",
  relay: "밖에서도 연결 (릴레이)",
  relayHelp:
    "직접 연결이 안 될 때는 휴대폰과 이 컴퓨터가 릴레이에서 만나요. 둘 다 릴레이로 나가는 연결이에요. 암호화가 휴대폰에서 이 컴퓨터까지 이어지므로 릴레이는 아무것도 읽을 수 없어요. NET_RELAY=1로 실행한 My Mate Geny 서버라면 어느 것이든 릴레이가 될 수 있어요.",
  relayUrl: "릴레이 주소",
  relayOnline: "연결됨",
  relayConnecting: "연결 중",
  relayOffline: "연결 안 됨",
  hereTitle: "이 기기",
  here: "Geny Net으로 {name}에 연결돼 있어요",
  forget: "이 휴대폰 연결 끊기",
  forgetConfirm: "이 휴대폰의 연결을 지울까요? 다시 쓰려면 새 QR 코드로 연결해야 해요.",

  // ---- 서버 실행: 로그인 코드
  loginTitle: "휴대폰으로 로그인",
  loginHelp:
    "휴대폰의 My Mate Geny 앱에서 [QR로 연결]을 눌러 이 코드를 스캔하면 이 서버에 지금 계정으로 로그인돼요. 코드는 5분 동안 한 번만 쓸 수 있어요.",
  server: "서버",
  account: "계정",
  getApp: "Android 앱 받기",
};
export default ko;
