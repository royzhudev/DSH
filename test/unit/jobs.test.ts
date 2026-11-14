import assert from "node:assert/strict";
import test from "node:test";
import { validateOptions } from "../../src/server/jobs.js";
import { makeTempDir, makeTestConfig } from "../helpers.js";

test("任务选项：百炼与 ElevenLabs 配音供应商都能通过校验", async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir);
  for (const provider of ["bailian", "elevenlabs"] as const) {
    assert.doesNotThrow(
      () => validateOptions({ ttsProvider: provider }, config),
      `供应商 ${provider} 不应被拒绝`,
    );
  }
  assert.throws(
    () => validateOptions({ ttsProvider: "bogus" as never }, config),
    /不支持的配音供应商/,
  );
  assert.doesNotThrow(() => validateOptions({ voice: "x".repeat(120) }, config));
  assert.throws(() => validateOptions({ voice: "x".repeat(121) }, config), /音色名称/);
});

test("任务选项：一镜到底允许 1 个分镜，0 个仍拒绝", async () => {
  const dir = await makeTempDir();
  const config = makeTestConfig(dir);
  assert.doesNotThrow(() => validateOptions({ maxSegments: 1 }, config));
  assert.doesNotThrow(() => validateOptions({ maxSegments: 20 }, config));
  assert.throws(() => validateOptions({ maxSegments: 0 }, config), /分镜数量/);
  assert.throws(() => validateOptions({ maxSegments: 21 }, config), /分镜数量/);
});
