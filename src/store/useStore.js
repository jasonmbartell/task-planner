import { create } from 'zustand';
import { PROJECT_COLORS } from '../utils/colors';
import { genId } from '../utils/ids.js';
import { normalizeDeps, hardTargets, removeTarget } from '../utils/depEdges.js';
import { enforceTaskDates, enforceBlockerConstraint, cascadeDateChanges, diffDaysISO } from '../utils/dateEnforcement.js';
import {
  validateEnvelope,
  normalizeOps,
  assignMissingIds,
  topoSortTaskAdds,
  validateBulk,
  checkStaleness,
} from '../agent/validate.js';
import { decideForBulk } from '../agent/trustMatrix.js';
import { applyOps } from '../agent/apply.js';
import { appleHigLight } from '../themes/appleHigLight.js';

/**
 * DFS check: returns true if adding a `hard-blocks` edge from `taskId` →
 * `dependencyId` would create a cycle. Only hard-blocks edges participate —
 * soft/preempt/deadline-independent edges can legally cycle (Milestone 3.5).
 *
 * Exported so the agent layer (and any other downstream cycle-aware code)
 * can reuse the same traversal — see `src/agent/validate.js`.
 */
export const hasCycle = (taskId, dependencyId, tasks) => {
  if (!dependencyId) return false;
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set();
  const stack = [dependencyId];
  while (stack.length) {
    const current = stack.pop();
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const t = taskMap.get(current);
    if (t) for (const next of hardTargets(t.dependencies)) stack.push(next);
  }
  return false;
};

const MAX_HISTORY = 50;

