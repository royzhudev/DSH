import assert from "node:assert/strict";
import test from "node:test";

import { assignDialogueVoices, resolveSpeakerVoice } from "../../src/tts/voices.js";
import { OfflineScriptProvider } from "../../src/script/offline.js";
import { normalizeScript } from "../../src/script/parse.js";

test("对话音色：不同角色自动分到不同音色，且避开旁白音色", () => {
  const cast = [{ name: "林小满" }, { name: "客人" }, { name: "老周" }];
  const voices = assignDialogueVoices(["林小满", "客人", "老周"], cast, "zh-CN-YunxiNeural");
  const values = [...voices.values()];
  assert.equal(new Set(values).size, 3);
  assert.ok(values.every((voice) => voice !== "zh-CN-YunxiNeural"));
});

test("对话音色：角色库显式指定时优先，且每次生成结果稳定", () => {
  const cast = [{ name: "林小满", voice: "zh-CN-XiaomoNeural" }];
  assert.equal(resolveSpeakerVoice("林小满", cast, "zh-CN-YunxiNeural"), "zh-CN-XiaomoNeural");
  const first = assignDialogueVoices(["林小满", "客人"], cast, "zh-CN-YunxiNeural");
  const second = assignDialogueVoices(["林小满", "客人"], cast, "zh-CN-YunxiNeural");
  assert.deepEqual([...first.entries()], [...second.entries()]);
});

test("离线脚本：开启对话模式时输出人物台词，而不是第三人称旁白", async () => {
  const provider = new OfflineScriptProvider();
  const script = await provider.generate({
    topic: "外卖员被冤枉",
    targetDurationSec: 30,
    maxSegments: 4,
    availableTags: ["城市", "雨夜"],
    dialogue: true,
    cast: [
      { name: "林小满", kind: "character", description: "" },
      { name: "客人", kind: "character", description: "" },
    ],
  });
  assert.equal(script.mode, "dialogue");
  for (const segment of script.segments) {
    assert.ok(segment.lines && segment.lines.length >= 2, "每段应有至少两句台词");
    assert.ok(segment.lines!.every((line) => line.speaker && line.text));
    assert.match(segment.narration, /：/);
  }
  assert.deepEqual(
    script.segments[0]!.lines!.map((line) => line.speaker),
    ["林小满", "客人"],
  );
});

test("脚本解析：接受 lines 台词并回填 narration 与 cast", () => {
  const script = normalizeScript(
    {
      title: "对话测试",
      segments: [
        {
          lines: [
            { speaker: "林小满", text: "我没拿你的东西。" },
            { speaker: "客人", text: "那它是怎么消失的？" },
          ],
          keywords: ["咖啡馆"],
          scene: "咖啡馆，傍晚",
          shot: "中景，两人对峙",
        },
        {
          narration: "第三人称旁白兜底。",
          keywords: ["街道"],
        },
      ],
    },
    { provider: "test", topic: "对话测试", maxSegments: 6 },
  );
  assert.equal(script.segments[0]!.lines?.length, 2);
  assert.equal(script.segments[0]!.narration, "林小满：我没拿你的东西。 客人：那它是怎么消失的？");
  assert.deepEqual(script.segments[0]!.cast, ["林小满", "客人"]);
  assert.equal(script.segments[1]!.lines, undefined);
});

test("对话音色：按角色性别自动分配男声/女声", () => {
  const cast = [
    { name: "黄乐", description: "28 岁男性，酒吧老板", kind: "character" },
    { name: "林小满", description: "25 岁女性，齐肩短发", kind: "character" },
  ];
  const voices = assignDialogueVoices(["黄乐", "林小满"], cast, "zh-CN-XiaoxiaoNeural");
  const male = voices.get("黄乐")!;
  const female = voices.get("林小满")!;
  assert.ok(["zh-CN-YunxiNeural", "zh-CN-YunjianNeural", "zh-CN-YunyangNeural"].includes(male), `男角色分到女声：${male}`);
  assert.ok(["zh-CN-XiaoyiNeural", "zh-CN-XiaomoNeural"].includes(female), `女角色分到男声：${female}`);
  assert.notEqual(male, female);
});

test("对话音色：同一角色跨分镜保持同一个声音", async () => {
  const { OfflineScriptProvider } = await import("../../src/script/offline.js");
  const script = await new OfflineScriptProvider().generate({
    topic: "酒吧误会",
    targetDurationSec: 20,
    maxSegments: 4,
    availableTags: [],
    dialogue: true,
    cast: [
      { name: "黄乐", kind: "character", description: "28 岁男性" },
      { name: "林小满", kind: "character", description: "25 岁女性" },
    ],
  });
  const speakers = [
    ...new Set(script.segments.flatMap((segment) => (segment.lines ?? []).map((line) => line.speaker))),
  ];
  const cast = [
    { name: "黄乐", description: "28 岁男性" },
    { name: "林小满", description: "25 岁女性" },
  ];
  const voices = assignDialogueVoices(speakers, cast, "zh-CN-XiaoxiaoNeural");
  assert.ok(voices.has("黄乐") && voices.has("林小满"));
  assert.notEqual(voices.get("黄乐"), voices.get("林小满"));
});
