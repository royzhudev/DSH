import assert from "node:assert/strict";
import test from "node:test";

import { assignDialogueVoices } from "../../src/tts/voices.js";

test("音色分配：同性别同龄角色再多，也尽量分到互不相同的音色", () => {
  // 5 个“35 岁男性”，候选池只有 4 个男声；前 4 个必须互不相同。
  const cast = [1, 2, 3, 4, 5].map((index) => ({
    name: `男角色${index}`,
    kind: "character" as const,
    description: "35 岁男性，沉默寡言",
  }));
  const voices = assignDialogueVoices(
    cast.map((item) => item.name),
    cast,
    "zh-CN-XiaoxiaoNeural",
  );
  const assigned = [...voices.values()];
  assert.equal(new Set(assigned.slice(0, 4)).size, 4, `前四个角色音色重复：${assigned.join(", ")}`);
  assert.equal(assigned.includes("zh-CN-XiaoxiaoNeural"), false, "不应和旁白音色撞车");
});

test("音色分配：角色库里手动指定的音色优先于自动匹配", () => {
  const cast = [
    { name: "老周", kind: "character" as const, description: "50 岁男性", voice: "zh-CN-YunjianNeural" },
  ];
  const voices = assignDialogueVoices(["老周"], cast, "zh-CN-XiaoxiaoNeural");
  assert.equal(voices.get("老周"), "zh-CN-YunjianNeural");
});
