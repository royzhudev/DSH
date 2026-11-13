/**
 * 对话模式的音色分配。
 *
 * 目标：同一角色在整条片子里用同一个音色，不同角色尽量不同音色，
 * 且不要和旁白音色撞车（否则听起来还是一个人在自说自话）。
 * 用户可以在角色库里给角色手动指定 voice；没指定时按角色设定的性别
 * 自动挑选男声/女声，再按名字稳定分配，同一个名字每次生成都得到同一个音色。
 */

interface VoiceOption {
  id: string;
  gender: "female" | "male";
  /** 听感说明，用于设置页提示与文档。 */
  tone: string;
}

/** Edge TTS 的中文音色池：男女各三个，覆盖温柔/活泼/沉稳与年轻/低沉/播报。 */
const VOICE_LIBRARY: VoiceOption[] = [
  { id: "zh-CN-XiaoxiaoNeural", gender: "female", tone: "温柔亲和" },
  { id: "zh-CN-XiaoyiNeural", gender: "female", tone: "活泼年轻" },
  { id: "zh-CN-XiaomoNeural", gender: "female", tone: "沉稳知性" },
  { id: "zh-CN-YunxiNeural", gender: "male", tone: "年轻清亮" },
  { id: "zh-CN-YunjianNeural", gender: "male", tone: "低沉有力" },
  { id: "zh-CN-YunyangNeural", gender: "male", tone: "稳重播报" },
];

const EDGE_VOICE_POOL = VOICE_LIBRARY.map((voice) => voice.id);

const MALE_HINTS = /男|爸|父|叔|伯|哥|弟|爷|先生|小伙|少年|男孩|男主/;
const FEMALE_HINTS = /女|妈|母|姨|姑|姐|妹|奶|阿姨|小姐|姑娘|女孩|女主/;

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
  /** 角色设定，用来判断男声/女声，例如“25 岁女性，齐肩短发”。 */
  description?: string;
  kind?: string;
}

function genderOf(speaker: string, cast: SpeakerLike[]): "female" | "male" | undefined {
  const asset = cast.find((item) => item.name === speaker);
  const text = `${asset?.description ?? ""} ${speaker}`;
  const female = FEMALE_HINTS.test(text);
  const male = MALE_HINTS.test(text);
  if (female && !male) return "female";
  if (male && !female) return "male";
  return undefined;
}

function poolFor(gender: "female" | "male" | undefined): string[] {
  if (!gender) return EDGE_VOICE_POOL;
  return VOICE_LIBRARY.filter((voice) => voice.gender === gender).map((voice) => voice.id);
}

/**
 * 给说话人挑音色：显式指定的优先；否则按性别从男/女声池里按名字稳定挑选，
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
  const pool = poolFor(genderOf(speaker, cast));
  const preferred = hashName(speaker) % pool.length;
  for (let offset = 0; offset < pool.length; offset += 1) {
    const candidate = pool[(preferred + offset) % pool.length]!;
    if (candidate === fallbackVoice || used.has(candidate)) continue;
    used.add(candidate);
    return candidate;
  }
  // 同性别池子被占满时，再退到整个池子；仍然避开旁白音色。
  for (const voice of EDGE_VOICE_POOL) {
    if (voice === fallbackVoice || used.has(voice)) continue;
    used.add(voice);
    return voice;
  }
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

/** 音色听感说明，设置页/角色页展示用。 */
export function describeVoice(voice: string): string {
  return VOICE_LIBRARY.find((item) => item.id === voice)?.tone ?? "";
}

export { EDGE_VOICE_POOL };