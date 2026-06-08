import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config/env.js";

const storePath = join(dataDir, "conversations.json");

function createId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function now() {
  return new Date().toISOString();
}

function cleanMessages(messages = []) {
  return messages.filter((message) => message.role !== "assistant" || String(message.content || "").trim());
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
    const store = await readStore();
    const index = store.conversations.findIndex((item) => item.id === conversation.id);
    const next = cleanConversation({ ...conversation, updatedAt: now() });
    if (index === -1) store.conversations.unshift(next);
    else store.conversations[index] = next;
    await writeStore(store);
    return next;
  }

  async delete(id) {
    const store = await readStore();
    const before = store.conversations.length;
    store.conversations = store.conversations.filter((conversation) => conversation.id !== id);
    await writeStore(store);
    return before !== store.conversations.length;
  }
}
