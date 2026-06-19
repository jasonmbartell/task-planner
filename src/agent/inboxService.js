/**
 * AgentInboxService — drives the Milestone 4 inbox review UI.
 *
 * Queued ops land in `$PLANNER_DATA_DIR/agent-archive/queued/` via the
 * AgentSync apply path when the trust matrix or staleness check says
 * "don't auto-apply". This service
 * watches that directory, exposes the envelopes to React via a pub-sub,
 * and implements the Approve / Reject transitions:
 *
 *   Approve → `_agentBulkApply(envelope, { forceApply: true })`.
 *             On success, archive to `applied/`; otherwise `rejected/`.
 *             Remove the queued file in either case.
 *
 *   Reject  → Archive the envelope to `rejected/` with
 *             `error.kind: "user_rejected"`. Remove the queued file.
 *
 * In the browser build, adapter calls return empty and the service stays
 * quiet — Milestone 6 will add an explicit import fallback.
 *
 * Pure-ish: all I/O goes through the injected adapter, so vitest can
 * drive the full lifecycle with an in-memory double.
 */

import { isTauri } from '../utils/platform.js';
import { getObsidianAdapter } from '../utils/obsidianAdapter.js';

const QUEUED_DIR = 'agent-archive/queued';
const APPLIED_DIR = 'agent-archive/applied';
const REJECTED_DIR = 'agent-archive/rejected';
const LOG_DIR = 'agent-log';

const DEFAULT_POLL_INTERVAL_MS = 5000;

function isoFileTimestamp(ms) {
  // Windows-safe: no colons.
  return new Date(ms).toISOString().replace(/:/g, '-');
}

function safeOpId(opId) {
  if (typeof opId !== 'string' || !opId) return 'unknown';
  return opId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
}

