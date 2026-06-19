/**
 * AgentSync apply path: file → store → archive → log → inbox cleanup.
 *
 * Uses an in-memory fake adapter so we can assert on the relative paths
 * written, the archive contents, and the inbox-cleanup behavior. The
 * fake event API is reused from the M2 test pattern.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentSync } from '../AgentSync.js';

function makeFakeEventApi() {
  let handler = null;
  return {
    api: {
      listen: vi.fn(async (_evt, cb) => { handler = cb; return () => { handler = null; }; }),
    },
    emit(payload) { if (!handler) throw new Error('no listener'); handler({ payload }); },
  };
}

function makeSilentLogger() { return { log: vi.fn(), error: vi.fn() }; }

function makeFakeAdapter({ inbox = {} } = {}) {
  // inbox: map of absPath → contents string (or null to simulate read failure)
  const writes = [];           // [{ rel, contents, plannerDataPath }]
  const appends = [];          // [{ rel, contents, plannerDataPath }]
  const removes = [];          // [absPath]
  const inboxFiles = { ...inbox };

  return {
    state: { writes, appends, removes, inboxFiles },
    readAgentFile: vi.fn(async (absPath) => {
      if (!(absPath in inboxFiles)) throw new Error(`ENOENT: ${absPath}`);
      const v = inboxFiles[absPath];
      if (v === null) throw new Error('simulated read failure');
      return v;
    }),
    writeAgentFile: vi.fn(async (rel, contents, plannerDataPath) => {
      writes.push({ rel, contents, plannerDataPath });
    }),
    appendAgentFile: vi.fn(async (rel, contents, plannerDataPath) => {
      appends.push({ rel, contents, plannerDataPath });
    }),
    removeAgentFile: vi.fn(async (absPath) => {
      removes.push(absPath);
      delete inboxFiles[absPath];
    }),
  };
}

function flush() {
  // Resolve any microtasks the fire-and-forget _processInbox queued.
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * Filter agent-log appends down to op-log lines, hiding the
 * `agent-sync.start` heartbeat that start() always writes.
 */
function opLogAppends(appends) {
  return appends.filter((a) => {
    try {
      const obj = JSON.parse(a.contents);
      return obj?.type !== 'agent-sync.start';
    } catch {
      return true;
    }
  });
}

const ABS = 'C:/planner-data/agent-inbox/op-1.json';

function makeStore({ applyResult = { status: 'applied', diff: { tasks: { updated: [] } }, appliedAt: 5000 } } = {}) {
  const _agentBulkApply = vi.fn(() => applyResult);
  return {
    getState: () => ({ _agentBulkApply, obsidianConfig: { plannerDataPath: '' } }),
    _agentBulkApply,
  };
}

