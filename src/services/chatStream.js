function dispatchEventBlock(block, onEvent) {
  const lines = block.split(/\r?\n/);
  const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
  const rawData = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (rawData) onEvent(event, JSON.parse(rawData));
}

export async function streamChat(conversationId, content, onEvent) {
  const response = await fetch(`/api/conversations/${conversationId}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "无法建立流式连接");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    blocks.filter(Boolean).forEach((block) => dispatchEventBlock(block, onEvent));
    if (done) break;
  }

  if (buffer.trim()) dispatchEventBlock(buffer, onEvent);
}
