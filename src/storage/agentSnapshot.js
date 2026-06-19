/**
 * Agent snapshot: canonical, read-only JSON export the planner writes
 * for Claude (or any other agent) to read before composing an op.
 *
 * Shape contract lives in CLAUDE_AGENT_PROTOCOL.md §3. If this file
 * disagrees with the protocol doc, update the doc — the code is
 * authoritative, but both must match before an op is accepted.
 */

import { normalizeDeps } from '../utils/depEdges.js';

// v1 = pre-milestone-3.5 (dependencies: string[])
// v2 = typed dependency edges (dependencies: DepEdge[])
const SNAPSHOT_SCHEMA_VERSION = 2;

function pickProject(p) {
  return {
    id: p.id,
    name: p.name ?? '',
    color: p.color ?? '',
    description: p.description ?? '',
    updatedAt: p.updatedAt ?? 0,
  };
}

function pickSprint(s) {
  return {
    id: s.id,
    name: s.name ?? '',
    startDate: s.startDate ?? '',
    endDate: s.endDate ?? '',
    projectId: s.projectId ?? '',
    updatedAt: s.updatedAt ?? 0,
  };
}

function pickTask(t) {
  return {
    id: t.id,
    title: t.title ?? '',
    description: t.description ?? '',
    startDate: t.startDate ?? '',
    endDate: t.endDate ?? '',
    dueDate: t.dueDate ?? '',
    dependencies: normalizeDeps(t.dependencies),
    urgency: t.urgency ?? 5,
    importance: t.importance ?? 5,
    difficulty: t.difficulty ?? 3,
    sprintId: t.sprintId ?? '',
    status: t.status ?? 'todo',
    parentTaskId: t.parentTaskId ?? null,
    updatedAt: t.updatedAt ?? 0,
  };
}

/**
 * Pure function: builds the snapshot object from a store-shaped state slice.
 * Accepts { projects, sprints, tasks } (any extra keys ignored).
 * `exportedAt` defaults to Date.now() but is injectable for tests.
 */
export function buildSnapshot(state, { exportedAt = Date.now() } = {}) {
  const projects = (state.projects ?? []).map(pickProject);
  const sprints = (state.sprints ?? []).map(pickSprint);
  const tasks = (state.tasks ?? []).map(pickTask);

  const tasksById = {};
  const sprintsById = {};
  const projectsById = {};
  const tasksBySprint = {};
  const sprintsByProject = {};

  for (let i = 0; i < projects.length; i++) {
    projectsById[projects[i].id] = i;
    sprintsByProject[projects[i].id] = [];
  }
  for (let i = 0; i < sprints.length; i++) {
    const s = sprints[i];
    sprintsById[s.id] = i;
    tasksBySprint[s.id] = [];
    if (s.projectId && sprintsByProject[s.projectId]) {
      sprintsByProject[s.projectId].push(s.id);
    }
  }
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    tasksById[t.id] = i;
    if (t.sprintId && tasksBySprint[t.sprintId]) {
      tasksBySprint[t.sprintId].push(t.id);
    }
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    exportedAt,
    projects,
    sprints,
    tasks,
    indexes: {
      tasksById,
      sprintsById,
      projectsById,
      tasksBySprint,
      sprintsByProject,
    },
  };
}

export function buildSnapshotMeta(snapshot) {
  return {
    version: snapshot.schemaVersion,
    exportedAt: snapshot.exportedAt,
    schemaVersion: snapshot.schemaVersion,
  };
}

/**
 * Writes snapshot.json (and snapshot.meta.json) via the given adapter.
 * `adapter` must expose `writeAgentFile(relPath, contents)`; missing adapter
 * (e.g. browser) is a no-op. Writes are atomic via temp + rename when the
 * adapter supports it; falls back to direct write otherwise.
 *
 * Body is parsed back into JSON before writing (`JSON.parse(JSON.stringify)`
 * round-trip) so that if the stringified output is somehow not parseable
 * (a Node/Tauri bug, surrogate pair issue, OOM truncation), we throw before
 * meta.exportedAt advances past a corrupt body. Meta-advances-without-body
 * was the silent-corruption shape the bug report flagged.
 */
export async function writeSnapshot(adapter, state, opts = {}) {
  if (!adapter || typeof adapter.writeAgentFile !== 'function') return null;
  const { plannerDataPath, exportedAt } = opts;
  const snapshot = buildSnapshot(state, { exportedAt });
  const meta = buildSnapshotMeta(snapshot);
  const bodyStr = JSON.stringify(snapshot, null, 2);
  const metaStr = JSON.stringify(meta, null, 2);

  try {
    JSON.parse(bodyStr);
  } catch (err) {
    throw new Error(`writeSnapshot: stringified body failed to round-trip parse: ${err?.message || err}`);
  }

  await adapter.writeAgentFile('snapshot.json', bodyStr, plannerDataPath);
  await adapter.writeAgentFile('snapshot.meta.json', metaStr, plannerDataPath);
  return snapshot;
}

/**
 * Reads the body+meta pair already on disk and decides whether the snapshot
 * is intact. Used by the startup integrity check (`ensureSnapshotIntegrity`)
 * so a corrupt file from a previous session doesn't persist when the store
 * happens not to change post-boot.
 *
 * Returns `{ ok: true }` when the pair is consistent, or
 *         `{ ok: false, reason }` with one of:
 *           - `missing-body`           — no snapshot.json file
 *           - `body-corrupt`           — snapshot.json fails JSON.parse
 *           - `meta-corrupt`           — snapshot.meta.json present but unparseable
 *           - `exportedAt-mismatch`    — body and meta disagree (the
 *                                        meta-advances-without-body shape)
 */
export function evaluateSnapshotPair({ body, meta } = {}) {
  if (body == null) return { ok: false, reason: 'missing-body' };
  let bodyJson;
  try {
    bodyJson = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'body-corrupt' };
  }
  if (meta == null) {
    // Body parses but meta is missing — fine, the next write recreates it.
    // Treat as ok rather than rewriting on every boot.
    return { ok: true };
  }
  let metaJson;
  try {
    metaJson = JSON.parse(meta);
  } catch {
    return { ok: false, reason: 'meta-corrupt' };
  }
  if (Number.isFinite(bodyJson?.exportedAt) && Number.isFinite(metaJson?.exportedAt)
      && bodyJson.exportedAt !== metaJson.exportedAt) {
    return { ok: false, reason: 'exportedAt-mismatch' };
  }
  return { ok: true };
}

/**
 * Reads snapshot.{json,meta.json} via the adapter, validates them, and forces
 * a fresh `writeSnapshot` if anything is wrong. Safe no-op when the adapter
 * lacks `readSnapshotPair` (browser build, tests with stub adapters).
 *
 * Returns `{ status: 'ok' | 'rewritten' | 'skipped', reason? }`.
 */
export async function ensureSnapshotIntegrity(adapter, state, opts = {}) {
  if (!adapter || typeof adapter.readSnapshotPair !== 'function'
      || typeof adapter.writeAgentFile !== 'function') {
    return { status: 'skipped' };
  }
  const { plannerDataPath } = opts;
  let pair;
  try {
    pair = await adapter.readSnapshotPair(plannerDataPath);
  } catch {
    pair = { body: null, meta: null };
  }
  const verdict = evaluateSnapshotPair(pair);
  if (verdict.ok) return { status: 'ok' };
  await writeSnapshot(adapter, state, { plannerDataPath });
  return { status: 'rewritten', reason: verdict.reason };
}

export { SNAPSHOT_SCHEMA_VERSION };
