/**
 * 台词朗读的自然度处理。
 *
 * Edge/OpenAI 这类 TTS 把整段文字一口气读完，句与句之间只有极短的机器停顿，
 * 听感就像客服播报——这是短剧配音“僵硬”的主要原因。这里把台词按标点切成小句，
 * 给每句单独的停顿、语速、音高与音量，再按顺序拼起来，接近真人一呼一吸的节奏。
 */

export interface SpeechBaseProsody {
  /** 基准语速，1 表示正常。 */
  rate: number;
  /** 基准音高，形如 "+2Hz"、"-3Hz"、"0Hz"。 */
  pitch: string;
  /** 基准音量，Edge 用百分比，0 表示不调整。 */
  volume: number;
}

export interface SpeechChunk {
  text: string;
  /** 这句话说完之后停顿多少毫秒。 */
  pauseAfterMs: number;
  rate: number;
  pitch: string;
  volume: number;
}

/** 各类标点后面的自然停顿。真人说话时逗号很短、句号稍长、情绪句之后会停一下。 */
const PAUSE_MS = {
  comma: 150,
  semicolon: 210,
  sentence: 320,
  strong: 360,
  ellipsis: 420,
  none: 0,
} as const;

const EXCITED_HINTS = ["滚", "凭什么", "胡说", "住口", "闭嘴", "竟然", "居然", "不可能", "救命", "给我"];
const SAD_HINTS = ["对不起", "算了", "走吧", "没事", "原来", "再也", "当初"];

const MIN_CLAUSE_LENGTH = 2;
const MAX_CLAUSES = 8;

/** 把一句话按标点切成朗读小句，标点保留在小句里。 */
export function splitClauses(text: string): string[] {
  const clauses: string[] = [];
  const pattern = /[^，,。.！!？?；;：:…~、\s]+[，,。.！!？?；;：:…~、]*/g;
  for (const match of text.matchAll(pattern)) {
    const clause = match[0].trim();
    if (clause) clauses.push(clause);
  }
  if (clauses.length === 0) {
    const fallback = text.trim();
    return fallback ? [fallback] : [];
  }
  return clauses;
}

function pauseAfter(clause: string): number {
  if (/[…]{1,}|\.{3,}/.test(clause)) return PAUSE_MS.ellipsis;
  if (/[！!？?]/.test(clause)) return PAUSE_MS.strong;
  if (/[。.]/.test(clause)) return PAUSE_MS.sentence;
  if (/[；;]/.test(clause)) return PAUSE_MS.semicolon;
  if (/[，,、：:]/.test(clause)) return PAUSE_MS.comma;
  return PAUSE_MS.none;
}

function parsePitchHz(pitch: string): number {
  const match = pitch.match(/(-?\d+(?:\.\d+)?)\s*Hz/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
}

function formatPitchHz(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return "0Hz";
  return `${rounded > 0 ? "+" : ""}${rounded}Hz`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 单句的情绪微调：情绪词与标点决定快慢高低，短句略放慢，避免念得又急又平。 */
export function emotionProsody(clause: string): { rate: number; pitchHz: number; volume: number } {
  const excited = /[！!]/.test(clause) || EXCITED_HINTS.some((hint) => clause.includes(hint));
  const question = /[？?]/.test(clause);
  const sad = SAD_HINTS.some((hint) => clause.includes(hint));
  const trailing = /[…]{1,}|\.{3,}/.test(clause);

  let rate = 1;
  let pitchHz = 0;
  let volume = 0;

  if (excited) {
    rate = 1.08;
    pitchHz = 2;
    volume = 3;
  } else if (question) {
    rate = 0.97;
    pitchHz = 3;
  } else if (trailing) {
    rate = 0.9;
    pitchHz = -1;
  } else if (sad) {
    rate = 0.92;
    pitchHz = -2;
    volume = -2;
  }

  const plain = clause.replace(/[，,。.！!？?；;：:…~、]/g, "");
  if (plain.length > 0 && plain.length <= 5) {
    rate *= 0.96;
  }

  return { rate, pitchHz, volume };
}

/**
 * 把一段台词排成带停顿的朗读计划：每句的停顿、语速、音高、音量都已确定。
 * 分句过多时合并末尾几段，避免把一句台词切得太碎、合成调用过多。
 */
export function planSpeech(text: string, base: SpeechBaseProsody): SpeechChunk[] {
  const clauses = splitClauses(text).filter((clause) => clause.length >= MIN_CLAUSE_LENGTH);
  if (clauses.length === 0) {
    const fallback = text.trim();
    return fallback
      ? [{ text: fallback, pauseAfterMs: 0, rate: base.rate, pitch: base.pitch, volume: base.volume }]
      : [];
  }

  const merged =
    clauses.length > MAX_CLAUSES
      ? [...clauses.slice(0, MAX_CLAUSES - 1), clauses.slice(MAX_CLAUSES - 1).join("")]
      : clauses;

  const basePitchHz = parsePitchHz(base.pitch);
  return merged.map((clause, index) => {
    const emotion = emotionProsody(clause);
    return {
      text: clause,
      pauseAfterMs: index === merged.length - 1 ? 0 : pauseAfter(clause),
      rate: clamp(Number((base.rate * emotion.rate).toFixed(3)), 0.5, 2),
      pitch: formatPitchHz(basePitchHz + emotion.pitchHz),
      volume: clamp(base.volume + emotion.volume, -50, 50),
    };
  });
}

/** 两名角色交接台词时的停顿：太短像抢话，太长像念稿。 */
export function turnGapMs(previousSpeaker: string, nextSpeaker: string): number {
  return previousSpeaker === nextSpeaker ? 90 : 220;
}