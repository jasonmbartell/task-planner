import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentSync, __TEST_ONLY__ } from '../AgentSync.js';

function makeFakeAdapter({ inboxList = null } = {}) {
  const writes = [];
  const appends = [];
  const removes = [];
  const reads = new Map();
  const adapter = {
    writes, appends, removes, reads,
    readAgentFile: vi.fn(async (path) => {
      if (!reads.has(path)) throw new Error(`no fixture for ${path}`);
      return reads.get(path);
    }),
    writeAgentFile: vi.fn(async (rel, content, base) => {
      writes.push({ rel, content, base });
    }),
    appendAgentFile: vi.fn(async (rel, content, base) => {
      appends.push({ rel, content, base });
    }),
    removeAgentFile: vi.fn(async (path) => {
      removes.push(path);
    }),
  };
  if (inboxList !== null) {
    adapter.listAgentFiles = vi.fn(async (relDir) => {
      if (relDir !== 'agent-inbox') return [];
      return inboxList;
    });
  }
  return adapter;
}

function flushMicrotasks(rounds = 4) {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

function makeStubStore({ hydrated = true, applyResult = { status: 'applied', diff: {}, appliedAt: 0 } } = {}) {
  const _agentBulkApply = vi.fn(() => applyResult);
  let state = { _agentBulkApply, _hydrated: hydrated, obsidianConfig: { plannerDataPath: '/planner-data' } };
  const subscribers = new Set();
  return {
    _agentBulkApply,
    getState: () => state,
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    setHydrated() {
      state = { ...state, _hydrated: true };
      for (const cb of subscribers) cb(state);
    },
  };
}

// Minimal fake event API: holds the handler and lets the test "emit".
function makeFakeEventApi() {
  let handler = null;
  return {
    api: {
      listen: vi.fn(async (_evt, cb) => {
        handler = cb;
        return () => { handler = null; };
      }),
    },
    emit(payload) {
      if (!handler) throw new Error('no listener registered');
      handler({ payload });
    },
    get hasHandler() { return handler !== null; },
  };
}

function makeSilentLogger() {
  return { log: vi.fn(), error: vi.fn() };
}

describe('AgentSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes to agent-inbox:op on start and logs the milestone-2 acceptance string', async () => {
    const fake = makeFakeEventApi();
    const logger = makeSilentLogger();
    const sync = new AgentSync({}, { eventApi: fake.api, logger });

    await sync.start();

    expect(fake.api.listen).toHaveBeenCalledTimes(1);
    expect(fake.api.listen.mock.calls[0][0]).toBe(__TEST_ONLY__.EVENT_NAME);

    fake.emit('C:\\planner-data\\agent-inbox\\op-1.json');
    // The expected log line is "agent op received".
    const logged = logger.log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/agent op received/);
    expect(logged).toMatch(/op-1\.json/);
  });

  it('dedupes rapid repeat events for the same path within the dedupe window', async () => {
    const fake = makeFakeEventApi();
    const logger = makeSilentLogger();
    const sync = new AgentSync({}, { eventApi: fake.api, logger });
    await sync.start();

    fake.emit('C:\\planner-data\\agent-inbox\\op-2.json');
    fake.emit('C:\\planner-data\\agent-inbox\\op-2.json');
    fake.emit('C:\\planner-data\\agent-inbox\\op-2.json');

    const received = logger.log.mock.calls
      .filter((c) => typeof c[0] === 'string' && c[0].includes('agent op received'));
    expect(received).toHaveLength(1);

    // After the window elapses the same path is accepted again.
    vi.advanceTimersByTime(__TEST_ONLY__.DEDUPE_WINDOW_MS + 10);
    fake.emit('C:\\planner-data\\agent-inbox\\op-2.json');
    const receivedAfter = logger.log.mock.calls
      .filter((c) => typeof c[0] === 'string' && c[0].includes('agent op received'));
    expect(receivedAfter).toHaveLength(2);
  });

  it('different paths are not deduped against each other', async () => {
    const fake = makeFakeEventApi();
    const logger = makeSilentLogger();
    const sync = new AgentSync({}, { eventApi: fake.api, logger });
    await sync.start();

    fake.emit('/planner-data/agent-inbox/a.json');
    fake.emit('/planner-data/agent-inbox/b.json');

    const received = logger.log.mock.calls
      .filter((c) => typeof c[0] === 'string' && c[0].includes('agent op received'));
    expect(received).toHaveLength(2);
  });

  it('ignores events whose payload is not a non-empty string', async () => {
    const fake = makeFakeEventApi();
    const logger = makeSilentLogger();
    const sync = new AgentSync({}, { eventApi: fake.api, logger });
    await sync.start();

    fake.emit(null);
    fake.emit('');
    fake.emit(42);
    fake.emit({ path: 'x.json' });

    const received = logger.log.mock.calls
      .filter((c) => typeof c[0] === 'string' && c[0].includes('agent op received'));
    expect(received).toHaveLength(0);
  });

  it('start() is idempotent', async () => {
    const fake = makeFakeEventApi();
    const sync = new AgentSync({}, { eventApi: fake.api, logger: makeSilentLogger() });

    await sync.start();
    await sync.start();
    await sync.start();

    expect(fake.api.listen).toHaveBeenCalledTimes(1);
  });

  it('routes prose.ingest envelopes to the prose handler and archives both self + spawned bulk', async () => {
    vi.useRealTimers();           // _processInbox is async; avoid fake-timer race
    const fake = makeFakeEventApi();
    const adapter = makeFakeAdapter();
    const inboxPath = '/planner-data/agent-inbox/op-prose-1.json';
    adapter.reads.set(inboxPath, JSON.stringify({
      opId: 'op-prose-1',
      type: 'prose.ingest',
      payload: { content: 'do the thing', sourceLabel: 'fixture' },
    }));

    const proseIngestHandler = vi.fn(async (envelope, { now }) => ({
      self: {
        status: 'applied',
        appliedAt: now(),
        diff: { ingest: { queuedBulkOpId: 'op-bulk-spawned-1', candidateCount: 3 } },
        error: null,
      },
      spawned: {
        envelope: {
          opId: 'op-bulk-spawned-1',
          type: 'bulk',
          actor: 'prose-ingest',
          spawnedFromOpId: envelope.opId,
          payload: {
            ops: [
              { type: 'project.add', payload: { project: { id: 'proj-x', name: 'X' } } },
              { type: 'task.add',    payload: { task:    { id: 'task-x1', sprintId: 'sprint-x', title: 'A' } } },
            ],
          },
        },
        reason: 'prose-ingest',
      },
    }));

    const sync = new AgentSync(
      { getState: () => ({ obsidianConfig: { plannerDataPath: '/planner-data' } }) },
      {
        eventApi: fake.api,
        adapter,
        logger: makeSilentLogger(),
        proseIngestHandler,
        plannerDataPathProvider: () => '/planner-data',
        now: () => 5_000_000,
      },
    );

    await sync.start();
    fake.emit(inboxPath);

    // Allow the async _processInbox chain to settle.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(proseIngestHandler).toHaveBeenCalledTimes(1);
    expect(proseIngestHandler.mock.calls[0][0].opId).toBe('op-prose-1');

    // Two archive writes: prose.ingest (applied) + spawned bulk (queued).
    expect(adapter.writes).toHaveLength(2);
    const appliedWrite = adapter.writes.find((w) => w.rel.startsWith('agent-archive/applied/'));
    const queuedWrite  = adapter.writes.find((w) => w.rel.startsWith('agent-archive/queued/'));
    expect(appliedWrite).toBeTruthy();
    expect(queuedWrite).toBeTruthy();

    const appliedJson = JSON.parse(appliedWrite.content);
    expect(appliedJson.opId).toBe('op-prose-1');
    expect(appliedJson.result.status).toBe('applied');
    expect(appliedJson.result.diff.ingest.queuedBulkOpId).toBe('op-bulk-spawned-1');

    const queuedJson = JSON.parse(queuedWrite.content);
    expect(queuedJson.opId).toBe('op-bulk-spawned-1');
    expect(queuedJson.type).toBe('bulk');
    expect(queuedJson.spawnedFromOpId).toBe('op-prose-1');
    expect(queuedJson.result.status).toBe('queued');
    expect(queuedJson.result.reason).toBe('prose-ingest');

    // Two op-log lines (one per archived envelope), plus the agent-sync.start
    // heartbeat that start() always emits. Filter the heartbeat out for the
    // count assertion since it's not the behavior under test here.
    const opLogs = adapter.appends.filter((a) => {
      try { return JSON.parse(a.content)?.type !== 'agent-sync.start'; }
      catch { return true; }
    });
    expect(opLogs).toHaveLength(2);
    // Inbox file removed.
    expect(adapter.removes).toContain(inboxPath);
  });

  it('archives prose.ingest as rejected and writes no spawned bulk when handler returns rejection', async () => {
    vi.useRealTimers();
    const fake = makeFakeEventApi();
    const adapter = makeFakeAdapter();
    const inboxPath = '/planner-data/agent-inbox/op-prose-2.json';
    adapter.reads.set(inboxPath, JSON.stringify({
      opId: 'op-prose-2',
      type: 'prose.ingest',
      payload: { content: '   ' },
    }));

    const proseIngestHandler = vi.fn(async () => ({
      self: {
        status: 'rejected',
        rejectedAt: 1234,
        error: { kind: 'validation', message: 'empty content' },
        diff: null,
      },
      spawned: null,
    }));

    const sync = new AgentSync(
      { getState: () => ({}) },
      { eventApi: fake.api, adapter, logger: makeSilentLogger(), proseIngestHandler, plannerDataPathProvider: () => '/data', now: () => 1234 },
    );
    await sync.start();
    fake.emit(inboxPath);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(adapter.writes).toHaveLength(1);
    expect(adapter.writes[0].rel).toMatch(/^agent-archive\/rejected\//);
    const json = JSON.parse(adapter.writes[0].content);
    expect(json.result.status).toBe('rejected');
    expect(json.result.error.kind).toBe('validation');
    expect(adapter.removes).toContain(inboxPath);
  });

  // ── Startup drain ─────────────────────────────────────────────────────
  // The Rust watcher only emits events for FS changes that happen while
  // it's running. Files placed in agent-inbox/ before subscribe (or that
  // the watcher missed) would otherwise sit forever — that was the cause
  // of the two stale April 2026 files in the bug report.
  describe('startup drain', () => {
    it('processes pre-existing inbox files on start() once hydrated', async () => {
      vi.useRealTimers();
      const fake = makeFakeEventApi();
      const logger = makeSilentLogger();
      const path1 = '/planner-data/agent-inbox/2026-04-28T01-11-48Z__bulk__op-A.json';
      const path2 = '/planner-data/agent-inbox/2026-04-29T22-01-18Z__bulk__op-B.json';
      const adapter = makeFakeAdapter({
        inboxList: [
          { name: '2026-04-28T01-11-48Z__bulk__op-A.json', absPath: path1, modifiedAt: 1 },
          { name: '2026-04-29T22-01-18Z__bulk__op-B.json', absPath: path2, modifiedAt: 2 },
        ],
      });
      adapter.reads.set(path1, JSON.stringify({ opId: 'op-A', type: 'task.update', payload: { id: 'task-1', patch: { status: 'done' } } }));
      adapter.reads.set(path2, JSON.stringify({ opId: 'op-B', type: 'task.update', payload: { id: 'task-2', patch: { status: 'done' } } }));
      const store = makeStubStore();

      const sync = new AgentSync(store, { eventApi: fake.api, adapter, logger });
      await sync.start();
      await flushMicrotasks();

      expect(adapter.listAgentFiles).toHaveBeenCalledWith('agent-inbox', expect.anything(), { ext: '.json' });
      expect(store._agentBulkApply).toHaveBeenCalledTimes(2);
      expect(adapter.removes).toEqual(expect.arrayContaining([path1, path2]));
    });

    it('logs and exits cleanly when the inbox is empty', async () => {
      vi.useRealTimers();
      const fake = makeFakeEventApi();
      const logger = makeSilentLogger();
      const adapter = makeFakeAdapter({ inboxList: [] });
      const store = makeStubStore();

      const sync = new AgentSync(store, { eventApi: fake.api, adapter, logger });
      await sync.start();
      await flushMicrotasks();

      expect(adapter.listAgentFiles).toHaveBeenCalledTimes(1);
      expect(store._agentBulkApply).not.toHaveBeenCalled();
      expect(adapter.removes).toEqual([]);
      const logged = logger.log.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).toMatch(/inbox is empty/);
    });

    it('skips .tmp and dotfiles to mirror the Rust watcher filter', async () => {
      vi.useRealTimers();
      const fake = makeFakeEventApi();
      const logger = makeSilentLogger();
      const realPath = '/planner-data/agent-inbox/op-real.json';
      const tmpPath = '/planner-data/agent-inbox/op-stale.json.tmp';
      const dotPath = '/planner-data/agent-inbox/.hidden.json';
      const adapter = makeFakeAdapter({
        inboxList: [
          { name: 'op-real.json', absPath: realPath, modifiedAt: 1 },
          { name: 'op-stale.json.tmp', absPath: tmpPath, modifiedAt: 2 },
          { name: '.hidden.json', absPath: dotPath, modifiedAt: 3 },
        ],
      });
      adapter.reads.set(realPath, JSON.stringify({ opId: 'op-real', type: 'task.update', payload: { id: 't', patch: {} } }));
      const store = makeStubStore();

      const sync = new AgentSync(store, { eventApi: fake.api, adapter, logger });
      await sync.start();
      await flushMicrotasks();

      expect(store._agentBulkApply).toHaveBeenCalledTimes(1);
      // tmp/dot files were never read.
      expect(adapter.readAgentFile).toHaveBeenCalledWith(realPath);
      expect(adapter.readAgentFile).not.toHaveBeenCalledWith(tmpPath);
      expect(adapter.readAgentFile).not.toHaveBeenCalledWith(dotPath);
    });

    it('waits for store._hydrated before draining', async () => {
      vi.useRealTimers();
      const fake = makeFakeEventApi();
      const logger = makeSilentLogger();
      const path = '/planner-data/agent-inbox/op-1.json';
      const adapter = makeFakeAdapter({
        inboxList: [{ name: 'op-1.json', absPath: path, modifiedAt: 1 }],
      });
      adapter.reads.set(path, JSON.stringify({ opId: 'op-1', type: 'task.update', payload: { id: 't', patch: {} } }));
      const store = makeStubStore({ hydrated: false });

      const sync = new AgentSync(store, { eventApi: fake.api, adapter, logger });
      const startPromise = sync.start();
      // Listen subscribed but no drain yet — store still hydrating.
      await flushMicrotasks();
      expect(adapter.listAgentFiles).not.toHaveBeenCalled();
      expect(store._agentBulkApply).not.toHaveBeenCalled();

      // Hydrate the store; drain proceeds.
      store.setHydrated();
      await startPromise;
      await flushMicrotasks();

      expect(adapter.listAgentFiles).toHaveBeenCalledTimes(1);
      expect(store._agentBulkApply).toHaveBeenCalledTimes(1);
    });

    it('deduplicates against watcher events for the same path', async () => {
      vi.useRealTimers();
      const fake = makeFakeEventApi();
      const logger = makeSilentLogger();
      const path = '/planner-data/agent-inbox/op-dup.json';
      const adapter = makeFakeAdapter({
        inboxList: [{ name: 'op-dup.json', absPath: path, modifiedAt: 1 }],
      });
      adapter.reads.set(path, JSON.stringify({ opId: 'op-dup', type: 'task.update', payload: { id: 't', patch: {} } }));
      const store = makeStubStore();

      const sync = new AgentSync(store, { eventApi: fake.api, adapter, logger });
      await sync.start();
      // Watcher fires for the same path the drain just handled.
      fake.emit(path);
      await flushMicrotasks();

      // Should only have applied once.
      expect(store._agentBulkApply).toHaveBeenCalledTimes(1);
    });

    it('continues draining when one file fails to process', async () => {
      vi.useRealTimers();
      const fake = makeFakeEventApi();
      const logger = makeSilentLogger();
      const goodPath = '/planner-data/agent-inbox/op-good.json';
      const badPath = '/planner-data/agent-inbox/op-bad.json';
      const adapter = makeFakeAdapter({
        inboxList: [
          { name: 'op-bad.json', absPath: badPath, modifiedAt: 1 },
          { name: 'op-good.json', absPath: goodPath, modifiedAt: 2 },
        ],
      });
      // bad: malformed JSON, good: valid op.
      adapter.reads.set(badPath, '{ this is not valid json');
      adapter.reads.set(goodPath, JSON.stringify({ opId: 'op-good', type: 'task.update', payload: { id: 't', patch: {} } }));
      const store = makeStubStore();

      const sync = new AgentSync(store, { eventApi: fake.api, adapter, logger });
      await sync.start();
      await flushMicrotasks();

      // bad gets archived as malformed-rejection; good gets applied.
      expect(store._agentBulkApply).toHaveBeenCalledTimes(1);
      const malformedWrite = adapter.writes.find((w) => w.rel.includes('agent-archive/rejected/'));
      expect(malformedWrite).toBeTruthy();
      expect(adapter.removes).toEqual(expect.arrayContaining([goodPath, badPath]));
    });
  });

  it('stop() unsubscribes and clears dedupe state', async () => {
    const fake = makeFakeEventApi();
    const logger = makeSilentLogger();
    const sync = new AgentSync({}, { eventApi: fake.api, logger });
    await sync.start();
    expect(fake.hasHandler).toBe(true);

    sync.stop();
    expect(fake.hasHandler).toBe(false);

    // After stop, subsequent start() re-subscribes cleanly.
    await sync.start();
    expect(fake.hasHandler).toBe(true);
    expect(fake.api.listen).toHaveBeenCalledTimes(2);
  });
});
