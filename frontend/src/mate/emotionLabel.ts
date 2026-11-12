import type { MsgKey, TFunction } from "../i18n";
import { EMOTIONS } from "./emotion";

const VOCAB: readonly string[] = EMOTIONS;

/** an emotion of the vocabulary in the UI's language (Settings → Avatar & outfits); any other word (a rig's own) as
 *  it is */
export const emotionLabel = (t: TFunction, e: string): string => (VOCAB.includes(e) ? t(`mate.emotion_${e}` as MsgKey) : e);
