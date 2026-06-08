import { finalizeAgentRun, planAndResearch } from "../agents/animalAgentOrchestrator.js";
import { conversationRepository, welcomeMessage } from "../repositories/conversationRepository.js";
import { completeChat, streamChat } from "./llmService.js";
import { generateConversationTitle, generateLocalTitle } from "./titleService.js";

// chatService 是业务编排层：
// 路由层只负责收发 HTTP，这里负责保存消息、调用 agent、调用模型、落库。
export async function listConversations() {
  return conversationRepository.list();
}

export async function createConversation() {
  return conversationRepository.create();
}

export async function importConversation(payload) {
  return conversationRepository.import(payload);
}

export async function getConversation(id) {
  return conversationRepository.get(id);
}

export async function deleteConversation(id) {
  return conversationRepository.delete(id);
}

export async function clearConversation(id) {
  const conversation = await conversationRepository.get(id);
  if (!conversation) return null;
  conversation.title = "新的动物对话";
  conversation.messages = [welcomeMessage()];
  return conversationRepository.save(conversation);
}

// 非流式接口 /api/chat 使用这个入口。
// 流程和流式接口保持一致：先 planner/researcher，再 writer，最后 critic。
export async function askOnce(messages) {
  const agentRun = await planAndResearch(messages);

  // 把角色选择结果透传到上下文层，由它切换动物科普或视频编导 system prompt。
  const answer = await completeChat(messages, agentRun.search.sources, agentRun.search, {
    agentTrace: agentRun.trace,
    selectedAgent: agentRun.selectedAgent
  });
  const finalRun = finalizeAgentRun(answer, agentRun.search.sources, agentRun.search, agentRun.trace);

  return {
    answer,
    sources: agentRun.search.sources,
    search: {
      enabled: agentRun.search.enabled,
      skipped: agentRun.search.skipped,
      query: agentRun.search.query,
      note: agentRun.search.note,
      tool: agentRun.search.tool,
      plan: agentRun.search.plan
    },
    agents: finalRun
  };
}

// 流式聊天主流程：
// 1. 读取或创建会话
// 2. 保存用户消息
// 3. Planner/Researcher 决定是否搜索并返回证据
// 4. Writer 流式生成回答
// 5. Critic 检查回答并把 agent 轨迹保存到 assistant message
export async function appendUserMessageAndStream(conversationId, content, events) {
  let conversation = await conversationRepository.get(conversationId);
  if (!conversation) conversation = await conversationRepository.create();

  conversation.messages.push({ role: "user", content, sources: [] });
  conversation.title = generateLocalTitle(conversation.messages);
  conversation = await conversationRepository.save(conversation);

  // agentRun 同时包含角色选择、搜索结果和多智能体协作轨迹。
  const agentRun = await planAndResearch(conversation.messages, events);
  const search = agentRun.search;
  events.sources({
    enabled: search.enabled,
    skipped: search.skipped,
    query: search.query,
    note: search.note,
    tool: search.tool,
    plan: search.plan,
    sources: search.sources
  });

  events.status("Writer agent 正在生成回答...");
  let answer = "";

  // streamChat 内部会调用 layeredContext，按 selectedAgent 选择 persona，
  // 再把历史、参考脚本、证据和运行状态组装成 LLM messages。
  answer = await streamChat(
    conversation.messages,
    search.sources,
    search,
    (delta) => {
      answer += delta;
      events.delta(delta);
    },
    { agentTrace: agentRun.trace, selectedAgent: agentRun.selectedAgent }
  );

  if (!answer.trim()) {
    throw new Error("Model did not return a valid answer.");
  }

  // Critic 的检查结果不会阻断回答，但会保存到 agents 字段，方便后续展示或排查。
  const finalRun = finalizeAgentRun(answer, search.sources, search, agentRun.trace);
  conversation.messages.push({ role: "assistant", content: answer, sources: search.sources, agents: finalRun });

  // 只在首个完整问答后用模型精炼一次标题，避免后续追问导致标题反复变化。
  const userMessageCount = conversation.messages.filter((message) => message.role === "user").length;
  if (userMessageCount === 1) {
    conversation.title = await generateConversationTitle(conversation.messages, {
      fallback: conversation.title
    });
  }
  conversation = await conversationRepository.save(conversation);
  return conversation;
}
