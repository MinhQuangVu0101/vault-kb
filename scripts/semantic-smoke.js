import { loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embeddings.js";
import { VaultIndex } from "../src/vault-index.js";

const config = loadConfig();
const embedder = createEmbedder();
const index = new VaultIndex(config, { embedder });

index.ingest();
const t0 = Date.now();
const summary = await index.embedAll();
console.log("embedAll:", summary, "in", Date.now() - t0, "ms");

const query = process.argv[2] || "volleyball training jumping higher";
console.log(`\nQuery: ${query}\n`);
const results = await index.semanticSearch({ query, limit: 5 });
for (const r of results) {
  console.log(`${r.score.toFixed(3)}  ${r.path}  — ${r.title}`);
}
index.close();
