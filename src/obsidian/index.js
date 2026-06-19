/**
 * Markdown / prose ingestion — public API.
 *
 * The deterministic markdown parser, the LLM-powered prose extractor, and
 * the spreadsheet→markdown adapter. Bidirectional Obsidian vault sync was
 * removed; the only supported ingestion path is one-way through the Ingest
 * modal (or the `prose.ingest` agent op).
 */

export { parseMarkdownFile } from './parseDeterministic.js';
export { parseMarkdownIntelligent, detectInputShape } from './parseOrchestrator.js';
export { flattenSubtasks } from './subtasks.js';
export { LLMClient } from './llmClient.js';

export { parseProse } from './parseProse.js';
export { spreadsheetToMarkdown } from './spreadsheetToMarkdown.js';
export { ProseIngestionNoLlmError, ProseIngestionNotImplementedError } from './errors.js';
