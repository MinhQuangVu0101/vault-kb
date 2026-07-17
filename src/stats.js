const MAX_ERRORS = 20;

export function createStats() {
  const state = {
    lastIngest: null,
    indexed: 0,
    scannedMarkdownFiles: 0,
    skipped: {
      missingAccess: 0,
      explicitFalse: 0,
      hardExcluded: 0,
      parseError: 0,
    },
    recentErrors: [],
    toolCalls: { total: 0, byTool: {}, errors: 0 },
  };

  function recordIngest(report) {
    state.lastIngest = report.indexedAt ?? new Date().toISOString();
    state.indexed = report.indexedNotes ?? 0;
    state.scannedMarkdownFiles = report.scannedMarkdownFiles ?? 0;
    state.skipped = {
      missingAccess: report.skipped?.missingAccess ?? 0,
      explicitFalse: report.skipped?.explicitFalse ?? 0,
      hardExcluded: report.skipped?.hardExcluded ?? 0,
      parseError: report.skipped?.parseError ?? 0,
    };
  }

  /** @param {{ tool?: string, path?: string, message?: any, code?: string }} entry */
  function pushError({ tool, path: p, message, code }) {
    state.recentErrors.unshift({
      ts: new Date().toISOString(),
      tool: tool ?? null,
      path: p ?? null,
      code: code ?? null,
      message: String(message ?? ""),
    });
    if (state.recentErrors.length > MAX_ERRORS) {
      state.recentErrors.length = MAX_ERRORS;
    }
    state.toolCalls.errors += 1;
  }

  function recordToolCall(tool) {
    state.toolCalls.total += 1;
    state.toolCalls.byTool[tool] = (state.toolCalls.byTool[tool] ?? 0) + 1;
  }

  function snapshot() {
    return {
      lastIngest: state.lastIngest,
      indexed: state.indexed,
      scannedMarkdownFiles: state.scannedMarkdownFiles,
      skipped: { ...state.skipped },
      recentErrors: state.recentErrors.slice(),
      toolCalls: {
        total: state.toolCalls.total,
        errors: state.toolCalls.errors,
        byTool: { ...state.toolCalls.byTool },
      },
    };
  }

  return { recordIngest, pushError, recordToolCall, snapshot };
}
