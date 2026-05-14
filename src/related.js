const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_SCORE = 0;
const CANDIDATE_MULTIPLIER = 3;

export async function relatedNotes({
  vaultIndex,
  path,
  limit = DEFAULT_LIMIT,
  minScore = DEFAULT_MIN_SCORE,
} = {}) {
  if (!vaultIndex) throw new Error("vaultIndex is required");
  if (!path) throw new Error("path is required");

  const candidates = vaultIndex
    .findRelatedByPath(path, { limit: limit * CANDIDATE_MULTIPLIER, excludePaths: [] })
    .filter((c) => c.score >= minScore)
    .slice(0, limit);

  return candidates.map((c) => ({
    path: c.path,
    title: c.title,
    excerpt: c.excerpt,
    score: c.score,
  }));
}
