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
import { getRouteParts, readBinaryBody, readJsonBody, sanitizeMessages, sendJson } from "../utils/http.js";
import { sendSse, setupSse } from "../utils/sse.js";
import {
  createUploadToken,
  deleteDocument,
  getBlobUploadMode,
  listDocuments,
  processDirectDocument,
  processUploadedDocument
} from "../services/knowledgeService.js";
import { getKnowledgeConfig } from "../config/env.js";

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

    if (req.method === "GET" && parts[1] === "documents" && parts.length === 2) {
      sendJson(res, 200, {
        documents: await listDocuments(),
        uploadMode: getBlobUploadMode(req),
        maxFileBytes: getKnowledgeConfig().maxFileBytes
      });
      return true;
    }

    if (req.method === "POST" && parts[1] === "documents" && parts[2] === "upload") {
      const body = await readJsonBody(req);
      sendJson(res, 200, await createUploadToken(req, body));
      return true;
    }

    if (req.method === "POST" && parts[1] === "documents" && parts[2] === "process") {
      const body = await readJsonBody(req);
      const document = await processUploadedDocument(
        {
          filename: body.filename,
          contentType: body.contentType,
          size: body.size,
          url: body.url,
          pathname: body.pathname
        },
        req
      );
      sendJson(res, 201, { document });
      return true;
    }

    if (req.method === "POST" && parts[1] === "documents" && parts[2] === "direct") {
      const config = getKnowledgeConfig();
      const buffer = await readBinaryBody(req, config.maxFileBytes);
      const document = await processDirectDocument(
        {
          filename: decodeURIComponent(String(req.headers["x-file-name"] || "document")),
          contentType: String(req.headers["content-type"] || "application/octet-stream"),
          size: buffer.length
        },
        buffer
      );
      sendJson(res, 201, { document });
      return true;
    }

    if (req.method === "DELETE" && parts[1] === "documents" && parts[2]) {
      const deleted = await deleteDocument(parts[2], req);
      sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "Document not found" });
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
      // SSE 连接关闭意味着用户已刷新或离开页面，用 AbortSignal 取消后端所有上游调用。
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort(new DOMException("Client disconnected.", "AbortError"));
      });
      try {
        const conversation = await appendUserMessageAndStream(parts[2], content, {
          status: (message) => sendSse(res, "status", { message }),
          sources: (payload) => sendSse(res, "sources", payload),
          images: (payload) => sendSse(res, "images", payload),
          delta: (delta) => sendSse(res, "delta", { content: delta }),
          // Critic 修订返回完整文本，使用独立事件通知前端覆盖现有草稿。
          replace: (replacement) => sendSse(res, "replace", { content: replacement }),
          signal: controller.signal
        });
        sendSse(res, "done", { ok: true, conversation });
      } catch (error) {
        // 客户端已经离开时无法消费错误事件，也不应继续向关闭的 socket 写数据。
        if (!controller.signal.aborted) {
          sendSse(res, "error", { message: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        if (!res.writableEnded) res.end();
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
