/** 估算字幕显示宽度：中日韩字符按 1 计，拉丁字符按 0.55 计。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (/\s/.test(char)) {
      width += 0.3;
    } else if (/[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(char)) {
      width += 1;
    } else {
      width += 0.55;
    }
  }
  return width;
}

/** 按中文/英文标点切句，保留标点。 */
export function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const sentences: string[] = [];
  let buffer = "";
  for (const char of normalized) {
    buffer += char;
    if ("。！？!?；;…".includes(char)) {
      if (buffer.trim()) sentences.push(buffer.trim());
      buffer = "";
    }
  }
  if (buffer.trim()) sentences.push(buffer.trim());
  return sentences;
}

function hardWrap(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const char of text) {
    current += char;
    if (displayWidth(current) >= maxChars) {
      chunks.push(current);
      current = "";
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/** 把一段长句按标点优先切成不超过 maxChars 的片段。 */
export function splitLongSentence(sentence: string, maxChars: number): string[] {
  if (displayWidth(sentence) <= maxChars) return [sentence.trim()].filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  let lastBreak = -1;
  for (const char of sentence) {
    current += char;
    if ("，,、：:；;！？!?。. ".includes(char)) lastBreak = current.length;
    if (displayWidth(current) >= maxChars) {
      if (lastBreak > 0 && lastBreak >= Math.floor(current.length * 0.5)) {
        chunks.push(current.slice(0, lastBreak).trim());
        current = current.slice(lastBreak);
      } else {
        chunks.push(current.trim());
        current = "";
      }
      lastBreak = -1;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.flatMap((chunk) => (displayWidth(chunk) > maxChars ? hardWrap(chunk, maxChars) : [chunk]));
}

/** 把口播文案切成字幕事件：每屏最多 maxLines 行，每行最多 maxCharsPerLine。 */
export function splitIntoSubtitleChunks(
  text: string,
  maxCharsPerLine: number,
  maxLines: number,
): string[] {
  const maxChars = Math.max(1, maxCharsPerLine) * Math.max(1, maxLines);
  const sentences = splitIntoSentences(text);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (displayWidth(sentence) <= maxChars) {
      chunks.push(sentence);
    } else {
      chunks.push(...splitLongSentence(sentence, maxChars));
    }
  }
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/** 在字幕事件内插入换行，避免 libass 自动换行到画面外。 */
export function wrapSubtitleText(text: string, maxCharsPerLine: number): string {
  const lines: string[] = [];
  let current = "";
  for (const char of text.trim()) {
    current += char;
    if (displayWidth(current) >= maxCharsPerLine) {
      lines.push(current);
      current = "";
    }
  }
  if (current) lines.push(current);
  return lines.join("\\N");
}

/** 去掉 ASS 中有特殊含义的字符，保留可读性。 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "＼")
    .replace(/{/g, "｛")
    .replace(/}/g, "｝")
    .replace(/\r?\n/g, " ");
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatAssTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalCentis = Math.round(clamped * 100);
  const cs = totalCentis % 100;
  const totalSeconds = Math.floor(totalCentis / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function formatSrtTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalMillis = Math.round(clamped * 1000);
  const ms = totalMillis % 1000;
  const totalSeconds = Math.floor(totalMillis / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/** 从文件名生成素材标题与标签，例如 city-night_01.mp4 → ["city","night","01"]。 */
export function tagsFromFilename(filename: string): string[] {
  const base = filename.replace(/\.[^.]+$/, "");
  return base
    .split(/[\s_\-.()（）[\]【】]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.length <= 20)
    .slice(0, 12);
}

export function normalizeTagList(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim().replace(/^#/, "");
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}