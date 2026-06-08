import { getLlmConfig } from "../config/env.js";
import { titleSystemPrompt } from "../prompts/titleSystemPrompt.js";
import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";

const DEFAULT_TITLE = "动物知识问答";
const fillerPattern =
  /帮我|请问|请|介绍一下|介绍|顺便说下|说下|一下|什么是|是什么|为什么|怎么|如何|有没有|吗|呢|吧/gu;
const comparePattern = /有什么区别|有啥区别|区别是什么|差异是什么|有什么不同|有啥不同|vs|VS/gu;

function parseBooleanEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function firstUserMessage(messages = []) {
  return messages.find((message) => message?.role === "user" && String(message.content || "").trim())?.content || "";
}

function firstAssistantAnswer(messages = []) {
  const firstUserIndex = messages.findIndex(
    (message) => message?.role === "user" && String(message.content || "").trim()
  );
  if (firstUserIndex === -1) return "";

  return messages
    .slice(firstUserIndex + 1)
    .find((message) => message?.role === "assistant" && String(message.content || "").trim())?.content || "";
}

// 本地标题只依据首个用户问题，避免随着追问增加而把多个主题生硬拼接在一起。
export function generateLocalTitle(messages = []) {
  const cleaned = String(firstUserMessage(messages))
    .replace(comparePattern, " 区别 ")
    .replace(fillerPattern, " ")
    .replace(/[^\p{Script=Han}a-zA-Z0-9\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.match(/[\p{Script=Han}]{2,8}|[a-zA-Z0-9]{2,20}/gu) || [];
  return words.slice(0, 3).join("").slice(0, 18) || DEFAULT_TITLE;
}

// 清理模型可能附带的“标题：”、Markdown、引号和句末标点，保证侧边栏标题短而稳定。
export function normalizeGeneratedTitle(value, fallback = DEFAULT_TITLE) {
  const title = String(value || "")
    .split(/\r?\n/)[0]
    .replace(/^[#*\s"'“”‘’《》「」『』]+|[#*\s"'“”‘’《》「」『』]+$/gu, "")
    .replace(/^\s*(?:标题|会话标题|主题)\s*[:：]\s*/i, "")
    .replace(/[。！？!?，,；;：:]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();

  if (title.length < 2) return fallback;
  return title.slice(0, 20);
}

function buildTitleMessages(messages = []) {
  const question = String(firstUserMessage(messages)).replace(/\s+/g, " ").trim().slice(0, 800);
  const answer = String(firstAssistantAnswer(messages)).replace(/\s+/g, " ").trim().slice(0, 1200);

  return [
    {
      role: "system",
      content: titleSystemPrompt
    },
    {
      role: "user",
      content: `用户问题：${question || "无"}
回答摘要素材：${answer || "暂无回答，请仅根据用户问题拟题"}`
    }
  ];
}

// 首轮回答完成后调用小模型精炼标题；缺少 Key、超时或格式异常时保留本地标题。
export async function generateConversationTitle(messages = [], options = {}) {
  const fallback = options.fallback || generateLocalTitle(messages);
  if (parseBooleanEnv("TITLE_GENERATOR_DISABLED", false)) return fallback;

  const config = options.config || getLlmConfig();
  if (!config.key) return fallback;

  try {
    const fetcher = options.fetcher || fetchWithTimeout;
    const response = await fetcher(
      `${config.baseURL}/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
        body: JSON.stringify({
          model: process.env.TITLE_GENERATOR_MODEL || config.model,
          temperature: 0.1,
          messages: buildTitleMessages(messages)
        })
      },
      Math.max(1500, Number(process.env.TITLE_GENERATOR_TIMEOUT_MS || 5000))
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return fallback;

    return normalizeGeneratedTitle(data?.choices?.[0]?.message?.content, fallback);
  } catch {
    return fallback;
  }
}
