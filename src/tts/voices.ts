/**
 * 对话模式的音色分配。
 *
 * 目标：
 * 1. 同一角色在整条片子里用同一个音色，不同角色尽量不同音色，且不要和旁白撞车；
 * 2. 音色要和人物设定对得上——角色描述里写了性别、年龄，就挑声音特征接近的音色，
 *    而不是按名字哈希随便给一个（否则容易出现“大叔配少女音”这种不自然的搭配）。
 * 用户可以在角色库里给角色手动指定 voice；没指定时按描述 + 名字稳定地自动分配，
 * 同一个角色每次生成都得到同一个音色。
 */

export type VoicePoolName = "edge" | "openai";
export type VoiceGender = "female" | "male" | "unknown";
export type VoiceAge = "young" | "middle" | "old" | "unknown";

interface EdgeVoiceProfile {
  voice: string;
  gender: VoiceGender;
  age: VoiceAge;
  /** 听感备注，仅用于日志和排查。 */
  note: string;
}

/** Edge TTS 的中文音色池：按性别与年龄打标签，方便按人物设定匹配。 */
const EDGE_VOICE_PROFILES: EdgeVoiceProfile[] = [
  { voice: "zh-CN-XiaoxiaoNeural", gender: "female", age: "young", note: "温柔年轻女声" },
  { voice: "zh-CN-XiaoyiNeural", gender: "female", age: "young", note: "活泼少女" },
  { voice: "zh-CN-XiaomoNeural", gender: "female", age: "middle", note: "沉稳成熟女声" },
  { voice: "zh-CN-XiaochenNeural", gender: "female", age: "old", note: "年长女声" },
  { voice: "zh-CN-YunxiNeural", gender: "male", age: "young", note: "年轻男声" },
  { voice: "zh-CN-YunjianNeural", gender: "male", age: "middle", note: "低沉中年男声" },
  { voice: "zh-CN-YunyangNeural", gender: "male", age: "middle", note: "播音腔中年男声" },
  { voice: "zh-CN-YunyeNeural", gender: "male", age: "old", note: "年长男声" },
];

export const EDGE_VOICE_POOL = EDGE_VOICE_PROFILES.map((profile) => profile.voice);

/**
 * OpenAI 兼容 TTS 的音色池（gpt-4o-mini-tts / tts-1 通用名称）。
 * 这些音色同样按性别/年龄打标签；支持 instructions 的模型还能按角色写表演提示。
 */
const OPENAI_VOICE_PROFILES: EdgeVoiceProfile[] = [
  { voice: "nova", gender: "female", age: "young", note: "明亮年轻女声" },
  { voice: "shimmer", gender: "female", age: "young", note: "柔和女声" },
  { voice: "coral", gender: "female", age: "middle", note: "温暖成熟女声" },
  { voice: "sage", gender: "female", age: "old", note: "沉稳年长女声" },
  { voice: "alloy", gender: "male", age: "young", note: "中性年轻声线" },
  { voice: "echo", gender: "male", age: "young", note: "清亮男声" },
  { voice: "onyx", gender: "male", age: "middle", note: "低沉男声" },
  { voice: "fable", gender: "male", age: "old", note: "年长叙事男声" },
];

export const OPENAI_VOICE_POOL = OPENAI_VOICE_PROFILES.map((profile) => profile.voice);

function profilesFor(pool: VoicePoolName): EdgeVoiceProfile[] {
  return pool === "openai" ? OPENAI_VOICE_PROFILES : EDGE_VOICE_PROFILES;
}

