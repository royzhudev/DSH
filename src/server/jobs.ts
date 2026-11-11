import type { AppConfig, JobProgress, PipelineResult } from "../types.js";
import type { Logger } from "../logger.js";
import { createJobId, runPipeline } from "../pipeline.js";
import { toErrorMessage } from "../errors.js";

export type JobState = "queued" | "running" | "succeeded" | "failed";

export interface JobRecord {
  id: string;
  topic: string;
  state: JobState;
  progress: JobProgress;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: PipelineResult;
  error?: string;
}

export interface SerializedJob {
  id: string;
  topic: string;
  state: JobState;
  progress: JobProgress;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationSec?: number;
  videoUrl?: string;
  subtitlesUrl?: string;
  scriptUrl?: string;
  resultUrl?: string;
  error?: string;
}

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly queue: string[] = [];
  private draining = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  create(topic: string): JobRecord {
    const id = createJobId();
    const record: JobRecord = {
      id,
      topic,
      state: "queued",
      progress: { stage: "queued", percent: 0, message: "等待执行" },
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(id, record);
    this.queue.push(id);
    this.logger.info(`任务入队：${id}（${topic}）`);
    setImmediate(() => {
      void this.drain();
    });
    return record;
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  serialize(record: JobRecord): SerializedJob {
    const base = `/api/videos/${record.id}`;
    return {
      id: record.id,
      topic: record.topic,
      state: record.state,
      progress: record.progress,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationSec: record.result?.durationSec,
      videoUrl: record.state === "succeeded" ? `${base}/video` : undefined,
      subtitlesUrl: record.state === "succeeded" ? `${base}/subtitles` : undefined,
      scriptUrl: record.state === "succeeded" ? `${base}/script` : undefined,
      resultUrl: record.state === "succeeded" ? `${base}/result` : undefined,
      error: record.error,
    };
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        const record = this.jobs.get(id);
        if (!record) continue;
        record.state = "running";
        record.startedAt = new Date().toISOString();
        record.progress = { stage: "script", percent: 1, message: "开始生成" };
        this.logger.info(`任务开始：${id}`);
        try {
          const result = await runPipeline({
            topic: record.topic,
            config: this.config,
            logger: this.logger,
            jobId: id,
            onProgress: (progress) => {
              record.progress = progress;
            },
          });
          record.result = result;
          record.state = "succeeded";
          record.finishedAt = new Date().toISOString();
          record.progress = { stage: "done", percent: 100, message: "成片已生成" };
          this.logger.info(`任务完成：${id}（${result.durationSec.toFixed(1)}s）`);
        } catch (error) {
          record.state = "failed";
          record.error = toErrorMessage(error);
          record.finishedAt = new Date().toISOString();
          record.progress = { ...record.progress, message: "任务失败" };
          this.logger.error(`任务失败：${id}`, error);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}