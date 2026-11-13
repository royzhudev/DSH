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

test("normalizeScript 保留场景、镜头与出场角色，并截断超长字段", () => {
  const script = normalizeScript(
    {
      title: "钟表店",
      segments: [
        {
          narration: "林小满抬头看了一眼门口。",
          scene: "老城区钟表店 · 黄昏",
          shot: "中景，缓慢推近",
          cast: ["林小满", "林小满", "旧怀表", "额外角色"],
          keywords: ["钟表店"],
        },
        {
          narration: "怀表在柜台里轻轻震动。",
          scene: "店" + "内".repeat(300),
          shot: "特写".repeat(300),
          cast: Array.from({ length: 12 }, (_, index) => `角色${index}`),
        },
      ],
    },
    { provider: "test", topic: "钟表店", maxSegments: 3 },
  );
  assert.equal(script.segments[0]!.scene, "老城区钟表店 · 黄昏");
  assert.equal(script.segments[0]!.shot, "中景，缓慢推近");
  assert.deepEqual(script.segments[0]!.cast, ["林小满", "旧怀表", "额外角色"]);
  assert.ok((script.segments[1]!.scene ?? "").length <= 200);
  assert.ok((script.segments[1]!.shot ?? "").length <= 400);
  assert.equal(script.segments[1]!.cast?.length, 10);
});

test("离线脚本在给定角色/剧本时保持出场设定", async () => {
  const provider = new OfflineScriptProvider();
  const script = await provider.generate({
    ...BASE_REQUEST,
    story: "林小满在钟表店遇到一位神秘客人。",
    cast: [
      { name: "林小满", kind: "character", description: "短发，米色风衣" },
      { name: "旧怀表", kind: "prop", description: "铜质，表盘有裂纹" },
    ],
  });
  const names = script.segments.flatMap((segment) => segment.cast ?? []);
  assert.ok(names.includes("林小满"), "离线脚本应保留角色");
  assert.ok(script.segments.every((segment) => typeof segment.scene === "string" && segment.scene));
  assert.ok(script.segments.every((segment) => typeof segment.shot === "string" && segment.shot));
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

test("normalizeScript 丢掉内容完全相同的分镜，避免同一个镜头反复播放", () => {
  const script = normalizeScript(
    {
      title: "酒局",
      segments: [
        { narration: "卖不动我自己吞。", scene: "包间，夜", shot: "中景，举杯" },
        { narration: "黄乐：那这杯酒，算我敬两位。", scene: "包间，夜", shot: "近景，黄乐" },
        { narration: "卖不动我自己吞。", scene: "包间，夜", shot: "中景，举杯" },
        { narration: "黄乐：那这杯酒，算我敬两位。", scene: "包间，夜", shot: "近景，黄乐" },
      ],
    },
    { provider: "test", topic: "酒局", maxSegments: 8 },
  );
  assert.deepEqual(
    script.segments.map((segment) => segment.narration),
    ["卖不动我自己吞。", "黄乐：那这杯酒，算我敬两位。"],
  );
  assert.deepEqual(
    script.segments.map((segment) => segment.id),
    [1, 2],
  );
});

test("normalizeScript 在去重后只剩一个分镜时给出明确报错", () => {
  assert.throws(
    () =>
      normalizeScript(
        {
          title: "重复",
          segments: [
            { narration: "同一句话。", scene: "同一场景", shot: "同一镜头" },
            { narration: "同一句话。", scene: "同一场景", shot: "同一镜头" },
            { narration: "同一句话。", scene: "同一场景", shot: "同一镜头" },
          ],
        },
        { provider: "test", topic: "重复", maxSegments: 8 },
      ),
    (error: unknown) => error instanceof AppError && error.code === "SCRIPT_DUPLICATED",
  );
});

test("normalizeScript 按念出来的内容判重：旁白一样就算不同场景也只留一条", () => {
  // 观众听到的是同一句话，场景/镜头换个说法也救不回来，必须在脚本层就丢掉。
  assert.throws(
    () =>
      normalizeScript(
        {
          title: "重复台词",
          segments: [
            { narration: "我不走。", scene: "客厅，白天", shot: "中景" },
            { narration: "我不走！", scene: "雨夜街头", shot: "特写" },
          ],
        },
        { provider: "test", topic: "重复台词", maxSegments: 8 },
      ),
    (error: unknown) => error instanceof AppError && error.code === "SCRIPT_DUPLICATED",
  );
});

test("normalizeScript 只丢掉重复的旁白，其余分镜照常保留并重排 id", () => {
  const script = normalizeScript(
    {
      title: "重复旁白",
      segments: [
        { narration: "合同里写着我陪。", scene: "包厢", shot: "中景" },
        { narration: "皮衣哥嘴硬心软。", scene: "包厢", shot: "近景" },
        { narration: "合同里写着我陪！", scene: "走廊", shot: "全景" },
        { narration: "这单，我认了。", scene: "包厢", shot: "特写" },
      ],
    },
    { provider: "test", topic: "重复旁白", maxSegments: 8 },
  );
  assert.deepEqual(
    script.segments.map((segment) => segment.narration),
    ["合同里写着我陪。", "皮衣哥嘴硬心软。", "这单，我认了。"],
  );
  assert.deepEqual(
    script.segments.map((segment) => segment.id),
    [1, 2, 3],
  );
});


test("脚本去重：台词相同、场景措辞不同的分镜只保留一条", () => {
  const script = normalizeScript(
    {
      title: "重复分镜",
      segments: [
        {
          lines: [
            { speaker: "黄乐", text: "卖不动我自己吞。" },
            { speaker: "客人", text: "那这杯酒，算我敬两位。" },
          ],
          scene: "酒吧，夜晚",
          shot: "中景",
        },
        {
          lines: [
            { speaker: "黄乐", text: "卖不动我自己吞。" },
            { speaker: "客人", text: "那这杯酒，算我敬两位。" },
          ],
          scene: "酒吧，夜里（换个说法）",
          shot: "近景",
        },
        {
          lines: [{ speaker: "黄乐", text: "那就再来一杯。" }],
          scene: "酒吧，夜晚",
          shot: "特写",
        },
      ],
    },
    { provider: "test", topic: "重复分镜", maxSegments: 6 },
  );
  assert.equal(script.segments.length, 2);
  assert.equal(script.droppedSegments, 1);
  assert.equal(script.segments[1]!.lines?.[0]?.text, "那就再来一杯。");
});

test("脚本去重：同一句台词不会在多个分镜里重复出现", () => {
  const script = normalizeScript(
    {
      title: "重复台词",
      segments: [
        {
          lines: [
            { speaker: "黄乐", text: "卖不动我自己吞。" },
            { speaker: "客人", text: "那这杯酒，算我敬两位。" },
          ],
        },
        {
          lines: [
            { speaker: "客人", text: "那这杯酒，算我敬两位。" },
            { speaker: "黄乐", text: "你先坐下慢慢说。" },
          ],
        },
        { lines: [{ speaker: "黄乐", text: "今晚这单我认了。" }] },
      ],
    },
    { provider: "test", topic: "重复台词", maxSegments: 8 },
  );
  const allLines = script.segments.flatMap((segment) => segment.lines?.map((line) => `${line.speaker}：${line.text}`) ?? []);
  assert.equal(new Set(allLines).size, allLines.length, `台词有重复：${allLines.join(" / ")}`);
  assert.equal(allLines.includes("客人：那这杯酒，算我敬两位。"), true);
  assert.equal(script.droppedSegments, undefined);
});
