import { describe, it, expect } from 'vitest';
import {
  validateEnvelope,
  normalizeOps,
  assignMissingIds,
  topoSortTaskAdds,
  validateBulk,
  checkStaleness,
} from '../validate.js';

const seedState = () => ({
  projects: [{ id: 'proj-a', name: 'Alpha', updatedAt: 1000 }],
  sprints:  [{ id: 'sprint-a1', name: 'A1', projectId: 'proj-a', updatedAt: 1100 }],
  tasks: [
    { id: 'task-1', title: 'T1', sprintId: 'sprint-a1', dependencies: [], status: 'todo', updatedAt: 1200 },
    { id: 'task-2', title: 'T2', sprintId: 'sprint-a1', dependencies: [{ targetId: 'task-1', type: 'hard-blocks' }], status: 'todo', updatedAt: 1300 },
  ],
});

describe('validateEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    const r = validateEnvelope({
      opId: 'op-1', type: 'task.update', payload: { id: 'task-1', patch: {} }, basedOn: 1234,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects non-object envelopes', () => {
    expect(validateEnvelope(null).error.kind).toBe('malformed');
    expect(validateEnvelope([]).error.kind).toBe('malformed');
    expect(validateEnvelope('hi').error.kind).toBe('malformed');
  });

  it('requires opId', () => {
    const r = validateEnvelope({ type: 'task.add', payload: { task: {} } });
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('malformed');
    expect(r.error.message).toMatch(/opId/);
  });

  it('rejects unknown op types with kind=unknown_type', () => {
    const r = validateEnvelope({ opId: 'op-1', type: 'task.frobnicate', payload: {} });
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('unknown_type');
  });

  it('requires payload to be an object', () => {
    const r = validateEnvelope({ opId: 'op-1', type: 'task.update', payload: null });
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('malformed');
  });

  it('rejects basedOn when not a number', () => {
    const r = validateEnvelope({ opId: 'op-1', type: 'task.update', payload: {}, basedOn: 'yesterday' });
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('malformed');
  });
});

describe('normalizeOps', () => {
  it('wraps a single typed op as a one-element list', () => {
    const ops = normalizeOps({ opId: 'x', type: 'task.update', payload: { id: 'task-1', patch: {} } });
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('task.update');
    expect(ops[0].payload.id).toBe('task-1');
  });

  it('flattens a bulk envelope', () => {
    const ops = normalizeOps({
      opId: 'x', type: 'bulk',
      payload: {
        ops: [
          { type: 'project.add', payload: { project: { id: 'proj-x', name: 'X' } } },
          { type: 'sprint.add',  payload: { sprint:  { id: 'sprint-x', projectId: 'proj-x' } } },
        ],
      },
    });
    expect(ops).toHaveLength(2);
    expect(ops[0].type).toBe('project.add');
    expect(ops[1].type).toBe('sprint.add');
  });

  it('returns null for empty bulk', () => {
    expect(normalizeOps({ opId: 'x', type: 'bulk', payload: { ops: [] } })).toBeNull();
  });

  it('returns null for bulk containing non-atomic child', () => {
    expect(normalizeOps({
      opId: 'x', type: 'bulk',
      payload: { ops: [{ type: 'bulk', payload: { ops: [] } }] },
    })).toBeNull();
  });
});

