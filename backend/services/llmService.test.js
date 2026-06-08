import assert from "node:assert/strict";
import test from "node:test";

import { completeChat } from "./llmService.js";

test("LLM completion retries transient failures and applies output budget", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    key: process.env.ANIMAL_AGENT_API_KEY,
    baseURL: process.env.ANIMAL_AGENT_BASE_URL,
    attempts: process.env.LLM_MAX_ATTEMPTS,
    maxTokens: process.env.LLM_MAX_OUTPUT_TOKENS
  };
  const requestBodies = [];
  let calls = 0;

  process.env.ANIMAL_AGENT_API_KEY = "test-key";
  process.env.ANIMAL_AGENT_BASE_URL = "https://llm.example/v1";
  process.env.LLM_MAX_ATTEMPTS = "2";
  process.env.LLM_MAX_OUTPUT_TOKENS = "777";
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    requestBodies.push(JSON.parse(options.body));
    if (calls === 1) return new Response("busy", { status: 503 });
    return Response.json({ choices: [{ message: { content: "完成" } }] });
  };

  try {
    const answer = await completeChat([{ role: "user", content: "介绍雪豹" }], [], { skipped: true });
    assert.equal(answer, "完成");
    assert.equal(calls, 2);
    assert.equal(requestBodies[0].max_tokens, 777);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv.key === undefined) delete process.env.ANIMAL_AGENT_API_KEY;
    else process.env.ANIMAL_AGENT_API_KEY = originalEnv.key;
    if (originalEnv.baseURL === undefined) delete process.env.ANIMAL_AGENT_BASE_URL;
    else process.env.ANIMAL_AGENT_BASE_URL = originalEnv.baseURL;
    if (originalEnv.attempts === undefined) delete process.env.LLM_MAX_ATTEMPTS;
    else process.env.LLM_MAX_ATTEMPTS = originalEnv.attempts;
    if (originalEnv.maxTokens === undefined) delete process.env.LLM_MAX_OUTPUT_TOKENS;
    else process.env.LLM_MAX_OUTPUT_TOKENS = originalEnv.maxTokens;
  }
});
