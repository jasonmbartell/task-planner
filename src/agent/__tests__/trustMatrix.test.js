import { describe, it, expect } from 'vitest';
import { decide, decideForBulk, DEFAULT_TRUST } from '../trustMatrix.js';

describe('trustMatrix.decide', () => {
  it('returns the documented trust defaults', () => {
    expect(decide('task.add')).toBe('auto');
    expect(decide('task.update')).toBe('auto');
    expect(decide('task.delete')).toBe('queue');
    expect(decide('sprint.add')).toBe('auto');
    expect(decide('sprint.update')).toBe('auto');
    expect(decide('sprint.delete')).toBe('queue');
    expect(decide('project.add')).toBe('auto');
    expect(decide('project.update')).toBe('auto');
    expect(decide('project.delete')).toBe('queue');
  });

  it('honors a per-op-type override', () => {
    expect(decide('task.update', { 'task.update': 'queue' })).toBe('queue');
    expect(decide('task.delete', { 'task.delete': 'auto' })).toBe('auto');
  });

  it('ignores invalid override values', () => {
    expect(decide('task.update', { 'task.update': 'banana' })).toBe('auto');
  });

  it('falls back to auto for unknown op types (defensive)', () => {
    expect(decide('task.frobnicate')).toBe('auto');
  });

  it('the default map covers every documented atomic op type', () => {
    const expected = [
      'task.add', 'task.update', 'task.delete',
      'sprint.add', 'sprint.update', 'sprint.delete',
      'project.add', 'project.update', 'project.delete',
    ];
    for (const k of expected) expect(DEFAULT_TRUST[k]).toBeDefined();
  });
});

describe('trustMatrix.decideForBulk', () => {
  it('returns auto when every child is auto', () => {
    const ops = [
      { type: 'task.add' }, { type: 'sprint.update' }, { type: 'project.add' },
    ];
    expect(decideForBulk(ops)).toBe('auto');
  });

  it('returns queue when any child is queue', () => {
    const ops = [
      { type: 'task.add' }, { type: 'task.delete' },
    ];
    expect(decideForBulk(ops)).toBe('queue');
  });

  it('honors override on the queueing child', () => {
    const ops = [{ type: 'task.add' }, { type: 'task.delete' }];
    expect(decideForBulk(ops, { 'task.delete': 'auto' })).toBe('auto');
  });
});
