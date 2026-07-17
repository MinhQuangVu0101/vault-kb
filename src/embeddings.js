import crypto from "node:crypto";

const DEFAULT_URL = "http://localhost:11434";
const DEFAULT_MODEL = "nomic-embed-text";
const MAX_CHARS = 4000;

export function createEmbedder({
  url = process.env.VAULT_KB_OLLAMA_URL || DEFAULT_URL,
  model = process.env.VAULT_KB_EMBED_MODEL || DEFAULT_MODEL,
  llmModel = process.env.VAULT_KB_LLM_MODEL || null,
  logger = null,
  fetchFn = globalThis.fetch,
  timeoutMs = 2000,
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
    const json = /** @type {{ embedding?: number[] }} */ (await res.json());
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

  async function summarize(prompt) {
    if (!llmModel) return null;
    try {
      const res = await fetchFn(`${url}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: llmModel, prompt, stream: false }),
      });
      if (!res.ok) {
        lastError = { message: `ollama generate ${res.status}`, ts: new Date().toISOString() };
        logger?.warn({ event: "summarize_failed", status: res.status });
        return null;
      }
      const json = /** @type {{ response?: string }} */ (await res.json());
      const text = typeof json.response === "string" ? json.response.trim() : null;
      return text || null;
    } catch (err) {
      lastError = { message: String(err?.message ?? err), ts: new Date().toISOString() };
      logger?.warn({ event: "summarize_error", error: lastError.message });
      return null;
    }
  }

  function status() {
    return { url, model, llmModel, reachable, lastError };
  }

  async function healthCheck() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchFn(`${url}/api/tags`, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        reachable = false;
        lastError = {
          message: `HTTP ${res.status}`,
          code: "UNREACHABLE",
          ts: new Date().toISOString(),
        };
        return { ok: false, requestedModel: model, ...lastError };
      }
      const json = await res.json();
      const names = (json.models ?? []).map((m) => m.name);
      const found = model.includes(":")
        ? names.find((n) => n === model)
        : names.find((n) => n === model || n.startsWith(`${model}:`));
      if (!found) {
        reachable = true;
        lastError = {
          message: `model '${model}' not installed`,
          code: "MODEL_MISSING",
          ts: new Date().toISOString(),
          availableModels: names,
        };
        return { ok: false, requestedModel: model, ...lastError };
      }
      reachable = true;
      lastError = null;
      return { ok: true, requestedModel: model, resolvedModel: found };
    } catch (err) {
      reachable = false;
      lastError = {
        message: String(err?.message ?? err),
        code: "UNREACHABLE",
        ts: new Date().toISOString(),
      };
      return { ok: false, requestedModel: model, ...lastError };
    }
  }

  return { embedNote, embedQuery, contentHash, status, summarize, healthCheck };
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
