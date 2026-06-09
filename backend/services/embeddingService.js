import { getEmbeddingConfig } from "../config/env.js";
import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function hashText(text, dimensions) {
  const vector = new Array(dimensions).fill(0);
  const normalized = String(text || "").normalize("NFKC").toLowerCase();
  const units = [...normalized];

  for (let index = 0; index < units.length; index += 1) {
    const gram = units.slice(index, index + 3).join("");
    let hash = 2166136261;
    for (const char of gram) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = Math.abs(hash) % dimensions;
    vector[bucket] += hash & 1 ? 1 : -1;
  }
  return normalizeVector(vector);
}

async function requestEmbeddings(texts, config) {
  const response = await fetchWithTimeout(
    `${config.baseURL}/embeddings`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.key}`
      },
      body: JSON.stringify({
        model: config.model,
        input: texts,
        dimensions: config.dimensions
      })
    },
    config.timeoutMs
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Embedding 接口请求失败：HTTP ${response.status}`);
  }
  const embeddings = (data.data || [])
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
  if (embeddings.length !== texts.length) throw new Error("Embedding 接口返回数量不完整。");
  return embeddings;
}

export async function embedTexts(texts = []) {
  if (!texts.length) return [];
  const config = getEmbeddingConfig();
  if (config.provider === "local") {
    return texts.map((text) => hashText(text, config.dimensions));
  }

  const output = [];
  for (let index = 0; index < texts.length; index += config.batchSize) {
    const batch = texts.slice(index, index + config.batchSize);
    output.push(...(await requestEmbeddings(batch, config)));
  }
  return output;
}

export async function embedQuery(text) {
  return (await embedTexts([text]))[0];
}
