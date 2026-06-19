/**
 * Typed errors for the Obsidian / ingestion pipeline.
 *
 * Kept as a separate module so both the parser and UI code can instanceof-check
 * without pulling in the full orchestrator.
 */

/**
 * Thrown when the caller routes content to the prose-extraction path but has
 * not configured an LLM client. Prose extraction is LLM-only — there is no
 * deterministic fallback — so the UI should gate the ingest feature behind a
 * settings prompt when this fires.
 *
 * See docs/prose-ingestion.md §6.
 */
export class ProseIngestionNoLlmError extends Error {
  constructor(message = 'Prose ingestion requires an LLM client; configure one in Settings.') {
    super(message);
    this.name = 'ProseIngestionNoLlmError';
  }
}

/**
 * Thrown by `parseProse` and `spreadsheetToMarkdown` when the stub body has
 * not been filled in yet. Surfaced verbatim to the UI so the next Claude Code
 * session sees a loud pointer to the doc.
 *
 * Replace this with real behavior when implementing M-P1 / M-P4.
 */
export class ProseIngestionNotImplementedError extends Error {
  constructor(fn) {
    super(
      `${fn}() is scaffolded but not implemented. ` +
      `See docs/prose-ingestion.md for the contract and the next milestone to land.`
    );
    this.name = 'ProseIngestionNotImplementedError';
  }
}
