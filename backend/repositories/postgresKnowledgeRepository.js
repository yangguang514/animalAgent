import { neon } from "@neondatabase/serverless";
import { getEmbeddingConfig } from "../config/env.js";

function createId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toDocument(row) {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size || 0),
    url: row.url,
    pathname: row.pathname,
    status: row.status,
    chunkCount: Number(row.chunk_count || 0),
    embeddingModel: row.embedding_model,
    error: row.error || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

export class PostgresKnowledgeRepository {
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
    if (!connectionString) throw new Error("Postgres 知识库缺少数据库连接变量。");
    if (!this.sql) this.sql = neon(connectionString, { fullResults: true });
    return this.sql;
  }

  async ensureSchema() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const sql = await this.getSql();
      const dimensions = getEmbeddingConfig().dimensions;
      if (dimensions !== 1536) {
        throw new Error("当前 pgvector 表固定为 1536 维，请将 EMBEDDING_DIMENSIONS 设置为 1536。");
      }
      // 当前表结构固定为 1536 维，模型切换维度时必须显式迁移并重新生成全部向量。
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;
      await sql`
        CREATE TABLE IF NOT EXISTS animal_documents (
          id TEXT PRIMARY KEY,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size BIGINT NOT NULL DEFAULT 0,
          url TEXT NOT NULL,
          pathname TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'processing',
          chunk_count INTEGER NOT NULL DEFAULT 0,
          embedding_model TEXT NOT NULL,
          error TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS animal_knowledge_chunks (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES animal_documents(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          heading TEXT NOT NULL DEFAULT '',
          page_number INTEGER,
          chunk_index INTEGER NOT NULL,
          token_count INTEGER NOT NULL DEFAULT 0,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          embedding VECTOR(1536) NOT NULL
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS animal_knowledge_chunks_document_idx
        ON animal_knowledge_chunks(document_id, chunk_index)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS animal_knowledge_chunks_embedding_hnsw
        ON animal_knowledge_chunks
        USING hnsw (embedding vector_cosine_ops)
      `;
    })();
    return this.ready;
  }

  async listDocuments() {
    await this.ensureSchema();
    const sql = await this.getSql();
    const result = await sql`SELECT * FROM animal_documents ORDER BY created_at DESC`;
    return result.rows.map(toDocument);
  }

  async createDocument(input) {
    await this.ensureSchema();
    const sql = await this.getSql();
    const id = createId();
    const result = await sql`
      INSERT INTO animal_documents (
        id, filename, content_type, size, url, pathname, embedding_model
      )
      VALUES (
        ${id}, ${input.filename}, ${input.contentType}, ${input.size || 0},
        ${input.url}, ${input.pathname || ""}, ${input.embeddingModel}
      )
      RETURNING *
    `;
    return toDocument(result.rows[0]);
  }

  async completeDocument(id, chunks) {
    await this.ensureSchema();
    const sql = await this.getSql();
    // 块替换和文档 ready 状态在同一事务提交，避免检索到半成品文档。
    await sql.transaction((txn) => [
      txn`DELETE FROM animal_knowledge_chunks WHERE document_id = ${id}`,
      ...chunks.map(
        (chunk) => txn`
          INSERT INTO animal_knowledge_chunks (
            id, document_id, content, heading, page_number, chunk_index,
            token_count, metadata, embedding
          )
          VALUES (
            ${createId()}, ${id}, ${chunk.content}, ${chunk.heading || ""},
            ${chunk.pageNumber}, ${chunk.chunkIndex}, ${chunk.tokenCount || 0},
            ${JSON.stringify(chunk.metadata || {})}::jsonb,
            ${JSON.stringify(chunk.embedding)}::vector
          )
        `
      ),
      txn`
        UPDATE animal_documents
        SET status = 'ready', chunk_count = ${chunks.length}, error = '', updated_at = NOW()
        WHERE id = ${id}
      `
    ]);
    const result = await sql`SELECT * FROM animal_documents WHERE id = ${id}`;
    return toDocument(result.rows[0]);
  }

  async failDocument(id, error) {
    await this.ensureSchema();
    const sql = await this.getSql();
    const result = await sql`
      UPDATE animal_documents
      SET status = 'failed', error = ${String(error || "").slice(0, 500)}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return result.rows[0] ? toDocument(result.rows[0]) : null;
  }

  async deleteDocument(id) {
    await this.ensureSchema();
    const sql = await this.getSql();
    const result = await sql`DELETE FROM animal_documents WHERE id = ${id}`;
    return result.rowCount > 0;
  }

  async search(queryEmbedding, limit = 8, embeddingModel = "") {
    await this.ensureSchema();
    const sql = await this.getSql();
    const vector = JSON.stringify(queryEmbedding);
    // HNSW 索引按 cosine distance 排序，再转换成更直观的相似度分数。
    const result = await sql`
      SELECT
        c.id,
        c.document_id,
        c.content,
        c.heading,
        c.page_number,
        c.chunk_index,
        c.token_count,
        c.metadata,
        1 - (c.embedding <=> ${vector}::vector) AS score,
        d.filename,
        d.url,
        d.content_type
      FROM animal_knowledge_chunks c
      JOIN animal_documents d ON d.id = c.document_id
      WHERE d.status = 'ready'
        AND d.embedding_model = ${embeddingModel}
      ORDER BY c.embedding <=> ${vector}::vector
      LIMIT ${Math.max(1, Math.min(limit, 20))}
    `;
    return result.rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      content: row.content,
      heading: row.heading,
      pageNumber: row.page_number,
      chunkIndex: row.chunk_index,
      tokenCount: row.token_count,
      metadata: row.metadata,
      score: Number(row.score),
      document: {
        id: row.document_id,
        filename: row.filename,
        url: row.url,
        contentType: row.content_type,
        status: "ready"
      }
    }));
  }
}
