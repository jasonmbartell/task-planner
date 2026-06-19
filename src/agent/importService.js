/**
 * AgentImportService — Milestone 6 browser fallback.
 *
 * On desktop, agent ops flow through the file-watcher (M2/M3/M4). In the
 * browser build there's no filesystem to watch, so a web user / LLM has to
 * hand the user an op bundle that they paste or drop here. This service parses
 * the bundle, runs each envelope through `_agentBulkApply`, and returns the
 * result envelopes in the same shape the desktop archive writes (protocol §6)
 * so the download is drop-in swappable with a Tauri `agent-archive/` entry.
 *
 * Pure-ish — no I/O. All store interaction goes through the injected
 * `_agentBulkApply`, which vitest can double.
 *
 * Spec: CLAUDE_AGENT_PROTOCOL.md §4 (envelope shape) and §6 (result block).
 */

/** Shape of a single parsed-but-not-yet-run envelope, ready for _agentBulkApply. */
export const BUNDLE_ACCEPTED_SHAPES = Object.freeze([
  'single-envelope',           // { opId, type, payload, ... }
  'envelope-array',            // [ { opId, type, payload, ... }, ... ]
  'envelopes-wrapper',         // { envelopes: [ ... ] }
  'bulk-ops-wrapper',          // { ops: [ { type, payload }, ... ] } — treated as ONE bulk envelope
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isEnvelopeLike(v) {
  return isPlainObject(v) && typeof v.type === 'string' && isPlainObject(v.payload);
}

/**
 * Parse a text blob into a list of envelopes plus metadata about the shape
 * we accepted. Does *not* run validation — that's `_agentBulkApply`'s job.
 *
 * Returns `{ ok: true, envelopes, shape }` or `{ ok: false, error: { message } }`.
 */
export function parseBundleText(text, { now = Date.now(), genId = null } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: { message: 'Empty bundle — paste or drop a JSON envelope.' } };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: { message: `Invalid JSON: ${err.message}` } };
  }

  // Array of envelopes.
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { ok: false, error: { message: 'Array bundle is empty.' } };
    for (let i = 0; i < parsed.length; i++) {
      if (!isEnvelopeLike(parsed[i])) {
        return { ok: false, error: { message: `Envelope at index ${i} is missing type or payload.` } };
      }
    }
    return { ok: true, envelopes: parsed.slice(), shape: 'envelope-array' };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: { message: 'Bundle must be a JSON object or array.' } };
  }

  // { envelopes: [...] }
  if (Array.isArray(parsed.envelopes)) {
    if (parsed.envelopes.length === 0) {
      return { ok: false, error: { message: 'envelopes array is empty.' } };
    }
    for (let i = 0; i < parsed.envelopes.length; i++) {
      if (!isEnvelopeLike(parsed.envelopes[i])) {
        return { ok: false, error: { message: `envelopes[${i}] is missing type or payload.` } };
      }
    }
    return { ok: true, envelopes: parsed.envelopes.slice(), shape: 'envelopes-wrapper' };
  }

  // { ops: [...] } — treat as a single `bulk` envelope.
  if (Array.isArray(parsed.ops)) {
    if (parsed.ops.length === 0) {
      return { ok: false, error: { message: 'ops array is empty.' } };
    }
    for (let i = 0; i < parsed.ops.length; i++) {
      const child = parsed.ops[i];
      if (!isPlainObject(child) || typeof child.type !== 'string' || !isPlainObject(child.payload)) {
        return { ok: false, error: { message: `ops[${i}] must be { type, payload }.` } };
      }
    }
    const opId = typeof parsed.opId === 'string' && parsed.opId
      ? parsed.opId
      : (typeof genId === 'function' ? genId('import') : `import-${now}`);
    return {
      ok: true,
      envelopes: [{
        opId,
        createdAt: parsed.createdAt ?? now,
        actor: parsed.actor ?? 'browser-import',
        type: 'bulk',
        payload: { ops: parsed.ops.slice() },
        ...(typeof parsed.basedOn === 'number' ? { basedOn: parsed.basedOn } : {}),
      }],
      shape: 'bulk-ops-wrapper',
    };
  }

  // Single envelope.
  if (isEnvelopeLike(parsed)) {
    return { ok: true, envelopes: [parsed], shape: 'single-envelope' };
  }

  return {
    ok: false,
    error: { message: 'Unrecognized bundle shape — expected an envelope, an array of envelopes, { envelopes: [...] }, or { ops: [...] }.' },
  };
}

