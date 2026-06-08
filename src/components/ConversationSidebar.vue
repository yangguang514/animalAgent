<script setup>
defineProps({
  conversations: { type: Array, required: true },
  activeId: { type: String, default: "" },
  open: { type: Boolean, default: false }
});

const emit = defineEmits(["create", "select", "remove", "close"]);

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function confirmRemove(conversation) {
  if (window.confirm(`删除“${conversation.title}”？此操作无法撤销。`)) {
    emit("remove", conversation.id);
  }
}
</script>

<template>
  <button
    class="sidebar-backdrop"
    :class="{ visible: open }"
    type="button"
    aria-label="关闭会话列表"
    @click="emit('close')"
  />
  <aside class="sidebar" :class="{ open }" aria-label="会话导航">
    <header class="brand">
      <span class="brand-mark" aria-hidden="true">A</span>
      <div>
        <h1>AnimalAgent</h1>
        <p>自然观察与动物知识助手</p>
      </div>
    </header>

    <button class="new-chat" type="button" @click="emit('create')">
      <span>新建观察记录</span>
      <span aria-hidden="true">＋</span>
    </button>

    <section class="conversation-section">
      <p class="section-label">最近对话</p>
      <div class="conversation-list">
        <article
          v-for="conversation in conversations"
          :key="conversation.id"
          class="conversation-item"
          :class="{ active: conversation.id === activeId }"
        >
          <button class="conversation-open" type="button" @click="emit('select', conversation.id)">
            <strong>{{ conversation.title }}</strong>
            <time>{{ formatDate(conversation.updatedAt) }}</time>
          </button>
          <button
            class="conversation-remove"
            type="button"
            :aria-label="`删除 ${conversation.title}`"
            @click="confirmRemove(conversation)"
          >
            ×
          </button>
        </article>
      </div>
    </section>

    <dl class="capabilities">
      <div><dt>物种百科</dt><dd>特征、栖息地与保护现状</dd></div>
      <div><dt>行为解读</dt><dd>从演化动机解释动物行为</dd></div>
      <div><dt>生态关联</dt><dd>把物种放回真实生态位</dd></div>
    </dl>
  </aside>
</template>
