import assert from "node:assert/strict";
import test from "node:test";
import { emotionProsody, planSpeech, splitClauses, turnGapMs } from "../../src/tts/prosody.js";

test("分句：按标点切开，标点保留在小句里", () => {
  assert.deepEqual(splitClauses("合同里写着我陪，你别管。真的吗？"), [
    "合同里写着我陪，",
    "你别管。",
    "真的吗？",
  ]);
  assert.deepEqual(splitClauses(""), []);
});

test("停顿：逗号短、句号长、情绪句与省略号更长", () => {
  const plan = planSpeech("我不走，你也别走。为什么？我……算了。", { rate: 1, pitch: "0Hz", volume: 0 });
  const pauses = plan.map((chunk) => chunk.pauseAfterMs);
  assert.equal(pauses.at(-1), 0, "最后一句不需要停顿");
  assert.ok(pauses[0]! > 0 && pauses[0]! < pauses[1]!, `逗号应短于句号：${pauses.join(",")}`);
  assert.ok(pauses[2]! >= pauses[1]!, `问句停顿应不短于句号：${pauses.join(",")}`);
  assert.ok(pauses[3]! > pauses[1]!, `省略号停顿应长于句号：${pauses.join(",")}`);
  assert.equal(pauses.at(-1), 0, "最后一句仍然不需要停顿");
});

test("情绪：感叹句更快更高更响，疑问句略慢且抬高，省略号放慢", () => {
  const excited = emotionProsody("你给我站住！");
  assert.ok(excited.rate > 1, "感叹句应更快");
  assert.ok(excited.pitchHz > 0, "感叹句应抬高音高");
  assert.ok(excited.volume > 0, "感叹句应更响");

  const question = emotionProsody("你为什么骗我？");
  assert.ok(question.pitchHz > 0);

  const trailing = emotionProsody("我早就知道了……");
  assert.ok(trailing.rate < 1, "省略号应放慢");
});

test("语速与音高按分句合成到基础设定上，并落在可用区间", () => {
  const plan = planSpeech("合同里写着我陪，你别管。", { rate: 0.92, pitch: "-2Hz", volume: -2 });
  for (const chunk of plan) {
    assert.ok(chunk.rate >= 0.5 && chunk.rate <= 2);
    assert.match(chunk.pitch, /^-?\d+Hz$/);
  }
  // 两句都是普通陈述，语速应落在基础值附近（短句会有轻微放慢）。
  assert.ok(Math.abs(plan[1]!.rate - 0.92) <= 0.05, `普通陈述不应大幅改速：${plan[1]!.rate}`);
  assert.equal(plan[1]!.pitch, "-2Hz");
});

test("角色交接的停顿比同一角色连说更长", () => {
  assert.ok(turnGapMs("黄乐", "客人") > turnGapMs("黄乐", "黄乐"));
}); 