/**
 * Build the protocol §6 result block for one envelope + apply result. Mirrors
 * the logic in AgentSync._buildArchivedEnvelope so the browser download is
 * indistinguishable from a desktop archive entry.
 */
function buildResultBlock(result, now, extras = {}) {
  const block = { status: result.status, ...extras };
  if (result.status === 'applied') {
    block.appliedAt = result.appliedAt ?? now;
    block.diff = result.diff ?? null;
    block.error = null;
  } else if (result.status === 'queued') {
    block.queuedAt = now;
    block.reason = result.reason ?? null;
    block.error = null;
    block.diff = null;
  } else {
    block.rejectedAt = now;
    block.error = result.error ?? { kind: 'unknown', message: 'unspecified rejection' };
    block.diff = null;
  }
  return block;
}

/**
 * Run a parsed list of envelopes through the store. Each envelope goes through
 * `_agentBulkApply` independently — if one rejects, the rest still run. Mirrors
 * desktop behavior where queued ops for a batch each get their own archive
 * entry.
 *
 * `options.forceApply` passes through to the store — use `true` when the user
 * has already reviewed the bundle (e.g. the Import UI's "Apply all, skip trust
 * matrix" toggle). Default `false` means queue decisions stick.
 *
 * Returns `{ results, summary }` where `results[i]` is the archived envelope
 * for `envelopes[i]` (envelope + §6 result block) and `summary` is a count
 * roll-up the UI can show directly.
 */
export function runBundle(store, envelopes, { forceApply = false, now = Date.now() } = {}) {
  if (!store || typeof store.getState !== 'function') {
    throw new Error('runBundle: store with getState() required');
  }
  const state = store.getState();
  if (typeof state._agentBulkApply !== 'function') {
    throw new Error('runBundle: store does not expose _agentBulkApply');
  }

  const summary = { total: envelopes.length, applied: 0, queued: 0, rejected: 0 };
  const results = [];

  for (const envelope of envelopes) {
    let result;
    try {
      result = state._agentBulkApply(envelope, { forceApply, now });
    } catch (err) {
      result = { status: 'rejected', error: { kind: 'internal', message: String(err?.message || err) } };
    }
    const block = buildResultBlock(result, now, { importedAt: now });
    const archived = { ...envelope, result: block };
    results.push(archived);
    if (result.status === 'applied') summary.applied += 1;
    else if (result.status === 'queued') summary.queued += 1;
    else summary.rejected += 1;
  }

  return { results, summary };
}

/**
 * Build a JSON string suitable for download. Wraps the list of archived
 * envelopes in a `{ importedAt, summary, envelopes }` object so the
 * receiving agent can tell it's a result bundle and scrape the status roll-up
 * without walking each envelope.
 */
export function buildResultBundleText(results, summary, { now = Date.now() } = {}) {
  const payload = {
    importedAt: now,
    summary: summary || null,
    envelopes: results,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Trigger a browser download of the result bundle. Uses `URL.createObjectURL`
 * + anchor-click, which works in every evergreen browser without a library.
 * No-op in non-browser contexts (tests, server-side rendering).
 */
export function downloadResultBundle(text, filename, { doc = typeof document !== 'undefined' ? document : null, urlApi = typeof URL !== 'undefined' ? URL : null } = {}) {
  if (!doc || !urlApi || typeof urlApi.createObjectURL !== 'function') return false;
  const blob = new Blob([text], { type: 'application/json' });
  const url = urlApi.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body?.appendChild(a);
  a.click();
  // Release the blob URL on the next tick so the download has time to start.
  setTimeout(() => {
    try { urlApi.revokeObjectURL(url); } catch { /* ignore */ }
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 0);
  return true;
}

/**
 * Default filename for a result bundle: `agent-import-result-{ISO-stamp}.json`.
 * Colons stripped so the filename is valid on Windows.
 */
export function defaultResultFilename(now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/:/g, '-').replace(/\..+$/, 'Z');
  return `agent-import-result-${stamp}.json`;
}

export const __TEST_ONLY__ = { isEnvelopeLike, isPlainObject, buildResultBlock };
