import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { runPipeline } from "../../src/pipeline.js";
import { silentLogger } from "../../src/logger.js";
import { generateSilentAudio, probeMedia } from "../../src/media/ffmpeg.js";
import { makeTempDir, makeTestConfig } from "../helpers.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

test(
  "OpenAI 兼容的脚本与配音 HTTP 接口可完整跑通",
  { timeout: 180_000 },
  async (t) => {
    const dir = await makeTempDir();
    const audioFile = path.join(dir, "mock-tts.mp3");
    await generateSilentAudio(audioFile, 1.5);
    const audioBuffer = await fs.readFile(audioFile);
    const probe = await probeMedia(audioFile);
    assert.ok((probe.durationSec ?? 0) > 1);

    let chatCalls = 0;
    let speechCalls = 0;
    const mockServer = http.createServer((req, res) => {
      if (req.url === "/v1/chat/completions") {
        chatCalls += 1;
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const parsed = JSON.parse(body) as { model?: string; messages?: unknown[] };
          assert.equal(parsed.model, "mock-chat");
          assert.ok(Array.isArray(parsed.messages));
          const content = JSON.stringify({
            title: "模拟模型脚本",
            summary: "由本地 mock 服务生成",
            segments: [
              { narration: "第一段模拟口播。", keywords: ["城市"] },
              { narration: "第二段模拟口播。", keywords: ["夜景"] },
              { narration: "第三段模拟口播。", keywords: ["灯光"] },
            ],
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        });
        return;
      }
      if (req.url === "/v1/audio/speech") {
        speechCalls += 1;
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "audio/mpeg" });
          res.end(audioBuffer);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const port = await listen(mockServer);
    t.after(async () => {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      mockServer.closeAllConnections?.();
      await fs.rm(dir, { recursive: true, force: true });
    });

    const config = makeTestConfig(dir, {
      script: {
        provider: "openai",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test-key",
        model: "mock-chat",
        fallbackToOffline: false,
      },
      tts: {
        provider: "openai",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "test-key",
        model: "mock-tts",
        voice: "alloy",
        fallback: "error",
      },
    });

    const result = await runPipeline({ topic: "城市夜景", config, logger: silentLogger });
    assert.equal(chatCalls, 1);
    assert.equal(speechCalls, result.segments.length);
    assert.equal(result.script.provider, "openai");
    assert.equal(result.script.title, "模拟模型脚本");
    assert.ok(result.segments.every((segment) => segment.ttsProvider === "openai"));
    assert.ok(result.durationSec > 3);
  },
);