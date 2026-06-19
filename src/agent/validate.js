/**
 * Validation + normalization helpers for agent ops.
 *
 * Pure functions only — no store, no I/O. Consumed by the store's
 * `_agentBulkApply` action and by `AgentSync` when archiving rejections
 * for malformed inbox files.
 *
 * Spec: CLAUDE_AGENT_PROTOCOL.md §4 (op envelope) and §4.5 (rejection kinds).
 */

import { canonicalEdgeType, normalizeDeps, hardTargets } from '../utils/depEdges.js';

const TASK_ID_RE = /^task-[A-Za-z0-9_-]+$/;
const SPRINT_ID_RE = /^sprint-[A-Za-z0-9_-]+$/;
const PROJECT_ID_RE = /^proj-[A-Za-z0-9_-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const VALID_STATUSES = new Set(['todo', 'in-progress', 'done', 'blocked']);

const ATOMIC_OP_TYPES = new Set([
  'task.add', 'task.update', 'task.delete',
  'sprint.add', 'sprint.update', 'sprint.delete',
  'project.add', 'project.update', 'project.delete',
]);
const ALL_OP_TYPES = new Set([...ATOMIC_OP_TYPES, 'bulk']);

export const __INTERNALS__ = {
  ATOMIC_OP_TYPES, ALL_OP_TYPES, VALID_STATUSES,
  TASK_ID_RE, SPRINT_ID_RE, PROJECT_ID_RE, DATE_RE,
};

function err(kind, message, details) {
  return { kind, message, ...(details ? { details } : {}) };
}

export function validateEnvelope(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env))
    return { ok: false, error: err('malformed', 'envelope must be a JSON object') };
  if (typeof env.opId !== 'string' || env.opId.length === 0)
    return {
      ok: false,
      error: err(
        'malformed',
        'envelope.opId required (non-empty string) — did you write a bare {type, payload} JSON to agent-inbox/? Pre-wrap inner ops via scripts/write_op.py (or supply opId, createdAt, actor, basedOn yourself).'
      ),
    };
  if (typeof env.type !== 'string' || !ALL_OP_TYPES.has(env.type))
    return { ok: false, error: err('unknown_type', `unknown op type: ${env.type ?? '<missing>'}`) };
  if (env.payload === null || typeof env.payload !== 'object' || Array.isArray(env.payload))
    return { ok: false, error: err('malformed', 'envelope.payload required (object)') };
  if (env.basedOn !== undefined && typeof env.basedOn !== 'number')
    return { ok: false, error: err('malformed', 'envelope.basedOn must be a number when present') };
  return { ok: true };
}

/**
 * Flatten an envelope to a list of atomic ops `{ type, payload }`.
 * Returns null on malformed bulk (empty array, non-atomic child type, etc.)
 */
export function normalizeOps(env) {
  if (env.type === 'bulk') {
    if (!Array.isArray(env.payload?.ops) || env.payload.ops.length === 0) return null;
    const out = [];
    for (const child of env.payload.ops) {
      if (!child || typeof child !== 'object') return null;
      if (!ATOMIC_OP_TYPES.has(child.type)) return null;
      if (!child.payload || typeof child.payload !== 'object') return null;
      out.push({ type: child.type, payload: child.payload });
    }
    return out;
  }
  return [{ type: env.type, payload: env.payload }];
}

/**
 * Pre-fill IDs for `*.add` ops that didn't supply one. Mutates a clone, never
 * the input. Validation and apply share the resulting list so id references
 * within a bulk (e.g. add-task-A then add-task-B-depending-on-A) line up.
 */
export function assignMissingIds(ops, { genId }) {
  return ops.map((op) => {
    if (op.type === 'task.add' && op.payload?.task && !op.payload.task.id) {
      return { type: op.type, payload: { ...op.payload, task: { ...op.payload.task, id: genId('task') } } };
    }
    if (op.type === 'sprint.add' && op.payload?.sprint && !op.payload.sprint.id) {
      return { type: op.type, payload: { ...op.payload, sprint: { ...op.payload.sprint, id: genId('sprint') } } };
    }
    if (op.type === 'project.add' && op.payload?.project && !op.payload.project.id) {
      return { type: op.type, payload: { ...op.payload, project: { ...op.payload.project, id: genId('proj') } } };
    }
    return op;
  });
}

