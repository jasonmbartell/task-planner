/**
 * Ingest service tests (M-P3).
 *
 * Exercises the three public functions that back the IngestModal:
 *   - runProseExtraction: correct routing, propagates ProseIngestionNoLlmError
 *   - buildIngestEnvelope: project/sprint reuse vs. creation, task.add shape,
 *     description provenance packing, envelope opId/type/actor
 *   - applyIngestEnvelope: forceApply path on a real zustand store (adds
 *     land as tasks without going through trust/staleness gates)
 *
 * The modal itself (JSX, React state) is tested by manual smoke because the
 * project doesn't carry @testing-library/react + jsdom. All non-rendering
 * logic in the modal delegates to these functions, which are covered here.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runProseExtraction,
  buildIngestEnvelope,
  applyIngestEnvelope,
  stripCandidateForAdd,
  buildLLMClientFromConfig,
  ProseIngestionNoLlmError,
} from '../proseIngest.js';
import useStore from '../../store/useStore.js';

function makeLLM(responses, { model = 'mock-model' } = {}) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const chat = vi.fn(async () => {
    if (queue.length === 0) return '{"tasks":[]}';
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'string' ? next : JSON.stringify(next);
  });
  return { chat, model };
}

function resetStore() {
  // Blow away mutation-held state between tests so each case sees a clean
  // store. The zustand store is a module-level singleton here, so explicit
  // reset is required.
  useStore.setState({
    projects: [],
    sprints: [],
    tasks: [],
    _past: [],
    _future: [],
  });
}

const PROSE = `Need to finish the investor deck by next Friday — slides 3 and 7 still blank. Also the pricing page copy is overdue.`;

describe('runProseExtraction', () => {
  it('routes to parseProse when inputShape="prose" with an LLM client', async () => {
    const llm = makeLLM([
      {
        projectName: 'Fundraising',
        projectDescription: 'Close the round',
        tasks: [
          { title: 'Finish investor deck', _confidence: 0.9, urgency: 8, importance: 9 },
        ],
      },
    ]);
    const result = await runProseExtraction(PROSE, {
      inputShape: 'prose',
      llmClient: llm,
      sourceLabel: 'test',
    });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(result.projectName).toBe('Fundraising');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Finish investor deck');
    expect(result.tasks[0]._sourcePointer.source).toBe('test');
  });

  it('routes to structured parser when inputShape="structured" (no LLM call)', async () => {
    const llm = makeLLM([]);
    const result = await runProseExtraction('- [ ] Ship thing | urg:3 | imp:5 | diff:2', {
      inputShape: 'structured',
      llmClient: llm,
    });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Ship thing');
  });

  it('auto mode dispatches based on content', async () => {
    const llm = makeLLM([{ tasks: [{ title: 'Pure prose task', _confidence: 0.7 }] }]);
    const r1 = await runProseExtraction(PROSE, { inputShape: 'auto', llmClient: llm });
    expect(r1.tasks).toHaveLength(1);
    expect(r1.tasks[0].title).toBe('Pure prose task');

    const r2 = await runProseExtraction('- [ ] Structured | urg:2 | imp:4 | diff:1', {
      inputShape: 'auto',
      llmClient: llm,
    });
    expect(r2.tasks).toHaveLength(1);
    expect(r2.tasks[0].title).toBe('Structured');
    // Only one LLM call total — the structured case didn't fire one.
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('surfaces ProseIngestionNoLlmError when prose path has no client', async () => {
    await expect(
      runProseExtraction(PROSE, { inputShape: 'prose', llmClient: null })
    ).rejects.toBeInstanceOf(ProseIngestionNoLlmError);
  });
});

describe('buildLLMClientFromConfig', () => {
  it('returns null when no API key is configured', () => {
    expect(buildLLMClientFromConfig(null)).toBeNull();
    expect(buildLLMClientFromConfig({})).toBeNull();
    expect(buildLLMClientFromConfig({ llmApiKey: '' })).toBeNull();
    expect(buildLLMClientFromConfig({ llmApiKey: '   ' })).toBeNull();
  });

  it('builds a client when an API key is present', () => {
    const client = buildLLMClientFromConfig({
      llmApiKey: 'sk-fake',
      llmEndpointUrl: 'https://api.anthropic.com/v1/messages',
      llmModel: 'claude-sonnet-4-20250514',
    });
    expect(client).not.toBeNull();
    expect(client.apiKey).toBe('sk-fake');
    expect(client.model).toBe('claude-sonnet-4-20250514');
  });
});

describe('stripCandidateForAdd', () => {
  it('drops extraction metadata and packs _sourcePointer into the description', () => {
    const candidate = {
      id: 'task-00000001',
      title: 'Ship thing',
      description: 'initial note',
      dueDate: '2026-05-01',
      urgency: 5, importance: 5, difficulty: 3,
      status: 'in-progress',
      dependencies: [],
      parentTaskId: null,
      _sourcePointer: {
        source: 'pasted-text',
        lineStart: 1,
        lineEnd: 4,
        rawText: 'Need to ship thing by next week',
      },
      _confidence: 0.9,
      _dependencyRefs: ['something'],
      _ambiguousFields: {},
      _subtasks: [],
    };

    const cleaned = stripCandidateForAdd(candidate, { sprintId: 'sprint-abc12345' });
    expect(cleaned._sourcePointer).toBeUndefined();
    expect(cleaned._confidence).toBeUndefined();
    expect(cleaned._dependencyRefs).toBeUndefined();
    expect(cleaned.sprintId).toBe('sprint-abc12345');
    expect(cleaned.description).toContain('initial note');
    expect(cleaned.description).toContain('> Source: pasted-text');
    expect(cleaned.description).toContain('> Need to ship thing by next week');
  });

  it('leaves description alone when candidate has no _sourcePointer', () => {
    const cleaned = stripCandidateForAdd(
      { id: 'task-00000002', title: 'T', description: 'plain' },
      { sprintId: 'sprint-abc' },
    );
    expect(cleaned.description).toBe('plain');
  });

  it('applies safe numeric defaults for urgency/importance/difficulty', () => {
    const cleaned = stripCandidateForAdd(
      { id: 'task-00000003', title: 'T', urgency: null, importance: undefined, difficulty: 0 },
      { sprintId: 'sprint-abc' },
    );
    expect(cleaned.urgency).toBe(1);
    expect(cleaned.importance).toBe(1);
    expect(cleaned.difficulty).toBe(0); // 0 is respected — strip only defaults null/undefined
  });
});

describe('buildIngestEnvelope', () => {
  it('emits project.add + sprint.add + task.add for a brand-new project', () => {
    const candidates = [
      { id: 'task-old01234', title: 'A', description: '', urgency: 5, importance: 5, difficulty: 3, dependencies: [], status: 'todo' },
      { id: 'task-old05678', title: 'B', description: '', urgency: 5, importance: 5, difficulty: 3, dependencies: [], status: 'todo' },
    ];
    const { envelope, projectId, sprintId, isNewProject, isNewSprint } = buildIngestEnvelope(candidates, {
      projectName: 'NewProj',
      projectDescription: 'desc',
      existingProjects: [],
      existingSprints: [],
    });
    expect(isNewProject).toBe(true);
    expect(isNewSprint).toBe(true);
    expect(projectId).toMatch(/^proj-/);
    expect(sprintId).toMatch(/^sprint-/);

    expect(envelope.type).toBe('bulk');
    expect(envelope.actor).toBe('ingest-modal');
    expect(envelope.opId).toMatch(/^op-ingest-/);
    expect(envelope.payload.ops).toHaveLength(4);

    const [addProj, addSprint, addT1, addT2] = envelope.payload.ops;
    expect(addProj.type).toBe('project.add');
    expect(addProj.payload.project.id).toBe(projectId);
    expect(addProj.payload.project.name).toBe('NewProj');

    expect(addSprint.type).toBe('sprint.add');
    expect(addSprint.payload.sprint.id).toBe(sprintId);
    expect(addSprint.payload.sprint.projectId).toBe(projectId);
    expect(addSprint.payload.sprint.name).toBe('Inbox');

    expect(addT1.type).toBe('task.add');
    expect(addT1.payload.task.sprintId).toBe(sprintId);
    // Candidate IDs are preserved (not regenerated). This is load-bearing:
    // the orchestrator's stage-7 dep-ref resolution writes edges pointing
    // at these IDs, so replacing them here would orphan the edges and the
    // bulk validator would reject the envelope.
    expect(addT1.payload.task.id).toBe('task-old01234');
    expect(addT2.payload.task.id).toBe('task-old05678');
    expect(addT2.type).toBe('task.add');
    expect(addT2.payload.task.sprintId).toBe(sprintId);
  });

  it('reuses existing project + sprint by case-insensitive name match', () => {
    const existingProjects = [
      { id: 'proj-existing1', name: 'Fundraising', color: '#fff', description: '', sprintIds: [] },
    ];
    const existingSprints = [
      { id: 'sprint-existing1', name: 'Inbox', projectId: 'proj-existing1', startDate: '2026-04-01', endDate: '' },
    ];
    const { envelope, projectId, sprintId, isNewProject, isNewSprint } = buildIngestEnvelope(
      [{ id: 'task-xxx', title: 'T', description: '', urgency: 5, importance: 5, difficulty: 3, dependencies: [], status: 'todo' }],
      { projectName: 'fundraising', existingProjects, existingSprints },
    );
    expect(isNewProject).toBe(false);
    expect(isNewSprint).toBe(false);
    expect(projectId).toBe('proj-existing1');
    expect(sprintId).toBe('sprint-existing1');
    // Only one op emitted — the task.add; project and sprint were reused.
    expect(envelope.payload.ops).toHaveLength(1);
    expect(envelope.payload.ops[0].type).toBe('task.add');
  });

  it('creates the Inbox sprint when the project exists but the sprint does not', () => {
    const existingProjects = [
      { id: 'proj-abc', name: 'MyProj', color: '#fff', description: '', sprintIds: [] },
    ];
    const existingSprints = []; // no Inbox sprint yet
    const { envelope, isNewProject, isNewSprint } = buildIngestEnvelope(
      [{ id: 'task-xxx', title: 'T', description: '', urgency: 5, importance: 5, difficulty: 3, dependencies: [], status: 'todo' }],
      { projectName: 'MyProj', existingProjects, existingSprints },
    );
    expect(isNewProject).toBe(false);
    expect(isNewSprint).toBe(true);
    const types = envelope.payload.ops.map((o) => o.type);
    expect(types).toEqual(['sprint.add', 'task.add']);
  });

  it('throws when called with an empty candidate list', () => {
    expect(() => buildIngestEnvelope([], { existingProjects: [], existingSprints: [] })).toThrow();
    expect(() => buildIngestEnvelope(null, { existingProjects: [], existingSprints: [] })).toThrow();
  });

  it('drops dep edges whose target is outside the batch and the store', () => {
    // Regression: structured paste of `- [ ] X\n  - Depends on: task-abc`
    // where task-abc lives in an earlier part of the source file NOT in the
    // paste. Previously the bulk validator rejected the whole envelope with
    // "task.add: dependency <id> not found"; now those edges drop silently
    // so the rest of the tasks still land.
    const candidates = [
      {
        id: 'task-in-batch',
        title: 'In batch',
        description: '',
        urgency: 5, importance: 5, difficulty: 3,
        dependencies: [
          { targetId: 'task-outside', type: 'hard-blocks' },  // not in batch, not in store
          { targetId: 'task-in-store', type: 'soft-prefers' }, // present in store
        ],
        status: 'todo',
      },
    ];
    const { envelope, droppedDeps } = buildIngestEnvelope(candidates, {
      projectName: 'P',
      existingProjects: [],
      existingSprints: [],
      existingTasks: [{ id: 'task-in-store', title: 'Pre-existing', sprintId: 'sprint-x' }],
    });
    const taskAdd = envelope.payload.ops.find((o) => o.type === 'task.add');
    expect(taskAdd.payload.task.dependencies).toEqual([
      { targetId: 'task-in-store', type: 'soft-prefers' },
    ]);
    expect(droppedDeps).toHaveLength(1);
    expect(droppedDeps[0]).toMatchObject({ fromTaskId: 'task-in-batch', targetId: 'task-outside' });
  });

  it('preserves inter-candidate dependency edges through the envelope', () => {
    // Regression: previously buildIngestEnvelope regenerated each task's
    // ID, which orphaned the stage-7-resolved edges and made the bulk
    // validator reject the envelope with "dependency <id> not found".
    const candidates = [
      { id: 'task-target01', title: 'Target', description: '', urgency: 5, importance: 5, difficulty: 3, dependencies: [], status: 'todo' },
      {
        id: 'task-depender1',
        title: 'Dependent',
        description: '',
        urgency: 5, importance: 5, difficulty: 3,
        dependencies: [{ targetId: 'task-target01', type: 'hard-blocks' }],
        status: 'todo',
      },
    ];
    const { envelope } = buildIngestEnvelope(candidates, {
      projectName: 'DepTest',
      existingProjects: [],
      existingSprints: [],
    });
    const taskAdds = envelope.payload.ops.filter((o) => o.type === 'task.add');
    expect(taskAdds[0].payload.task.id).toBe('task-target01');
    expect(taskAdds[1].payload.task.id).toBe('task-depender1');
    expect(taskAdds[1].payload.task.dependencies).toEqual([
      { targetId: 'task-target01', type: 'hard-blocks' },
    ]);
  });

  it('applies cleanly when one extracted task depends on another (end-to-end)', () => {
    // Full pipeline regression for the dep-not-found bug.
    resetStore();
    const candidates = [
      { id: 'task-aaaaaaa1', title: 'First', description: '', urgency: 5, importance: 5, difficulty: 3, dependencies: [], status: 'todo' },
      {
        id: 'task-bbbbbbb2',
        title: 'Second (depends on First)',
        description: '',
        urgency: 5, importance: 5, difficulty: 3,
        dependencies: [{ targetId: 'task-aaaaaaa1', type: 'hard-blocks' }],
        status: 'todo',
      },
    ];
    const state = useStore.getState();
    const { envelope } = buildIngestEnvelope(candidates, {
      projectName: 'DepTest',
      existingProjects: state.projects,
      existingSprints: state.sprints,
    });
    const res = applyIngestEnvelope(useStore, envelope);
    expect(res.status).toBe('applied');
    const after = useStore.getState();
    const second = after.tasks.find((t) => t.id === 'task-bbbbbbb2');
    expect(second.dependencies).toEqual([{ targetId: 'task-aaaaaaa1', type: 'hard-blocks' }]);
  });

  it('packs _sourcePointer into the task description', () => {
    const { envelope } = buildIngestEnvelope(
      [{
        id: 'task-xxx',
        title: 'T',
        description: 'note',
        urgency: 5, importance: 5, difficulty: 3, dependencies: [], status: 'todo',
        _sourcePointer: { source: 'cowork-2026-04-21', lineStart: 1, lineEnd: 2, rawText: 'raw snippet' },
        _confidence: 0.8,
      }],
      { projectName: 'P', existingProjects: [], existingSprints: [] },
    );
    const taskAdd = envelope.payload.ops.find((o) => o.type === 'task.add');
    expect(taskAdd.payload.task.description).toContain('note');
    expect(taskAdd.payload.task.description).toContain('> Source: cowork-2026-04-21');
    expect(taskAdd.payload.task.description).toContain('raw snippet');
    // extraction metadata does NOT leak into task payload
    expect(taskAdd.payload.task._sourcePointer).toBeUndefined();
    expect(taskAdd.payload.task._confidence).toBeUndefined();
  });
});

describe('applyIngestEnvelope (integration with the real zustand store)', () => {
  it('lands accepted candidates as tasks via the bulk apply path', () => {
    resetStore();
    const candidates = [
      { id: 'task-x1', title: 'First task', description: 'd1', urgency: 5, importance: 5, difficulty: 3, dependencies: [], status: 'todo' },
      { id: 'task-x2', title: 'Second task', description: 'd2', urgency: 5, importance: 5, difficulty: 3, dependencies: [], status: 'todo' },
    ];
    const state = useStore.getState();
    const { envelope } = buildIngestEnvelope(candidates, {
      projectName: 'TestProject',
      projectDescription: 'x',
      existingProjects: state.projects,
      existingSprints: state.sprints,
    });

    const res = applyIngestEnvelope(useStore, envelope);
    expect(res.status).toBe('applied');

    const after = useStore.getState();
    expect(after.projects.map((p) => p.name)).toEqual(['TestProject']);
    expect(after.sprints).toHaveLength(1);
    expect(after.sprints[0].name).toBe('Inbox');
    expect(after.tasks).toHaveLength(2);
    expect(after.tasks.map((t) => t.title).sort()).toEqual(['First task', 'Second task']);
    // Every task got a fresh ID and landed in the Inbox sprint.
    for (const t of after.tasks) {
      expect(t.id).toMatch(/^task-/);
      expect(t.sprintId).toBe(after.sprints[0].id);
    }
  });

  it('reuses an existing project so a second ingest does not duplicate it', () => {
    resetStore();
    const first = [
      { id: 'task-a', title: 'T1', description: '', urgency: 5, importance: 5, difficulty: 3, dependencies: [], status: 'todo' },
    ];
    const second = [
      { id: 'task-b', title: 'T2', description: '', urgency: 5, importance: 5, difficulty: 3, dependencies: [], status: 'todo' },
    ];

    let state = useStore.getState();
    const env1 = buildIngestEnvelope(first, {
      projectName: 'Reuse',
      existingProjects: state.projects,
      existingSprints: state.sprints,
    }).envelope;
    expect(applyIngestEnvelope(useStore, env1).status).toBe('applied');

    state = useStore.getState();
    const env2 = buildIngestEnvelope(second, {
      projectName: 'Reuse',
      existingProjects: state.projects,
      existingSprints: state.sprints,
    }).envelope;
    expect(applyIngestEnvelope(useStore, env2).status).toBe('applied');

    const after = useStore.getState();
    expect(after.projects).toHaveLength(1);
    expect(after.sprints).toHaveLength(1);
    expect(after.tasks).toHaveLength(2);
    // Both tasks share the same Inbox sprint.
    const sprintIds = new Set(after.tasks.map((t) => t.sprintId));
    expect(sprintIds.size).toBe(1);
  });

  it('full pipeline: runProseExtraction → buildIngestEnvelope → applyIngestEnvelope', async () => {
    resetStore();
    const llm = makeLLM([
      {
        projectName: 'Fundraising',
        tasks: [
          { title: 'Finish investor deck', _confidence: 0.9, dueDate: '2026-05-01', urgency: 8, importance: 9 },
          { title: 'Ship pricing page', _confidence: 0.7, urgency: 6, importance: 7 },
        ],
      },
    ]);

    const extraction = await runProseExtraction(PROSE, {
      inputShape: 'prose',
      llmClient: llm,
      sourceLabel: 'pasted-text',
    });
    expect(extraction.tasks).toHaveLength(2);

    const state = useStore.getState();
    const { envelope } = buildIngestEnvelope(extraction.tasks, {
      projectName: extraction.projectName,
      existingProjects: state.projects,
      existingSprints: state.sprints,
    });
    const res = applyIngestEnvelope(useStore, envelope);
    expect(res.status).toBe('applied');

    const after = useStore.getState();
    expect(after.projects[0].name).toBe('Fundraising');
    expect(after.tasks.map((t) => t.title).sort()).toEqual(['Finish investor deck', 'Ship pricing page']);

    // Provenance got packed into the description.
    for (const t of after.tasks) {
      expect(t.description).toContain('> Source: pasted-text');
    }
  });

  it('applies a markdown re-import that repeats the same id on multiple tasks', async () => {
    // Regression: a copy-pasted markdown file with `id:task-p4-01` on more
    // than one line used to render duplicate React keys in the candidate
    // list and then trip the bulk validator's duplicate_id check. The
    // orchestrator now de-dupes ids before flattening so the second
    // occurrence gets a fresh canonical id at apply time.
    resetStore();
    const md = `## Project: DupTest\n\n- [ ] First | id:task-p4-01 | urg:5 | imp:5 | diff:3\n- [ ] Second | id:task-p4-01 | urg:5 | imp:5 | diff:3`;
    const result = await runProseExtraction(md, { inputShape: 'markdown', llmClient: null });
    expect(result.tasks).toHaveLength(2);
    const ids = result.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(2); // unique after de-dup pass

    const state = useStore.getState();
    const { envelope } = buildIngestEnvelope(result.tasks, {
      projectName: result.projectName,
      existingProjects: state.projects,
      existingSprints: state.sprints,
      existingTasks: state.tasks,
    });
    const res = applyIngestEnvelope(useStore, envelope);
    expect(res.status).toBe('applied');
    expect(useStore.getState().tasks).toHaveLength(2);
  });

  it('applies a markdown re-import even when the file carries bad id tokens', async () => {
    // Regression: a markdown file with `id:abc` in the legacy pipe format
    // (or `- ID: foo` in the indented metadata format) used to render in
    // the candidate list but be rejected by the bulk validator with
    // "task.add: invalid task id 'abc'". parseDeterministic now drops
    // those ids to null so assignMissingIds issues fresh task-{nanoid}s.
    resetStore();
    const md = `## Project: ReimportTest\n\n- [ ] Task one | id:abc | urg:5 | imp:5 | diff:3\n- [ ] Task two — desc\n    - ID: 1\n    - Urgency: 4`;
    const result = await runProseExtraction(md, { inputShape: 'markdown', llmClient: null });
    expect(result.tasks).toHaveLength(2);
    // flattenSubtasks issues fresh canonical IDs for any null id it sees,
    // so by the time candidates reach the modal each id matches `task-...`.
    for (const t of result.tasks) expect(t.id).toMatch(/^task-/);

    const state = useStore.getState();
    const { envelope } = buildIngestEnvelope(result.tasks, {
      projectName: result.projectName,
      existingProjects: state.projects,
      existingSprints: state.sprints,
      existingTasks: state.tasks,
    });
    const res = applyIngestEnvelope(useStore, envelope);
    expect(res.status).toBe('applied');
    const after = useStore.getState();
    expect(after.tasks.map((t) => t.title).sort()).toEqual(['Task one', 'Task two']);
    for (const t of after.tasks) expect(t.id).toMatch(/^task-/);
  });

  it('rejects an envelope that somehow lacks candidates (defensive check)', () => {
    resetStore();
    // Can't get buildIngestEnvelope to produce this, but if a malformed
    // envelope reaches applyIngestEnvelope, _agentBulkApply gates it.
    const res = applyIngestEnvelope(useStore, {
      opId: 'op-bad',
      type: 'bulk',
      payload: { ops: [] },
    });
    expect(res.status).toBe('rejected');
  });

  it('throws for a store that does not expose _agentBulkApply', () => {
    expect(() => applyIngestEnvelope({ getState: () => ({}) }, { opId: 'x', type: 'bulk', payload: { ops: [] } }))
      .toThrow(/_agentBulkApply/);
  });
});
