import { del, get, issueSignedToken } from "@vercel/blob";
import { handleUpload, handleUploadPresigned } from "@vercel/blob/client";
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
  // 文件名会进入 Blob 路径、数据库和提示词，因此只保留可读且安全的字符。
  return String(value || "document")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function resolveBlobCredentials(req) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return { mode: "blob-token", options: {} };
  }
  const oidcToken =
    req?.headers?.["x-vercel-oidc-token"] ||
    process.env.VERCEL_OIDC_TOKEN;
  if (oidcToken && process.env.BLOB_STORE_ID) {
    return {
      mode: "blob-presigned",
      options: { oidcToken, storeId: process.env.BLOB_STORE_ID }
    };
  }
  return { mode: process.env.VERCEL ? "disabled" : "direct", options: {} };
}

export async function createUploadToken(req, body) {
  const config = getKnowledgeConfig();
  const credentials = resolveBlobCredentials(req);
  if (credentials.mode === "blob-presigned") {
    // OIDC 不能签发传统 client token，必须改用短期 signed token 和 presigned URL。
    return handleUploadPresigned({
      request: req,
      body,
      webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY,
      getSignedToken: async (pathname) => {
        const filename = safeFilename(pathname.split("/").pop());
        if (!isSupportedDocument(filename, "")) throw new Error("不支持该文件类型。");
        const validUntil = Date.now() + 15 * 60 * 1000;
        const token = await issueSignedToken({
          ...credentials.options,
          pathname,
          operations: ["put"],
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: config.maxFileBytes,
          validUntil
        });
        return {
          token,
          urlOptions: {
            allowedContentTypes: ALLOWED_CONTENT_TYPES,
            maximumSizeInBytes: config.maxFileBytes,
            addRandomSuffix: false,
            validUntil
          }
        };
      }
    });
  }
  if (credentials.mode !== "blob-token") {
    throw new Error("缺少可用的 Vercel Blob 凭证。");
  }

  // 旧版 read-write token 继续使用传统 client upload 协议。
  return handleUpload({
    request: req,
    body,
    onBeforeGenerateToken: async (pathname) => {
      // 上传前在服务端约束类型和大小，避免客户端绕过 accept 属性。
      const filename = safeFilename(pathname.split("/").pop());
      if (!isSupportedDocument(filename, "")) throw new Error("不支持该文件类型。");
      return {
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: config.maxFileBytes,
        addRandomSuffix: false,
        tokenPayload: JSON.stringify({ filename })
      };
    },
    onUploadCompleted: async () => {}
  });
}

export async function listDocuments() {
  const documents = await knowledgeRepository.listDocuments();
  return documents.map((document) => ({
    id: document.id,
    filename: document.filename,
    contentType: document.contentType,
    size: document.size,
    status: document.status,
    chunkCount: document.chunkCount,
    embeddingModel: document.embeddingModel,
    error: document.error,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  }));
}

async function processDocumentBuffer(input, buffer) {
  const config = getKnowledgeConfig();
  const filename = safeFilename(input.filename || input.pathname?.split("/").pop());
  const contentType = String(input.contentType || "");
  const size = Number(input.size || 0);
  if (!isSupportedDocument(filename, contentType)) throw new Error("不支持该文件类型。");
  if (size > config.maxFileBytes) throw new Error(`文件不能超过 ${config.maxFileMb} MB。`);

  // 先保存 processing 状态，后续任何解析或向量化异常都能在界面中被追踪。
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

    // 文件名和章节标题共同参与向量化，可提高短问题对正确章节的召回率。
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

export async function processUploadedDocument(input, req) {
  // 生产环境只接受本项目 Blob 域名和知识库前缀，避免读取 Store 中的其他对象。
  if (!/^https:\/\/.+\.blob\.vercel-storage\.com\//i.test(String(input.url || ""))) {
    throw new Error("文件地址不是有效的 Vercel Blob URL。");
  }
  const pathname = String(input.pathname || "");
  if (!pathname.startsWith("knowledge/")) {
    throw new Error("文件路径不属于知识库目录。");
  }
  const result = await get(pathname, {
    access: "private",
    useCache: false,
    ...resolveBlobCredentials(req).options
  });
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error("读取上传文件失败：Blob 内容不可用。");
  }
  const buffer = await new Response(result.stream).arrayBuffer();
  return processDocumentBuffer(
    {
      ...input,
      pathname: result.blob.pathname,
      url: result.blob.url,
      size: result.blob.size,
      contentType: result.blob.contentType || input.contentType
    },
    buffer
  );
}

export async function processDirectDocument(input, buffer) {
  // 直传仅服务本地开发；Vercel 必须绕过函数请求体限制，改走 Blob 客户端直传。
  if (process.env.VERCEL) {
    throw new Error("Vercel 部署必须使用 Blob 客户端直传。");
  }
  return processDocumentBuffer({ ...input, url: "", pathname: "" }, buffer);
}

export function getBlobUploadMode(req) {
  return resolveBlobCredentials(req).mode;
}

export async function deleteDocument(id, req) {
  const documents = await knowledgeRepository.listDocuments();
  const document = documents.find((item) => item.id === id);
  const deleted = await knowledgeRepository.deleteDocument(id);
  const credentials = resolveBlobCredentials(req);
  if (deleted && document?.url && credentials.mode.startsWith("blob-")) {
    await del(document.url, {
      ...credentials.options
    }).catch(() => {});
  }
  return deleted;
}

export async function retrieveKnowledge(query) {
  const config = getKnowledgeConfig();
  const text = String(query || "").trim();
  if (!text || config.retrievalDisabled) return [];

  // 查询与文档块必须使用同一模型和维度，否则相似度没有可比性。
  const embeddingConfig = getEmbeddingConfig();
  const embedding = await embedQuery(text);
  const matches = await knowledgeRepository.search(
    embedding,
    config.retrievalLimit,
    embeddingConfig.model
  );
  return matches
    .filter((match) => match.score >= config.minimumScore)
    .map((match) => ({
      type: "knowledge",
      title: match.document.filename,
      // Blob 为私有资源，引用仅展示文件名和页码，不向浏览器暴露不可访问的 URL。
      url: "",
      snippet: match.content,
      pageNumber: match.pageNumber,
      heading: match.heading,
      score: match.score,
      documentId: match.documentId
    }));
}
