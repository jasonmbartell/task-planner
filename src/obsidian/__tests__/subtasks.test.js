import { describe, it, expect } from 'vitest';
import { flattenSubtasks } from '../subtasks.js';

describe('flattenSubtasks', () => {
  it('flattens subtasks into independent tasks', () => {
    const parsed = [
      {
        id: null,
        title: 'Parent',
        description: 'Parent desc',
        status: 'todo',
        startDate: '2026-03-01',
        endDate: '',
        dueDate: '2026-03-15',
        urgency: 2,
        importance: 1,
        difficulty: 3,
        dependencies: [],
        _ambiguousFields: {},
        _subtasks: [
          {
            id: null,
            title: 'Child A',
            description: '',
            status: 'done',
            startDate: '',
            endDate: '',
            dueDate: '',
            urgency: null,
            importance: null,
            difficulty: null,
            dependencies: [],
            _ambiguousFields: {},
            _subtasks: [],
            _originalLines: [],
          },
        ],
        _originalLines: [],
        _sprintName: 'Sprint 1',
        _projectName: 'Project',
      },
    ];

    const flat = flattenSubtasks(parsed);

    // Should have 2 tasks (parent + child)
    expect(flat).toHaveLength(2);

    const child = flat.find((t) => t.title === 'Child A');
    const parent = flat.find((t) => t.title === 'Parent');

    expect(child).toBeDefined();
    expect(parent).toBeDefined();

    // Child gets parentTaskId
    expect(child.parentTaskId).toBe(parent.id);

    // Parent depends on child (hard-blocks edge)
    expect(parent.dependencies).toContainEqual({ targetId: child.id, type: 'hard-blocks' });

    // Child inherits parent metadata where not set
    expect(child.dueDate).toBe('2026-03-15');
    expect(child.urgency).toBe(2);
    expect(child.importance).toBe(1);
  });

  it('assigns IDs to tasks without them', () => {
    const parsed = [
      {
        id: null,
        title: 'Task',
        description: '',
        status: 'todo',
        startDate: '',
        endDate: '',
        dueDate: '',
        urgency: 5,
        importance: 3,
        difficulty: 3,
        dependencies: [],
        _ambiguousFields: {},
        _subtasks: [],
        _originalLines: [],
        _sprintName: 'S',
        _projectName: 'P',
      },
    ];

    const flat = flattenSubtasks(parsed);
    expect(flat[0].id).toMatch(/^task-/);
  });
});

