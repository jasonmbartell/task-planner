import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EDGE_TYPE,
  EDGE_TYPES,
  canonicalEdgeType,
  isValidEdgeType,
  normalizeDep,
  normalizeDeps,
  coerceToEdges,
  hardTargets,
  edgeTargets,
  removeTarget,
  parseEdgeToken,
  serializeEdgeToken,
} from '../depEdges.js';

describe('canonicalEdgeType', () => {
  it('returns canonical name for full types', () => {
    expect(canonicalEdgeType('hard-blocks')).toBe('hard-blocks');
    expect(canonicalEdgeType('soft-prefers')).toBe('soft-prefers');
    expect(canonicalEdgeType('preempts')).toBe('preempts');
    expect(canonicalEdgeType('deadline-independent')).toBe('deadline-independent');
  });

  it('maps short aliases to canonical types', () => {
    expect(canonicalEdgeType('hard')).toBe('hard-blocks');
    expect(canonicalEdgeType('soft')).toBe('soft-prefers');
    expect(canonicalEdgeType('preempt')).toBe('preempts');
    expect(canonicalEdgeType('independent')).toBe('deadline-independent');
  });

  it('is case/space tolerant', () => {
    expect(canonicalEdgeType('  HARD  ')).toBe('hard-blocks');
    expect(canonicalEdgeType('Soft-Prefers')).toBe('soft-prefers');
  });

  it('returns null for garbage', () => {
    expect(canonicalEdgeType('noodles')).toBeNull();
    expect(canonicalEdgeType('')).toBeNull();
    expect(canonicalEdgeType(null)).toBeNull();
    expect(canonicalEdgeType(42)).toBeNull();
  });
});

describe('isValidEdgeType', () => {
  it('accepts canonical names only (not aliases)', () => {
    for (const t of EDGE_TYPES) expect(isValidEdgeType(t)).toBe(true);
    expect(isValidEdgeType('hard')).toBe(false);
    expect(isValidEdgeType('')).toBe(false);
  });
});

describe('normalizeDep', () => {
  it('promotes a bare string to a hard-blocks edge', () => {
    expect(normalizeDep('task-abc')).toEqual({ targetId: 'task-abc', type: 'hard-blocks' });
  });

  it('passes through a valid DepEdge, trimming targetId', () => {
    expect(normalizeDep({ targetId: ' task-x ', type: 'soft-prefers' }))
      .toEqual({ targetId: 'task-x', type: 'soft-prefers' });
  });

  it('defaults missing type to hard-blocks', () => {
    expect(normalizeDep({ targetId: 'task-x' })).toEqual({ targetId: 'task-x', type: 'hard-blocks' });
  });

  it('maps alias types', () => {
    expect(normalizeDep({ targetId: 'task-x', type: 'soft' }).type).toBe('soft-prefers');
  });

  it('falls back to default type when the type is unknown', () => {
    expect(normalizeDep({ targetId: 'task-x', type: 'noodles' }, { defaultType: 'soft-prefers' }))
      .toEqual({ targetId: 'task-x', type: 'soft-prefers' });
  });

  it('preserves except/note when non-empty', () => {
    const r = normalizeDep({ targetId: 'task-x', type: 'hard-blocks', except: 'weekends', note: 'per spec' });
    expect(r.except).toBe('weekends');
    expect(r.note).toBe('per spec');
  });

  it('drops empty or whitespace-only optional fields', () => {
    const r = normalizeDep({ targetId: 'task-x', type: 'hard-blocks', except: '   ', note: '' });
    expect(r).not.toHaveProperty('except');
    expect(r).not.toHaveProperty('note');
  });

  it('returns null for missing targetId or garbage input', () => {
    expect(normalizeDep('')).toBeNull();
    expect(normalizeDep('   ')).toBeNull();
    expect(normalizeDep(null)).toBeNull();
    expect(normalizeDep({})).toBeNull();
    expect(normalizeDep({ targetId: '' })).toBeNull();
    expect(normalizeDep(42)).toBeNull();
  });
});

describe('normalizeDeps', () => {
  it('converts a mixed list of strings and objects', () => {
    expect(normalizeDeps(['task-a', { targetId: 'task-b', type: 'soft' }])).toEqual([
      { targetId: 'task-a', type: 'hard-blocks' },
      { targetId: 'task-b', type: 'soft-prefers' },
    ]);
  });

  it('dedupes by (targetId, type)', () => {
    const r = normalizeDeps(['task-a', 'task-a', { targetId: 'task-a', type: 'soft' }]);
    expect(r).toHaveLength(2);
    expect(r).toContainEqual({ targetId: 'task-a', type: 'hard-blocks' });
    expect(r).toContainEqual({ targetId: 'task-a', type: 'soft-prefers' });
  });

  it('returns [] for non-array input', () => {
    expect(normalizeDeps(null)).toEqual([]);
    expect(normalizeDeps(undefined)).toEqual([]);
    expect(normalizeDeps('task-a')).toEqual([]);
  });

  it('is idempotent on already-normalized edges', () => {
    const once = normalizeDeps(['task-a', 'task-b']);
    const twice = normalizeDeps(once);
    expect(twice).toEqual(once);
  });

  it('coerceToEdges is an alias with the same semantics', () => {
    expect(coerceToEdges(['task-a'])).toEqual([{ targetId: 'task-a', type: 'hard-blocks' }]);
  });
});

