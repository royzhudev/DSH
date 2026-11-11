export type ScriptProviderName = "auto" | "openai" | "offline";
export type TtsProviderName = "edge" | "openai" | "silent";

/** 一个分镜：口播文案 + 画面检索关键词。 */
export interface ScriptSegment {
  id: number;
  narration: string;
  keywords: string[];
  durationHintSec?: number;
}

/** 大模型或离线模板生成的完整脚本。 */
export interface Script {
  title: string;
  summary: string;
  segments: ScriptSegment[];
  provider: string;
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
  tts: TtsResult;
  durationSec: number;
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
  material: Pick<Material, "id" | "title" | "type" | "file"> | null;
  voice: string;
  ttsProvider: TtsProviderName;
  durationSec: number;
  startSec: number;
  subtitleCues: number;
}

export interface PipelineResult {
  jobId: string;
  topic: string;
  createdAt: string;
  finishedAt: string;
  durationSec: number;
  videoPath: string;
  srtPath: string;
  scriptPath: string;
  resultPath: string;
  script: Script;
  segments: SegmentResult[];
  video: VideoInfo;
}

export type JobStage =
  | "queued"
  | "script"
  | "materials"
  | "tts"
  | "render"
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

export interface ServerSettings {
  host: string;
  port: number;
  maxUploadBytes: number;
}

export interface AppConfig {
  outputDir: string;
  workDir: string;
  libraryDir: string;
  cacheDir: string;
  video: VideoSettings;
  script: ScriptSettings;
  tts: TtsSettings;
  subtitles: SubtitleStyle;
  materials: MaterialSettings;
  server: ServerSettings;
}

export interface ScriptRequest {
  topic: string;
  targetDurationSec: number;
  maxSegments: number;
  availableTags: string[];
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