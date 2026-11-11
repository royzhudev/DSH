import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../util/fs.js";

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function pseudoNoise(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return Math.floor((n - Math.floor(n)) * 9) - 4;
}

/**
 * 当素材库没有匹配项时，用纯 JS 生成一张渐变背景图（PPM），
 * 再交给 ffmpeg 做缓慢推镜。这样零素材也能产出完整成片。
 */
export async function createGradientImage(
  file: string,
  width: number,
  height: number,
  seed: number,
): Promise<void> {
  await ensureDir(path.dirname(file));
  const hue = (seed * 47 + 210) % 360;
  const top = hslToRgb(hue, 0.42, 0.1);
  const bottom = hslToRgb((hue + 38) % 360, 0.55, 0.32);
  const accent = hslToRgb((hue + 180) % 360, 0.7, 0.55);
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  const pixels = Buffer.allocUnsafe(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    const ty = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const tx = x / Math.max(1, width - 1);
      const dx = tx - 0.5;
      const dy = ty - 0.32;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 0.72);
      const glowStrength = glow * glow * 0.22;
      const noise = pseudoNoise(x, y);
      const index = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const base = top[channel]! + (bottom[channel]! - top[channel]!) * ty;
        const value = base + accent[channel]! * glowStrength + noise;
        pixels[index + channel] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
  }

  await fs.writeFile(file, Buffer.concat([header, pixels]));
}

/** 为每个分镜生成稳定但不同的背景色，避免整条视频观感重复。 */
export function backgroundSeed(index: number, topic: string): number {
  let hash = 17;
  for (const char of topic) hash = (hash * 31 + char.codePointAt(0)!) % 1_000_003;
  return (hash + index * 37) % 360;
}