import {
  appendUserMessageAndStream,
  askOnce,
  clearConversation,
  createConversation,
  deleteConversation,
  getConversation,
  importConversation,
  listConversations
} from "../services/chatService.js";
import { AGENT_PATTERNS } from "../agents/animalAgentOrchestrator.js";
import { generateLocalTitle } from "../services/titleService.js";
import { getRouteParts, readJsonBody, sanitizeMessages, sendJson } from "../utils/http.js";
import { sendSse, setupSse } from "../utils/sse.js";

export async function handleApi(req, res) {
  const parts = getRouteParts(req.url);

  if (req.method === "GET" && (req.url === "/health" || (parts[0] === "api" && parts[1] === "health"))) {
    sendJson(res, 200, { ok: true, name: "animal-agent" });
    return true;
  }

  if (parts[0] !== "api") return false;

  try {
    if (req.method === "GET" && parts[1] === "conversations" && parts.length === 2) {
      sendJson(res, 200, { conversations: await listConversations() });
      return true;
    }

    if (req.method === "GET" && parts[1] === "agents") {
      sendJson(res, 200, { patterns: AGENT_PATTERNS });
      return true;
    }

    if (req.method === "POST" && parts[1] === "conversations" && parts.length === 2) {
      sendJson(res, 201, { conversation: await createConversation() });
      return true;
    }

    if (req.method === "POST" && parts[1] === "conversations" && parts[2] === "import") {
      const body = await readJsonBody(req);
      const messages = sanitizeMessages(body.messages);
      sendJson(res, 201, {
        conversation: await importConversation({
          title: String(body.title || "已迁移的对话").slice(0, 32),
          messages
        })
      });
      return true;
    }

    if (req.method === "GET" && parts[1] === "conversations" && parts[2]) {
      const conversation = await getConversation(parts[2]);
      if (!conversation) sendJson(res, 404, { error: "Conversation not found" });
      else sendJson(res, 200, { conversation });
      return true;
    }

    if (req.method === "DELETE" && parts[1] === "conversations" && parts[2]) {
      const deleted = await deleteConversation(parts[2]);
      sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "Conversation not found" });
      return true;
    }

    if (req.method === "POST" && parts[1] === "conversations" && parts[2] && parts[3] === "clear") {
      const conversation = await clearConversation(parts[2]);
      if (!conversation) sendJson(res, 404, { error: "Conversation not found" });
      else sendJson(res, 200, { conversation });
      return true;
    }

    if (req.method === "POST" && parts[1] === "conversations" && parts[2] && parts[3] === "chat" && parts[4] === "stream") {
      const body = await readJsonBody(req);
      const content = String(body.content || "").trim();
      if (!content) {
        sendJson(res, 400, { error: "content is required" });
        return true;
      }

      setupSse(res);
      try {
        const conversation = await appendUserMessageAndStream(parts[2], content, {
          status: (message) => sendSse(res, "status", { message }),
          sources: (payload) => sendSse(res, "sources", payload),
          delta: (delta) => sendSse(res, "delta", { content: delta })
        });
        sendSse(res, "done", { ok: true, conversation });
      } catch (error) {
        sendSse(res, "error", { message: error instanceof Error ? error.message : String(error) });
      } finally {
        res.end();
      }
      return true;
    }

    // Compatibility endpoints for earlier frontend/API callers.
    if (req.method === "POST" && parts[1] === "chat") {
      const body = await readJsonBody(req);
      const messages = sanitizeMessages(body.messages);
      if (!messages.length || messages[messages.length - 1].role !== "user") {
        sendJson(res, 400, { error: "messages 最后一条必须是用户问题。" });
        return true;
      }
      sendJson(res, 200, await askOnce(messages));
      return true;
    }

    if (req.method === "POST" && parts[1] === "title") {
      const body = await readJsonBody(req);
      sendJson(res, 200, { title: generateLocalTitle(sanitizeMessages(body.messages)) });
      return true;
    }

    sendJson(res, 404, { error: "Not found" });
    return true;
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
