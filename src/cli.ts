#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig, summarizeConfig, type DeepPartial } from "./config.js";
import { runPipeline } from "./pipeline.js";
import { MaterialLibrary } from "./materials/library.js";
import { createLogger } from "./logger.js";
import { startServer } from "./server/server.js";
import { AppError, toErrorMessage } from "./errors.js";
import type { AppConfig } from "./types.js";

const VERSION = "0.2.0";

const HELP = `视频创作智能体 MVP ${VERSION}

用法：
  video-agent create --topic "主题" [选项]
  video-agent materials add <文件...> [--tags 城市,夜景]
  video-agent materials list [--json]
  video-agent serve [--port 8787] [--host 127.0.0.1]   # 启动网页控制台与 API

create 选项：
  -t, --topic <主题>     视频主题（必填）
  -c, --config <路径>    配置文件，默认 ./video-agent.config.json
      --out <目录>       成片输出目录
      --offline          使用离线脚本模板（不调用大模型）
      --silent           使用静音占位配音（仅演示/测试）
      --voice <音色>     覆盖 TTS 音色，如 zh-CN-XiaoxiaoNeural
      --story <文本>     剧本/大纲，分镜会按剧本生成
      --cast <id,id>     使用角色库中的角色/道具 id（默认全部）
      --dialogue         人物对话模式：分镜写成多角色台词，每个角色用不同音色
      --width <像素>     视频宽度，默认 1080
      --height <像素>    视频高度，默认 1920
      --json             以 JSON 输出结果

materials 选项：
      --tags <标签>      逗号分隔的素材标签
      --json             以 JSON 输出结果

通用选项：
      --verbose          输出调试日志
  -h, --help             显示帮助
  -v, --version          显示版本

环境变量：见 .env.example 与 README.md
`;

function parseNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError(`${name} 必须是数字：${value}`, { code: "INVALID_ARGUMENT", status: 400 });
  }
  return parsed;
}

function buildConfig(values: Record<string, string | boolean | undefined>): AppConfig {
  const overrides: DeepPartial<AppConfig> = {};
  if (values.out) overrides.outputDir = String(values.out);
  if (values.offline) overrides.script = { provider: "offline" };
  if (values.silent) overrides.tts = { provider: "silent" };
  if (values.voice) overrides.tts = { ...overrides.tts, voice: String(values.voice) };
  const width = parseNumber(values.width as string | undefined, "--width");
  const height = parseNumber(values.height as string | undefined, "--height");
  if (width !== undefined || height !== undefined) {
    overrides.video = { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
  }
  if (values.port !== undefined) overrides.server = { port: parseNumber(values.port as string, "--port") };
  if (values.host !== undefined) overrides.server = { ...overrides.server, host: String(values.host) };
  return loadConfig({ configPath: values.config as string | undefined, overrides });
}

function printProgress(progress: { stage: string; percent: number; message: string }): void {
  process.stderr.write(`[${String(progress.percent).padStart(3)}%] ${progress.message}\n`);
}

async function commandCreate(
  values: Record<string, string | boolean | undefined>,
  positionals: string[],
): Promise<void> {
  const topic = (values.topic as string | undefined) ?? positionals[0];
  if (!topic || !topic.trim()) {
    throw new AppError('请提供主题，例如：video-agent create --topic "城市夜景"', {
      code: "INVALID_ARGUMENT",
      status: 400,
    });
  }
  const logger = createLogger({ level: values.verbose ? "debug" : "info" });
  const config = buildConfig(values);
  const summary = summarizeConfig(config);
  logger.info(
    `脚本=${summary.scriptProvider} 配音=${summary.ttsProvider} 尺寸=${summary.video.width}x${summary.video.height}`,
  );
  const story = typeof values.story === "string" ? values.story.trim() : undefined;
  const castIds =
    typeof values.cast === "string"
      ? values.cast
          .split(/[,，]/)
          .map((id) => id.trim())
          .filter(Boolean)
      : undefined;
  const result = await runPipeline({
    topic,
    config,
    logger,
    onProgress: printProgress,
    ...(story ? { story } : {}),
    ...(castIds && castIds.length > 0 ? { castIds } : {}),
    ...(values.dialogue ? { dialogue: true } : {}),
  });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`\n成片：${result.videoPath}\n`);
  process.stdout.write(`字幕：${result.srtPath}\n`);
  process.stdout.write(`脚本：${result.scriptPath}\n`);
  process.stdout.write(`时长：${result.durationSec.toFixed(1)}s，${result.segments.length} 个分镜\n`);
}

