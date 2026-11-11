import assert from "node:assert/strict";
import test from "node:test";
import {
  displayWidth,
  formatAssTime,
  formatSrtTime,
  splitIntoSubtitleChunks,
  splitIntoSentences,
  tagsFromFilename,
} from "../../src/util/text.js";
import {
  buildSubtitleCues,
  renderAss,
  renderSrt,
} from "../../src/subtitles/ass.js";
import { estimateSentences, parseEdgeMetadata } from "../../src/tts/estimate.js";
import type { SubtitleStyle } from "../../src/types.js";

const STYLE: SubtitleStyle = {
  enabled: true,
  fontFamily: "Noto Sans CJK SC",
  fontSize: 54,
  maxCharsPerLine: 10,
  maxLines: 2,
  marginV: 260,
  primaryColor: "#FFFFFF",
  outlineColor: "#000000",
  outline: 3,
  shadow: 1,
  bold: true,
};

test("splitIntoSentences 按中英文标点切句并保留标点", () => {
  assert.deepEqual(splitIntoSentences("你好。世界！测试?OK"), [
    "你好。",
    "世界！",
    "测试?",
    "OK",
  ]);
});

test("displayWidth 把中文计为全角、拉丁字符计为半角", () => {
  assert.equal(displayWidth("中文"), 2);
  assert.ok(displayWidth("abc") < 2);
});

test("splitIntoSubtitleChunks 限制每屏字数", () => {
  const chunks = splitIntoSubtitleChunks("一二三四五六七八九十一二三四五", 5, 2);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(displayWidth(chunk) <= 10.01, chunk);
});

test("时间码格式正确", () => {
  assert.equal(formatAssTime(0), "0:00:00.00");
  assert.equal(formatAssTime(3661.23), "1:01:01.23");
  assert.equal(formatSrtTime(3661.234), "01:01:01,234");
});

test("文件名生成素材标签", () => {
  assert.deepEqual(tagsFromFilename("city-night_01.mp4"), ["city", "night", "01"]);
});

test("parseEdgeMetadata 把 100ns tick 转成秒", () => {
  const raw = JSON.stringify({
    Metadata: [
      {
        Type: "SentenceBoundary",
        Data: {
          Offset: 1_000_000,
          Duration: 39_875_000,
          text: { Text: "你好，这是测试。" },
        },
      },
    ],
  });
  const sentences = parseEdgeMetadata(raw, "你好，这是测试。", 5);
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0]!.startSec, 0.1);
  assert.ok(Math.abs(sentences[0]!.endSec - 4.0875) < 0.000001);
});

test("estimateSentences 的总时长与音频时长一致", () => {
  const sentences = estimateSentences("第一句话。第二句话更长一些。", 6);
  assert.equal(sentences.length, 2);
  assert.equal(sentences[0]!.startSec, 0);
  assert.ok(Math.abs(sentences[sentences.length - 1]!.endSec - 6) < 0.001);
});

test("buildSubtitleCues 使用句级时间戳并拆成多屏", () => {
  const cues = buildSubtitleCues({
    narration: "你好。世界。",
    sentences: [
      { text: "你好。", startSec: 0, endSec: 2 },
      { text: "世界。", startSec: 2, endSec: 4 },
    ],
    audioDurationSec: 4,
    style: { ...STYLE, maxCharsPerLine: 10, maxLines: 1 },
  });
  assert.equal(cues.length, 2);
  assert.equal(cues[0]!.startSec, 0);
  assert.equal(cues[1]!.endSec, 4);
});

test("renderAss 输出字体、时间轴与手动换行", () => {
  const ass = renderAss(
    [{ startSec: 0, endSec: 2, text: "一二三四五六" }],
    { ...STYLE, maxCharsPerLine: 3 },
    { width: 1080, height: 1920, fps: 30 },
  );
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /Noto Sans CJK SC/);
  assert.match(ass, /Dialogue: 0,0:00:00.00,0:00:02.00/);
  assert.match(ass, /一二三\\N四五六/);
});

test("renderSrt 加上分镜起始偏移", () => {
  const srt = renderSrt([{ startSec: 1, endSec: 2, text: "你好", startOffsetSec: 10 }]);
  assert.match(srt, /00:00:11,000 --> 00:00:12,000/);
  assert.match(srt, /你好/);
});