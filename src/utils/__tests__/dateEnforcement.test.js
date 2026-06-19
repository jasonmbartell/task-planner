import { describe, it, expect } from 'vitest';
import {
  enforceTaskDates,
  enforceBlockerConstraint,
  backfillBlockerConstraints,
  cascadeDateChanges,
  getDurationDays,
  DIFFICULTY_TO_DAYS,
} from '../dateEnforcement.js';

const mkTask = (over = {}) => ({
  id: 't1',
  title: 'Task',
  startDate: '2026-05-01',
  endDate: '2026-05-05',
  dueDate: '2026-05-07',
  difficulty: 3, // 1 day
  dependencies: [],
  ...over,
});

describe('getDurationDays', () => {
  it('matches the user rubric', () => {
    expect(DIFFICULTY_TO_DAYS[1]).toBe(0); // 1 hour
    expect(DIFFICULTY_TO_DAYS[2]).toBe(0); // 1/2 day
    expect(DIFFICULTY_TO_DAYS[3]).toBe(1); // 1 day
    expect(DIFFICULTY_TO_DAYS[4]).toBe(7); // 1 week
    expect(DIFFICULTY_TO_DAYS[5]).toBe(30); // 1 month
  });

  it('falls back to 1 day when difficulty is missing or invalid', () => {
    expect(getDurationDays(undefined)).toBe(1);
    expect(getDurationDays(null)).toBe(1);
    expect(getDurationDays(0)).toBe(1);
    expect(getDurationDays('foo')).toBe(1);
  });
});

describe('enforceTaskDates — Rule 1 (start past due)', () => {
  it('matches the user-provided example: start=May 10, difficulty 3 → end=due=May 11', () => {
    const out = enforceTaskDates(mkTask({ startDate: '2026-05-10' }));
    expect(out.startDate).toBe('2026-05-10');
    expect(out.endDate).toBe('2026-05-11');
    expect(out.dueDate).toBe('2026-05-11');
  });

  it('zero-duration (difficulty 1): start past due collapses to a single day', () => {
    const out = enforceTaskDates(
      mkTask({ startDate: '2026-05-10', difficulty: 1 }),
    );
    expect(out.startDate).toBe('2026-05-10');
    expect(out.endDate).toBe('2026-05-10');
    expect(out.dueDate).toBe('2026-05-10');
  });

  it('week-long (difficulty 4): start past due pushes end+due 7 days forward', () => {
    const out = enforceTaskDates(
      mkTask({ startDate: '2026-05-10', difficulty: 4 }),
    );
    expect(out.endDate).toBe('2026-05-17');
    expect(out.dueDate).toBe('2026-05-17');
  });
});

describe('enforceTaskDates — Rule 2 (end always equals due)', () => {
  it('snaps endDate to dueDate even when start is comfortably before due', () => {
    const out = enforceTaskDates(mkTask({ endDate: '2026-05-05', dueDate: '2026-05-07' }));
    expect(out.endDate).toBe('2026-05-07');
    expect(out.dueDate).toBe('2026-05-07');
    expect(out.startDate).toBe('2026-05-01'); // unchanged
  });

  it('derives dueDate (and endDate) from startDate + duration when due is missing', () => {
    const out = enforceTaskDates(
      mkTask({ startDate: '2026-05-01', endDate: '', dueDate: '', difficulty: 4 }),
    );
    expect(out.dueDate).toBe('2026-05-08');
    expect(out.endDate).toBe('2026-05-08');
  });

  it('returns the input reference when no rule fires', () => {
    const t = mkTask({ startDate: '2026-05-01', endDate: '2026-05-07', dueDate: '2026-05-07' });
    expect(enforceTaskDates(t)).toBe(t);
  });

  it('leaves the task alone when startDate is missing (nothing to anchor on)', () => {
    const t = mkTask({ startDate: '', endDate: '2026-05-05', dueDate: '2026-05-07' });
    expect(enforceTaskDates(t)).toBe(t);
  });
});

