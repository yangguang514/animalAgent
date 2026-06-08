import { searchWeb } from "../services/searchService.js";

// 面试里说的“agent 设计模式”在这里集中登记。
// 它不是运行必须的数据，而是给 /api/agents 和 README 做架构展示用。
export const AGENT_PATTERNS = [
  { name: "Router/Planner", pattern: "router", purpose: "Classify the latest request and decide whether retrieval is needed." },
  { name: "Tool-Using Researcher", pattern: "tool-use", purpose: "Call registered tools, normalize evidence, and expose citable sources." },
  { name: "Layered Memory Manager", pattern: "memory", purpose: "Separate persona, summary, recent turns, evidence, and runtime metadata." },
  { name: "Writer", pattern: "reactive", purpose: "Generate the final user-facing answer from the managed context." },
  { name: "Critic", pattern: "reflection", purpose: "Run deterministic post-checks for citation and evidence consistency." }
];

// 每个 agent 执行完一步，都往 trace 里写一条轨迹。
// 这可以理解为“多智能体协作日志”，方便调试和讲解链路。
function trace(agent, status, note = "") {
  return { agent, status, note, at: new Date().toISOString() };
}

// 从模型回答里找 [1]、[2] 这样的引用编号。
// Critic 会用它判断模型有没有引用不存在的来源。
function extractCitationIds(answer = "") {
  return [...String(answer).matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
}

// Critic agent：不再调用一次大模型，而是做确定性的规则检查。
// 好处是稳定、便宜、可解释，主要检查来源引用是否一致。
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

// Router/Planner + Researcher 的协作入口。
// searchWeb 内部已经包含“是否需要搜索”的 planner 逻辑；
// 这里把它包装成 agent 流程，并记录 planner/researcher 的执行轨迹。
export async function planAndResearch(messages, events = {}) {
  const traceLog = [trace("router", "started", "Inspecting intent and retrieval need.")];
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

  return { search, trace: traceLog };
}

// Writer 生成答案之后调用这里，追加 Critic 检查结果。
// 返回值会存到 assistant message 的 agents 字段里。
export function finalizeAgentRun(answer, sources = [], search = {}, traceLog = []) {
  const review = reviewAnswer(answer, sources, search);
  return {
    review,
    trace: [...traceLog, trace("critic", review.ok ? "passed" : "warnings", review.warnings.join(" | "))]
  };
}
