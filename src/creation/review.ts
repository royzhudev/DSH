import type { ScriptSegment } from "../types.js";

/**
 * 创作品控：把短剧行业的硬性经验（钩子、节奏、景别、人物一致性、
 * 合规与投放归属）落成可执行的检查项。
 *
 * 这里只做“本地启发式”判断，不调用任何模型、不产生费用；结论是提醒，
 * 不替代人工判断——平台负责生成与合成，选题、备案、版权、投放仍由人负责。
 */

export type ReviewStage = "plan" | "script" | "storyboard" | "assets" | "publish";
export type ReviewLevel = "ok" | "warn" | "todo";

export interface ReviewItem {
  id: string;
  stage: ReviewStage;
  level: ReviewLevel;
  title: string;
  detail: string;
}

export interface ReviewCastEntry {
  name: string;
  kind?: string;
  imageFile?: string | null;
}

export interface ReviewSegment {
  id: number;
  narration: string;
  shot?: string;
  cast?: string[];
  durationHintSec?: number;
}

export interface ReviewInput {
  topic: string;
  story?: string;
  targetDurationSec: number;
  segments: ReviewSegment[];
  cast?: ReviewCastEntry[];
}

export interface CreationReview {
  score: number;
  items: ReviewItem[];
}

export const REVIEW_STAGE_LABELS: Record<ReviewStage, string> = {
  plan: "策划",
  script: "剧本",
  storyboard: "分镜",
  assets: "素材",
  publish: "发布",
};

/** 结尾钩子：疑问、感叹、省略号，或常见的反转/悬念提示词。 */
const HOOK_END = /[？！?!…]$/;
const HOOK_WORDS = /(竟然|没想到|原来|突然|居然|难道|谁知|就在这时|可偏偏|反转)/;

const SHOT_SIZE = /(大特写|特写|近景|中景|全景|远景|空镜)/;

function hookCheck(segments: ReviewSegment[]): ReviewItem {
  const last = segments.at(-1);
  const text = last?.narration?.trim() ?? "";
  const hasHook = HOOK_END.test(text) || HOOK_WORDS.test(text);
  return {
    id: "hook",
    stage: "script",
    level: hasHook ? "ok" : "warn",
    title: hasHook ? "结尾有钩子" : "结尾钩子偏弱",
    detail: hasHook
      ? "最后一句留了悬念/反转，符合短剧“每集结尾抓人”的节奏。"
      : "短剧靠结尾钩子留人：建议最后一句改成疑问、反转或“下一集才揭晓”的悬念，而不是把话说满。",
  };
}

function dialogueCheck(segments: ReviewSegment[]): ReviewItem {
  let longest = 0;
  for (const segment of segments) {
    for (const sentence of (segment.narration ?? "").split(/[，。！？；：,.!?;]/)) {
      longest = Math.max(longest, [...sentence.trim()].length);
    }
  }
  // 数字人/配音按句朗读，超过 30 字容易一口气读不完、字幕也会挤。
  const level: ReviewLevel = longest > 30 ? "warn" : "ok";
  return {
    id: "dialogue",
    stage: "script",
    level,
    title: level === "ok" ? "台词适合口播" : "台词偏长",
    detail:
      level === "ok"
        ? "单句都在 30 字以内，配音与字幕节奏更好控制。"
        : `最长一句 ${longest} 字，配音容易赶、字幕会挤；建议拆成 2～3 句，每句 30 字以内。`,
  };
}

function shotCheck(segments: ReviewSegment[]): ReviewItem {
  if (segments.length === 1) {
    return {
      id: "shots",
      stage: "storyboard",
      level: "ok",
      title: "一镜到底",
      detail: "只安排了一个连续镜头，不切机位；用人物动作、走位和光线变化保持画面信息量。",
    };
  }
  const sizes = new Set<string>();
  for (const segment of segments) {
    const match = (segment.shot ?? "").match(SHOT_SIZE);
    if (match) sizes.add(match[1]!);
  }
  const level: ReviewLevel = sizes.size >= 2 ? "ok" : "warn";
  return {
    id: "shots",
    stage: "storyboard",
    level,
    title: level === "ok" ? `景别有变化（${[...sizes].join("、")}）` : "景别单一",
    detail:
      level === "ok"
        ? "分镜里出现了多种景别，画面不会一路中景到底。"
        : "所有镜头景别接近，成片容易“一个机位拍到底”。建议至少安排特写（情绪）+ 近景（对话）+ 全景（场景交代）。",
  };
}

