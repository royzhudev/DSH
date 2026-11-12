import type { Script, ScriptProvider, ScriptRequest } from "../types.js";
import { truncate } from "../util/text.js";

const FALLBACK_TAGS = ["生活", "城市", "光影", "细节", "故事"];

/**
 * 离线脚本模板：没有配置大模型密钥时也能跑通完整链路。
 * 关键词优先使用素材库标签，提高素材命中率。
 */
export class OfflineScriptProvider implements ScriptProvider {
  readonly name = "offline";

  async generate(request: ScriptRequest): Promise<Script> {
    const topic = request.topic.trim();
    const tags = request.availableTags.length > 0 ? request.availableTags : FALLBACK_TAGS;
    const keywordsAt = (index: number): string[] => {
      const first = tags[index % tags.length]!;
      const second = tags[(index + 1) % tags.length]!;
      return first === second ? [first] : [first, second];
    };

    const narration = [
      `你有没有想过，${topic}到底藏着怎样的故事？`,
      `先从一个最普通的场景说起：${topic}，其实每天都在我们身边发生。`,
      `真正打动人的，往往是那些容易被忽略的细节。`,
      `想看懂${topic}，不妨从光线、声音和人的表情开始观察。`,
      `关于${topic}，你最先想到的是什么？评论区聊聊。`,
    ];

    const count = Math.max(2, Math.min(5, request.maxSegments));
    const cast = request.cast ?? [];
    const castAt = (index: number): string[] => {
      if (cast.length === 0) return [];
      if (cast.length === 1) return [cast[0]!.name];
      // 轮转出场，让同一人物/道具在多个镜头里重复出现，方便检查一致性。
      return [cast[index % cast.length]!.name, cast[(index + 1) % cast.length]!.name].filter(
        (name, position, list) => list.indexOf(name) === position,
      );
    };
    const segments = narration.slice(0, count).map((text, index) => {
      const names = castAt(index);
      return {
        id: index + 1,
        narration: text,
        keywords: keywordsAt(index),
        durationHintSec: 6,
        scene: `${topic} · 场景 ${Math.floor(index / 2) + 1}`,
        shot: names.length
          ? `中景，${names.join("与")}自然互动，镜头稳定，画面延续上一镜`
          : `中景，${topic}，镜头稳定`,
        ...(names.length > 0 ? { cast: names } : {}),
      };
    });

    return {
      title: truncate(`${topic}｜${request.targetDurationSec} 秒看懂`, 60),
      summary: `围绕「${topic}」的 ${count} 段式短视频脚本（离线模板生成）。`,
      segments,
      provider: this.name,
    };
  }
}