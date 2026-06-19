/**
 * AgentSync — frontend side of the Claude ↔ planner op channel.
 *
 * Listens for `agent-inbox:op` events emitted by the Rust-side notify
 * watcher (see `src-tauri/src/agent_watcher.rs`). For each event:
 *
 *   1. Read the inbox file (absolute path from the event payload).
 *   2. Parse JSON. If parse fails → archive a synthetic rejection.
 *   3. Call `_agentBulkApply(envelope)` on the store.
 *   4. Write the result envelope into
 *      `agent-archive/{applied|queued|rejected}/`.
 *   5. Append a JSONL line to `agent-log/YYYY-MM-DD.jsonl`.
 *   6. Remove the inbox file.
 *
 * In the browser build this class is mostly inert: `start()` returns without
 * subscribing, and even if events are simulated (tests), the apply path
 * skips when no adapter is available. Milestone 6 introduces a click-to-import
 * fallback for browsers.
 */

import { isTauri } from '../utils/platform.js';
import { getObsidianAdapter } from '../utils/obsidianAdapter.js';
import { processProseIngest as defaultProseIngestHandler } from './proseIngestHandler.js';

const EVENT_NAME = 'agent-inbox:op';
const DEDUPE_WINDOW_MS = 2000;

function isoFileTimestamp(ms) {
  // 2026-04-22T18-30-12.345Z — Windows-safe (no colons), sortable.
  return new Date(ms).toISOString().replace(/:/g, '-');
}

function safeOpId(opId) {
  if (typeof opId !== 'string' || !opId) return 'unknown';
  return opId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
}

function basenameFromPath(absPath) {
  if (typeof absPath !== 'string') return '';
  const idx = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
  return idx >= 0 ? absPath.slice(idx + 1) : absPath;
}

export class AgentSync {
  constructor(store, { eventApi, logger, adapter, plannerDataPathProvider, now, onAfterArchive, proseIngestHandler } = {}) {
    this.store = store;
    this._eventApi = eventApi || null;
    this._adapter = adapter || null;
    this._logger = logger || console;
    this._unlisten = null;
    this._started = false;
    this._seenPaths = new Map();           // path → timeout id (event dedupe)
    this._processingOpIds = new Set();     // in-flight envelope dedupe by opId
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._onAfterArchive = typeof onAfterArchive === 'function' ? onAfterArchive : null;
    this._proseIngestHandler = typeof proseIngestHandler === 'function' ? proseIngestHandler : defaultProseIngestHandler;
    this._plannerDataPathProvider = plannerDataPathProvider || (() => {
      try {
        return store?.getState?.()?.obsidianConfig?.plannerDataPath || '';
      } catch {
        return '';
      }
    });
  }

  async _resolveEventApi() {
    if (this._eventApi) return this._eventApi;
    const mod = await import('@tauri-apps/api/event');
    this._eventApi = { listen: mod.listen };
    return this._eventApi;
  }

  async _resolveAdapter() {
    if (this._adapter) return this._adapter;
    if (!isTauri()) return null;
    this._adapter = await getObsidianAdapter();
    return this._adapter;
  }

  /**
   * Begin listening for agent ops. Safe to call multiple times; subsequent
   * calls are no-ops while already started.
   *
   * After subscribing we drain any files already present in `agent-inbox/`.
   * The Rust watcher only emits events for filesystem changes that happen
   * while it's running — files placed before we subscribed (e.g. by Claude
   * while the app was closed, or by a manual drop just before launch) would
   * otherwise sit forever. The drain waits for `_hydrated: true` first so
   * ops apply against the real store, not an empty hydrating one.
   */
  async start() {
    if (this._started) return;
    if (!this._eventApi && !isTauri()) {
      // Browser build: nothing to subscribe to. Keep the method callable
      // so App.jsx wiring stays platform-agnostic.
      return;
    }

    try {
      const api = await this._resolveEventApi();
      this._unlisten = await api.listen(EVENT_NAME, (event) => {
        this._handleEvent(event);
      });
      this._started = true;
      this._logger.log?.('[agent-sync] listening for agent ops');
    } catch (err) {
      this._logger.error?.('[agent-sync] failed to subscribe:', err);
      return;
    }

    // Drain pre-existing files now that the watcher is armed. Order matters:
    // subscribing first means new files landing during drain are still
    // observed by the watcher, and the seen-paths dedupe prevents double
    // processing.
    let drained = 0;
    let drainError = null;
    try {
      await this._waitForHydration();
      drained = await this._drainExistingInbox();
    } catch (err) {
      drainError = err;
      this._logger.error?.('[agent-sync] startup drain failed:', err);
    }

    // Heartbeat to agent-log/YYYY-MM-DD.jsonl so we can tell from the file
    // system that AgentSync subscribed today, even on days when no ops are
    // applied. Bug report flagged the missing 2026-05-06.jsonl as a key
    // observability gap.
    await this._writeStartHeartbeat({ drained, drainError });
  }

