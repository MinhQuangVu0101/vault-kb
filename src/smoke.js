import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEntry = fileURLToPath(new URL("./index.js", import.meta.url));

function extractText(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

const client = new Client({
  name: "vault-mcp-smoke-test",
  version: "0.1.0",
}, {
  capabilities: {},
});

const transport = new StdioClientTransport({
  command: "node",
  args: [serverEntry],
  env: process.env,
  stderr: "pipe",
});

if (transport.stderr) {
  transport.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
}

await client.connect(transport);

const tools = await client.listTools();
const searchResult = await client.callTool({
  name: "kb_search",
  arguments: {
    query: "study queue lecture",
    limit: 2,
  },
});
const listResult = await client.callTool({
  name: "kb_list",
  arguments: {
    folder: "20 Notes/Study",
    limit: 3,
  },
});
const readResult = await client.callTool({
  name: "kb_read",
  arguments: {
    path: "95 AI/context.md",
    maxChars: 1200,
  },
});
const ingestResult = await client.callTool({
  name: "kb_ingest",
  arguments: {},
});

console.log(JSON.stringify({
  toolCount: tools.tools.length,
  toolNames: tools.tools.map((tool) => tool.name),
  searchPreview: extractText(searchResult),
  listPreview: extractText(listResult),
  readPreview: extractText(readResult),
  ingestPreview: extractText(ingestResult),
}, null, 2));

await client.close();
