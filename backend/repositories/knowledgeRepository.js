import { getServerConfig } from "../config/env.js";
import { JsonKnowledgeRepository } from "./jsonKnowledgeRepository.js";
import { PostgresKnowledgeRepository } from "./postgresKnowledgeRepository.js";

function createRepository() {
  return getServerConfig().storageProvider === "postgres"
    ? new PostgresKnowledgeRepository()
    : new JsonKnowledgeRepository();
}

export const knowledgeRepository = createRepository();
