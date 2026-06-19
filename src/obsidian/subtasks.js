/**
 * Subtask Flattening
 *
 * Converts nested checkbox subtasks into independent tasks with
 * dependency relationships (parent depends on subtasks).
 */

import { genId } from '../utils/ids.js';
import { normalizeDeps } from '../utils/depEdges.js';

/**
 * Flatten subtasks from parsed task data into independent tasks.
 * Each subtask becomes its own task; the parent's dependencies include subtask IDs.
 *
 * @param {Array} parsedTasks - Tasks from parseDeterministic with _subtasks arrays
 * @returns {Array} Flat array of tasks (parents + subtasks), with parentTaskId set on subtasks
 */
export function flattenSubtasks(parsedTasks) {
  const result = [];

  for (const task of parsedTasks) {
    const parentId = task.id || genId('task');
    task.id = parentId;

    const subtaskIds = [];

    for (const sub of task._subtasks || []) {
      const subId = sub.id || genId('task');
      sub.id = subId;
      subtaskIds.push(subId);

      // Subtasks inherit parent metadata where not set
      result.push({
        id: subId,
        title: sub.title,
        description: sub.description,
        status: sub.status,
        startDate: sub.startDate || task.startDate || '',
        endDate: sub.endDate || '',
        dueDate: sub.dueDate || task.dueDate || '',
        urgency: sub.urgency ?? task.urgency,
        importance: sub.importance ?? task.importance,
        difficulty: sub.difficulty ?? task.difficulty,
        dependencies: normalizeDeps(sub.dependencies),
        _ambiguousFields: { ...sub._ambiguousFields },
        _originalLines: sub._originalLines || [],
        _sprintName: task._sprintName,
        _projectName: task._projectName,
        _isLegacyFormat: false,
        parentTaskId: parentId,
      });
    }

    // Parent depends on all subtasks — subtask edges are always hard-blocks.
    const parentDeps = normalizeDeps([
      ...(task.dependencies || []),
      ...subtaskIds.map((id) => ({ targetId: id, type: 'hard-blocks' })),
    ]);

    result.push({
      ...task,
      id: parentId,
      dependencies: parentDeps,
      _subtasks: undefined, // clean up internal field
    });
  }

  return result;
}
