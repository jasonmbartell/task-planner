/**
 * Task date enforcement.
 *
 * Three rules apply automatically whenever a task is added or its
 * startDate/endDate/dueDate/difficulty/dependencies change:
 *
 *   1. If startDate moves past dueDate, snap dueDate = endDate and
 *      recompute endDate = startDate + duration. All three move together.
 *   2. endDate always equals dueDate (zero-duration tasks collapse to a
 *      single day; longer tasks have endDate == dueDate as their finish
 *      line, with startDate carrying the lead-time gap).
 *   3. A task's startDate is never earlier than the latest endDate among
 *      its hard-blocks predecessors. If it is, push startDate forward to
 *      that endDate and re-apply rules 1–2 (`enforceBlockerConstraint`).
 *
 * Cascade through the hard-blocks graph in two flavors:
 *   - Forward (dayDelta omitted or >= 0): when an upstream task's endDate
 *     pushes past a downstream task's startDate, snap the downstream
 *     startDate to the upstream endDate and re-enforce.
 *   - Backward (dayDelta < 0): when an upstream task's endDate moved
 *     earlier, shift downstream tasks earlier by the same delta to
 *     preserve lag, but never earlier than another hard-blocks
 *     predecessor's endDate.
 */
import { addDays as _addDays, parseISO, format, differenceInCalendarDays } from 'date-fns';

// Difficulty → estimated work days (matches user's rubric)
//   1: 1 hour            → 0 (same day)
//   2: 1/2 day           → 0 (same day)
//   3: 1 day             → 1
//   4: 1 week            → 7
//   5: 1 month           → 30
//   6: a couple months   → 60
//   7: 1 year            → 365
//   8: 1 year w/ team    → 365
//   9: significant       → 540
//  10: maybe impossible  → 730
export const DIFFICULTY_TO_DAYS = Object.freeze({
  1: 0,
  2: 0,
  3: 1,
  4: 7,
  5: 30,
  6: 60,
  7: 365,
  8: 365,
  9: 540,
  10: 730,
});

