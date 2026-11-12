import type { Messages } from "..";

const ko: Messages<"composer"> = {
  photos: "사진",
  photosHint: "PNG, JPG, GIF, WebP…",
  camera: "카메라",
  cameraHint: "지금 사진 찍기",
  files: "파일",
  filesHint: "PDF, 코드, 문서, 압축 파일…",
  pasteHint: "붙여넣기(Ctrl/⌘+V)나 끌어다 놓기로도 첨부할 수 있어요.",
  queued: "대기 중",
  nAttachments: "첨부 파일 {count}개",
  plusFiles: "+파일 {count}개",
  removeFromQueue: "대기열에서 빼기",
  dropToAttach: "놓아서 파일 첨부",
  bouncedNext: "턴이 끝나 가는 중이었어요 — 메시지는 다음 턴으로 보낼게요.",
  waitUploads: "업로드가 끝나기를 기다리는 중…",
  notConnectedKept: "연결 안 됨 — 다시 연결하는 중이에요. 메시지는 그대로 남아 있어요.",
  tooBig: "{mb} MB 제한보다 커요",
  tooMany: "메시지 하나에 파일은 최대 {count}개까지예요",
  // screen capture (docs/mate.md §4 "Seeing the screen")
  shareScreen: "화면 공유",
  shareScreenHint: "메시지를 보낼 때마다 화면을 함께 보여 줘요",
  shareScreenOn: "공유 중이에요 · 바꾸거나 끌 수 있어요",
};
export default ko;