describe('enforceBlockerConstraint — Rule 3 (start respects hard-blocks predecessors)', () => {
  const blockerMap = (...tasks) => new Map(tasks.map((t) => [t.id, t]));

  it('pushes start forward to the blocker endDate and re-applies rules 1–2', () => {
    const a = { id: 'a', startDate: '2026-05-01', endDate: '2026-05-15', dueDate: '2026-05-15' };
    const b = mkTask({
      id: 'b',
      startDate: '2026-05-05',
      endDate: '2026-05-07',
      dueDate: '2026-05-07',
      difficulty: 3, // 1 day
      dependencies: [{ targetId: 'a', type: 'hard-blocks' }],
    });
    const out = enforceBlockerConstraint(b, blockerMap(a));
    expect(out.startDate).toBe('2026-05-15');
    // Start moved past due → Rule 1 pushes due+end forward by 1 day.
    expect(out.endDate).toBe('2026-05-16');
    expect(out.dueDate).toBe('2026-05-16');
  });

  it('takes the max endDate across multiple hard-blocks predecessors', () => {
    const a = { id: 'a', startDate: '2026-05-01', endDate: '2026-05-10', dueDate: '2026-05-10' };
    const c = { id: 'c', startDate: '2026-05-01', endDate: '2026-05-20', dueDate: '2026-05-20' };
    const b = mkTask({
      id: 'b',
      startDate: '2026-05-02',
      endDate: '2026-05-04',
      dueDate: '2026-05-04',
      difficulty: 3,
      dependencies: [
        { targetId: 'a', type: 'hard-blocks' },
        { targetId: 'c', type: 'hard-blocks' },
      ],
    });
    const out = enforceBlockerConstraint(b, blockerMap(a, c));
    expect(out.startDate).toBe('2026-05-20');
  });

  it('ignores soft / preempts / deadline-independent edges', () => {
    const a = { id: 'a', startDate: '2026-05-01', endDate: '2026-05-15', dueDate: '2026-05-15' };
    const b = mkTask({
      id: 'b',
      startDate: '2026-05-05',
      dependencies: [{ targetId: 'a', type: 'soft-prefers' }],
    });
    const out = enforceBlockerConstraint(b, blockerMap(a));
    expect(out).toBe(b);
  });

  it('returns the input reference when start is already after all blockers', () => {
    const a = { id: 'a', startDate: '2026-05-01', endDate: '2026-05-05', dueDate: '2026-05-05' };
    const b = mkTask({
      id: 'b',
      startDate: '2026-05-10',
      dependencies: [{ targetId: 'a', type: 'hard-blocks' }],
    });
    expect(enforceBlockerConstraint(b, blockerMap(a))).toBe(b);
  });

  it('treats legacy bare-string deps as hard-blocks', () => {
    const a = { id: 'a', startDate: '2026-05-01', endDate: '2026-05-15', dueDate: '2026-05-15' };
    const b = mkTask({
      id: 'b',
      startDate: '2026-05-05',
      endDate: '2026-05-07',
      dueDate: '2026-05-07',
      difficulty: 3,
      dependencies: ['a'],
    });
    const out = enforceBlockerConstraint(b, blockerMap(a));
    expect(out.startDate).toBe('2026-05-15');
  });

  it('skips blockers with missing or malformed endDate', () => {
    const a = { id: 'a', startDate: '2026-05-01', endDate: '', dueDate: '' };
    const b = mkTask({
      id: 'b',
      startDate: '2026-05-05',
      dependencies: [{ targetId: 'a', type: 'hard-blocks' }],
    });
    expect(enforceBlockerConstraint(b, blockerMap(a))).toBe(b);
  });

  it('accepts a plain object id-map in place of a Map', () => {
    const a = { id: 'a', startDate: '2026-05-01', endDate: '2026-05-15', dueDate: '2026-05-15' };
    const b = mkTask({
      id: 'b',
      startDate: '2026-05-05',
      endDate: '2026-05-07',
      dueDate: '2026-05-07',
      difficulty: 3,
      dependencies: [{ targetId: 'a', type: 'hard-blocks' }],
    });
    const out = enforceBlockerConstraint(b, { a });
    expect(out.startDate).toBe('2026-05-15');
  });
});

