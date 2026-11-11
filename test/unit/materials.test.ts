import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MaterialLibrary, materialType } from "../../src/materials/library.js";
import { matchMaterial } from "../../src/materials/match.js";
import { silentLogger } from "../../src/logger.js";
import { generateTestClip, makeTempDir, makeTestConfig } from "../helpers.js";

test("素材库添加、打标签、匹配和删除", async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir);
  const clip = path.join(dir, "source", "city-night.mp4");
  await generateTestClip(clip, { durationSec: 1, size: "160x160" });

  const library = new MaterialLibrary(config.libraryDir, silentLogger);
  const material = await library.add(clip, { tags: ["城市"] });
  assert.equal(material.type, "video");
  assert.ok(material.tags.includes("城市"));
  assert.ok(material.tags.includes("city"));
  assert.ok(material.tags.includes("night"));
  assert.equal(material.durationSec && material.durationSec > 0.5, true);

  const listed = await library.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, material.id);

  const matched = matchMaterial(
    { id: 1, narration: "城市夜景", keywords: ["城市"] },
    listed,
    { allowUnmatched: false, usedIds: new Set() },
  );
  assert.equal(matched?.id, material.id);

  const unmatched = matchMaterial(
    { id: 2, narration: "科技", keywords: ["科技"] },
    listed,
    { allowUnmatched: false, usedIds: new Set() },
  );
  assert.equal(unmatched, null);

  const forced = matchMaterial(
    { id: 3, narration: "科技", keywords: ["科技"] },
    listed,
    { allowUnmatched: true, usedIds: new Set() },
  );
  assert.equal(forced?.id, material.id);

  assert.equal(await library.remove(material.id), true);
  assert.equal((await library.list()).length, 0);
});

test("materialType 识别常见音视频与图片格式", () => {
  assert.equal(materialType("a.mp4"), "video");
  assert.equal(materialType("a.MOV"), "video");
  assert.equal(materialType("a.png"), "image");
  assert.equal(materialType("a.txt"), null);
});

test("素材索引在重新扫描后保持稳定", async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir);
  const clip = path.join(dir, "source", "nature.mp4");
  await generateTestClip(clip, { durationSec: 0.6, size: "120x120" });
  const library = new MaterialLibrary(config.libraryDir, silentLogger);
  const first = await library.add(clip, { tags: ["自然"] });
  const second = await library.list();
  assert.equal(second.length, 1);
  assert.equal(second[0]!.id, first.id);
  assert.equal(second[0]!.file, first.file);
});