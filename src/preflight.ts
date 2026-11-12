import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.js";
import { resolveScriptProvider } from "./config.js";
import type { AppConfig, CastAsset, JobOptions } from "./types.js";
import type { Logger } from "./logger.js";
import { ensureDir, pathExists } from "./util/fs.js";
import { runFfmpeg, runFfprobe } from "./media/ffmpeg.js";
import { MAX_REFERENCE_BYTES } from "./videogen/http.js";

export const STORY_MAX_LENGTH = 6000;
const MAX_CAST_PER_JOB = 30;

export interface PreflightInput {
  config: AppConfig;
  topic: string;
  story?: string;
  options?: Pick<JobOptions, "videoGenEnabled" | "castIds">;
  /** 本片将使用的角色/道具设定。 */
  castAssets?: CastAsset[];
  /** 是否检查目录、ffmpeg/ffprobe 等运行环境；默认 true。 */
  checkEnvironment?: boolean;
  logger?: Logger;
}

interface EnvironmentCheck {
  ok: boolean;
  message?: string;
}

let environmentCheck: Promise<EnvironmentCheck> | undefined;

/** ffmpeg/ffprobe 只验证一次，避免每个任务重复启动进程。 */
function ensureMediaTools(): Promise<EnvironmentCheck> {
  environmentCheck ??= (async () => {
    try {
      await runFfmpeg(["-version"], { timeoutMs: 10_000, maxCapture: 4096 });
      await runFfprobe(["-version"], { timeoutMs: 10_000, maxCapture: 4096 });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: `ffmpeg/ffprobe 不可用：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  })();
  return environmentCheck;
}

/** 仅测试用：清空媒体工具探测缓存。 */
export function resetPreflightCache(): void {
  environmentCheck = undefined;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function pushIf(issues: string[], condition: boolean, message: string): void {
  if (condition) issues.push(message);
}

/**
 * 视频生成前检查：在调用任何付费模型之前，把配置、参考图、
 * 运行环境等能在本地发现的问题一次性告诉用户，避免先扣费再失败。
 * 只做本地检查，不会发起模型请求。
 */
export async function preflightVideoJob(input: PreflightInput): Promise<void> {
  const issues: string[] = [];
  const { config } = input;
  const story = input.story?.trim() ?? "";

  pushIf(issues, !input.topic.trim(), "主题不能为空");
  pushIf(issues, input.topic.trim().length > 200, "主题不能超过 200 个字符");
  pushIf(
    issues,
    story.length > STORY_MAX_LENGTH,
    `剧本/大纲不能超过 ${STORY_MAX_LENGTH} 个字符（当前 ${story.length}）`,
  );
  pushIf(
    issues,
    (input.options?.castIds?.length ?? 0) > MAX_CAST_PER_JOB,
    `单个视频最多选择 ${MAX_CAST_PER_JOB} 个角色/道具`,
  );

  // 脚本模型：auto 模式没有密钥会自动走离线模板，不算错误。
  if (resolveScriptProvider(config) === "openai") {
    pushIf(issues, !config.script.apiKey, "脚本模型已选择大模型，但还没有填写 API Key");
    pushIf(
      issues,
      Boolean(config.script.apiKey) && !isHttpUrl(config.script.baseUrl),
      `脚本接口地址无效：${config.script.baseUrl || "（空）"}`,
    );
  }

  // 配音。
  if (config.tts.provider === "openai") {
    pushIf(issues, !config.tts.apiKey, "配音供应商为 OpenAI 兼容接口，但还没有填写 API Key");
  }
  if (config.tts.provider !== "silent") {
    pushIf(issues, !config.tts.voice.trim(), "配音音色不能为空");
  }

  // 角色/道具参考图：在调用脚本模型之前就确认能读到，避免生成完才发现。
  const castAssets = input.castAssets ?? [];
  for (const asset of castAssets) {
    if (!asset.imageFile) continue;
    const file = path.join(config.castDir, asset.imageFile);
    const exists = await pathExists(file);
    pushIf(
      issues,
      !exists,
      `${asset.kind === "character" ? "角色" : "道具"}「${asset.name}」的参考图丢失：${asset.imageFile}`,
    );
    if (exists) {
      const stat = await fs.stat(file).catch(() => null);
      pushIf(issues, !stat || stat.size === 0, `参考图无法读取：${asset.imageFile}`);
      pushIf(
        issues,
        Boolean(stat) && stat!.size > MAX_REFERENCE_BYTES,
        `参考图超过 ${Math.round(MAX_REFERENCE_BYTES / 1024 / 1024)}MB，无法用于图生视频：${asset.imageFile}`,
      );
    }
  }

  // AI 画面生成（含图生视频）。
  const videoGenEnabled = input.options?.videoGenEnabled !== false;
  if (videoGenEnabled && config.videoGen.provider === "http") {
    pushIf(issues, !isHttpUrl(config.videoGen.baseUrl), "AI 画面生成的服务地址无效");
    pushIf(issues, !config.videoGen.model.trim(), "AI 画面生成的模型名称不能为空");
    pushIf(
      issues,
      !config.videoGen.submitPath.startsWith("/") ||
        !config.videoGen.pollPath.startsWith("/") ||
        !config.videoGen.pollPath.includes("{id}"),
      "AI 画面生成的提交/查询路径无效（查询路径必须包含 {id}）",
    );
    if (castAssets.length > 0 && !castAssets.some((asset) => asset.imageFile)) {
      input.logger?.warn("所选角色/道具都没有参考图，将按文生视频生成");
    }
  }

  if (input.checkEnvironment !== false) {
    const dirs: Array<[string, string]> = [
      [config.outputDir, "输出目录"],
      [config.workDir, "工作目录"],
      [config.libraryDir, "素材库目录"],
      [config.castDir, "角色库目录"],
      [config.cacheDir, "缓存目录"],
    ];
    for (const [dir, label] of dirs) {
      try {
        await ensureDir(dir);
        await fs.access(dir, fs.constants.W_OK);
      } catch {
        issues.push(`${label}不可写：${dir}`);
      }
    }
    const tools = await ensureMediaTools();
    if (!tools.ok && tools.message) issues.push(tools.message);
  }

  if (issues.length > 0) {
    throw new AppError(`任务未开始，请先处理：${issues.join("；")}`, {
      code: "PREFLIGHT_FAILED",
      status: 400,
    });
  }
}

/** 脚本预览前的轻量检查：同样在调用模型前拦截明显问题。 */
export async function preflightScript(input: {
  config: AppConfig;
  topic: string;
  story?: string;
  castAssets?: CastAsset[];
}): Promise<void> {
  await preflightVideoJob({
    config: input.config,
    topic: input.topic,
    story: input.story,
    castAssets: input.castAssets,
    options: { videoGenEnabled: false },
    checkEnvironment: false,
  });
}