export function getDurationDays(difficulty) {
  return DIFFICULTY_TO_DAYS[difficulty] ?? 1;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const isISO = (s) => typeof s === 'string' && ISO_RE.test(s);

const fmt = (d) => format(d, 'yyyy-MM-dd');

// Returns null on any failure so callers can fall back rather than throw.
function addDaysISO(iso, n) {
  if (!isISO(iso)) return null;
  try {
    const d = _addDays(parseISO(iso), n);
    if (Number.isNaN(d.getTime())) return null;
    return fmt(d);
  } catch {
    return null;
  }
}

// Returns 0 on any failure (defensive — callers use it to compute cascade delta).
export function diffDaysISO(fromIso, toIso) {
  if (!isISO(fromIso) || !isISO(toIso)) return 0;
  try {
    return differenceInCalendarDays(parseISO(toIso), parseISO(fromIso));
  } catch {
    return 0;
  }
}

/**
 * Apply both enforcement rules to a single task.
 * Returns the same reference if nothing changes; otherwise a new object.
 *
 * Defensive: if any date field is non-ISO or arithmetic fails, returns the
 * task unchanged rather than throwing — a malformed legacy task should never
 * be able to take down the save path.
 */
export function enforceTaskDates(task) {
  if (!task) return task;
  let { startDate, endDate, dueDate } = task;

  // Nothing to enforce without a valid startDate anchor.
  if (!isISO(startDate)) return task;
  // Treat malformed end/due as missing rather than refusing to enforce.
  if (endDate && !isISO(endDate)) endDate = '';
  if (dueDate && !isISO(dueDate)) dueDate = '';

  const duration = getDurationDays(task.difficulty);

  // Rule 1: start moved past current due → push end and due forward together.
  if (dueDate && startDate > dueDate) {
    const pushed = addDaysISO(startDate, duration);
    if (pushed) {
      endDate = pushed;
      dueDate = pushed;
    }
  }

  // If due is missing entirely, derive it from start + duration.
  if (!dueDate) {
    const derived = addDaysISO(startDate, duration);
    if (derived) dueDate = derived;
  }

  // Rule 2: end always equals due (when due is known).
  if (dueDate && endDate !== dueDate) endDate = dueDate;

  if (
    startDate === task.startDate &&
    endDate === task.endDate &&
    dueDate === task.dueDate
  ) {
    return task;
  }
  return { ...task, startDate, endDate, dueDate };
}

/**
 * Latest endDate among `task`'s hard-blocks predecessors (looked up in
 * `tasksById`). Returns '' if the task has no hard-blocks deps with valid
 * endDates. Soft / preempts / deadline-independent edges and bare-string
 * deps (treated as hard-blocks) follow the same rules as the cascade.
 */
function maxBlockerEnd(task, tasksById) {
  if (!task || !Array.isArray(task.dependencies)) return '';
  let floor = '';
  for (const e of task.dependencies) {
    const targetId = typeof e === 'string' ? e : e?.targetId;
    const type = typeof e === 'string' ? 'hard-blocks' : (e?.type ?? 'hard-blocks');
    if (!targetId || type !== 'hard-blocks') continue;
    const pred = tasksById.get?.(targetId) ?? tasksById[targetId];
    if (pred && isISO(pred.endDate) && pred.endDate > floor) floor = pred.endDate;
  }
  return floor;
}

/**
 * Rule 3: ensure `task.startDate` is at least as late as its hard-blocks
 * predecessors' max endDate. Used by `addTask`/`updateTask` so a task
 * created or updated with a blocker can never start before the blocker
 * ends. Returns the input reference if no constraint binds.
 *
 * `tasksById` may be a `Map<id, task>` or a plain `{ [id]: task }` object.
 */
export function enforceBlockerConstraint(task, tasksById) {
  if (!task || !tasksById) return task;
  const floor = maxBlockerEnd(task, tasksById);
  if (!floor) return task;
  if (!isISO(task.startDate)) return task;
  if (task.startDate >= floor) return task;
  return enforceTaskDates({ ...task, startDate: floor });
}

// Build reverse index: upstreamId -> [downstreamIds] (hard-blocks only).
function buildDownstreamIndex(tasks) {
  const downstream = new Map();
  for (const t of tasks) {
    for (const e of t.dependencies || []) {
      const targetId = typeof e === 'string' ? e : e?.targetId;
      const type = typeof e === 'string' ? 'hard-blocks' : (e?.type ?? 'hard-blocks');
      if (!targetId || type !== 'hard-blocks') continue;
      const list = downstream.get(targetId) || [];
      list.push(t.id);
      downstream.set(targetId, list);
    }
  }
  return downstream;
}

/**
 * Walk the hard-blocks dependency graph downstream from `seedIds`.
 *
 * Two modes, selected by the optional `dayDelta` option:
 *
 * Forward (default — `dayDelta` omitted or >= 0): push any task whose
 * startDate is earlier than its blocker's endDate forward to that endDate,
 * then re-enforce. Used when an upstream task moved later or was newly
 * created with an end past its dependents' starts.
 *
 * Backward (`dayDelta` < 0): the seed task's endDate just moved earlier by
 * `|dayDelta|` days. Shift each downstream task earlier by the *effective*
 * delta of its blocker (the actual number of days the blocker moved, which
 * may be smaller than `dayDelta` if another predecessor floored the shift).
 * Lag (gap between blocker.endDate and dependent.startDate) is preserved
 * when no other predecessor binds. A dependent is never moved past one of
 * its other hard-blocks predecessors' endDates, and never pushed later.
 *
 * Returns the next tasks array. If nothing changed, returns the input array
 * by reference. Tasks that change get `updatedAt = now`.
 */
export function cascadeDateChanges(tasks, seedIds, { now = Date.now(), dayDelta } = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks;
  const seeds = Array.isArray(seedIds) ? seedIds : [seedIds];
  if (seeds.length === 0) return tasks;

  if (typeof dayDelta === 'number' && dayDelta < 0) {
    return cascadeBackward(tasks, seeds, dayDelta, now);
  }
  return cascadeForward(tasks, seeds, now);
}

/**
 * One-shot backfill: walk every task in `tasks` through the hard-blocks
 * graph and push any dependent whose `startDate` is earlier than its
 * blocker's `endDate`. Idempotent — re-running on already-correct data
 * returns the input array by reference.
 *
 * Used during hydration to retrofit Rule 3 onto data created before the
 * blocker-constraint enforcement landed.
 */
export function backfillBlockerConstraints(tasks, { now = Date.now() } = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks;
  const seeds = tasks.map((t) => t.id).filter(Boolean);
  if (seeds.length === 0) return tasks;
  return cascadeForward(tasks, seeds, now);
}

function cascadeForward(tasks, seeds, now) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const updated = new Map(); // id -> patched task
  const queue = [...seeds];
  const inQueue = new Set(seeds); // dedup: don't re-enqueue while pending

  const downstream = buildDownstreamIndex(tasks);

  const guard = tasks.length * 4; // hard-blocks cycles are blocked at write time
  let steps = 0;
  while (queue.length > 0 && steps++ < guard) {
    const upId = queue.shift();
    inQueue.delete(upId);
    const upstream = updated.get(upId) || byId.get(upId);
    if (!upstream || !isISO(upstream.endDate)) continue;

    const children = downstream.get(upId) || [];
    for (const childId of children) {
      const current = updated.get(childId) || byId.get(childId);
      if (!current) continue;
      // Skip if child already starts at or after blocker's end.
      if (isISO(current.startDate) && current.startDate >= upstream.endDate) continue;

      let pushed = { ...current, startDate: upstream.endDate };
      pushed = enforceTaskDates(pushed);
      // No-op safety: if enforcement returned the same dates we already had,
      // skip — prevents infinite churn on tasks with malformed dates.
      const prev = updated.get(childId) || current;
      if (
        pushed.startDate === prev.startDate &&
        pushed.endDate === prev.endDate &&
        pushed.dueDate === prev.dueDate
      ) {
        continue;
      }
      pushed.updatedAt = now;
      updated.set(childId, pushed);
      if (!inQueue.has(childId)) {
        queue.push(childId);
        inQueue.add(childId);
      }
    }
  }

  if (updated.size === 0) return tasks;
  return tasks.map((t) => updated.get(t.id) || t);
}

