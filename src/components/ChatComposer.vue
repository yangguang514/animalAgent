<script setup>
import { nextTick, ref } from "vue";
import KnowledgeDocuments from "./KnowledgeDocuments.vue";

defineProps({ busy: { type: Boolean, default: false } });
const emit = defineEmits(["send"]);
const prompt = ref("");
const input = ref(null);

const examples = [
  "介绍一下雪豹，它和花豹有什么区别？",
  "猫为什么会踩奶？",
  "海獭减少会怎样影响海带森林？"
];

function submit() {
  const content = prompt.value.trim();
  if (!content) return;
  emit("send", content);
  prompt.value = "";
  nextTick(() => input.value?.focus());
}

function useExample(example) {
  prompt.value = example;
  nextTick(() => input.value?.focus());
}
</script>

<template>
  <footer class="chat-footer">
    <KnowledgeDocuments :busy="busy" />
    <div class="examples" aria-label="示例问题">
      <button v-for="example in examples" :key="example" type="button" @click="useExample(example)">
        {{ example }}
      </button>
    </div>
    <form class="composer" @submit.prevent="submit">
      <textarea
        ref="input"
        v-model="prompt"
        rows="2"
        placeholder="输入动物、行为或物种对比问题..."
        aria-label="输入问题"
        :disabled="busy"
        @keydown.enter.exact.prevent="submit"
      />
      <button type="submit" :disabled="busy || !prompt.trim()">
        {{ busy ? "生成中" : "发送" }}
      </button>
    </form>
  </footer>
</template>
