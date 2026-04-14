import process from "node:process";

import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { runBulkUpdate } from "../src/bulk.js";

function parseArgs(argv) {
  const out = {
    match: {},
    ops: {},
    apply: false,
  };
  const split = (s) => s.split(",").map((t) => t.trim()).filter(Boolean);

  for (const arg of argv) {
    if (arg === "--apply") { out.apply = true; continue; }
    if (arg === "--help" || arg === "-h") { out.help = true; continue; }
    const eq = arg.indexOf("=");
    if (!arg.startsWith("--") || eq < 0) continue;
    const key = arg.slice(2, eq);
    const val = arg.slice(eq + 1);
    switch (key) {
      case "folder": out.match.folder = val; break;
      case "tag": out.match.tag = val; break;
      case "path":
      case "paths": out.match.paths = split(val); break;
      case "where": {
        const [k, v] = val.split(":");
        out.match.frontmatter = out.match.frontmatter ?? {};
        out.match.frontmatter[k] = v;
        break;
      }
      case "add-tag":
      case "add-tags": out.ops.addTags = split(val); break;
      case "remove-tag":
      case "remove-tags": out.ops.removeTags = split(val); break;
      case "set": {
        const [k, v] = val.split(":");
        out.ops.setFields = out.ops.setFields ?? {};
        let parsed = v;
        if (v === "true") parsed = true;
        else if (v === "false") parsed = false;
        else if (v === "null") parsed = null;
        else if (!Number.isNaN(Number(v)) && v.trim() !== "") parsed = Number(v);
        out.ops.setFields[k] = parsed;
        break;
      }
      case "unset":
      case "unset-field":
      case "unset-fields": out.ops.unsetFields = split(val); break;
      case "set-access": out.ops.setAccess = val === "true"; break;
      default: break;
    }
  }
  return out;
}

const HELP = `Usage: npm run bulk -- [filters] [ops] [--apply]

Filters (AND):
  --folder=PATH              Match notes in folder (or subfolder)
  --tag=NAME                 Match notes with tag
  --where=FIELD:VALUE        Match notes whose frontmatter FIELD equals VALUE
  --paths=a.md,b.md          Explicit list of vault-relative paths

Operations (any combination):
  --add-tags=x,y             Append tags
  --remove-tags=x,y          Remove tags
  --set=FIELD:VALUE          Set frontmatter FIELD to VALUE (true/false/number auto-cast)
  --unset=f1,f2              Remove frontmatter fields
  --set-access=true|false    Shortcut for --set=ai-access:<bool>

Flags:
  --apply                    Actually write changes. Default is dry-run.
  --help                     Show this help

Examples:
  npm run bulk -- --folder="20 Notes/Study" --add-tags=study
  npm run bulk -- --where=status:draft --set=status:archived --apply
`;

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  console.log(HELP);
  process.exit(0);
}

const config = loadConfig();
const logger = createLogger();
const result = runBulkUpdate({ config, match: parsed.match, ops: parsed.ops, apply: parsed.apply, logger });
console.log(JSON.stringify(result, null, 2));
if (!parsed.apply && result.matched > 0) {
  console.error(`\n[dry-run] ${result.matched} notes would change. Pass --apply to write.`);
}
