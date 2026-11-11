import type { SubtitleCue, SubtitleStyle, TtsSentence, VideoInfo } from "../types.js";
import {
  displayWidth,
  escapeAssText,
  formatAssTime,
  formatSrtTime,
  splitIntoSubtitleChunks,
  wrapSubtitleText,
} from "../util/text.js";

export interface BuildCuesOptions {
  narration: string;
  sentences: TtsSentence[] | undefined;
  audioDurationSec: number;
  style: SubtitleStyle;
}

function allocateSentence(
  sentence: TtsSentence,
  style: SubtitleStyle,
  cues: SubtitleCue[],
): void {
  const chunks = splitIntoSubtitleChunks(
    sentence.text,
    style.maxCharsPerLine,
    style.maxLines,
  );
  if (chunks.length === 0) return;
  const weights = chunks.map((chunk) => Math.max(1, displayWidth(chunk)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const start = Math.max(0, sentence.startSec);
  const end = Math.max(start, sentence.endSec);
  const duration = end - start;
  let cursor = start;
  for (let index = 0; index < chunks.length; index += 1) {
    const isLast = index === chunks.length - 1;
    const cueEnd = isLast ? end : Math.min(end, cursor + (duration * weights[index]!) / totalWeight);
    if (cueEnd - cursor >= 0.08) {
      cues.push({ startSec: cursor, endSec: cueEnd, text: chunks[index]! });
    }
    cursor = cueEnd;
  }
}

/** 把一句口播拆成字幕事件；优先使用 TTS 的句级时间戳。 */
export function buildSubtitleCues(options: BuildCuesOptions): SubtitleCue[] {
  const { narration, sentences, audioDurationSec, style } = options;
  if (!style.enabled || audioDurationSec <= 0) return [];
  const usable = (sentences ?? [])
    .filter((sentence) => sentence.text.trim() && sentence.endSec > sentence.startSec)
    .map((sentence) => ({
      text: sentence.text,
      startSec: Math.min(audioDurationSec, Math.max(0, sentence.startSec)),
      endSec: Math.min(audioDurationSec, Math.max(0, sentence.endSec)),
    }))
    .filter((sentence) => sentence.endSec > sentence.startSec);

  const source: TtsSentence[] =
    usable.length > 0
      ? usable
      : (() => {
          const chunks = splitIntoSubtitleChunks(narration, 100, 1);
          const text = chunks.join("") || narration;
          return [{ text, startSec: 0, endSec: audioDurationSec }];
        })();

  const cues: SubtitleCue[] = [];
  for (const sentence of source) allocateSentence(sentence, style, cues);

  // Edge 的句级时间戳偶尔有几十毫秒重叠，顺序修正，避免两屏字幕同时出现。
  cues.sort((a, b) => a.startSec - b.startSec);
  const normalized: SubtitleCue[] = [];
  let previousEnd = 0;
  for (const cue of cues) {
    const startSec = Math.max(cue.startSec, previousEnd);
    const endSec = Math.min(cue.endSec, audioDurationSec);
    if (endSec - startSec < 0.08) continue;
    normalized.push({
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      text: cue.text,
    });
    previousEnd = endSec;
  }
  return normalized;
}

function hexToAssColor(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return "&H00FFFFFF";
  const value = match[1]!;
  const r = value.slice(0, 2);
  const g = value.slice(2, 4);
  const b = value.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

export function renderAss(cues: SubtitleCue[], style: SubtitleStyle, video: VideoInfo): string {
  const bold = style.bold ? -1 : 0;
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${video.width}
PlayResY: ${video.height}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontFamily},${style.fontSize},${hexToAssColor(style.primaryColor)},&H000000FF,${hexToAssColor(style.outlineColor)},&H80000000,${bold},0,0,0,100,100,0,0,1,${style.outline},${style.shadow},2,80,80,${style.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = cues.map((cue) => {
    const text = wrapSubtitleText(escapeAssText(cue.text), style.maxCharsPerLine);
    return `Dialogue: 0,${formatAssTime(cue.startSec)},${formatAssTime(cue.endSec)},Default,,0,0,0,,${text}`;
  });
  return `${header}${events.join("\n")}\n`;
}

export function renderSrt(cues: Array<SubtitleCue & { startOffsetSec: number }>): string {
  return `${cues
    .map((cue, index) => {
      const start = cue.startOffsetSec + cue.startSec;
      const end = cue.startOffsetSec + cue.endSec;
      return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${cue.text}\n`;
    })
    .join("\n")}\n`;
}