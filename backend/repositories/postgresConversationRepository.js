import { neon } from "@neondatabase/serverless";
import { welcomeMessage } from "./jsonConversationRepository.js";

function createId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toConversation(row, messages = []) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    messages: messages.filter((message) => message.role !== "assistant" || message.content.trim())
  };
}

function toMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    sources: Array.isArray(row.sources) ? row.sources : [],
    agents: row.agents && typeof row.agents === "object" ? row.agents : undefined,
    status: row.status || "complete"
  };
}

export class PostgresConversationRepository {
  constructor() {
    this.sql = null;
    this.ready = null;
  }

  async getSql() {
    const connectionString =
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error("STORAGE_PROVIDER=postgres requires Vercel Postgres env vars such as POSTGRES_URL.");
    }

    if (!this.sql) {
      this.sql = neon(connectionString, { fullResults: true });
    }
    return this.sql;
  }

  async ensureSchema() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const sql = await this.getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS animal_conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS animal_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES animal_conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          sources JSONB NOT NULL DEFAULT '[]'::jsonb,
          position INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        ALTER TABLE animal_messages
        ADD COLUMN IF NOT EXISTS position INTEGER
      `;
      await sql`
        ALTER TABLE animal_messages
        ADD COLUMN IF NOT EXISTS agents JSONB
      `;
      await sql`
        ALTER TABLE animal_messages
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete'
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS animal_messages_conversation_created_idx
        ON animal_messages(conversation_id, position, created_at)
      `;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS animal_messages_one_streaming_per_conversation_idx
        ON animal_messages(conversation_id)
        WHERE status = 'streaming'
      `;
    })();
    return this.ready;
  }

  async list() {
    await this.ensureSchema();
    const sql = await this.getSql();
    const result = await sql`
      SELECT
        c.id,
        c.title,
        c.created_at,
        c.updated_at,
        COUNT(m.id) FILTER (
          WHERE NOT (m.role = 'assistant' AND btrim(m.content) = '')
        )::int AS message_count
      FROM animal_conversations c
      LEFT JOIN animal_messages m ON m.conversation_id = c.id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
    `;
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      messageCount: row.message_count
    }));
  }

  async get(id) {
    await this.ensureSchema();
    const sql = await this.getSql();
    const conversationResult = await sql`
      SELECT id, title, created_at, updated_at
      FROM animal_conversations
      WHERE id = ${id}
      LIMIT 1
    `;
    const row = conversationResult.rows[0];
    if (!row) return null;

    const messagesResult = await sql`
      SELECT id, role, content, sources, agents, status
      FROM animal_messages
      WHERE conversation_id = ${id}
      ORDER BY position ASC NULLS LAST, created_at ASC
    `;
    return toConversation(row, messagesResult.rows.map(toMessage));
  }

  async create(title = "新的动物对话") {
    return this.import({ title, messages: [welcomeMessage()] });
  }

  async import({ title = "已迁移的对话", messages = [] }) {
    await this.ensureSchema();
    const sql = await this.getSql();
    const id = createId();
    await sql`
      INSERT INTO animal_conversations (id, title)
      VALUES (${id}, ${title})
    `;
    const conversation = {
      id,
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: messages.length ? messages : [welcomeMessage()]
    };
    await this.replaceMessages(conversation);
    return this.get(id);
  }

  async save(conversation) {
    await this.ensureSchema();
    const sql = await this.getSql();
    await sql`
      INSERT INTO animal_conversations (id, title, created_at, updated_at)
      VALUES (${conversation.id}, ${conversation.title}, ${conversation.createdAt || new Date().toISOString()}, NOW())
      ON CONFLICT (id)
      DO UPDATE SET title = EXCLUDED.title, updated_at = NOW()
    `;
    await this.replaceMessages(conversation);
    return this.get(conversation.id);
  }

  async appendTurn(conversationId, userMessage, assistantMessage, title) {
    await this.ensureSchema();
    const sql = await this.getSql();
    const userId = userMessage.id || createId();
    const assistantId = assistantMessage.id || createId();

    // advisory lock 以 conversationId 为粒度串行化位置计算，避免两个请求拿到相同 position。
    // 唯一部分索引进一步保证同一会话数据库层面只能存在一个 streaming 回答。
    await sql.transaction((txn) => [
      txn`SELECT pg_advisory_xact_lock(hashtext(${conversationId}))`,
      // Serverless 实例可能在断连后直接退出，允许新请求接管超过 15 分钟的遗留草稿。
      txn`
        UPDATE animal_messages
        SET status = 'interrupted'
        WHERE conversation_id = ${conversationId}
          AND status = 'streaming'
          AND created_at < NOW() - INTERVAL '15 minutes'
      `,
      txn`
        UPDATE animal_conversations
        SET title = ${title}, updated_at = NOW()
        WHERE id = ${conversationId}
      `,
      txn`
        -- 用户消息与 assistant 草稿在同一事务提交，避免只保存了半个问答回合。
        INSERT INTO animal_messages (id, conversation_id, role, content, sources, agents, status, position)
        SELECT
          ${userId},
          ${conversationId},
          ${userMessage.role},
          ${userMessage.content},
          ${JSON.stringify(userMessage.sources || [])}::jsonb,
          ${JSON.stringify(userMessage.agents || null)}::jsonb,
          ${userMessage.status || "complete"},
          COALESCE(MAX(position), -1) + 1
        FROM animal_messages
        WHERE conversation_id = ${conversationId}
      `,
      txn`
        INSERT INTO animal_messages (id, conversation_id, role, content, sources, agents, status, position)
        SELECT
          ${assistantId},
          ${conversationId},
          ${assistantMessage.role},
          ${assistantMessage.content || ""},
          ${JSON.stringify(assistantMessage.sources || [])}::jsonb,
          ${JSON.stringify(assistantMessage.agents || null)}::jsonb,
          ${assistantMessage.status || "streaming"},
          COALESCE(MAX(position), -1) + 1
        FROM animal_messages
        WHERE conversation_id = ${conversationId}
      `
    ]);

    return { conversation: await this.get(conversationId), assistantMessageId: assistantId };
  }

  async updateMessage(conversationId, messageId, patch = {}) {
    await this.ensureSchema();
    const sql = await this.getSql();
    const content = patch.content === undefined ? null : String(patch.content);
    const sources = patch.sources === undefined ? null : JSON.stringify(patch.sources || []);
    const agents = patch.agents === undefined ? null : JSON.stringify(patch.agents);
    const status = patch.status === undefined ? null : String(patch.status);

    // null 表示“不修改该字段”，因此同一个方法可用于草稿刷新、失败收尾和最终完成。
    const result = await sql`
      UPDATE animal_messages
      SET
        content = COALESCE(${content}, content),
        sources = COALESCE(${sources}::jsonb, sources),
        agents = CASE WHEN ${agents}::text IS NULL THEN agents ELSE ${agents}::jsonb END,
        status = COALESCE(${status}, status)
      WHERE conversation_id = ${conversationId} AND id = ${messageId}
      RETURNING id
    `;
    if (!result.rows.length) throw new Error(`Message not found: ${messageId}`);
    await sql`UPDATE animal_conversations SET updated_at = NOW() WHERE id = ${conversationId}`;
    return this.get(conversationId);
  }

  async updateTitle(conversationId, title) {
    // 标题独立更新，避免旧的 conversation 快照覆盖并发追加的消息。
    await this.ensureSchema();
    const sql = await this.getSql();
    await sql`
      UPDATE animal_conversations
      SET title = ${title}, updated_at = NOW()
      WHERE id = ${conversationId}
    `;
    return this.get(conversationId);
  }

  async replaceMessages(conversation) {
    const sql = await this.getSql();
    const messages = (conversation.messages || []).filter(
      (message) => message.role !== "assistant" || String(message.content || "").trim()
    );
    // import/save 仍需要全量替换，但删除和重建必须处于同一事务，失败时整体回滚。
    await sql.transaction((txn) => [
      txn`SELECT pg_advisory_xact_lock(hashtext(${conversation.id}))`,
      txn`DELETE FROM animal_messages WHERE conversation_id = ${conversation.id}`,
      ...messages.map(
        (message, index) => txn`
        INSERT INTO animal_messages (id, conversation_id, role, content, sources, agents, status, position)
        VALUES (
          ${message.id || createId()},
          ${conversation.id},
          ${message.role},
          ${message.content},
          ${JSON.stringify(message.sources || [])}::jsonb,
          ${JSON.stringify(message.agents || null)}::jsonb,
          ${message.status || "complete"},
          ${index}
        )
      `
      )
    ]);
  }

  async delete(id) {
    await this.ensureSchema();
    const sql = await this.getSql();
    const result = await sql`DELETE FROM animal_conversations WHERE id = ${id}`;
    return result.rowCount > 0;
  }
}
