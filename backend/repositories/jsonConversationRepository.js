import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config/env.js";

const storePath = join(dataDir, "conversations.json");
// JSON 文件没有数据库事务能力，用进程内 Promise 队列串行化“读取-修改-写回”，避免并发覆盖。
let writeQueue = Promise.resolve();

function createId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function now() {
  return new Date().toISOString();
}

function cleanMessages(messages = []) {
  return messages.filter((message) => message.role !== "assistant" || String(message.content || "").trim());
}

function withWriteLock(operation) {
  const run = writeQueue.then(operation, operation);
  // 队列自身吞掉上一次失败，调用方仍收到原始异常，同时后续写操作可以继续执行。
  writeQueue = run.catch(() => {});
  return run;
}

function cleanConversation(conversation) {
  return {
    ...conversation,
    messages: cleanMessages(conversation.messages || [])
  };
}

export function welcomeMessage() {
  return {
    role: "assistant",
    content:
      "**核心名片模式已就绪**\n\n我支持联网检索、信源标注、流式输出和后端会话保存。\n\n> 试试：“帮我介绍一下雪豹，顺便说下它和花豹有什么区别。”",
    sources: []
  };
}

async function readStore() {
  try {
    const content = await readFile(storePath, "utf8");
    const parsed = JSON.parse(content);
    return {
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : []
    };
  } catch {
    return { conversations: [] };
  }
}

async function writeStore(store) {
  if (process.env.VERCEL) {
    throw new Error(
      "JSON storage cannot persist on Vercel. Add Vercel Postgres and set STORAGE_PROVIDER=postgres."
    );
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

export class JsonConversationRepository {
  async list() {
    const store = await readStore();
    return store.conversations
      .map(({ messages, ...conversation }) => ({
        ...conversation,
        messageCount: cleanMessages(Array.isArray(messages) ? messages : []).length
      }))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async get(id) {
    const store = await readStore();
    const conversation = store.conversations.find((item) => item.id === id);
    return conversation ? cleanConversation(conversation) : null;
  }

  async create(title = "新的动物对话") {
    return withWriteLock(async () => {
      const store = await readStore();
      const timestamp = now();
      const conversation = {
        id: createId(),
        title,
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [welcomeMessage()]
      };
      store.conversations.unshift(conversation);
      await writeStore(store);
      return conversation;
    });
  }

  async import({ title = "已迁移的对话", messages = [] }) {
    const store = await readStore();
    const timestamp = now();
    const conversation = {
      id: createId(),
      title,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: cleanMessages(messages).length ? cleanMessages(messages) : [welcomeMessage()]
    };
    store.conversations.unshift(conversation);
    await writeStore(store);
    return conversation;
  }

  async save(conversation) {
    return withWriteLock(async () => {
      const store = await readStore();
      const index = store.conversations.findIndex((item) => item.id === conversation.id);
      const next = cleanConversation({ ...conversation, updatedAt: now() });
      if (index === -1) store.conversations.unshift(next);
      else store.conversations[index] = next;
      await writeStore(store);
      return next;
    });
  }

  async appendTurn(conversationId, userMessage, assistantMessage, title) {
    return withWriteLock(async () => {
      const store = await readStore();
      const conversation = store.conversations.find((item) => item.id === conversationId);
      if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
      const activeMessage = conversation.messages.find((message) => message.status === "streaming");
      if (activeMessage) {
        // 正常生成任务不允许重入；超过 15 分钟则视为进程退出或断连遗留的陈旧任务。
        const activeAt = new Date(activeMessage.updatedAt || activeMessage.createdAt || conversation.updatedAt).getTime();
        if (Date.now() - activeAt < 15 * 60 * 1000) {
          throw new Error("Conversation already has a streaming response.");
        }
        activeMessage.status = "interrupted";
      }

      const assistantMessageId = assistantMessage.id || createId();
      const timestamp = now();
      conversation.title = title;
      conversation.updatedAt = timestamp;
      conversation.messages.push(
        // 用户消息和 assistant 空草稿一次写入，确保模型调用前就有可恢复的持久化记录。
        { ...userMessage, id: userMessage.id || createId(), status: userMessage.status || "complete", createdAt: timestamp },
        {
          ...assistantMessage,
          id: assistantMessageId,
          status: assistantMessage.status || "streaming",
          createdAt: timestamp,
          updatedAt: timestamp
        }
      );
      await writeStore(store);
      return { conversation: cleanConversation(conversation), assistantMessageId };
    });
  }

  async updateMessage(conversationId, messageId, patch = {}) {
    // 流式生成只更新目标消息，不再用整个会话覆盖文件中的最新状态。
    return withWriteLock(async () => {
      const store = await readStore();
      const conversation = store.conversations.find((item) => item.id === conversationId);
      if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
      const message = conversation.messages.find((item) => item.id === messageId);
      if (!message) throw new Error(`Message not found: ${messageId}`);
      Object.assign(message, patch, { updatedAt: now() });
      conversation.updatedAt = now();
      await writeStore(store);
      return cleanConversation(conversation);
    });
  }

  async updateTitle(conversationId, title) {
    // 标题生成是独立的异步步骤，单独更新可以避免覆盖刚写入的回答。
    return withWriteLock(async () => {
      const store = await readStore();
      const conversation = store.conversations.find((item) => item.id === conversationId);
      if (!conversation) return null;
      conversation.title = title;
      conversation.updatedAt = now();
      await writeStore(store);
      return cleanConversation(conversation);
    });
  }

  async delete(id) {
    return withWriteLock(async () => {
      const store = await readStore();
      const before = store.conversations.length;
      store.conversations = store.conversations.filter((conversation) => conversation.id !== id);
      await writeStore(store);
      return before !== store.conversations.length;
    });
  }
}
