import { LocalAdapter } from './localAdapter.js';
import { normalizeDeps } from '../utils/depEdges.js';
import { backfillBlockerConstraints } from '../utils/dateEnforcement.js';

const MIGRATION_KEY = '_migration_complete';
const LS_KEY = 'task-planner-store';

/**
 * Storage schema version. Bumped whenever the on-disk task/sprint/project
 * shape changes in a way `deserializeFromFiles` has to react to.
 *
 *   1 = original shape (dependencies: string[], pre-agent-channel)
 *   2 = typed dependency edges (dependencies: DepEdge[]; Milestone 3.5)
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Walk tasks and rewrite legacy `dependencies: string[]` into
 * `DepEdge[]` via `normalizeDeps`. Idempotent — re-running on migrated data
 * produces the same normalized edges. Mutates tasks in place (consistent
 * with `addTimestamps` above) and returns the same array.
 */
export function migrateDependencyEdges(tasks) {
  if (!Array.isArray(tasks)) return tasks;
  for (const t of tasks) {
    if (!t) continue;
    t.dependencies = normalizeDeps(t.dependencies);
  }
  return tasks;
}

/**
 * Adds `updatedAt` to every project, sprint, and task that doesn't already
 * have one. Mutates and returns the state object.
 */
export function addTimestamps(state) {
  const now = Date.now();
  for (const p of state.projects) {
    if (!p.updatedAt) p.updatedAt = now;
  }
  for (const s of state.sprints) {
    if (!s.updatedAt) s.updatedAt = now;
  }
  for (const t of state.tasks) {
    if (!t.updatedAt) t.updatedAt = now;
  }
  return state;
}

/**
 * Converts flat arrays into the file-based storage format.
 * Returns an object keyed by filename with JSON-serializable values.
 *
 * Shape:
 *   'meta.json'           -> { schemaVersion, projects (summary), settings, updatedAt }
 *   'project-{id}.json'   -> { ...project, sprints: [ ...sprint with nested tasks ] , updatedAt }
 */
export function serializeToFiles(projects, sprints, tasks, obsidianConfig) {
  const files = {};

  // meta.json
  files['meta.json'] = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      description: p.description,
      updatedAt: p.updatedAt,
    })),
    settings: {
      obsidianConfig: obsidianConfig || undefined,
    },
    updatedAt: Date.now(),
  };

  // Per-project files
  for (const project of projects) {
    const projectSprints = sprints.filter((s) => s.projectId === project.id);

    const sprintsWithTasks = projectSprints.map((sprint) => {
      const sprintTasks = tasks.filter((t) => t.sprintId === sprint.id);
      return { ...sprint, tasks: sprintTasks };
    });

    // updatedAt = max timestamp across the project, its sprints, and their tasks
    const timestamps = [
      project.updatedAt || 0,
      ...projectSprints.map((s) => s.updatedAt || 0),
      ...tasks
        .filter((t) => projectSprints.some((s) => s.id === t.sprintId))
        .map((t) => t.updatedAt || 0),
    ];
    const maxUpdatedAt = Math.max(...timestamps, 0);

    files[`project-${project.id}.json`] = {
      ...project,
      sprints: sprintsWithTasks,
      updatedAt: maxUpdatedAt,
    };
  }

  return files;
}

/**
 * Converts the file-based format back into flat arrays.
 * Accepts an object keyed by filename (same shape serializeToFiles produces).
 * Returns { projects, sprints, tasks, obsidianConfig }.
 */
export function deserializeFromFiles(fileMap) {
  const meta = fileMap['meta.json'];
  let obsidianConfig = meta?.settings?.obsidianConfig ?? null;
  // Populate plannerDataPath default for configs predating the agent-channel milestone.
  if (obsidianConfig && obsidianConfig.plannerDataPath === undefined) {
    obsidianConfig = { ...obsidianConfig, plannerDataPath: '' };
  }

  const projects = [];
  const sprints = [];
  const tasks = [];

  // Iterate over project files
  for (const [filename, content] of Object.entries(fileMap)) {
    if (!filename.startsWith('project-') || !filename.endsWith('.json')) continue;

    // Extract the flat project (without the nested sprints array)
    const { sprints: nestedSprints, ...projectData } = content;
    projects.push(projectData);

    if (!Array.isArray(nestedSprints)) continue;

    for (const sprintWithTasks of nestedSprints) {
      const { tasks: nestedTasks, ...sprintData } = sprintWithTasks;
      sprints.push(sprintData);

      if (Array.isArray(nestedTasks)) {
        tasks.push(...nestedTasks);
      }
    }
  }

  // Migrate legacy projectImpact -> importance (scale was 1-5 inverted, now 1-10 where higher = more important)
  for (const task of tasks) {
    if (task.projectImpact !== undefined && task.importance === undefined) {
      task.importance = task.projectImpact;
      delete task.projectImpact;
    }
  }

  // Normalize dependencies to DepEdge[] (Milestone 3.5). Idempotent on
  // already-migrated data; promotes legacy `string[]` to hard-blocks edges.
  migrateDependencyEdges(tasks);

  // Retrofit Rule 3 onto pre-existing tasks: if a dependent's startDate is
  // before its hard-blocks blocker's endDate, push it forward. Idempotent —
  // a no-op once the data is correct. Bumps `updatedAt` on any corrected
  // task so the change propagates through the sync layer.
  const backfilled = backfillBlockerConstraints(tasks);
  return {
    projects,
    sprints,
    tasks: backfilled === tasks ? tasks : backfilled,
    obsidianConfig,
  };
}

/**
 * One-time migration from the Zustand localStorage key into IndexedDB
 * using the file-based storage format.
 *
 * Returns the parsed state ({ projects, sprints, tasks }) so the caller
 * can hydrate, or null if migration was skipped / nothing to migrate.
 */
export async function migrateFromLocalStorage() {
  const adapter = new LocalAdapter();

  // 1. Check if already migrated
  const marker = await adapter.load(MIGRATION_KEY);
  if (marker) return null;

  // 2. Read from localStorage
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // Zustand persist wraps in { state: { ... } }
  const state = parsed.state ?? parsed;
  const projects = state.projects ?? [];
  const sprints = state.sprints ?? [];
  const tasks = state.tasks ?? [];
  const obsidianConfig = state.obsidianConfig ?? null;

  // 3. Add updatedAt to entities missing it
  addTimestamps({ projects, sprints, tasks });

  // 4. Serialize to file-based format
  const files = serializeToFiles(projects, sprints, tasks, obsidianConfig);

  // 5. Save all files via LocalAdapter
  for (const [filename, data] of Object.entries(files)) {
    await adapter.save(filename, data);
  }

  // 6. Mark migration complete
  await adapter.save(MIGRATION_KEY, { migratedAt: Date.now() });

  // 7. Return parsed state for hydration
  return { projects, sprints, tasks };
}

/**
 * Remove the legacy Zustand localStorage key after confirming IndexedDB
 * has been successfully hydrated. Call this AFTER hydration, not during migration.
 */
export function cleanupLocalStorage() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch (err) {
    console.error('[migrations] Failed to clean up localStorage:', err);
  }
}
