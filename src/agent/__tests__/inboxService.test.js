/**
 * AgentInboxService — lifecycle, pub-sub, approve/reject transitions.
 *
 * Uses an in-memory fake adapter with the subset of the obsidian-adapter
 * contract the service calls (listAgentFiles, readAgentFile, writeAgentFile,
 * appendAgentFile, removeAgentFile). The "filesystem" is a Map keyed by
 * absolute path (queued/ entries) plus an array of writes we can assert on.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AgentInboxService } from '../inboxService.js';

function makeFakeAdapter({ queued = {} } = {}) {
  // queued: { absPath → contents }
  const queuedFiles = { ...queued };
  const writes = [];
  const appends = [];
  const removes = [];

  return {
    state: { queuedFiles, writes, appends, removes },
    listAgentFiles: vi.fn(async (relDir) => {
      if (relDir !== 'agent-archive/queued') return [];
      return Object.keys(queuedFiles).map((absPath, i) => ({
        name: absPath.split(/[\\/]/).pop(),
        absPath,
        modifiedAt: 1_700_000_000_000 + i * 1000,
      }));
    }),
    readAgentFile: vi.fn(async (absPath) => {
      if (!(absPath in queuedFiles)) throw new Error(`ENOENT: ${absPath}`);
      return queuedFiles[absPath];
    }),
    writeAgentFile: vi.fn(async (rel, contents, plannerDataPath) => {
      writes.push({ rel, contents, plannerDataPath });
    }),
    appendAgentFile: vi.fn(async (rel, contents, plannerDataPath) => {
      appends.push({ rel, contents, plannerDataPath });
    }),
    removeAgentFile: vi.fn(async (absPath) => {
      removes.push(absPath);
      delete queuedFiles[absPath];
    }),
  };
}

function makeStore({ applyResult = { status: 'applied', diff: { tasks: { updated: [] } }, appliedAt: 5000 }, plannerDataPath = '' } = {}) {
  const _agentBulkApply = vi.fn(() => applyResult);
  return {
    _agentBulkApply,
    getState: () => ({ _agentBulkApply, obsidianConfig: { plannerDataPath } }),
  };
}

const QUEUED_A = 'C:/planner-data/agent-archive/queued/2026-04-22T18-00-00.000Z__op-a.json';
const QUEUED_B = 'C:/planner-data/agent-archive/queued/2026-04-22T18-01-00.000Z__op-b.json';

function makeEnvelope(opId, overrides = {}) {
  return {
    opId,
    createdAt: 1_700_000_000_000,
    type: 'task.delete',
    payload: { id: 'task-1' },
    result: { status: 'queued', queuedAt: 1_700_000_000_000, reason: 'trust', error: null },
    ...overrides,
  };
}

describe('AgentInboxService — refresh + subscribe', () => {
  let adapter;
  let store;
  let logger;

  beforeEach(() => {
    logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  it('start() lists queued files and populates the subscriber', async () => {
    adapter = makeFakeAdapter({
      queued: {
        [QUEUED_A]: JSON.stringify(makeEnvelope('op-a')),
        [QUEUED_B]: JSON.stringify(makeEnvelope('op-b', { type: 'task.update', payload: { id: 'task-1', patch: { status: 'done' } } })),
      },
    });
    store = makeStore();
    const svc = new AgentInboxService(store, { adapter, logger, pollIntervalMs: 0 });

    const seen = [];
    svc.subscribe((list) => seen.push(list.map((x) => x.envelope.opId)));

    await svc.start();

    expect(adapter.listAgentFiles).toHaveBeenCalledWith('agent-archive/queued', '');
    expect(svc.getCount()).toBe(2);
    const opIds = svc.getQueued().map((x) => x.envelope.opId);
    expect(opIds).toContain('op-a');
    expect(opIds).toContain('op-b');
    // Subscriber was invoked on subscribe (initial) + after refresh.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1]).toContain('op-a');

    svc.stop();
  });

  it('subscribe returns an unsubscribe fn', async () => {
    adapter = makeFakeAdapter();
    store = makeStore();
    const svc = new AgentInboxService(store, { adapter, logger, pollIntervalMs: 0 });
    const cb = vi.fn();
    const unsub = svc.subscribe(cb);
    expect(cb).toHaveBeenCalledTimes(1); // initial prime
    unsub();
    await svc.refresh();
    expect(cb).toHaveBeenCalledTimes(1); // not called again after unsub
  });

  it('skips unreadable queued files but surfaces the rest', async () => {
    adapter = makeFakeAdapter({
      queued: {
        [QUEUED_A]: 'not json',
        [QUEUED_B]: JSON.stringify(makeEnvelope('op-b')),
      },
    });
    store = makeStore();
    const svc = new AgentInboxService(store, { adapter, logger, pollIntervalMs: 0 });
    await svc.start();
    expect(svc.getCount()).toBe(1);
    expect(svc.getQueued()[0].envelope.opId).toBe('op-b');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('empty adapter listing ⇒ empty queued list (no throw)', async () => {
    adapter = makeFakeAdapter();
    store = makeStore();
    const svc = new AgentInboxService(store, { adapter, logger, pollIntervalMs: 0 });
    await svc.start();
    expect(svc.getCount()).toBe(0);
  });

  it('no adapter available ⇒ empty list without error', async () => {
    store = makeStore();
    // No `adapter` injected and platform is not Tauri under test ⇒ adapter is null.
    const svc = new AgentInboxService(store, { logger, pollIntervalMs: 0 });
    await svc.start();
    expect(svc.getCount()).toBe(0);
  });

  it('coalesces concurrent refresh calls', async () => {
    adapter = makeFakeAdapter({ queued: { [QUEUED_A]: JSON.stringify(makeEnvelope('op-a')) } });
    store = makeStore();
    const svc = new AgentInboxService(store, { adapter, logger, pollIntervalMs: 0 });
    const p1 = svc.refresh();
    const p2 = svc.refresh();
    await Promise.all([p1, p2]);
    // listAgentFiles called once even though refresh was called twice concurrently.
    expect(adapter.listAgentFiles).toHaveBeenCalledTimes(1);
  });
});

describe('AgentInboxService — approve', () => {
  it('applies envelope with forceApply, archives to applied/, removes queued file, refreshes', async () => {
    const env = makeEnvelope('op-a');
    const adapter = makeFakeAdapter({ queued: { [QUEUED_A]: JSON.stringify(env) } });
    const store = makeStore({
      applyResult: { status: 'applied', diff: { tasks: { deleted: [{ id: 'task-1' }] } }, appliedAt: 7000 },
      plannerDataPath: 'D:/custom',
    });
    const svc = new AgentInboxService(store, {
      adapter,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pollIntervalMs: 0,
      now: () => 9_999,
    });
    await svc.start();

    const result = await svc.approve(QUEUED_A);

    expect(result.status).toBe('applied');
    expect(store._agentBulkApply).toHaveBeenCalledTimes(1);
    const [envPassedIn, opts] = store._agentBulkApply.mock.calls[0];
    expect(opts.forceApply).toBe(true);
    // `result` field from the queued file is stripped before re-applying.
    expect(envPassedIn.result).toBeUndefined();
    expect(envPassedIn.opId).toBe('op-a');

    // Archive write lands in applied/ with plannerDataPath forwarded.
    expect(adapter.state.writes).toHaveLength(1);
    const archiveEntry = adapter.state.writes[0];
    expect(archiveEntry.rel).toMatch(/^agent-archive\/applied\/.+__op-a\.json$/);
    expect(archiveEntry.plannerDataPath).toBe('D:/custom');
    const archived = JSON.parse(archiveEntry.contents);
    expect(archived.result.status).toBe('applied');
    expect(archived.result.approvedFromQueue).toBe(true);
    expect(archived.result.diff).toEqual({ tasks: { deleted: [{ id: 'task-1' }] } });

    // Log line appended.
    expect(adapter.state.appends).toHaveLength(1);
    expect(adapter.state.appends[0].rel).toMatch(/^agent-log\/\d{4}-\d{2}-\d{2}\.jsonl$/);

    // Queued file removed + inbox now empty.
    expect(adapter.state.removes).toEqual([QUEUED_A]);
    expect(svc.getCount()).toBe(0);
  });

  it('archives to rejected/ when the store still rejects (validation wins over forceApply)', async () => {
    const env = makeEnvelope('op-bad');
    const adapter = makeFakeAdapter({ queued: { [QUEUED_A]: JSON.stringify(env) } });
    const store = makeStore({
      applyResult: { status: 'rejected', error: { kind: 'missing_ref', message: 'task-1 not found' } },
    });
    const svc = new AgentInboxService(store, { adapter, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, pollIntervalMs: 0 });
    await svc.start();

    const res = await svc.approve(QUEUED_A);

    expect(res.status).toBe('rejected');
    expect(adapter.state.writes[0].rel).toMatch(/^agent-archive\/rejected\//);
    const archived = JSON.parse(adapter.state.writes[0].contents);
    expect(archived.result.status).toBe('rejected');
    expect(archived.result.error.kind).toBe('missing_ref');
    expect(adapter.state.removes).toEqual([QUEUED_A]);
  });

  it('respects edited envelope (user-edited JSON overrides the stored body)', async () => {
    const env = makeEnvelope('op-edit', { type: 'task.update', payload: { id: 'task-1', patch: { status: 'blocked' } } });
    const adapter = makeFakeAdapter({ queued: { [QUEUED_A]: JSON.stringify(env) } });
    const store = makeStore();
    const svc = new AgentInboxService(store, { adapter, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, pollIntervalMs: 0 });
    await svc.start();

    const edited = { ...env, payload: { id: 'task-1', patch: { status: 'done' } } };
    await svc.approve(QUEUED_A, edited);

    const envApplied = store._agentBulkApply.mock.calls[0][0];
    expect(envApplied.payload.patch.status).toBe('done');
  });

  it('survives a thrown _agentBulkApply (internal error) and still archives', async () => {
    const env = makeEnvelope('op-throw');
    const adapter = makeFakeAdapter({ queued: { [QUEUED_A]: JSON.stringify(env) } });
    const store = {
      getState: () => ({
        _agentBulkApply: () => { throw new Error('boom'); },
        obsidianConfig: {},
      }),
    };
    const svc = new AgentInboxService(store, { adapter, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, pollIntervalMs: 0 });
    await svc.start();

    const res = await svc.approve(QUEUED_A);
    expect(res.status).toBe('rejected');
    expect(res.error.kind).toBe('internal');
    expect(adapter.state.writes[0].rel).toMatch(/^agent-archive\/rejected\//);
    expect(adapter.state.removes).toEqual([QUEUED_A]);
  });

  it('throws if the queued file is not in the service\'s cache', async () => {
    const adapter = makeFakeAdapter();
    const store = makeStore();
    const svc = new AgentInboxService(store, { adapter, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, pollIntervalMs: 0 });
    await svc.start();
    await expect(svc.approve('C:/nope/nothing.json')).rejects.toThrow(/no queued op/);
  });
});

describe('AgentInboxService — reject', () => {
  it('writes rejected/ entry with error.kind=user_rejected, removes queued file', async () => {
    const env = makeEnvelope('op-nay');
    const adapter = makeFakeAdapter({ queued: { [QUEUED_A]: JSON.stringify(env) } });
    const store = makeStore();
    const svc = new AgentInboxService(store, { adapter, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, pollIntervalMs: 0, now: () => 4242 });
    await svc.start();

    const archived = await svc.reject(QUEUED_A, { reason: 'not comfortable with cascade' });

    expect(archived.result.status).toBe('rejected');
    expect(archived.result.error.kind).toBe('user_rejected');
    expect(archived.result.error.message).toMatch(/not comfortable/);
    expect(archived.result.rejectedAt).toBe(4242);
    // Re-applied envelope is NOT run for reject.
    expect(store._agentBulkApply).not.toHaveBeenCalled();

    expect(adapter.state.writes[0].rel).toMatch(/^agent-archive\/rejected\//);
    expect(adapter.state.removes).toEqual([QUEUED_A]);
    expect(svc.getCount()).toBe(0);
  });

  it('uses a default reason string when none is supplied', async () => {
    const env = makeEnvelope('op-default-reject');
    const adapter = makeFakeAdapter({ queued: { [QUEUED_A]: JSON.stringify(env) } });
    const store = makeStore();
    const svc = new AgentInboxService(store, { adapter, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, pollIntervalMs: 0 });
    await svc.start();

    const archived = await svc.reject(QUEUED_A);
    expect(archived.result.error.message).toMatch(/rejected by user/i);
  });
});

describe('AgentInboxService — polling', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('polls at the configured interval and refreshes the list', async () => {
    const adapter = makeFakeAdapter();
    const store = makeStore();
    const svc = new AgentInboxService(store, { adapter, logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() }, pollIntervalMs: 1000 });
    const startPromise = svc.start();
    await startPromise;
    expect(adapter.listAgentFiles).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    // One more refresh after the timer fires.
    expect(adapter.listAgentFiles.mock.calls.length).toBeGreaterThanOrEqual(2);

    svc.stop();
    const countBefore = adapter.listAgentFiles.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(adapter.listAgentFiles.mock.calls.length).toBe(countBefore);
  });
});
