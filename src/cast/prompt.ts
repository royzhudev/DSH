import type { CastAsset, ScriptSegment } from "../types.js";

export interface ShotPromptInput {
  topic: string;
  index: number;
  total: number;
  segment: ScriptSegment;
  /** 本分镜出场的角色/道具设定。 */
  cast: CastAsset[];
  /** 与上一镜区分用的机位/构图提示；相邻分镜场景镜头相同时由流水线补上。 */
  variation?: string;
}

const STYLE_SUFFIX = "竖屏 9:16，真实拍摄质感，电影感构图，光线自然，镜头稳定，无文字水印。";

function castLine(asset: CastAsset): string {
  const label = asset.kind === "character" ? "人物" : "道具";
  const description = asset.description ? `${asset.description}。` : "";
  const consistency =
    asset.kind === "character"
      ? "保持与参考图一致的发型、脸型、年龄、服装与气质，不要替换人物身份。"
      : "保持与参考图一致的外形、材质、颜色与新旧程度，不要改变道具外观。";
  return `${label}「${asset.name}」：${description}${consistency}`;
}

/**
 * 短剧分镜的画面提示词：剧本/镜头信息 + 出场角色与道具的外观设定，
 * 再显式要求跨镜头一致。相同的设定会出现在同一人物/道具的所有分镜里，
 * 配合参考图（图生视频）让后续镜头延续同一形象。
 */
export function buildShotPrompt(input: ShotPromptInput): string {
  const { topic, index, total, segment, cast, variation } = input;
  const scene = segment.scene?.trim();
  const shot = segment.shot?.trim();
  // 分镜内容一定要进提示词：相邻分镜的 scene/shot 写得很像时，
  // 只有台词/旁白不同，画面模型才会给出不同的表演与构图。
  const content = [
    ...(segment.lines ?? []).map((line) => `${line.speaker}：${line.text}`),
    ...(segment.lines?.length ? [] : [segment.narration]),
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [
    `短剧《${topic}》第 ${index}/${total} 镜。`,
    scene ? `场景：${scene}。` : "",
    shot ? `镜头：${shot}。` : "",
    content ? `本镜内容：${content}。` : "",
    variation ? `本镜构图：${variation}。` : "",
    "不要重复上一镜的画面与机位；每个分镜必须呈现新的动作或信息。" ,
    ...cast.map(castLine),
    cast.length > 0
      ? "一致性要求：同一人物/道具在本片不同镜头中外观、服装、光线方向保持一致，延续同一部短剧的影像风格。"
      : "",
    STYLE_SUFFIX,
  ];
  return lines.filter(Boolean).join("\n").slice(0, 1500);
}