describe('hardTargets / edgeTargets / removeTarget', () => {
  const edges = [
    { targetId: 'task-a', type: 'hard-blocks' },
    { targetId: 'task-b', type: 'soft-prefers' },
    { targetId: 'task-c', type: 'preempts' },
    { targetId: 'task-d', type: 'deadline-independent' },
    { targetId: 'task-a', type: 'soft-prefers' }, // same target, different type
  ];

  it('hardTargets returns only hard-blocks target ids', () => {
    expect(hardTargets(edges)).toEqual(['task-a']);
  });

  it('edgeTargets returns every target id (duplicates possible)', () => {
    expect(edgeTargets(edges)).toEqual(['task-a', 'task-b', 'task-c', 'task-d', 'task-a']);
  });

  it('removeTarget drops every edge pointing at the id', () => {
    const remaining = removeTarget(edges, 'task-a');
    expect(remaining.every((e) => e.targetId !== 'task-a')).toBe(true);
    expect(remaining).toHaveLength(3);
  });

  it('handles non-array inputs safely', () => {
    expect(hardTargets(null)).toEqual([]);
    expect(edgeTargets(undefined)).toEqual([]);
    expect(removeTarget(null, 'task-a')).toEqual([]);
  });

  it('treats legacy string entries as hard-blocks edges', () => {
    const mixed = ['task-a', { targetId: 'task-b', type: 'soft-prefers' }];
    expect(hardTargets(mixed)).toEqual(['task-a']);
    expect(edgeTargets(mixed)).toEqual(['task-a', 'task-b']);
    expect(removeTarget(mixed, 'task-a')).toEqual([{ targetId: 'task-b', type: 'soft-prefers' }]);
  });
});

describe('parseEdgeToken', () => {
  it('parses a bare id as hard-blocks', () => {
    expect(parseEdgeToken('task-abc')).toEqual({ targetId: 'task-abc', type: 'hard-blocks' });
  });

  it('parses "id (type)" syntax with short or full names', () => {
    expect(parseEdgeToken('task-abc (soft)'))
      .toEqual({ targetId: 'task-abc', type: 'soft-prefers' });
    expect(parseEdgeToken('task-abc (hard-blocks)'))
      .toEqual({ targetId: 'task-abc', type: 'hard-blocks' });
    expect(parseEdgeToken('task-abc (preempts)'))
      .toEqual({ targetId: 'task-abc', type: 'preempts' });
  });

  it('parses key:value annotations including except and note', () => {
    expect(parseEdgeToken('task-abc (type: soft, note: tentative)'))
      .toEqual({ targetId: 'task-abc', type: 'soft-prefers', note: 'tentative' });
    expect(parseEdgeToken('task-abc (hard, except: weekends)'))
      .toEqual({ targetId: 'task-abc', type: 'hard-blocks', except: 'weekends' });
  });

  it('defaults to hard-blocks when the annotation is garbage', () => {
    expect(parseEdgeToken('task-abc (noodles)'))
      .toEqual({ targetId: 'task-abc', type: 'hard-blocks' });
  });

  it('returns null for empty input', () => {
    expect(parseEdgeToken('')).toBeNull();
    expect(parseEdgeToken('   ')).toBeNull();
    expect(parseEdgeToken(null)).toBeNull();
  });
});

describe('serializeEdgeToken', () => {
  it('emits a bare id for default hard-blocks edges', () => {
    expect(serializeEdgeToken({ targetId: 'task-abc', type: 'hard-blocks' }))
      .toBe('task-abc');
  });

  it('emits "id (type)" for non-default types', () => {
    expect(serializeEdgeToken({ targetId: 'task-abc', type: 'soft-prefers' }))
      .toBe('task-abc (soft-prefers)');
  });

  it('includes except/note when present', () => {
    expect(serializeEdgeToken({ targetId: 'task-abc', type: 'hard-blocks', except: 'weekends' }))
      .toBe('task-abc (except: weekends)');
    expect(serializeEdgeToken({ targetId: 'task-abc', type: 'soft-prefers', note: 'tentative' }))
      .toBe('task-abc (soft-prefers, note: tentative)');
  });

  it('round-trips with parseEdgeToken for every edge type', () => {
    for (const type of EDGE_TYPES) {
      const edge = { targetId: 'task-x', type };
      expect(parseEdgeToken(serializeEdgeToken(edge))).toEqual(edge);
    }
  });

  it('returns empty string for invalid input', () => {
    expect(serializeEdgeToken(null)).toBe('');
    expect(serializeEdgeToken({})).toBe('');
  });
});

describe('DEFAULT_EDGE_TYPE', () => {
  it('is hard-blocks', () => {
    expect(DEFAULT_EDGE_TYPE).toBe('hard-blocks');
  });
});