const FEMALE_HINTS = ["女", "姐", "妹", "姑娘", "女孩", "少女", "阿姨", "妈妈", "母亲", "奶奶", "姥姥", "女士", "太太", "妻子", "她"];
const MALE_HINTS = ["男", "哥", "弟", "男孩", "少年", "大叔", "叔叔", "爸爸", "父亲", "爷爷", "姥爷", "先生", "丈夫", "他"];
const YOUNG_HINTS = ["少女", "女孩", "男孩", "少年", "青年", "学生", "大学生", "20 岁", "20岁", "18 岁", "18岁", "22 岁", "22岁", "25 岁", "25岁"];
const OLD_HINTS = ["老", "奶奶", "爷爷", "姥姥", "姥爷", "花甲", "古稀", "退休", "60 岁", "60岁", "65 岁", "65岁", "70 岁", "70岁"];
const MIDDLE_HINTS = ["中年", "30 岁", "30岁", "35 岁", "35岁", "40 岁", "40岁", "45 岁", "45岁", "50 岁", "50岁", "母亲", "父亲", "老板", "经理"];

function hit(text: string, hints: string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

/** 从人物设定里读出性别倾向；读不出来就返回 unknown，交给名字和音色池兜底。 */
export function inferVoiceGender(description: string): VoiceGender {
  const text = description.trim();
  if (!text) return "unknown";
  const female = hit(text, FEMALE_HINTS);
  const male = hit(text, MALE_HINTS);
  if (female && !male) return "female";
  if (male && !female) return "male";
  return "unknown";
}

/** 从人物设定里读出年龄段；读不出来返回 unknown。 */
export function inferVoiceAge(description: string): VoiceAge {
  const text = description.trim();
  if (!text) return "unknown";
  const age = text.match(/(\d{1,2})\s*岁/);
  if (age) {
    const value = Number(age[1]);
    if (value >= 55) return "old";
    if (value >= 32) return "middle";
    return "young";
  }
  if (hit(text, OLD_HINTS)) return "old";
  if (hit(text, YOUNG_HINTS)) return "young";
  if (hit(text, MIDDLE_HINTS)) return "middle";
  return "unknown";
}

function hashName(name: string): number {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return hash;
}

/**
 * 按人物设定筛出候选音色：性别、年龄都对得上的优先；
 * 对不上时逐级放宽（先只保性别，再退回整个池子），保证总能给出音色。
 */
function candidateVoices(gender: VoiceGender, age: VoiceAge, poolName: VoicePoolName = "edge"): string[] {
  const all = profilesFor(poolName);
  const byGender = (profile: EdgeVoiceProfile): boolean =>
    gender === "unknown" || profile.gender === gender;
  const exact = all.filter(
    (profile) => byGender(profile) && (age === "unknown" || profile.age === age),
  );
  const sameGender = all.filter(byGender);
  const pool = exact.length > 0 ? exact : sameGender.length > 0 ? sameGender : all;
  return pool.map((profile) => profile.voice);
}

export interface SpeakerLike {
  name: string;
  /** 人物设定（性别、年龄、身份），用来挑音色；没有就按名字稳定分配。 */
  description?: string;
  voice?: string;
}

/**
 * 给说话人挑音色：显式指定的优先；否则按人物设定（性别/年龄）挑，
 * 同一角色稳定得到同一个音色，并尽量避开旁白音色和已经分给其他角色的音色。
 */
export function resolveSpeakerVoice(
  speaker: string,
  cast: SpeakerLike[],
  fallbackVoice: string,
  used: Set<string> = new Set(),
  pool: VoicePoolName = "edge",
): string {
  const asset = cast.find((item) => item.name === speaker);
  const explicit = asset?.voice?.trim();
  if (explicit) return explicit;

  const description = asset?.description ?? "";
  const candidates = candidateVoices(inferVoiceGender(description), inferVoiceAge(description), pool);
  const preferred = hashName(speaker) % candidates.length;
  for (let offset = 0; offset < candidates.length; offset += 1) {
    const candidate = candidates[(preferred + offset) % candidates.length]!;
    if (candidate === fallbackVoice || used.has(candidate)) continue;
    used.add(candidate);
    return candidate;
  }
  // 候选都被占满时（同性别/同龄角色特别多）先在整池里找没人用过的音色，
  // 实在没有才允许重复——两个角色同一个声音，观众会以为是同一个人在自言自语。
  const free =
    pool === "edge"
      ? EDGE_VOICE_POOL.find((voice) => voice !== fallbackVoice && !used.has(voice))
      : undefined;
  const any = free ?? EDGE_VOICE_POOL.find((voice) => voice !== fallbackVoice) ?? EDGE_VOICE_POOL[0]!;
  used.add(any);
  return any;
}

/** 给一个分镜里的说话人分配音色（按出现顺序，保证稳定）。 */
export function assignDialogueVoices(
  speakers: string[],
  cast: SpeakerLike[],
  fallbackVoice: string,
  pool: VoicePoolName = "edge",
): Map<string, string> {
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const speaker of speakers) {
    result.set(speaker, resolveSpeakerVoice(speaker, cast, fallbackVoice, used, pool));
  }
  return result;
}

