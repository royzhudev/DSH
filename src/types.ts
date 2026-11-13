export type ScriptProviderName = "auto" | "openai" | "offline";
export type TtsProviderName = "edge" | "openai" | "silent";
/** 画面来源：none 只使用素材库；http 调用可配置的 AI 视频生成接口。 */
export type VideoGenProviderName = "none" | "http";

/** 角色或道具：短剧里需要跨镜头保持一致的主体。 */
export type CastKind = "character" | "prop";

/** 角色库中的一条设定：名称 + 外观描述 + 可选参考图。 */
export interface CastAsset {
  id: string;
  kind: CastKind;
  name: string;
  /** 外观设定，会写入每个分镜的画面提示词，保证跨镜头一致。 */
  description: string;
  /** 参考图相对 castDir 的文件名；没有参考图时不参与图生视频。 */
  imageFile?: string;
  /** 对话模式下给这个角色配音的音色（Edge voice id 等）；为空时自动分配。 */
  voice?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  createdAt: string;
  updatedAt: string;
}

/** 一个分镜：口播文案 + 画面检索关键词 + 短剧镜头信息。 */
/** 角色台词：短剧的对话单元，按说话人分配不同配音音色。 */
export interface DialogueLine {
  speaker: string;
  text: string;
}

export interface ScriptSegment {
  id: number;
  /** 画外旁白/整段文案；对话模式下由 lines 拼接而来，用于字幕与画面提示。 */
  narration: string;
  keywords: string[];
  durationHintSec?: number;
  /** 场景（地点/时间/光线），同一场景的多个镜头保持一致。 */
  scene?: string;
  /** 镜头描述：景别、人物动作、构图，用于生成画面提示词。 */
  shot?: string;
  /** 出场角色/道具名称，对应角色库中的名字。 */
  cast?: string[];
  /** 对话模式的台词，按顺序朗读，每个说话人可使用不同音色。 */
  lines?: DialogueLine[];
}

/** 大模型或离线模板生成的完整脚本。 */
export interface Script {
  title: string;
  summary: string;
  segments: ScriptSegment[];
  provider: string;
  /** dialogue：人物对话（多音色）；narration：第三人称旁白。 */
  mode?: "dialogue" | "narration";
  /** 脚本里被判定为重复而丢掉的分镜数量（台词/旁白相同）。 */
  droppedSegments?: number;
}

export type MaterialType = "video" | "image";

/** 本地素材库中的一条素材。 */
export interface Material {
  id: string;
  /** 相对素材库根目录的文件名。 */
  file: string;
  type: MaterialType;
  title: string;
  tags: string[];
  durationSec?: number;
  width?: number;
  height?: number;
  sizeBytes: number;
  addedAt: string;
}

/** Edge TTS 返回的句级时间戳，用于字幕对齐。 */
export interface TtsSentence {
  text: string;
  startSec: number;
  endSec: number;
}

export interface TtsResult {
  provider: TtsProviderName;
  voice: string;
  audioPath: string;
  durationSec: number;
  sentences?: TtsSentence[];
  cached: boolean;
}

export interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface SegmentPlan {
  index: number;
  segment: ScriptSegment;
  material: Material | null;
  /** AI 生成的分镜画面；存在时优先于素材。 */
  generated?: GeneratedClip;
  /** 该分镜解析出的角色/道具设定。 */
  cast: CastAsset[];
  /** 是否用参考图做了图生视频。 */
  imageToVideo?: boolean;
  tts: TtsResult;
  durationSec: number;
  /** 对话模式下的台词与音色分配。 */
  lines?: Array<DialogueLine & { voice: string; durationSec: number }>;
  /** 相对当前分镜的本地时间轴。 */
  cues: SubtitleCue[];
  /** 成片时间轴上的绝对开始时间，拼接后写入 SRT。 */
  startSec: number;
}

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
}

