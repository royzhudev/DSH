import assert from "node:assert/strict";
import test from "node:test";
import { hasPublicAssetBase, publicCastImageUrl } from "../../src/videogen/public-assets.js";

test("公网素材地址：未配置时返回 undefined，配置后生成带令牌的只读 URL", () => {
  assert.equal(hasPublicAssetBase({ publicBaseUrl: "", publicAssetToken: "" }), false);
  assert.equal(publicCastImageUrl({ publicBaseUrl: "", publicAssetToken: "" }, "cast1"), undefined);
  assert.equal(
    publicCastImageUrl({ publicBaseUrl: "https://video.example.com", publicAssetToken: "" }, "cast1"),
    undefined,
  );
  assert.equal(
    publicCastImageUrl(
      { publicBaseUrl: "https://video.example.com/", publicAssetToken: "tok_123" },
      "cast1",
    ),
    "https://video.example.com/api/public/cast/tok_123/cast1",
  );
});
