import DOMPurify from "dompurify";
import { marked } from "marked";

marked.use({
  breaks: true,
  gfm: true
});

export function renderMarkdown(content) {
  return DOMPurify.sanitize(marked.parse(String(content || "")));
}
