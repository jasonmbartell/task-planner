import { describe, it, expect, vi } from 'vitest';
import {
  buildSnapshot,
  writeSnapshot,
  evaluateSnapshotPair,
  ensureSnapshotIntegrity,
  SNAPSHOT_SCHEMA_VERSION,
} from '../agentSnapshot.js';

const seed = () => ({
  projects: [
    { id: 'proj-a', name: 'Alpha', color: '#f00', description: 'A', updatedAt: 1000 },
    { id: 'proj-b', name: 'Beta',  color: '#0f0', description: 'B', updatedAt: 2000 },
  ],
  sprints: [
    { id: 'sprint-a1', name: 'A-S1', startDate: '2026-04-01', endDate: '', projectId: 'proj-a', updatedAt: 1500 },
    { id: 'sprint-a2', name: 'A-S2', startDate: '2026-04-15', endDate: '', projectId: 'proj-a', updatedAt: 1600 },
    { id: 'sprint-b1', name: 'B-S1', startDate: '2026-04-01', endDate: '', projectId: 'proj-b', updatedAt: 2100 },
    { id: 'sprint-orphan', name: 'Orphan', startDate: '', endDate: '', projectId: 'proj-missing', updatedAt: 9 },
  ],
  tasks: [
    { id: 'task-1', title: 'T1', sprintId: 'sprint-a1', status: 'todo', urgency: 7, importance: 8, difficulty: 3,
      dependencies: [], parentTaskId: null, updatedAt: 1100 },
    { id: 'task-2', title: 'T2', sprintId: 'sprint-a1', status: 'done', urgency: 3, importance: 3, difficulty: 2,
      dependencies: ['task-1'], parentTaskId: null, updatedAt: 1200 },
    { id: 'task-3', title: 'T3', sprintId: 'sprint-b1', status: 'in-progress', urgency: 9, importance: 9, difficulty: 5,
      dependencies: [], parentTaskId: null, updatedAt: 2200 },
    { id: 'task-ghost', title: 'Ghost', sprintId: 'sprint-nope', status: 'todo', urgency: 5, importance: 5, difficulty: 5,
      dependencies: [], parentTaskId: null, updatedAt: 10 },
  ],
});

