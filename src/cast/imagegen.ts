import path from "node:path";
import { AppError } from "../errors.js";
import { isImageGenEnabled } from "../config.js";
import type { Logger } from "../logger.js";
import type { AppConfig, CastAsset } from "../types.js";
import { shortId } from "../util/fs.js";
import { DashScopeImageProvider, type ImageGenResult } from "../imagegen/dashscope.js";

/** 外观设定直接作为提示词主体，再补上角色/道具的取景要求。 */
export function buildCastImagePrompt(asset: Pick<CastAsset, "kind" | "name" | "description">): string {
  const description = asset.description.trim();
  if (!description) {
    throw new AppError("请先填写外观设定，AI 才能按设定生成参考图", {
      code: "IMAGE_GEN_PROMPT_EMPTY",
      status: 400,
    });
  }
  const name = asset.name.trim();
  const kindLabel = asset.kind === "character" ? "角色" : "道具";
  const subject = name ? `${kindLabel}「${name}」` : `这个${kindLabel}`;
  const framing =
    asset.kind === "character"
      ? "角色定妆照，单人，正面半身，五官和服装细节清晰，干净纯色背景，柔和均匀的光线，写实电影质感，无文字，无水印"
      : "道具设定图，单个物品完整展示，正面视角，干净纯色背景，材质和细节清晰，柔和均匀的光线，写实质感，无文字，无水印";
  return `${description}。${subject}：${framing}`;
}

export interface CastImageGeneration {
  result: ImageGenResult;
  prompt: string;
  /** 临时文件；入库后由调用方删除。 */
  tempFile: string;
}

/** 调图像模型生成一张参考图，落到 cache 里等待 CastLibrary 入库。 */
export async function generateCastImage(
  config: AppConfig,
  asset: CastAsset,
  logger: Logger,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<CastImageGeneration> {
  if (!isImageGenEnabled(config.imageGen)) {
    throw new AppError("还没有启用图像生成模型，请到「设置 → AI 角色图生成」选择阿里百炼并填写 API Key", {
      code: "IMAGE_GEN_DISABLED",
      status: 400,
    });
  }
  const prompt = buildCastImagePrompt(asset);
  const provider = new DashScopeImageProvider(config.imageGen, logger, {
    fetchImpl: deps.fetchImpl,
    fallbackBaseUrl: config.videoGen.baseUrl,
  });
  const tempFile = path.join(config.cacheDir, "cast-images", `${asset.id}-${shortId()}.png`);
  const result = await provider.generate(prompt, tempFile);
  return { result, prompt, tempFile: result.file };
}