async function commandMaterials(
  values: Record<string, string | boolean | undefined>,
  positionals: string[],
): Promise<void> {
  const logger = createLogger({ level: values.verbose ? "debug" : "info" });
  const config = buildConfig(values);
  const library = new MaterialLibrary(config.libraryDir, logger);
  const action = positionals[0] ?? "list";

  if (action === "add") {
    const files = positionals.slice(1);
    if (files.length === 0) {
      throw new AppError("请提供要添加的素材文件", { code: "INVALID_ARGUMENT", status: 400 });
    }
    const tags = String(values.tags ?? "")
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    const added = [];
    for (const file of files) {
      added.push(await library.add(file, { tags }));
    }
    if (values.json) {
      process.stdout.write(`${JSON.stringify(added, null, 2)}\n`);
    } else {
      for (const material of added) {
        process.stdout.write(
          `已添加：${material.file}（${material.type}，${material.tags.join("、") || "无标签"}）\n`,
        );
      }
    }
    return;
  }

  if (action === "list") {
    const materials = await library.list();
    if (values.json) {
      process.stdout.write(`${JSON.stringify(materials, null, 2)}\n`);
      return;
    }
    if (materials.length === 0) {
      process.stdout.write(`素材库为空：${config.libraryDir}\n`);
      return;
    }
    process.stdout.write(`素材库：${config.libraryDir}\n`);
    for (const material of materials) {
      const duration = material.durationSec ? `${material.durationSec.toFixed(1)}s` : "-";
      process.stdout.write(
        `  ${material.id}  ${material.type.padEnd(5)}  ${duration.padEnd(6)}  [${material.tags.join(",")}]  ${material.file}\n`,
      );
    }
    return;
  }

  throw new AppError(`未知的 materials 子命令：${action}`, { code: "INVALID_ARGUMENT", status: 400 });
}

async function commandServe(values: Record<string, string | boolean | undefined>): Promise<void> {
  const logger = createLogger({ level: values.verbose ? "debug" : "info" });
  const config = buildConfig(values);
  const app = await startServer(config, logger);
  process.stdout.write(`video-agent 服务已启动：${app.url}\n`);
  process.stdout.write(`网页控制台：${app.url}/\n`);
  process.stdout.write(`接口说明：${app.url}/api\n`);
  const shutdown = async () => {
    process.stdout.write("\n正在关闭服务…\n");
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      topic: { type: "string", short: "t" },
      config: { type: "string", short: "c" },
      out: { type: "string" },
      offline: { type: "boolean" },
      silent: { type: "boolean" },
      voice: { type: "string" },
      width: { type: "string" },
      height: { type: "string" },
      story: { type: "string" },
      cast: { type: "string" },
      dialogue: { type: "boolean" },
      json: { type: "boolean" },
      tags: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const command = parsed.positionals[0] ?? "help";
  const rest = parsed.positionals.slice(1);
  switch (command) {
    case "create":
      await commandCreate(parsed.values, rest);
      return;
    case "materials":
      await commandMaterials(parsed.values, rest);
      return;
    case "serve":
      await commandServe(parsed.values);
      return;
    case "help":
    default:
      process.stdout.write(HELP);
      if (command !== "help") {
        throw new AppError(`未知命令：${command}`, { code: "INVALID_ARGUMENT", status: 400 });
      }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof AppError ? error.message : toErrorMessage(error);
  process.stderr.write(`错误：${message}\n`);
  if (process.env.DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});