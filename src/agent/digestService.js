/**
 * AgentDigestService — Milestone 5 reader for the daily agent digest view.
 *
 * Every op processed by `AgentSync._processInbox` (and every approve/reject
 * from `AgentInboxService`) appends one line to `agent-log/YYYY-MM-DD.jsonl`
 * containing the full archived envelope (CLAUDE_AGENT_PROTOCOL.md §6). The
 * digest surface reads those files for today + the previous N days and
 * presents a coherent "what did Claude do overnight?" view.
 *
 * The service is pure-ish: all I/O goes through the injected obsidian adapter
 * (`listAgentFiles` with `.jsonl` extension + `readAgentFile` against the
 * absolute paths it returns), so vitest can drive the full lifecycle with an
 * in-memory double.
 */

import { isTauri } from '../utils/platform.js';
import { getObsidianAdapter } from '../utils/obsidianAdapter.js';

const LOG_DIR = 'agent-log';
const DEFAULT_DAYS = 8; // today + 7 prior

/**
 * Generate `YYYY-MM-DD` date keys from `nowMs` backward, newest first.
 * @param {number} nowMs epoch ms
 * @param {number} days  total days to include (incl. today)
 */
export function dateKeysBackFrom(nowMs, days = DEFAULT_DAYS) {
  if (!Number.isFinite(nowMs) || days <= 0) return [];
  const out = [];
  const base = new Date(nowMs);
  // Normalize to UTC midnight so we match the log filename convention
  // (AgentSync uses `new Date(now).toISOString().slice(0, 10)`).
  const baseUtc = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  for (let i = 0; i < days; i++) {
    const d = new Date(baseUtc - i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Parse a JSONL body into an array of objects. Malformed lines are skipped
 * (and reported via `onWarn` if provided) — we never want one bad line to
 * sink the whole day.
 */
export function parseJsonlBody(body, onWarn) {
  if (typeof body !== 'string' || !body) return [];
  const out = [];
  const lines = body.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); }
    catch (err) {
      if (typeof onWarn === 'function') onWarn(err, line);
    }
  }
  return out;
}

function pickTimestamp(envelope) {
  const r = envelope?.result;
  if (!r) return envelope?.createdAt || 0;
  return r.appliedAt || r.queuedAt || r.rejectedAt || envelope?.createdAt || 0;
}

function collectAffectedIds(diff) {
  const out = { projects: new Set(), sprints: new Set(), tasks: new Set() };
  if (!diff || typeof diff !== 'object') return out;
  for (const kind of ['projects', 'sprints', 'tasks']) {
    const bucket = diff[kind];
    if (!bucket) continue;
    for (const arr of ['added', 'updated', 'deleted']) {
      const list = bucket[arr];
      if (!Array.isArray(list)) continue;
      for (const row of list) {
        const id = row?.id || row?.after?.id || row?.before?.id;
        if (id) out[kind].add(id);
      }
    }
  }
  return { projects: [...out.projects], sprints: [...out.sprints], tasks: [...out.tasks] };
}

/**
 * Build an entry from a raw archived envelope (one jsonl line). Returns
 * `null` for rows that are unusable (e.g. missing opId + type).
 */
export function buildEntry(envelope, dateKey) {
  if (!envelope || typeof envelope !== 'object') return null;
  const opId = typeof envelope.opId === 'string' ? envelope.opId : null;
  const type = typeof envelope.type === 'string' ? envelope.type : 'unknown';
  if (!opId && type === 'unknown') return null;

  const result = envelope.result || {};
  const status = result.status || 'unknown';
  const affected = collectAffectedIds(result.diff);

  return {
    dateKey,
    opId: opId || `anon-${dateKey}-${type}-${pickTimestamp(envelope)}`,
    type,
    status,
    timestamp: pickTimestamp(envelope),
    actor: typeof envelope.actor === 'string' ? envelope.actor : null,
    reason: result.reason || null,
    error: result.error || null,
    approvedFromQueue: Boolean(result.approvedFromQueue),
    affected,
    envelope,
  };
}

