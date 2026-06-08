<script setup>
import { onMounted, ref } from "vue";
import ChatComposer from "./components/ChatComposer.vue";
import ConversationSidebar from "./components/ConversationSidebar.vue";
import MessageList from "./components/MessageList.vue";
import { useConversations } from "./composables/useConversations.js";

const { state, messages, boot, create, open, remove, clear, send } = useConversations();
const sidebarOpen = ref(false);

async function selectConversation(id) {
  await open(id);
  sidebarOpen.value = false;
}

onMounted(boot);
</script>

<template>
  <a class="skip-link" href="#conversation">跳到对话内容</a>
  <main class="app-shell">
    <section class="workspace">
      <ConversationSidebar
        :conversations="state.conversations"
        :active-id="state.activeId"
        :open="sidebarOpen"
        @create="create"
        @select="selectConversation"
        @remove="remove"
        @close="sidebarOpen = false"
      />

      <section id="conversation" class="chat-panel">
        <header class="chat-header">
          <button class="menu-button" type="button" aria-label="打开会话列表" @click="sidebarOpen = true">
            ☰
          </button>
          <div>
            <p class="eyebrow">动物学问答</p>
            <h2>{{ state.activeConversation?.title || "新的观察记录" }}</h2>
          </div>
          <button class="clear-button" type="button" :disabled="state.busy" @click="clear">
            清空
          </button>
        </header>

        <p v-if="state.error" class="error-banner" role="alert">{{ state.error }}</p>

        <MessageList
          :messages="messages"
          :streaming-index="state.streamingIndex"
          :loading="state.loading"
        />
        <ChatComposer :busy="state.busy" @send="send" />
      </section>
    </section>
  </main>
</template>
