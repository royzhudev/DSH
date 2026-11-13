import { z } from "zod";
import { AppError } from "../errors.js";
import type { Script, ScriptSegment } from "../types.js";
import { normalizeTagList, truncate } from "../util/text.js";

const lineSchema = z.object({
  speaker: z.string().min(1),
  text: z.string().min(1),
});

const segmentSchema = z.object({
  narration: z.string().optional(),
  lines: z.array(lineSchema).optional(),
  keywords: z.array(z.string()).optional(),
  durationHintSec: z.number().positive().optional(),
  onScreenText: z.string().optional(),
  scene: z.string().optional(),
  shot: z.string().optional(),
  cast: z.array(z.string()).optional(),
});

const scriptSchema = z.object({
  title: z.string().min(1),
  summary: z.string().optional(),
  segments: z.array(segmentSchema).min(2).max(12),
});

export interface NormalizeOptions {
  provider: string;
  topic: string;
  maxSegments: number;
}

/** 去掉 ```json 围栏、前后说明文字，提取第一个完整 JSON 对象。 */
export function extractJsonObject(raw: string): string {
  const text = raw.replace(/^\uFEFF/, "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new AppError("模型输出中找不到 JSON 对象", { code: "SCRIPT_PARSE_FAILED" });
  }
  return candidate.slice(start, end + 1);
}

export function parseScriptJson(raw: string): unknown {
  const json = extractJsonObject(raw);
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new AppError(`脚本 JSON 解析失败：${truncate(raw, 200)}`, {
      code: "SCRIPT_PARSE_FAILED",
      cause: error,
    });
  }
}

function cleanNarration(text: string): string {
  return text
    .replace(/^\s*(?:\d+[.、)]|[-*•])\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitOverlongNarration(narration: string, maxChars = 110): string[] {
  if (narration.length <= maxChars) return [narration];
  const sentences = narration.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [narration];
  const parts: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxChars) {
      parts.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length > 0 ? parts : [narration];
}

export function normalizeScript(value: unknown, options: NormalizeOptions): Script {
  const parsed = scriptSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(`脚本结构不符合要求：${parsed.error.issues[0]?.message ?? "未知错误"}`, {
      code: "SCRIPT_INVALID",
    });
  }

  const segments: ScriptSegment[] = [];
  for (const raw of parsed.data.segments) {
    const lines = (raw.lines ?? [])
      .map((line) => ({ speaker: line.speaker.trim(), text: cleanNarration(line.text) }))
      .filter((line) => line.speaker && line.text)
      .slice(0, 8);
    const narration = cleanNarration(
      raw.narration ?? (lines.length > 0 ? lines.map((line) => `${line.speaker}：${line.text}`).join(" ") : ""),
    );
    if (!narration && lines.length === 0) continue;
    const keywords = normalizeTagList(raw.keywords ?? []).slice(0, 6);
    const scene = raw.scene?.trim().slice(0, 200);
    const shot = raw.shot?.trim().slice(0, 400);
    const cast = normalizeTagList(raw.cast ?? []).slice(0, 10);
    const speakers = [...new Set(lines.map((line) => line.speaker))];
    const finalCast = normalizeTagList([...(raw.cast ?? []), ...speakers]).slice(0, 10);
    const base = {
      keywords,
      durationHintSec: raw.durationHintSec,
      ...(scene ? { scene } : {}),
      ...(shot ? { shot } : {}),
      ...(finalCast.length > 0 ? { cast: finalCast } : {}),
      ...(lines.length > 0 ? { lines } : {}),
    };
    if (lines.length > 0) {
      segments.push({ id: segments.length + 1, narration, ...base });
      continue;
    }
    for (const piece of splitOverlongNarration(narration)) {
      segments.push({ id: segments.length + 1, narration: piece, ...base });
    }
  }

  // 模型有时把同一句台词写进好几个分镜，成片就会同一句反复出现。
  // 这里按“说话人+台词”全片去重，只保留第一次出现；分镜台词被清空的整段丢掉。
  const seenLines = new Set<string>();
  for (const segment of segments) {
    if (!segment.lines || segment.lines.length === 0) continue;
    const kept = segment.lines.filter((line) => {
      const key = `${line.speaker}：${line.text}`;
      if (line.text.length >= 4 && seenLines.has(key)) return false;
      seenLines.add(key);
      return true;
    });
    if (kept.length !== segment.lines.length) {
      segment.lines = kept;
      segment.narration = kept.map((line) => `${line.speaker}：${line.text}`).join(" ");
    }
  }
  const withoutRepeatedLines = segments.filter(
    (segment) => segment.lines === undefined || segment.lines.length > 0,
  );
  const droppedLines = segments.length - withoutRepeatedLines.length;
  segments.length = 0;
  segments.push(...withoutRepeatedLines);

  // 模型偶尔把同一句台词（连同同一个场景/镜头）重复输出，成片就会变成“同一个镜头来回放”。
  // 台词相同就算重复（场景/镜头措辞不同也算），只保留第一次出现的那条。
  const seenSegments = new Set<string>();
  const uniqueSegments = segments.filter((segment) => {
    const isDialogue = (segment.lines ?? []).length > 0;
    const lineKey = (segment.lines ?? [])
      .map((line) => `${line.speaker}：${line.text}`.replace(/\s+/g, ""))
      .join("|");
    // 对话模式按台词判重：台词一样就是同一场戏，场景/镜头换个说法也算重复；
    // 旁白模式仍按“旁白+场景+镜头”判重，同样的旁白可以在不同画面里出现。
    const key = isDialogue
      ? lineKey
      : [segment.narration, segment.scene ?? "", segment.shot ?? ""].join("\u0000");
    if (seenSegments.has(key)) return false;
    seenSegments.add(key);
    return true;
  });
  const droppedSegments = segments.length - uniqueSegments.length + droppedLines;
  if (droppedSegments > 0) {
    if (uniqueSegments.length < 2) {
      throw new AppError(
        "脚本模型把同一段内容重复输出了好几遍，去掉重复后只剩 1 个分镜；这样生成的片子会一直是同一个镜头，请重试或补充剧情细节。",
        { code: "SCRIPT_DUPLICATED" },
      );
    }
    segments.length = 0;
    segments.push(...uniqueSegments);
  }

  if (segments.length < 2) {
    throw new AppError("脚本至少需要 2 个有效分镜", { code: "SCRIPT_INVALID" });
  }

  const limited = segments.slice(0, Math.max(2, options.maxSegments)).map((segment, index) => ({
    ...segment,
    id: index + 1,
  }));

  const title = parsed.data.title.trim() || options.topic;
  return {
    title: truncate(title, 80),
    summary: (parsed.data.summary ?? "").trim(),
    segments: limited,
    provider: options.provider,
    ...(droppedSegments > 0 ? { droppedSegments } : {}),
  };
}