/**
 * Coalesce entries sharing the same `opId`. An op can produce multiple log
 * lines over its lifetime (e.g. first queued then approved → two lines). We
 * want the terminal-status view, preferring `applied > rejected > queued`
 * so the digest reflects the op's final outcome. Ties break on timestamp.
 */
const TERMINAL_RANK = { applied: 3, rejected: 2, queued: 1, unknown: 0 };

export function coalesceByOpId(entries) {
  const byOp = new Map();
  for (const e of entries) {
    if (!e) continue;
    const existing = byOp.get(e.opId);
    if (!existing) { byOp.set(e.opId, e); continue; }
    const a = TERMINAL_RANK[existing.status] ?? 0;
    const b = TERMINAL_RANK[e.status] ?? 0;
    if (b > a) byOp.set(e.opId, e);
    else if (b === a && (e.timestamp || 0) > (existing.timestamp || 0)) byOp.set(e.opId, e);
  }
  return [...byOp.values()];
}

export class AgentDigestService {
  constructor(store, {
    adapter = null,
    logger = null,
    now = null,
    plannerDataPathProvider = null,
    days = DEFAULT_DAYS,
  } = {}) {
    this.store = store;
    this._adapter = adapter;
    this._logger = logger || console;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._days = days;
    this._plannerDataPathProvider = plannerDataPathProvider || (() => {
      try { return store?.getState?.()?.obsidianConfig?.plannerDataPath || ''; }
      catch { return ''; }
    });
  }

  async _resolveAdapter() {
    if (this._adapter) return this._adapter;
    if (!isTauri()) return null;
    this._adapter = await getObsidianAdapter();
    return this._adapter;
  }

  /**
   * Read log files for the last `days` calendar days (UTC). Returns:
   *   [{ dateKey, entries: Entry[], counts: { [opType]: n } }]
   * Newest day first; within each day, newest entry first.
   */
  async loadDigest({ days } = {}) {
    const nDays = Math.max(1, days || this._days);
    const adapter = await this._resolveAdapter();
    if (!adapter || typeof adapter.listAgentFiles !== 'function' || typeof adapter.readAgentFile !== 'function') {
      return dateKeysBackFrom(this._now(), nDays).map((dateKey) => ({ dateKey, entries: [], counts: {} }));
    }
    const plannerDataPath = this._plannerDataPathProvider();

    // Enumerate the log directory once so we don't read(absent) N times.
    let fileList = [];
    try {
      fileList = await adapter.listAgentFiles(LOG_DIR, plannerDataPath, { ext: '.jsonl' });
    } catch (err) {
      this._logger.error?.('[agent-digest] listAgentFiles failed:', err);
      fileList = [];
    }
    const byDate = new Map();
    for (const entry of fileList) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/i.exec(entry.name || '');
      if (!m) continue;
      byDate.set(m[1], entry.absPath);
    }

    const wantedDates = dateKeysBackFrom(this._now(), nDays);
    const days_ = [];
    for (const dateKey of wantedDates) {
      const absPath = byDate.get(dateKey);
      if (!absPath) {
        days_.push({ dateKey, entries: [], counts: {} });
        continue;
      }
      let body = '';
      try { body = await adapter.readAgentFile(absPath); }
      catch (err) {
        this._logger.warn?.('[agent-digest] failed to read log file:', absPath, err);
      }
      const envelopes = parseJsonlBody(body, (err, line) => {
        this._logger.warn?.('[agent-digest] skipping malformed jsonl line:', err?.message || err, line.slice(0, 120));
      });
      const entries = coalesceByOpId(envelopes.map((e) => buildEntry(e, dateKey)).filter(Boolean));
      entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      const counts = {};
      for (const e of entries) counts[e.type] = (counts[e.type] || 0) + 1;
      days_.push({ dateKey, entries, counts });
    }
    return days_;
  }
}

export const __TEST_ONLY__ = {
  LOG_DIR, DEFAULT_DAYS, TERMINAL_RANK,
};
