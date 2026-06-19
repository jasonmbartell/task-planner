/**
 * Unit tests for the prose.ingest handler (M-P5).
 *
 * The handler is store-aware (reads obsidianConfig + state for envelope
 * assembly) but doesn't touch I/O or React, so we exercise it against the
 * real Zustand store with stubbed extraction. Validation paths use mocks
 * for clarity.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import useStore from '../../store/useStore.js';
import { processProseIngest } from '../proseIngestHandler.js';

function resetStore({ projects = [], sprints = [], tasks = [], obsidianConfig = {} } = {}) {
  useStore.setState({
    projects, sprints, tasks,
    obsidianConfig: {
      vaultPath: '', taskFiles: '', taskFolder: 'Tasks', syncInterval: 30,
      enabled: false, llmApiKey: '', llmEndpointUrl: '',
      llmModel: 'claude-sonnet-4-20250514', syncOnFocus: true,
      plannerDataPath: '',
      ...obsidianConfig,
    },
    _past: [], _future: [],
    _notifications: [],
  });
}

const ENVELOPE_TEMPLATE = (overrides = {}) => ({
  opId: 'op-prose-test-1',
  createdAt: 1000,
  basedOn: 1000,
  actor: 'claude/cowork',
  type: 'prose.ingest',
  payload: {
    content: 'Need to ship the investor deck by Friday and queue smoke tests for staging.',
    sourceLabel: 'cowork-2026-04-23',
    inputShape: 'prose',
  },
  ...overrides,
});

const TWO_TASK_EXTRACTION = {
  projectName: 'Investor prep',
  projectDescription: '',
  sprints: [],
  tasks: [
    {
      id: 'task-extract-001',
      title: 'Ship investor deck',
      description: 'Slides 3 and 7 still blank',
      startDate: '', endDate: '', dueDate: '2026-04-25',
      urgency: 8, importance: 9, difficulty: 4,
      status: 'todo',
      dependencies: [],
      parentTaskId: null,
      _confidence: 0.9,
      _sourcePointer: { source: 'cowork-2026-04-23', lineStart: 1, lineEnd: 1, rawText: 'investor deck by Friday' },
    },
    {
      id: 'task-extract-002',
      title: 'Queue smoke tests for staging',
      description: '',
      startDate: '', endDate: '', dueDate: '',
      urgency: 5, importance: 6, difficulty: 3,
      status: 'todo',
      dependencies: [],
      parentTaskId: null,
      _confidence: 0.7,
      _sourcePointer: { source: 'cowork-2026-04-23', lineStart: 1, lineEnd: 1, rawText: 'smoke tests for staging' },
    },
  ],
  _extraction: { model: 'mock-model', tokensUsed: 200, wallMs: 1, chunkCount: 1 },
};

function makeLLM(canned) {
  return { model: 'mock-model', chat: vi.fn(async () => JSON.stringify(canned)) };
}

describe('processProseIngest', () => {
  beforeEach(() => {
    resetStore();
  });

  it('rejects when store is missing', async () => {
    const out = await processProseIngest(ENVELOPE_TEMPLATE(), {});
    expect(out.self.status).toBe('rejected');
    expect(out.self.error.kind).toBe('internal');
    expect(out.spawned).toBeNull();
  });

  it('rejects when envelope.type is wrong', async () => {
    const out = await processProseIngest(
      { type: 'task.add', opId: 'x', payload: {} },
      { store: useStore },
    );
    expect(out.self.status).toBe('rejected');
    expect(out.self.error.kind).toBe('validation');
  });

  it('rejects when payload is missing', async () => {
    const out = await processProseIngest(ENVELOPE_TEMPLATE({ payload: undefined }), { store: useStore });
    expect(out.self.status).toBe('rejected');
    expect(out.self.error.kind).toBe('validation');
  });

  it('rejects when content is empty or whitespace', async () => {
    const out1 = await processProseIngest(
      ENVELOPE_TEMPLATE({ payload: { content: '' } }),
      { store: useStore, llmClientBuilder: () => makeLLM(TWO_TASK_EXTRACTION) },
    );
    expect(out1.self.status).toBe('rejected');
    expect(out1.self.error.kind).toBe('validation');

    const out2 = await processProseIngest(
      ENVELOPE_TEMPLATE({ payload: { content: '   \n\n\t' } }),
      { store: useStore, llmClientBuilder: () => makeLLM(TWO_TASK_EXTRACTION) },
    );
    expect(out2.self.status).toBe('rejected');
    expect(out2.self.error.kind).toBe('validation');
  });

  it('rejects when no LLM client can be built', async () => {
    const out = await processProseIngest(ENVELOPE_TEMPLATE(), {
      store: useStore,
      llmClientBuilder: () => null,
    });
    expect(out.self.status).toBe('rejected');
    expect(out.self.error.kind).toBe('config');
    expect(out.self.error.message).toMatch(/LLM/);
    expect(out.spawned).toBeNull();
  });

  it('rejects when extraction yields zero candidates', async () => {
    const out = await processProseIngest(ENVELOPE_TEMPLATE(), {
      store: useStore,
      llmClientBuilder: () => makeLLM({ projectName: null, tasks: [] }),
    });
    expect(out.self.status).toBe('rejected');
    expect(out.self.error.kind).toBe('no_candidates');
  });

  it('rejects with extraction_failed when the LLM throws', async () => {
    const llm = { model: 'mock', chat: vi.fn(async () => { throw new Error('boom'); }) };
    const out = await processProseIngest(ENVELOPE_TEMPLATE(), {
      store: useStore,
      llmClientBuilder: () => llm,
    });
    expect(out.self.status).toBe('rejected');
    expect(out.self.error.kind).toBe('extraction_failed');
    expect(out.self.error.message).toMatch(/boom/);
  });

  it('on success: spawns a bulk envelope of task.add children + project + sprint', async () => {
    const out = await processProseIngest(ENVELOPE_TEMPLATE(), {
      store: useStore,
      llmClientBuilder: () => makeLLM(TWO_TASK_EXTRACTION),
      now: () => 999000,
    });

    expect(out.self.status).toBe('applied');
    expect(out.self.appliedAt).toBe(999000);
    expect(out.self.diff.ingest.candidateCount).toBe(2);
    expect(out.self.diff.ingest.queuedBulkOpId).toBe(out.spawned.envelope.opId);
    expect(out.self.diff.ingest.projectName).toBe('Investor prep');
    expect(out.self.diff.ingest.isNewProject).toBe(true);
    expect(out.self.diff.ingest.isNewSprint).toBe(true);
    expect(out.self.diff.ingest.extraction.chunkCount).toBe(1);

    const env = out.spawned.envelope;
    expect(env.type).toBe('bulk');
    expect(env.actor).toBe('prose-ingest');
    expect(env.spawnedFromOpId).toBe('op-prose-test-1');
    expect(env.basedOn).toBe(1000);
    expect(env.sourceLabel).toBe('cowork-2026-04-23');
    expect(env.inputShapeHint).toBe('prose');

    const types = env.payload.ops.map((o) => o.type);
    expect(types).toContain('project.add');
    expect(types).toContain('sprint.add');
    expect(types.filter((t) => t === 'task.add')).toHaveLength(2);

    const taskOps = env.payload.ops.filter((o) => o.type === 'task.add');
    expect(taskOps[0].payload.task.title).toBe('Ship investor deck');
    expect(taskOps[0].payload.task.dueDate).toBe('2026-04-25');
    // Provenance packed into description
    expect(taskOps[0].payload.task.description).toMatch(/Source:.*cowork-2026-04-23/);

    expect(out.spawned.reason).toBe('prose-ingest');
  });

  it('reuses an existing project when names match (case-insensitive)', async () => {
    resetStore({
      projects: [{ id: 'proj-existing', name: 'Investor Prep', color: '#abc', description: '', updatedAt: 1 }],
      sprints: [],
      tasks: [],
    });

    const out = await processProseIngest(ENVELOPE_TEMPLATE(), {
      store: useStore,
      llmClientBuilder: () => makeLLM(TWO_TASK_EXTRACTION),
    });
    expect(out.self.status).toBe('applied');
    expect(out.self.diff.ingest.isNewProject).toBe(false);
    expect(out.self.diff.ingest.projectId).toBe('proj-existing');

    const projectOps = out.spawned.envelope.payload.ops.filter((o) => o.type === 'project.add');
    expect(projectOps).toHaveLength(0);
  });

  it('falls back to "Agent Inbox" when extraction returns no projectName', async () => {
    const out = await processProseIngest(ENVELOPE_TEMPLATE(), {
      store: useStore,
      llmClientBuilder: () => makeLLM({ ...TWO_TASK_EXTRACTION, projectName: null }),
    });
    expect(out.self.status).toBe('applied');
    expect(out.self.diff.ingest.projectName).toBe('Agent Inbox');
  });

  it('uses agent-prose-ingest as the default sourceLabel when payload omits one', async () => {
    const out = await processProseIngest(
      ENVELOPE_TEMPLATE({ payload: { content: 'do the thing' } }),
      {
        store: useStore,
        llmClientBuilder: () => makeLLM(TWO_TASK_EXTRACTION),
      },
    );
    expect(out.self.status).toBe('applied');
    expect(out.spawned.envelope.sourceLabel).toBe('agent-prose-ingest');
  });

  it('preserves the original opId in spawnedFromOpId', async () => {
    const out = await processProseIngest(
      ENVELOPE_TEMPLATE({ opId: 'op-original-12345' }),
      {
        store: useStore,
        llmClientBuilder: () => makeLLM(TWO_TASK_EXTRACTION),
      },
    );
    expect(out.spawned.envelope.spawnedFromOpId).toBe('op-original-12345');
    expect(out.spawned.envelope.opId).not.toBe('op-original-12345');
  });
});