  async _writeStartHeartbeat({ drained, drainError }) {
    const adapter = await this._resolveAdapter().catch(() => null);
    if (!adapter || typeof adapter.appendAgentFile !== 'function') return;
    const ts = this._now();
    const dateStr = new Date(ts).toISOString().slice(0, 10);
    const rel = `agent-log/${dateStr}.jsonl`;
    const line = JSON.stringify({
      type: 'agent-sync.start',
      ts,
      drained,
      drainError: drainError ? String(drainError?.message || drainError) : null,
    }) + '\n';
    try {
      await adapter.appendAgentFile(rel, line, this._plannerDataPathProvider());
    } catch (err) {
      this._logger.error?.('[agent-sync] heartbeat log write failed:', err);
    }
  }

  /**
   * Resolve once `useStore._hydrated` flips to true so the drain doesn't run
   * against an empty store. Bails after `timeoutMs` to avoid hanging tests
   * that pass a stubbed store without `subscribe`.
   */
  async _waitForHydration(timeoutMs = 10_000) {
    const store = this.store;
    if (!store) return;
    try {
      if (store.getState?.()?._hydrated) return;
    } catch {
      return;
    }
    if (typeof store.subscribe !== 'function') return;
    await new Promise((resolve) => {
      let done = false;
      let unsub = null;
      const finish = () => {
        if (done) return;
        done = true;
        try { unsub?.(); } catch { /* noop */ }
        resolve();
      };
      unsub = store.subscribe((state) => {
        if (state?._hydrated) finish();
      });
      setTimeout(finish, timeoutMs);
    });
  }

  /**
   * Scan `agent-inbox/` once and route every existing `.json` file through
   * the same `_processInbox` path that watcher events use. Each file gets
   * pre-registered in `_seenPaths` so a watcher event for the same path
   * (which can arrive concurrently as Tauri may replay Modify events on
   * subscribe) is deduped instead of double-applied. Returns the number of
   * files processed.
   */
  async _drainExistingInbox() {
    const adapter = await this._resolveAdapter();
    if (!adapter || typeof adapter.listAgentFiles !== 'function') return 0;
    const plannerDataPath = this._plannerDataPathProvider();
    let files;
    try {
      files = await adapter.listAgentFiles('agent-inbox', plannerDataPath, { ext: '.json' });
    } catch (err) {
      this._logger.error?.('[agent-sync] drain: listAgentFiles failed:', err);
      return 0;
    }
    if (!files || files.length === 0) {
      this._logger.log?.('[agent-sync] drain: inbox is empty');
      return 0;
    }
    this._logger.log?.(`[agent-sync] drain: found ${files.length} pre-existing inbox file(s)`);

    let processed = 0;
    for (const f of files) {
      if (!f?.name || !f?.absPath) continue;
      // Mirror the Rust watcher's filter: skip atomic-write tmp files and dotfiles.
      if (f.name.endsWith('.tmp') || f.name.startsWith('.')) continue;
      if (this._seenPaths.has(f.absPath)) continue;
      const timeoutId = setTimeout(() => {
        this._seenPaths.delete(f.absPath);
      }, DEDUPE_WINDOW_MS);
      this._seenPaths.set(f.absPath, timeoutId);
      try {
        await this._processInbox(f.absPath);
        processed += 1;
      } catch (err) {
        this._logger.error?.('[agent-sync] drain: processing failed:', f.absPath, err);
      }
    }
    this._logger.log?.(`[agent-sync] drain: processed ${processed} file(s)`);
    return processed;
  }

  stop() {
    if (this._unlisten) {
      try {
        this._unlisten();
      } catch (err) {
        this._logger.error?.('[agent-sync] unlisten failed:', err);
      }
      this._unlisten = null;
    }
    for (const timeoutId of this._seenPaths.values()) {
      clearTimeout(timeoutId);
    }
    this._seenPaths.clear();
    this._processingOpIds.clear();
    this._started = false;
  }

