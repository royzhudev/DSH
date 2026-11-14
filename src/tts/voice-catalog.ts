import type { Logger } from "../logger.js";
import type { TtsProviderName, TtsSettings } from "../types.js";

export interface VoiceOption {
  /** 填进「对话配音音色」的 voice id。 */
  value: string;
  label: string;
}

export interface VoiceCatalog {
  provider: TtsProviderName;
  model: string;
  voices: VoiceOption[];
  /** 该供应商/模型的音色说明，前端显示在音色输入框下面。 */
  hint: string;
  /** 是否允许填列表之外的音色（复刻音色、自定义 voice id）。 */
  allowCustom: boolean;
}

const EDGE_VOICES: VoiceOption[] = [
  { value: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 温柔女声（默认）" },
  { value: "zh-CN-YunxiNeural", label: "云希 · 青年男声" },
  { value: "zh-CN-XiaoyiNeural", label: "晓伊 · 活泼女声" },
  { value: "zh-CN-YunjianNeural", label: "云健 · 浑厚男声" },
  { value: "zh-CN-YunyangNeural", label: "云扬 · 新闻男声" },
  { value: "zh-CN-XiaochenNeural", label: "晓辰 · 知性女声" },
  { value: "zh-CN-liaoning-XiaobeiNeural", label: "晓北 · 东北女声" },
  { value: "zh-CN-shaanxi-XiaoniNeural", label: "晓妮 · 陕西女声" },
  { value: "zh-HK-HiuMaanNeural", label: "曉曼 · 粤语女声" },
  { value: "zh-TW-HsiaoChenNeural", label: "曉臻 · 台湾女声" },
];

const OPENAI_VOICES: VoiceOption[] = [
  { value: "alloy", label: "alloy · 中性" },
  { value: "echo", label: "echo · 男声" },
  { value: "fable", label: "fable · 故事腔" },
  { value: "onyx", label: "onyx · 低沉男声" },
  { value: "nova", label: "nova · 明亮女声" },
  { value: "shimmer", label: "shimmer · 柔和女声" },
  { value: "coral", label: "coral · 亲和女声" },
  { value: "verse", label: "verse · 沉稳男声" },
];

const ELEVENLABS_VOICES: VoiceOption[] = [
  { value: "21m00Tcm4TlvDq8ikWAM", label: "Rachel · 女声" },
  { value: "pNInz6obpgDQGcFmaJgB", label: "Adam · 男声" },
  { value: "EXAVITQu4vr4xnSDxMaL", label: "Bella · 女声" },
  { value: "ErXwobaYiN019PkySvjV", label: "Antoni · 男声" },
  { value: "TxGE2FRQNgIUrvnN1JEA", label: "Josh · 青年男声" },
  { value: "VR6AewLTigWG4xSOukaG", label: "Arnold · 低沉男声" },
  { value: "yoZ06aMxZJJ28mfd3POQ", label: "Sam · 中性" },
];

const QWEN_TTS_VOICES: VoiceOption[] = [
  { value: "Cherry", label: "Cherry · 女声" },
  { value: "Serena", label: "Serena · 女声" },
  { value: "Ethan", label: "Ethan · 男声" },
  { value: "Chelsie", label: "Chelsie · 女声" },
];

const COSYVOICE_VOICES: VoiceOption[] = [
  { value: "longxiaochun", label: "龙小淳 · 女声" },
  { value: "longxiaoxia", label: "龙小夏 · 女声" },
  { value: "longxiaocheng", label: "龙小诚 · 男声" },
  { value: "longxiaobai", label: "龙小白 · 男声" },
  { value: "longlaotie", label: "龙老铁 · 东北男声" },
  { value: "longshu", label: "龙书 · 男声" },
  { value: "longshuo", label: "龙硕 · 男声" },
  { value: "longjing", label: "龙婧 · 女声" },
  { value: "longmiao", label: "龙妙 · 女声" },
  { value: "longyue", label: "龙悦 · 女声" },
  { value: "longyuan", label: "龙媛 · 女声" },
  { value: "longfei", label: "龙飞 · 男声" },
  { value: "longtong", label: "龙彤 · 童声" },
];

const MINIMAX_VOICES: VoiceOption[] = [
  { value: "male-qn-qingse", label: "青涩青年 · 男声" },
  { value: "male-qn-jingying", label: "精英青年 · 男声" },
  { value: "male-qn-badao", label: "霸道青年 · 男声" },
  { value: "female-shaonv", label: "少女 · 女声" },
  { value: "female-yujie", label: "御姐 · 女声" },
  { value: "female-chengshu", label: "成熟女性 · 女声" },
  { value: "female-tianmei", label: "甜美女性 · 女声" },
  { value: "presenter_male", label: "男性主持人" },
  { value: "presenter_female", label: "女性主持人" },
  { value: "audiobook_male_1", label: "有声书男声" },
  { value: "audiobook_female_1", label: "有声书女声" },
];

function catalogFor(provider: TtsProviderName, model: string): VoiceCatalog {
  const trimmed = model.trim();
  switch (provider) {
    case "edge":
      return {
        provider,
        model: trimmed || "edge-tts",
        voices: EDGE_VOICES,
        hint: "Edge TTS 中文音色；也可以直接输入其他 Edge 音色 ID。",
        allowCustom: true,
      };
    case "openai":
      return {
        provider,
        model: trimmed || "tts-1",
        voices: OPENAI_VOICES,
        hint: "OpenAI 兼容接口的常用音色；自建服务支持别的音色时可直接输入。",
        allowCustom: true,
      };
    case "elevenlabs":
      return {
        provider,
        model: trimmed || "eleven_multilingual_v2",
        voices: ELEVENLABS_VOICES,
        hint: "ElevenLabs 常用音色；账号里自建的声音可填 voice id。",
        allowCustom: true,
      };
    case "bailian": {
      if (/^qwen[\w.-]*tts/i.test(trimmed)) {
        return {
          provider,
          model: trimmed || "qwen-tts",
          voices: QWEN_TTS_VOICES,
          hint: "Qwen TTS 系列（qwen-tts / qwen3-tts-flash）官方音色；声音复刻得到的 voice id 也可直接填。",
          allowCustom: true,
        };
      }
      if (/^cosyvoice/i.test(trimmed)) {
        return {
          provider,
          model: trimmed || "cosyvoice-v3",
          voices: COSYVOICE_VOICES,
          hint: "CosyVoice 常用音色（v2 音色常带 _v2 后缀）；声音复刻得到的 voice id 直接填这里。",
          allowCustom: true,
        };
      }
      return {
        provider,
        model: trimmed || "MiniMax/speech-2.8-turbo",
        voices: MINIMAX_VOICES,
        hint: "百炼第三方模型（如 MiniMax/speech-2.8-turbo）的音色；以模型文档为准，可直接输入其他 id。",
        allowCustom: true,
      };
    }
    default:
      return {
        provider,
        model: trimmed,
        voices: [],
        hint: "当前供应商没有可选音色列表。",
        allowCustom: false,
      };
  }
}

/** ElevenLabs 有账号时优先拉取账号里的真实音色；失败就退回常用列表。 */
async function elevenLabsVoices(
  settings: TtsSettings,
  logger: Logger,
  fetchImpl: typeof fetch,
): Promise<VoiceOption[] | null> {
  if (!settings.apiKey) return null;
  const base = (settings.baseUrl?.trim() || "https://api.elevenlabs.io/v1").replace(/\/+$/, "");
  try {
    const response = await fetchImpl(`${base}/voices`, {
      headers: { "xi-api-key": settings.apiKey },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { voices?: Array<{ voice_id?: string; name?: string }> };
    const voices = (body.voices ?? [])
      .filter((voice) => voice.voice_id)
      .map((voice) => ({ value: String(voice.voice_id), label: String(voice.name ?? voice.voice_id) }));
    return voices.length ? voices : null;
  } catch (error) {
    logger.warn(`读取 ElevenLabs 音色失败，使用常用音色列表：${String(error)}`);
    return null;
  }
}

/** 是否是该供应商/模型之外、但属于我们内置音色库的旧音色（换供应商后残留）。 */
export function isStaleVoiceId(provider: TtsProviderName, model: string, voice: string): boolean {
  const current = catalogFor(provider, model);
  if (current.voices.some((item) => item.value === voice)) return false;
  for (const candidate of [
    ...EDGE_VOICES,
    ...OPENAI_VOICES,
    ...ELEVENLABS_VOICES,
    ...QWEN_TTS_VOICES,
    ...COSYVOICE_VOICES,
    ...MINIMAX_VOICES,
  ]) {
    if (candidate.value === voice) return true;
  }
  return false;
}

export async function voiceCatalog(
  settings: TtsSettings,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<VoiceCatalog> {
  const catalog = catalogFor(settings.provider, settings.model);
  if (settings.provider !== "elevenlabs") return catalog;
  const remote = await elevenLabsVoices(settings, logger, fetchImpl);
  return remote ? { ...catalog, voices: remote } : catalog;
}
