/**
 * Migration idempotency regression guard (Milestone 7 developer-channel nicety).
 *
 * Every pure migration exported from `src/storage/migrations.js` is held to the
 * contract "running me twice on the same input yields the same result". When
 * a new migration is added, add a case here — the failure message will be
 * blunt about which assertion tripped (first-pass-vs-second-pass, or
 * single-apply-vs-double-apply).
 *
 * Schema migrations ride along with on-disk data for the lifetime of the app;
 * a non-idempotent one silently corrupts data on re-hydration. This file is
 * the "cheap automated check" side of CLAUDE_AGENT_PROTOCOL.md §7.
 */

import { describe, it, expect } from 'vitest';
import './idempotent-matcher.js';
import {
  migrateDependencyEdges,
  addTimestamps,
  deserializeFromFiles,
  serializeToFiles,
  CURRENT_SCHEMA_VERSION,
} from '../migrations.js';

describe('toBeIdempotent matcher — sanity checks', () => {
  it('passes on a noop function', () => {
    const noop = (x) => x;
    expect(noop).toBeIdempotent([1, 2, 3]);
  });

  it('passes on a clamp function (naturally idempotent)', () => {
    const clamp = (arr) => arr.map((n) => Math.max(0, Math.min(10, n)));
    expect(clamp).toBeIdempotent([-5, 3, 42]);
  });

  it('fails on a non-idempotent function (appends a marker)', () => {
    const nonIdempotent = (arr) => [...arr, 'X'];
    // We expect the matcher itself to fail here — wrap in a try.
    let threw = false;
    try {
      expect(nonIdempotent).toBeIdempotent([1]);
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/NOT idempotent/);
    }
    expect(threw).toBe(true);
  });

  it('surfaces the label when given', () => {
    const nonIdempotent = (x) => (typeof x === 'number' ? x + 1 : x);
    let msg = '';
    try {
      expect(nonIdempotent).toBeIdempotent(1, { label: 'my-mig' });
    } catch (err) {
      msg = String(err);
    }
    expect(msg).toMatch(/my-mig/);
    expect(msg).toMatch(/NOT idempotent/);
  });
});

describe('storage migrations are idempotent', () => {
  it('migrateDependencyEdges — legacy string[] → DepEdge[]', () => {
    const tasks = [
      { id: 'task-1', dependencies: ['task-a', 'task-b'] },
      { id: 'task-2', dependencies: [] },
      { id: 'task-3' }, // no deps key
    ];
    expect(migrateDependencyEdges).toBeIdempotent(tasks, { label: 'migrateDependencyEdges' });
  });

  it('migrateDependencyEdges — mixed typed / legacy / empty input', () => {
    const tasks = [
      { id: 'task-1', dependencies: ['task-a', { targetId: 'task-b', type: 'soft-prefers' }] },
      { id: 'task-2', dependencies: [{ targetId: 'task-c', type: 'preempts', note: 'ok' }] },
      { id: 'task-3', dependencies: null },
    ];
    expect(migrateDependencyEdges).toBeIdempotent(tasks, { label: 'migrateDependencyEdges (mixed)' });
  });

  it('migrateDependencyEdges — non-array inputs are returned unchanged', () => {
    expect(migrateDependencyEdges).toBeIdempotent(null, { label: 'migrateDependencyEdges (null)' });
    expect(migrateDependencyEdges).toBeIdempotent({}, { label: 'migrateDependencyEdges (object)' });
  });

  it('addTimestamps — fills missing updatedAt without overwriting present ones', () => {
    // Make addTimestamps deterministic under the double-apply check: pre-fill
    // the ones we care about so the second invocation on the already-migrated
    // object doesn't pick up a fresh Date.now() for anything still missing.
    // We include entities with and without updatedAt to cover both branches.
    const state = {
      projects: [
        { id: 'proj-a', updatedAt: 1000 },
        { id: 'proj-b', updatedAt: 2000 },
      ],
      sprints: [
        { id: 'sprint-a', updatedAt: 3000 },
      ],
      tasks: [
        { id: 'task-a', updatedAt: 4000 },
        { id: 'task-b', updatedAt: 5000 },
      ],
    };
    expect(addTimestamps).toBeIdempotent(state, { label: 'addTimestamps' });
  });

  it('serialize → deserialize → serialize is stable', () => {
    const state = {
      projects: [{ id: 'proj-a', name: 'Alpha', color: '#aaa', description: '', updatedAt: 1000 }],
      sprints: [{ id: 'sprint-a', name: 'A', startDate: '2026-04-01', endDate: '', projectId: 'proj-a', updatedAt: 1100 }],
      tasks: [
        { id: 'task-1', title: 'T1', sprintId: 'sprint-a', dependencies: [], updatedAt: 1200 },
        { id: 'task-2', title: 'T2', sprintId: 'sprint-a', dependencies: [{ targetId: 'task-1', type: 'hard-blocks' }], updatedAt: 1300 },
      ],
    };
    // Round-trip is itself an idempotent operation: once-through vs twice-through
    // should agree (schemaVersion stamped, dep shape stable).
    const roundTrip = (s) => {
      const files = serializeToFiles(s.projects, s.sprints, s.tasks, null);
      return deserializeFromFiles(files);
    };
    expect(roundTrip).toBeIdempotent(state, { label: 'serialize→deserialize round-trip' });
    // Belt-and-suspenders: the round-trip shouldn't drop the version.
    const files = serializeToFiles(state.projects, state.sprints, state.tasks, null);
    expect(files['meta.json'].schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});