const useStore = create(
    (set, get) => ({
      // ─── State ───
      projects: [],
      sprints: [],
      tasks: [],
      // Slice name kept as `obsidianConfig` for storage/agent compatibility
      // (serialized into meta.json.settings.obsidianConfig; read by
      // _agentBulkApply via obsidianConfig?.agentTrust). After the bidirectional
      // Obsidian sync removal this slice is effectively the ingest + agent
      // settings bag.
      obsidianConfig: {
        llmApiKey: '',
        llmEndpointUrl: '',
        llmModel: 'claude-sonnet-4-20250514',
        plannerDataPath: '',             // $PLANNER_DATA_DIR override; '' = Tauri app_data_dir()/planner-data
        ingestConfidenceThreshold: 0.5,  // candidates with _confidence < this start unchecked in the modal
        lastIngestion: null,             // { at, source, model, candidateCount, accepted, costUsd, ... }
      },
      customCssConfig: {
        // snippets: [{ id, name, css, enabled }]
        // Apple HIG Light ships enabled by default; users can toggle it off in
        // Appearance settings.
        snippets: [
          { id: appleHigLight.id, name: appleHigLight.name, css: appleHigLight.css, enabled: true },
        ],
      },
      _hydrated: false,
      syncStatus: 'idle',
      cloudProvider: null, // 'google' | 'microsoft' | null
      // Per-session — flips true after the first successful cloud round-trip.
      // ConnectStorage shows "Verifying…" while cloudProvider is set but this
      // is still false, so the green "Connected" badge never paints over an
      // unverified token. Reset to false on every app start (excluded from
      // getSerializableState below) so a stale "true" never carries over a
      // session boundary into a session where the refresh token has died.
      cloudVerified: false,

      // ─── Notifications ───
      _notifications: [],
      addNotification: (message, type = 'info') => {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        set((s) => ({ _notifications: [...s._notifications, { id, message, type, timestamp: Date.now() }] }));
      },
      dismissNotification: (id) => {
        set((s) => ({ _notifications: s._notifications.filter((n) => n.id !== id) }));
      },

      // ─── Undo / Redo State ───
      _past: [],
      _future: [],

      // Snapshot helper — captures the three core arrays
      _pushHistory: () => {
        const { projects, sprints, tasks, _past } = get();
        const snapshot = {
          projects: JSON.parse(JSON.stringify(projects)),
          sprints: JSON.parse(JSON.stringify(sprints)),
          tasks: JSON.parse(JSON.stringify(tasks)),
        };
        const newPast = [..._past, snapshot];
        if (newPast.length > MAX_HISTORY) newPast.shift();
        set({ _past: newPast, _future: [] });
      },

      undo: () => {
        const { _past, projects, sprints, tasks } = get();
        if (_past.length === 0) return;
        const prev = _past[_past.length - 1];
        const currentSnapshot = {
          projects: JSON.parse(JSON.stringify(projects)),
          sprints: JSON.parse(JSON.stringify(sprints)),
          tasks: JSON.parse(JSON.stringify(tasks)),
        };
        set({
          projects: prev.projects,
          sprints: prev.sprints,
          tasks: prev.tasks,
          _past: _past.slice(0, -1),
          _future: [...get()._future, currentSnapshot],
        });
      },

      redo: () => {
        const { _future, projects, sprints, tasks } = get();
        if (_future.length === 0) return;
        const next = _future[_future.length - 1];
        const currentSnapshot = {
          projects: JSON.parse(JSON.stringify(projects)),
          sprints: JSON.parse(JSON.stringify(sprints)),
          tasks: JSON.parse(JSON.stringify(tasks)),
        };
        set({
          projects: next.projects,
          sprints: next.sprints,
          tasks: next.tasks,
          _future: _future.slice(0, -1),
          _past: [...get()._past, currentSnapshot],
        });
      },

      // ─── Project Actions ───
      addProject: (data) => {
        get()._pushHistory();
        set((s) => ({
          projects: [
            ...s.projects,
            {
              id: data.id || genId('proj'),
              name: data.name || 'Untitled Project',
              color: data.color || PROJECT_COLORS[s.projects.length % PROJECT_COLORS.length],
              description: data.description || '',
              updatedAt: Date.now(),
            },
          ],
        }));
      },

      updateProject: (id, data) => {
        get()._pushHistory();
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? { ...p, ...data, updatedAt: Date.now() } : p)),
        }));
      },

      deleteProject: (id) => {
        get()._pushHistory();
        set((s) => {
          const sprintIds = s.sprints.filter((sp) => sp.projectId === id).map((sp) => sp.id);
          return {
            projects: s.projects.filter((p) => p.id !== id),
            sprints: s.sprints.filter((sp) => sp.projectId !== id),
            tasks: s.tasks.filter((t) => !sprintIds.includes(t.sprintId)),
          };
        });
      },

      // ─── Sprint Actions ───
      addSprint: (data) => {
        get()._pushHistory();
        set((s) => ({
          sprints: [
            ...s.sprints,
            {
              id: data.id || genId('sprint'),
              name: data.name || 'Untitled Sprint',
              startDate: data.startDate || new Date().toISOString().split('T')[0],
              endDate: data.endDate || '',
              projectId: data.projectId,
              updatedAt: Date.now(),
            },
          ],
        }));
      },

      updateSprint: (id, data) => {
        get()._pushHistory();
        set((s) => ({
          sprints: s.sprints.map((sp) => (sp.id === id ? { ...sp, ...data, updatedAt: Date.now() } : sp)),
        }));
      },

      deleteSprint: (id) => {
        get()._pushHistory();
        set((s) => ({
          sprints: s.sprints.filter((sp) => sp.id !== id),
          tasks: s.tasks.filter((t) => t.sprintId !== id),
        }));
      },

      // ─── Task Actions ───
      addTask: (data) => {
        get()._pushHistory();
        set((s) => {
          const now = Date.now();
          const newId = data.id || genId('task');
          const rawDeps = Array.isArray(data.dependencies)
            ? data.dependencies
            : (data.dependency ? [data.dependency] : []);
          const normalized = normalizeDeps(rawDeps);
          // Only hard-blocks edges can create a cycle; the rest pass through.
          const dependencies = normalized.filter(
            (edge) => edge.type !== 'hard-blocks' || !hasCycle(newId, edge.targetId, s.tasks),
          );

          if (dependencies.length < normalized.length) {
            setTimeout(() => get().addNotification('Dependency rejected: would create a circular dependency chain.', 'warning'), 0);
          }

          const seed = {
            id: newId,
            title: data.title || 'Untitled Task',
            description: data.description || '',
            startDate: data.startDate || new Date().toISOString().split('T')[0],
            endDate: data.endDate || '',
            dueDate: data.dueDate || '',
            dependencies,
            urgency: Math.min(10, Math.max(1, data.urgency || 5)),
            importance: Math.min(10, Math.max(1, data.importance ?? data.projectImpact ?? 5)),
            difficulty: Math.min(10, Math.max(1, data.difficulty || 3)),
            sprintId: data.sprintId,
            status: data.status || 'todo',
            parentTaskId: data.parentTaskId || null,
            updatedAt: now,
          };
          const enforced = enforceTaskDates(seed);
          // Rule 3: a new task with hard-blocks deps cannot start before
          // its blockers end. Push start forward and re-enforce if needed.
          const tasksById = new Map(s.tasks.map((t) => [t.id, t]));
          const constrained = enforceBlockerConstraint(enforced, tasksById);
          constrained.updatedAt = now;
          return { tasks: [...s.tasks, constrained] };
        });
      },

      updateTask: (id, data) => {
        get()._pushHistory();
        set((s) => {
          const now = Date.now();
          const beforeTask = s.tasks.find((t) => t.id === id);
          // Snapshot pre-update tasksById so blocker lookups resolve from
          // the current state (the updated task itself isn't a useful
          // self-blocker, and cycles are already filtered above).
          const tasksById = new Map(s.tasks.map((t) => [t.id, t]));
          let nextTasks = s.tasks.map((t) => {
            if (t.id !== id) return t;
            const updated = { ...t, ...data };
            if (data.dependencies !== undefined) {
              const normalized = normalizeDeps(data.dependencies);
              updated.dependencies = normalized.filter(
                (edge) => edge.type !== 'hard-blocks' || !hasCycle(id, edge.targetId, s.tasks),
              );
              if (updated.dependencies.length < normalized.length) {
                setTimeout(() => get().addNotification('Dependency rejected: would create a circular dependency chain.', 'warning'), 0);
              }
            }
            if (data.urgency !== undefined) updated.urgency = Math.min(10, Math.max(1, data.urgency));
            if (data.importance !== undefined) updated.importance = Math.min(10, Math.max(1, data.importance));
            if (data.difficulty !== undefined) updated.difficulty = Math.min(10, Math.max(1, data.difficulty));
            const enforced = enforceTaskDates(updated);
            // Rule 3: respect hard-blocks predecessors. If a dep was just
            // added (or the start moved earlier than an existing blocker),
            // push start forward and re-enforce.
            const constrained = enforceBlockerConstraint(enforced, tasksById);
            constrained.updatedAt = now;
            return constrained;
          });
          // Cascade through the hard-blocks graph whenever this task's
          // endDate changed. Forward (later) push dependents up to the new
          // end; backward (earlier) shifts dependents earlier by the same
          // delta, floored by their other blockers.
          const afterTask = nextTasks.find((t) => t.id === id);
          if (
            afterTask &&
            afterTask.endDate &&
            (!beforeTask?.endDate || afterTask.endDate !== beforeTask.endDate)
          ) {
            const dayDelta = beforeTask?.endDate
              ? diffDaysISO(beforeTask.endDate, afterTask.endDate)
              : undefined;
            nextTasks = cascadeDateChanges(nextTasks, [id], { now, dayDelta });
          }
          return { tasks: nextTasks };
        });
      },

      deleteTask: (id) => {
        get()._pushHistory();
        set((s) => ({
          tasks: s.tasks.filter((t) => t.id !== id).map((t) => {
            const filtered = removeTarget(t.dependencies, id);
            return filtered.length === (t.dependencies?.length ?? 0) ? t : { ...t, dependencies: filtered };
          }),
        }));
      },

      // ─── Obsidian Config ───
      setObsidianConfig: (config) => {
        get()._pushHistory();
        set((s) => ({
          obsidianConfig: { ...s.obsidianConfig, ...config },
        }));
      },

      // ─── Custom CSS Snippets ───
      setCustomCssConfig: (config) => {
        get()._pushHistory();
        set((s) => ({
          customCssConfig: { ...s.customCssConfig, ...config },
        }));
      },

      addCssSnippet: (snippet = {}) => {
        get()._pushHistory();
        set((s) => ({
          customCssConfig: {
            ...s.customCssConfig,
            snippets: [
              ...(s.customCssConfig?.snippets || []),
              {
                id: snippet.id || genId('css'),
                name: snippet.name || 'New snippet',
                css: snippet.css || '',
                enabled: snippet.enabled ?? false,
              },
            ],
          },
        }));
      },

      updateCssSnippet: (id, data) => {
        get()._pushHistory();
        set((s) => ({
          customCssConfig: {
            ...s.customCssConfig,
            snippets: (s.customCssConfig?.snippets || []).map((sn) =>
              sn.id === id ? { ...sn, ...data } : sn,
            ),
          },
        }));
      },

      deleteCssSnippet: (id) => {
        get()._pushHistory();
        set((s) => ({
          customCssConfig: {
            ...s.customCssConfig,
            snippets: (s.customCssConfig?.snippets || []).filter((sn) => sn.id !== id),
          },
        }));
      },

      /**
       * Record telemetry from the most recent prose ingestion (M-P6
       * diagnostics panel). No history checkpoint — this is metadata, not
       * a user-visible mutation.
       *
       * @param {object} summary - { at, source, model, candidateCount,
       *   accepted, costUsd, tokensUsed, projectName, dropped }
       */
      recordIngestion: (summary) => {
        if (!summary || typeof summary !== 'object') return;
        set((s) => ({
          obsidianConfig: { ...s.obsidianConfig, lastIngestion: { ...summary } },
        }));
      },

      // ─── Bulk Operations ───
      importTasks: (taskList) => {
        get()._pushHistory();
        set((s) => ({
          tasks: [
            ...s.tasks,
            ...taskList.map((t) => ({
              ...t,
              id: t.id || genId('task'),
              updatedAt: Date.now(),
            })),
          ],
        }));
      },

      // ─── Helpers ───
      getProjectForTask: (taskId) => {
        const s = get();
        const task = s.tasks.find((t) => t.id === taskId);
        if (!task) return null;
        const sprint = s.sprints.find((sp) => sp.id === task.sprintId);
        if (!sprint) return null;
        return s.projects.find((p) => p.id === sprint.projectId) || null;
      },

      getTasksForSprint: (sprintId) => get().tasks.filter((t) => t.sprintId === sprintId),
      getSprintsForProject: (projectId) => get().sprints.filter((sp) => sp.projectId === projectId),

      getSprintVelocity: (sprintId) => {
        const sprintTasks = get().tasks.filter((t) => t.sprintId === sprintId);
        const done = sprintTasks.filter((t) => t.status === 'done');
        return {
          total: sprintTasks.length,
          done: done.length,
          inProgress: sprintTasks.filter((t) => t.status === 'in-progress').length,
          blocked: sprintTasks.filter((t) => t.status === 'blocked').length,
          todo: sprintTasks.filter((t) => t.status === 'todo').length,
          velocityPoints: done.reduce((sum, t) => sum + (t.difficulty || 5), 0),
        };
      },

      // ─── Agent Channel ───
      /**
       * Apply a parsed agent op envelope (single typed op or `bulk`) through
       * the store. One undo checkpoint per envelope, single set() call.
       *
       * Returns one of:
       *   { status: 'applied',  diff,    appliedAt,  normalizedOps }
       *   { status: 'queued',   reason,  normalizedOps }
       *   { status: 'rejected', error }
       *
       * `forceApply: true` bypasses the trust matrix (for the future inbox
       * UI's "approve" button) and the staleness queue. Validation errors
       * are still hard-rejected — `forceApply` is not "ignore safety", just
       * "ignore trust + freshness".
       */
      _agentBulkApply: (envelope, { forceApply = false, now = Date.now() } = {}) => {
        const envCheck = validateEnvelope(envelope);
        if (!envCheck.ok) return { status: 'rejected', error: envCheck.error };

        const rawOps = normalizeOps(envelope);
        if (!rawOps || rawOps.length === 0)
          return { status: 'rejected', error: { kind: 'malformed', message: 'no ops to apply' } };

        const idAssigned = assignMissingIds(rawOps, { genId });

        // Topo-sort task.add ops by intra-bulk dep edges so a task referencing
        // a sibling declared later in the array still validates and applies
        // correctly. Cycles in declared edges short-circuit here with
        // kind: 'cycle' instead of falling through to a misleading 'missing_ref'.
        const sortResult = topoSortTaskAdds(idAssigned);
        if (!sortResult.ok) return { status: 'rejected', error: sortResult.error };
        const ops = sortResult.ops;

        const state = get();
        const stateSlice = { projects: state.projects, sprints: state.sprints, tasks: state.tasks };

        const valCheck = validateBulk(ops, stateSlice);
        if (!valCheck.ok) return { status: 'rejected', error: valCheck.error };

        if (!forceApply && checkStaleness(ops, stateSlice, envelope.basedOn)) {
          return { status: 'queued', reason: 'stale', normalizedOps: ops };
        }

        if (!forceApply) {
          const decision = decideForBulk(ops, state.obsidianConfig?.agentTrust);
          if (decision === 'queue') return { status: 'queued', reason: 'trust', normalizedOps: ops };
        }

        get()._pushHistory();
        const { nextProjects, nextSprints, nextTasks, diff } = applyOps(stateSlice, ops, { now });
        set({ projects: nextProjects, sprints: nextSprints, tasks: nextTasks });

        return { status: 'applied', diff, appliedAt: now, normalizedOps: ops };
      },

      // ─── Hydration & Sync Actions ───
      _setHydrated: (val) => set({ _hydrated: val }),
      setSyncStatus: (status) => set({ syncStatus: status }),
      setCloudProvider: (provider) => set({ cloudProvider: provider }),
      setCloudVerified: (verified) => set({ cloudVerified: verified }),
      _hydrateState: (state) => set({ ...state, _hydrated: true }),
    })
);

/**
 * Returns only the serializable data fields from the store state,
 * excluding undo/redo stacks, hydration flag, sync status, and functions.
 */
export const getSerializableState = (state) => {
  const { _past, _future, _hydrated, _notifications, syncStatus, cloudVerified, ...rest } = state;
  return Object.fromEntries(
    Object.entries(rest).filter(([, v]) => typeof v !== 'function')
  );
};

export default useStore;