export class AgentInboxService {
  constructor(store, {
    adapter = null,
    logger = null,
    now = null,
    plannerDataPathProvider = null,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = {}) {
    this.store = store;
    this._adapter = adapter;
    this._logger = logger || console;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._pollIntervalMs = pollIntervalMs;
    this._plannerDataPathProvider = plannerDataPathProvider || (() => {
      try { return store?.getState?.()?.obsidianConfig?.plannerDataPath || ''; }
      catch { return ''; }
    });

    this._queued = [];          // [{ name, absPath, envelope, modifiedAt, queuedAt, reason }]
    this._subscribers = new Set();
    this._pollHandle = null;
    this._refreshInFlight = null;
    this._started = false;
  }

  async _resolveAdapter() {
    if (this._adapter) return this._adapter;
    if (!isTauri()) return null;
    this._adapter = await getObsidianAdapter();
    return this._adapter;
  }

  /** Begin polling. Idempotent. Returns the initial refresh promise. */
  async start() {
    if (this._started) return this.refresh();
    this._started = true;
    if (this._pollIntervalMs > 0) {
      this._pollHandle = setInterval(() => {
        this.refresh().catch((err) => {
          this._logger.error?.('[agent-inbox] poll refresh failed:', err);
        });
      }, this._pollIntervalMs);
    }
    return this.refresh();
  }

  stop() {
    if (this._pollHandle) {
      clearInterval(this._pollHandle);
      this._pollHandle = null;
    }
    this._subscribers.clear();
    this._started = false;
  }

  getQueued() { return this._queued.slice(); }
  getCount() { return this._queued.length; }

  /**
   * Subscribe to queued-list updates. Returns an unsubscribe fn. The callback
   * is invoked immediately with the current list so consumers can prime state.
   */
  subscribe(cb) {
    if (typeof cb !== 'function') return () => {};
    this._subscribers.add(cb);
    try { cb(this.getQueued()); } catch (err) {
      this._logger.error?.('[agent-inbox] subscriber threw:', err);
    }
    return () => this._subscribers.delete(cb);
  }

  _notify() {
    const snap = this.getQueued();
    for (const cb of this._subscribers) {
      try { cb(snap); } catch (err) {
        this._logger.error?.('[agent-inbox] subscriber threw during notify:', err);
      }
    }
  }

  /**
   * Re-read the queued directory. Coalesces concurrent calls so we don't
   * stack up reads on a slow disk or during a flurry of approvals.
   */
  async refresh() {
    if (this._refreshInFlight) return this._refreshInFlight;
    this._refreshInFlight = (async () => {
      const adapter = await this._resolveAdapter();
      if (!adapter || typeof adapter.listAgentFiles !== 'function') {
        this._queued = [];
        this._notify();
        return this._queued;
      }
      const plannerDataPath = this._plannerDataPathProvider();
      let entries = [];
      try {
        entries = await adapter.listAgentFiles(QUEUED_DIR, plannerDataPath);
      } catch (err) {
        this._logger.error?.('[agent-inbox] listAgentFiles failed:', err);
        entries = [];
      }
      const parsed = [];
      for (const entry of entries) {
        try {
          const raw = await adapter.readAgentFile(entry.absPath);
          if (typeof raw !== 'string' || !raw.trim()) continue;
          const envelope = JSON.parse(raw);
          parsed.push({
            name: entry.name,
            absPath: entry.absPath,
            modifiedAt: entry.modifiedAt,
            envelope,
            queuedAt: envelope?.result?.queuedAt ?? entry.modifiedAt ?? 0,
            reason: envelope?.result?.reason ?? null,
          });
        } catch (err) {
          this._logger.warn?.('[agent-inbox] skipping unreadable queued file:', entry.absPath, err);
        }
      }
      parsed.sort((a, b) => (b.queuedAt || 0) - (a.queuedAt || 0));
      this._queued = parsed;
      this._notify();
      return this._queued;
    })();
    try { return await this._refreshInFlight; }
    finally { this._refreshInFlight = null; }
  }

  /**
   * Approve one queued envelope. If `edited` is provided it replaces the
   * envelope body (minus any prior `result`) before re-applying. Returns
   * the apply result (`{ status, ... }`).
   */
  async approve(absPath, edited = null) {
    const item = this._queued.find((q) => q.absPath === absPath);
    if (!item) throw new Error(`inbox: no queued op at ${absPath}`);
    const adapter = await this._resolveAdapter();
    if (!adapter) throw new Error('inbox: no adapter available');

    const envelopeToApply = edited
      ? this._stripResult(edited)
      : this._stripResult(item.envelope);

    const state = this.store.getState();
    if (typeof state._agentBulkApply !== 'function') {
      throw new Error('inbox: store does not expose _agentBulkApply');
    }

    let result;
    try {
      result = state._agentBulkApply(envelopeToApply, { forceApply: true, now: this._now() });
    } catch (err) {
      result = { status: 'rejected', error: { kind: 'internal', message: String(err?.message || err) } };
    }

    const now = this._now();
    const archived = this._buildArchivedEnvelope(envelopeToApply, result, now, { approvedFromQueue: true });
    await this._writeArchive(adapter, archived, result.status, now);
    await this._appendLog(adapter, archived, now);
    await this._removeQueued(adapter, absPath);
    await this.refresh();
    return result;
  }

  /**
   * Reject one queued envelope. Writes the envelope to `rejected/` with
   * `error.kind: "user_rejected"`, removes the queued file, logs it.
   */
  async reject(absPath, { reason = '' } = {}) {
    const item = this._queued.find((q) => q.absPath === absPath);
    if (!item) throw new Error(`inbox: no queued op at ${absPath}`);
    const adapter = await this._resolveAdapter();
    if (!adapter) throw new Error('inbox: no adapter available');

    const now = this._now();
    const base = this._stripResult(item.envelope);
    const archived = {
      ...base,
      result: {
        status: 'rejected',
        rejectedAt: now,
        diff: null,
        error: {
          kind: 'user_rejected',
          message: reason || 'Rejected by user from inbox review.',
        },
      },
    };
    await this._writeArchive(adapter, archived, 'rejected', now);
    await this._appendLog(adapter, archived, now);
    await this._removeQueued(adapter, absPath);
    await this.refresh();
    return archived;
  }

  _stripResult(envelope) {
    if (!envelope || typeof envelope !== 'object') return envelope;
    // eslint-disable-next-line no-unused-vars
    const { result, ...rest } = envelope;
    return rest;
  }

  _buildArchivedEnvelope(envelope, result, now, extras = {}) {
    const resultBlock = { status: result.status, ...extras };
    if (result.status === 'applied') {
      resultBlock.appliedAt = result.appliedAt ?? now;
      resultBlock.diff = result.diff ?? null;
      resultBlock.error = null;
    } else if (result.status === 'queued') {
      // Unusual path — approve re-queued (e.g. user edited in an unknown op).
      resultBlock.queuedAt = now;
      resultBlock.reason = result.reason ?? null;
      resultBlock.error = null;
    } else {
      resultBlock.rejectedAt = now;
      resultBlock.error = result.error ?? { kind: 'unknown', message: 'unspecified rejection' };
      resultBlock.diff = null;
    }
    return { ...envelope, result: resultBlock };
  }

  async _writeArchive(adapter, archived, status, now) {
    const subdir =
      status === 'applied' ? APPLIED_DIR :
      status === 'queued'  ? QUEUED_DIR  : REJECTED_DIR;
    const stamp = isoFileTimestamp(now);
    const rel = `${subdir}/${stamp}__${safeOpId(archived?.opId)}.json`;
    try {
      await adapter.writeAgentFile(rel, JSON.stringify(archived, null, 2), this._plannerDataPathProvider());
    } catch (err) {
      this._logger.error?.('[agent-inbox] failed to write archive entry:', rel, err);
    }
  }

  async _appendLog(adapter, archived, now) {
    if (typeof adapter.appendAgentFile !== 'function') return;
    const dateStr = new Date(now).toISOString().slice(0, 10);
    const rel = `${LOG_DIR}/${dateStr}.jsonl`;
    try {
      await adapter.appendAgentFile(rel, JSON.stringify(archived) + '\n', this._plannerDataPathProvider());
    } catch (err) {
      this._logger.error?.('[agent-inbox] failed to append log line:', rel, err);
    }
  }

  async _removeQueued(adapter, absPath) {
    if (typeof adapter.removeAgentFile !== 'function') return;
    try {
      await adapter.removeAgentFile(absPath);
    } catch (err) {
      this._logger.error?.('[agent-inbox] failed to remove queued file:', absPath, err);
    }
  }
}

export const __TEST_ONLY__ = {
  QUEUED_DIR, APPLIED_DIR, REJECTED_DIR, LOG_DIR,
  DEFAULT_POLL_INTERVAL_MS, isoFileTimestamp, safeOpId,
};
