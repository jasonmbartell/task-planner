/**
 * AgentImportService — parse / run / download unit coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseBundleText,
  runBundle,
  buildResultBundleText,
  downloadResultBundle,
  defaultResultFilename,
  __TEST_ONLY__,
} from '../importService.js';

describe('parseBundleText', () => {
  it('rejects empty / non-string input', () => {
    expect(parseBundleText('').ok).toBe(false);
    expect(parseBundleText('   ').ok).toBe(false);
    expect(parseBundleText(null).ok).toBe(false);
    expect(parseBundleText(undefined).ok).toBe(false);
  });

  it('rejects malformed JSON with a helpful error', () => {
    const r = parseBundleText('{ not json');
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/Invalid JSON/);
  });

  it('accepts a single envelope', () => {
    const env = { opId: 'op-a', type: 'task.update', payload: { id: 'task-1', patch: { status: 'done' } } };
    const r = parseBundleText(JSON.stringify(env));
    expect(r.ok).toBe(true);
    expect(r.shape).toBe('single-envelope');
    expect(r.envelopes).toEqual([env]);
  });

  it('accepts an array of envelopes', () => {
    const envs = [
      { opId: 'op-a', type: 'task.update', payload: { id: 'task-1', patch: { status: 'done' } } },
      { opId: 'op-b', type: 'task.delete', payload: { id: 'task-2' } },
    ];
    const r = parseBundleText(JSON.stringify(envs));
    expect(r.ok).toBe(true);
    expect(r.shape).toBe('envelope-array');
    expect(r.envelopes).toEqual(envs);
  });

  it('rejects an empty array', () => {
    const r = parseBundleText(JSON.stringify([]));
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/empty/i);
  });

  it('rejects array entries missing type/payload', () => {
    const r = parseBundleText(JSON.stringify([{ opId: 'op-a' }]));
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/index 0/);
  });

  it('accepts { envelopes: [...] }', () => {
    const envs = [{ opId: 'op-a', type: 'task.delete', payload: { id: 'task-1' } }];
    const r = parseBundleText(JSON.stringify({ envelopes: envs }));
    expect(r.ok).toBe(true);
    expect(r.shape).toBe('envelopes-wrapper');
    expect(r.envelopes).toEqual(envs);
  });

  it('rejects { envelopes: [] }', () => {
    const r = parseBundleText(JSON.stringify({ envelopes: [] }));
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/empty/i);
  });

  it('wraps { ops: [...] } into a single bulk envelope with generated opId', () => {
    const ops = [
      { type: 'task.update', payload: { id: 'task-1', patch: { status: 'done' } } },
      { type: 'task.delete', payload: { id: 'task-2' } },
    ];
    const r = parseBundleText(JSON.stringify({ ops }), { now: 1234 });
    expect(r.ok).toBe(true);
    expect(r.shape).toBe('bulk-ops-wrapper');
    expect(r.envelopes).toHaveLength(1);
    expect(r.envelopes[0].type).toBe('bulk');
    expect(r.envelopes[0].payload.ops).toEqual(ops);
    expect(r.envelopes[0].opId).toMatch(/^import-1234$/);
    expect(r.envelopes[0].actor).toBe('browser-import');
  });

  it('honors a genId override when wrapping { ops: [...] }', () => {
    const genId = vi.fn((prefix) => `${prefix}-generated-xyz`);
    const r = parseBundleText(JSON.stringify({ ops: [{ type: 'task.delete', payload: { id: 'task-1' } }] }), { genId });
    expect(r.ok).toBe(true);
    expect(r.envelopes[0].opId).toBe('import-generated-xyz');
    expect(genId).toHaveBeenCalledWith('import');
  });

  it('preserves explicit opId / basedOn / createdAt / actor in { ops: [...] } wrapper', () => {
    const src = { opId: 'op-explicit', basedOn: 42, createdAt: 100, actor: 'cowork', ops: [{ type: 'task.delete', payload: { id: 'task-1' } }] };
    const r = parseBundleText(JSON.stringify(src));
    expect(r.ok).toBe(true);
    const env = r.envelopes[0];
    expect(env.opId).toBe('op-explicit');
    expect(env.basedOn).toBe(42);
    expect(env.createdAt).toBe(100);
    expect(env.actor).toBe('cowork');
  });

  it('rejects ops entries missing type/payload', () => {
    const r = parseBundleText(JSON.stringify({ ops: [{ type: 'task.delete' }] }));
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/ops\[0\]/);
  });

  it('rejects an object that matches none of the shapes', () => {
    const r = parseBundleText(JSON.stringify({ hello: 'world' }));
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/Unrecognized/);
  });

  it('rejects a bare string / number', () => {
    expect(parseBundleText(JSON.stringify('hello')).ok).toBe(false);
    expect(parseBundleText(JSON.stringify(42)).ok).toBe(false);
  });
});

function makeStore({ applyQueue = [], now = 5000 } = {}) {
  const apply = vi.fn((_env, _opts) => {
    if (applyQueue.length === 0) throw new Error('makeStore: applyQueue exhausted');
    const next = applyQueue.shift();
    if (next instanceof Error) throw next;
    return { appliedAt: now, ...next };
  });
  return {
    _apply: apply,
    getState: () => ({ _agentBulkApply: apply }),
  };
}

describe('runBundle', () => {
  it('runs each envelope through _agentBulkApply, preserving order', () => {
    const envs = [
      { opId: 'op-a', type: 'task.update', payload: { id: 'task-1', patch: { status: 'done' } } },
      { opId: 'op-b', type: 'task.delete', payload: { id: 'task-2' } },
    ];
    const store = makeStore({
      applyQueue: [
        { status: 'applied', diff: { tasks: { updated: [{ id: 'task-1' }] } } },
        { status: 'queued', reason: 'trust' },
      ],
    });
    const now = 7000;
    const { results, summary } = runBundle(store, envs, { now });

    expect(store._apply).toHaveBeenCalledTimes(2);
    expect(store._apply.mock.calls[0][0]).toEqual(envs[0]);
    expect(store._apply.mock.calls[0][1]).toEqual({ forceApply: false, now });
    expect(results).toHaveLength(2);
    expect(results[0].result.status).toBe('applied');
    expect(results[0].result.diff.tasks.updated[0].id).toBe('task-1');
    expect(results[0].result.importedAt).toBe(now);
    expect(results[1].result.status).toBe('queued');
    expect(results[1].result.reason).toBe('trust');
    expect(results[1].result.queuedAt).toBe(now);
    expect(summary).toEqual({ total: 2, applied: 1, queued: 1, rejected: 0 });
  });

  it('passes forceApply through to the store', () => {
    const store = makeStore({ applyQueue: [{ status: 'applied', diff: null }] });
    runBundle(store, [{ opId: 'op-a', type: 'task.update', payload: { id: 'task-1', patch: {} } }], { forceApply: true, now: 1 });
    expect(store._apply.mock.calls[0][1]).toEqual({ forceApply: true, now: 1 });
  });

  it('converts a thrown _agentBulkApply into a synthetic internal rejection', () => {
    const store = makeStore({ applyQueue: [new Error('store blew up')] });
    const envs = [{ opId: 'op-a', type: 'task.update', payload: { id: 'task-1', patch: {} } }];
    const { results, summary } = runBundle(store, envs, { now: 42 });
    expect(results[0].result.status).toBe('rejected');
    expect(results[0].result.error).toEqual({ kind: 'internal', message: 'store blew up' });
    expect(results[0].result.rejectedAt).toBe(42);
    expect(summary).toEqual({ total: 1, applied: 0, queued: 0, rejected: 1 });
  });

  it('keeps going after a rejection so later envelopes still run', () => {
    const envs = [
      { opId: 'op-a', type: 'task.update', payload: { id: 'task-1', patch: {} } },
      { opId: 'op-b', type: 'task.update', payload: { id: 'task-2', patch: {} } },
    ];
    const store = makeStore({
      applyQueue: [
        { status: 'rejected', error: { kind: 'validation', message: 'no' } },
        { status: 'applied', diff: null },
      ],
    });
    const { results, summary } = runBundle(store, envs, { now: 10 });
    expect(results[0].result.status).toBe('rejected');
    expect(results[1].result.status).toBe('applied');
    expect(summary).toEqual({ total: 2, applied: 1, queued: 0, rejected: 1 });
  });

  it('fills in a default unknown error for rejected results missing one', () => {
    const store = makeStore({ applyQueue: [{ status: 'rejected' }] });
    const envs = [{ opId: 'op-a', type: 'task.update', payload: { id: 'task-1', patch: {} } }];
    const { results } = runBundle(store, envs, { now: 1 });
    expect(results[0].result.error).toEqual({ kind: 'unknown', message: 'unspecified rejection' });
  });

  it('throws when store lacks _agentBulkApply', () => {
    const store = { getState: () => ({}) };
    expect(() => runBundle(store, [], {})).toThrow(/_agentBulkApply/);
  });

  it('throws when store is missing or invalid', () => {
    expect(() => runBundle(null, [], {})).toThrow(/getState/);
    expect(() => runBundle({}, [], {})).toThrow(/getState/);
  });
});

describe('buildResultBundleText', () => {
  it('wraps results in importedAt/summary/envelopes and pretty-prints', () => {
    const results = [
      { opId: 'op-a', type: 'task.update', payload: {}, result: { status: 'applied', diff: null, appliedAt: 1 } },
    ];
    const summary = { total: 1, applied: 1, queued: 0, rejected: 0 };
    const text = buildResultBundleText(results, summary, { now: 99 });
    const parsed = JSON.parse(text);
    expect(parsed.importedAt).toBe(99);
    expect(parsed.summary).toEqual(summary);
    expect(parsed.envelopes).toEqual(results);
    // Pretty-printed (indentation present)
    expect(text).toMatch(/\n {2}"/);
  });

  it('tolerates a null summary', () => {
    const text = buildResultBundleText([], null, { now: 1 });
    const parsed = JSON.parse(text);
    expect(parsed.summary).toBeNull();
    expect(parsed.envelopes).toEqual([]);
  });
});

describe('downloadResultBundle', () => {
  let doc;
  let urlApi;
  let createdAnchors;

  beforeEach(() => {
    createdAnchors = [];
    const body = { appendChild: vi.fn(), removeChild: vi.fn() };
    doc = {
      body,
      createElement: vi.fn(() => {
        const a = { click: vi.fn(), parentNode: body, style: {} };
        createdAnchors.push(a);
        return a;
      }),
    };
    urlApi = {
      createObjectURL: vi.fn(() => 'blob:fake-url'),
      revokeObjectURL: vi.fn(),
    };
  });

  it('creates an anchor, clicks it, and returns true', () => {
    const ok = downloadResultBundle('{"hello":"world"}', 'bundle.json', { doc, urlApi });
    expect(ok).toBe(true);
    expect(doc.createElement).toHaveBeenCalledWith('a');
    expect(createdAnchors[0].href).toBe('blob:fake-url');
    expect(createdAnchors[0].download).toBe('bundle.json');
    expect(createdAnchors[0].click).toHaveBeenCalled();
    expect(doc.body.appendChild).toHaveBeenCalled();
  });

  it('no-ops and returns false in a non-browser context', () => {
    expect(downloadResultBundle('x', 'y.json', { doc: null, urlApi })).toBe(false);
    expect(downloadResultBundle('x', 'y.json', { doc, urlApi: null })).toBe(false);
  });
});

describe('defaultResultFilename', () => {
  it('produces a Windows-safe ISO stamp', () => {
    const name = defaultResultFilename(new Date('2026-04-23T11:22:33.456Z').getTime());
    expect(name).toBe('agent-import-result-2026-04-23T11-22-33Z.json');
    expect(name).not.toMatch(/:/);
  });
});

describe('__TEST_ONLY__ helpers', () => {
  it('isPlainObject / isEnvelopeLike edge cases', () => {
    const { isPlainObject, isEnvelopeLike } = __TEST_ONLY__;
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);

    expect(isEnvelopeLike({ type: 'x', payload: {} })).toBe(true);
    expect(isEnvelopeLike({ type: 'x' })).toBe(false);          // no payload
    expect(isEnvelopeLike({ type: 'x', payload: [] })).toBe(false); // payload must be object
    expect(isEnvelopeLike([])).toBe(false);
  });
});
