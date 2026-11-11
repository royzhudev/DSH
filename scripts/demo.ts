import { loadConfig } from "../src/config.js";
import { runPipeline } from "../src/pipeline.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "info" });
const config = loadConfig({
  cwd: process.cwd(),
  overrides: {
    script: { provider: "offline" },
    tts: { provider: "edge" },
    video: { width: 720, height: 1280 },
    outputDir: "./output",
  },
});
const topic = process.env.DEMO_TOPIC?.trim() || "城市夜景";

const result = await runPipeline({
  topic,
  config,
  logger,
  onProgress: (progress) => {
    process.stderr.write(`[${String(progress.percent).padStart(3)}%] ${progress.message}\n`);
  },
});

process.stdout.write(`\n演示成片：${result.videoPath}\n`);
process.stdout.write(`字幕：${result.srtPath}\n`);
process.stdout.write(`时长：${result.durationSec.toFixed(1)}s，${result.segments.length} 个分镜\n`);
process.stdout.write(`脚本供应商：${result.script.provider}，配音：${result.segments[0]?.ttsProvider ?? "-"}\n`);