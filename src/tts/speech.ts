import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import { concatAudio, probeMedia } from "../media/ffmpeg.js";
import { ensureDir, sha256 } from "../util/fs.js";
import type { TtsProvider, TtsResult } from "../types.js";
import { planSpeech, type SpeechBaseProsody } from "./prosody.js";

export interface SpeechPiecesInput {
  provider: TtsProvider;
  text: string;
  /** 发音用的基础语速/音高/音量（已按人物设定算好）。 */
  base: SpeechBaseProsody;
  /** 生成/复用静音文件：传入已有实现可以共享停顿缓存。 */
  silenceFor: (seconds: number) => Promise<string>;
  signal?: AbortSignal;
  /** 这段台词之后额外留的停顿（角色交接时用）。 */
  trailingPauseMs?: number;
}

export interface SpeechPiecesResult {
  /** 依次为「小句音频、停顿、小句音频、停顿…」的文件列表。 */
  pieces: string[];
  /** 音频 + 停顿合计时长。 */
  durationSec: number;
  /** 只算朗读音频本身的时长，不含停顿。 */
  speechSec: number;
  cached: boolean;
  /** 实际合成的分句数。 */
  chunks: number;
}

export interface NaturalSpeechInput extends SpeechPiecesInput {
  /** 输出文件路径（mp3）。 */
  outputFile: string;
}

export interface NaturalSpeechResult {
  audioPath: string;
  durationSec: number;
  cached: boolean;
  chunks: number;
}

function cacheKeyFor(
  provider: TtsProvider,
  chunkText: string,
  chunk: { rate: number; pitch: string; volume: number },
  extra: string,
): string {
  return sha256(
    [provider.name, provider.voice, chunkText, String(chunk.rate), chunk.pitch, String(chunk.volume), extra].join("|"),
  ).slice(0, 40);
}

/**
 * 把一段台词拆成带停顿的音频片段：按标点切小句、逐句合成、句间插入静音。
 * 整段一口气读出来是“机械播报感”的最大来源——句子之间没有呼吸，
 * 也不会因为标点改变节奏；切成小句后每句还能单独调快慢高低。
 */
export async function synthesizeSpeechPieces(input: SpeechPiecesInput): Promise<SpeechPiecesResult> {
  const { provider, text, base, silenceFor, signal, trailingPauseMs = 0 } = input;
  const chunks = planSpeech(text, base);
  if (chunks.length === 0) {
    throw new AppError("台词为空，无法配音", { code: "TTS_EMPTY_TEXT", status: 400 });
  }

  const pieces: string[] = [];
  let cached = true;
  let totalSec = 0;
  let speechSec = 0;

  const pushSilence = async (ms: number): Promise<void> => {
    if (ms <= 0) return;
    pieces.push(await silenceFor(ms / 1000));
    totalSec += ms / 1000;
  };

  for (const [index, chunk] of chunks.entries()) {
    if (signal?.aborted) throw new AppError("任务已取消", { code: "ABORTED", status: 499 });
    const result: TtsResult = await provider.synthesize(
      {
        text: chunk.text,
        cacheKey: cacheKeyFor(provider, chunk.text, chunk, base.pitch),
        rate: chunk.rate,
        ...(chunk.volume !== 0 ? { volume: chunk.volume } : {}),
        ...(chunk.pitch !== "0Hz" ? { pitch: chunk.pitch } : {}),
      },
      signal,
    );
    cached = cached && result.cached;
    pieces.push(result.audioPath);
    totalSec += result.durationSec;
    speechSec += result.durationSec;
    if (index < chunks.length - 1) await pushSilence(chunk.pauseAfterMs);
  }

  await pushSilence(trailingPauseMs);
  return { pieces, durationSec: totalSec, speechSec, cached, chunks: chunks.length };
}

/** 单段朗读：拆句 + 句间停顿后拼成一条音轨（旁白用）。 */
export async function synthesizeNaturalSpeech(input: NaturalSpeechInput): Promise<NaturalSpeechResult> {
  const { outputFile, ...rest } = input;
  const planned = await synthesizeSpeechPieces(rest);
  await ensureDir(path.dirname(outputFile));
  if (planned.pieces.length === 1) {
    await fs.copyFile(planned.pieces[0]!, outputFile);
  } else {
    await concatAudio(planned.pieces, outputFile);
  }
  const probe = await probeMedia(outputFile);
  return {
    audioPath: outputFile,
    durationSec: probe.durationSec ?? planned.durationSec,
    cached: planned.cached,
    chunks: planned.chunks,
  };
}