describe('buildSnapshot', () => {
  it('produces the protocol §3 top-level shape', () => {
    const snap = buildSnapshot(seed(), { exportedAt: 42 });
    expect(snap.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snap.exportedAt).toBe(42);
    expect(Array.isArray(snap.projects)).toBe(true);
    expect(Array.isArray(snap.sprints)).toBe(true);
    expect(Array.isArray(snap.tasks)).toBe(true);
    expect(snap.indexes).toBeDefined();
    expect(snap.indexes.tasksById).toBeDefined();
    expect(snap.indexes.sprintsById).toBeDefined();
    expect(snap.indexes.projectsById).toBeDefined();
    expect(snap.indexes.tasksBySprint).toBeDefined();
    expect(snap.indexes.sprintsByProject).toBeDefined();
  });

  it('projectsById / sprintsById / tasksById map id → array index', () => {
    const snap = buildSnapshot(seed(), { exportedAt: 0 });
    for (const [id, i] of Object.entries(snap.indexes.projectsById)) {
      expect(snap.projects[i].id).toBe(id);
    }
    for (const [id, i] of Object.entries(snap.indexes.sprintsById)) {
      expect(snap.sprints[i].id).toBe(id);
    }
    for (const [id, i] of Object.entries(snap.indexes.tasksById)) {
      expect(snap.tasks[i].id).toBe(id);
    }
  });

  it('sprintsByProject groups sprints under their project', () => {
    const snap = buildSnapshot(seed(), { exportedAt: 0 });
    expect(snap.indexes.sprintsByProject['proj-a']).toEqual(['sprint-a1', 'sprint-a2']);
    expect(snap.indexes.sprintsByProject['proj-b']).toEqual(['sprint-b1']);
    // orphan sprint whose project doesn't exist should not crash and should not invent a bucket
    expect(snap.indexes.sprintsByProject['proj-missing']).toBeUndefined();
  });

  it('tasksBySprint groups tasks under their sprint; ghost tasks are ignored', () => {
    const snap = buildSnapshot(seed(), { exportedAt: 0 });
    expect(snap.indexes.tasksBySprint['sprint-a1']).toEqual(['task-1', 'task-2']);
    expect(snap.indexes.tasksBySprint['sprint-b1']).toEqual(['task-3']);
    // ghost task (sprintId doesn't resolve) still indexed in tasksById but not in tasksBySprint
    expect(snap.indexes.tasksById['task-ghost']).toBe(3);
    expect(snap.indexes.tasksBySprint['sprint-nope']).toBeUndefined();
  });

  it('defaults missing fields without mutating input', () => {
    const state = { projects: [], sprints: [], tasks: [{ id: 'task-x', sprintId: 'sprint-a1' }] };
    const snap = buildSnapshot(state, { exportedAt: 0 });
    const t = snap.tasks[0];
    expect(t.title).toBe('');
    expect(t.urgency).toBe(5);
    expect(t.importance).toBe(5);
    expect(t.difficulty).toBe(3);
    expect(t.dependencies).toEqual([]);
    expect(t.parentTaskId).toBeNull();
    expect(t.status).toBe('todo');
    // input wasn't mutated
    expect(Object.keys(state.tasks[0])).toEqual(['id', 'sprintId']);
  });

  it('JSON round-trip is stable', () => {
    const snap = buildSnapshot(seed(), { exportedAt: 1234 });
    const roundTripped = JSON.parse(JSON.stringify(snap));
    expect(roundTripped).toEqual(snap);
  });

  it('handles an empty state', () => {
    const snap = buildSnapshot({ projects: [], sprints: [], tasks: [] }, { exportedAt: 5 });
    expect(snap.projects).toEqual([]);
    expect(snap.sprints).toEqual([]);
    expect(snap.tasks).toEqual([]);
    expect(snap.indexes.tasksById).toEqual({});
    expect(snap.indexes.sprintsByProject).toEqual({});
  });

  it('normalizes dependency arrays into DepEdge[] without aliasing source data', () => {
    const state = seed();
    const snap = buildSnapshot(state, { exportedAt: 0 });
    const task2 = snap.tasks.find((t) => t.id === 'task-2');
    expect(task2.dependencies).toEqual([{ targetId: 'task-1', type: 'hard-blocks' }]);
    // mutating snapshot deps should not affect source
    task2.dependencies.push({ targetId: 'task-hack', type: 'hard-blocks' });
    expect(state.tasks.find((t) => t.id === 'task-2').dependencies).toEqual(['task-1']);
  });

  it('preserves non-hard edge types and optional note on export', () => {
    const state = {
      projects: [], sprints: [], tasks: [
        { id: 'task-x', title: 'X', sprintId: 's1', dependencies: [
          { targetId: 'task-y', type: 'soft-prefers', note: 'tentative' },
          { targetId: 'task-z', type: 'preempts' },
        ], updatedAt: 0 },
      ],
    };
    const snap = buildSnapshot(state, { exportedAt: 0 });
    expect(snap.tasks[0].dependencies).toEqual([
      { targetId: 'task-y', type: 'soft-prefers', note: 'tentative' },
      { targetId: 'task-z', type: 'preempts' },
    ]);
  });
});