function cascadeBackward(tasks, seeds, dayDelta, now) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const updated = new Map();
  const downstream = buildDownstreamIndex(tasks);

  // Per-task effective shift in days (negative). Seeds shifted by `dayDelta`;
  // descendants may be floored by other predecessors and shift less.
  const shiftByTask = new Map();
  for (const s of seeds) shiftByTask.set(s, dayDelta);

  const queue = [...seeds];
  const visited = new Set();
  const guard = tasks.length * 4;
  let steps = 0;

  while (queue.length > 0 && steps++ < guard) {
    const upId = queue.shift();
    if (visited.has(upId)) continue;
    visited.add(upId);
    const upShift = shiftByTask.get(upId);
    if (!Number.isFinite(upShift) || upShift >= 0) continue;

    const children = downstream.get(upId) || [];
    for (const childId of children) {
      const child = updated.get(childId) || byId.get(childId);
      if (!child || !isISO(child.startDate)) continue;

      // Floor: max endDate among ALL of child's hard-blocks predecessors,
      // using the post-cascade state. Includes the seed (already shifted).
      let floor = '';
      for (const e of child.dependencies || []) {
        const predId = typeof e === 'string' ? e : e?.targetId;
        const type = typeof e === 'string' ? 'hard-blocks' : (e?.type ?? 'hard-blocks');
        if (!predId || type !== 'hard-blocks') continue;
        const pred = updated.get(predId) || byId.get(predId);
        if (pred?.endDate && pred.endDate > floor) floor = pred.endDate;
      }

      // Proposed start: shift child by the upstream's effective delta.
      const proposed = addDaysISO(child.startDate, upShift);
      if (!proposed) continue;
      const newStart = floor && floor > proposed ? floor : proposed;

      // Backward cascade never pushes a task later — if the floor would,
      // leave the child alone and don't propagate past it.
      if (newStart >= child.startDate) continue;

      const childShift = diffDaysISO(child.startDate, newStart); // negative
      const newEnd = isISO(child.endDate) ? addDaysISO(child.endDate, childShift) : child.endDate;
      const newDue = isISO(child.dueDate) ? addDaysISO(child.dueDate, childShift) : child.dueDate;

      let next = {
        ...child,
        startDate: newStart,
        endDate: newEnd ?? child.endDate,
        dueDate: newDue ?? child.dueDate,
      };
      next = enforceTaskDates(next);

      const prev = updated.get(childId) || child;
      if (
        next.startDate === prev.startDate &&
        next.endDate === prev.endDate &&
        next.dueDate === prev.dueDate
      ) {
        continue;
      }
      next.updatedAt = now;
      updated.set(childId, next);
      shiftByTask.set(childId, childShift);
      if (!visited.has(childId)) queue.push(childId);
    }
  }

  if (updated.size === 0) return tasks;
  return tasks.map((t) => updated.get(t.id) || t);
}
