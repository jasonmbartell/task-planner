import { diffDays } from './dateUtils';
import { hardTargets } from './depEdges.js';

/**
 * Critical path only follows `hard-blocks` edges. Soft/preempt/deadline-
 * independent edges affect scheduling but do not extend the path.
 */
export function computeCriticalPath(tasks) {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Build adjacency list: dependency -> dependents (forward edges)
  const forward = new Map();   // depId -> [taskIds that depend on it]
  const inDegree = new Map();

  for (const t of tasks) {
    if (!forward.has(t.id)) forward.set(t.id, []);
    inDegree.set(t.id, 0);
  }

  for (const t of tasks) {
    for (const depId of hardTargets(t.dependencies)) {
      if (!taskMap.has(depId)) continue;
      forward.get(depId).push(t.id);
      inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
    }
  }

  // Topological sort (Kahn's algorithm)
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order = [];
  const tempDegree = new Map(inDegree);

  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of (forward.get(id) || [])) {
      tempDegree.set(next, tempDegree.get(next) - 1);
      if (tempDegree.get(next) === 0) queue.push(next);
    }
  }

  // If there's a cycle (shouldn't happen due to hasCycle guard), return empty
  if (order.length !== tasks.length) return new Set();

  // Longest path DP: dist[id] = longest path ending at id
  const dist = new Map();
  const prev = new Map();

  function taskDuration(t) {
    if (!t.startDate || !t.endDate) return 1;
    return Math.max(1, diffDays(t.startDate, t.endDate));
  }

  for (const id of order) {
    const t = taskMap.get(id);
    const dur = taskDuration(t);

    let maxDist = 0;
    let bestPrev = null;

    for (const depId of hardTargets(t.dependencies)) {
      if (!dist.has(depId)) continue;
      if (dist.get(depId) > maxDist) {
        maxDist = dist.get(depId);
        bestPrev = depId;
      }
    }

    dist.set(id, maxDist + dur);
    prev.set(id, bestPrev);
  }

  // Find the sink with maximum distance
  let maxId = null;
  let maxVal = 0;
  for (const [id, d] of dist) {
    if (d > maxVal) {
      maxVal = d;
      maxId = id;
    }
  }

  // Backtrack to find the full critical path
  const critical = new Set();
  let cur = maxId;
  while (cur) {
    critical.add(cur);
    cur = prev.get(cur) || null;
  }

  return critical;
}