/**
 * Topologically sort `task.add` ops within a bulk so each op's intra-bulk
 * dependency targets appear earlier in the sequence. Non-task.add ops keep
 * their original positions; only the task.add slots are reordered.
 *
 * `validateBulk` walks ops in array order against a mutable shadow, so
 * without this sort a `task.add` referencing a sibling `task.add` declared
 * later in the bulk fails with `missing_ref`. Callers (agents generating
 * bulks) shouldn't have to know to topo-sort up front.
 *
 * Edge type is ignored when computing order: every `targetId` reference
 * imposes an ordering constraint, regardless of `hard-blocks` / `soft-prefers`
 * / etc. — `validateBulk` resolves the target by id alone. A cycle in the
 * intra-bulk dep graph (any edge type) has no valid order, so we reject
 * with `kind: 'cycle'` rather than letting it fall through to a misleading
 * `missing_ref`.
 *
 * Caller must have already run `assignMissingIds` so every task.add has an id.
 *
 * Returns `{ ok: true, ops }` (possibly the same array if nothing moved) or
 * `{ ok: false, error: { kind, message } }` on cycle.
 */
export function topoSortTaskAdds(ops) {
  const addIndices = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]?.type === 'task.add') addIndices.push(i);
  }
  if (addIndices.length <= 1) return { ok: true, ops };

  const addOps = addIndices.map((i) => ops[i]);
  const idToOrdinal = new Map();
  for (let k = 0; k < addOps.length; k++) {
    const id = addOps[k].payload?.task?.id;
    if (typeof id === 'string' && id) idToOrdinal.set(id, k);
  }

  const indeg = new Array(addOps.length).fill(0);
  const outEdges = Array.from({ length: addOps.length }, () => []);

  for (let k = 0; k < addOps.length; k++) {
    const deps = addOps[k].payload?.task?.dependencies;
    if (!Array.isArray(deps)) continue;
    for (const d of deps) {
      const targetId = typeof d === 'string' ? d : d?.targetId;
      if (typeof targetId !== 'string' || !targetId) continue;
      const j = idToOrdinal.get(targetId);
      // Skip non-intra-bulk refs and self-loops. Self-loops are still caught
      // by validateBulk's hard-blocks cycle check (with the right kind).
      if (j === undefined || j === k) continue;
      outEdges[j].push(k);
      indeg[k] += 1;
    }
  }

  // Kahn's algorithm. Seeding the queue in original order makes the sort
  // stable for ties: tasks with no intra-bulk deps come out in the order
  // they were submitted.
  const queue = [];
  for (let k = 0; k < addOps.length; k++) {
    if (indeg[k] === 0) queue.push(k);
  }
  const sorted = [];
  let head = 0;
  while (head < queue.length) {
    const k = queue[head++];
    sorted.push(addOps[k]);
    for (const child of outEdges[k]) {
      indeg[child] -= 1;
      if (indeg[child] === 0) queue.push(child);
    }
  }

  if (sorted.length !== addOps.length) {
    return {
      ok: false,
      error: err('cycle', 'bulk: intra-bulk task.add dependency cycle'),
    };
  }

  // Splice the sorted task.adds back into the original task.add slots.
  // Non-task.add ops (project.add, sprint.add, task.update, etc.) stay put.
  const result = ops.slice();
  for (let k = 0; k < addIndices.length; k++) {
    result[addIndices[k]] = sorted[k];
  }
  return { ok: true, ops: result };
}

/**
 * Cycle check over the shadow task map. Walks only `hard-blocks` edges —
 * soft/preempt/deadline-independent edges are allowed to cycle (M3.5).
 */
function hasCycleIn(taskId, dependencyId, taskMap) {
  if (!dependencyId) return false;
  if (taskId === dependencyId) return true;
  const visited = new Set();
  const stack = [dependencyId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === taskId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const t = taskMap.get(cur);
    if (t) for (const next of hardTargets(t.dependencies)) stack.push(next);
  }
  return false;
}

