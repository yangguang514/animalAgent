import { getLlmConfig } from "../config/env.js";
import { buildLayeredContext } from "../context/layeredContext.js";

// llmService 只负责“怎么调用模型”。
// 它不直接拼 prompt，而是委托 layeredContext 做上下文分层管理。
export function buildMessages(messages, sources, search = {}, options = {}) {
  return buildLayeredContext(messages, sources, search, options).messages;
}

// 兜底逻辑：如果模型忘记在末尾列“信息来源”，后端帮它补上。
function sourceListMarkdown(sources) {
  return sources.map((source) => `[${source.id}] ${source.title} - ${source.url}`).join("\n");
}

function ensureSourceList(answer, sources) {
  if (!sources.length || /信息来源/.test(answer)) return answer;
  return `${answer.trim()}\n\n**信息来源**\n${sourceListMarkdown(sources)}`;
}

function ensureLlmKey(config) {
  if (!config.key) {
    throw new Error("缺少 ANIMAL_AGENT_API_KEY、DEEPSEEK_API_KEY 或 OPENAI_API_KEY。请在 animalAgent/.env 中配置。");
  }
}

// 非流式模型调用，主要给兼容接口 /api/chat 使用。
export async function completeChat(messages, sources = [], search = {}, options = {}) {
  const config = getLlmConfig();
  ensureLlmKey(config);

  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      messages: buildMessages(messages, sources, search, options)
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `模型接口请求失败：HTTP ${response.status}`);

  const answer = data?.choices?.[0]?.message?.content;
  if (!answer) throw new Error("模型没有返回有效回答。");
  return ensureSourceList(answer, sources);
}

// 流式模型调用，给主聊天界面使用。
// 它逐段解析 OpenAI-compatible SSE，把 delta 通过 onDelta 推给上层。
export async function streamChat(messages, sources, search = {}, onDelta, options = {}) {
  const config = getLlmConfig();
  ensureLlmKey(config);

  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      stream: true,
      messages: buildMessages(messages, sources, search, options)
    })
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error?.message || `模型接口请求失败：HTTP ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("模型接口没有返回可读流。");

  const decoder = new TextDecoder();
  let buffer = "";
  let fullAnswer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const dataLines = part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.replace(/^data:\s?/, ""));

      for (const dataLine of dataLines) {
        if (dataLine === "[DONE]") {
          if (sources.length && !/信息来源/.test(fullAnswer)) {
            const sourceList = `\n\n**信息来源**\n${sourceListMarkdown(sources)}`;
            fullAnswer += sourceList;
            onDelta(sourceList);
          }
          return fullAnswer;
        }

        const chunk = JSON.parse(dataLine);
        const content = chunk?.choices?.[0]?.delta?.content || "";
        if (content) {
          fullAnswer += content;
          onDelta(content);
        }
      }
    }
  }

  if (sources.length && !/信息来源/.test(fullAnswer)) {
    const sourceList = `\n\n**信息来源**\n${sourceListMarkdown(sources)}`;
    fullAnswer += sourceList;
    onDelta(sourceList);
  }
  return fullAnswer;
}
