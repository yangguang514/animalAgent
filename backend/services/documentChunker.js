const DEFAULT_MAX_CHARS = 2200;
const DEFAULT_OVERLAP_CHARS = 280;

function normalizeParagraph(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function looksLikeHeading(paragraph) {
  const text = normalizeParagraph(paragraph);
  return (
    text.length > 0 &&
    text.length <= 80 &&
    (/^#{1,6}\s/.test(text) ||
      /^[一二三四五六七八九十\d]+[、.．]\s*\S/.test(text) ||
      /^(chapter|section)\s+\d+/i.test(text))
  );
}

function splitLongParagraph(paragraph, maxChars) {
  if (paragraph.length <= maxChars) return [paragraph];
  const parts = [];
  let cursor = 0;
  while (cursor < paragraph.length) {
    let end = Math.min(cursor + maxChars, paragraph.length);
    if (end < paragraph.length) {
      // 优先在句末截断，减少一个语义单元被机械切成两半的情况。
      const boundary = Math.max(
        paragraph.lastIndexOf("。", end),
        paragraph.lastIndexOf("！", end),
        paragraph.lastIndexOf("？", end),
        paragraph.lastIndexOf(". ", end)
      );
      if (boundary > cursor + Math.floor(maxChars * 0.55)) end = boundary + 1;
    }
    parts.push(paragraph.slice(cursor, end).trim());
    cursor = end;
  }
  return parts.filter(Boolean);
}

function trailingOverlap(text, overlapChars) {
  if (text.length <= overlapChars) return text;
  const tail = text.slice(-overlapChars);
  const boundary = tail.search(/[。！？.!?]\s*/);
  return boundary >= 0 ? tail.slice(boundary + 1).trim() : tail.trim();
}

export function chunkDocument(sections = [], options = {}) {
  const maxChars = Math.max(600, Number(options.maxChars || DEFAULT_MAX_CHARS));
  const overlapChars = Math.max(0, Math.min(Number(options.overlapChars || DEFAULT_OVERLAP_CHARS), maxChars / 3));
  const chunks = [];
  let currentHeading = "";

  for (const section of sections) {
    const paragraphs = String(section.text || "")
      .split(/\n{2,}/)
      .map(normalizeParagraph)
      .filter(Boolean)
      .flatMap((paragraph) => splitLongParagraph(paragraph, maxChars));
    let buffer = "";

    const flush = () => {
      const content = buffer.trim();
      if (!content) return;
      chunks.push({
        content,
        heading: currentHeading,
        pageNumber: section.pageNumber ?? null,
        chunkIndex: chunks.length,
        tokenCount: Math.ceil(content.length / 2.5)
      });
      // 将上一块末尾带入下一块，保留跨块指代和上下句关系。
      buffer = trailingOverlap(content, overlapChars);
    };

    for (const paragraph of paragraphs) {
      if (looksLikeHeading(paragraph)) currentHeading = paragraph.replace(/^#{1,6}\s*/, "");
      const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (candidate.length > maxChars && buffer) flush();
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    }
    flush();
  }

  return chunks;
}
