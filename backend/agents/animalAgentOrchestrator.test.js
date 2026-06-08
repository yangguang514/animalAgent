import assert from "node:assert/strict";
import test from "node:test";

import { selectAgentPattern } from "./animalAgentOrchestrator.js";
import { buildLayeredContext, extractReferenceScripts } from "../context/layeredContext.js";

test("routes explicit video production requests to DirectorAgent", () => {
  const selected = selectAgentPattern([
    { role: "user", content: "制作一个约30分钟的探园视频" }
  ]);

  assert.equal(selected.id, "director");
});

test("keeps animal knowledge questions on the educator persona", () => {
  const selected = selectAgentPattern([
    { role: "user", content: "为什么章鱼有三颗心脏？" }
  ]);

  assert.equal(selected.id, "animal_educator");
});

test("keeps video follow-ups on DirectorAgent", () => {
  const selected = selectAgentPattern([
    { role: "user", content: "帮我制作一期动物园探园视频" },
    { role: "assistant", content: "可以，先规划路线。" },
    { role: "user", content: "把时长调整到30分钟，开场更有悬念" }
  ]);

  assert.equal(selected.id, "director");
});

test("injects DirectorAgent prompt and historical scripts into layered context", () => {
  const messages = [
    {
      role: "assistant",
      content: "| 时间估算 | 画面提示 (Visual) | 解说词 (Audio) | 音效/BGM (SFX) |\n|---|---|---|---|\n| 0~5秒 | 水下镜头 | 你敢信？ | 鼓点 |"
    },
    { role: "user", content: "把这个脚本扩写成30分钟" }
  ];
  const references = extractReferenceScripts(messages);
  const context = buildLayeredContext(messages, [], { skipped: true }, {
    selectedAgent: { id: "director", name: "DirectorAgent", reason: "Video request." }
  });

  assert.equal(references.length, 1);
  assert.match(context.messages[0].content, /DirectorAgent/);
  assert.match(context.messages[0].content, /你敢信/);
  assert.equal(context.stats.selectedAgent, "director");
});