export interface SegmentResult {
  index: number;
  narration: string;
  keywords: string[];
  scene?: string;
  shot?: string;
  /** 本分镜出场的角色/道具。 */
  cast?: Array<Pick<CastAsset, "id" | "name" | "kind">>;
  material: Pick<Material, "id" | "title" | "type" | "file"> | null;
  voice: string;
  ttsProvider: TtsProviderName;
  /** 该分镜是否做过口型同步（仅对话分镜会记录）。 */
  lipsync?: "synced" | "unsynced" | "skipped";
  /** 对话模式：本分镜的台词、说话人与音色。 */
  lines?: Array<DialogueLine & { voice: string; durationSec: number }>;
  durationSec: number;
  startSec: number;
  subtitleCues: number;
  /** 该分镜画面来源：素材库命中、AI 生成或渐变背景。 */
  source: "material" | "generated" | "background";
  /** AI 画面是否使用了角色/道具参考图（图生视频）。 */
  imageToVideo?: boolean;
  generated?: {
    provider: string;
    model: string;
  };
}

export interface PipelineResult {
  jobId: string;
  topic: string;
  /** 用户提供的剧本/大纲（如果有）。 */
  story?: string;
  createdAt: string;
  finishedAt: string;
  durationSec: number;
  videoPath: string;
  posterPath?: string;
  srtPath: string;
  scriptPath: string;
  resultPath: string;
  script: Script;
  /** 本片使用的角色/道具设定。 */
  cast: Array<Pick<CastAsset, "id" | "name" | "kind" | "description" | "imageFile">>;
  segments: SegmentResult[];
  /** 生成过程中不致命、但需要告知用户的问题（如画面生成失败已回退）。 */
  warnings?: string[];
  video: VideoInfo;
}

export type JobStage =
  | "queued"
  | "preflight"
  | "script"
  | "materials"
  | "tts"
  | "videogen"
  | "render"
  | "lipsync"
  | "concat"
  | "done";

export interface JobProgress {
  stage: JobStage;
  percent: number;
  message: string;
}

export type ProgressReporter = (progress: JobProgress) => void;

export interface SubtitleStyle {
  enabled: boolean;
  fontFamily: string;
  fontSize: number;
  maxCharsPerLine: number;
  maxLines: number;
  marginV: number;
  primaryColor: string;
  outlineColor: string;
  outline: number;
  shadow: number;
  bold: boolean;
}

export interface VideoSettings {
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
  transition: "fade";
  transitionDurationSec: number;
  minSegmentSec: number;
  tailPaddingSec: number;
}

export interface ScriptSettings {
  provider: ScriptProviderName;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature: number;
  targetDurationSec: number;
  maxSegments: number;
  timeoutMs: number;
  fallbackToOffline: boolean;
}

export interface TtsSettings {
  provider: TtsProviderName;
  voice: string;
  rate: number;
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  fallback: "silent" | "error";
  cache: boolean;
}

export interface MaterialSettings {
  allowUnmatched: boolean;
}

/**
 * 可选的 AI 画面生成。provider 为 http 时，按下方约定调用用户配置的
 * 文生视频 / 图生视频服务，生成的分镜画面会替代素材匹配结果。
 */
/** 口型同步（lip-sync）设置：默认接阿里云百炼 VideoRetalk。 */
export interface LipsyncSettings {
  provider: "none" | "dashscope";
  baseUrl: string;
  apiKey?: string;
  /** 模型名，百炼为 videoretalk（仅华北 2 北京地域）。 */
  model: string;
  timeoutMs: number;
  pollIntervalMs: number;
  /** 口型失败时是否保留未对口型的片段继续成片。 */
  fallbackToUnsynced: boolean;
}

export interface LipsyncRequest {
  /** 已渲染的分镜视频（本地路径）。 */
  videoFile: string;
  /** 该分镜的配音音轨（本地路径）。 */
  audioFile: string;
}

export interface LipsyncResult {
  provider: string;
  model: string;
  file: string;
  durationSec: number;
}

export interface LipsyncProvider {
  readonly name: string;
  sync(request: LipsyncRequest, outputDir: string, signal?: AbortSignal): Promise<LipsyncResult>;
}

export interface VideoGenSettings {
  provider: VideoGenProviderName;
  baseUrl: string;
  /**
   * 接口协议：auto 按服务地址判断（DashScope 用 dashscope，其他用 generic）。
   * dashscope = 阿里百炼异步视频接口（提交带 X-DashScope-Async，任务在 output.task_id）。
   */
  protocol: "auto" | "dashscope" | "generic";
  apiKey?: string;
  model: string;
  /** 提交任务路径，默认 /v1/videos/generations。 */
  submitPath: string;
  /** 查询任务路径模板，{id} 会替换为任务 ID。 */
  pollPath: string;
  pollIntervalMs: number;
  timeoutMs: number;
  /** 每个分镜请求生成的视频时长。 */
  clipDurationSec: number;
  /**
   * 成片地址在查询响应里的点号路径（如 data.output.video_url）。
   * 留空时按常见字段自动识别；配置后没取到地址会回退自动识别。
   */
  resultPath: string;
  /** 生成失败时是否回退到素材库/渐变背景。 */
  fallbackToMaterials: boolean;
}

