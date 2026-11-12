import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Script, ScriptProvider, ScriptRequest, ScriptSettings } from "../types.js";
import { truncate } from "../util/text.js";
import { normalizeScript, parseScriptJson } from "./parse.js";

const SYSTEM_PROMPT = `你是一名资深短剧编导，擅长把主题或剧本拆成竖屏短剧分镜。
你要保证同一人物、同一道具在后续镜头里外观和设定一致，不能前后矛盾。
你的输出必须是严格合法的 JSON，不要包含 Markdown 代码围栏、注释或任何额外说明。`;

function castSection(request: ScriptRequest): string {
  const cast = request.cast ?? [];
  if (cast.length === 0) return "";
  const lines = cast.map(
    (item) =>
      `- ${item.kind === "character" ? "人物" : "道具"}「${item.name}」：${item.description || "（未填写外观设定，请保持名称与身份一致）"}`,
  );
  return `

角色/道具设定（必须原样使用这些名称，不得改名或替换外观）：
${lines.join("\n")}
要求：每个分镜用 cast 列出该镜头出场的名称（只能来自上面的清单，没有出场就给空数组）；
同一人物/道具的服装、发型、年龄、外形在整条片子里保持不变。`;
}

function storySection(request: ScriptRequest): string {
  const story = request.story?.trim();
  if (!story) return "";
  return `

用户提供的剧本/大纲（必须严格按此改编，不得改变人物关系、关键情节与结局）：
"""
${story.slice(0, 6000)}
"""`;
}

function buildUserPrompt(request: ScriptRequest): string {
  const tags = request.availableTags.length > 0
    ? request.availableTags.slice(0, 40).join("、")
    : "（素材库暂无可选标签，请给出通用画面关键词）";
  return `请围绕主题「${request.topic}」写一条竖屏短剧脚本。${storySection(request)}${castSection(request)}

硬性要求：
1. 目标总时长约 ${request.targetDurationSec} 秒，拆成 3 到 ${request.maxSegments} 个分镜。
2. 每个分镜的口播文案 20 到 60 个汉字，口语化、有节奏，开头 2 秒内抓住注意力，结尾有总结或互动引导。
3. 每个分镜给出 2 到 4 个画面检索关键词，优先从以下素材标签中选择：${tags}
4. 每个分镜补全 scene（场景：地点/时间/光线）和 shot（镜头：景别、人物动作、构图），用于画面生成。
5. 不要出现 Markdown、序号、括号说明、表情符号或英文标签。
6. 只输出如下结构的 JSON：
{
  "title": "视频标题，20 字以内",
  "summary": "一句话概括",
  "segments": [
    {
      "narration": "这一段的口播文案",
      "keywords": ["画面关键词1", "画面关键词2"],
      "durationHintSec": 7,
      "scene": "老城区咖啡馆，傍晚，暖色台灯",
      "shot": "中景，女主推门进来，镜头缓慢跟随",
      "cast": ["林小满", "旧怀表"]
    }
  ]
}`;
}

export interface OpenAiScriptOptions {
  config: ScriptSettings;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAiScriptProvider implements ScriptProvider {
  readonly name = "openai";
  private readonly config: ScriptSettings;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiScriptOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(request: ScriptRequest, signal?: AbortSignal): Promise<Script> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new AppError("未配置脚本接口密钥 SCRIPT_API_KEY", { code: "CONFIG_MISSING_API_KEY" });
    }

    const body = {
      model: this.config.model,
      temperature: this.config.temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(request) },
      ],
    };

    const content = await this.requestCompletion(body, apiKey, signal);
    const script = normalizeScript(parseScriptJson(content), {
      provider: this.name,
      topic: request.topic,
      maxSegments: request.maxSegments,
    });
    this.logger.info(`脚本生成完成：${script.segments.length} 个分镜（${this.config.model}）`);
    return script;
  }

  private async requestCompletion(
    body: unknown,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const maxAttempts = 3;
    let lastError: unknown;
    let requestBody = body as Record<string, unknown>;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          if (
            (response.status === 400 || response.status === 422) &&
            "response_format" in requestBody
          ) {
            this.logger.warn("脚本接口不支持 response_format，去掉后重试");
            const { response_format: _responseFormat, ...rest } = requestBody;
            requestBody = rest;
            continue;
          }
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < maxAttempts) {
            this.logger.warn(`脚本接口返回 ${response.status}，第 ${attempt} 次重试`);
            await sleep(800 * attempt);
            continue;
          }
          throw new AppError(`脚本接口返回 ${response.status}：${truncate(text, 300)}`, {
            code: "SCRIPT_API_FAILED",
            status: 502,
          });
        }

        const json = (await response.json()) as ChatCompletionResponse;
        const content = json.choices?.[0]?.message?.content;
        if (!content || !content.trim()) {
          throw new AppError("脚本接口返回了空内容", { code: "SCRIPT_API_EMPTY", status: 502 });
        }
        return content;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        if (error instanceof AppError) throw error;
        if (attempt < maxAttempts) {
          this.logger.warn(`脚本接口请求失败，第 ${attempt} 次重试：${String(error)}`);
          await sleep(800 * attempt);
          continue;
        }
        throw new AppError(`脚本接口请求失败：${String(error)}`, {
          code: "SCRIPT_API_FAILED",
          status: 502,
          cause: error,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }

    throw new AppError(`脚本接口请求失败：${String(lastError)}`, {
      code: "SCRIPT_API_FAILED",
      status: 502,
      cause: lastError,
    });
  }
}