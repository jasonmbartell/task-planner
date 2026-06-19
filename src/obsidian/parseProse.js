/**
 * Prose Extraction (M-P1)
 *
 * Turn free-form text (prose, transcripts, markdown-from-xlsx tables) into
 * the same `{ projectName, projectDescription, sprints, tasks }` shape that
 * parseMarkdownFile returns, so downstream orchestrator stages (flatten →
 * defaults → date-infer → dep-ref resolution) run unchanged.
 *
 * Shape of a candidate task (ProseCandidateTask):
 *   - All normal task fields (id, title, description, dueDate, urgency, ...)
 *   - _sourcePointer: { source, lineStart, lineEnd, rawText }  // provenance
 *   - _confidence: 0..1                                         // LLM self-rating
 *   - _dependencyRefs: string[]                                 // titles to resolve
 *   - _ambiguousFields: {}                                      // always empty on this path
 *
 * v1 design choice: _sourcePointer is *chunk-scoped*, not snippet-scoped.
 * Every task extracted from a single chunk shares that chunk's lineStart /
 * lineEnd / rawText. Snippet-level precision would require asking the LLM
 * for verbatim quotes (or accurate line counts, which models are bad at)
 * and is left as a future upgrade.
 */

import { genId } from '../utils/ids.js';
import { ProseIngestionNoLlmError } from './errors.js';
import { PROSE_SYSTEM_PROMPT, buildProseUserPrompt } from './proseExtractionPrompt.js';

/** @typedef {import('./llmClient.js').LLMClient} LLMClient */

const RAW_TEXT_MAX_CHARS = 512;

/**
 * @typedef {Object} ParseProseOptions
 * @property {LLMClient} llmClient - Required. Prose ingestion is LLM-only.
 * @property {string} [fileName] - Default project-name fallback.
 * @property {string} [sourceLabel] - Provenance tag attached to every
 *   candidate's _sourcePointer. Examples: "deployment-plan.xlsx",
 *   "cowork-transcript-2026-04-21", "pasted-text".
 * @property {AbortSignal} [signal] - Cancellation for long inputs.
 * @property {number} [chunkTokenBudget=6000] - Approximate target chunk size.
 * @property {number} [chunkOverlapTokens=500] - Overlap between adjacent chunks.
 */

/**
 * @typedef {Object} ParseProseResult
 * @property {string} projectName
 * @property {string} projectDescription
 * @property {Array<object>} sprints
 * @property {Array<object>} tasks
 * @property {object} _extraction - { model, tokensUsed, wallMs, chunkCount }
 */

/**
 * @param {string} content
 * @param {ParseProseOptions} options
 * @returns {Promise<ParseProseResult>}
 */
export async function parseProse(content, options = {}) {
  if (!options?.llmClient) {
    throw new ProseIngestionNoLlmError();
  }
  const {
    llmClient,
    fileName,
    sourceLabel,
    signal,
    chunkTokenBudget,
    chunkOverlapTokens,
  } = options;

  const startMs = Date.now();
  const safeContent = typeof content === 'string' ? content : '';
  const chunks = chunkForExtraction(safeContent, { chunkTokenBudget, chunkOverlapTokens });

  let projectName = null;
  let projectDescription = null;
  const allCandidates = [];
  let approxTokens = 0;

  for (const chunk of chunks) {
    if (signal?.aborted) {
      throw signalAbortError();
    }

    const userPrompt = buildProseUserPrompt(chunk.text, { sourceLabel });
    // 8192 gives ample headroom for a full task list. The default 1024
    // truncates real-world extractions mid-JSON, which breaks parsing.
    const responseText = await llmClient.chat(PROSE_SYSTEM_PROMPT, userPrompt, { maxTokens: 8192 });
    approxTokens += Math.ceil((userPrompt.length + (responseText || '').length) / 4);

    const parsed = parseExtractionResponse(responseText);
    if (!parsed) {
      console.warn('[parseProse] extraction response did not parse as JSON; raw response:', responseText);
      // Malformed JSON from this chunk — skip. The user reviews the rest in
      // the modal and can re-run if needed. Don't fail the whole extraction.
      continue;
    }

    if (!projectName && typeof parsed.projectName === 'string' && parsed.projectName.trim()) {
      projectName = parsed.projectName.trim();
    }
    if (!projectDescription && typeof parsed.projectDescription === 'string' && parsed.projectDescription.trim()) {
      projectDescription = parsed.projectDescription.trim();
    }

    const chunkRawText = truncateForSource(chunk.text);
    const sourceTag = sourceLabel || '';

    for (const rawTask of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
      const normalized = normalizeCandidate(rawTask, {
        source: sourceTag,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        rawText: chunkRawText,
      });
      if (normalized) allCandidates.push(normalized);
    }
  }

  const tasks = dedupCandidates(allCandidates);

  return {
    projectName: projectName || fileName || 'Untitled',
    projectDescription: projectDescription || '',
    sprints: [],
    tasks,
    _extraction: {
      model: llmClient.model || null,
      tokensUsed: approxTokens,
      wallMs: Date.now() - startMs,
      chunkCount: chunks.length,
    },
  };
}