function paceCheck(input: ReviewInput): ReviewItem {
  const count = Math.max(1, input.segments.length);
  const average = input.targetDurationSec / count;
  const durations = input.segments
    .map((segment) => segment.durationHintSec)
    .filter((value): value is number => typeof value === "number" && value > 0);
  const spread = durations.length > 1 ? Math.max(...durations) - Math.min(...durations) : 0;
  if (average > 10) {
    return {
      id: "pace",
      stage: "storyboard",
      level: "warn",
      title: "单个镜头偏长",
      detail: `平均每个镜头 ${average.toFixed(1)} 秒，AI 生成的画面容易拖沓。短剧建议每镜 4～8 秒，把长段落拆成多个镜头。`,
    };
  }
  if (spread > 6) {
    return {
      id: "pace",
      stage: "storyboard",
      level: "warn",
      title: "镜头时长落差大",
      detail: `最长与最短镜头相差 ${spread} 秒，节奏会忽快忽慢；建议把超过 8 秒的镜头拆开。`,
    };
  }
  return {
    id: "pace",
    stage: "storyboard",
    level: "ok",
    title: "节奏基本均衡",
    detail: `平均每个镜头 ${average.toFixed(1)} 秒，接近短剧常见的 4～8 秒。`,
  };
}

function consistencyCheck(input: ReviewInput): ReviewItem {
  const cast = input.cast ?? [];
  const withImage = new Map(cast.filter((item) => item.imageFile).map((item) => [item.name, item]));
  const referenced = new Set<string>();
  for (const segment of input.segments) {
    for (const name of segment.cast ?? []) referenced.add(name);
  }
  const missing = [...referenced].filter((name) => !withImage.has(name));
  if (missing.length > 0) {
    const names = missing.slice(0, 3).join("、");
    return {
      id: "consistency",
      stage: "assets",
      level: "warn",
      title: "有人物没有参考图",
      detail: `${names} 还没有上传参考图，跨镜头容易变脸。给主要角色和关键道具各配一张参考图，并在每个分镜里保持同一套外观描述。`,
    };
  }
  if (referenced.size === 0) {
    return {
      id: "consistency",
      stage: "assets",
      level: "warn",
      title: "没有锁定人物形象",
      detail:
        "这条视频没有指定角色，画面里的人物每次生成都可能不同。对话类短剧建议先建角色卡（参考图 + 外观设定），再让分镜引用。",
    };
  }
  return {
    id: "consistency",
    stage: "assets",
    level: "ok",
    title: "人物形象已锁定",
    detail: `出现的 ${referenced.size} 个角色/道具都有参考图，图生视频会沿用同一形象。成片后仍建议人工检查有没有换脸、画风跳变。`,
  };
}

function planCheck(input: ReviewInput): ReviewItem {
  const topicLength = [...input.topic.trim()].length;
  const hasStory = Boolean(input.story?.trim());
  if (topicLength < 8) {
    return {
      id: "topic",
      stage: "plan",
      level: "warn",
      title: "选题偏模糊",
      detail: "主题太短，AI 只能泛泛生成。写清“谁 + 遇到什么冲突 + 什么场景”，例如“外卖小哥被客户冤枉，监控揭开真相”。",
    };
  }
  if (!hasStory) {
    return {
      id: "story",
      stage: "plan",
      level: "todo",
      title: "没有剧本/大纲",
      detail:
        "将直接按主题创作，情节会比较平。短剧建议先写好人设与冲突，粘贴到“剧本/大纲”再生成，并人工打磨反转与钩子。",
    };
  }
  return {
    id: "story",
    stage: "plan",
    level: "ok",
    title: "选题与剧本已就位",
    detail: "已提供主题与剧本/大纲，分镜会按你的故事改编；成稿仍建议人工检查逻辑与台词。",
  };
}

function publishChecks(): ReviewItem[] {
  return [
    {
      id: "publish-compliance",
      stage: "publish",
      level: "todo",
      title: "备案与版权需自己确认",
      detail:
        "平台不负责备案与资质：付费分账短剧要按目标平台要求完成备案；素材、数字人形象、音乐的商用授权需要自己确认。",
    },
    {
      id: "publish-cover",
      stage: "publish",
      level: "todo",
      title: "封面与投放仍需人工",
      detail:
        "前 3 秒决定完播率：成片后人工挑封面、标题与高光片段；平台不会替你判断哪个封面点击率高，也不负责投流与数据复盘。",
    },
  ];
}

/** 打分只统计能改进的项（ok/warn），发布类提醒不计入分数。 */
function scoreOf(items: ReviewItem[]): number {
  const graded = items.filter((item) => item.level !== "todo");
  if (graded.length === 0) return 100;
  const ok = graded.filter((item) => item.level === "ok").length;
  return Math.round((ok / graded.length) * 100);
}

export function reviewCreation(input: ReviewInput): CreationReview {
  const segments = input.segments ?? [];
  const items: ReviewItem[] = [
    planCheck(input),
    hookCheck(segments),
    dialogueCheck(segments),
    shotCheck(segments),
    paceCheck(input),
    consistencyCheck(input),
    ...publishChecks(),
  ];
  return { score: scoreOf(items), items };
}