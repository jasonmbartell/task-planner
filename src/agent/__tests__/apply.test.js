import { describe, it, expect } from 'vitest';
import { applyOps } from '../apply.js';

const seed = () => ({
  projects: [{ id: 'proj-a', name: 'Alpha', color: '#abc', description: '', updatedAt: 1000 }],
  sprints:  [{ id: 'sprint-a1', name: 'A1', startDate: '2026-04-01', endDate: '', projectId: 'proj-a', updatedAt: 1100 }],
  tasks: [
    { id: 'task-1', title: 'T1', description: '', startDate: '', endDate: '', dueDate: '',
      dependencies: [], urgency: 5, importance: 5, difficulty: 3, sprintId: 'sprint-a1',
      status: 'todo', parentTaskId: null, updatedAt: 1200 },
    { id: 'task-2', title: 'T2', description: '', startDate: '', endDate: '', dueDate: '',
      dependencies: [{ targetId: 'task-1', type: 'hard-blocks' }], urgency: 5, importance: 5, difficulty: 3, sprintId: 'sprint-a1',
      status: 'todo', parentTaskId: null, updatedAt: 1300 },
  ],
});

describe('applyOps — task ops', () => {
  it('task.update patches only the named fields', () => {
    const { nextTasks, diff } = applyOps(seed(), [
      { type: 'task.update', payload: { id: 'task-1', patch: { status: 'done', urgency: 9 } } },
    ], { now: 5000 });
    const t = nextTasks.find((x) => x.id === 'task-1');
    expect(t.status).toBe('done');
    expect(t.urgency).toBe(9);
    expect(t.title).toBe('T1');
    expect(t.updatedAt).toBe(5000);
    expect(diff.tasks.updated).toHaveLength(1);
    expect(diff.tasks.updated[0].before.status).toBe('todo');
    expect(diff.tasks.updated[0].after.status).toBe('done');
  });

  it('task.update clamps ratings to 1..10', () => {
    const { nextTasks } = applyOps(seed(), [
      { type: 'task.update', payload: { id: 'task-1', patch: { urgency: 99, difficulty: 0 } } },
    ]);
    const t = nextTasks.find((x) => x.id === 'task-1');
    expect(t.urgency).toBe(10);
    expect(t.difficulty).toBe(1);
  });

  it('task.add appends a fully-defaulted task', () => {
    const { nextTasks, diff } = applyOps(seed(), [
      { type: 'task.add', payload: { task: { id: 'task-x', sprintId: 'sprint-a1' } } },
    ], { now: 7000 });
    const t = nextTasks.find((x) => x.id === 'task-x');
    expect(t).toBeDefined();
    expect(t.title).toBe('Untitled Task');
    expect(t.status).toBe('todo');
    expect(t.urgency).toBe(5);
    expect(t.updatedAt).toBe(7000);
    expect(diff.tasks.added).toHaveLength(1);
    expect(diff.tasks.added[0].id).toBe('task-x');
  });

  it('task.delete removes the task and trims it from other tasks’ deps', () => {
    const { nextTasks, diff } = applyOps(seed(), [
      { type: 'task.delete', payload: { id: 'task-1' } },
    ], { now: 9000 });
    expect(nextTasks.find((x) => x.id === 'task-1')).toBeUndefined();
    const t2 = nextTasks.find((x) => x.id === 'task-2');
    expect(t2.dependencies).toEqual([]);
    expect(t2.updatedAt).toBe(9000);
    expect(diff.tasks.deleted).toHaveLength(1);
    expect(diff.tasks.deleted[0].id).toBe('task-1');
    // task-2's dep was trimmed → recorded as an updated entry too
    expect(diff.tasks.updated.some((u) => u.id === 'task-2')).toBe(true);
  });
});

