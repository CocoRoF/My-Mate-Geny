/** Mate client core: avatar renderers, voice bridge, emotion tags, sentence splitting, the voice queue. */
export type * from "./types";
export { MateAvatar, setLive2DCoreUrl, getLive2DCoreUrl } from "./avatar/MateAvatar";
export type { MateAvatarExtraProps } from "./avatar/MateAvatar";
export {
  markLive2DCoreInstalled,
  useLive2DCoreInstalls,
  openGlobalSettings,
  LIVE2D_CORE_INSTALLED_EVENT,
  OPEN_GLOBAL_SETTINGS_EVENT,
} from "./live2dCore";
export {
  voiceBridge,
  start as voiceStart,
  level as voiceLevel,
  end as voiceEnd,
  attachAudio,
  unlockAudio,
  getAudioContext,
  fakeLevel,
  useVoiceLevel,
  useVoiceSpeaking,
} from "./voiceBridge";
export type { VoiceEvent, VoiceMark } from "./voiceBridge";
export {
  EMOTIONS,
  normalizeEmotion,
  emotionCandidates,
  lookupEmotion,
  parseEmotionText,
  stripEmotionTags,
  EmotionTracker,
} from "./emotion";
export type { Emotion, EmotionTag, ParsedEmotionText } from "./emotion";
export { SentenceStream, splitSentences, splitBubbles, speakable, plainText } from "./sentences";
export type { Sentence, SentenceOptions } from "./sentences";
export { MateAudioQueue, getMateAudioQueue, useMateAudio, installAutoplayUnlock } from "./audioQueue";
export type { AudioQueueItem, ClipSource, QueueState, Resolver, BrowserVoiceOptions } from "./audioQueue";