describe('writeSnapshot', () => {
  it('no-ops when adapter has no writeAgentFile', async () => {
    const result = await writeSnapshot({}, seed());
    expect(result).toBeNull();
  });

  it('calls writeAgentFile for snapshot.json and snapshot.meta.json with override path', async () => {
    const calls = [];
    const adapter = {
      writeAgentFile: async (rel, contents, override) => {
        calls.push({ rel, contents, override });
      },
    };
    const snap = await writeSnapshot(adapter, seed(), {
      exportedAt: 99,
      plannerDataPath: '/custom/path',
    });
    expect(snap.exportedAt).toBe(99);
    expect(calls).toHaveLength(2);
    expect(calls[0].rel).toBe('snapshot.json');
    expect(calls[0].override).toBe('/custom/path');
    const parsedSnap = JSON.parse(calls[0].contents);
    expect(parsedSnap.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(parsedSnap.projects).toHaveLength(2);

    expect(calls[1].rel).toBe('snapshot.meta.json');
    const parsedMeta = JSON.parse(calls[1].contents);
    expect(parsedMeta.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(parsedMeta.exportedAt).toBe(99);
  });
});

describe('evaluateSnapshotPair', () => {
  it('returns ok when body parses and meta agrees on exportedAt', () => {
    const snap = buildSnapshot(seed(), { exportedAt: 42 });
    const verdict = evaluateSnapshotPair({
      body: JSON.stringify(snap),
      meta: JSON.stringify({ exportedAt: 42, version: 2, schemaVersion: 2 }),
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('returns missing-body when body is null', () => {
    expect(evaluateSnapshotPair({ body: null, meta: '{}' })).toEqual({
      ok: false, reason: 'missing-body',
    });
  });

  it('returns body-corrupt when body fails JSON.parse (mid-string truncation)', () => {
    const truncated = '{"projects":[{"name":"hello"';
    expect(evaluateSnapshotPair({ body: truncated, meta: null })).toEqual({
      ok: false, reason: 'body-corrupt',
    });
  });

  it('returns exportedAt-mismatch when meta advances past body — the bug shape', () => {
    const snap = buildSnapshot(seed(), { exportedAt: 100 });
    const verdict = evaluateSnapshotPair({
      body: JSON.stringify(snap),
      meta: JSON.stringify({ exportedAt: 200, version: 2, schemaVersion: 2 }),
    });
    expect(verdict).toEqual({ ok: false, reason: 'exportedAt-mismatch' });
  });

  it('returns meta-corrupt when meta is unparseable', () => {
    const snap = buildSnapshot(seed(), { exportedAt: 0 });
    expect(evaluateSnapshotPair({
      body: JSON.stringify(snap),
      meta: 'not json',
    })).toEqual({ ok: false, reason: 'meta-corrupt' });
  });

  it('treats body-only (meta missing) as ok — first launch shape', () => {
    const snap = buildSnapshot(seed(), { exportedAt: 1 });
    expect(evaluateSnapshotPair({
      body: JSON.stringify(snap),
      meta: null,
    })).toEqual({ ok: true });
  });
});

describe('ensureSnapshotIntegrity', () => {
  function makeAdapter({ body = null, meta = null } = {}) {
    const writes = [];
    return {
      writes,
      readSnapshotPair: vi.fn(async () => ({ body, meta })),
      writeAgentFile: vi.fn(async (rel, contents) => { writes.push({ rel, contents }); }),
    };
  }

  it('skips when adapter lacks readSnapshotPair', async () => {
    const result = await ensureSnapshotIntegrity({ writeAgentFile: () => {} }, seed());
    expect(result).toEqual({ status: 'skipped' });
  });

  it('returns ok and does not rewrite when on-disk pair is valid', async () => {
    const snap = buildSnapshot(seed(), { exportedAt: 100 });
    const adapter = makeAdapter({
      body: JSON.stringify(snap),
      meta: JSON.stringify({ exportedAt: 100, version: 2, schemaVersion: 2 }),
    });
    const result = await ensureSnapshotIntegrity(adapter, seed());
    expect(result).toEqual({ status: 'ok' });
    expect(adapter.writes).toHaveLength(0);
  });

  it('rewrites the snapshot when body is corrupt', async () => {
    const adapter = makeAdapter({ body: '{"truncated":', meta: '{"exportedAt":1}' });
    const result = await ensureSnapshotIntegrity(adapter, seed());
    expect(result.status).toBe('rewritten');
    expect(result.reason).toBe('body-corrupt');
    expect(adapter.writes).toHaveLength(2);
    expect(adapter.writes[0].rel).toBe('snapshot.json');
    // The fresh write is parseable.
    expect(() => JSON.parse(adapter.writes[0].contents)).not.toThrow();
  });

  it('rewrites when meta exportedAt has advanced past a corrupt-but-parseable body', async () => {
    // Synthesize the bug shape: body has exportedAt=100 (stale), meta says 200.
    const staleBody = JSON.stringify(buildSnapshot(seed(), { exportedAt: 100 }));
    const adapter = makeAdapter({
      body: staleBody,
      meta: JSON.stringify({ exportedAt: 200, version: 2, schemaVersion: 2 }),
    });
    const result = await ensureSnapshotIntegrity(adapter, seed());
    expect(result.status).toBe('rewritten');
    expect(result.reason).toBe('exportedAt-mismatch');
    expect(adapter.writes).toHaveLength(2);
  });

  it('rewrites when no snapshot.json exists yet (first Tauri launch)', async () => {
    const adapter = makeAdapter({ body: null, meta: null });
    const result = await ensureSnapshotIntegrity(adapter, seed());
    expect(result.status).toBe('rewritten');
    expect(result.reason).toBe('missing-body');
  });

  it('treats readSnapshotPair throws as missing pair and rewrites', async () => {
    const writes = [];
    const adapter = {
      writes,
      readSnapshotPair: vi.fn(async () => { throw new Error('disk read failed'); }),
      writeAgentFile: vi.fn(async (rel, contents) => { writes.push({ rel, contents }); }),
    };
    const result = await ensureSnapshotIntegrity(adapter, seed());
    expect(result.status).toBe('rewritten');
    expect(result.reason).toBe('missing-body');
    expect(adapter.writes).toHaveLength(2);
  });
});