/** 抖音开放平台应用配置；clientKey/clientSecret 需在开放平台申请。 */
export interface DouyinSettings {
  clientKey: string;
  clientSecret?: string;
  /** 为空时使用 http://<host>:<port>/api/douyin/callback。 */
  redirectUri: string;
  scope: string;
  apiBaseUrl: string;
}

export interface ServerSettings {
  host: string;
  port: number;
  maxUploadBytes: number;
}

export interface AppConfig {
  outputDir: string;
  workDir: string;
  libraryDir: string;
  /** 角色/道具参考图与设定索引目录。 */
  castDir: string;
  cacheDir: string;
  /** 网页设置持久化文件；由 loadConfig 解析为绝对路径。 */
  settingsFile: string;
  video: VideoSettings;
  script: ScriptSettings;
  tts: TtsSettings;
  subtitles: SubtitleStyle;
  materials: MaterialSettings;
  videoGen: VideoGenSettings;
  lipsync: LipsyncSettings;
  douyin: DouyinSettings;
  server: ServerSettings;
}

/** 单次任务可覆盖的创作参数，不影响全局设置。 */
export interface JobOptions {
  targetDurationSec?: number;
  maxSegments?: number;
  ttsProvider?: TtsProviderName;
  voice?: string;
  /** 对话模式：分镜按人物台词生成，并按说话人分配音色。 */
  dialogue?: boolean;
  subtitlesEnabled?: boolean;
  videoGenEnabled?: boolean;
  allowUnmatched?: boolean;
  /** 剧本或大纲文本；为空时只按主题创作。 */
  story?: string;
  /** 本片使用的角色/道具 id；未提供表示使用角色库全部设定，空数组表示不使用。 */
  castIds?: string[];
}

export interface ScriptRequest {
  topic: string;
  targetDurationSec: number;
  maxSegments: number;
  availableTags: string[];
  /** 用户提供的剧本/大纲，生成分镜时必须遵循。 */
  story?: string;
  /** 可选的角色/道具设定，用于安排出场并保持外观一致。 */
  cast?: Array<Pick<CastAsset, "name" | "kind" | "description">>;
  /** 生成人物对话（多角色台词）而不是第三人称旁白。 */
  dialogue?: boolean;
}

export interface ScriptProvider {
  readonly name: string;
  generate(request: ScriptRequest, signal?: AbortSignal): Promise<Script>;
}

export interface TtsRequest {
  text: string;
  cacheKey: string;
}

export interface TtsProvider {
  readonly name: TtsProviderName;
  readonly voice: string;
  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsResult>;
}
export interface VideoGenReferenceImage {
  role: CastKind;
  name: string;
  /** 本地参考图绝对路径。 */
  file: string;
}

export interface VideoGenRequest {
  prompt: string;
  durationSec: number;
  /** 图生视频的首帧/主参考图（本地路径）；为空时按文生视频处理。 */
  image?: string;
  /** 角色/道具参考图，按出场顺序排列。 */
  references?: VideoGenReferenceImage[];
}

export interface GeneratedClip {
  /** 生成视频的本地绝对路径。 */
  file: string;
  durationSec: number;
  provider: string;
  model: string;
}

export interface VideoGenProvider {
  readonly name: string;
  readonly model: string;
  generate(request: VideoGenRequest, outputDir: string, signal?: AbortSignal): Promise<GeneratedClip>;
}

/** 抖音授权令牌；持久化在 .cache/douyin-token.json，权限 0600。 */
export interface DouyinToken {
  accessToken: string;
  refreshToken: string;
  openId: string;
  scope: string;
  expiresAt: string;
  refreshExpiresAt?: string;
  nickname?: string;
  avatar?: string;
  updatedAt: string;
}

export interface PublishRecord {
  id: string;
  jobId: string;
  topic: string;
  text: string;
  itemId: string;
  videoId: string;
  coverTsp?: number;
  createdAt: string;
}
