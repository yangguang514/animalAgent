<script setup>
import { nextTick, ref, watch } from "vue";
import { renderMarkdown } from "../utils/markdown.js";

const props = defineProps({
  messages: { type: Array, required: true },
  streamingIndex: { type: Number, default: -1 },
  loading: { type: Boolean, default: false }
});

const container = ref(null);

watch(
  () => [props.messages.length, props.messages.map((message) => message.content).join("")],
  async () => {
    await nextTick();
    if (container.value) container.value.scrollTop = container.value.scrollHeight;
  }
);
</script>

<template>
  <section ref="container" class="messages" aria-live="polite">
    <div v-if="loading" class="loading-state">
      <span />
      <span />
      <span />
    </div>

    <section v-else-if="!messages.length" class="empty-state">
      <span class="empty-kicker">FIELD NOTES · 01</span>
      <h2>从一个动物问题开始。</h2>
      <p>询问物种特征、行为原因或生态关系。需要检索时，回答会附上可继续阅读的信息来源。</p>
    </section>

    <article
      v-for="(message, index) in messages"
      v-else
      :key="`${index}-${message.role}`"
      class="message"
      :class="message.role"
    >
      <span class="message-label">{{ message.role === "user" ? "YOU" : "ANIMALAGENT" }}</span>
      <div class="bubble">
        <div
          v-if="message.content"
          class="markdown"
          v-html="renderMarkdown(message.content)"
        />
        <span v-else-if="index === streamingIndex" class="typing" aria-label="正在生成回答">
          <i /><i /><i />
        </span>
        <nav
          v-if="message.role === 'assistant' && message.sources?.length && index !== streamingIndex"
          class="sources"
          aria-label="信息来源"
        >
          <a
            v-for="source in message.sources"
            :key="source.url"
            :href="source.url"
            target="_blank"
            rel="noreferrer"
          >
            <span>[{{ source.id }}]</span>
            {{ source.title }}
          </a>
        </nav>
      </div>
    </article>
  </section>
</template>
