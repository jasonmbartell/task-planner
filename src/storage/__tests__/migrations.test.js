import { describe, it, expect } from 'vitest';
import {
  migrateDependencyEdges,
  serializeToFiles,
  deserializeFromFiles,
  CURRENT_SCHEMA_VERSION,
} from '../migrations.js';

describe('migrateDependencyEdges', () => {
  it('rewrites legacy string[] deps into DepEdge[]', () => {
    const tasks = [
      { id: 'task-1', dependencies: ['task-a', 'task-b'] },
      { id: 'task-2', dependencies: [] },
    ];
    migrateDependencyEdges(tasks);
    expect(tasks[0].dependencies).toEqual([
      { targetId: 'task-a', type: 'hard-blocks' },
      { targetId: 'task-b', type: 'hard-blocks' },
    ]);
    expect(tasks[1].dependencies).toEqual([]);
  });

  it('is idempotent on already-migrated data', () => {
    const tasks = [
      { id: 'task-1', dependencies: [{ targetId: 'task-a', type: 'soft-prefers' }] },
    ];
    migrateDependencyEdges(tasks);
    const once = JSON.parse(JSON.stringify(tasks));
    migrateDependencyEdges(tasks);
    expect(tasks).toEqual(once);
  });

  it('handles tasks missing dependencies arrays', () => {
    const tasks = [{ id: 'task-1' }, { id: 'task-2', dependencies: null }];
    migrateDependencyEdges(tasks);
    expect(tasks[0].dependencies).toEqual([]);
    expect(tasks[1].dependencies).toEqual([]);
  });

  it('preserves edge types on mixed inputs', () => {
    const tasks = [
      {
        id: 'task-1',
        dependencies: [
          'task-a',
          { targetId: 'task-b', type: 'soft' },
          { targetId: 'task-c', type: 'preempts', note: 'per spec' },
        ],
      },
    ];
    migrateDependencyEdges(tasks);
    expect(tasks[0].dependencies).toEqual([
      { targetId: 'task-a', type: 'hard-blocks' },
      { targetId: 'task-b', type: 'soft-prefers' },
      { targetId: 'task-c', type: 'preempts', note: 'per spec' },
    ]);
  });

  it('returns non-array input unchanged', () => {
    expect(migrateDependencyEdges(null)).toBeNull();
    expect(migrateDependencyEdges(undefined)).toBeUndefined();
  });
});

describe('serializeToFiles / deserializeFromFiles — typed edges', () => {
  const baseState = () => ({
    projects: [{ id: 'proj-a', name: 'Alpha', color: '#aaa', description: '', updatedAt: 1000 }],
    sprints:  [{ id: 'sprint-a1', name: 'A1', startDate: '2026-04-01', endDate: '', projectId: 'proj-a', updatedAt: 1100 }],
    tasks: [
      { id: 'task-1', title: 'T1', sprintId: 'sprint-a1', dependencies: [], updatedAt: 1200 },
      { id: 'task-2', title: 'T2', sprintId: 'sprint-a1', dependencies: ['task-1'], updatedAt: 1300 },
    ],
  });

  it('meta.json records the current schema version', () => {
    const { projects, sprints, tasks } = baseState();
    const files = serializeToFiles(projects, sprints, tasks, null);
    expect(files['meta.json'].schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('loading v1-shaped files migrates deps to DepEdge[]', () => {
    // Simulate an on-disk file written before milestone 3.5.
    const files = {
      'meta.json': { schemaVersion: 1, projects: [], settings: {}, updatedAt: 0 },
      'project-proj-a.json': {
        id: 'proj-a', name: 'Alpha', color: '#aaa', description: '', updatedAt: 1000,
        sprints: [
          {
            id: 'sprint-a1', name: 'A1', startDate: '2026-04-01', endDate: '', projectId: 'proj-a', updatedAt: 1100,
            tasks: [
              { id: 'task-1', title: 'T1', sprintId: 'sprint-a1', dependencies: [], updatedAt: 1200 },
              { id: 'task-2', title: 'T2', sprintId: 'sprint-a1', dependencies: ['task-1'], updatedAt: 1300 },
            ],
          },
        ],
      },
    };

    const { tasks } = deserializeFromFiles(files);
    const t2 = tasks.find((t) => t.id === 'task-2');
    expect(t2.dependencies).toEqual([{ targetId: 'task-1', type: 'hard-blocks' }]);
  });

  it('round-trips DepEdge[] through serialize → deserialize without data loss', () => {
    const state = baseState();
    state.tasks[1].dependencies = [
      { targetId: 'task-1', type: 'soft-prefers' },
      { targetId: 'task-1', type: 'preempts', note: 'only overnight' },
    ];

    const files = serializeToFiles(state.projects, state.sprints, state.tasks, null);
    const { tasks } = deserializeFromFiles(files);
    const t2 = tasks.find((t) => t.id === 'task-2');
    expect(t2.dependencies).toEqual([
      { targetId: 'task-1', type: 'soft-prefers' },
      { targetId: 'task-1', type: 'preempts', note: 'only overnight' },
    ]);
  });

  it('deserialize is idempotent — running the result back through produces identical state', () => {
    const state = baseState();
    state.tasks[1].dependencies = [{ targetId: 'task-1', type: 'hard-blocks' }];
    // Use compatible dates so neither task triggers backfill.
    state.tasks[0].startDate = '2026-04-01';
    state.tasks[0].endDate = '2026-04-05';
    state.tasks[0].dueDate = '2026-04-05';
    state.tasks[1].startDate = '2026-04-05';
    state.tasks[1].endDate = '2026-04-10';
    state.tasks[1].dueDate = '2026-04-10';

    const files1 = serializeToFiles(state.projects, state.sprints, state.tasks, null);
    const first = deserializeFromFiles(files1);
    const files2 = serializeToFiles(first.projects, first.sprints, first.tasks, null);
    const second = deserializeFromFiles(files2);
    expect(second.tasks).toEqual(first.tasks);
  });

  it('retrofits Rule 3: deserializing data with a dependent that starts before its blocker pushes it forward', () => {
    const state = baseState();
    // task-1 ends 2026-04-15; task-2 hard-blocks on task-1 but starts before that.
    state.tasks[0].startDate = '2026-04-01';
    state.tasks[0].endDate = '2026-04-15';
    state.tasks[0].dueDate = '2026-04-15';
    state.tasks[1].startDate = '2026-04-05';
    state.tasks[1].endDate = '2026-04-10';
    state.tasks[1].dueDate = '2026-04-10';
    state.tasks[1].difficulty = 3;
    state.tasks[1].dependencies = [{ targetId: 'task-1', type: 'hard-blocks' }];

    const files = serializeToFiles(state.projects, state.sprints, state.tasks, null);
    const { tasks } = deserializeFromFiles(files);
    const t2 = tasks.find((t) => t.id === 'task-2');
    expect(t2.startDate).toBe('2026-04-15');
    // Start moved past due → Rule 1 pushes due/end forward by difficulty=3 (1 day).
    expect(t2.endDate).toBe('2026-04-16');
    expect(t2.dueDate).toBe('2026-04-16');
  });
});
