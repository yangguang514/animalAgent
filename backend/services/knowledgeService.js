import { del } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";
import { getEmbeddingConfig, getKnowledgeConfig } from "../config/env.js";
import { knowledgeRepository } from "../repositories/knowledgeRepository.js";
import { chunkDocument } from "./documentChunker.js";
import { isSupportedDocument, parseDocument } from "./documentParser.js";
import { embedQuery, embedTexts } from "./embeddingService.js";

const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/x-markdown"
];

function safeFilename(value) {
  return String(value || "document")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export async function createUploadToken(req, body) {
  const config = getKnowledgeConfig();
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("缺少 BLOB_READ_WRITE_TOKEN，无法上传知识文件。");
  }
  return handleUpload({
    request: req,
    body,
    onBeforeGenerateToken: async (pathname) => {
      const filename = safeFilename(pathname.split("/").pop());
      if (!isSupportedDocument(filename, "")) throw new Error("不支持该文件类型。");
      return {
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: config.maxFileBytes,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ filename })
      };
    },
    onUploadCompleted: async () => {}
  });
}

export async function listDocuments() {
  return knowledgeRepository.listDocuments();
}

async function processDocumentBuffer(input, buffer) {
  const config = getKnowledgeConfig();
  const filename = safeFilename(input.filename || input.pathname?.split("/").pop());
  const contentType = String(input.contentType || "");
  const size = Number(input.size || 0);
  if (!isSupportedDocument(filename, contentType)) throw new Error("不支持该文件类型。");
  if (size > config.maxFileBytes) throw new Error(`文件不能超过 ${config.maxFileMb} MB。`);

  const document = await knowledgeRepository.createDocument({
    filename,
    contentType,
    size,
    url: input.url,
    pathname: input.pathname || "",
    embeddingModel: getEmbeddingConfig().model
  });

  try {
    const sections = await parseDocument(buffer, { filename, contentType });
    const chunks = chunkDocument(sections, {
      maxChars: config.chunkMaxChars,
      overlapChars: config.chunkOverlapChars
    });
    if (!chunks.length) throw new Error("文件中没有可提取的文本，扫描版 PDF 暂不支持。");

    const embeddingInputs = chunks.map((chunk) =>
      [filename, chunk.heading, chunk.content].filter(Boolean).join("\n")
    );
    const embeddings = await embedTexts(embeddingInputs);
    return await knowledgeRepository.completeDocument(
      document.id,
      chunks.map((chunk, index) => ({
        ...chunk,
        embedding: embeddings[index],
        metadata: { filename }
      }))
    );
  } catch (error) {
    await knowledgeRepository.failDocument(
      document.id,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}

export async function processUploadedDocument(input) {
  if (!/^https:\/\/.+\.blob\.vercel-storage\.com\//i.test(String(input.url || ""))) {
    throw new Error("文件地址不是有效的 Vercel Blob URL。");
  }
  const response = await fetch(input.url);
  if (!response.ok) throw new Error(`读取上传文件失败：HTTP ${response.status}`);
  return processDocumentBuffer(input, await response.arrayBuffer());
}

export async function processDirectDocument(input, buffer) {
  if (process.env.VERCEL) {
    throw new Error("Vercel 部署必须使用 Blob 客户端直传。");
  }
  return processDocumentBuffer({ ...input, url: "", pathname: "" }, buffer);
}

export async function deleteDocument(id) {
  const documents = await knowledgeRepository.listDocuments();
  const document = documents.find((item) => item.id === id);
  const deleted = await knowledgeRepository.deleteDocument(id);
  if (deleted && document?.url && process.env.BLOB_READ_WRITE_TOKEN) {
    await del(document.url).catch(() => {});
  }
  return deleted;
}

export async function retrieveKnowledge(query) {
  const config = getKnowledgeConfig();
  const text = String(query || "").trim();
  if (!text || config.retrievalDisabled) return [];
  const documents = await knowledgeRepository.listDocuments();
  if (!documents.some((document) => document.status === "ready")) return [];

  const embedding = await embedQuery(text);
  const matches = await knowledgeRepository.search(embedding, config.retrievalLimit);
  return matches
    .filter((match) => match.score >= config.minimumScore)
    .map((match) => ({
      type: "knowledge",
      title: match.document.filename,
      url: match.document.url,
      snippet: match.content,
      pageNumber: match.pageNumber,
      heading: match.heading,
      score: match.score,
      documentId: match.documentId
    }));
}