describe('assignMissingIds', () => {
  it('fills in task/sprint/project ids when absent', () => {
    let n = 0;
    const genId = (prefix) => `${prefix}-stub${++n}`;
    const ops = assignMissingIds([
      { type: 'task.add',    payload: { task:    { sprintId: 'sprint-a1' } } },
      { type: 'sprint.add',  payload: { sprint:  { projectId: 'proj-a' } } },
      { type: 'project.add', payload: { project: { name: 'Z' } } },
    ], { genId });
    expect(ops[0].payload.task.id).toBe('task-stub1');
    expect(ops[1].payload.sprint.id).toBe('sprint-stub2');
    expect(ops[2].payload.project.id).toBe('proj-stub3');
  });

  it('preserves explicit ids', () => {
    const genId = () => 'should-not-be-called';
    const ops = assignMissingIds([
      { type: 'task.add', payload: { task: { id: 'task-explicit', sprintId: 'sprint-a1' } } },
    ], { genId });
    expect(ops[0].payload.task.id).toBe('task-explicit');
  });

  it('does not mutate input', () => {
    const input = [{ type: 'task.add', payload: { task: { sprintId: 'sprint-a1' } } }];
    const before = JSON.stringify(input);
    assignMissingIds(input, { genId: () => 'task-x' });
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('topoSortTaskAdds', () => {
  const taskAdd = (id, deps) => ({
    type: 'task.add',
    payload: { task: { id, sprintId: 'sprint-a1', ...(deps ? { dependencies: deps } : {}) } },
  });

  it('returns input unchanged when there are 0 or 1 task.add ops', () => {
    const r0 = topoSortTaskAdds([]);
    expect(r0.ok).toBe(true);
    expect(r0.ops).toEqual([]);

    const ops1 = [taskAdd('task-x')];
    const r1 = topoSortTaskAdds(ops1);
    expect(r1.ok).toBe(true);
    expect(r1.ops).toBe(ops1); // identity — short-circuit
  });

  it('reorders out-of-order intra-bulk task.add deps', () => {
    // task-A (declared first) depends on task-B (declared second).
    // After sort, task-B must come before task-A.
    const ops = [
      taskAdd('task-A', [{ targetId: 'task-B', type: 'hard-blocks' }]),
      taskAdd('task-B'),
    ];
    const r = topoSortTaskAdds(ops);
    expect(r.ok).toBe(true);
    expect(r.ops.map((o) => o.payload.task.id)).toEqual(['task-B', 'task-A']);
  });

  it('handles legacy bare-string deps the same as DepEdge objects', () => {
    const ops = [
      taskAdd('task-A', ['task-B']),
      taskAdd('task-B'),
    ];
    const r = topoSortTaskAdds(ops);
    expect(r.ok).toBe(true);
    expect(r.ops.map((o) => o.payload.task.id)).toEqual(['task-B', 'task-A']);
  });

  it('preserves original order when there are no intra-bulk deps', () => {
    const ops = [taskAdd('task-A'), taskAdd('task-B'), taskAdd('task-C')];
    const r = topoSortTaskAdds(ops);
    expect(r.ok).toBe(true);
    expect(r.ops.map((o) => o.payload.task.id)).toEqual(['task-A', 'task-B', 'task-C']);
  });

  it('preserves the positions of non-task.add ops (sprint.add stays at index 0)', () => {
    const sprintAdd = { type: 'sprint.add', payload: { sprint: { id: 'sprint-z', projectId: 'proj-a' } } };
    const ops = [
      sprintAdd,
      taskAdd('task-A', ['task-B']),
      taskAdd('task-B'),
    ];
    const r = topoSortTaskAdds(ops);
    expect(r.ok).toBe(true);
    expect(r.ops[0]).toBe(sprintAdd);
    expect(r.ops.slice(1).map((o) => o.payload.task.id)).toEqual(['task-B', 'task-A']);
  });

  it('keeps non-task.add slots untouched even when interleaved', () => {
    const sprintAdd = { type: 'sprint.add', payload: { sprint: { id: 'sprint-z', projectId: 'proj-a' } } };
    const taskUpdate = { type: 'task.update', payload: { id: 'task-1', patch: { status: 'done' } } };
    const ops = [
      taskAdd('task-A', ['task-C']),
      sprintAdd,
      taskAdd('task-B'),
      taskUpdate,
      taskAdd('task-C'),
    ];
    const r = topoSortTaskAdds(ops);
    expect(r.ok).toBe(true);
    // sprint.add still at index 1, task.update still at index 3
    expect(r.ops[1]).toBe(sprintAdd);
    expect(r.ops[3]).toBe(taskUpdate);
    // task.add slots (0, 2, 4) get topo-sorted: B, C, A (B has no deps and was original
    // earlier than C, so B first; C has no deps and unblocks A; A last)
    const taskOrder = [r.ops[0], r.ops[2], r.ops[4]].map((o) => o.payload.task.id);
    // Whatever the exact tie-break, A must come AFTER C (its declared dep)
    expect(taskOrder.indexOf('task-A')).toBeGreaterThan(taskOrder.indexOf('task-C'));
  });

  it('detects intra-bulk dependency cycle (A → B → A) with kind=cycle', () => {
    const ops = [
      taskAdd('task-A', ['task-B']),
      taskAdd('task-B', ['task-A']),
    ];
    const r = topoSortTaskAdds(ops);
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('cycle');
  });

  it('ignores self-loops in topo-sort (validateBulk catches them later)', () => {
    // task-A depends on itself. Topo-sort skips the self-edge (no useful order
    // info), so the op passes through; validateBulk's cycle check rejects it.
    const ops = [taskAdd('task-A', ['task-A'])];
    const r = topoSortTaskAdds(ops);
    expect(r.ok).toBe(true);
    expect(r.ops).toBe(ops); // single task.add → identity short-circuit
  });

  it('ignores deps targeting tasks NOT in the bulk', () => {
    // task-A depends on task-1 (existing, not in bulk). No intra-bulk edge.
    const ops = [taskAdd('task-A', ['task-1']), taskAdd('task-B')];
    const r = topoSortTaskAdds(ops);
    expect(r.ok).toBe(true);
    expect(r.ops.map((o) => o.payload.task.id)).toEqual(['task-A', 'task-B']);
  });

  it('treats soft-prefers cycles as a cycle (no valid order possible)', () => {
    // Even though validateBulk's hard-blocks-only cycle check would let a soft
    // cycle stand among existing tasks, two NEW tasks that mutually reference
    // each other have no valid bulk order — declaring both means the second
    // one has to be added first and vice versa.
    const ops = [
      taskAdd('task-A', [{ targetId: 'task-B', type: 'soft-prefers' }]),
      taskAdd('task-B', [{ targetId: 'task-A', type: 'soft-prefers' }]),
    ];
    const r = topoSortTaskAdds(ops);
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('cycle');
  });
});

describe('validateBulk', () => {
  it('happy path: single task.update', () => {
    const r = validateBulk(
      [{ type: 'task.update', payload: { id: 'task-1', patch: { status: 'done' } } }],
      seedState(),
    );
    expect(r.ok).toBe(true);
  });

  it('rejects task.update with missing target as missing_ref', () => {
    const r = validateBulk(
      [{ type: 'task.update', payload: { id: 'task-nope', patch: {} } }],
      seedState(),
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('missing_ref');
    expect(r.error.details.opIndex).toBe(0);
  });

  it('rejects task.update with bad status as validation', () => {
    const r = validateBulk(
      [{ type: 'task.update', payload: { id: 'task-1', patch: { status: 'flerb' } } }],
      seedState(),
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('validation');
  });

  it('rejects task.update with malformed date as validation', () => {
    const r = validateBulk(
      [{ type: 'task.update', payload: { id: 'task-1', patch: { dueDate: 'tomorrow' } } }],
      seedState(),
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('validation');
  });

  it('rejects cycle in task.update.dependencies as cycle', () => {
    // task-1 already has no deps; adding dep on task-2 creates 1→2→1
    const r = validateBulk(
      [{ type: 'task.update', payload: { id: 'task-1', patch: { dependencies: ['task-2'] } } }],
      seedState(),
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('cycle');
  });

  it('rejects task.add with duplicate id as duplicate_id', () => {
    const r = validateBulk(
      [{ type: 'task.add', payload: { task: { id: 'task-1', sprintId: 'sprint-a1' } } }],
      seedState(),
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('duplicate_id');
  });

  it('rejects task.add with missing sprintId ref', () => {
    const r = validateBulk(
      [{ type: 'task.add', payload: { task: { id: 'task-x', sprintId: 'sprint-nope' } } }],
      seedState(),
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('missing_ref');
  });

  it('accepts intra-bulk forward references (task-add → task-add depending on it)', () => {
    const r = validateBulk(
      [
        { type: 'task.add', payload: { task: { id: 'task-x', sprintId: 'sprint-a1' } } },
        { type: 'task.add', payload: { task: { id: 'task-y', sprintId: 'sprint-a1', dependencies: ['task-x'] } } },
      ],
      seedState(),
    );
    expect(r.ok).toBe(true);
  });

  it('rejects intra-bulk cycle', () => {
    const r = validateBulk(
      [
        { type: 'task.add', payload: { task: { id: 'task-x', sprintId: 'sprint-a1', dependencies: ['task-y'] } } },
        { type: 'task.add', payload: { task: { id: 'task-y', sprintId: 'sprint-a1', dependencies: ['task-x'] } } },
      ],
      seedState(),
    );
    // First op fails because task-y doesn't exist yet: missing_ref.
    // Tests the order-dependence of intra-bulk validation.
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('missing_ref');
  });

  it('rejects sprint.add with missing project ref', () => {
    const r = validateBulk(
      [{ type: 'sprint.add', payload: { sprint: { id: 'sprint-x', projectId: 'proj-nope' } } }],
      seedState(),
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('missing_ref');
  });

  it('cascades sprint.delete in shadow so subsequent task.update of dropped task fails', () => {
    const r = validateBulk(
      [
        { type: 'sprint.delete', payload: { id: 'sprint-a1' } },
        { type: 'task.update',   payload: { id: 'task-1', patch: { status: 'done' } } },
      ],
      seedState(),
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('missing_ref');
    expect(r.error.details.opIndex).toBe(1);
  });

  it('cascades project.delete in shadow', () => {
    const r = validateBulk(
      [
        { type: 'project.delete', payload: { id: 'proj-a' } },
        { type: 'task.update',    payload: { id: 'task-2', patch: {} } },
      ],
      seedState(),
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('missing_ref');
  });

  it('rejects malformed task.add (no payload.task)', () => {
    const r = validateBulk(
      [{ type: 'task.add', payload: {} }],
      seedState(),
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('validation');
  });

  it('accepts DepEdge objects in task.add.dependencies', () => {
    const r = validateBulk(
      [{ type: 'task.add', payload: { task: {
        id: 'task-x', sprintId: 'sprint-a1',
        dependencies: [
          { targetId: 'task-1', type: 'hard-blocks' },
          { targetId: 'task-2', type: 'soft-prefers', note: 'if possible' },
        ],
      } } }],
      seedState(),
    );
    expect(r.ok).toBe(true);
  });

  it('rejects unknown edge type in task.add.dependencies', () => {
    const r = validateBulk(
      [{ type: 'task.add', payload: { task: {
        id: 'task-x', sprintId: 'sprint-a1',
        dependencies: [{ targetId: 'task-1', type: 'noodle-blocks' }],
      } } }],
      seedState(),
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('validation');
    expect(r.error.message).toMatch(/noodle-blocks/);
  });

  it('allows a soft-prefers cycle — only hard-blocks edges trigger cycle detection', () => {
    // task-2 hard-blocks task-1 already; adding soft-prefers task-2 → task-1 is fine.
    // Change task-1 to soft-prefers task-2 — that would be a cycle if hard, but soft is OK.
    const r = validateBulk(
      [{ type: 'task.update', payload: { id: 'task-1', patch: {
        dependencies: [{ targetId: 'task-2', type: 'soft-prefers' }],
      } } }],
      seedState(),
    );
    expect(r.ok).toBe(true);
  });

  it('still rejects a hard-blocks cycle even when other edges are soft', () => {
    const r = validateBulk(
      [{ type: 'task.update', payload: { id: 'task-1', patch: {
        dependencies: [{ targetId: 'task-2', type: 'hard-blocks' }],
      } } }],
      seedState(),
    );
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('cycle');
  });

  it('accepts legacy string[] dependencies (backward-compat)', () => {
    const r = validateBulk(
      [{ type: 'task.update', payload: { id: 'task-1', patch: { dependencies: ['task-1'] /* self-dep */ } } }],
      seedState(),
    );
    // task-1 → task-1 is a hard cycle; accepting legacy strings doesn't skip cycle detection.
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('cycle');
  });
});

describe('checkStaleness', () => {
  it('returns false when basedOn is missing', () => {
    expect(checkStaleness(
      [{ type: 'task.update', payload: { id: 'task-1', patch: {} } }],
      seedState(),
      undefined,
    )).toBe(false);
  });

  it('returns true when target task updated after basedOn', () => {
    expect(checkStaleness(
      [{ type: 'task.update', payload: { id: 'task-1', patch: {} } }],
      seedState(),
      1100, // task-1.updatedAt is 1200
    )).toBe(true);
  });

  it('returns false when basedOn equals target updatedAt', () => {
    expect(checkStaleness(
      [{ type: 'task.update', payload: { id: 'task-1', patch: {} } }],
      seedState(),
      1200,
    )).toBe(false);
  });

  it('detects sprint and project staleness', () => {
    expect(checkStaleness(
      [{ type: 'sprint.update', payload: { id: 'sprint-a1', patch: {} } }],
      seedState(), 1099,
    )).toBe(true);
    expect(checkStaleness(
      [{ type: 'project.update', payload: { id: 'proj-a', patch: {} } }],
      seedState(), 999,
    )).toBe(true);
  });

  it('ignores ops with no id (e.g. task.add)', () => {
    expect(checkStaleness(
      [{ type: 'task.add', payload: { task: { sprintId: 'sprint-a1' } } }],
      seedState(), 0,
    )).toBe(false);
  });
});
