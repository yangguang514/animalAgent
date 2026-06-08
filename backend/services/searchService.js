import { getLlmConfig, getSearchConfig } from "../config/env.js";
import { callTool, WEB_SEARCH_TOOL } from "../tools/index.js";
import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";

// 搜索计划的意图枚举，避免模型返回任意字符串影响后续分支判断。
const SEARCH_INTENTS = new Set([
  "species_profile",
  "conservation_status",
  "behavior_explanation",
  "species_comparison",
  "ecology",
  "current_event",
  "general_chat",
  "other"
]);

function latestQuestion(messages) {
  return [...messages].reverse().find((message) => message.role === "user")?.content || "";
}

// 给 planner 提供最近几条用户问题，保留追问场景下的必要上下文。
function recentUserContext(messages) {
  return messages
    .filter((message) => message.role === "user")
    .slice(-3)
    .map((message) => String(message.content || "").trim())
    .filter(Boolean)
    .join("\n");
}

// 当 planner 不可用时，用稳定的本地规则生成一个保守搜索 query。
function buildFallbackQuery(messages) {
  const recentContext = recentUserContext(messages).replace(/\s+/g, " ");
  return `${recentContext || latestQuestion(messages)} animal zoology scientific name IUCN habitat behavior ecology`;
}

// 本地兜底判断：只对明显需要事实、物种、保护状态等信息的问题触发搜索。
function looksLikeSearchNeeded(question) {
  const text = String(question || "").trim();
  if (!text) return false;

  const lower = text.toLowerCase();
  if (/^(hi|hello|hey|thanks|thank you|ok|好的|谢谢|你好|嗨)[!！。.\s]*$/i.test(text)) return false;
  if (/你是谁|你能做什么|怎么用|help|使用方法/.test(lower)) return false;

  return /iucn|保护|濒危|分布|栖息|学名|拉丁|物种|动物|鸟|鱼|蛇|猫|犬|虎|豹|鲸|海豚|昆虫|生态|食性|行为|繁殖|迁徙|habitat|species|zoology|conservation|endangered|scientific name/.test(
    lower
  );
}

// planner 失败、关闭或没有 LLM Key 时，保证搜索链路仍然可以继续工作。
function fallbackSearchPlan(messages, reason = "LLM planner unavailable; used local heuristic.") {
  const question = latestQuestion(messages);
  const shouldSearch = looksLikeSearchNeeded(question);
  return {
    shouldSearch,
    query: shouldSearch ? buildFallbackQuery(messages) : "",
    intent: shouldSearch ? "other" : "general_chat",
    reason,
    freshnessNeeded: shouldSearch,
    confidence: 0.45,
    fallback: true
  };
}

function parseBooleanEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function normalizeText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

// 不同搜索服务字段不一致，这里统一整理成前端和模型都能消费的 source 结构。
function normalizeSource(item, index, maxSnippetLength = 1600) {
  const content = item.content || item.snippet || item.description || item.text || item.raw_content || "";
  return {
    id: index + 1,
    title: String(item.title || item.name || `来源 ${index + 1}`).trim(),
    url: String(item.url || item.link || "").trim(),
    snippet: normalizeText(content, maxSnippetLength),
    score: typeof item.score === "number" ? item.score : null,
    publishedDate: item.published_date || item.publishedDate || ""
  };
}

// planner 有时会返回 ```json 代码块，这里只抽取其中的 JSON 对象。
function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("empty planner response");

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("planner did not return JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

// 校验并收敛模型返回的搜索计划，确保后续只处理已知字段和安全长度。
function normalizeSearchPlan(rawPlan, messages) {
  const fallback = fallbackSearchPlan(messages, "LLM planner returned an invalid plan; used local heuristic.");
  if (!rawPlan || typeof rawPlan !== "object") return fallback;

  const shouldSearch = Boolean(rawPlan.shouldSearch);
  const query = normalizeText(rawPlan.query || "", 280);
  const intent = SEARCH_INTENTS.has(rawPlan.intent) ? rawPlan.intent : shouldSearch ? "other" : "general_chat";
  const confidence = Number(rawPlan.confidence);

  if (shouldSearch && !query) {
    return {
      ...fallback,
      reason: "LLM planner requested search without a query; used local heuristic."
    };
  }

  return {
    shouldSearch,
    query,
    intent,
    reason: normalizeText(rawPlan.reason || (shouldSearch ? "Search needed." : "Search not needed."), 240),
    freshnessNeeded: Boolean(rawPlan.freshnessNeeded),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(confidence, 1)) : 0.7,
    fallback: false
  };
}

