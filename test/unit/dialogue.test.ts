import assert from "node:assert/strict";
import test from "node:test";

import { mergeDialogueTurns } from "../../src/pipeline.js";
import {
  assignDialogueVoices,
  OPENAI_VOICE_POOL,
  voiceStyleFor,
  inferVoiceAge,
  inferVoiceGender,
  resolveSpeakerVoice,
  voicePitchFor,
  voiceRateFor,
  voiceVolumeFor,
} from "../../src/tts/voices.js";
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

test("对话音色：按人物设定的性别挑音色，不会给大叔配少女音", () => {
  const female = resolveSpeakerVoice(
    "林小满",
    [{ name: "林小满", description: "25 岁女性，齐肩短发，米色风衣" }],
    "zh-CN-YunxiNeural",
  );
  const male = resolveSpeakerVoice(
    "老周",
    [{ name: "老周", description: "45 岁男性，寸头，皮夹克，声音低沉" }],
    "zh-CN-XiaoxiaoNeural",
  );
  assert.match(female, /Xiao/);
  assert.doesNotMatch(female, /Yun/);
  assert.match(male, /Yun/);
  assert.doesNotMatch(male, /Xiao/);
});

test("对话音色：从设定里读不出性别时退回整个音色池，仍保持稳定", () => {
  const cast = [{ name: "神秘人", description: "戴着兜帽，看不出年纪" }];
  const first = resolveSpeakerVoice("神秘人", cast, "zh-CN-YunxiNeural");
  const second = resolveSpeakerVoice("神秘人", cast, "zh-CN-YunxiNeural");
  assert.equal(first, second);
  assert.notEqual(first, "zh-CN-YunxiNeural");
});

test("对话音色：能从设定里读出年龄段，并据此微调语速", () => {
  assert.equal(inferVoiceAge("25 岁女性"), "young");
  assert.equal(inferVoiceAge("40 岁男性，公司经理"), "middle");
  assert.equal(inferVoiceAge("68 岁的退休教师"), "old");
  assert.equal(inferVoiceAge("看不出年纪"), "unknown");
  assert.ok(voiceRateFor("68 岁的退休教师", 1) < 1);
  assert.ok(voiceRateFor("25 岁女性", 1) > 1);
  assert.equal(voiceRateFor("看不出年纪", 1), 1);
  assert.equal(inferVoiceGender("她推门进来"), "female");
  assert.equal(inferVoiceGender("他推门进来"), "male");
  assert.equal(inferVoiceGender("推门进来"), "unknown");
});


test("对话语气：音高按年龄微调，音量只跟着台词强度变", () => {
  assert.equal(voicePitchFor("70 岁的退休教师"), "-4Hz");
  assert.equal(voicePitchFor("20 岁女大学生"), "+2Hz");
  assert.equal(voicePitchFor("看不出年纪的人"), "0Hz");
  assert.equal(voiceVolumeFor("30 岁男性", "你站住！"), 6);
  assert.equal(voiceVolumeFor("30 岁男性", "别出声，跟我来。"), -4);
  assert.equal(voiceVolumeFor("30 岁男性", "我们走吧。"), 0);
});

test("对话音色：OpenAI 兼容 TTS 用同一套男女声池，并按角色写表演提示", () => {
  const cast = [
    { name: "黄乐", description: "45 岁男性，酒吧老板，说话沉稳" },
    { name: "林小满", description: "20 岁女性，活泼" },
  ];
  const voices = assignDialogueVoices(["黄乐", "林小满"], cast, "alloy", "openai");
  assert.ok(OPENAI_VOICE_POOL.includes(voices.get("黄乐")!));
  assert.ok(OPENAI_VOICE_POOL.includes(voices.get("林小满")!));
  assert.notEqual(voices.get("黄乐"), voices.get("林小满"));
  const style = voiceStyleFor("45 岁男性，说话沉稳");
  assert.ok(style.includes("自然"), style);
  assert.ok(style.includes("男声"), style);
  assert.ok(voiceStyleFor("", "你站住！").includes("争执"));
  assert.ok(voiceStyleFor("", "你是谁？").includes("疑问"));
});

test("对白轮次：同一角色连续台词合并为一次合成，换人才断开", () => {
  const turns = mergeDialogueTurns([
    { speaker: "黄乐", text: "合同里写着我陪。" },
    { speaker: "黄乐", text: "我认。" },
    { speaker: "林小满", text: "你走吧。" },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.text, "合同里写着我陪，我认。");
  assert.equal(turns[0]!.items.length, 2);
  assert.equal(turns[1]!.text, "你走吧。");
});
