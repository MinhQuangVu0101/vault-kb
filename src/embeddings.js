import crypto from "node:crypto";

const DEFAULT_URL = "http://localhost:11434";
const DEFAULT_MODEL = "nomic-embed-text";
const MAX_CHARS = 4000;

export function createEmbedder({
  url = process.env.VAULT_KB_OLLAMA_URL || DEFAULT_URL,
  model = process.env.VAULT_KB_EMBED_MODEL || DEFAULT_MODEL,
  logger = null,
  fetchFn = globalThis.fetch,
} = {}) {
  let lastError = null;
  let reachable = null;

  function buildInput(title, body) {
    const base = `${title ?? ""}\n\n${body ?? ""}`.trim();
    return base.length > MAX_CHARS ? base.slice(0, MAX_CHARS) : base;
  }

  function contentHash(title, body) {
    return crypto
      .createHash("sha256")
      .update(buildInput(title, body))
      .digest("hex");
  }

  async function embed(text) {
    const res = await fetchFn(`${url}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!res.ok) {
      throw new Error(`ollama ${res.status}: ${await res.text()}`);
    }
    const json = await res.json();
    if (!Array.isArray(json.embedding)) {
      throw new Error("ollama response missing embedding array");
    }
    return Float32Array.from(json.embedding);
  }

  async function embedNote({ title, body }) {
    const hash = contentHash(title, body);
    let text = buildInput(title, body);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const vector = await embed(text);
        reachable = true;
        lastError = null;
        return { vector, model, contentHash: hash };
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (/context length/i.test(msg) && text.length > 500) {
          text = text.slice(0, Math.floor(text.length / 2));
          continue;
        }
        reachable = false;
        lastError = { message: msg, ts: new Date().toISOString() };
        logger?.warn({ event: "embed_failed", error: msg });
        return null;
      }
    }
    return null;
  }

  async function embedQuery(text) {
    return embed(text);
  }

  function status() {
    return { url, model, reachable, lastError };
  }

  async function healthCheck() {
    const res = await fetchFn(`${url}/api/tags`);
    const json = await res.json();
    const names = (json.models ?? []).map((m) => m.name);
    const baseModel = model.split(":")[0];
    const found = names.find((n) => n === model || n.startsWith(`${baseModel}:`));
    reachable = true;
    lastError = null;
    return { ok: true, requestedModel: model, resolvedModel: found };
  }

  return { embedNote, embedQuery, contentHash, status, healthCheck };
}

export function floatsToBlob(floats) {
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function blobToFloats(buf) {
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(bytes);
}

export function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
