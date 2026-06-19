/**
 * Prose Ingest Service (M-P3)
 *
 * The plumbing behind the in-app "Ingest" modal. Keeps the IngestModal thin
 * and React-free so this module is unit-testable without jsdom.
 *
 * Pipeline:
 *   1. `runProseExtraction(content, options)` — calls the orchestrator with
 *      the caller's chosen inputShape, returning the candidate list plus any
 *      routing/LLM error surfaced for UI display.
 *   2. `buildIngestEnvelope(candidates, { projectName, ..., existingProjects, existingSprints })`
 *      — converts accepted candidates into a single `bulk` envelope
 *      composed of `project.add` (if the extracted project is new), a
 *      `sprint.add` for the "Inbox" sprint (if new), and a `task.add` per
 *      candidate. IDs are prefilled so the envelope validates; references
 *      stay consistent within the bulk.
 *   3. `applyIngestEnvelope(store, envelope)` — shims `_agentBulkApply` with
 *      `forceApply: true` (the user just reviewed them in the modal) and
 *      returns the result.
 *
 * Spec: docs/prose-ingestion.md §8a.
 */

import { parseMarkdownIntelligent } from '../obsidian/parseOrchestrator.js';
import { LLMClient } from '../obsidian/llmClient.js';
import { ProseIngestionNoLlmError } from '../obsidian/errors.js';
import { genId } from '../utils/ids.js';
import { getNextColor } from '../utils/colors.js';

const INBOX_SPRINT_NAME = 'Inbox';

/**
 * Build an LLMClient from the store's obsidianConfig if an API key is
 * present. Returns null otherwise so callers can show a "configure LLM"
 * nudge instead of firing a guaranteed-to-fail request.
 *
 * @param {object} obsidianConfig - `store.getState().obsidianConfig`
 * @returns {LLMClient|null}
 */
export function buildLLMClientFromConfig(obsidianConfig) {
  if (!obsidianConfig || typeof obsidianConfig !== 'object') return null;
  const apiKey = String(obsidianConfig.llmApiKey || '').trim();
  if (!apiKey) return null;
  return new LLMClient({
    apiKey,
    endpointUrl: obsidianConfig.llmEndpointUrl || undefined,
    model: obsidianConfig.llmModel || undefined,
  });
}

/**
 * Run the extraction pipeline. Thin wrapper over `parseMarkdownIntelligent`;
 * exists so the modal doesn't need to know about orchestrator internals.
 *
 * @param {string} content
 * @param {object} options
 * @param {'auto'|'prose'|'markdown'|'structured'} [options.inputShape='auto'] - 'structured' is a back-compat synonym for 'markdown'.
 * @param {LLMClient|null} [options.llmClient]
 * @param {string} [options.sourceLabel='pasted-text']
 * @param {Array<object>} [options.existingTasks=[]] - for dep-ref resolution.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ projectName, projectDescription, sprints, tasks }>}
 * @throws {ProseIngestionNoLlmError} if the shape resolves to prose and no LLM is configured.
 */
export async function runProseExtraction(content, options = {}) {
  const {
    inputShape = 'auto',
    llmClient = null,
    sourceLabel = 'pasted-text',
    existingTasks = [],
    signal,
  } = options;

  return parseMarkdownIntelligent(content, {
    inputShape,
    llmClient,
    sourceLabel,
    existingTasks,
    signal,
  });
}

/**
 * Strip extraction metadata from a candidate and pack the source snippet
 * into the description as a blockquote, so provenance survives even though
 * the core Task schema doesn't carry `_sourcePointer` yet (P3i).
 *
 * Idempotent: a candidate with no _sourcePointer comes through with just
 * metadata fields dropped.
 *
 * @param {object} candidate - normalized candidate from parseProse/orchestrator
 * @returns {object} cleaned task payload ready for `task.add.payload.task`
 */
export function stripCandidateForAdd(candidate, { sprintId }) {
  const {
    _sourcePointer,
    _confidence,      // extraction metadata
    _dependencyRefs,  // consumed by stage 7 of the orchestrator before we see the candidate
    _ambiguousFields,
    _subtasks,
    _originalLines,
    _isLegacyFormat,
    _sprintName,
    _projectName,
    ...rest
  } = candidate;

  const task = {
    id: rest.id,
    title: rest.title,
    description: packSourceIntoDescription(rest.description || '', _sourcePointer),
    status: rest.status || 'todo',
    startDate: rest.startDate || '',
    endDate: rest.endDate || '',
    dueDate: rest.dueDate || '',
    urgency: rest.urgency ?? 1,
    importance: rest.importance ?? 1,
    difficulty: rest.difficulty ?? 1,
    dependencies: Array.isArray(rest.dependencies) ? rest.dependencies : [],
    sprintId,
    parentTaskId: rest.parentTaskId ?? null,
  };

  return task;
}

function packSourceIntoDescription(description, sourcePointer) {
  if (!sourcePointer || typeof sourcePointer !== 'object') return description;
  const src = String(sourcePointer.source || '').trim();
  const raw = String(sourcePointer.rawText || '').trim();
  if (!src && !raw) return description;
  // Conservative: don't quote multi-KB rawText — parseProse already truncates
  // to 512 chars, but guard here too in case the shape changes.
  const quote = raw.length > 512 ? raw.slice(0, 511) + '…' : raw;
  const breadcrumb = `> Source: ${src || '(unknown)'}` + (quote ? `\n> ${quote.replace(/\n/g, '\n> ')}` : '');
  return description ? `${description}\n\n${breadcrumb}` : breadcrumb;
}

