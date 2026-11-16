import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startServer } from "../../src/server/server.js";
import { silentLogger } from "../../src/logger.js";
import { generateTestImage, makeTempDir, makeTestConfig, setupTestAdmin, withCookie } from "../helpers.js";

test("HTTP API：按角色外观设定生成参考图并保留上传模式", { timeout: 120_000 }, async (t) => {
  const dir = await makeTempDir();
  const source = path.join(dir, "generated.png");
  await generateTestImage(source, { size: "240x320" });
  const requests: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/api/v1/services/aigc/multimodal-generation/generation")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          output: {
            choices: [{ message: { content: [{ image: "https://image.test/generated.png" }] } }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://image.test/generated.png") {
      return new Response(new Uint8Array(await fs.readFile(source)), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const config = makeTestConfig(dir, {
    server: { port: 0 },
    imageGen: {
      provider: "bailian",
      baseUrl: "https://image.test",
      apiKey: "test-key",
      model: "qwen-image-2.0-pro",
      size: "1152*1536",
    },
  });
  const app = await startServer(config, silentLogger, { cwd: dir, env: {}, fetchImpl });
  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const session = await setupTestAdmin(app.url);
  const request = withCookie(session.cookie);

  const form = new FormData();
  form.append("kind", "character");
  form.append("name", "林小满");
  form.append("description", "25 岁女性，齐肩短发，米色风衣，左眉一道浅疤");
  const createResponse = await request(`${app.url}/api/cast`, { method: "POST", body: form });
  assert.equal(createResponse.status, 201, await createResponse.clone().text());
  const created = (await createResponse.json()) as { cast: { id: string; imageUrl?: string } };
  assert.equal(created.cast.imageUrl, undefined);

  const generateResponse = await request(`${app.url}/api/cast/${created.cast.id}/image/generate`, {
    method: "POST",
  });
  assert.equal(generateResponse.status, 200, await generateResponse.clone().text());
  const generated = (await generateResponse.json()) as {
    cast: { imageUrl?: string; width?: number; height?: number; description: string };
  };
  assert.ok(generated.cast.imageUrl);
  assert.equal(generated.cast.width, 240);
  assert.equal(generated.cast.height, 320);
  assert.equal(requests.length, 2);
  const requestBody = bodies[0] as {
    model: string;
    input: { messages: Array<{ content: Array<{ text: string }> }> };
    parameters: { size: string };
  };
  assert.equal(requestBody.model, "qwen-image-2.0-pro");
  assert.equal(requestBody.parameters.size, "1152*1536");
  assert.match(requestBody.input.messages[0]!.content[0]!.text, /齐肩短发/);
  assert.match(requestBody.input.messages[0]!.content[0]!.text, /角色「林小满」/);

  const image = await request(`${app.url}${generated.cast.imageUrl}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal((await image.arrayBuffer()).byteLength > 0, true);

  // 没有外观设定时不能生成，避免拿空提示词白花钱。
  const emptyForm = new FormData();
  emptyForm.append("kind", "prop");
  emptyForm.append("name", "旧怀表");
  const empty = await request(`${app.url}/api/cast`, { method: "POST", body: emptyForm });
  const emptyCast = (await empty.json()) as { cast: { id: string } };
  const emptyGenerate = await request(`${app.url}/api/cast/${emptyCast.cast.id}/image/generate`, {
    method: "POST",
  });
  assert.equal(emptyGenerate.status, 400);
  assert.equal(
    ((await emptyGenerate.json()) as { error: { code: string } }).error.code,
    "IMAGE_GEN_PROMPT_EMPTY",
  );

  const missing = await request(`${app.url}/api/cast/not-found/image/generate`, { method: "POST" });
  assert.equal(missing.status, 404);
});
