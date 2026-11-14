import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDraftScript } from "../../src/script/draft.js";

test("手工修改的脚本：重排分镜编号、补全旁白并识别对话模式", () => {
  const script = normalizeDraftScript({
    title: "  钟表店  ",
    summary: "外卖员被冤枉",
    segments: [
      { narration: "林小满推门而入。", keywords: ["钟表店", "黄昏"], scene: "老城区钟表店" },
      {
        lines: [
          { speaker: "林小满", text: "这块表不是你的。" },
          { speaker: "黄乐", text: "你凭什么这么说？" },
        ],
        keywords: [],
      },
    ],
  });
  assert.equal(script.title, "钟表店");
  assert.equal(script.provider, "edited");
  assert.equal(script.mode, "dialogue");
  assert.deepEqual(script.segments.map((segment) => segment.id), [1, 2]);
  assert.equal(script.segments[1]!.narration, "林小满：这块表不是你的。黄乐：你凭什么这么说？");
});

test("手工修改的脚本：空分镜、空内容会被拒绝", () => {
  assert.throws(() => normalizeDraftScript({ title: "t", summary: "", segments: [] }), /至少需要 1 个分镜/);
  assert.throws(
    () => normalizeDraftScript({ title: "t", summary: "", segments: [{ keywords: ["a"] }] }),
    /需要旁白或台词/,
  );
  assert.throws(
    () => normalizeDraftScript({ title: "t", summary: "", segments: [{ narration: "x".repeat(900) }] }),
    /不能超过/,
  );
});
