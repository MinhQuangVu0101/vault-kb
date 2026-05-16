---
ai-access: true
status: active
tags: [embeddings, ollama, reference]
---
# Embedding Models

Local embedding models via Ollama:

| Model | Dim | Notes |
|---|---|---|
| nomic-embed-text | 768 | Default for vault-kb |
| all-minilm | 384 | Smaller, faster |
| mxbai-embed-large | 1024 | Higher quality, slower |

See [[MCP Architecture]] for how embeddings plug into the index.
