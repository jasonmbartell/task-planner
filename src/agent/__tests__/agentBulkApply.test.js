/**
 * Integration test for the store's `_agentBulkApply` action — the orchestrator
 * that ties validate + trustMatrix + apply together with one _pushHistory
 * checkpoint per envelope.
 *
 * Uses the real Zustand store (not a mock) so we exercise the full set()
 * + history path. Each test resets the store via direct setState.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import useStore from '../../store/useStore.js';

function resetStore({ projects = [], sprints = [], tasks = [], obsidianConfig = {} } = {}) {
  // Don't spread the existing config — that lets state from one test leak
  // into the next (e.g. `agentTrust` overrides). Build fresh each time.
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

const seed = () => ({
  projects: [{ id: 'proj-a', name: 'Alpha', color: '#abc', description: '', updatedAt: 1000 }],
  sprints:  [{ id: 'sprint-a1', name: 'A1', startDate: '2026-04-01', endDate: '', projectId: 'proj-a', updatedAt: 1100 }],
  tasks: [
    { id: 'task-1', title: 'T1', description: '', startDate: '', endDate: '', dueDate: '',
      dependencies: [], urgency: 5, importance: 5, difficulty: 3, sprintId: 'sprint-a1',
      status: 'todo', parentTaskId: null, updatedAt: 1200 },
    { id: 'task-2', title: 'T2', description: '', startDate: '', endDate: '', dueDate: '',
      dependencies: [{ targetId: 'task-1', type: 'hard-blocks' }], urgency: 5, importance: 5, difficulty: 3, sprintId: 'sprint-a1',
      status: 'todo', parentTaskId: null, updatedAt: 1300 },
  ],
});

describe('_agentBulkApply', () => {
  beforeEach(() => {
    resetStore(seed());
  });

  it('applied: single task.update mutates the store', () => {
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-1', type: 'task.update',
      payload: { id: 'task-1', patch: { status: 'done' } },
    });
    expect(result.status).toBe('applied');
    expect(result.diff.tasks.updated[0].after.status).toBe('done');
    expect(useStore.getState().tasks.find((t) => t.id === 'task-1').status).toBe('done');
  });

  it('applied: bulk envelope creates one undo checkpoint', () => {
    const before = useStore.getState()._past.length;
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-bulk', type: 'bulk',
      payload: {
        ops: [
          { type: 'task.update', payload: { id: 'task-1', patch: { status: 'done' } } },
          { type: 'task.update', payload: { id: 'task-2', patch: { status: 'in-progress' } } },
        ],
      },
    });
    expect(result.status).toBe('applied');
    // Exactly one history checkpoint pushed for the entire bulk
    expect(useStore.getState()._past.length).toBe(before + 1);
    expect(useStore.getState().tasks.find((t) => t.id === 'task-1').status).toBe('done');
    expect(useStore.getState().tasks.find((t) => t.id === 'task-2').status).toBe('in-progress');
  });

  it('applied: bulk add of project + sprint + task with intra-bulk refs', () => {
    resetStore({ projects: [], sprints: [], tasks: [] });
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-2', type: 'bulk',
      payload: {
        ops: [
          { type: 'project.add', payload: { project: { id: 'proj-z', name: 'Z' } } },
          { type: 'sprint.add',  payload: { sprint:  { id: 'sprint-z', projectId: 'proj-z' } } },
          { type: 'task.add',    payload: { task:    { id: 'task-z',  sprintId: 'sprint-z', urgency: 9 } } },
        ],
      },
    });
    expect(result.status).toBe('applied');
    const s = useStore.getState();
    expect(s.projects).toHaveLength(1);
    expect(s.sprints).toHaveLength(1);
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0].urgency).toBe(9);
  });

  it('rejected: cycle in task.update.dependencies', () => {
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-3', type: 'task.update',
      payload: { id: 'task-1', patch: { dependencies: ['task-2'] } },
    });
    expect(result.status).toBe('rejected');
    expect(result.error.kind).toBe('cycle');
    // Store untouched
    expect(useStore.getState().tasks.find((t) => t.id === 'task-1').dependencies).toEqual([]);
  });

  it('rejected: missing_ref propagates from validateBulk', () => {
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-4', type: 'task.update',
      payload: { id: 'task-nope', patch: {} },
    });
    expect(result.status).toBe('rejected');
    expect(result.error.kind).toBe('missing_ref');
  });

  it('rejected: validation failure aborts and does not push history', () => {
    const before = useStore.getState()._past.length;
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-5', type: 'task.update',
      payload: { id: 'task-1', patch: { dueDate: 'tomorrow' } },
    });
    expect(result.status).toBe('rejected');
    expect(result.error.kind).toBe('validation');
    expect(useStore.getState()._past.length).toBe(before);
  });

  it('rejected: malformed envelope returns kind=malformed without touching state', () => {
    const before = JSON.stringify(useStore.getState().tasks);
    const result = useStore.getState()._agentBulkApply({ type: 'task.update', payload: { id: 'task-1', patch: {} } });
    expect(result.status).toBe('rejected');
    expect(result.error.kind).toBe('malformed');
    expect(JSON.stringify(useStore.getState().tasks)).toBe(before);
  });

  it('rejected: unknown_type', () => {
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-7', type: 'task.frobnicate', payload: {},
    });
    expect(result.status).toBe('rejected');
    expect(result.error.kind).toBe('unknown_type');
  });

  it('queued: task.delete defaults to queue', () => {
    const before = JSON.stringify(useStore.getState().tasks);
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-8', type: 'task.delete',
      payload: { id: 'task-2' },
    });
    expect(result.status).toBe('queued');
    expect(result.reason).toBe('trust');
    // Store untouched — queue means human decides later
    expect(JSON.stringify(useStore.getState().tasks)).toBe(before);
  });

  it('queued: bulk containing a task.delete queues the whole bulk', () => {
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-9', type: 'bulk',
      payload: {
        ops: [
          { type: 'task.update', payload: { id: 'task-1', patch: { status: 'done' } } },
          { type: 'task.delete', payload: { id: 'task-2' } },
        ],
      },
    });
    expect(result.status).toBe('queued');
    // Neither op applied
    expect(useStore.getState().tasks.find((t) => t.id === 'task-1').status).toBe('todo');
    expect(useStore.getState().tasks.find((t) => t.id === 'task-2')).toBeDefined();
  });

  it('queued: stale envelope (basedOn < target.updatedAt)', () => {
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-10', type: 'task.update', basedOn: 1000, // task-1.updatedAt is 1200
      payload: { id: 'task-1', patch: { status: 'done' } },
    });
    expect(result.status).toBe('queued');
    expect(result.reason).toBe('stale');
  });

  it('forceApply bypasses trust and stale gates but not validation', () => {
    // Trust bypass: deletes a task even though it would normally queue.
    const r1 = useStore.getState()._agentBulkApply(
      { opId: 'op-f1', type: 'task.delete', payload: { id: 'task-2' } },
      { forceApply: true },
    );
    expect(r1.status).toBe('applied');
    expect(useStore.getState().tasks.find((t) => t.id === 'task-2')).toBeUndefined();

    // Validation NOT bypassed:
    const r2 = useStore.getState()._agentBulkApply(
      { opId: 'op-f2', type: 'task.update', payload: { id: 'task-nope', patch: {} } },
      { forceApply: true },
    );
    expect(r2.status).toBe('rejected');
    expect(r2.error.kind).toBe('missing_ref');
  });

  it('honors obsidianConfig.agentTrust override', () => {
    resetStore({ ...seed(), obsidianConfig: { agentTrust: { 'task.update': 'queue' } } });
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-12', type: 'task.update',
      payload: { id: 'task-1', patch: { status: 'done' } },
    });
    expect(result.status).toBe('queued');
    expect(result.reason).toBe('trust');
  });

  it('undo restores the pre-apply snapshot', () => {
    useStore.getState()._agentBulkApply({
      opId: 'op-undo', type: 'task.update',
      payload: { id: 'task-1', patch: { status: 'done' } },
    });
    expect(useStore.getState().tasks.find((t) => t.id === 'task-1').status).toBe('done');
    useStore.getState().undo();
    expect(useStore.getState().tasks.find((t) => t.id === 'task-1').status).toBe('todo');
  });

  it('applied: bulk task.adds in arbitrary order with intra-bulk deps (topo-sort)', () => {
    // task-A (declared first) depends on task-B (declared second). Without the
    // topo-sort in _agentBulkApply this would reject with missing_ref.
    resetStore({ projects: [], sprints: [], tasks: [] });
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-topo', type: 'bulk',
      payload: {
        ops: [
          { type: 'project.add', payload: { project: { id: 'proj-z', name: 'Z' } } },
          { type: 'sprint.add',  payload: { sprint:  { id: 'sprint-z', projectId: 'proj-z' } } },
          { type: 'task.add', payload: { task: {
            id: 'task-A', sprintId: 'sprint-z', urgency: 1, importance: 1, difficulty: 1,
            dependencies: [{ targetId: 'task-B', type: 'hard-blocks' }],
          } } },
          { type: 'task.add', payload: { task: {
            id: 'task-B', sprintId: 'sprint-z', urgency: 1, importance: 1, difficulty: 1,
          } } },
        ],
      },
    });
    expect(result.status).toBe('applied');
    const tasks = useStore.getState().tasks;
    expect(tasks).toHaveLength(2);
    const a = tasks.find((t) => t.id === 'task-A');
    expect(a.dependencies).toEqual([{ targetId: 'task-B', type: 'hard-blocks' }]);
    // The diff exposes the order applyOps actually used: B before A.
    expect(result.diff.tasks.added.map((t) => t.id)).toEqual(['task-B', 'task-A']);
  });

  it('rejected: intra-bulk task.add cycle is reported as kind=cycle (not missing_ref)', () => {
    resetStore({ projects: [], sprints: [], tasks: [] });
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-cycle', type: 'bulk',
      payload: {
        ops: [
          { type: 'project.add', payload: { project: { id: 'proj-z', name: 'Z' } } },
          { type: 'sprint.add',  payload: { sprint:  { id: 'sprint-z', projectId: 'proj-z' } } },
          { type: 'task.add', payload: { task: {
            id: 'task-A', sprintId: 'sprint-z', urgency: 1, importance: 1, difficulty: 1,
            dependencies: [{ targetId: 'task-B', type: 'hard-blocks' }],
          } } },
          { type: 'task.add', payload: { task: {
            id: 'task-B', sprintId: 'sprint-z', urgency: 1, importance: 1, difficulty: 1,
            dependencies: [{ targetId: 'task-A', type: 'hard-blocks' }],
          } } },
        ],
      },
    });
    expect(result.status).toBe('rejected');
    expect(result.error.kind).toBe('cycle');
  });

  it('assigns ids for adds without explicit id and exposes them in the diff', () => {
    resetStore({ projects: [], sprints: [], tasks: [] });
    const result = useStore.getState()._agentBulkApply({
      opId: 'op-ids', type: 'bulk',
      payload: {
        ops: [
          { type: 'project.add', payload: { project: { name: 'P' } } },
          { type: 'sprint.add',  payload: { sprint:  { name: 'S', projectId: '__forward__' } } },
        ],
      },
    });
    // The forward ref `__forward__` doesn't exist → expect rejection (proves we use real ids in validation).
    expect(result.status).toBe('rejected');
    expect(result.error.kind).toBe('missing_ref');

    // Without the bad forward ref, generated ids should flow into the diff.
    resetStore({ projects: [], sprints: [], tasks: [] });
    const r2 = useStore.getState()._agentBulkApply({
      opId: 'op-ids-2', type: 'project.add',
      payload: { project: { name: 'New' } },
    });
    expect(r2.status).toBe('applied');
    expect(r2.diff.projects.added[0].id).toMatch(/^proj-/);
    expect(useStore.getState().projects[0].id).toBe(r2.diff.projects.added[0].id);
  });
});
