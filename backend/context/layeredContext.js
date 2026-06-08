import { animalSystemPrompt } from "../prompts/animalSystemPrompt.js";

const DEFAULT_RECENT_MESSAGE_LIMIT = 8;
const DEFAULT_SUMMARY_MESSAGE_LIMIT = 12;
const DEFAULT_LAYER_CHAR_BUDGET = 4200;

// 控制进入上下文的文本长度，避免历史消息或网页摘要把 token 撑爆。
function normalizeText(value, maxLength = 1200) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

// 欢迎语只是 UI 引导，不应该反复喂给模型，否则会污染真实对话上下文。
function isWelcomeMessage(message) {
  return message?.role === "assistant" && !message.sources?.length && /AnimalAgent|核心|名片|模式|card|mode/i.test(String(message.content || ""));
}

// 把仓库里的 message 清洗成 LLM 可以直接消费的最小结构。
// sources、agents 这些元数据会保存，但不直接作为对话消息喂给模型。
function cleanConversationMessages(messages = []) {
  return messages
    .filter((message) => message && ["user", "assistant", "system"].includes(message.role))
    .filter((message) => String(message.content || "").trim())
    .filter((message) => !isWelcomeMessage(message))
    .map(({ role, content }) => ({ role, content: String(content) }));
}

function latestUserQuestion(messages = []) {
  return [...messages].reverse().find((message) => message.role === "user")?.content || "";
}

// long_term_summary 层：把较早的对话压缩成要点。
// 这里先用本地规则摘要，后续可以替换成“摘要 agent”调用 LLM。
function buildConversationSummary(messages = []) {
  const cleanMessages = cleanConversationMessages(messages);
  const olderMessages = cleanMessages.slice(0, Math.max(0, cleanMessages.length - DEFAULT_RECENT_MESSAGE_LIMIT));
  if (!olderMessages.length) return "No older conversation turns need summarizing yet.";

  const userTopics = olderMessages
    .filter((message) => message.role === "user")
    .slice(-DEFAULT_SUMMARY_MESSAGE_LIMIT)
    .map((message) => `- ${normalizeText(message.content, 180)}`)
    .join("\n");

  const assistantContext = olderMessages
    .filter((message) => message.role === "assistant")
    .slice(-4)
    .map((message) => `- ${normalizeText(message.content, 220)}`)
    .join("\n");

  return [
    "Older conversation summary:",
    userTopics ? `User topics:\n${userTopics}` : "User topics: none.",
    assistantContext ? `Relevant assistant context:\n${assistantContext}` : "Relevant assistant context: none."
  ].join("\n");
}

// evidence 层：专门管理外部证据。
// 有搜索结果时放来源；跳过搜索或搜索失败时，也明确告诉模型不要编造引用。
function formatEvidenceLayer(sources = [], search = {}) {
  if (sources.length) {
    const blocks = sources
      .map(
        (source) => `[${source.id}] ${source.title}
URL: ${source.url}
Snippet: ${normalizeText(source.snippet || "No snippet.", 1600)}`
      )
      .join("\n\n");

    return `Web evidence was gathered before answer generation.
Search query: ${search.query || search.plan?.query || ""}
Search reason: ${search.note || search.plan?.reason || ""}

Use only the source ids listed below when citing web evidence. Do not invent citation numbers.
${blocks}`;
  }

  if (search.skipped) {
    return `Web search was intentionally skipped.
Reason: ${search.note || search.plan?.reason || "The current request does not require external evidence."}
Answer directly and do not add fabricated web citations or a fabricated source list.`;
  }

  if (search.plan?.shouldSearch) {
    return `The planner recommended web search, but no citable source was available.
Reason: ${search.note || "The search tool returned no usable evidence."}
If the answer needs verified facts, explicitly say that no citable web source is currently available.`;
  }

  return "No web evidence is available. Do not fabricate citations.";
}

// runtime 层：把本次请求的执行计划、搜索意图、agent trace 放进上下文。
// 它让 Writer 知道前面 agent 做过什么，而不是只看到一堆历史消息。
function buildRuntimeLayer(search = {}, agentTrace = []) {
  const trace = agentTrace.length
    ? agentTrace.map((step) => `- ${step.agent}: ${step.status}${step.note ? ` (${step.note})` : ""}`).join("\n")
    : "- single-pass runtime";

  return `Runtime plan:
Latest user request: ${normalizeText(search.latestQuestion || "", 260)}
Search intent: ${search.plan?.intent || "unknown"}
Search confidence: ${search.plan?.confidence ?? "unknown"}
Agent trace:
${trace}`;
}

// short_term_history 层只保留最近几轮，并按字符预算截断。
// 这样用户聊得很久时，模型仍然优先看到最近上下文。
function trimMessagesToBudget(messages, budget = DEFAULT_LAYER_CHAR_BUDGET) {
  const output = [];
  let used = 0;

  for (const message of [...messages].reverse()) {
    const length = String(message.content || "").length;
    if (output.length && used + length > budget) break;
    output.unshift(message);
    used += length;
  }

  return output;
}

// 分层上下文总入口。
// 最终给模型的 messages = persona / long_term_summary / evidence / runtime / short_term_history。
export function buildLayeredContext(messages = [], sources = [], search = {}, options = {}) {
  const cleanMessages = cleanConversationMessages(messages);
  const recentLimit = Math.max(2, Number(options.recentMessageLimit || DEFAULT_RECENT_MESSAGE_LIMIT));
  const recentMessages = trimMessagesToBudget(cleanMessages.slice(-recentLimit), options.messageCharBudget || DEFAULT_LAYER_CHAR_BUDGET);
  const latestQuestion = latestUserQuestion(cleanMessages);
  const enrichedSearch = { ...search, latestQuestion };

  const layers = [
    { name: "persona", role: "system", content: animalSystemPrompt },
    { name: "long_term_summary", role: "system", content: buildConversationSummary(cleanMessages) },
    { name: "evidence", role: "system", content: formatEvidenceLayer(sources, enrichedSearch) },
    { name: "runtime", role: "system", content: buildRuntimeLayer(enrichedSearch, options.agentTrace || []) },
    { name: "short_term_history", role: "conversation", content: recentMessages }
  ];

  // layers 保留结构化信息，便于调试；messages 是真正传给 chat/completions 的格式。
  return {
    layers,
    messages: [
      ...layers.filter((layer) => layer.role === "system").map((layer) => ({ role: "system", content: layer.content })),
      ...recentMessages
    ],
    stats: {
      totalConversationMessages: cleanMessages.length,
      recentMessages: recentMessages.length,
      sources: sources.length,
      layers: layers.map((layer) => layer.name)
    }
  };
}
