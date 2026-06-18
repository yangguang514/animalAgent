import {
  finalizeAgentRun,
  planAndResearch,
  reviewAnswer,
  shouldReviseAnswer
} from "../agents/animalAgentOrchestrator.js";
import { getLlmConfig } from "../config/env.js";
import { conversationRepository, welcomeMessage } from "../repositories/conversationRepository.js";
import { completeChat, reviseChatAnswer, streamChat } from "./llmService.js";
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

function criticRevisionEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.CRITIC_REVISION_ENABLED || "true"));
}

// Critic 先做低成本确定性检查；仅在有明确 warning 且调用预算充足时执行一次模型修订。
// 修订失败保留 Writer 原稿，避免一个增强步骤让整个回答不可用。
async function reviseIfNeeded(answer, messages, sources, search, options = {}) {
  const initialReview = reviewAnswer(answer, sources, search);
  const config = getLlmConfig();
  const canRevise = shouldReviseAnswer(initialReview, {
    enabled: criticRevisionEnabled(),
    remainingAgentCalls: config.maxAgentCallsPerTurn - (options.agentCallsUsed || 1)
  });
  if (!canRevise) return { answer, revision: null, agentCallsUsed: options.agentCallsUsed || 1 };

  options.onStatus?.("Critic 发现可修订问题，Revision Agent 正在改进回答...");
  try {
    const revisedAnswer = await reviseChatAnswer(answer, messages, sources, search, initialReview, {
      signal: options.signal
    });
    return {
      answer: revisedAnswer,
      revision: {
        attempted: true,
        succeeded: true,
        warningsBefore: initialReview.warnings,
        note: "Revised once after deterministic critic warnings."
      },
      agentCallsUsed: (options.agentCallsUsed || 1) + 1
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return {
      answer,
      revision: {
        attempted: true,
        succeeded: false,
        warningsBefore: initialReview.warnings,
        note: error instanceof Error ? error.message : String(error)
      },
      agentCallsUsed: (options.agentCallsUsed || 1) + 1
    };
  }
}

// 非流式接口 /api/chat 使用这个入口。
// 流程和流式接口保持一致：先 planner/researcher，再 writer，最后 critic。
export async function askOnce(messages) {
  const agentRun = await planAndResearch(messages);

  // 把角色选择结果透传到上下文层，由它切换动物科普或视频编导 system prompt。
  const draftAnswer = await completeChat(messages, agentRun.search.sources, agentRun.search, {
    agentTrace: agentRun.trace,
    selectedAgent: agentRun.selectedAgent
  });
  const revisionResult = await reviseIfNeeded(
    draftAnswer,
    messages,
    agentRun.search.sources,
    agentRun.search,
    { agentCallsUsed: 1 + (agentRun.search.plan?.fallback ? 0 : 1) }
  );
  const answer = revisionResult.answer;
  const finalRun = finalizeAgentRun(
    answer,
    agentRun.search.sources,
    agentRun.search,
    agentRun.trace,
    { revision: revisionResult.revision }
  );

  return {
    answer,
    sources: agentRun.search.sources,
    images: agentRun.search.images || [],
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

  const userMessage = { role: "user", content, sources: [], images: [], status: "complete" };
  const title = generateLocalTitle([...conversation.messages, userMessage]);
  let appended;
  try {
    // 先持久化用户消息和 assistant 占位，再启动 Planner/Writer，刷新页面也不会丢失本轮任务。
    appended = await conversationRepository.appendTurn(
      conversation.id,
      userMessage,
      { role: "assistant", content: "", sources: [], images: [], status: "streaming" },
      title
    );
  } catch (error) {
    if (error?.code === "23505" || /streaming|unique/i.test(String(error?.message || ""))) {
      throw new Error("这个会话已有回答正在生成，请等待完成或 15 分钟后重试。");
    }
    throw error;
  }
  conversation = appended.conversation;
  const assistantMessageId = appended.assistantMessageId;

  // agentRun 同时包含角色选择、搜索结果和多智能体协作轨迹。
  let agentRun;
  try {
    agentRun = await planAndResearch(conversation.messages, events);
  } catch (error) {
    // Planner 或搜索阶段断开时也结束草稿状态，否则唯一索引会一直阻止后续提问。
    await conversationRepository
      .updateMessage(conversation.id, assistantMessageId, {
        content: "回答准备阶段已中断，请重新发送问题继续。",
        status: events.signal?.aborted ? "interrupted" : "failed"
      })
      .catch(() => {});
    throw error;
  }
  const search = agentRun.search;
  const images = search.images || [];
  events.sources?.({
    enabled: search.enabled,
    skipped: search.skipped,
    query: search.query,
    note: search.note,
    tool: search.tool,
    plan: search.plan,
    sources: search.sources
  });
  events.images?.({ images });

  events.status?.("Writer agent 正在生成回答...");
  let answer = "";
  let persistedLength = 0;
  let lastPersistedAt = 0;
  let persistenceChain = Promise.resolve();

  // 首个 token 立即保存；之后按字符数和时间双阈值节流，兼顾刷新可恢复性与数据库写入成本。
  // persistenceChain 保证异步更新严格按生成顺序执行，较早的短快照不会覆盖较新的长快照。
  const persistDraft = (force = false, patch = {}) => {
    const now = Date.now();
    const isFirstContent = persistedLength === 0 && answer.length > 0;
    if (!force && !isFirstContent && answer.length - persistedLength < 240 && now - lastPersistedAt < 900) return;
    const snapshot = answer;
    persistedLength = snapshot.length;
    lastPersistedAt = now;
    persistenceChain = persistenceChain
      .catch(() => {})
      .then(() =>
        conversationRepository.updateMessage(conversation.id, assistantMessageId, {
          content: snapshot,
          sources: search.sources,
          images,
          status: patch.status || "streaming",
          ...(patch.agents === undefined ? {} : { agents: patch.agents })
        })
      );
  };

  try {
    // streamChat 内部会调用 layeredContext，按 selectedAgent 选择 persona，
    // 再把历史、参考脚本、证据和运行状态组装成 LLM messages。
    answer = await streamChat(
      conversation.messages,
      search.sources,
      search,
      (delta) => {
        answer += delta;
        events.delta?.(delta);
        persistDraft();
      },
      {
        agentTrace: agentRun.trace,
        selectedAgent: agentRun.selectedAgent,
        signal: events.signal
      }
    );
    persistDraft(true);
    await persistenceChain;
  } catch (error) {
    const interruptedAnswer = answer.trim() || "回答生成已中断，请重新发送问题继续。";
    answer = interruptedAnswer;
    persistDraft(true, { status: events.signal?.aborted ? "interrupted" : "failed" });
    await persistenceChain.catch(() => {});
    throw error;
  }

  if (!answer.trim()) {
    await conversationRepository.updateMessage(conversation.id, assistantMessageId, {
      content: "模型没有返回有效回答，请稍后重试。",
      status: "failed"
    });
    throw new Error("Model did not return a valid answer.");
  }

  let revisionResult;
  try {
    revisionResult = await reviseIfNeeded(answer, conversation.messages, search.sources, search, {
      signal: events.signal,
      onStatus: events.status,
      agentCallsUsed: 1 + (search.plan?.fallback ? 0 : 1)
    });
  } catch (error) {
    await conversationRepository
      .updateMessage(conversation.id, assistantMessageId, {
        content: answer,
        sources: search.sources,
        images,
        status: events.signal?.aborted ? "interrupted" : "failed"
      })
      .catch(() => {});
    throw error;
  }
  if (revisionResult.answer !== answer) {
    answer = revisionResult.answer;
    // Revision Agent 返回的是完整答案，因此前端应原位替换 Writer 草稿，而不是继续追加 delta。
    events.replace?.(answer);
  }

  const finalRun = finalizeAgentRun(answer, search.sources, search, agentRun.trace, {
    revision: revisionResult.revision
  });
  conversation = await conversationRepository.updateMessage(conversation.id, assistantMessageId, {
    content: answer,
    sources: search.sources,
    images,
    agents: finalRun,
    status: "complete"
  });

  // 只在首个完整问答后用模型精炼一次标题，避免后续追问导致标题反复变化。
  const userMessageCount = conversation.messages.filter((message) => message.role === "user").length;
  // TitleAgent 同样计入每轮调用预算；预算已被 Revision Agent 用完时直接保留本地标题。
  if (userMessageCount === 1 && revisionResult.agentCallsUsed < getLlmConfig().maxAgentCallsPerTurn) {
    const generatedTitle = await generateConversationTitle(conversation.messages, {
      fallback: conversation.title
    });
    conversation = await conversationRepository.updateTitle(conversation.id, generatedTitle);
  }
  return conversation;
}
