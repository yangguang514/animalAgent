import { computed, reactive } from "vue";
import { chatApi } from "../services/chatApi.js";
import { streamChat } from "../services/chatStream.js";

const ACTIVE_KEY = "animal-agent-active-conversation-id";

export function useConversations() {
  const state = reactive({
    conversations: [],
    activeId: localStorage.getItem(ACTIVE_KEY) || "",
    activeConversation: null,
    streamingIndex: -1,
    busy: false,
    loading: true,
    error: ""
  });

  const messages = computed(() => state.activeConversation?.messages || []);

  async function refresh() {
    const data = await chatApi.list();
    state.conversations = data.conversations || [];
  }

  async function open(id) {
    if (state.busy) return;
    const data = await chatApi.get(id);
    state.activeId = data.conversation.id;
    state.activeConversation = data.conversation;
    localStorage.setItem(ACTIVE_KEY, state.activeId);
  }

  async function create() {
    const data = await chatApi.create();
    await refresh();
    await open(data.conversation.id);
  }

  async function remove(id) {
    await chatApi.remove(id);
    await refresh();
    if (id !== state.activeId) return;
    const next = state.conversations[0];
    if (next) await open(next.id);
    else await create();
  }

  async function clear() {
    if (!state.activeId || state.busy) return;
    const data = await chatApi.clear(state.activeId);
    state.activeConversation = data.conversation;
    await refresh();
  }

  async function send(content) {
    const text = content.trim();
    if (!text || state.busy || !state.activeConversation) return;

    state.error = "";
    state.busy = true;
    state.activeConversation.messages.push({ role: "user", content: text, sources: [] });
    state.streamingIndex =
      state.activeConversation.messages.push({ role: "assistant", content: "", sources: [] }) - 1;

    try {
      await streamChat(state.activeId, text, (event, data) => {
        const assistant = state.activeConversation.messages[state.streamingIndex];
        if (!assistant) return;
        if (event === "sources") assistant.sources = data.sources || [];
        if (event === "delta") assistant.content += data.content || "";
        // Revision Agent 返回完整修订稿，不能像 Writer token 一样追加。
        if (event === "replace") assistant.content = data.content || assistant.content;
        if (event === "error") throw new Error(data.message || "流式响应失败");
        if (event === "done") state.activeConversation = data.conversation;
      });
      await refresh();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      const assistant = state.activeConversation.messages[state.streamingIndex];
      if (assistant && !assistant.content) assistant.content = "服务暂时不可用，请稍后重试。";
    } finally {
      state.streamingIndex = -1;
      state.busy = false;
    }
  }

  async function boot() {
    state.loading = true;
    state.error = "";
    try {
      await refresh();
      if (state.activeId && state.conversations.some((item) => item.id === state.activeId)) {
        await open(state.activeId);
      } else {
        await create();
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.loading = false;
    }
  }

  return { state, messages, boot, create, open, remove, clear, send };
}
