import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config/env.js";

const storePath = join(dataDir, "knowledge.json");
let writeQueue = Promise.resolve();

function createId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function readStore() {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8"));
    return {
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      chunks: Array.isArray(parsed.chunks) ? parsed.chunks : []
    };
  } catch {
    return { documents: [], chunks: [] };
  }
}

async function writeStore(store) {
  if (process.env.VERCEL) {
    throw new Error("Vercel 部署必须使用 Postgres 保存知识库。");
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

function withWriteLock(operation) {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.catch(() => {});
  return run;
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return dot / ((Math.sqrt(leftNorm) || 1) * (Math.sqrt(rightNorm) || 1));
}

export class JsonKnowledgeRepository {
  async listDocuments() {
    const store = await readStore();
    return [...store.documents].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  async createDocument(input) {
    return withWriteLock(async () => {
      const store = await readStore();
      const timestamp = new Date().toISOString();
      const document = {
        id: createId(),
        filename: input.filename,
        contentType: input.contentType,
        size: input.size || 0,
        url: input.url,
        pathname: input.pathname || "",
        status: "processing",
        chunkCount: 0,
        embeddingModel: input.embeddingModel,
        error: "",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      store.documents.unshift(document);
      await writeStore(store);
      return document;
    });
  }

  async completeDocument(id, chunks) {
    return withWriteLock(async () => {
      const store = await readStore();
      const document = store.documents.find((item) => item.id === id);
      if (!document) throw new Error(`Document not found: ${id}`);
      store.chunks = store.chunks.filter((chunk) => chunk.documentId !== id);
      store.chunks.push(
        ...chunks.map((chunk) => ({
          id: createId(),
          documentId: id,
          ...chunk
        }))
      );
      document.status = "ready";
      document.chunkCount = chunks.length;
      document.updatedAt = new Date().toISOString();
      await writeStore(store);
      return document;
    });
  }

  async failDocument(id, error) {
    return withWriteLock(async () => {
      const store = await readStore();
      const document = store.documents.find((item) => item.id === id);
      if (!document) return null;
      document.status = "failed";
      document.error = String(error || "文档处理失败。").slice(0, 500);
      document.updatedAt = new Date().toISOString();
      await writeStore(store);
      return document;
    });
  }

  async deleteDocument(id) {
    return withWriteLock(async () => {
      const store = await readStore();
      const before = store.documents.length;
      store.documents = store.documents.filter((item) => item.id !== id);
      store.chunks = store.chunks.filter((item) => item.documentId !== id);
      await writeStore(store);
      return before !== store.documents.length;
    });
  }

  async search(queryEmbedding, limit = 8) {
    const store = await readStore();
    const documents = new Map(store.documents.map((document) => [document.id, document]));
    return store.chunks
      .map((chunk) => ({
        ...chunk,
        document: documents.get(chunk.documentId),
        score: cosineSimilarity(queryEmbedding, chunk.embedding)
      }))
      .filter((chunk) => chunk.document?.status === "ready")
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
