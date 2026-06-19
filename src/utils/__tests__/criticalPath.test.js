import { describe, it, expect } from 'vitest';
import { computeCriticalPath } from '../criticalPath.js';

const mkTask = (id, startDate, endDate, dependencies = []) => ({
  id, title: id, startDate, endDate,
  dependencies: dependencies.map((d) =>
    typeof d === 'string' ? { targetId: d, type: 'hard-blocks' } : d,
  ),
});

describe('computeCriticalPath — typed edges', () => {
  it('follows a linear hard-blocks chain', () => {
    const tasks = [
      mkTask('a', '2026-04-01', '2026-04-03'),             // 2 days
      mkTask('b', '2026-04-03', '2026-04-08', ['a']),      // 5 days
      mkTask('c', '2026-04-08', '2026-04-10', ['b']),      // 2 days
    ];
    const cp = computeCriticalPath(tasks);
    expect(Array.from(cp).sort()).toEqual(['a', 'b', 'c']);
  });

  it('ignores soft-prefers edges when computing the path', () => {
    // a: 4d, b: 9d, c: 10d and depends hard on a, soft on b.
    // Under the new semantics, c's longest-path length is a (4) + c (10) = 14,
    // which makes c the max sink; backtrack goes c → a. b is a standalone sink at 9.
    // Under the old untyped semantics, c's longest-path would be b (9) + c (10) = 19,
    // pulling b into the critical path — this test guards against that regression.
    const tasks = [
      mkTask('a', '2026-04-01', '2026-04-05'),
      mkTask('b', '2026-04-01', '2026-04-10'),
      mkTask('c', '2026-04-10', '2026-04-20', [
        { targetId: 'a', type: 'hard-blocks' },
        { targetId: 'b', type: 'soft-prefers' },
      ]),
    ];
    const cp = computeCriticalPath(tasks);
    expect(cp.has('a')).toBe(true);
    expect(cp.has('c')).toBe(true);
    expect(cp.has('b')).toBe(false);
  });

  it('tolerates a preempts-only cycle without falling over', () => {
    // a preempts b and b preempts a — would be a cycle under the old
    // untyped shape; since preempts is not hard-blocks, the topological
    // sort sees no edges and everything is reachable.
    const tasks = [
      mkTask('a', '2026-04-01', '2026-04-05', [{ targetId: 'b', type: 'preempts' }]),
      mkTask('b', '2026-04-01', '2026-04-10', [{ targetId: 'a', type: 'preempts' }]),
    ];
    const cp = computeCriticalPath(tasks);
    // Longest path is b on its own (9 days).
    expect(cp.has('b')).toBe(true);
  });

  it('accepts legacy string[] for backward compatibility', () => {
    const tasks = [
      { id: 'a', startDate: '2026-04-01', endDate: '2026-04-03', dependencies: [] },
      { id: 'b', startDate: '2026-04-03', endDate: '2026-04-06', dependencies: ['a'] },
    ];
    const cp = computeCriticalPath(tasks);
    expect(cp.has('a')).toBe(true);
    expect(cp.has('b')).toBe(true);
  });
});
