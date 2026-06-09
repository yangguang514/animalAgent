import assert from "node:assert/strict";
import test from "node:test";

process.env.EMBEDDING_PROVIDER = "local";

const { chunkDocument } = await import("./documentChunker.js");
const { parseDocument } = await import("./documentParser.js");
const { embedTexts } = await import("./embeddingService.js");

test("parses text documents and keeps source page metadata while chunking", async () => {
  const sections = await parseDocument(
    new TextEncoder().encode("# Snow leopard\n\nLives in high mountains.\n\n## Habitat\n\nRocky alpine slopes."),
    { filename: "field-notes.md", contentType: "text/markdown" }
  );
  const chunks = chunkDocument(sections, { maxChars: 600, overlapChars: 40 });

  assert.equal(sections.length, 1);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /Snow leopard/);
  assert.equal(chunks[0].pageNumber, null);
});

test("local embedding fallback is deterministic and uses configured dimensions", async () => {
  const [first, second] = await embedTexts(["snow leopard habitat", "snow leopard habitat"]);

  assert.equal(first.length, 1536);
  assert.deepEqual(first, second);
  assert.ok(first.some((value) => value !== 0));
});
