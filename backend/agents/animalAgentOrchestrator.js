import { searchWeb } from "../services/searchService.js";

// “agent 设计模式”在这里集中登记。
// 它既用于运行时角色路由，也用于 /api/agents 和 README 的架构展示。
export const AGENT_PATTERNS = [
  { name: "Context Role Selector", pattern: "router", purpose: "Route each turn to the animal educator or video director persona." },
  { name: "Router/Planner", pattern: "router", purpose: "Classify the latest request and decide whether retrieval is needed." },
  { name: "Tool-Using Researcher", pattern: "tool-use", purpose: "Call registered tools, normalize evidence, and expose citable sources." },
  { name: "Layered Memory Manager", pattern: "memory", purpose: "Separate persona, summary, recent turns, evidence, and runtime metadata." },
  { name: "Animal Educator", pattern: "reactive", purpose: "Answer animal science and zoology questions accurately and accessibly." },
  { name: "DirectorAgent", pattern: "reactive", purpose: "Create duration-aware animal video plans, narration, and storyboard scripts." },
  { name: "TitleAgent", pattern: "summarizer", purpose: "Compress the first completed exchange into a stable sidebar title." },
  { name: "Critic", pattern: "reflection", purpose: "Run deterministic post-checks for citation and evidence consistency." }
];

// 视频角色路由拆成三类信号：
// 1. 用户提到了视频产物；2. 用户明确要求创作；3. 用户正在修改上一轮视频方案。
// 分开判断可以避免“这个动物出现在什么视频里”之类的知识问题被误判为脚本创作。
const VIDEO_ARTIFACT_PATTERN =
  /视频|短视频|长视频|探园|探馆|vlog|脚本|分镜|口播稿|解说词|拍摄方案|镜头表|storyboard|shooting script|video script|reels?|shorts?/i;
const VIDEO_CREATION_PATTERN =
  /制作|创作|生成|写(?:一个|一份|个|份)?|策划|设计|规划|改写|改成|扩写|润色|剪辑|拍摄|做(?:一个|一期|个|期)?|produce|create|write|plan|direct|rewrite|storyboard/i;
const VIDEO_FOLLOW_UP_PATTERN =
  /改成|调整|扩写|缩短|延长|增加|删掉|换成|时长|分钟|秒|节奏|镜头|开场|结尾|旁白|解说|版本|风格|受众|平台/i;

// 角色判断只读取最近几条用户消息，既能识别追问，又不会被很早以前的话题持续干扰。
function recentUserMessages(messages = [], limit = 4) {
  return messages
    .filter((message) => message?.role === "user")
    .slice(-limit)
    .map((message) => String(message.content || "").trim())
    .filter(Boolean);
}

// Context Role Selector：
// 明确的视频创作请求和视频方案追问交给 DirectorAgent，其余请求保留动物科普角色。
// 当前使用本地确定性规则，响应快且容易测试；后续也可以替换为 LLM 分类器。
export function selectAgentPattern(messages = []) {
  const userMessages = recentUserMessages(messages);
  const latest = userMessages.at(-1) || "";
  const priorContext = userMessages.slice(0, -1).join("\n");
  const explicitVideoRequest = VIDEO_ARTIFACT_PATTERN.test(latest) && VIDEO_CREATION_PATTERN.test(latest);
  const scriptArtifactRequest = /脚本|分镜|口播稿|解说词|镜头表|storyboard|video script/i.test(latest);

  // 用户在上一轮已提出视频创作，本轮只说“延长到 30 分钟”时，仍应延续导演角色。
  const videoFollowUp =
    VIDEO_FOLLOW_UP_PATTERN.test(latest) &&
    VIDEO_ARTIFACT_PATTERN.test(priorContext) &&
    VIDEO_CREATION_PATTERN.test(priorContext);

  if (explicitVideoRequest || scriptArtifactRequest || videoFollowUp) {
    return {
      id: "director",
      name: "DirectorAgent",
      reason: explicitVideoRequest || scriptArtifactRequest
        ? "The latest request asks for a video artifact or production plan."
        : "The latest request continues the recent video creation task."
    };
  }

  return {
    id: "animal_educator",
    name: "Animal Educator",
    reason: "The request is primarily an animal knowledge or general conversation task."
  };
}

// 每个 agent 执行完一步，都会往 trace 里写一条轨迹。
function trace(agent, status, note = "") {
  return { agent, status, note, at: new Date().toISOString() };
}

function extractCitationIds(answer = "") {
  return [...String(answer).matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
}

// Critic 使用确定性规则检查引用编号和来源列表，不额外调用模型。
export function reviewAnswer(answer, sources = [], search = {}) {
  const availableIds = new Set(sources.map((source) => Number(source.id)));
  const citationIds = extractCitationIds(answer);
  const unknownIds = citationIds.filter((id) => !availableIds.has(id));
  const needsSources = Boolean(sources.length);
  const hasSourceSection = /信息来源|sources|source list/i.test(answer);
  const warnings = [];

  if (unknownIds.length) warnings.push(`Answer cited unknown source ids: ${[...new Set(unknownIds)].join(", ")}.`);
  if (needsSources && !citationIds.length) warnings.push("Search returned sources, but the answer did not include inline citations.");
  if (needsSources && !hasSourceSection) warnings.push("Search returned sources, but the answer did not include a source section.");
  if (!sources.length && search.plan?.shouldSearch) warnings.push("Planner wanted search, but no citable evidence was available.");

  return {
    ok: warnings.length === 0,
    warnings,
    citations: citationIds,
    availableSourceIds: [...availableIds]
  };
}

// 编排入口先选择回答角色，再执行原有的搜索规划。
// selectedAgent 会继续传到 layeredContext，最终决定真正注入模型的 system prompt。
export async function planAndResearch(messages, events = {}) {
  const selectedAgent = selectAgentPattern(messages);
  const traceLog = [
    trace("role_selector", "selected", `${selectedAgent.name}: ${selectedAgent.reason}`),
    trace("router", "started", "Inspecting intent and retrieval need.")
  ];
  events.status?.(`Role selector chose ${selectedAgent.name}.`);
  events.status?.("Planner agent is checking whether retrieval is needed...");

  const search = await searchWeb(messages);
  traceLog.push(
    trace(
      "router",
      search.plan?.shouldSearch ? "search_requested" : "search_skipped",
      search.plan?.reason || search.note || ""
    )
  );

  if (search.plan?.shouldSearch) {
    traceLog.push(
      trace(
        "researcher",
        search.sources?.length ? "sources_ready" : "no_sources",
        search.sources?.length ? `${search.sources.length} sources normalized.` : search.note || ""
      )
    );
  }

  return { selectedAgent, search, trace: traceLog };
}

// Writer 完成后追加 Critic 结果，供消息持久化、前端展示和问题排查使用。
export function finalizeAgentRun(answer, sources = [], search = {}, traceLog = []) {
  const review = reviewAnswer(answer, sources, search);
  return {
    review,
    trace: [...traceLog, trace("critic", review.ok ? "passed" : "warnings", review.warnings.join(" | "))]
  };
}
