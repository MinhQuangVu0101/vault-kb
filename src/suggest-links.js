const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_SCORE = 0.55;
const CANDIDATE_MULTIPLIER = 3;
const EXCERPT_CHARS = 400;

function buildPrompt(source, candidate) {
  return [
    "Two notes from a personal knowledge base.",
    "",
    `Note A — ${source.title}:`,
    source.excerpt,
    "",
    `Note B — ${candidate.title}:`,
    candidate.excerpt,
    "",
    "In one short sentence, why might these notes link to each other? Be specific, no preamble.",
  ].join("\n");
}

function trimExcerpt(text, max = EXCERPT_CHARS) {
  const t = String(text ?? "").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

export async function suggestLinks({
  vaultIndex,
  embedder,
  path,
  limit = DEFAULT_LIMIT,
  minScore = DEFAULT_MIN_SCORE,
} = {}) {
  if (!vaultIndex || !embedder) throw new Error("vaultIndex and embedder are required");
  if (!path) throw new Error("path is required");

  const source = vaultIndex.readNote(path);
  const excludePaths = [
    ...(source.outlinks ?? []).filter((o) => !o.unresolved).map((o) => o.path),
    ...(source.backlinks ?? []).map((b) => b.path),
  ];

  const candidates = vaultIndex
    .findRelatedByPath(path, { limit: limit * CANDIDATE_MULTIPLIER, excludePaths })
    .filter((c) => c.score >= minScore)
    .slice(0, limit);

  const sourceExcerpt = trimExcerpt(source.rawContent ?? source.excerpt);
  const sourceForPrompt = { title: source.title, excerpt: sourceExcerpt };

  const enriched = await Promise.all(candidates.map(async (c) => {
    const candidateExcerpt = trimExcerpt(c.excerpt);
    const reason = await embedder.summarize(buildPrompt(sourceForPrompt, { title: c.title, excerpt: candidateExcerpt }));
    return {
      path: c.path,
      title: c.title,
      excerpt: c.excerpt,
      score: c.score,
      reason: reason || null,
    };
  }));

  return enriched;
}