  _handleEvent(event) {
    const payload = event?.payload;
    if (typeof payload !== 'string' || !payload) return;

    // A single op file write on Windows can fire multiple Modify events
    // in rapid succession; dedupe within a short window so the apply path
    // only runs once per op.
    if (this._seenPaths.has(payload)) return;
    const timeoutId = setTimeout(() => {
      this._seenPaths.delete(payload);
    }, DEDUPE_WINDOW_MS);
    this._seenPaths.set(payload, timeoutId);

    this._logger.log?.('[agent-sync] agent op received:', payload);

    // Fire-and-forget; failures are logged inside.
    this._processInbox(payload).catch((err) => {
      this._logger.error?.('[agent-sync] processing failed:', err);
    });
  }

  async _processInbox(absPath) {
    const adapter = await this._resolveAdapter();
    if (!adapter || typeof adapter.readAgentFile !== 'function') {
      // No I/O available (browser, or test without adapter). Stop here so
      // we don't lose the M2 logging behavior tests rely on.
      return;
    }

    const plannerDataPath = this._plannerDataPathProvider();

    // 1. Read & parse the inbox file.
    let raw;
    try {
      raw = await adapter.readAgentFile(absPath);
    } catch (err) {
      this._logger.error?.('[agent-sync] failed to read inbox file:', absPath, err);
      // The file may have been moved/deleted between watcher events — best
      // effort: leave it; do not write a synthetic rejection because we
      // don't have an opId.
      return;
    }
    if (typeof raw !== 'string') return;

    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (parseErr) {
      await this._archiveMalformed(adapter, plannerDataPath, absPath, raw, parseErr);
      await this._tryRemoveInbox(adapter, absPath);
      return;
    }

    // 2. In-flight dedupe by opId.
    const opId = typeof envelope?.opId === 'string' ? envelope.opId : null;
    if (opId && this._processingOpIds.has(opId)) {
      // Another handler is already mid-process for this op. Drop the dup.
      return;
    }
    if (opId) this._processingOpIds.add(opId);

    try {
      if (envelope?.type === 'prose.ingest') {
        await this._processProseIngestEnvelope(adapter, plannerDataPath, envelope);
      } else {
        await this._processStandardEnvelope(adapter, plannerDataPath, envelope);
      }
      await this._tryRemoveInbox(adapter, absPath);
    } finally {
      if (opId) this._processingOpIds.delete(opId);
    }
  }

  async _processStandardEnvelope(adapter, plannerDataPath, envelope) {
    let result;
    try {
      result = this.store.getState()._agentBulkApply(envelope);
    } catch (applyErr) {
      this._logger.error?.('[agent-sync] _agentBulkApply threw:', applyErr);
      result = {
        status: 'rejected',
        error: { kind: 'internal', message: String(applyErr?.message || applyErr) },
      };
    }

    const now = this._now();
    const archived = this._buildArchivedEnvelope(envelope, result, now);
    await this._writeArchive(adapter, plannerDataPath, archived, result.status, now);
    await this._appendLog(adapter, plannerDataPath, archived, now);
    if (this._onAfterArchive) {
      try { this._onAfterArchive({ status: result.status, archived }); }
      catch (err) { this._logger.error?.('[agent-sync] onAfterArchive threw:', err); }
    }
  }

