import path from "node:path";

const LINK_RE = /\[\[([^\]|#^\n]+?)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export function parseLinks(markdownBody) {
  if (!markdownBody) return [];
  const stripped = markdownBody
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]+`/g, " ");
  const seen = new Set();
  const results = [];
  for (const match of stripped.matchAll(LINK_RE)) {
    const raw = match[1].trim();
    if (!raw) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    results.push(raw);
  }
  return results;
}

function stripExt(p) {
  return p.replace(/\.md$/i, "");
}

export function buildResolver(allPaths) {
  const byFull = new Map();
  const byBasename = new Map();
  for (const p of allPaths) {
    byFull.set(stripExt(p).toLowerCase(), p);
    const base = stripExt(path.posix.basename(p)).toLowerCase();
    const list = byBasename.get(base) ?? [];
    list.push(p);
    byBasename.set(base, list);
  }
  return function resolve(raw) {
    const norm = raw.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    const lower = stripExt(norm).toLowerCase();
    const full = byFull.get(lower);
    if (full) return full;
    const base = stripExt(path.posix.basename(norm)).toLowerCase();
    const candidates = byBasename.get(base);
    if (candidates?.length === 1) return candidates[0];
    if (candidates?.length > 1) return candidates[0];
    return null;
  };
}
