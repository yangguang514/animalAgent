import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = fileURLToPath(new URL("../../", import.meta.url));
export const publicDir = join(rootDir, "public");
export const frontendDir = join(rootDir, "frontend", "src");
export const dataDir = join(rootDir, "data");

export async function loadEnvFile() {
  try {
    const content = await readFile(join(rootDir, ".env"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rawValue] = trimmed.split("=");
      const key = rawKey.trim().replace(/^export\s+/, "");
      const value = rawValue.join("=").trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional in deployed environments.
  }
}

export function getLlmConfig() {
  const key =
    process.env.ANIMAL_AGENT_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.OPENAI_API_KEY;

  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY && !process.env.DEEPSEEK_API_KEY);
  const baseURL =
    process.env.ANIMAL_AGENT_BASE_URL ||
    process.env.DEEPSEEK_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    (hasOpenAiKey ? "https://api.openai.com/v1" : "https://api.deepseek.com/v1");

  const model =
    process.env.ANIMAL_AGENT_MODEL ||
    process.env.DEEPSEEK_MODEL ||
    (hasOpenAiKey ? "gpt-4o-mini" : "deepseek-chat");

  return {
    key,
    baseURL: baseURL.replace(/\/$/, ""),
    model,
    temperature: Number(process.env.ANIMAL_AGENT_TEMPERATURE || 0.4)
  };
}

export function getSearchConfig() {
  const explicitProvider = (process.env.SEARCH_PROVIDER || "").trim().toLowerCase();
  const provider =
    explicitProvider ||
    (process.env.TAVILY_API_KEY || process.env.SEARCH_API_KEY
      ? "tavily"
      : process.env.SERPER_API_KEY
        ? "serper"
        : process.env.BRAVE_SEARCH_API_KEY
          ? "brave"
          : "off");

  const keyByProvider = {
    tavily: process.env.TAVILY_API_KEY || process.env.SEARCH_API_KEY,
    serper: process.env.SERPER_API_KEY || process.env.SEARCH_API_KEY,
    brave: process.env.BRAVE_SEARCH_API_KEY || process.env.SEARCH_API_KEY
  };
  const rawKey = keyByProvider[provider] || process.env.SEARCH_API_KEY;

  return {
    provider,
    key: rawKey && !/^your_.+_key_here$/i.test(rawKey.trim()) ? rawKey.trim() : "",
    maxResults: Math.max(1, Math.min(Number(process.env.SEARCH_MAX_RESULTS || 5), 8)),
    timeoutMs: Math.max(3000, Number(process.env.SEARCH_TIMEOUT_MS || 10000)),
    strictErrors: /^true$/i.test(process.env.SEARCH_STRICT_ERRORS || "")
  };
}

export function getServerConfig() {
  const hasPostgresEnv = Boolean(
    process.env.POSTGRES_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.DATABASE_URL
  );
  const defaultStorageProvider = process.env.VERCEL && hasPostgresEnv ? "postgres" : "json";
  return {
    port: Number(process.env.PORT || 3010),
    storageProvider: (process.env.STORAGE_PROVIDER || defaultStorageProvider).toLowerCase()
  };
}