  /**
   * `prose.ingest` is routed outside `_agentBulkApply` because the store-side
   * validator only knows about task/sprint/project/bulk ops. The handler runs
   * the LLM extraction and returns:
   *   - `outcome.self`  → result block for the prose.ingest envelope itself
   *                       (archived to applied/rejected as appropriate).
   *   - `outcome.spawned` → bulk envelope of task.add children, archived to
   *                         queued/ for the M4 inbox UI to surface.
   */
  async _processProseIngestEnvelope(adapter, plannerDataPath, envelope) {
    let outcome;
    try {
      outcome = await this._proseIngestHandler(envelope, {
        store: this.store,
        now: this._now,
      });
    } catch (handlerErr) {
      this._logger.error?.('[agent-sync] proseIngestHandler threw:', handlerErr);
      outcome = {
        self: {
          status: 'rejected',
          rejectedAt: this._now(),
          error: { kind: 'internal', message: String(handlerErr?.message || handlerErr) },
          diff: null,
        },
        spawned: null,
      };
    }

    const now = this._now();

    // Archive the prose.ingest envelope itself.
    const selfArchived = { ...envelope, result: outcome.self };
    await this._writeArchive(adapter, plannerDataPath, selfArchived, outcome.self.status, now);
    await this._appendLog(adapter, plannerDataPath, selfArchived, now);
    if (this._onAfterArchive) {
      try { this._onAfterArchive({ status: outcome.self.status, archived: selfArchived }); }
      catch (err) { this._logger.error?.('[agent-sync] onAfterArchive threw:', err); }
    }

    // Archive the spawned bulk envelope (queued for human review). The M4
    // inbox UI lists agent-archive/queued/ entries — when the user approves,
    // it runs the bulk through `_agentBulkApply` with `forceApply: true`.
    if (outcome.spawned?.envelope) {
      const spawnedResult = {
        status: 'queued',
        queuedAt: now,
        reason: outcome.spawned.reason || 'prose-ingest',
        error: null,
        diff: null,
        spawnedFromOpId: envelope.opId,
      };
      const spawnedArchived = { ...outcome.spawned.envelope, result: spawnedResult };
      await this._writeArchive(adapter, plannerDataPath, spawnedArchived, 'queued', now);
      await this._appendLog(adapter, plannerDataPath, spawnedArchived, now);
      if (this._onAfterArchive) {
        try { this._onAfterArchive({ status: 'queued', archived: spawnedArchived }); }
        catch (err) { this._logger.error?.('[agent-sync] onAfterArchive threw:', err); }
      }
    }
  }

  _buildArchivedEnvelope(envelope, result, now) {
    const resultBlock = { status: result.status };
    if (result.status === 'applied') {
      resultBlock.appliedAt = result.appliedAt ?? now;
      resultBlock.diff = result.diff ?? null;
      resultBlock.error = null;
    } else if (result.status === 'queued') {
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

  async _writeArchive(adapter, plannerDataPath, archived, status, now) {
    const subdir =
      status === 'applied' ? 'applied' :
      status === 'queued'  ? 'queued'  : 'rejected';
    const stamp = isoFileTimestamp(now);
    const opId = safeOpId(archived?.opId);
    const rel = `agent-archive/${subdir}/${stamp}__${opId}.json`;
    try {
      await adapter.writeAgentFile(rel, JSON.stringify(archived, null, 2), plannerDataPath);
    } catch (err) {
      this._logger.error?.('[agent-sync] failed to write archive entry:', rel, err);
    }
  }

  async _appendLog(adapter, plannerDataPath, archived, now) {
    if (typeof adapter.appendAgentFile !== 'function') return;
    const dateStr = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
    const rel = `agent-log/${dateStr}.jsonl`;
    try {
      await adapter.appendAgentFile(rel, JSON.stringify(archived) + '\n', plannerDataPath);
    } catch (err) {
      this._logger.error?.('[agent-sync] failed to append log line:', rel, err);
    }
  }

  async _archiveMalformed(adapter, plannerDataPath, absPath, raw, parseErr) {
    const now = this._now();
    const stamp = isoFileTimestamp(now);
    const baseName = basenameFromPath(absPath) || 'malformed';
    const synthetic = {
      opId: `malformed-${stamp}-${baseName}`,
      type: 'unknown',
      payload: null,
      raw: typeof raw === 'string' ? raw.slice(0, 4096) : null,
      sourcePath: absPath,
      result: {
        status: 'rejected',
        rejectedAt: now,
        diff: null,
        error: { kind: 'malformed', message: `JSON parse failed: ${parseErr?.message || parseErr}` },
      },
    };
    const rel = `agent-archive/rejected/${stamp}__${safeOpId(synthetic.opId)}.json`;
    try {
      await adapter.writeAgentFile(rel, JSON.stringify(synthetic, null, 2), plannerDataPath);
    } catch (err) {
      this._logger.error?.('[agent-sync] failed to write malformed-rejection entry:', rel, err);
    }
    await this._appendLog(adapter, plannerDataPath, synthetic, now);
  }

  async _tryRemoveInbox(adapter, absPath) {
    if (typeof adapter.removeAgentFile !== 'function') return;
    try {
      await adapter.removeAgentFile(absPath);
    } catch (err) {
      this._logger.error?.('[agent-sync] failed to remove inbox file:', absPath, err);
    }
  }
}

export const __TEST_ONLY__ = { EVENT_NAME, DEDUPE_WINDOW_MS, isoFileTimestamp, safeOpId };
