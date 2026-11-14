import { AppError } from "../errors.js";
import type { DialogueLine, Script, ScriptSegment } from "../types.js";

/**
 * 用户在创作页预览后手工修改过的脚本。
 *
 * 预览接口返回的 Script 允许直接编辑标题、摘要、每段旁白/台词、画面与关键词；
 * 开始生成时把修改后的结构回传，成片严格按这份脚本走，不再重新调用模型。
 * 这里做一次严格收敛：字段缺失/类型不对/为空的分镜都拒绝，避免把坏数据写进任务。
 */

const MAX_TITLE = 80;
const MAX_SUMMARY = 300;
const MAX_SEGMENTS = 20;
const MAX_NARRATION = 800;
const MAX_LINE_TEXT = 300;
const MAX_SPEAKER = 24;
const MAX_SHOT = 300;
const MAX_KEYWORDS = 12;
const MAX_KEYWORD = 24;
const MAX_CAST = 12;

function text(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new AppError(`${label}必须是文本`, { code: "INVALID_SCRIPT", status: 400 });
  }
  const trimmed = value.trim();
  if (!trimmed && !allowEmpty) {
    throw new AppError(`${label}不能为空`, { code: "INVALID_SCRIPT", status: 400 });
  }
  if (trimmed.length > max) {
    throw new AppError(`${label}不能超过 ${max} 个字符`, { code: "INVALID_SCRIPT", status: 400 });
  }
  return trimmed;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, label, max);
}

function normalizeLines(value: unknown, index: number): DialogueLine[] {
  if (!Array.isArray(value)) {
    throw new AppError(`分镜 ${index + 1} 的台词格式不正确`, { code: "INVALID_SCRIPT", status: 400 });
  }
  if (value.length === 0) return [];
  return value.map((raw, lineIndex) => {
    if (typeof raw !== "object" || raw === null) {
      throw new AppError(`分镜 ${index + 1} 第 ${lineIndex + 1} 句台词格式不正确`, {
        code: "INVALID_SCRIPT",
        status: 400,
      });
    }
    const line = raw as Record<string, unknown>;
    return {
      speaker: text(line.speaker, `分镜 ${index + 1} 第 ${lineIndex + 1} 句的说话人`, MAX_SPEAKER),
      text: text(line.text, `分镜 ${index + 1} 第 ${lineIndex + 1} 句台词`, MAX_LINE_TEXT),
    };
  });
}

function normalizeSegment(raw: unknown, index: number): ScriptSegment {
  if (typeof raw !== "object" || raw === null) {
    throw new AppError(`分镜 ${index + 1} 格式不正确`, { code: "INVALID_SCRIPT", status: 400 });
  }
  const segment = raw as Record<string, unknown>;
  const lines = normalizeLines(segment.lines ?? [], index);
  const narration = optionalText(segment.narration, `分镜 ${index + 1} 的旁白`, MAX_NARRATION);
  if (!narration && lines.length === 0) {
    throw new AppError(`分镜 ${index + 1} 需要旁白或台词`, { code: "INVALID_SCRIPT", status: 400 });
  }
  const keywords = Array.isArray(segment.keywords)
    ? segment.keywords
        .filter((keyword): keyword is string => typeof keyword === "string")
        .map((keyword) => keyword.trim())
        .filter(Boolean)
        .slice(0, MAX_KEYWORDS)
        .map((keyword) => text(keyword, `分镜 ${index + 1} 的画面关键词`, MAX_KEYWORD))
    : [];
  const cast = Array.isArray(segment.cast)
    ? segment.cast
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.trim())
        .filter(Boolean)
        .slice(0, MAX_CAST)
    : [];
  const durationHintSec = segment.durationHintSec;
  return {
    id: index + 1,
    narration: narration ?? lines.map((line) => `${line.speaker}：${line.text}`).join(""),
    keywords,
    ...(typeof durationHintSec === "number" && Number.isFinite(durationHintSec) && durationHintSec > 0
      ? { durationHintSec: Math.min(120, Math.max(1, Math.round(durationHintSec * 10) / 10)) }
      : {}),
    ...(optionalText(segment.scene, `分镜 ${index + 1} 的场景`, MAX_SHOT) ? { scene: optionalText(segment.scene, `分镜 ${index + 1} 的场景`, MAX_SHOT)! } : {}),
    ...(optionalText(segment.shot, `分镜 ${index + 1} 的镜头`, MAX_SHOT) ? { shot: optionalText(segment.shot, `分镜 ${index + 1} 的镜头`, MAX_SHOT)! } : {}),
    ...(cast.length > 0 ? { cast } : {}),
    ...(lines.length > 0 ? { lines } : {}),
  };
}

/** 校验并收敛一份手工修改的脚本；不合法时抛 400，避免带病入队。 */
export function normalizeDraftScript(input: unknown): Script {
  if (typeof input !== "object" || input === null) {
    throw new AppError("脚本格式不正确", { code: "INVALID_SCRIPT", status: 400 });
  }
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
    throw new AppError("脚本至少需要 1 个分镜", { code: "INVALID_SCRIPT", status: 400 });
  }
  if (raw.segments.length > MAX_SEGMENTS) {
    throw new AppError(`脚本最多 ${MAX_SEGMENTS} 个分镜`, { code: "INVALID_SCRIPT", status: 400 });
  }
  const segments = raw.segments.map((segment, index) => normalizeSegment(segment, index));
  return {
    title: text(raw.title, "标题", MAX_TITLE),
    summary: text(raw.summary, "摘要", MAX_SUMMARY, true),
    segments,
    provider: "edited",
    mode: segments.some((segment) => segment.lines?.length) ? "dialogue" : "narration",
  };
}
