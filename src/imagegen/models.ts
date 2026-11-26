/** 阿里百炼图像生成默认地址；角色参考图不沿用视频/聚合平台的地址。 */
export const DASHSCOPE_IMAGE_BASE_URL = "https://dashscope.aliyuncs.com";
/** 千问图像系列同步接口；3.0 / 2.1 / 2.0 都使用这个 path。 */
export const DASHSCOPE_IMAGE_GENERATION_PATH =
  "/api/v1/services/aigc/multimodal-generation/generation";
export const DEFAULT_IMAGE_GEN_MODEL = "qwen-image-2.0-pro";

export interface ImageGenModelOption {
  /** 百炼模型 ID。 */
  id: string;
  label: string;
  hint: string;
  /** qwen-image-2.1 系列不支持 negative_prompt，传了会报参数错误。 */
  supportsNegativePrompt: boolean;
  supportsPromptExtend: boolean;
}

/**
 * 可在设置页直接切换的阿里百炼文生图模型。
 * 同一个百炼 API Key 即可切换；模型、endpoint 与 Key 必须属于同一地域。
 */
export const IMAGE_GEN_MODEL_OPTIONS: readonly ImageGenModelOption[] = [
  {
    id: "qwen-image-3.0-pro",
    label: "Qwen-Image 3.0 Pro（旗舰，文字渲染更强）",
    hint: "旗舰效果，擅长中英文文字渲染与真实材质；支持负向提示词，适合正式角色定妆照。",
    supportsNegativePrompt: true,
    supportsPromptExtend: true,
  },
  {
    id: "qwen-image-3.0",
    label: "Qwen-Image 3.0（质量与速度兼顾）",
    hint: "3.0 标准档，质量与速度平衡；支持负向提示词。",
    supportsNegativePrompt: true,
    supportsPromptExtend: true,
  },
  {
    id: "qwen-image-2.1-pro",
    label: "Qwen-Image 2.1 Pro（均衡）",
    hint: "速度、效果、成本最均衡；该系列不支持负向提示词，不希望出现的元素请写进正向描述。",
    supportsNegativePrompt: false,
    supportsPromptExtend: true,
  },
  {
    id: "qwen-image-2.1-turbo",
    label: "Qwen-Image 2.1 Turbo（性价比）",
    hint: "系列中性价比最高、速度更快；该系列不支持负向提示词，不希望出现的元素请写进正向描述。",
    supportsNegativePrompt: false,
    supportsPromptExtend: true,
  },
  {
    id: "qwen-image-2.0-pro",
    label: "Qwen-Image 2.0 Pro（旧版稳定）",
    hint: "旧版稳定模型，兼容已有设置；支持负向提示词。",
    supportsNegativePrompt: true,
    supportsPromptExtend: true,
  },
];

export function imageGenModelOption(model: string): ImageGenModelOption | undefined {
  const id = model.trim();
  return IMAGE_GEN_MODEL_OPTIONS.find((option) => option.id === id);
}