/**
 * Validate a dependency list (mixed DepEdge[] or legacy string[]).
 * Returns `{ ok: true, edges }` with normalized edges, or `{ ok: false, kind, message }`.
 * `kind` is one of: 'validation' (bad type / shape) or 'missing_ref' (targetId not in shadow).
 */
function validateDepsList(raw, { tasks, label }) {
  if (!Array.isArray(raw)) return { ok: false, kind: 'validation', message: `${label}: dependencies must be array` };
  const edges = [];
  for (const entry of raw) {
    let targetId;
    let type;
    let extras = null;
    if (typeof entry === 'string') {
      targetId = entry.trim();
      type = 'hard-blocks';
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if (typeof entry.targetId !== 'string' || !entry.targetId.trim()) {
        return { ok: false, kind: 'validation', message: `${label}: dependency entry missing targetId` };
      }
      targetId = entry.targetId.trim();
      if (entry.type === undefined || entry.type === null || entry.type === '') {
        type = 'hard-blocks';
      } else {
        const canon = canonicalEdgeType(entry.type);
        if (!canon) return { ok: false, kind: 'validation', message: `${label}: unknown dependency type "${entry.type}"` };
        type = canon;
      }
      extras = {};
      if (typeof entry.except === 'string' && entry.except.trim()) extras.except = entry.except.trim();
      if (typeof entry.note === 'string' && entry.note.trim()) extras.note = entry.note.trim();
    } else {
      return { ok: false, kind: 'validation', message: `${label}: dependency entries must be strings or DepEdge objects` };
    }
    if (!targetId) return { ok: false, kind: 'validation', message: `${label}: dependency entries must be non-empty` };
    if (!tasks.has(targetId)) return { ok: false, kind: 'missing_ref', message: `${label}: dependency "${targetId}" not found` };
    edges.push({ targetId, type, ...(extras || {}) });
  }
  return { ok: true, edges };
}

function validateTaskDates(t) {
  for (const k of ['startDate', 'endDate', 'dueDate']) {
    const v = t[k];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string' || !DATE_RE.test(v)) return `bad ${k} "${v}"`;
  }
  return null;
}

/**
 * Walk the bulk in order against a mutable shadow of state, so that intra-bulk
 * references (forward IDs, cascades) are resolved correctly. Aborts on first
 * error (matches protocol §4.2: "applied as one undo-checkpoint; aborts on
 * first validation error").
 *
 * Caller must have already run `assignMissingIds` so add-ops have stable IDs.
 *
 * Returns { ok: true } or { ok: false, error: { kind, message, details: { opIndex, ... } } }
 */
