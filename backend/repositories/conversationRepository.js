import { getServerConfig } from "../config/env.js";
import { JsonConversationRepository, welcomeMessage } from "./jsonConversationRepository.js";
import { PostgresConversationRepository } from "./postgresConversationRepository.js";

function createRepository() {
  const { storageProvider } = getServerConfig();
  if (storageProvider === "postgres") return new PostgresConversationRepository();
  return new JsonConversationRepository();
}

export { welcomeMessage };
export const conversationRepository = createRepository();
