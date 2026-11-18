import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/** 截取一个顶层 async function 的函数体，防止跨页面的事件绑定混进来。 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `找不到函数 ${name}`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  throw new Error(`函数 ${name} 没有闭合`);
}

test("网页渲染：素材库和发布页不混入其他页面的事件绑定", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "web/js/app.js"), "utf8");
  const materials = functionBody(source, "renderMaterials");
  assert.doesNotMatch(materials, /voicePreview|previewCastVoice|cast-edit-voice/);
  assert.match(materials, /upload-btn/);

  const publish = functionBody(source, "renderPublish");
  assert.doesNotMatch(publish, /openSegmentEdit|submitSegmentEdit|startEditPolling|segment-edit-form/);
  assert.match(publish, /connect-douyin/);
});

test("创作页目标时长：包含 90/120 秒选项，默认 15 秒且选中项高亮", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "web/js/app.js"), "utf8");
  const body = functionBody(source, "renderCreate");
  assert.match(body, /\[15, 30, 45, 60, 90, 120, target\]/, "创作页应提供 90/120 秒选项");
  assert.match(body, /targetDurationSec\) \|\| 15/, "没有设置时默认 15 秒");
  // 选中项通过与 data-value 比较加 active 类，保持现有高亮方式。
  assert.match(body, /class="\$\{value === target \? "active" : ""\}"/, "当前时长要高亮");
  // 提交任务时读取当前选中的按钮，没有选中时同样回落到 15 秒。
  assert.match(source, /activeDuration\?\.dataset\.value \?\? 15/, "提交时默认也取 15 秒");
});
