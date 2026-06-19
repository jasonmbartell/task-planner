/**
 * Parse Orchestrator
 *
 * Coordinates the parsing pipeline:
 * 0. Detect input shape (structured markdown vs. prose).
 *    Spreadsheets are converted to markdown tables upstream and enter here
 *    as prose with `options.inputShape = 'prose'` (caller-forced).
 * 1. Deterministic parse (markdown path) OR LLM extraction (prose path).
 * 2. LLM interpretation of ambiguous fields (markdown path only; prose
 *    path returns resolved fields and empty _ambiguousFields, so this
 *    stage no-ops for it).
 * 3. Subtask flattening (both paths; no-op if no subtasks).
 * 4. Apply null defaults.
 * 5. Infer start/end dates from difficulty.
 * 6. Resolve dependency references (titles → IDs).
 *
 * See docs/prose-ingestion.md for the prose path's design.
 */

import { parseMarkdownFile } from './parseDeterministic.js';
import { subDays } from 'date-fns';
import { interpretAmbiguousFields } from './parseLLM.js';
import { flattenSubtasks } from './subtasks.js';
import { parseProse } from './parseProse.js';
import { ProseIngestionNoLlmError } from './errors.js';
import { DIFFICULTY_TO_DAYS } from '../utils/dateEnforcement.js';

/**
 * Classify raw input. Called by parseMarkdownIntelligent unless the caller
 * overrides via `options.inputShape`.
 *
 * Returns 'markdown' if ANY recognized structural marker is present,
 * otherwise 'prose'. Spreadsheets are NOT detected here — the caller
 * converts them to markdown tables via spreadsheetToMarkdown() and passes
 * `inputShape: 'prose'` explicitly (the same extractor handles both).
 *
 * @param {string} content
 * @returns {'markdown' | 'prose'}
 */
export function detectInputShape(content) {
  if (typeof content !== 'string' || content.trim().length === 0) return 'markdown'; // empty → let the deterministic parser yield empty result
  const STRUCTURED_MARKERS = [
    /^\s*-\s*\[[ xX]\]/m,        // checkbox subtask
    /^##\s+Task:/m,              // indented metadata block
    /^\|[^|\n]+\|[^|\n]+\|/m,    // pipe-delimited task row
  ];
  return STRUCTURED_MARKERS.some((re) => re.test(content)) ? 'markdown' : 'prose';
}

/**
 * Parse markdown content through the full pipeline.
 *
 * @param {string} content - Markdown file content OR prose OR
 *   markdown-from-spreadsheet (caller forces `inputShape` in the last case).
 * @param {object} options
 * @param {string} [options.fileName] - Filename for project name fallback
 * @param {import('./llmClient.js').LLMClient|null} [options.llmClient] - LLM client (null = skip LLM; required for prose)
 * @param {Array} [options.existingTasks] - Current store tasks (for dependency resolution)
 * @param {'markdown'|'structured'|'prose'|'auto'} [options.inputShape='markdown'] - Routing.
 *   - 'markdown' (default): run the deterministic markdown parser. `'structured'`
 *     is accepted as a synonym for the same path (back-compat for older
 *     callers and the agent op handler).
 *   - 'prose': force the LLM extraction path. Used by the Ingest button when
 *     the user explicitly picks "Prose" (or when a spreadsheet has already
 *     been converted to a markdown table upstream).
 *   - 'auto': run `detectInputShape(content)` to pick. Use when the caller
 *     has a trusted single-file origin (pasted text in the Ingest modal).
 * @param {string} [options.sourceLabel] - Provenance tag threaded into
 *   prose candidates' _sourcePointer. Ignored on the markdown path.
 * @returns {Promise<{ projectName, sprints, tasks }>}
 * @throws {ProseIngestionNoLlmError} If shape resolves to 'prose' and llmClient is missing.
 */
