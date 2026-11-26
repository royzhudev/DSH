import type { VideoGenSettings } from "../types.js";

/** 公网素材地址是否已配置完整（地址 + 访问令牌）。 */
export function hasPublicAssetBase(
  videoGen: Pick<VideoGenSettings, "publicBaseUrl" | "publicAssetToken">,
): boolean {
  return Boolean(videoGen.publicBaseUrl.trim() && videoGen.publicAssetToken.trim());
}

/**
 * 把本地角色/道具图映射成平台可访问的只读 URL。平台只接受公网 HTTP(S)，
 * 因此只有显式配置了公网地址与随机令牌时才返回；否则仍走本地图片。
 */
export function publicCastImageUrl(
  videoGen: Pick<VideoGenSettings, "publicBaseUrl" | "publicAssetToken">,
  castId: string,
): string | undefined {
  if (!hasPublicAssetBase(videoGen)) return undefined;
  const base = videoGen.publicBaseUrl.trim().replace(/\/+$/, "");
  return `${base}/api/public/cast/${encodeURIComponent(videoGen.publicAssetToken.trim())}/${encodeURIComponent(castId)}`;
}
