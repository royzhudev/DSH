import type { Material, ScriptSegment } from "../types.js";

export interface MatchOptions {
  /** 没有关键词命中时，是否允许使用素材库里的任意素材。 */
  allowUnmatched: boolean;
  usedIds: Set<string>;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function scoreMaterial(
  segment: ScriptSegment,
  material: Material,
  used: boolean,
): { score: number; keywordScore: number } {
  const tags = material.tags.map((tag) => tag.toLowerCase());
  const haystack = `${material.title} ${material.file}`.toLowerCase();
  let keywordScore = 0;

  for (const rawKeyword of segment.keywords) {
    const keyword = rawKeyword.trim().toLowerCase();
    if (!keyword) continue;
    if (tags.includes(keyword)) {
      keywordScore += 5;
      continue;
    }
    if (tags.some((tag) => tag.includes(keyword) || (keyword.length >= 2 && keyword.includes(tag)))) {
      keywordScore += 3;
      continue;
    }
    if (haystack.includes(keyword)) keywordScore += 2;
  }

  let score = keywordScore;
  if (!used) score += 1.5;
  if (material.type === "video") score += 0.5;
  return { score, keywordScore };
}

/**
 * 规则化素材匹配：关键词命中标签优先，其次标题/文件名；
 * 未命中时默认回退到生成的渐变背景，避免把无关素材硬塞进片子。
 */
export function matchMaterial(
  segment: ScriptSegment,
  materials: Material[],
  options: MatchOptions,
): Material | null {
  if (materials.length === 0) return null;
  const ranked = materials
    .map((material) => {
      const used = options.usedIds.has(material.id);
      const { score, keywordScore } = scoreMaterial(segment, material, used);
      return {
        material,
        used,
        score,
        keywordScore,
        tieBreak: hashString(`${segment.id}:${material.id}`),
      };
    })
    .sort((a, b) => b.score - a.score || a.tieBreak - b.tieBreak);

  const best = ranked[0]!;
  if (best.keywordScore > 0) {
    return best.material;
  }
  if (!options.allowUnmatched) {
    return null;
  }
  return ranked.find((item) => !item.used)?.material ?? best.material;
}

export function materialTagPool(materials: Material[]): string[] {
  const tags = new Set<string>();
  for (const material of materials) {
    for (const tag of material.tags) tags.add(tag);
  }
  return [...tags].slice(0, 60);
}