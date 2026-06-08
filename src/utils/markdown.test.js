import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCjkEmphasis } from "./markdown.js";

test("normalizes Chinese quoted bold text that CommonMark leaves unparsed", () => {
  assert.equal(
    normalizeCjkEmphasis("进行**“跳跃取食”训练**，再强化"),
    "进行<strong>“跳跃取食”训练</strong>，再强化"
  );
});

test("does not rewrite Markdown examples inside code", () => {
  assert.equal(
    normalizeCjkEmphasis("示例：`进行**“跳跃取食”训练**`"),
    "示例：`进行**“跳跃取食”训练**`"
  );
});