describe('cascadeDateChanges', () => {
  it('pushes a hard-blocks dependent forward when the blocker ends later', () => {
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-15', dueDate: '2026-05-15', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-05', endDate: '2026-05-07', dueDate: '2026-05-07', difficulty: 3,
        dependencies: [{ targetId: 'a', type: 'hard-blocks' }] },
    ];
    const out = cascadeDateChanges(tasks, ['a'], { now: 1 });
    const b = out.find((t) => t.id === 'b');
    expect(b.startDate).toBe('2026-05-15');
    expect(b.endDate).toBe('2026-05-16'); // 15 + 1 day duration
    expect(b.dueDate).toBe('2026-05-16'); // Rule 2 collapses end+due
    expect(b.updatedAt).toBe(1);
  });

  it('cascades transitively through chains a → b → c', () => {
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-20', dueDate: '2026-05-20', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-05', endDate: '2026-05-07', dueDate: '2026-05-07', difficulty: 3,
        dependencies: [{ targetId: 'a', type: 'hard-blocks' }] },
      { id: 'c', startDate: '2026-05-08', endDate: '2026-05-10', dueDate: '2026-05-10', difficulty: 3,
        dependencies: [{ targetId: 'b', type: 'hard-blocks' }] },
    ];
    const out = cascadeDateChanges(tasks, ['a'], { now: 1 });
    const b = out.find((t) => t.id === 'b');
    const c = out.find((t) => t.id === 'c');
    expect(b.startDate).toBe('2026-05-20');
    expect(b.endDate).toBe('2026-05-21');
    expect(c.startDate).toBe('2026-05-21');
    expect(c.endDate).toBe('2026-05-22');
  });

  it('ignores soft-prefers and other non-hard edges', () => {
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-15', dueDate: '2026-05-15', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-05', endDate: '2026-05-07', dueDate: '2026-05-07', difficulty: 3,
        dependencies: [{ targetId: 'a', type: 'soft-prefers' }] },
    ];
    const out = cascadeDateChanges(tasks, ['a'], { now: 1 });
    expect(out).toBe(tasks); // unchanged reference
  });

  it('does nothing when the dependent already starts on or after the blocker ends', () => {
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-05', dueDate: '2026-05-05', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-10', endDate: '2026-05-12', dueDate: '2026-05-12', difficulty: 3,
        dependencies: [{ targetId: 'a', type: 'hard-blocks' }] },
    ];
    const out = cascadeDateChanges(tasks, ['a'], { now: 1 });
    expect(out).toBe(tasks);
  });

  it('treats legacy bare-string dependencies as hard-blocks edges', () => {
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-15', dueDate: '2026-05-15', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-05', endDate: '2026-05-07', dueDate: '2026-05-07', difficulty: 3,
        dependencies: ['a'] },
    ];
    const out = cascadeDateChanges(tasks, ['a'], { now: 1 });
    const b = out.find((t) => t.id === 'b');
    expect(b.startDate).toBe('2026-05-15');
  });
});