export function validateBulk(ops, state) {
  const tasks = new Map((state.tasks ?? []).map((t) => [t.id, t]));
  const sprints = new Map((state.sprints ?? []).map((s) => [s.id, s]));
  const projects = new Map((state.projects ?? []).map((p) => [p.id, p]));

  const fail = (kind, message, opIndex, extra) =>
    ({ ok: false, error: err(kind, message, { opIndex, ...extra }) });

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const p = op.payload;

    switch (op.type) {
      case 'task.add': {
        const t = p?.task;
        if (!t || typeof t !== 'object') return fail('validation', 'task.add: payload.task required', i);
        if (typeof t.id !== 'string' || !TASK_ID_RE.test(t.id))
          return fail('validation', `task.add: invalid task id "${t.id}"`, i);
        if (tasks.has(t.id)) return fail('duplicate_id', `task.add: id "${t.id}" already exists`, i);
        if (typeof t.sprintId !== 'string' || !t.sprintId)
          return fail('validation', 'task.add: sprintId required', i);
        if (!sprints.has(t.sprintId))
          return fail('missing_ref', `task.add: sprintId "${t.sprintId}" not found`, i);
        const dateErr = validateTaskDates(t);
        if (dateErr) return fail('validation', `task.add: ${dateErr}`, i);
        if (t.status !== undefined && !VALID_STATUSES.has(t.status))
          return fail('validation', `task.add: invalid status "${t.status}"`, i);
        if (t.parentTaskId !== undefined && t.parentTaskId !== null && !tasks.has(t.parentTaskId))
          return fail('missing_ref', `task.add: parentTaskId "${t.parentTaskId}" not found`, i);
        let edges = [];
        if (t.dependencies !== undefined) {
          const dr = validateDepsList(t.dependencies, { tasks, label: 'task.add' });
          if (!dr.ok) return fail(dr.kind, dr.message, i);
          edges = dr.edges;
        }
        // Insert into shadow first, then check cycles using the new hard-blocks edges.
        const shadow = { ...t, dependencies: edges };
        tasks.set(t.id, shadow);
        for (const targetId of hardTargets(edges)) {
          if (hasCycleIn(t.id, targetId, tasks))
            return fail('cycle', `task.add: dependency "${targetId}" creates a cycle`, i);
        }
        break;
      }

      case 'task.update': {
        if (typeof p?.id !== 'string' || !p.id) return fail('validation', 'task.update: id required', i);
        if (!tasks.has(p.id)) return fail('missing_ref', `task.update: task "${p.id}" not found`, i);
        const patch = p.patch;
        if (!patch || typeof patch !== 'object') return fail('validation', 'task.update: patch required (object)', i);
        const existing = tasks.get(p.id);
        const merged = { ...existing, ...patch };
        const dateErr = validateTaskDates(merged);
        if (dateErr) return fail('validation', `task.update: ${dateErr}`, i);
        if (patch.status !== undefined && !VALID_STATUSES.has(patch.status))
          return fail('validation', `task.update: invalid status "${patch.status}"`, i);
        if (patch.sprintId !== undefined && !sprints.has(patch.sprintId))
          return fail('missing_ref', `task.update: sprintId "${patch.sprintId}" not found`, i);
        if (patch.parentTaskId !== undefined && patch.parentTaskId !== null && !tasks.has(patch.parentTaskId))
          return fail('missing_ref', `task.update: parentTaskId "${patch.parentTaskId}" not found`, i);
        if (patch.dependencies !== undefined) {
          const dr = validateDepsList(patch.dependencies, { tasks, label: 'task.update' });
          if (!dr.ok) return fail(dr.kind, dr.message, i);
          tasks.set(p.id, { ...merged, dependencies: dr.edges });
          for (const targetId of hardTargets(dr.edges)) {
            if (hasCycleIn(p.id, targetId, tasks))
              return fail('cycle', `task.update: dependency "${targetId}" creates a cycle`, i);
          }
        } else {
          tasks.set(p.id, merged);
        }
        break;
      }

      case 'task.delete': {
        if (typeof p?.id !== 'string' || !p.id) return fail('validation', 'task.delete: id required', i);
        if (!tasks.has(p.id)) return fail('missing_ref', `task.delete: task "${p.id}" not found`, i);
        tasks.delete(p.id);
        // Trim from any other task's dep list in shadow so subsequent cycle checks see truth
        for (const [tid, t] of tasks) {
          if (!Array.isArray(t.dependencies)) continue;
          let changed = false;
          const trimmed = [];
          for (const edge of t.dependencies) {
            const target = typeof edge === 'string' ? edge : edge?.targetId;
            if (target === p.id) { changed = true; continue; }
            trimmed.push(edge);
          }
          if (changed) tasks.set(tid, { ...t, dependencies: trimmed });
        }
        break;
      }

      case 'sprint.add': {
        const s = p?.sprint;
        if (!s || typeof s !== 'object') return fail('validation', 'sprint.add: payload.sprint required', i);
        if (typeof s.id !== 'string' || !SPRINT_ID_RE.test(s.id))
          return fail('validation', `sprint.add: invalid sprint id "${s.id}"`, i);
        if (sprints.has(s.id)) return fail('duplicate_id', `sprint.add: id "${s.id}" already exists`, i);
        if (typeof s.projectId !== 'string' || !s.projectId)
          return fail('validation', 'sprint.add: projectId required', i);
        if (!projects.has(s.projectId))
          return fail('missing_ref', `sprint.add: projectId "${s.projectId}" not found`, i);
        if (s.startDate !== undefined && s.startDate !== '' && !DATE_RE.test(s.startDate))
          return fail('validation', `sprint.add: bad startDate "${s.startDate}"`, i);
        if (s.endDate !== undefined && s.endDate !== '' && !DATE_RE.test(s.endDate))
          return fail('validation', `sprint.add: bad endDate "${s.endDate}"`, i);
        sprints.set(s.id, { ...s });
        break;
      }

      case 'sprint.update': {
        if (typeof p?.id !== 'string' || !p.id) return fail('validation', 'sprint.update: id required', i);
        if (!sprints.has(p.id)) return fail('missing_ref', `sprint.update: sprint "${p.id}" not found`, i);
        const patch = p.patch;
        if (!patch || typeof patch !== 'object') return fail('validation', 'sprint.update: patch required (object)', i);
        if (patch.startDate !== undefined && patch.startDate !== '' && !DATE_RE.test(patch.startDate))
          return fail('validation', `sprint.update: bad startDate "${patch.startDate}"`, i);
        if (patch.endDate !== undefined && patch.endDate !== '' && !DATE_RE.test(patch.endDate))
          return fail('validation', `sprint.update: bad endDate "${patch.endDate}"`, i);
        if (patch.projectId !== undefined && !projects.has(patch.projectId))
          return fail('missing_ref', `sprint.update: projectId "${patch.projectId}" not found`, i);
        sprints.set(p.id, { ...sprints.get(p.id), ...patch });
        break;
      }

      case 'sprint.delete': {
        if (typeof p?.id !== 'string' || !p.id) return fail('validation', 'sprint.delete: id required', i);
        if (!sprints.has(p.id)) return fail('missing_ref', `sprint.delete: sprint "${p.id}" not found`, i);
        sprints.delete(p.id);
        for (const [tid, t] of tasks) if (t.sprintId === p.id) tasks.delete(tid);
        break;
      }

      case 'project.add': {
        const pr = p?.project;
        if (!pr || typeof pr !== 'object') return fail('validation', 'project.add: payload.project required', i);
        if (typeof pr.id !== 'string' || !PROJECT_ID_RE.test(pr.id))
          return fail('validation', `project.add: invalid project id "${pr.id}"`, i);
        if (projects.has(pr.id)) return fail('duplicate_id', `project.add: id "${pr.id}" already exists`, i);
        projects.set(pr.id, { ...pr });
        break;
      }

      case 'project.update': {
        if (typeof p?.id !== 'string' || !p.id) return fail('validation', 'project.update: id required', i);
        if (!projects.has(p.id)) return fail('missing_ref', `project.update: project "${p.id}" not found`, i);
        const patch = p.patch;
        if (!patch || typeof patch !== 'object') return fail('validation', 'project.update: patch required (object)', i);
        projects.set(p.id, { ...projects.get(p.id), ...patch });
        break;
      }

      case 'project.delete': {
        if (typeof p?.id !== 'string' || !p.id) return fail('validation', 'project.delete: id required', i);
        if (!projects.has(p.id)) return fail('missing_ref', `project.delete: project "${p.id}" not found`, i);
        projects.delete(p.id);
        const droppedSprints = new Set();
        for (const [sid, s] of sprints) if (s.projectId === p.id) { droppedSprints.add(sid); sprints.delete(sid); }
        for (const [tid, t] of tasks) if (droppedSprints.has(t.sprintId)) tasks.delete(tid);
        break;
      }

      default:
        return fail('unknown_type', `unknown atomic op type "${op.type}"`, i);
    }
  }

  return { ok: true };
}

/**
 * Returns true if any op targets an entity whose `updatedAt > basedOn`.
 * Stale ops are queued (not rejected) per protocol §4.5 — the human resolves.
 */
export function checkStaleness(ops, state, basedOn) {
  if (typeof basedOn !== 'number') return false;
  const tasksById = new Map((state.tasks ?? []).map((t) => [t.id, t]));
  const sprintsById = new Map((state.sprints ?? []).map((s) => [s.id, s]));
  const projectsById = new Map((state.projects ?? []).map((p) => [p.id, p]));
  for (const op of ops) {
    const id = op.payload?.id;
    if (!id) continue;
    let target;
    if (op.type.startsWith('task.')) target = tasksById.get(id);
    else if (op.type.startsWith('sprint.')) target = sprintsById.get(id);
    else if (op.type.startsWith('project.')) target = projectsById.get(id);
    if (target && typeof target.updatedAt === 'number' && target.updatedAt > basedOn) return true;
  }
  return false;
}
