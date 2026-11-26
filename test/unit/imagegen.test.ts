import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DashScopeImageProvider } from "../../src/imagegen/dashscope.js";
import { generateCastImage } from "../../src/cast/imagegen.js";
import { silentLogger } from "../../src/logger.js";
import type { CastAsset } from "../../src/types.js";
import { generateTestImage, makeTempDir, makeTestConfig } from "../helpers.js";

test("图像生成：请求百炼 Qwen-Image 并下载结果", { timeout: 60_000 }, async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "source.png");
  await generateTestImage(source, { size: "240x320" });
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/v1/services/aigc/multimodal-generation/generation")) {
      requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          output: {
            choices: [{ message: { role: "assistant", content: [{ image: "https://image.test/out.png" }] } }],
          },
          usage: { image_count: 1, width: 240, height: 320 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://image.test/out.png") {
      return new Response(new Uint8Array(await fs.readFile(source)), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const output = path.join(dir, "generated.png");
  try {
    const provider = new DashScopeImageProvider(
      {
        provider: "bailian",
        baseUrl: "",
        apiKey: "test-key",
        model: "qwen-image-2.0-pro",
        size: "1152*1536",
        negativePrompt: "低画质，畸形手指",
        promptExtend: true,
        timeoutMs: 30_000,
      },
      silentLogger,
      { fetchImpl },
    );
    const result = await provider.generate("25 岁女性，齐肩短发，米色风衣", output);
    assert.equal(result.width, 240);
    assert.equal(result.height, 320);
    assert.equal(result.model, "qwen-image-2.0-pro");
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]!.url,
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    const body = requests[0]!.body as {
      model: string;
      input: { messages: Array<{ content: Array<{ text: string }> }> };
      parameters: Record<string, unknown>;
    };
    assert.equal(body.model, "qwen-image-2.0-pro");
    assert.equal(body.input.messages[0]!.content[0]!.text, "25 岁女性，齐肩短发，米色风衣");
    assert.equal(body.parameters.size, "1152*1536");
    assert.equal(body.parameters.negative_prompt, "低画质，畸形手指");
    assert.equal(body.parameters.prompt_extend, true);
    assert.equal(body.parameters.n, 1);
    assert.equal((await fs.stat(output)).size > 0, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("图像生成：没有 API Key 或响应没图时给出明确错误", { timeout: 30_000 }, async () => {
  const dir = await makeTempDir();
  try {
    const provider = new DashScopeImageProvider(
      {
        provider: "bailian",
        baseUrl: "https://image.test",
        model: "qwen-image-2.0-pro",
        size: "1024*1024",
        negativePrompt: "",
        promptExtend: false,
        timeoutMs: 10_000,
      },
      silentLogger,
      { fetchImpl: async () => new Response("{}", { status: 200 }) },
    );
    await assert.rejects(() => provider.generate("一个角色", path.join(dir, "out.png")), /API Key/);

    const noImage = new DashScopeImageProvider(
      {
        provider: "bailian",
        baseUrl: "https://image.test",
        apiKey: "test-key",
        model: "qwen-image-2.0-pro",
        size: "1024*1024",
        negativePrompt: "",
        promptExtend: false,
        timeoutMs: 10_000,
      },
      silentLogger,
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ output: { choices: [] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );
    await assert.rejects(() => noImage.generate("一个角色", path.join(dir, "out2.png")), /没有图片地址/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("图像生成：qwen-image-2.1 系列跳过不支持的 negative_prompt", { timeout: 30_000 }, async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "source.png");
  await generateTestImage(source);
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/multimodal-generation/generation")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ output: { choices: [{ message: { content: [{ image: "https://image.test/out.png" }] } }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(new Uint8Array(await fs.readFile(source)), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  };
  try {
    const provider = new DashScopeImageProvider(
      {
        provider: "bailian",
        baseUrl: "",
        apiKey: "test-key",
        model: "qwen-image-2.1-pro",
        size: "1152*1536",
        negativePrompt: "低画质，畸形手指",
        promptExtend: true,
        timeoutMs: 30_000,
      },
      silentLogger,
      { fetchImpl },
    );
    await provider.generate("一个角色", path.join(dir, "out.png"));
    const body = bodies[0] as { parameters: Record<string, unknown> };
    assert.equal(body.parameters.negative_prompt, undefined);
    assert.equal(body.parameters.prompt_extend, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("图像生成：401 提示百炼 Key 不能用于聚合平台", { timeout: 30_000 }, async () => {
  const dir = await makeTempDir();
  const provider = new DashScopeImageProvider(
    {
      provider: "bailian",
      baseUrl: "",
      apiKey: "test-key",
      model: "qwen-image-3.0-pro",
      size: "1152*1536",
      negativePrompt: "",
      promptExtend: true,
      timeoutMs: 10_000,
    },
    silentLogger,
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: { code: "", message: "Invalid token", type: "new_api_error" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    },
  );
  try {
    await assert.rejects(
      () => provider.generate("一个角色", path.join(dir, "out.png")),
      /百炼 API Key 只能调用百炼地址.*聚合平台/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("图像生成：角色参考图地址默认百炼，不沿用视频聚合平台地址", { timeout: 30_000 }, async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "source.png");
  await generateTestImage(source);
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/multimodal-generation/generation")) {
      return new Response(
        JSON.stringify({ output: { choices: [{ message: { content: [{ image: "https://image.test/out.png" }] } }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(new Uint8Array(await fs.readFile(source)), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  };
  const config = makeTestConfig(dir, {
    videoGen: { baseUrl: "https://nexus.cytain.com" },
    imageGen: {
      provider: "bailian",
      baseUrl: "",
      apiKey: "test-key",
      model: "qwen-image-3.0-pro",
      size: "1152*1536",
    },
  });
  const asset: CastAsset = {
    id: "cast1",
    kind: "character",
    name: "林小满",
    description: "25 岁女性，齐肩短发，米色风衣",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    assert.equal(config.videoGen.baseUrl, "https://nexus.cytain.com");
    assert.equal(config.imageGen.baseUrl, "https://dashscope.aliyuncs.com");
    await generateCastImage(config, asset, silentLogger, { fetchImpl });
    assert.equal(
      requested[0],
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
