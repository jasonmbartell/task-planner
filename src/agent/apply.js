/**
 * Pure mutator for agent ops. Takes the current state slice
 * { projects, sprints, tasks } and a pre-validated, ID-assigned list of
 * atomic ops, and returns the next slice plus a diff suitable for the
 * archive `result.diff` envelope.
 *
 * Validation must run before this function — applyOps assumes every op is
 * shape-correct and references existing IDs (with intra-bulk forward refs
 * already resolved).
 */

import { PROJECT_COLORS } from '../utils/colors.js';
import { normalizeDeps, removeTarget } from '../utils/depEdges.js';
import { enforceTaskDates, enforceBlockerConstraint, cascadeDateChanges, diffDaysISO } from '../utils/dateEnforcement.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function emptyDiff() {
  return {
    projects: { added: [], updated: [], deleted: [] },
    sprints:  { added: [], updated: [], deleted: [] },
    tasks:    { added: [], updated: [], deleted: [] },
  };
}

export function applyOps(state, ops, { now = Date.now() } = {}) {
  let projects = [...(state.projects ?? [])];
  let sprints  = [...(state.sprints ?? [])];
  let tasks    = [...(state.tasks ?? [])];

  const diff = emptyDiff();
  const nowDateStr = new Date(now).toISOString().split('T')[0];

  for (const op of ops) {
    const p = op.payload;
    switch (op.type) {
      case 'project.add': {
        const pr = p.project;
        const obj = {
          id: pr.id,
          name: pr.name || 'Untitled Project',
          color: pr.color || PROJECT_COLORS[projects.length % PROJECT_COLORS.length],
          description: pr.description || '',
          updatedAt: now,
        };
        projects.push(obj);
        diff.projects.added.push({ ...obj });
        break;
      }

      case 'project.update': {
        const idx = projects.findIndex((x) => x.id === p.id);
        if (idx < 0) break;
        const before = { ...projects[idx] };
        const after  = { ...projects[idx], ...p.patch, id: p.id, updatedAt: now };
        projects[idx] = after;
        diff.projects.updated.push({ id: p.id, before, after: { ...after } });
        break;
      }

      case 'project.delete': {
        const before = projects.find((x) => x.id === p.id);
        if (!before) break;
        projects = projects.filter((x) => x.id !== p.id);
        const droppedSprintIds = sprints.filter((s) => s.projectId === p.id).map((s) => s.id);
        sprints = sprints.filter((s) => s.projectId !== p.id);
        for (const sid of droppedSprintIds) {
          const s = state.sprints.find((x) => x.id === sid);
          diff.sprints.deleted.push({ id: sid, before: s ? { ...s } : undefined });
        }
        const droppedTasks = tasks.filter((t) => droppedSprintIds.includes(t.sprintId));
        tasks = tasks.filter((t) => !droppedSprintIds.includes(t.sprintId));
        for (const t of droppedTasks) diff.tasks.deleted.push({ id: t.id, before: { ...t } });
        diff.projects.deleted.push({ id: p.id, before: { ...before } });
        break;
      }

      case 'sprint.add': {
        const s = p.sprint;
        const obj = {
          id: s.id,
          name: s.name || 'Untitled Sprint',
          startDate: s.startDate || nowDateStr,
          endDate: s.endDate || '',
          projectId: s.projectId,
          updatedAt: now,
        };
        sprints.push(obj);
        diff.sprints.added.push({ ...obj });
        break;
      }

      case 'sprint.update': {
        const idx = sprints.findIndex((x) => x.id === p.id);
        if (idx < 0) break;
        const before = { ...sprints[idx] };
        const after  = { ...sprints[idx], ...p.patch, id: p.id, updatedAt: now };
        sprints[idx] = after;
        diff.sprints.updated.push({ id: p.id, before, after: { ...after } });
        break;
      }

      case 'sprint.delete': {
        const before = sprints.find((x) => x.id === p.id);
        if (!before) break;
        sprints = sprints.filter((x) => x.id !== p.id);
        const droppedTasks = tasks.filter((t) => t.sprintId === p.id);
        tasks = tasks.filter((t) => t.sprintId !== p.id);
        for (const t of droppedTasks) diff.tasks.deleted.push({ id: t.id, before: { ...t } });
        diff.sprints.deleted.push({ id: p.id, before: { ...before } });
        break;
      }

      case 'task.add': {
        const t = p.task;
        let obj = {
          id: t.id,
          title: t.title || 'Untitled Task',
          description: t.description || '',
          startDate: t.startDate || nowDateStr,
          endDate: t.endDate || '',
          dueDate: t.dueDate || '',
          dependencies: normalizeDeps(t.dependencies),
          urgency:    clamp(t.urgency    ?? 5, 1, 10),
          importance: clamp(t.importance ?? t.projectImpact ?? 5, 1, 10),
          difficulty: clamp(t.difficulty ?? 3, 1, 10),
          sprintId: t.sprintId,
          status: t.status || 'todo',
          parentTaskId: t.parentTaskId ?? null,
          updatedAt: now,
        };
        obj = enforceTaskDates(obj);
        // Rule 3: hard-blocks predecessors floor the task's startDate.
        obj = enforceBlockerConstraint(obj, new Map(tasks.map((x) => [x.id, x])));
        obj.updatedAt = now;
        tasks.push(obj);
        diff.tasks.added.push({ ...obj });
        break;
      }

      case 'task.update': {
        const idx = tasks.findIndex((x) => x.id === p.id);
        if (idx < 0) break;
        const before = { ...tasks[idx] };
        let after  = { ...tasks[idx], ...p.patch, id: p.id };
        if (p.patch.urgency    !== undefined) after.urgency    = clamp(p.patch.urgency,    1, 10);
        if (p.patch.importance !== undefined) after.importance = clamp(p.patch.importance, 1, 10);
        if (p.patch.difficulty !== undefined) after.difficulty = clamp(p.patch.difficulty, 1, 10);
        if (p.patch.dependencies !== undefined) after.dependencies = normalizeDeps(p.patch.dependencies);
        after = enforceTaskDates(after);
        // Rule 3: hard-blocks predecessors floor the task's startDate.
        // Build the lookup from siblings (excluding self) so a task can't
        // self-block via a malformed dep that survived validation.
        const siblingMap = new Map();
        for (const x of tasks) if (x.id !== after.id) siblingMap.set(x.id, x);
        after = enforceBlockerConstraint(after, siblingMap);
        after.updatedAt = now;
        tasks[idx] = after;
        diff.tasks.updated.push({ id: p.id, before, after: { ...after } });

        // Cascade if endDate changed (later → push forward, earlier → pull back).
        if (
          after.endDate &&
          (!before.endDate || after.endDate !== before.endDate)
        ) {
          const dayDelta = before.endDate
            ? diffDaysISO(before.endDate, after.endDate)
            : undefined;
          const beforeMap = new Map(tasks.map((x) => [x.id, x]));
          const cascaded = cascadeDateChanges(tasks, [after.id], { now, dayDelta });
          if (cascaded !== tasks) {
            for (const t2 of cascaded) {
              if (t2.id === after.id) continue;
              const prev = beforeMap.get(t2.id);
              if (prev && prev !== t2) {
                diff.tasks.updated.push({ id: t2.id, before: { ...prev }, after: { ...t2 } });
              }
            }
            tasks = cascaded;
          }
        }
        break;
      }

      case 'task.delete': {
        const before = tasks.find((x) => x.id === p.id);
        if (!before) break;
        const trimmedUpdates = [];
        tasks = tasks
          .filter((x) => x.id !== p.id)
          .map((t) => {
            if (!Array.isArray(t.dependencies) || t.dependencies.length === 0) return t;
            const filtered = removeTarget(t.dependencies, p.id);
            if (filtered.length === t.dependencies.length) return t;
            const updated = { ...t, dependencies: filtered, updatedAt: now };
            trimmedUpdates.push({ id: t.id, before: { ...t }, after: { ...updated } });
            return updated;
          });
        diff.tasks.deleted.push({ id: p.id, before: { ...before } });
        for (const u of trimmedUpdates) diff.tasks.updated.push(u);
        break;
      }

      // No default — validateBulk should have rejected unknown types.
    }
  }

  return { nextProjects: projects, nextSprints: sprints, nextTasks: tasks, diff };
}
