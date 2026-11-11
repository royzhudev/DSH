import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { silentLogger } from "../../src/logger.js";
import { OfflineScriptProvider } from "../../src/script/offline.js";
import { OpenAiScriptProvider } from "../../src/script/openai.js";
import {
  extractJsonObject,
  normalizeScript,
  parseScriptJson,
} from "../../src/script/parse.js";
import { AppError } from "../../src/errors.js";
import type { ScriptSettings } from "../../src/types.js";

const BASE_REQUEST = {
  topic: "城市夜景",
  targetDurationSec: 30,
  maxSegments: 5,
  availableTags: ["城市", "夜景", "灯光"],
};

test("extractJsonObject 去掉代码围栏和前后说明", () => {
  const raw = '下面是脚本：\n```json\n{"title":"T","segments":[]}\n```\n希望有帮助';
  assert.equal(extractJsonObject(raw), '{"title":"T","segments":[]}');
  assert.deepEqual(parseScriptJson(raw), { title: "T", segments: [] });
});

test("normalizeScript 清理序号、去重关键词并重排 id", () => {
  const script = normalizeScript(
    {
      title: "  城市夜景  ",
      summary: " 一句话 ",
      segments: [
        { narration: "1. 第一段口播。", keywords: ["城市", "城市", "夜景"] },
        { narration: "第二段口播。", keywords: ["灯光"] },
      ],
    },
    { provider: "test", topic: "城市夜景", maxSegments: 5 },
  );
  assert.equal(script.title, "城市夜景");
  assert.equal(script.segments.length, 2);
  assert.equal(script.segments[0]!.narration, "第一段口播。");
  assert.deepEqual(script.segments[0]!.keywords, ["城市", "夜景"]);
  assert.equal(script.segments[1]!.id, 2);
});

test("normalizeScript 拆分过长口播并限制分镜数", () => {
  const longNarration = "这是一段很长的口播。".repeat(12);
  const script = normalizeScript(
    {
      title: "长脚本",
      segments: [
        { narration: longNarration, keywords: ["城市"] },
        { narration: "第二段。", keywords: ["夜景"] },
      ],
    },
    { provider: "test", topic: "城市", maxSegments: 3 },
  );
  assert.ok(script.segments.length >= 2);
  assert.ok(script.segments.length <= 3);
  for (const segment of script.segments) assert.ok(segment.narration.length <= 110);
});

test("normalizeScript 拒绝无效结构", () => {
  assert.throws(
    () => normalizeScript({ title: "只有一段", segments: [{ narration: "唯一一段" }] }, {
      provider: "test",
      topic: "主题",
      maxSegments: 5,
    }),
    (error: unknown) => error instanceof AppError && error.code === "SCRIPT_INVALID",
  );
});

test("离线脚本优先使用素材库标签作为关键词", async () => {
  const provider = new OfflineScriptProvider();
  const script = await provider.generate(BASE_REQUEST);
  assert.equal(script.provider, "offline");
  assert.ok(script.segments.length >= 3);
  assert.ok(script.segments[0]!.keywords.includes("城市"));
  assert.ok(script.title.includes("城市夜景"));
});

test("OpenAI 脚本供应商在 response_format 不受支持时自动重试", async () => {
  const settings: ScriptSettings = {
    ...DEFAULT_CONFIG.script,
    provider: "openai",
    apiKey: "sk-test",
    baseUrl: "https://example.test/v1",
  };
  let calls = 0;
  let secondBody: Record<string, unknown> = {};
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (calls === 1) {
      assert.ok("response_format" in body);
      return new Response('{"error":"response_format is not supported"}', { status: 400 });
    }
    secondBody = body;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '{"title":"兼容标题","segments":[{"narration":"第一段。","keywords":[]},{"narration":"第二段。","keywords":[]}]}',
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const provider = new OpenAiScriptProvider({
    config: settings,
    logger: silentLogger,
    fetchImpl: fakeFetch,
  });
  const script = await provider.generate(BASE_REQUEST);
  assert.equal(calls, 2);
  assert.equal("response_format" in secondBody, false);
  assert.equal(script.title, "兼容标题");
});

test("OpenAI 兼容脚本供应商解析模型返回的 JSON", async () => {
  const settings: ScriptSettings = {
    ...DEFAULT_CONFIG.script,
    provider: "openai",
    apiKey: "sk-test",
    baseUrl: "https://example.test/v1",
  };
  let calledUrl = "";
  let calledBody: Record<string, unknown> = {};
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calledUrl = String(url);
    calledBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '```json\n{"title":"模型标题","segments":[{"narration":"第一段。","keywords":["城市"]},{"narration":"第二段。","keywords":["夜景"]}]}\n```',
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const provider = new OpenAiScriptProvider({
    config: settings,
    logger: silentLogger,
    fetchImpl: fakeFetch,
  });
  const script = await provider.generate(BASE_REQUEST);
  assert.equal(calledUrl, "https://example.test/v1/chat/completions");
  assert.equal(calledBody.model, settings.model);
  assert.equal(script.provider, "openai");
  assert.equal(script.title, "模型标题");
  assert.equal(script.segments.length, 2);
});