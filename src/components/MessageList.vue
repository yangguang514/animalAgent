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
  () => [
    props.messages.length,
    props.messages.map((message) => message.content).join(""),
    props.messages.map((message) => message.images?.length || 0).join(",")
  ],
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
        <div
          v-if="message.role === 'assistant' && message.images?.length"
          class="message-images"
          aria-label="相关图片"
        >
          <figure v-for="image in message.images" :key="image.id || image.url">
            <a :href="image.sourceUrl || image.url" target="_blank" rel="noreferrer">
              <img
                :src="image.thumbnailUrl || image.url"
                :alt="image.alt || image.caption || '相关图片'"
                loading="lazy"
                referrerpolicy="no-referrer"
              />
            </a>
            <figcaption>
              <span>{{ image.caption || image.alt || "相关图片" }}</span>
              <small v-if="image.sourceTitle || image.sourceId">
                {{ image.sourceId ? `[${image.sourceId}] ` : "" }}{{ image.sourceTitle }}
              </small>
            </figcaption>
          </figure>
        </div>
        <nav
          v-if="message.role === 'assistant' && message.sources?.length && index !== streamingIndex"
          class="sources"
          aria-label="信息来源"
        >
          <template v-for="source in message.sources" :key="`${source.id}-${source.url || 'local'}`">
            <a v-if="source.url" :href="source.url" target="_blank" rel="noreferrer">
              <span>[{{ source.id }}]</span>
              {{ source.title }}
              <small v-if="source.type === 'knowledge' && source.pageNumber">
                第 {{ source.pageNumber }} 页
              </small>
            </a>
            <span v-else class="source-static">
              <span>[{{ source.id }}]</span>
              {{ source.title }}
              <small v-if="source.pageNumber">第 {{ source.pageNumber }} 页</small>
            </span>
          </template>
        </nav>
      </div>
    </article>
  </section>
</template>