/**
 * 给支持 instructions 的 TTS（OpenAI gpt-4o-mini-tts 等）写表演提示：
 * 用短剧演员的口语感，避免“念稿子”的僵硬感。
 */
export function voiceStyleFor(description: string, text = ""): string {
  const age = inferVoiceAge(description);
  const gender = inferVoiceGender(description);
  const parts = ["像短剧演员一样自然地说台词，口语化，停顿和语气有起伏，不要朗读腔。"];
  parts.push(gender === "male" ? "成年男声。" : gender === "female" ? "成年女声。" : "");
  if (age === "old") parts.push("语速偏慢，声音低沉一些。");
  if (age === "young") parts.push("语气轻快，有活力。");

  // 按这一句的内容补表演提示：短剧的对白情绪变化快，逐句给提示比全片一个语气自然。
  if (/[!！]|喊|吼|嚷|咆哮|住手|闭嘴|滚|放开|不许|凭什么/.test(text)) {
    parts.push("这一句带情绪，音量提高、语速加快，像真的在争执。");
  } else if (/[?？]|吗|呢|什么|怎么|为什么/.test(text)) {
    parts.push("这一句是疑问语气，句尾自然上扬，不要平铺直叙。");
  } else if (/哭|泪|难受|心疼|对不起|求|别走/.test(text)) {
    parts.push("这一句放低声音，带一点哽咽和停顿，情绪压着说。");
  } else if (/耳语|小声|低声|悄悄|别出声/.test(text)) {
    parts.push("这一句压低声音说，接近气声。");
  } else if (/笑|哈哈|逗|玩笑/.test(text)) {
    parts.push("这一句带笑意，语气轻松。");
  } else {
    parts.push("这一句像平时说话一样自然，句与句之间留短停顿。");
  }
  return parts.filter(Boolean).join("");
}

/** 每个角色的音高微调：年长角色压低，年轻角色略提高，避免和年龄设定违和。 */
export function voicePitchFor(description: string): string {
  const age = inferVoiceAge(description);
  if (age === "old") return "-4Hz";
  if (age === "young") return "+2Hz";
  return "0Hz";
}

/**
 * 每个角色的音量增量（百分比）：只对需要提高嗓门的台词加一点，
 * 其余保持 0，响度差由拼接阶段的 loudnorm 统一拉平。
 */
export function voiceVolumeFor(description: string, text: string): number {
  if (/喊|吼|嚷|咆哮|大叫|站住|住手|闭嘴|滚开|放开|不许|别动/.test(text)) return 6;
  if (/耳语|小声|低声|别出声|压低声音|悄悄/.test(text)) return -4;
  return 0;
}

/** 每个角色的语速微调：年长角色慢一点，年轻角色略快，让对白更像真人。 */
export function voiceRateFor(description: string, baseRate: number): number {
  const age = inferVoiceAge(description);
  const delta = age === "old" ? -0.08 : age === "young" ? 0.06 : 0;
  const rate = Math.round((baseRate + delta) * 100) / 100;
  return Math.min(2, Math.max(0.5, rate));
}