import process from "node:process";

import { loadConfig } from "../src/config.js";
import { VaultIndex } from "../src/vault-index.js";

const config = loadConfig();
const index = new VaultIndex(config);
const ingest = index.ingest();

const rows = index.db.prepare("SELECT path FROM notes ORDER BY path").all();

let failures = 0;
const errors = [];

for (const { path: p } of rows) {
  try {
    const note = index.readNote(p);
    if (!note.rawContent) throw new Error("empty content");
  } catch (err) {
    failures += 1;
    errors.push({ path: p, message: err?.message ?? String(err) });
  }
}

index.close();

console.log(JSON.stringify({
  vaultRoot: config.vaultRoot,
  indexed: ingest.indexedNotes,
  attempted: rows.length,
  failures,
  errors,
}, null, 2));

process.exit(failures === 0 ? 0 : 1);