describe('cascadeDateChanges — backward (endDate moved earlier)', () => {
  it('shifts a tight hard-blocks dependent earlier by the same delta', () => {
    // a was May 1-10. a moved to May 1-5 (delta -5). b was tight at May 10-12.
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-05', dueDate: '2026-05-05', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-10', endDate: '2026-05-12', dueDate: '2026-05-12', difficulty: 3,
        dependencies: [{ targetId: 'a', type: 'hard-blocks' }] },
    ];
    const out = cascadeDateChanges(tasks, ['a'], { now: 1, dayDelta: -5 });
    const b = out.find((t) => t.id === 'b');
    expect(b.startDate).toBe('2026-05-05');
    expect(b.endDate).toBe('2026-05-07');
    expect(b.dueDate).toBe('2026-05-07');
    expect(b.updatedAt).toBe(1);
  });

  it('preserves the gap between blocker and dependent when shifting earlier', () => {
    // a was May 1-10, b had a 5-day gap at May 15-17. a moved to May 1-5 (-5).
    // b should shift to May 10-12 — gap preserved at 5 days.
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-05', dueDate: '2026-05-05', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-15', endDate: '2026-05-17', dueDate: '2026-05-17', difficulty: 3,
        dependencies: [{ targetId: 'a', type: 'hard-blocks' }] },
    ];
    const out = cascadeDateChanges(tasks, ['a'], { now: 1, dayDelta: -5 });
    const b = out.find((t) => t.id === 'b');
    expect(b.startDate).toBe('2026-05-10');
    expect(b.endDate).toBe('2026-05-12');
  });

  it('cascades transitively through chains a → b → c', () => {
    // a moved -5: was May 1-10, now May 1-5. b was May 11-13. c was May 14-16.
    // Expected: b → May 6-8, c → May 9-11.
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-05', dueDate: '2026-05-05', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-11', endDate: '2026-05-13', dueDate: '2026-05-13', difficulty: 3,
        dependencies: [{ targetId: 'a', type: 'hard-blocks' }] },
      { id: 'c', startDate: '2026-05-14', endDate: '2026-05-16', dueDate: '2026-05-16', difficulty: 3,
        dependencies: [{ targetId: 'b', type: 'hard-blocks' }] },
    ];
    const out = cascadeDateChanges(tasks, ['a'], { now: 1, dayDelta: -5 });
    const b = out.find((t) => t.id === 'b');
    const c = out.find((t) => t.id === 'c');
    expect(b.startDate).toBe('2026-05-06');
    expect(b.endDate).toBe('2026-05-08');
    expect(c.startDate).toBe('2026-05-09');
    expect(c.endDate).toBe('2026-05-11');
  });

  it("floors the dependent at another hard-blocks predecessor's endDate", () => {
    // a (moved from May 15 → May 5, delta -10) and c (fixed end May 12) both block b.
    // b was May 20-22. Naively b → May 10-12, but c.endDate=May 12 floors start to May 12.
    // So b shifts by only -8 → May 12-14.
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-05', dueDate: '2026-05-05', difficulty: 3, dependencies: [] },
      { id: 'c', startDate: '2026-05-10', endDate: '2026-05-12', dueDate: '2026-05-12', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-20', endDate: '2026-05-22', dueDate: '2026-05-22', difficulty: 3,
        dependencies: [
          { targetId: 'a', type: 'hard-blocks' },
          { targetId: 'c', type: 'hard-blocks' },
        ] },
    ];
    const out = cascadeDateChanges(tasks, ['a'], { now: 1, dayDelta: -10 });
    const b = out.find((t) => t.id === 'b');
    expect(b.startDate).toBe('2026-05-12');
    expect(b.endDate).toBe('2026-05-14');
  });

  it('does not move a dependent when another predecessor would push it later', () => {
    // a moved earlier (-5), but c.endDate (May 25) is already past b.startDate (May 20).
    // We never push later in a backward cascade — leave b alone.
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-05', dueDate: '2026-05-05', difficulty: 3, dependencies: [] },
      { id: 'c', startDate: '2026-05-22', endDate: '2026-05-25', dueDate: '2026-05-25', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-20', endDate: '2026-05-22', dueDate: '2026-05-22', difficulty: 3,
        dependencies: [
          { targetId: 'a', type: 'hard-blocks' },
          { targetId: 'c', type: 'hard-blocks' },
        ] },
    ];
    const out = cascadeDateChanges(tasks, ['a'], { now: 1, dayDelta: -5 });
    expect(out).toBe(tasks);
  });

  it('ignores soft-prefers and other non-hard edges', () => {
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-05', dueDate: '2026-05-05', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-15', endDate: '2026-05-17', dueDate: '2026-05-17', difficulty: 3,
        dependencies: [{ targetId: 'a', type: 'soft-prefers' }] },
    ];
    const out = cascadeDateChanges(tasks, ['a'], { now: 1, dayDelta: -5 });
    expect(out).toBe(tasks);
  });

  it('treats legacy bare-string dependencies as hard-blocks edges', () => {
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-05', dueDate: '2026-05-05', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-15', endDate: '2026-05-17', dueDate: '2026-05-17', difficulty: 3,
        dependencies: ['a'] },
    ];
    const out = cascadeDateChanges(tasks, ['a'], { now: 1, dayDelta: -5 });
    const b = out.find((t) => t.id === 'b');
    expect(b.startDate).toBe('2026-05-10');
    expect(b.endDate).toBe('2026-05-12');
  });
});