// 构造专用的“是否需要搜索”判断 prompt，要求模型只返回 JSON。
function plannerPrompt(messages) {
  return [
    {
      role: "system",
      content: `You are the search planner for a Chinese animal science assistant.
Decide whether the latest user request needs web search before answering.

Search when the request needs current facts, citations, conservation status, scientific names, distribution, habitat, taxonomy, species comparison, or claims that should be verified.
Skip search for greetings, product/help questions about the assistant, simple follow-up wording, or broad conversational replies that do not need external facts.

Return only one JSON object with this shape:
{
  "shouldSearch": true,
  "query": "concise search query in Chinese or English",
  "intent": "species_profile | conservation_status | behavior_explanation | species_comparison | ecology | current_event | general_chat | other",
  "reason": "short Chinese reason",
  "freshnessNeeded": true,
  "confidence": 0.0
}`
    },
    {
      role: "user",
      content: `Recent user messages:
${recentUserContext(messages) || latestQuestion(messages)}

Latest user request:
${latestQuestion(messages)}`
    }
  ];
}

// 调用 LLM 生成搜索计划；失败时回退到本地启发式计划。
async function generateSearchPlan(messages) {
  if (parseBooleanEnv("SEARCH_PLANNER_DISABLED", false)) {
    return fallbackSearchPlan(messages, "SEARCH_PLANNER_DISABLED=true; used local heuristic.");
  }

  const llmConfig = getLlmConfig();
  if (!llmConfig.key) {
    return fallbackSearchPlan(messages, "Missing LLM API key; used local heuristic.");
  }

  try {
    const response = await fetchWithTimeout(
      `${llmConfig.baseURL}/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${llmConfig.key}` },
        body: JSON.stringify({
          model: process.env.SEARCH_PLANNER_MODEL || llmConfig.model,
          temperature: 0,
          messages: plannerPrompt(messages)
        })
      },
      Math.max(3000, Number(process.env.SEARCH_PLANNER_TIMEOUT_MS || 8000))
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error?.message || `planner failed: HTTP ${response.status}`);
    }

    const content = data?.choices?.[0]?.message?.content;
    return normalizeSearchPlan(extractJsonObject(content), messages);
  } catch (error) {
    return fallbackSearchPlan(
      messages,
      `Search planner failed; used local heuristic. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// 搜索服务入口：先生成搜索计划，再按计划决定跳过、提示缺配置或执行搜索。
export async function searchWeb(messages) {
  const plan = await generateSearchPlan(messages);
  const config = getSearchConfig();

  if (!plan.shouldSearch) {
    return {
      enabled: false,
      skipped: true,
      query: "",
      note: `已跳过联网检索：${plan.reason}`,
      plan,
      sources: []
    };
  }

  if (config.provider === "off") {
    return {
      enabled: false,
      skipped: false,
      query: plan.query,
      note: "搜索计划建议联网检索，但当前未配置 Search API。",
      plan,
      sources: []
    };
  }

  if (!config.key) {
    return {
      enabled: false,
      skipped: false,
      query: plan.query,
      note: `搜索计划建议使用 ${config.provider}，但缺少对应 Search API Key。`,
      plan,
      sources: []
    };
  }

  let toolCall;
  try {
    toolCall = await callTool(WEB_SEARCH_TOOL, { query: plan.query }, { searchConfig: config });
    if (!toolCall.ok) throw new Error(toolCall.error);
  } catch (error) {
    if (config.strictErrors) throw error;
    return {
      enabled: false,
      skipped: false,
      query: plan.query,
      note: `${config.provider} 检索失败：${error instanceof Error ? error.message : String(error)}`,
      plan,
      sources: []
    };
  }

  const seen = new Set();
  const sources = (toolCall.result?.results || [])
    .map((item, index) => normalizeSource(item, index, Number(process.env.SEARCH_SNIPPET_MAX_LENGTH || 1600)))
    .filter((source) => source.url && !seen.has(source.url) && seen.add(source.url))
    .slice(0, config.maxResults);

  return {
    enabled: true,
    skipped: false,
    query: plan.query,
    note: plan.reason,
    tool: { name: toolCall.tool, provider: toolCall.result?.provider, elapsedMs: toolCall.elapsedMs },
    plan,
    sources
  };
}
