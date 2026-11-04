import type {BodyMood} from './types';

/** Video intent follows conversation activity. Audio playback is deliberately not an input. */
export function activityMood(streaming:boolean,writing:boolean,listening:boolean,away:boolean):BodyMood {
  return streaming ? writing ? 'talking' : 'thinking' : listening ? 'listening' : away ? 'away' : 'idle';
}