describe('backfillBlockerConstraints (hydration retrofit)', () => {
  it('pushes a violating dependent forward to its blocker endDate', () => {
    // Mirrors the real-world example: dependent starts before its blockers end.
    const tasks = [
      { id: 'a', startDate: '2026-05-14', endDate: '2026-05-15', dueDate: '2026-05-15', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-18', endDate: '2026-05-19', dueDate: '2026-05-19', difficulty: 3, dependencies: [] },
      { id: 'c', startDate: '2026-05-20', endDate: '2026-05-20', dueDate: '2026-05-20', difficulty: 1, dependencies: [] },
      { id: 'm', startDate: '2026-05-06', endDate: '2026-06-01', dueDate: '2026-06-01', difficulty: 5,
        dependencies: [
          { targetId: 'a', type: 'hard-blocks' },
          { targetId: 'b', type: 'hard-blocks' },
          { targetId: 'c', type: 'hard-blocks' },
        ] },
    ];
    const out = backfillBlockerConstraints(tasks, { now: 42 });
    const m = out.find((t) => t.id === 'm');
    expect(m.startDate).toBe('2026-05-20'); // latest blocker endDate
    expect(m.endDate).toBe('2026-06-01');   // unchanged — start is still <= due
    expect(m.updatedAt).toBe(42);
  });

  it('is idempotent — running on already-correct data returns the input reference', () => {
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-10', dueDate: '2026-05-10', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-10', endDate: '2026-05-12', dueDate: '2026-05-12', difficulty: 3,
        dependencies: [{ targetId: 'a', type: 'hard-blocks' }] },
    ];
    expect(backfillBlockerConstraints(tasks, { now: 1 })).toBe(tasks);
  });

  it('cascades transitively through chains a → b → c', () => {
    const tasks = [
      { id: 'a', startDate: '2026-05-01', endDate: '2026-05-15', dueDate: '2026-05-15', difficulty: 3, dependencies: [] },
      { id: 'b', startDate: '2026-05-05', endDate: '2026-05-07', dueDate: '2026-05-07', difficulty: 3,
        dependencies: [{ targetId: 'a', type: 'hard-blocks' }] },
      { id: 'c', startDate: '2026-05-08', endDate: '2026-05-10', dueDate: '2026-05-10', difficulty: 3,
        dependencies: [{ targetId: 'b', type: 'hard-blocks' }] },
    ];
    const out = backfillBlockerConstraints(tasks, { now: 1 });
    const b = out.find((t) => t.id === 'b');
    const c = out.find((t) => t.id === 'c');
    expect(b.startDate).toBe('2026-05-15');
    expect(c.startDate).toBe(b.endDate);
  });

  it('handles empty / non-array input safely', () => {
    expect(backfillBlockerConstraints([])).toEqual([]);
    expect(backfillBlockerConstraints(null)).toBe(null);
    expect(backfillBlockerConstraints(undefined)).toBe(undefined);
  });
});