export async function parseMarkdownIntelligent(content, options = {}) {
  const { fileName, llmClient, existingTasks = [], inputShape, sourceLabel } = options;

  // Stage 0: Shape resolution. Default 'markdown' runs the deterministic
  // parser; 'auto' runs real detection; 'prose' forces the LLM path.
  // 'structured' is kept as a back-compat synonym for 'markdown'.
  let shape;
  if (inputShape === 'auto') {
    shape = detectInputShape(content);
  } else if (inputShape === 'prose') {
    shape = 'prose';
  } else if (inputShape === 'markdown' || inputShape === 'structured') {
    shape = 'markdown';
  } else {
    shape = 'markdown';
  }

  // Stage 1: Route to the right parser.
  let parsed;
  if (shape === 'prose') {
    if (!llmClient) throw new ProseIngestionNoLlmError();
    parsed = await parseProse(content, { llmClient, fileName, sourceLabel });
  } else {
    parsed = parseMarkdownFile(content, fileName);
  }

  // Stage 1.5: De-duplicate task ids within this parse. A re-imported
  // markdown file can carry the same `id:task-foo` on multiple lines (copy-
  // paste, template reuse). Without this pass React warns "two children
  // with the same key" in the candidate list and the bulk validator
  // rejects the envelope with `duplicate_id`. We keep the first occurrence
  // and null out the rest so flattenSubtasks issues fresh ids.
  {
    const seen = new Set();
    for (const t of parsed.tasks || []) {
      if (!t.id) continue;
      if (seen.has(t.id)) t.id = null;
      else seen.add(t.id);
    }
  }

  // Stage 2: LLM interpretation (if available and needed)
  const allParsedTasks = parsed.tasks;

  const hasAmbiguous = allParsedTasks.some(
    (t) => t._ambiguousFields && Object.keys(t._ambiguousFields).length > 0
  );

  if (hasAmbiguous && llmClient) {
    try {
      await interpretAmbiguousFields(allParsedTasks, llmClient);
    } catch (err) {
      console.warn('[obsidian/orchestrator] LLM interpretation failed, using defaults:', err.message);
      applyAllDefaults(allParsedTasks);
    }
  } else if (hasAmbiguous) {
    applyAllDefaults(allParsedTasks);
  }

  // Stage 3: Flatten subtasks
  const flatTasks = flattenSubtasks(allParsedTasks);

  // Stage 4: Apply null defaults for any remaining null fields
  for (const task of flatTasks) {
    if (task.urgency == null) task.urgency = 1;
    if (task.importance == null) task.importance = 1;
    if (task.difficulty == null) task.difficulty = 1;
  }

  // Stage 5: Infer start/end dates from difficulty + due date
  inferDatesFromDifficulty(flatTasks);

  // Stage 6: Resolve dependency references (task names -> IDs)
  resolveDependencyRefs(flatTasks, existingTasks);

  return {
    projectName: parsed.projectName,
    projectDescription: parsed.projectDescription || '',
    sprints: parsed.sprints,
    tasks: flatTasks,
    ...(parsed._extraction ? { _extraction: parsed._extraction } : {}),
  };
}

/**
 * Apply default values to all tasks with unresolved ambiguous fields.
 */
function applyAllDefaults(tasks) {
  for (const task of tasks) {
    if (!task._ambiguousFields || Object.keys(task._ambiguousFields).length === 0) continue;

    const notes = Object.entries(task._ambiguousFields)
      .map(([field, value]) => `[${field}: ${value}]`)
      .join(' ');
    if (notes) {
      task.description = task.description
        ? `${task.description}\n${notes}`
        : notes;
    }

    if (task._ambiguousFields.urgency && task.urgency == null) task.urgency = 1;
    if ((task._ambiguousFields.importance || task._ambiguousFields.projectImpact) && task.importance == null) task.importance = 1;
    if (task._ambiguousFields.difficulty && task.difficulty == null) task.difficulty = 1;

    task._ambiguousFields = {};
  }
}


/**
 * Infer start/end dates from difficulty and due date when not explicitly set.
 * endDate = dueDate - 1 day buffer, startDate = endDate - duration from difficulty.
 */
function inferDatesFromDifficulty(tasks) {
  const formatISO = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  for (const task of tasks) {
    if (!task.dueDate) continue;

    const dueDate = new Date(task.dueDate + 'T00:00:00');
    const durationDays = DIFFICULTY_TO_DAYS[task.difficulty] ?? 1;

    if (!task.endDate) {
      const end = durationDays === 0 ? dueDate : subDays(dueDate, 1);
      task.endDate = formatISO(end);
    }

    if (!task.startDate) {
      const endDate = new Date(task.endDate + 'T00:00:00');
      const start = durationDays === 0 ? endDate : subDays(endDate, durationDays);
      task.startDate = formatISO(start);
    }
  }
}

/**
 * Resolve dependency references (task names) to task IDs.
 * Searches both the newly parsed tasks and existing store tasks.
 */
function resolveDependencyRefs(tasks, existingTasks) {
  // Build a lookup: lowercase title -> task ID
  const titleToId = new Map();
  for (const t of existingTasks) {
    titleToId.set(t.title.toLowerCase(), t.id);
  }
  for (const t of tasks) {
    if (t.id && t.title) {
      titleToId.set(t.title.toLowerCase(), t.id);
    }
  }

  for (const task of tasks) {
    if (!task._dependencyRefs?.length) continue;

    const hasEdgeFor = (id) => task.dependencies.some((e) =>
      (typeof e === 'string' ? e : e?.targetId) === id,
    );

    for (const ref of task._dependencyRefs) {
      const refLower = ref.toLowerCase();
      const matchedId = titleToId.get(refLower);
      if (matchedId) {
        if (!hasEdgeFor(matchedId)) {
          task.dependencies.push({ targetId: matchedId, type: 'hard-blocks' });
        }
      } else {
        // Fuzzy match: check if any title contains the reference
        for (const [title, id] of titleToId) {
          if (title.includes(refLower) || refLower.includes(title)) {
            if (!hasEdgeFor(id)) {
              task.dependencies.push({ targetId: id, type: 'hard-blocks' });
            }
            break;
          }
        }
      }
    }

    delete task._dependencyRefs;
  }
}