/**
 * Convert the accepted candidate list into a single `bulk` envelope.
 *
 * If `projectName` matches an existing project (case-insensitive), reuse its
 * ID; otherwise emit a `project.add`. Same for the Inbox sprint scoped to
 * that project. Each candidate becomes a `task.add` child.
 *
 * @param {Array<object>} candidates - cleaned list (the modal's "approved" rows).
 * @param {object} ctx
 * @param {string} ctx.projectName
 * @param {string} [ctx.projectDescription]
 * @param {Array<object>} ctx.existingProjects - `store.getState().projects`
 * @param {Array<object>} ctx.existingSprints - `store.getState().sprints`
 * @param {Array<object>} [ctx.existingTasks] - `store.getState().tasks`, used
 *   to validate dep edges. Edges pointing at IDs not in the batch or store
 *   are silently dropped so a partial paste (e.g. lines 19–87 of a file
 *   that references IDs defined earlier) can still apply.
 * @param {number} [ctx.now=Date.now()]
 * @returns {{ envelope, projectId, sprintId, isNewProject, isNewSprint, droppedDeps }}
 */
export function buildIngestEnvelope(candidates, ctx) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('buildIngestEnvelope: at least one candidate required');
  }
  const {
    projectName = 'Inbox',
    projectDescription = '',
    existingProjects = [],
    existingSprints = [],
    existingTasks = [],
    now = Date.now(),
  } = ctx || {};

  // Set of IDs an edge may legitimately point at: everything already in the
  // store plus every task in this batch. Edges outside this set are dropped
  // before the envelope is assembled — the validator would otherwise reject
  // the whole bulk and the user's tasks wouldn't land.
  const validTargetIds = new Set();
  for (const t of existingTasks) if (t?.id) validTargetIds.add(t.id);
  for (const c of candidates) if (c?.id) validTargetIds.add(c.id);

  const droppedDeps = [];

  const ops = [];

  // Find-or-create project.
  const nameKey = String(projectName).trim().toLowerCase();
  const existingProject = existingProjects.find((p) => String(p.name || '').trim().toLowerCase() === nameKey);
  let projectId;
  let isNewProject = false;
  if (existingProject) {
    projectId = existingProject.id;
  } else {
    projectId = genId('proj');
    isNewProject = true;
    ops.push({
      type: 'project.add',
      payload: {
        project: {
          id: projectId,
          name: String(projectName).trim() || 'Inbox',
          color: getNextColor(existingProjects.map((p) => p.color).filter(Boolean)),
          description: projectDescription || '',
          updatedAt: now,
        },
      },
    });
  }

  // Find-or-create Inbox sprint for this project.
  const existingSprint = existingSprints.find(
    (s) => s.projectId === projectId && String(s.name || '').trim().toLowerCase() === INBOX_SPRINT_NAME.toLowerCase(),
  );
  let sprintId;
  let isNewSprint = false;
  if (existingSprint) {
    sprintId = existingSprint.id;
  } else {
    sprintId = genId('sprint');
    isNewSprint = true;
    ops.push({
      type: 'sprint.add',
      payload: {
        sprint: {
          id: sprintId,
          name: INBOX_SPRINT_NAME,
          projectId,
          startDate: isoDate(now),
          endDate: '',
          updatedAt: now,
        },
      },
    });
  }

  // Preserve each candidate's ID from parseProse — it's nanoid-based so
  // collision with store IDs is effectively impossible, and keeping it
  // means the orchestrator's stage-7 dependency edges (which already
  // resolved to *these* IDs) stay internally consistent.
  for (const candidate of candidates) {
    const prunedDeps = [];
    for (const edge of Array.isArray(candidate.dependencies) ? candidate.dependencies : []) {
      const targetId = typeof edge === 'string' ? edge : edge?.targetId;
      if (targetId && validTargetIds.has(targetId)) {
        prunedDeps.push(edge);
      } else if (targetId) {
        droppedDeps.push({ fromTaskId: candidate.id, fromTitle: candidate.title, targetId });
      }
    }
    const cleaned = { ...candidate, dependencies: prunedDeps };
    ops.push({
      type: 'task.add',
      payload: { task: stripCandidateForAdd(cleaned, { sprintId }) },
    });
  }

  const envelope = {
    opId: `op-ingest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'bulk',
    actor: 'ingest-modal',
    payload: { ops },
  };

  return { envelope, projectId, sprintId, isNewProject, isNewSprint, droppedDeps };
}

/**
 * Apply an envelope through the store. Uses `forceApply: true` because the
 * user just reviewed each candidate in the modal — the trust matrix's
 * default "adds apply" already lets these through, but forcing is
 * unambiguous and dodges a staleness false-positive if the store mutated
 * during review.
 *
 * @param {import('zustand').StoreApi<any>} store - zustand store (with getState())
 * @param {object} envelope
 * @returns {{ status: string, diff?: object, error?: object, appliedAt?: number }}
 */
export function applyIngestEnvelope(store, envelope) {
  if (!store || typeof store.getState !== 'function') {
    throw new Error('applyIngestEnvelope: zustand store required');
  }
  const state = store.getState();
  if (typeof state._agentBulkApply !== 'function') {
    throw new Error('applyIngestEnvelope: store does not expose _agentBulkApply');
  }
  return state._agentBulkApply(envelope, { forceApply: true, now: Date.now() });
}

function isoDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export { ProseIngestionNoLlmError };