/**
 * Chunk raw content into overlapping windows sized roughly to
 * `chunkTokenBudget` with `chunkOverlapTokens` of overlap. Pure helper
 * (exported so tests can verify boundaries without mocking the LLM).
 *
 * Approximate tokens as chars/4 until we wire a real tokenizer. This is
 * good enough for windowing — the LLM enforces its own hard limit.
 *
 * Sliding window over lines (cheap, predictable). Boundary refinement
 * (prefer blank lines) is a future enhancement; the LLM tolerates a
 * mid-paragraph cut just fine for v1.
 *
 * @param {string} content
 * @param {{ chunkTokenBudget?: number, chunkOverlapTokens?: number }} [opts]
 * @returns {Array<{ text: string, lineStart: number, lineEnd: number }>}
 */
export function chunkForExtraction(content, { chunkTokenBudget = 6000, chunkOverlapTokens = 500 } = {}) {
  if (typeof content !== 'string' || content.length === 0) return [];
  const lineCount = content.split(/\r\n|\r|\n/).length;
  const approxTokens = Math.ceil(content.length / 4);
  if (approxTokens <= chunkTokenBudget) {
    return [{ text: content, lineStart: 1, lineEnd: lineCount }];
  }
  const chunks = [];
  const lines = content.split(/\r\n|\r|\n/);
  const linesPerChunk = Math.max(1, Math.floor((chunkTokenBudget * 4) / 80)); // ~80 char/line avg
  const overlapLines = Math.max(1, Math.floor((chunkOverlapTokens * 4) / 80));
  const step = Math.max(1, linesPerChunk - overlapLines);
  for (let i = 0; i < lines.length; i += step) {
    const start = i;
    const end = Math.min(lines.length, i + linesPerChunk);
    chunks.push({
      text: lines.slice(start, end).join('\n'),
      lineStart: start + 1,
      lineEnd: end,
    });
    if (end === lines.length) break;
  }
  return chunks;
}

/**
 * Dedup candidate tasks across chunks. Keyed on lowercase(title); keeps the
 * entry with the highest _confidence. Pure helper, exported for tests.
 *
 * Dedup is best-effort — any duplicates that survive end up in the review
 * modal and the user clicks Reject. Don't try to merge "similar" tasks
 * automatically; that is silently destructive.
 *
 * @param {Array<object>} candidates
 * @returns {Array<object>}
 */
export function dedupCandidates(candidates) {
  const byTitle = new Map();
  for (const c of candidates) {
    const key = String(c?.title || '').trim().toLowerCase();
    if (!key) continue;
    const prev = byTitle.get(key);
    if (!prev || (c._confidence ?? 0) > (prev._confidence ?? 0)) {
      byTitle.set(key, c);
    }
  }
  return Array.from(byTitle.values());
}

/**
 * Strip code fences and parse the LLM's JSON response. Returns null if the
 * response is not parseable JSON — the caller skips that chunk rather than
 * failing the whole extraction.
 */
function parseExtractionResponse(text) {
  if (typeof text !== 'string') return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/, '');
  }
  // Some models wrap JSON in commentary. Try to extract the outermost {...}.
  if (!cleaned.startsWith('{')) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;
    cleaned = cleaned.slice(first, last + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Normalize one raw LLM task object into the shape the orchestrator's
 * downstream stages expect. Returns null if the candidate is missing a
 * usable title (we never add a task with no title).
 *
 * Mirrors the field defaults parseMarkdownFile uses (empty strings for
 * dates, null for urgency/importance/difficulty so stage 5 can apply
 * defaults uniformly across both paths).
 */
function normalizeCandidate(raw, sourceMeta) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;

  return {
    id: genId('task'),
    title,
    description: typeof raw.description === 'string' ? raw.description : '',
    status: normalizeStatus(raw.status),
    startDate: '',
    endDate: '',
    dueDate: typeof raw.dueDate === 'string' ? raw.dueDate : '',
    urgency: clampInt1to10(raw.urgency),
    importance: clampInt1to10(raw.importance),
    difficulty: clampInt1to10(raw.difficulty),
    dependencies: [],
    parentTaskId: null,
    _ambiguousFields: {},
    _subtasks: [],
    _originalLines: [],
    _isLegacyFormat: false,
    _sprintName: 'Inbox',
    _projectName: null,
    _confidence: clampConfidence(raw._confidence),
    _dependencyRefs: Array.isArray(raw._dependencyRefs)
      ? raw._dependencyRefs.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
      : [],
    _sourcePointer: {
      source: sourceMeta.source,
      lineStart: sourceMeta.lineStart,
      lineEnd: sourceMeta.lineEnd,
      rawText: sourceMeta.rawText,
    },
  };
}

function clampInt1to10(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 1) return 1;
  if (n > 10) return 10;
  return n;
}

function clampConfidence(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0.5;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

const VALID_STATUSES = new Set(['todo', 'in-progress', 'done', 'blocked']);
function normalizeStatus(v) {
  if (typeof v !== 'string') return 'todo';
  const s = v.trim().toLowerCase();
  return VALID_STATUSES.has(s) ? s : 'todo';
}

function truncateForSource(text) {
  if (typeof text !== 'string') return '';
  if (text.length <= RAW_TEXT_MAX_CHARS) return text;
  return text.slice(0, RAW_TEXT_MAX_CHARS - 1) + '…';
}

function signalAbortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('parseProse aborted', 'AbortError');
  }
  const err = new Error('parseProse aborted');
  err.name = 'AbortError';
  return err;
}

export const __TEST_ONLY__ = {
  chunkForExtraction,
  dedupCandidates,
  parseExtractionResponse,
  normalizeCandidate,
  truncateForSource,
};
