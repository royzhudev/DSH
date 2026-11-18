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

test("创作页目标时长：15 秒默认选中，包含 90/120 秒且使用高亮样式", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "web/js/app.js"), "utf8");
  const create = functionBody(source, "renderCreate");
  assert.match(create, /const target = 15;/);
  assert.match(create, /\[15, 30, 45, 60, 90, 120\]/);
  assert.match(create, /value === target \? "active" : ""/);
  assert.match(source, /targetDurationSec: Number\(activeDuration\?\.dataset\.value \?\? 15\)/);

  const styles = await fs.readFile(path.join(process.cwd(), "web/styles.css"), "utf8");
  assert.match(styles, /\.segmented button\.active\s*\{[^}]*background:\s*var\(--brand\)/s);
});