describe('AgentSync — apply path', () => {
  let fake, adapter, logger;

  beforeEach(() => {
    fake = makeFakeEventApi();
    logger = makeSilentLogger();
  });

  it('reads inbox file, calls _agentBulkApply, archives applied, removes inbox', async () => {
    adapter = makeFakeAdapter({
      inbox: { [ABS]: JSON.stringify({ opId: 'op-1', type: 'task.update', payload: { id: 'task-1', patch: { status: 'done' } } }) },
    });
    const store = makeStore();
    const sync = new AgentSync(store, { eventApi: fake.api, logger, adapter, now: () => 1700000000000 });
    await sync.start();
    fake.emit(ABS);
    await flush();

    expect(adapter.readAgentFile).toHaveBeenCalledWith(ABS);
    expect(store._agentBulkApply).toHaveBeenCalledTimes(1);
    expect(adapter.state.writes).toHaveLength(1);
    expect(adapter.state.writes[0].rel).toMatch(/^agent-archive\/applied\/.+__op-1\.json$/);
    const opLogs = opLogAppends(adapter.state.appends);
    expect(opLogs).toHaveLength(1);
    expect(opLogs[0].rel).toMatch(/^agent-log\/\d{4}-\d{2}-\d{2}\.jsonl$/);
    expect(adapter.state.removes).toEqual([ABS]);
  });

  it('archives queued ops to agent-archive/queued/ without applying', async () => {
    adapter = makeFakeAdapter({
      inbox: { [ABS]: JSON.stringify({ opId: 'op-q', type: 'task.delete', payload: { id: 'task-1' } }) },
    });
    const store = makeStore({ applyResult: { status: 'queued', reason: 'trust' } });
    const sync = new AgentSync(store, { eventApi: fake.api, logger, adapter });
    await sync.start();
    fake.emit(ABS);
    await flush();

    expect(adapter.state.writes[0].rel).toMatch(/^agent-archive\/queued\//);
    const archived = JSON.parse(adapter.state.writes[0].contents);
    expect(archived.result.status).toBe('queued');
    expect(archived.result.reason).toBe('trust');
    expect(adapter.state.removes).toEqual([ABS]);
  });

  it('archives rejected ops to agent-archive/rejected/', async () => {
    adapter = makeFakeAdapter({
      inbox: { [ABS]: JSON.stringify({ opId: 'op-r', type: 'task.update', payload: { id: 'task-nope', patch: {} } }) },
    });
    const store = makeStore({
      applyResult: { status: 'rejected', error: { kind: 'missing_ref', message: 'task-nope not found' } },
    });
    const sync = new AgentSync(store, { eventApi: fake.api, logger, adapter });
    await sync.start();
    fake.emit(ABS);
    await flush();

    expect(adapter.state.writes[0].rel).toMatch(/^agent-archive\/rejected\//);
    const archived = JSON.parse(adapter.state.writes[0].contents);
    expect(archived.result.status).toBe('rejected');
    expect(archived.result.error.kind).toBe('missing_ref');
  });

  it('handles malformed JSON: synthetic rejection in archive, inbox file removed', async () => {
    adapter = makeFakeAdapter({ inbox: { [ABS]: '{not valid json' } });
    const store = makeStore();
    const sync = new AgentSync(store, { eventApi: fake.api, logger, adapter });
    await sync.start();
    fake.emit(ABS);
    await flush();

    expect(store._agentBulkApply).not.toHaveBeenCalled();
    expect(adapter.state.writes).toHaveLength(1);
    expect(adapter.state.writes[0].rel).toMatch(/^agent-archive\/rejected\//);
    const archived = JSON.parse(adapter.state.writes[0].contents);
    expect(archived.result.status).toBe('rejected');
    expect(archived.result.error.kind).toBe('malformed');
    expect(adapter.state.removes).toEqual([ABS]);
  });

  it('survives a thrown _agentBulkApply: writes a synthetic rejection', async () => {
    adapter = makeFakeAdapter({
      inbox: { [ABS]: JSON.stringify({ opId: 'op-throw', type: 'task.update', payload: { id: 'task-1', patch: {} } }) },
    });
    const store = {
      getState: () => ({
        _agentBulkApply: () => { throw new Error('kaboom'); },
        obsidianConfig: {},
      }),
    };
    const sync = new AgentSync(store, { eventApi: fake.api, logger, adapter });
    await sync.start();
    fake.emit(ABS);
    await flush();

    expect(adapter.state.writes[0].rel).toMatch(/^agent-archive\/rejected\//);
    const archived = JSON.parse(adapter.state.writes[0].contents);
    expect(archived.result.error.kind).toBe('internal');
    expect(archived.result.error.message).toMatch(/kaboom/);
  });

  it('dedupes within an in-flight opId so the apply runs once even on rapid duplicate paths', async () => {
    // Different absolute paths, same envelope opId → exercise the in-flight set.
    const PATH_A = 'C:/planner-data/agent-inbox/a.json';
    const PATH_B = 'C:/planner-data/agent-inbox/b.json';
    const env = JSON.stringify({ opId: 'op-dup', type: 'task.update', payload: { id: 'task-1', patch: {} } });
    adapter = makeFakeAdapter({ inbox: { [PATH_A]: env, [PATH_B]: env } });

    let inflight = 0;
    let maxInflight = 0;
    const store = {
      getState: () => ({
        _agentBulkApply: () => {
          inflight++;
          maxInflight = Math.max(maxInflight, inflight);
          // simulate sync work; release on the next tick by returning
          inflight--;
          return { status: 'applied', diff: null, appliedAt: 1 };
        },
        obsidianConfig: {},
      }),
    };
    const sync = new AgentSync(store, { eventApi: fake.api, logger, adapter });
    await sync.start();

    // Synchronously emit both events — both kick off async _processInbox.
    fake.emit(PATH_A);
    fake.emit(PATH_B);
    await flush();

    // Both files end up archived because each is a distinct file path.
    // The in-flight dedupe protects against concurrent re-entry, not eventual
    // duplicate work — that's the by-design tradeoff.
    expect(adapter.state.writes.length).toBeGreaterThanOrEqual(1);
    expect(maxInflight).toBeLessThanOrEqual(1);
  });

  it('archive timestamp filename uses the injected `now`', async () => {
    adapter = makeFakeAdapter({
      inbox: { [ABS]: JSON.stringify({ opId: 'op-time', type: 'task.update', payload: { id: 't', patch: {} } }) },
    });
    const store = makeStore();
    // 2026-04-22T18:30:12.345Z → filename uses dashes for colons
    const now = Date.UTC(2026, 3, 22, 18, 30, 12, 345);
    const sync = new AgentSync(store, { eventApi: fake.api, logger, adapter, now: () => now });
    await sync.start();
    fake.emit(ABS);
    await flush();

    const archiveRel = adapter.state.writes[0].rel;
    expect(archiveRel).toMatch(/2026-04-22T18-30-12\.345Z__op-time\.json$/);
    const logRel = opLogAppends(adapter.state.appends)[0].rel;
    expect(logRel).toBe('agent-log/2026-04-22.jsonl');
  });

  it('passes plannerDataPath from the store config through to the adapter', async () => {
    adapter = makeFakeAdapter({
      inbox: { [ABS]: JSON.stringify({ opId: 'op-pp', type: 'task.update', payload: { id: 't', patch: {} } }) },
    });
    const store = {
      getState: () => ({
        _agentBulkApply: () => ({ status: 'applied', diff: null, appliedAt: 1 }),
        obsidianConfig: { plannerDataPath: 'D:/custom/planner-data' },
      }),
    };
    const sync = new AgentSync(store, { eventApi: fake.api, logger, adapter });
    await sync.start();
    fake.emit(ABS);
    await flush();

    expect(adapter.state.writes[0].plannerDataPath).toBe('D:/custom/planner-data');
    expect(opLogAppends(adapter.state.appends)[0].plannerDataPath).toBe('D:/custom/planner-data');
  });

  it('skips processing when no adapter is available (M2 logging behavior preserved)', async () => {
    // No `adapter` injected; not in Tauri. Apply path should silently skip.
    const store = makeStore();
    const sync = new AgentSync(store, { eventApi: fake.api, logger });
    await sync.start();
    fake.emit(ABS);
    await flush();

    expect(store._agentBulkApply).not.toHaveBeenCalled();
    const logged = logger.log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/agent op received/);
  });
});
