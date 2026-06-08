import assert from "node:assert/strict";
import test from "node:test";

import { generateLocalTitle, normalizeGeneratedTitle } from "./titleService.js";

test("local title stays focused on the first user request", () => {
  const title = generateLocalTitle([
    { role: "user", content: "帮我介绍一下雪豹，顺便说下它和花豹有什么区别？" },
    { role: "assistant", content: "雪豹生活在高海拔地区。" },
    { role: "user", content: "再讲讲章鱼。" }
  ]);

  assert.match(title, /雪豹/);
  assert.doesNotMatch(title, /章鱼/);
});

test("generated title normalization removes labels and markdown", () => {
  assert.equal(normalizeGeneratedTitle('**标题：雪豹与花豹区别。**'), "雪豹与花豹区别");
});
