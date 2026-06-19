/**
 * AgentDigestService — date-keyed reads of `agent-log/*.jsonl`, coalescing
 * lifecycle lines into a single terminal-status entry per opId, and graceful
 * degradation when the log file is missing or malformed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AgentDigestService,
  dateKeysBackFrom,
  parseJsonlBody,
  buildEntry,
  coalesceByOpId,
} from '../digestService.js';

function makeStore({ plannerDataPath = '' } = {}) {
  return {
    getState: () => ({ obsidianConfig: { plannerDataPath } }),
  };
}

function makeLogAdapter({ files = {} } = {}) {
  // files: { 'YYYY-MM-DD': 'line1\nline2\n' }
  const listCalls = [];
  return {
    state: { listCalls },
    listAgentFiles: vi.fn(async (relDir, plannerDataPath, opts = {}) => {
      listCalls.push({ relDir, plannerDataPath, opts });
      if (relDir !== 'agent-log') return [];
      return Object.keys(files).map((dateKey, i) => ({
        name: `${dateKey}.jsonl`,
        absPath: `C:/planner-data/agent-log/${dateKey}.jsonl`,
        modifiedAt: 1_700_000_000_000 + i * 1000,
      }));
    }),
    readAgentFile: vi.fn(async (absPath) => {
      const m = /\/agent-log\/(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(absPath);
      if (!m) throw new Error(`ENOENT: ${absPath}`);
      const body = files[m[1]];
      if (body === undefined) throw new Error(`ENOENT: ${absPath}`);
      return body;
    }),
  };
}

function line(envelope) {
  return JSON.stringify(envelope) + '\n';
}

describe('dateKeysBackFrom', () => {
  it('returns `days` UTC date strings, newest first', () => {
    const now = Date.UTC(2026, 3, 23, 10, 0, 0); // 2026-04-23T10:00:00Z
    expect(dateKeysBackFrom(now, 3)).toEqual(['2026-04-23', '2026-04-22', '2026-04-21']);
  });

  it('handles a single day and zero-day edge', () => {
    expect(dateKeysBackFrom(Date.UTC(2026, 3, 23), 1)).toEqual(['2026-04-23']);
    expect(dateKeysBackFrom(Date.UTC(2026, 3, 23), 0)).toEqual([]);
  });

  it('is UTC-normalized — a late-evening local time still gets today UTC', () => {
    // 2026-04-23T23:59:59Z
    const now = Date.UTC(2026, 3, 23, 23, 59, 59);
    expect(dateKeysBackFrom(now, 1)[0]).toBe('2026-04-23');
  });

  it('returns [] for invalid input', () => {
    expect(dateKeysBackFrom(NaN, 7)).toEqual([]);
  });
});

describe('parseJsonlBody', () => {
  it('parses one-object-per-line jsonl', () => {
    const body = '{"a":1}\n{"a":2}\n';
    expect(parseJsonlBody(body)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('skips blank and malformed lines, calls onWarn for bad ones', () => {
    const body = '{"ok":true}\n\nnot-json\n{"ok":false}\n';
    const warns = [];
    const parsed = parseJsonlBody(body, (err, line) => warns.push(line));
    expect(parsed).toEqual([{ ok: true }, { ok: false }]);
    expect(warns).toEqual(['not-json']);
  });

  it('handles CRLF line endings', () => {
    const body = '{"a":1}\r\n{"a":2}\r\n';
    expect(parseJsonlBody(body)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('empty / non-string body → []', () => {
    expect(parseJsonlBody('')).toEqual([]);
    expect(parseJsonlBody(null)).toEqual([]);
    expect(parseJsonlBody(undefined)).toEqual([]);
  });
});

describe('buildEntry', () => {
  const baseEnv = {
    opId: 'op-1',
    type: 'task.update',
    createdAt: 1000,
    actor: 'claude/test',
    result: {
      status: 'applied',
      appliedAt: 2000,
      diff: {
        tasks: { updated: [{ id: 'task-abc', before: {}, after: {} }], added: [], deleted: [] },
        sprints: { added: [], updated: [], deleted: [] },
        projects: { added: [], updated: [], deleted: [] },
      },
    },
  };

  it('extracts the op fields and affected task ids', () => {
    const e = buildEntry(baseEnv, '2026-04-23');
    expect(e.opId).toBe('op-1');
    expect(e.type).toBe('task.update');
    expect(e.status).toBe('applied');
    expect(e.timestamp).toBe(2000);
    expect(e.actor).toBe('claude/test');
    expect(e.affected.tasks).toEqual(['task-abc']);
    expect(e.affected.sprints).toEqual([]);
    expect(e.affected.projects).toEqual([]);
  });

  it('prefers queuedAt when no appliedAt', () => {
    const env = { ...baseEnv, result: { status: 'queued', queuedAt: 3000, reason: 'trust' } };
    const e = buildEntry(env, '2026-04-23');
    expect(e.status).toBe('queued');
    expect(e.timestamp).toBe(3000);
    expect(e.reason).toBe('trust');
  });

  it('carries error block for rejected entries', () => {
    const env = { ...baseEnv, result: { status: 'rejected', rejectedAt: 4000, error: { kind: 'cycle', message: 'no' } } };
    const e = buildEntry(env, '2026-04-23');
    expect(e.status).toBe('rejected');
    expect(e.error).toEqual({ kind: 'cycle', message: 'no' });
    expect(e.timestamp).toBe(4000);
  });

  it('marks approvedFromQueue when present', () => {
    const env = { ...baseEnv, result: { ...baseEnv.result, approvedFromQueue: true } };
    expect(buildEntry(env, '2026-04-23').approvedFromQueue).toBe(true);
  });

  it('collects affected ids from all entity buckets + add/update/delete arrays', () => {
    const env = {
      opId: 'op-multi',
      type: 'bulk',
      result: {
        status: 'applied',
        appliedAt: 5000,
        diff: {
          projects: { added: [{ id: 'proj-1' }], updated: [], deleted: [] },
          sprints:  { added: [], updated: [{ id: 'sprint-1', before: {}, after: {} }], deleted: [] },
          tasks:    { added: [], updated: [], deleted: [{ id: 'task-del' }] },
        },
      },
    };
    const e = buildEntry(env, '2026-04-23');
    expect(e.affected.projects).toEqual(['proj-1']);
    expect(e.affected.sprints).toEqual(['sprint-1']);
    expect(e.affected.tasks).toEqual(['task-del']);
  });

  it('returns null for obviously unusable rows', () => {
    expect(buildEntry(null, '2026-04-23')).toBeNull();
    expect(buildEntry({}, '2026-04-23')).toBeNull();
  });
});

describe('coalesceByOpId', () => {
  function e(opId, status, timestamp) {
    return { opId, status, timestamp };
  }
  it('keeps terminal-status line when multiple exist for the same opId', () => {
    const queued   = e('op-x', 'queued',   1000);
    const applied  = e('op-x', 'applied',  2000);
    const result = coalesceByOpId([queued, applied]);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('applied');
  });

  it('prefers rejected over queued', () => {
    const queued   = e('op-y', 'queued',   1000);
    const rejected = e('op-y', 'rejected', 2000);
    expect(coalesceByOpId([queued, rejected])[0].status).toBe('rejected');
  });

  it('tie-breaks on timestamp when ranks match', () => {
    const aOld = e('op-z', 'applied', 1000);
    const aNew = e('op-z', 'applied', 2000);
    expect(coalesceByOpId([aOld, aNew])[0].timestamp).toBe(2000);
  });

  it('distinct opIds pass through unchanged', () => {
    const a = e('op-a', 'applied', 1);
    const b = e('op-b', 'rejected', 2);
    const out = coalesceByOpId([a, b]);
    expect(out).toHaveLength(2);
  });

  it('skips nulls (entries that buildEntry discarded)', () => {
    expect(coalesceByOpId([null, e('op-a', 'applied', 1), null])).toHaveLength(1);
  });
});

describe('AgentDigestService.loadDigest', () => {
  const NOW = Date.UTC(2026, 3, 23, 10, 0, 0); // 2026-04-23T10:00:00Z

  it('reads today + last N-1 days, newest first', async () => {
    const files = {
      '2026-04-23':
        line({ opId: 'a', type: 'task.update', result: { status: 'applied', appliedAt: NOW, diff: { tasks: { updated: [{ id: 't-1' }], added: [], deleted: [] } } } }) +
        line({ opId: 'b', type: 'task.add',    result: { status: 'applied', appliedAt: NOW - 3600_000, diff: { tasks: { added: [{ id: 't-2' }], updated: [], deleted: [] } } } }),
      '2026-04-22':
        line({ opId: 'c', type: 'task.delete', result: { status: 'applied', appliedAt: NOW - 86400_000, diff: { tasks: { deleted: [{ id: 't-3' }], added: [], updated: [] } } } }),
    };
    const adapter = makeLogAdapter({ files });
    const svc = new AgentDigestService(makeStore(), { adapter, now: () => NOW, days: 3 });

    const digest = await svc.loadDigest();

    expect(digest.map((d) => d.dateKey)).toEqual(['2026-04-23', '2026-04-22', '2026-04-21']);
    expect(digest[0].entries.map((e) => e.opId)).toEqual(['a', 'b']); // newest first
    expect(digest[0].counts).toEqual({ 'task.update': 1, 'task.add': 1 });
    expect(digest[1].entries.map((e) => e.opId)).toEqual(['c']);
    expect(digest[2].entries).toEqual([]);   // missing log file → empty day

    // Digest passed ext: '.jsonl' to the adapter.
    expect(adapter.state.listCalls[0].opts).toEqual({ ext: '.jsonl' });
  });

  it('coalesces duplicate opIds (queued then applied on the same day)', async () => {
    const files = {
      '2026-04-23':
        line({ opId: 'dup', type: 'task.delete', result: { status: 'queued',  queuedAt: NOW - 1000, reason: 'trust' } }) +
        line({ opId: 'dup', type: 'task.delete', result: { status: 'applied', appliedAt: NOW, diff: { tasks: { deleted: [{ id: 't-d' }], added: [], updated: [] } } } }),
    };
    const adapter = makeLogAdapter({ files });
    const svc = new AgentDigestService(makeStore(), { adapter, now: () => NOW, days: 1 });

    const [today] = await svc.loadDigest();
    expect(today.entries).toHaveLength(1);
    expect(today.entries[0].status).toBe('applied');
    expect(today.entries[0].affected.tasks).toEqual(['t-d']);
  });

  it('skips malformed lines but surfaces the rest', async () => {
    const files = {
      '2026-04-23':
        '{"opId":"good","type":"task.add","result":{"status":"applied","appliedAt":1}}\n' +
        'not-json-at-all\n' +
        '{"opId":"also-good","type":"task.update","result":{"status":"applied","appliedAt":2}}\n',
    };
    const adapter = makeLogAdapter({ files });
    const warn = vi.fn();
    const svc = new AgentDigestService(makeStore(), { adapter, logger: { warn, error: vi.fn() }, now: () => NOW, days: 1 });

    const [today] = await svc.loadDigest();
    expect(today.entries).toHaveLength(2);
    expect(today.entries.map((e) => e.opId).sort()).toEqual(['also-good', 'good']);
    expect(warn).toHaveBeenCalled();
  });

  it('missing adapter ⇒ empty days (no throw)', async () => {
    const svc = new AgentDigestService(makeStore(), { now: () => NOW, days: 2 });
    const digest = await svc.loadDigest();
    expect(digest).toHaveLength(2);
    for (const d of digest) expect(d.entries).toEqual([]);
  });

  it('forwards plannerDataPath from the store to the adapter', async () => {
    const adapter = makeLogAdapter({ files: {} });
    const svc = new AgentDigestService(makeStore({ plannerDataPath: 'D:/custom' }), { adapter, now: () => NOW, days: 1 });
    await svc.loadDigest();
    expect(adapter.state.listCalls[0].plannerDataPath).toBe('D:/custom');
  });

  it('per-call days override wins over constructor default', async () => {
    const adapter = makeLogAdapter({ files: {} });
    const svc = new AgentDigestService(makeStore(), { adapter, now: () => NOW, days: 8 });
    const digest = await svc.loadDigest({ days: 2 });
    expect(digest.map((d) => d.dateKey)).toEqual(['2026-04-23', '2026-04-22']);
  });

  it('ignores non-YYYY-MM-DD filenames returned by listAgentFiles', async () => {
    const adapter = {
      listAgentFiles: vi.fn(async () => [
        { name: 'README.md.jsonl', absPath: 'C:/planner-data/agent-log/README.md.jsonl', modifiedAt: 0 },
        { name: '2026-04-23.jsonl', absPath: 'C:/planner-data/agent-log/2026-04-23.jsonl', modifiedAt: 1 },
      ]),
      readAgentFile: vi.fn(async (p) => p.endsWith('2026-04-23.jsonl')
        ? line({ opId: 'z', type: 'task.add', result: { status: 'applied', appliedAt: NOW } })
        : 'garbage\n'),
    };
    const svc = new AgentDigestService(makeStore(), { adapter, now: () => NOW, days: 1 });
    const digest = await svc.loadDigest();
    // Only the real log file for 2026-04-23 contributes.
    expect(adapter.readAgentFile).toHaveBeenCalledTimes(1);
    expect(digest[0].entries.map((e) => e.opId)).toEqual(['z']);
  });
});
