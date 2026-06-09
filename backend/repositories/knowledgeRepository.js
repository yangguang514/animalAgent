import { getServerConfig } from "../config/env.js";
import { JsonKnowledgeRepository } from "./jsonKnowledgeRepository.js";
import { PostgresKnowledgeRepository } from "./postgresKnowledgeRepository.js";

function createRepository() {
  // 与会话仓储保持同一开关：本地使用 JSON，部署环境使用 Neon Postgres。
  return getServerConfig().storageProvider === "postgres"
    ? new PostgresKnowledgeRepository()
    : new JsonKnowledgeRepository();
}

export const knowledgeRepository = createRepository();
