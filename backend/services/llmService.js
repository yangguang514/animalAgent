import { getLlmConfig } from "../config/env.js";
import { buildLayeredContext } from "../context/layeredContext.js";
import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";

// llmService 只负责“怎么调用模型”。
// 它不直接拼 prompt，而是委托 layeredContext 做上下文分层管理。
export function buildMessages(messages, sources, search = {}, options = {}) {
  return buildLayeredContext(messages, sources, search, options).messages;
}

// 兜底逻辑：如果模型忘记在末尾列“信息来源”，后端帮它补上。
function sourceListMarkdown(sources) {
  return sources
    .map((source) => {
      const location = source.type === "knowledge" && source.pageNumber ? `（第 ${source.pageNumber} 页）` : "";
      return source.url
        ? `[${source.id}] ${source.title}${location} - ${source.url}`
        : `[${source.id}] ${source.title}${location}`;
    })
    .join("\n");
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

function isRetryableStatus(status) {
  // 仅重试临时性错误；鉴权、参数等确定性 4xx 立即返回，避免无意义地重复计费。
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted || error?.name === "AbortError");
}

async function waitBeforeRetry(attempt, signal) {
  // 使用短指数退避，同时监听外部取消，用户刷新后不再等待下一次尝试。
  const delayMs = Math.min(250 * 2 ** attempt, 1500);
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestCompletion(config, payload, options = {}) {
  // 所有模型调用共用同一套超时、重试和取消语义，避免 Planner/Writer/Critic 行为不一致。
  let lastError;
  for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        `${config.baseURL}/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
          body: JSON.stringify(payload),
          signal: options.signal
        },
        options.timeoutMs || config.timeoutMs
      );
      if (response.ok || !isRetryableStatus(response.status) || attempt === config.maxAttempts - 1) {
        return response;
      }
      // 重试前主动释放失败响应流，避免长连接占用底层资源。
      await response.body?.cancel().catch(() => {});
      lastError = new Error(`Retryable model response: HTTP ${response.status}`);
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      lastError = error;
      if (attempt === config.maxAttempts - 1) throw error;
    }
    await waitBeforeRetry(attempt, options.signal);
  }
  throw lastError || new Error("Model request failed.");
}

function completionPayload(config, messages, options = {}) {
  // max_tokens 是单次模型调用的硬输出上限，也是最直接的成本保护。
  return {
    model: options.model || config.model,
    temperature: options.temperature ?? config.temperature,
    max_tokens: options.maxOutputTokens || config.maxOutputTokens,
    stream: options.stream || undefined,
    messages
  };
}

// 非流式模型调用，主要给兼容接口 /api/chat 使用。
export async function completeChat(messages, sources = [], search = {}, options = {}) {
  const config = getLlmConfig();
  ensureLlmKey(config);

  const response = await requestCompletion(
    config,
    completionPayload(config, buildMessages(messages, sources, search, options), options),
    options
  );

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

  const response = await requestCompletion(
    config,
    completionPayload(config, buildMessages(messages, sources, search, options), { ...options, stream: true }),
    options
  );

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

export async function reviseChatAnswer(answer, messages, sources = [], search = {}, review = {}, options = {}) {
  const config = getLlmConfig();
  ensureLlmKey(config);
  const evidence = sources.length
    ? sources.map((source) => `[${source.id}] ${source.title}\n${source.url}\n${source.snippet || ""}`).join("\n\n")
    : "No citable web evidence is available.";
  const latestUserRequest = [...messages].reverse().find((message) => message.role === "user")?.content || "";
  // Revision Agent 只接收当前请求、Critic 警告、可用证据和原稿，减少历史上下文造成的偏航。
  const revisionMessages = [
    {
      role: "system",
      content: `You are the Critic and revision agent for an animal-science assistant.
Repair the draft using the review warnings. Preserve useful content and the user's requested format.
Do not invent source ids or unsupported facts. When sources exist, add inline [n] citations only where supported and end with an 信息来源 section.
Return only the revised final answer.`
    },
    {
      role: "user",
      content: `Latest user request:
${latestUserRequest}

Critic warnings:
${(review.warnings || []).map((warning) => `- ${warning}`).join("\n")}

Available evidence:
${evidence}

Draft answer:
${answer}`
    }
  ];
  const response = await requestCompletion(
    config,
    completionPayload(config, revisionMessages, {
      ...options,
      temperature: 0.1,
      maxOutputTokens: options.maxOutputTokens || config.maxOutputTokens
    }),
    options
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Critic revision failed: HTTP ${response.status}`);
  const revised = data?.choices?.[0]?.message?.content;
  if (!revised) throw new Error("Critic revision did not return a valid answer.");
  return ensureSourceList(revised, sources);
}
