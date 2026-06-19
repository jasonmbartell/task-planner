/**
 * prose.ingest handler — M-P5.
 *
 * Bridges the agent op channel to the prose-extraction pipeline. Lives outside
 * `_agentBulkApply` because the store-side validator only knows about
 * `task.add` / `bulk` / etc. — `prose.ingest` is a meta-op the watcher routes
 * here directly.
 *
 * Pipeline:
 *   1. Validate `payload.content`.
 *   2. Build an LLMClient from `store.getState().obsidianConfig` (rejection
 *      if no API key — extraction is LLM-only, no deterministic fallback).
 *   3. Run `parseMarkdownIntelligent({ inputShape: 'prose' })` to extract
 *      candidate tasks. `payload.inputShape` is informational only — the
 *      writing agent pre-converts spreadsheets to markdown tables, so the
 *      planner always treats `content` as prose.
 *   4. Build a `bulk` envelope of `task.add` children via the existing
 *      `buildIngestEnvelope` (shared with the in-app modal, M-P3).
 *   5. Return two outcomes:
 *        - `self`: result block for the prose.ingest envelope (`applied`,
 *          `diff.ingest = { queuedBulkOpId, candidateCount, ... }`).
 *        - `spawned`: the bulk envelope to archive as `queued` so the M4
 *          inbox UI surfaces it for human review.
 *
 * The handler does NOT auto-apply the spawned bulk — extraction
 * hallucinations should never silently mutate the store.
 */

import { parseMarkdownIntelligent } from '../obsidian/parseOrchestrator.js';
import { buildIngestEnvelope, buildLLMClientFromConfig } from '../ingest/proseIngest.js';
import { ProseIngestionNoLlmError } from '../obsidian/errors.js';

/**
 * @typedef {Object} ProseIngestSelfResult
 * @property {'applied'|'rejected'} status
 * @property {number} [appliedAt]
 * @property {number} [rejectedAt]
 * @property {object|null} [diff]
 * @property {object|null} [error]
 *
 * @typedef {Object} ProseIngestSpawned
 * @property {object} envelope - bulk envelope ready to archive as queued
 * @property {string} reason - free-form reason for the queue (e.g. 'prose-ingest')
 *
 * @typedef {Object} ProseIngestOutcome
 * @property {ProseIngestSelfResult} self
 * @property {ProseIngestSpawned|null} spawned
 */

/**
 * Process a `prose.ingest` envelope.
 *
 * @param {object} envelope - the parsed envelope (must be type='prose.ingest')
 * @param {object} deps
 * @param {import('zustand').StoreApi<any>} deps.store - zustand store
 * @param {(cfg: object) => object|null} [deps.llmClientBuilder=buildLLMClientFromConfig]
 *   - factory that returns an LLMClient given obsidianConfig, or null if not configured
 * @param {() => number} [deps.now] - clock fn (defaults to Date.now)
 * @returns {Promise<ProseIngestOutcome>}
 */
export async function processProseIngest(envelope, deps) {
  const now = typeof deps?.now === 'function' ? deps.now() : Date.now();
  const store = deps?.store;
  const llmClientBuilder = deps?.llmClientBuilder || buildLLMClientFromConfig;

  if (!store || typeof store.getState !== 'function') {
    return {
      self: rejected(now, 'internal', 'processProseIngest: store with getState() required'),
      spawned: null,
    };
  }

  if (!envelope || envelope.type !== 'prose.ingest') {
    return {
      self: rejected(now, 'validation', 'processProseIngest: envelope.type must be "prose.ingest"'),
      spawned: null,
    };
  }

  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      self: rejected(now, 'validation', 'prose.ingest: payload must be an object'),
      spawned: null,
    };
  }

  const content = payload.content;
  if (typeof content !== 'string' || !content.trim()) {
    return {
      self: rejected(now, 'validation', 'prose.ingest: payload.content must be a non-empty string'),
      spawned: null,
    };
  }

  const sourceLabel = typeof payload.sourceLabel === 'string' && payload.sourceLabel.trim()
    ? payload.sourceLabel.trim()
    : 'agent-prose-ingest';

  const inputShapeHint = typeof payload.inputShape === 'string' ? payload.inputShape : 'prose';

  const state = store.getState();
  const llmClient = llmClientBuilder(state.obsidianConfig);
  if (!llmClient) {
    return {
      self: rejected(
        now,
        'config',
        'prose.ingest requires an LLM client; configure one in Settings (obsidianConfig.llmApiKey).',
      ),
      spawned: null,
    };
  }

  // Extraction. Always force inputShape='prose' — spreadsheet conversion
  // happens upstream (writing agent has xlsx tooling, planner doesn't carry
  // the binary). inputShapeHint is preserved in actor metadata for traceability.
  let extracted;
  try {
    extracted = await parseMarkdownIntelligent(content, {
      inputShape: 'prose',
      llmClient,
      sourceLabel,
      // fileName seeds parseProse's projectName fallback chain so the spawned
      // bulk lands in "Agent Inbox" rather than the generic "Untitled" when
      // the LLM doesn't infer a name. The modal's path uses sourceLabel
      // similarly; here we pin to a stable label.
      fileName: 'Agent Inbox',
      existingTasks: state.tasks ?? [],
    });
  } catch (err) {
    if (err instanceof ProseIngestionNoLlmError) {
      return {
        self: rejected(now, 'config', err.message),
        spawned: null,
      };
    }
    return {
      self: rejected(now, 'extraction_failed', err?.message || String(err)),
      spawned: null,
    };
  }

  const candidates = Array.isArray(extracted?.tasks) ? extracted.tasks : [];
  if (candidates.length === 0) {
    return {
      self: rejected(now, 'no_candidates', 'extraction produced 0 candidate tasks'),
      spawned: null,
    };
  }

  let bulk;
  try {
    bulk = buildIngestEnvelope(candidates, {
      projectName: extracted.projectName || 'Agent Inbox',
      projectDescription: extracted.projectDescription || '',
      existingProjects: state.projects ?? [],
      existingSprints: state.sprints ?? [],
      existingTasks: state.tasks ?? [],
      now,
    });
  } catch (err) {
    return {
      self: rejected(now, 'envelope_build_failed', err?.message || String(err)),
      spawned: null,
    };
  }

  const spawnedEnvelope = {
    ...bulk.envelope,
    actor: 'prose-ingest',
    createdAt: now,
    basedOn: typeof envelope.basedOn === 'number' ? envelope.basedOn : now,
    spawnedFromOpId: envelope.opId,
    inputShapeHint,
    sourceLabel,
  };

  return {
    self: {
      status: 'applied',
      appliedAt: now,
      diff: {
        ingest: {
          queuedBulkOpId: spawnedEnvelope.opId,
          candidateCount: candidates.length,
          projectName: extracted.projectName || 'Agent Inbox',
          projectId: bulk.projectId,
          sprintId: bulk.sprintId,
          isNewProject: bulk.isNewProject,
          isNewSprint: bulk.isNewSprint,
          droppedDeps: Array.isArray(bulk.droppedDeps) ? bulk.droppedDeps.length : 0,
          extraction: extracted._extraction || null,
        },
      },
      error: null,
    },
    spawned: {
      envelope: spawnedEnvelope,
      reason: 'prose-ingest',
    },
  };
}

function rejected(now, kind, message, details) {
  return {
    status: 'rejected',
    rejectedAt: now,
    diff: null,
    error: { kind, message, ...(details ? { details } : {}) },
  };
}

export const __TEST_ONLY__ = { rejected };
