import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  CastLibrary,
  castImageType,
  castSummary,
  parseCastDescription,
  parseCastName,
  resolveCastNames,
  selectCastAssets,
} from "../../src/cast/library.js";
import { AppError } from "../../src/errors.js";
import { silentLogger } from "../../src/logger.js";
import { runFfmpeg } from "../../src/media/ffmpeg.js";
import type { CastAsset } from "../../src/types.js";
import { makeTempDir } from "../helpers.js";

async function makeImage(file: string, color = "0x884466"): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=64x64`,
    "-frames:v",
    "1",
    file,
  ]);
}

test("角色库：添加、重名、编辑、换图与删除", async () => {
  const dir = await makeTempDir();
  try {
    const library = new CastLibrary(path.join(dir, "cast"), silentLogger);
    const image = path.join(dir, "input", "hero.jpg");
    await makeImage(image);

    const hero = await library.add({
      kind: "character",
      name: "林小满",
      description: "25 岁女性，齐肩短发，米色风衣",
      imagePath: image,
    });
    assert.equal(hero.kind, "character");
    assert.equal(hero.name, "林小满");
    assert.ok(hero.imageFile, "参考图没有导入");
    assert.equal(hero.width, 64);
    assert.equal(hero.height, 64);
    assert.equal(await fs.stat(path.join(library.dir, hero.imageFile!)).then((s) => s.isFile()), true);

    await assert.rejects(
      library.add({ kind: "prop", name: "林小满" }),
      (error: unknown) => error instanceof AppError && error.code === "CAST_NAME_TAKEN",
    );
    await assert.rejects(
      library.add({ kind: "character", name: "   " }),
      (error: unknown) => error instanceof AppError && error.code === "CAST_INVALID",
    );

    const watch = await library.add({ kind: "prop", name: "旧怀表" });
    assert.equal(watch.imageFile, undefined);

    const renamed = await library.update(hero.id, { description: "红色围巾", kind: "character" });
    assert.equal(renamed.description, "红色围巾");

    const replacement = path.join(dir, "input", "hero-2.png");
    await makeImage(replacement, "0x336699");
    const replaced = await library.setImage(hero.id, replacement);
    assert.notEqual(replaced.imageFile, hero.imageFile);
    await assert.rejects(
      fs.stat(path.join(library.dir, hero.imageFile!)),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );

    const listed = await library.list();
    assert.equal(listed.length, 2);
    assert.equal(await library.remove(watch.id), true);
    assert.equal(await library.remove(watch.id), false);
    assert.equal((await library.list()).length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("角色库：自动导入目录中的参考图并跳过损坏文件", async () => {
  const dir = await makeTempDir();
  try {
    const castDir = path.join(dir, "cast");
    await makeImage(path.join(castDir, "char-阿青-3f9a2c.jpg"));
    await makeImage(path.join(castDir, "prop-怀表-1a2b3c.png"));
    await fs.writeFile(path.join(castDir, "broken.jpg"), "not an image");
    const library = new CastLibrary(castDir, silentLogger);
    const listed = await library.list();
    assert.equal(listed.length, 2);
    const character = listed.find((asset) => asset.kind === "character");
    const prop = listed.find((asset) => asset.kind === "prop");
    assert.ok(character && prop);
    assert.equal(character.name, "阿青");
    assert.equal(prop.name, "怀表");
    assert.equal(castImageType("a.JPEG"), ".jpeg");
    assert.equal(castImageType("a.gif"), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("角色库：名称解析、选择与摘要", () => {
  const assets: CastAsset[] = [
    {
      id: "a1",
      kind: "character",
      name: "林小满",
      description: "短发",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "a2",
      kind: "prop",
      name: "Old Watch",
      description: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  assert.deepEqual(
    resolveCastNames(["林小满", "old watch", "不存在"], assets).map((asset) => asset.id),
    ["a1", "a2"],
  );
  assert.deepEqual(resolveCastNames(undefined, assets), []);
  assert.deepEqual(selectCastAssets(assets, ["a2", "a2"]).map((asset) => asset.id), ["a2"]);
  assert.deepEqual(selectCastAssets(assets).length, 2);
  assert.throws(
    () => selectCastAssets(assets, ["nope"]),
    (error: unknown) => error instanceof AppError && error.code === "CAST_NOT_FOUND",
  );
  assert.deepEqual(castSummary(assets), [
    { id: "a1", name: "林小满", kind: "character", description: "短发" },
    { id: "a2", name: "Old Watch", kind: "prop", description: "" },
  ]);

  assert.equal(parseCastName("  阿青  "), "阿青");
  assert.throws(() => parseCastName(""), AppError);
  assert.throws(() => parseCastDescription(42), AppError);
  assert.equal(parseCastDescription(undefined), "");
});