describe('applyOps — sprint cascades', () => {
  it('sprint.delete cascades to its tasks', () => {
    const { nextSprints, nextTasks, diff } = applyOps(seed(), [
      { type: 'sprint.delete', payload: { id: 'sprint-a1' } },
    ]);
    expect(nextSprints.find((x) => x.id === 'sprint-a1')).toBeUndefined();
    expect(nextTasks).toHaveLength(0);
    expect(diff.sprints.deleted.map((d) => d.id)).toEqual(['sprint-a1']);
    expect(diff.tasks.deleted.map((d) => d.id).sort()).toEqual(['task-1', 'task-2']);
  });
});

describe('applyOps — project cascades', () => {
  it('project.delete cascades to sprints and tasks', () => {
    const { nextProjects, nextSprints, nextTasks, diff } = applyOps(seed(), [
      { type: 'project.delete', payload: { id: 'proj-a' } },
    ]);
    expect(nextProjects).toHaveLength(0);
    expect(nextSprints).toHaveLength(0);
    expect(nextTasks).toHaveLength(0);
    expect(diff.projects.deleted.map((d) => d.id)).toEqual(['proj-a']);
    expect(diff.sprints.deleted.map((d) => d.id)).toEqual(['sprint-a1']);
    expect(diff.tasks.deleted.map((d) => d.id).sort()).toEqual(['task-1', 'task-2']);
  });
});

describe('applyOps — project & sprint adds and updates', () => {
  it('project.add and project.update', () => {
    const { nextProjects, diff } = applyOps(seed(), [
      { type: 'project.add', payload: { project: { id: 'proj-z', name: 'Zeta' } } },
      { type: 'project.update', payload: { id: 'proj-z', patch: { color: '#fff' } } },
    ], { now: 8000 });
    const z = nextProjects.find((p) => p.id === 'proj-z');
    expect(z.color).toBe('#fff');
    expect(z.updatedAt).toBe(8000);
    expect(diff.projects.added).toHaveLength(1);
    expect(diff.projects.updated).toHaveLength(1);
  });

  it('sprint.add and sprint.update', () => {
    const { nextSprints, diff } = applyOps(seed(), [
      { type: 'sprint.add', payload: { sprint: { id: 'sprint-z', projectId: 'proj-a' } } },
      { type: 'sprint.update', payload: { id: 'sprint-z', patch: { name: 'New Name' } } },
    ], { now: 8000 });
    const z = nextSprints.find((s) => s.id === 'sprint-z');
    expect(z.name).toBe('New Name');
    expect(z.updatedAt).toBe(8000);
    expect(diff.sprints.added).toHaveLength(1);
    expect(diff.sprints.updated).toHaveLength(1);
  });
});

describe('applyOps — typed edges', () => {
  it('task.add normalizes string deps into DepEdge[]', () => {
    const { nextTasks } = applyOps(seed(), [
      { type: 'task.add', payload: { task: { id: 'task-x', sprintId: 'sprint-a1', dependencies: ['task-1'] } } },
    ]);
    expect(nextTasks.find((t) => t.id === 'task-x').dependencies).toEqual([
      { targetId: 'task-1', type: 'hard-blocks' },
    ]);
  });

  it('task.update normalizes mixed dep inputs', () => {
    const { nextTasks } = applyOps(seed(), [
      { type: 'task.update', payload: { id: 'task-2', patch: { dependencies: [
        'task-1',
        { targetId: 'task-1', type: 'soft-prefers', note: 'prefer' },
      ] } } },
    ]);
    expect(nextTasks.find((t) => t.id === 'task-2').dependencies).toEqual([
      { targetId: 'task-1', type: 'hard-blocks' },
      { targetId: 'task-1', type: 'soft-prefers', note: 'prefer' },
    ]);
  });
});

describe('applyOps — non-mutation', () => {
  it('does not mutate the input state arrays', () => {
    const state = seed();
    const projectsRef = state.projects;
    const tasksRef = state.tasks;
    applyOps(state, [
      { type: 'task.update', payload: { id: 'task-1', patch: { status: 'done' } } },
    ]);
    expect(state.projects).toBe(projectsRef);
    expect(state.tasks).toBe(tasksRef);
    expect(state.tasks.find((t) => t.id === 'task-1').status).toBe('todo');
  });
});
