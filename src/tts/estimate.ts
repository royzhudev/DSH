import type { TtsSentence } from "../types.js";
import { displayWidth, splitIntoSentences } from "../util/text.js";

/** 没有精确时间戳时，按字符数估算中文口播时长。 */
export function estimateSpeechDuration(text: string): number {
  const width = displayWidth(text);
  const seconds = width / 4.3 + 0.7;
  return Math.max(1.2, Number(seconds.toFixed(2)));
}

/** 按句子字符占比切分整段音频时长，用于非 Edge 供应商的字幕对齐。 */
export function estimateSentences(text: string, durationSec: number): TtsSentence[] {
  const sentences = splitIntoSentences(text);
  if (sentences.length === 0) return [];
  const weights = sentences.map((sentence) => Math.max(1, displayWidth(sentence)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;
  return sentences.map((sentence, index) => {
    const startSec = cursor;
    const endSec =
      index === sentences.length - 1
        ? durationSec
        : Math.min(durationSec, cursor + (durationSec * weights[index]!) / totalWeight);
    cursor = endSec;
    return { text: sentence, startSec, endSec };
  });
}

interface EdgeMetadataFile {
  Metadata?: Array<{
    Type?: string;
    Data?: {
      Offset?: number;
      Duration?: number;
      text?: { Text?: string };
    };
  }>;
}

/** Edge TTS 的 Offset/Duration 单位是 100ns tick。 */
export function parseEdgeMetadata(raw: string, fallbackText: string, durationSec: number): TtsSentence[] {
  try {
    const parsed = JSON.parse(raw) as EdgeMetadataFile;
    const items = parsed.Metadata ?? [];
    const sentences: TtsSentence[] = [];
    for (const item of items) {
      if (item.Type !== "SentenceBoundary" || !item.Data) continue;
      const text = item.Data.text?.Text?.trim();
      if (!text) continue;
      const startSec = Math.max(0, (item.Data.Offset ?? 0) / 10_000_000);
      const endSec = Math.min(durationSec, startSec + Math.max(0.1, (item.Data.Duration ?? 0) / 10_000_000));
      if (endSec <= startSec) continue;
      sentences.push({ text, startSec, endSec });
    }
    if (sentences.length > 0) return sentences;
  } catch {
    // 元数据解析失败时退回按字符估算，不影响出片。
  }
  return estimateSentences(fallbackText, durationSec);
}