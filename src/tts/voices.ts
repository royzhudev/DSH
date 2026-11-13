/**
 * 对话模式的音色分配。
 *
 * 目标：同一角色在整条片子里用同一个音色，不同角色尽量不同音色，
 * 且不要和旁白音色撞车（否则听起来还是一个人在自说自话）。
 * 用户可以在角色库里给角色手动指定 voice；没指定时按名字稳定地自动分配，
 * 同一个名字每次生成都得到同一个音色。
 */

/** Edge TTS 的中文音色池：男声、女声各两个，覆盖常见的青年/中年听感。 */
const EDGE_VOICE_POOL = [
  "zh-CN-XiaoxiaoNeural", // 女声，温柔
  "zh-CN-YunxiNeural", // 男声，年轻
  "zh-CN-XiaoyiNeural", // 女声，活泼
  "zh-CN-YunjianNeural", // 男声，低沉
  "zh-CN-YunyangNeural", // 男声，新闻
  "zh-CN-XiaomoNeural", // 女声，沉稳
] as const;

function hashName(name: string): number {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return hash;
}

export interface SpeakerLike {
  name: string;
  voice?: string;
}

/**
 * 给说话人挑音色：显式指定的优先；否则从音色池按名字稳定挑选，
 * 跳过已经分给别人的音色和旁白音色（池子够大时）。
 */
export function resolveSpeakerVoice(
  speaker: string,
  cast: SpeakerLike[],
  fallbackVoice: string,
  used: Set<string> = new Set(),
): string {
  const explicit = cast.find((item) => item.name === speaker)?.voice?.trim();
  if (explicit) return explicit;
  const preferred = hashName(speaker) % EDGE_VOICE_POOL.length;
  for (let offset = 0; offset < EDGE_VOICE_POOL.length; offset += 1) {
    const candidate = EDGE_VOICE_POOL[(preferred + offset) % EDGE_VOICE_POOL.length]!;
    if (candidate === fallbackVoice || used.has(candidate)) continue;
    used.add(candidate);
    return candidate;
  }
  // 池子被占满时退而求其次：和旁白不同即可。
  const any = EDGE_VOICE_POOL.find((voice) => voice !== fallbackVoice) ?? EDGE_VOICE_POOL[0]!;
  used.add(any);
  return any;
}

/** 给一个分镜里的说话人分配音色（按出现顺序，保证稳定）。 */
export function assignDialogueVoices(
  speakers: string[],
  cast: SpeakerLike[],
  fallbackVoice: string,
): Map<string, string> {
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const speaker of speakers) {
    result.set(speaker, resolveSpeakerVoice(speaker, cast, fallbackVoice, used));
  }
  return result;
}

export { EDGE_VOICE_POOL };