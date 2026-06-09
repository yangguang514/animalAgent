import mammoth from "mammoth";

const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/json"
]);

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function parsePdf(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true
  }).promise;

  try {
    const sections = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = normalizeText(
        content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
      );
      if (text) sections.push({ pageNumber, text });
    }
    return sections;
  } finally {
    await pdf.destroy();
  }
}

async function parseDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
  const text = normalizeText(result.value);
  return text ? [{ pageNumber: null, text }] : [];
}

function parseText(buffer) {
  const text = normalizeText(new TextDecoder("utf-8").decode(buffer));
  return text ? [{ pageNumber: null, text }] : [];
}

export function isSupportedDocument(filename = "", contentType = "") {
  const lowerName = filename.toLowerCase();
  return (
    contentType === "application/pdf" ||
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    TEXT_TYPES.has(contentType) ||
    /\.(pdf|docx|txt|md|markdown)$/i.test(lowerName)
  );
}

export async function parseDocument(buffer, { filename = "", contentType = "" } = {}) {
  const lowerName = filename.toLowerCase();
  if (contentType === "application/pdf" || lowerName.endsWith(".pdf")) {
    return parsePdf(buffer);
  }
  if (
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".docx")
  ) {
    return parseDocx(buffer);
  }
  if (TEXT_TYPES.has(contentType) || /\.(txt|md|markdown)$/i.test(lowerName)) {
    return parseText(buffer);
  }
  throw new Error("仅支持 PDF、DOCX、TXT 和 Markdown 文件。");
}
