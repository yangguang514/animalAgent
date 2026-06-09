<script setup>
import { upload } from "@vercel/blob/client";
import { computed, onMounted, ref } from "vue";
import { chatApi } from "../services/chatApi.js";

const props = defineProps({ busy: { type: Boolean, default: false } });
const documents = ref([]);
const expanded = ref(false);
const loading = ref(true);
const uploading = ref(false);
const progress = ref(0);
const phase = ref("idle");
const error = ref("");
const input = ref(null);
const uploadMode = ref("blob");
const maxFileBytes = ref(25 * 1024 * 1024);

const readyCount = computed(
  () => documents.value.filter((document) => document.status === "ready").length
);
const uploadDisabled = computed(
  () => props.busy || uploading.value || uploadMode.value === "disabled"
);

function formatSize(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function statusLabel(document) {
  if (document.status === "ready") return `${document.chunkCount} 个知识片段`;
  if (document.status === "failed") return document.error || "解析失败";
  return "正在解析并生成向量";
}

async function refresh() {
  loading.value = true;
  try {
    const data = await chatApi.listDocuments();
    documents.value = data.documents || [];
    // 后端根据运行环境决定直传方式，前端不自行推断是否位于 Vercel。
    uploadMode.value = data.uploadMode || "blob";
    maxFileBytes.value = Number(data.maxFileBytes || maxFileBytes.value);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

async function chooseFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  expanded.value = true;
  uploading.value = true;
  phase.value = "uploading";
  progress.value = 0;
  error.value = "";
  try {
    if (file.size > maxFileBytes.value) {
      throw new Error(`文件不能超过 ${Math.round(maxFileBytes.value / 1024 / 1024)} MB。`);
    }
    // 本地直接发给 Express；生产环境先直传 Blob，再通知后端解析 Blob URL。
    if (uploadMode.value === "direct") {
      phase.value = "processing";
      await chatApi.uploadDocumentDirect(file);
    } else {
      const blob = await upload(`knowledge/${file.name}`, file, {
        access: "public",
        handleUploadUrl: "/api/documents/upload",
        multipart: file.size > 5 * 1024 * 1024,
        onUploadProgress: ({ percentage }) => {
          progress.value = Math.round(percentage);
        }
      });
      phase.value = "processing";
      await chatApi.processDocument({
        filename: file.name,
        contentType: file.type || blob.contentType,
        size: file.size,
        url: blob.url,
        pathname: blob.pathname
      });
    }
    await refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    await refresh();
  } finally {
    uploading.value = false;
    phase.value = "idle";
    progress.value = 0;
  }
}

async function removeDocument(document) {
  if (props.busy || uploading.value) return;
  error.value = "";
  try {
    await chatApi.removeDocument(document.id);
    documents.value = documents.value.filter((item) => item.id !== document.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

onMounted(refresh);
</script>

<template>
  <section class="knowledge-dock" :class="{ expanded }">
    <div class="knowledge-toolbar">
      <button
        class="knowledge-toggle"
        type="button"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <span class="knowledge-icon" aria-hidden="true">K</span>
        <span>
          <strong>知识文件</strong>
          <small>{{ readyCount ? `${readyCount} 份已可检索` : "导入 PDF、DOCX 或文本" }}</small>
        </span>
      </button>

      <input
        ref="input"
        class="visually-hidden"
        type="file"
        accept=".pdf,.docx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
        :disabled="uploadDisabled"
        @change="chooseFile"
      />
      <button
        class="knowledge-upload"
        type="button"
        :disabled="uploadDisabled"
        @click="input?.click()"
      >
        {{
          uploading
            ? phase === "processing"
              ? "正在解析"
              : `上传 ${progress}%`
            : uploadMode === "disabled"
              ? "未配置 Blob"
              : "导入文件"
        }}
      </button>
    </div>

    <div v-if="expanded" class="knowledge-panel">
      <p v-if="error" class="knowledge-error" role="alert">{{ error }}</p>
      <div v-if="uploading" class="upload-progress" aria-live="polite">
        <span :style="{ width: `${progress}%` }" />
      </div>

      <p v-if="loading" class="knowledge-empty">正在读取知识库...</p>
      <p v-else-if="!documents.length && !uploading" class="knowledge-empty">
        文件解析完成后，Agent 会在每次提问前自动检索相关片段。
      </p>
      <div v-else class="document-list">
        <article v-for="document in documents" :key="document.id" class="document-item">
          <span class="document-format">{{ document.filename.split(".").pop()?.toUpperCase() }}</span>
          <div>
            <strong>{{ document.filename }}</strong>
            <small :class="`status-${document.status}`">
              {{ statusLabel(document) }} · {{ formatSize(document.size) }}
            </small>
          </div>
          <button
            type="button"
            :aria-label="`删除 ${document.filename}`"
            :disabled="busy || uploading"
            @click="removeDocument(document)"
          >
            删除
          </button>
        </article>
      </div>
    </div>
  </section>
</template>
