import DOMPurify from "dompurify";
import { marked } from "marked";

marked.use({
  breaks: true,
  gfm: true
});

// CommonMark 对强调符号有边界限制：
// `进行**“训练”**` 中，`**` 前后同时紧邻中文和开引号时可能被当成普通文本。
// 这里只修复模型常见的“中文开引号起始的粗体”，并跳过代码块与行内代码。
export function normalizeCjkEmphasis(content) {
  return String(content || "")
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment.replace(
        /\*\*([“‘「『《〈（【][^*\n]*?\S)\*\*/g,
        "<strong>$1</strong>"
      );
    })
    .join("");
}

export function renderMarkdown(content) {
  const normalized = normalizeCjkEmphasis(content);
  return DOMPurify.sanitize(marked.parse(normalized));
}
