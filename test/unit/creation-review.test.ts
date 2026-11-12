import assert from "node:assert/strict";
import test from "node:test";

import { reviewCreation } from "../../src/creation/review.js";

test("创作品控：钩子、台词、景别、节奏、人物一致性的合格样例得满分", () => {
  const review = reviewCreation({
    topic: "外卖小哥被客户冤枉偷餐，监控揭开真相",
    story: "外卖员被冤枉，调监控反转，客户道歉。",
    targetDurationSec: 30,
    segments: [
      { id: 1, narration: "你偷了我的外卖！", shot: "近景 客户指着外卖员", cast: ["林小满"], durationHintSec: 5 },
      { id: 2, narration: "我没动过，调监控吧。", shot: "特写 外卖员的手", cast: ["林小满"], durationHintSec: 5 },
      { id: 3, narration: "监控里，拿外卖的竟然不是他！", shot: "全景 楼道监控", cast: ["林小满"], durationHintSec: 5 },
    ],
    cast: [{ name: "林小满", kind: "character", imageFile: "hero.png" }],
  });
  const byId = new Map(review.items.map((item) => [item.id, item]));
  assert.equal(byId.get("story")?.level, "ok");
  assert.equal(byId.get("hook")?.level, "ok");
  assert.equal(byId.get("dialogue")?.level, "ok");
  assert.equal(byId.get("shots")?.level, "ok");
  assert.equal(byId.get("pace")?.level, "ok");
  assert.equal(byId.get("consistency")?.level, "ok");
  assert.equal(review.score, 100);
});

test("创作品控：标题太短、结尾平淡、台词过长、景别单一、人物没图时逐项提醒", () => {
  const review = reviewCreation({
    topic: "短剧",
    targetDurationSec: 90,
    segments: [
      {
        id: 1,
        narration:
          "我今天在楼下遇到一个特别奇怪的人他说他知道我所有的秘密并且愿意告诉我一个关于我父亲的真相但是他要求我今晚十二点一个人去旧仓库见面我到底该不该去",
        shot: "中景 人物站着",
        cast: ["林小满"],
      },
      { id: 2, narration: "好吧，就这样。", shot: "中景 人物坐下", cast: ["林小满"] },
    ],
    cast: [{ name: "林小满", kind: "character" }],
  });
  const byId = new Map(review.items.map((item) => [item.id, item]));
  assert.equal(byId.get("topic")?.level, "warn");
  assert.equal(byId.get("hook")?.level, "warn");
  assert.equal(byId.get("dialogue")?.level, "warn");
  assert.equal(byId.get("shots")?.level, "warn");
  assert.equal(byId.get("pace")?.level, "warn");
  assert.equal(byId.get("consistency")?.level, "warn");
  assert.ok(review.score < 50, `分数应偏低，实际 ${review.score}`);
});

test("创作品控：发布类提醒不计入分数", () => {
  const review = reviewCreation({
    topic: "雨夜霓虹街道上一只橘猫走过",
    story: "橘猫在雨夜街道上散步。",
    targetDurationSec: 20,
    segments: [
      { id: 1, narration: "雨还在下吗？", shot: "特写 橘猫的爪子", cast: ["橘猫"], durationHintSec: 4 },
      { id: 2, narration: "它为什么突然停下？", shot: "全景 街道", cast: ["橘猫"], durationHintSec: 4 },
    ],
    cast: [{ name: "橘猫", kind: "prop", imageFile: "cat.png" }],
  });
  const publish = review.items.filter((item) => item.stage === "publish");
  assert.equal(publish.length, 2);
  assert.ok(publish.every((item) => item.level === "todo"));
  assert.equal(review.score, 100);
});
